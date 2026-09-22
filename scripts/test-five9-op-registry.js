/**
 * Phase H PR3 — buildFromSchema + the declarative op registry.
 *   node --test scripts/test-five9-op-registry.js
 *
 * No network, no DB. Three things are under test here, and they fail for
 * different reasons:
 *
 *   1. buildFromSchema  — does the generic serializer reproduce what the
 *      hand-written builders produce, and does it refuse what they would have
 *      let through (an unknown key, a missing required field)?
 *
 *   2. the registry     — does every operation it names actually exist in
 *      v13, and does it agree with the handler map that is really wired up?
 *
 *   3. the deny-list    — this is the one that matters most. A denied
 *      operation acquiring an action type is not a style regression, it is a
 *      capability nobody approved. With FIVE9_WRITES_ENABLED armed in
 *      production, "registered" and "live" are the same thing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  buildFromSchema,
  flattenType,
  wsdlSchema,
  buildCampaignProfileXml,
  buildUserSkillXml,
  actionFieldXml,
  secondsToTimerXml,
  CAMPAIGN_PROFILE_FIELD_ORDER,
  PROFILE_PATCHABLE_FIELDS,
} from '../src/five9/admin-writes.js';
import {
  OP_CLASSIFICATION,
  OP_REGISTRY,
  DENIED_OPERATIONS,
  FORBIDDEN_ACTION_TYPES,
  TIERS,
  KINDS,
  STATUSES,
  isDenied,
  byTier,
  registryByActionType,
  unknownOperations,
  unclassifiedOperations,
} from '../src/five9/op-registry.js';
import { escapeXml } from '../src/five9-admin.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const schema = wsdlSchema();

/* ====================================================================== *
 * 1. buildFromSchema
 * ====================================================================== */

test('buildFromSchema emits xs:sequence order, not payload key order', () => {
  // campaignProfileInfo's sequence puts `name` SEVENTH. A builder that walked
  // Object.keys would put it first, which is the exact class of bug the
  // hand-written arrays existed to prevent.
  const xml = buildFromSchema(
    'campaignProfileInfo',
    { numberOfAttempts: 8, name: 'Data Leads', ANI: '7275133151' },
    { wrapper: 'campaignProfile' }
  );
  assert.equal(
    xml,
    '<campaignProfile><ANI>7275133151</ANI><name>Data Leads</name>'
    + '<numberOfAttempts>8</numberOfAttempts></campaignProfile>'
  );
  assert.ok(xml.indexOf('<ANI>') < xml.indexOf('<name>'), 'ANI must precede name');
  assert.ok(xml.indexOf('<name>') < xml.indexOf('<numberOfAttempts>'));
});

test('buildFromSchema omits absent optional fields entirely', () => {
  const xml = buildFromSchema('campaignProfileInfo', { name: 'P' });
  assert.equal(xml, '<name>P</name>');
  for (const absent of ['ANI', 'description', 'dialingSchedule', 'maxCharges']) {
    assert.ok(!xml.includes(`<${absent}>`), `${absent} must not be emitted`);
  }
});

test('buildFromSchema THROWS on a missing minOccurs=1 field', () => {
  // userSkill.level is the one element in the type without minOccurs="0".
  // Five9's own error for this names the type, not the field, which is what
  // made the Phase G regression (a55200d) take as long as it did to find.
  const level = schema.complexTypes.userSkill.fields.find((f) => f.name === 'level');
  assert.equal(level.minOccurs, 1, 'precondition: userSkill.level is required');

  assert.throws(
    () => buildFromSchema('userSkill', { userName: 'jflanders', skillName: 'Setter' }),
    /required field "level" \(minOccurs=1\) is missing/
  );
  assert.doesNotThrow(
    () => buildFromSchema('userSkill', { userName: 'jflanders', skillName: 'Setter', level: 5 })
  );
});

test('buildFromSchema THROWS on a payload key the schema does not have', () => {
  // The typo gate, and the single highest-value assertion in this file.
  // Five9 SILENTLY IGNORES an element it does not recognise: the write returns
  // success having set nothing. There is no server-side error to catch, so if
  // this does not throw, nothing ever will.
  assert.throws(
    () => buildFromSchema('campaignProfileInfo', { name: 'P', numberOfAttempt: 8 }),
    /"numberOfAttempt" is not a field of tns:campaignProfileInfo/
  );
  assert.throws(
    () => buildFromSchema('campaignProfileInfo', { name: 'P', ani: '727' }),
    /"ani" is not a field of tns:campaignProfileInfo/,
    'field names are case-sensitive — ANI is not ani'
  );
});

test('buildFromSchema walks the inheritance chain base-sequence first', () => {
  // outboundCampaign is four levels deep. JAXB unmarshals base fields BEFORE
  // extension fields, so a flattened order that is not base-first is a fault.
  const flat = flattenType('outboundCampaign').map((f) => f.name);
  assert.equal(flat.length, 39, 'campaign(7) + generalCampaign(7) + baseOutboundCampaign(8) + outboundCampaign(17)');
  assert.equal(flat[0], 'description', 'tns:campaign sequence comes first');
  assert.ok(flat.indexOf('autoRecord') < flat.indexOf('analyzeLevel'), 'generalCampaign before baseOutboundCampaign');
  assert.ok(flat.indexOf('analyzeLevel') < flat.indexOf('dialingMode'), 'baseOutboundCampaign before outboundCampaign');
  assert.equal(flat.indexOf('CRMRedialTimeout'), 15, 'second within baseOutboundCampaign');
});

test('buildFromSchema dispatches tns:timer to secondsToTimerXml', () => {
  // Five9 is asymmetric on tns:timer: it ACCEPTS an integer of seconds and
  // RETURNS a {days,hours,minutes,seconds} struct. Recursing into the struct
  // would emit the read shape on the write path.
  const xml = buildFromSchema('outboundCampaign', { name: 'C', maxQueueTime: 2 });
  assert.ok(xml.includes(secondsToTimerXml('maxQueueTime', 2)));
  assert.equal(
    xml,
    '<name>C</name><maxQueueTime><days>0</days><hours>0</hours>'
    + '<minutes>0</minutes><seconds>2</seconds></maxQueueTime>'
  );
});

test('buildFromSchema recursion reproduces actionFieldXml for the dialing-action pair', () => {
  // actionOnQueueExpiration is tns:campaignDialingAction {actionArgument,
  // actionType, maxWaitTime}. With only actionType supplied the other two are
  // omitted, so the generic walk emits exactly what the hand-written
  // actionFieldXml emits — which is why this pair needs no custom builder.
  const generic = buildFromSchema('outboundCampaign', {
    actionOnQueueExpiration: { actionType: 'DROP_CALL' },
  });
  assert.equal(generic, actionFieldXml('actionOnQueueExpiration', 'DROP_CALL'));
  assert.equal(generic, '<actionOnQueueExpiration><actionType>DROP_CALL</actionType></actionOnQueueExpiration>');
});

test('buildFromSchema recurses into nested complex types (callWrapup)', () => {
  const xml = buildFromSchema('inboundCampaign', {
    name: 'Main Number',
    callWrapup: { enabled: true, dispostionName: 'No Disposition', timeout: 180 },
  });
  assert.equal(
    xml,
    '<name>Main Number</name><callWrapup><dispostionName>No Disposition</dispostionName>'
    + '<enabled>true</enabled><timeout><days>0</days><hours>0</hours>'
    + '<minutes>3</minutes><seconds>0</seconds></timeout></callWrapup>'
  );
  assert.ok(
    xml.indexOf('<dispostionName>') < xml.indexOf('<enabled>'),
    'nested types get the same xs:sequence treatment as the top level'
  );
});

test('buildFromSchema refuses a scalar where a complex type belongs', () => {
  assert.throws(
    () => buildFromSchema('inboundCampaign', { name: 'X', callWrapup: 'yes' }),
    /"callWrapup" is tns:campaignCallWrapup, a complex type — expected an object, got string/
  );
});

test('buildFromSchema repeats maxOccurs="unbounded" fields and refuses arrays elsewhere', () => {
  const schedule = buildFromSchema('ivrScriptSchedule', {
    name: 'S', scriptName: 'Main',
    scriptParameters: [{ name: 'a', value: '1' }, { name: 'b', value: '2' }],
  });
  assert.equal(
    schedule,
    '<name>S</name><scriptName>Main</scriptName>'
    + '<scriptParameters><name>a</name><value>1</value></scriptParameters>'
    + '<scriptParameters><name>b</name><value>2</value></scriptParameters>'
  );
  assert.throws(
    () => buildFromSchema('campaignProfileInfo', { name: ['A', 'B'] }),
    /"name" is not repeatable/
  );
});

test('buildFromSchema escapes scalar values', () => {
  const xml = buildFromSchema('campaignProfileInfo', { name: 'A & B <c>' });
  assert.equal(xml, `<name>${escapeXml('A & B <c>')}</name>`);
  assert.ok(xml.includes('&amp;'), 'raw ampersand would be a malformed body');
});

test('buildFromSchema rejects an unknown complexType and a non-object payload', () => {
  assert.throws(() => buildFromSchema('notAType', { a: 1 }), /complexType "notAType" is not in wsdl-schema\.json/);
  assert.throws(() => buildFromSchema('campaignProfileInfo', 'nope'), /payload must be an object/);
  assert.throws(() => buildFromSchema('campaignProfileInfo', null), /payload must be an object/);
  assert.throws(() => buildFromSchema('campaignProfileInfo', ['a']), /payload must be an object/);
});

/* -- Five9's own misspellings -------------------------------------------- */

test('buildFromSchema reproduces every Five9 misspelling verbatim', () => {
  // These are Five9's, not ours. Reading names from the artifact reproduces
  // them without anyone having to remember — but "should reproduce naturally"
  // is a claim, so it gets asserted.
  //
  // Emitting the CORRECT spelling raises no error and silently sets nothing,
  // which is the whole reason these are dangerous.
  const wrapup = buildFromSchema('campaignCallWrapup', { dispostionName: 'No Disposition' });
  assert.equal(wrapup, '<dispostionName>No Disposition</dispostionName>');
  assert.throws(
    () => buildFromSchema('campaignCallWrapup', { dispositionName: 'No Disposition' }),
    /"dispositionName" is not a field of tns:campaignCallWrapup/,
    'the CORRECTLY spelled name must be rejected — Five9 would accept and ignore it'
  );

  const media = buildFromSchema('mediaTypeItem', {
    enabled: true, intlligentRouting: true, maxAlowed: 3, type: 'CHAT',
  });
  assert.equal(
    media,
    '<enabled>true</enabled><intlligentRouting>true</intlligentRouting>'
    + '<maxAlowed>3</maxAlowed><type>CHAT</type>'
  );
  assert.throws(
    () => buildFromSchema('mediaTypeItem', { intelligentRouting: true }),
    /"intelligentRouting" is not a field of tns:mediaTypeItem/
  );
  assert.throws(
    () => buildFromSchema('mediaTypeItem', { maxAllowed: 3 }),
    /"maxAllowed" is not a field of tns:mediaTypeItem/
  );

  // userProfileNamePatern is on the getUserProfiles REQUEST wrapper.
  assert.deepEqual(schema.operations.getUserProfiles.fields, ['userProfileNamePatern']);
});

/* -- the migration ------------------------------------------------------- */

test('byte-identical migration: five9_create_campaign_profile', () => {
  // The hand-written serialization loop, reproduced verbatim as it stood on
  // main at 61c515f. buildCampaignProfileXml now delegates to buildFromSchema;
  // this is the proof that the delegation changed nothing on the wire.
  const handWritten = (profileName, patch) => {
    const name = String(profileName || '').trim();
    if (!name) throw new Error('profile_name is required');
    if (!patch || typeof patch !== 'object' || !Object.keys(patch).length) {
      throw new Error('patch with at least one field is required');
    }
    for (const key of Object.keys(patch)) {
      if (!PROFILE_PATCHABLE_FIELDS.has(key)) {
        throw new Error(`REFUSED: "${key}" is not a patchable campaign profile field (allowed: ${[...PROFILE_PATCHABLE_FIELDS].join(', ')})`);
      }
    }
    const merged = { name, ...patch };
    let xml = '';
    for (const field of CAMPAIGN_PROFILE_FIELD_ORDER) {
      const v = merged[field];
      if (v === undefined || v === null) continue;
      xml += `<${field}>${escapeXml(v)}</${field}>`;
    }
    return `<campaignProfile>${xml}</campaignProfile>`;
  };

  const names = ['Data Leads', 'Data-Hot', 'Rehash & Co <Ampersand>', '  padded  ', 'O\'Brien "quoted"'];
  const values = {
    description: ['per-tier profile', '', 'a & b <c> "d"', 0, false],
    ANI: ['7275133151', 1234567890],
    numberOfAttempts: [8, 0, '12', -1],
    dialingTimeout: [30, '45'],
    initialCallPriority: [1, 9],
    maxCharges: [100, 0],
  };
  const patchable = [...PROFILE_PATCHABLE_FIELDS];

  const cases = [];
  for (const n of names) {
    for (const f of patchable) for (const v of values[f]) cases.push([n, { [f]: v }]);
  }
  for (let i = 0; i < patchable.length; i++) {
    for (let j = i + 1; j < patchable.length; j++) {
      cases.push(['Data Leads', { [patchable[i]]: values[patchable[i]][0], [patchable[j]]: values[patchable[j]][0] }]);
    }
  }
  const all = Object.fromEntries(patchable.map((f) => [f, values[f][0]]));
  cases.push(['Data Leads', all]);
  cases.push(['Data Leads', Object.fromEntries(Object.entries(all).reverse())]); // key order must not matter

  for (const [n, patch] of cases) {
    assert.equal(
      buildCampaignProfileXml(n, patch), handWritten(n, patch),
      `diverged for ${n} / ${JSON.stringify(patch)}`
    );
  }
  assert.ok(cases.length >= 100, `matrix too small: ${cases.length}`);

  // The refusal paths must be identical too — same message, same trigger.
  // PROFILE_PATCHABLE_FIELDS runs BEFORE buildFromSchema, so a schema-valid
  // but non-patchable key still refuses the way it always did.
  for (const [n, patch] of [
    ['', { ANI: '1' }], ['P', {}], ['P', null],
    ['P', { name: 'Renamed' }], ['P', { dialingSchedule: {} }], ['P', { bogus: 1 }],
  ]) {
    let a; let b;
    try { buildCampaignProfileXml(n, patch); a = '(no throw)'; } catch (e) { a = e.message; }
    try { handWritten(n, patch); b = '(no throw)'; } catch (e) { b = e.message; }
    assert.equal(a, b, `refusal diverged for ${n} / ${JSON.stringify(patch)}`);
  }
});

test('the migration did not loosen the patchable whitelist', () => {
  // buildFromSchema only knows what the SCHEMA permits; PROFILE_PATCHABLE_FIELDS
  // is a PERMISSION list and is deliberately narrower. Losing it would make
  // `name` (a rename) and `dialingSchedule` writable through the patch path.
  assert.throws(() => buildCampaignProfileXml('P', { name: 'Renamed' }), /REFUSED: "name"/);
  assert.throws(() => buildCampaignProfileXml('P', { dialingSchedule: {} }), /REFUSED: "dialingSchedule"/);
  const schemaFields = flattenType('campaignProfileInfo').map((f) => f.name);
  for (const f of PROFILE_PATCHABLE_FIELDS) {
    assert.ok(schemaFields.includes(f), `${f} is whitelisted but absent from the schema`);
  }
  assert.ok(PROFILE_PATCHABLE_FIELDS.size < schemaFields.length, 'the permission list must stay narrower than the schema');
});

test('buildUserSkillXml still matches a plain schema walk', () => {
  // Not migrated (it owns the 1–9 level validation), but the BODY should be a
  // straight sequence walk. If these ever diverge, one of them is wrong.
  const skill = { userName: 'jflanders', skillName: 'Setter', level: 5 };
  assert.equal(
    buildUserSkillXml(skill),
    buildFromSchema('userSkill', { level: 5, skillName: 'Setter', userName: 'jflanders' }, { wrapper: 'userSkill' })
  );
});

/* ====================================================================== *
 * 2. the registry
 * ====================================================================== */

test('every soapOperation in the registry exists in wsdl-schema.json', () => {
  // Enforced by test, not by inspection — this is what catches an operation
  // name carried in from a pre-v13 document (getCallLogReport,
  // getAgentAuditReport, resetListPositions all died here).
  const missing = OP_REGISTRY.filter((e) => !schema.operations[e.soapOperation]);
  assert.deepEqual(missing.map((e) => e.soapOperation), [], 'registry names operations absent from v13');
});

test('every complexType in the registry exists in wsdl-schema.json', () => {
  const missing = OP_REGISTRY
    .filter((e) => e.complexType && !schema.complexTypes[e.complexType])
    .map((e) => `${e.actionType} → ${e.complexType}`);
  assert.deepEqual(missing, []);
});

test('registry entries are well-formed and uniquely keyed', () => {
  const seenAction = new Set();
  for (const e of OP_REGISTRY) {
    assert.match(e.actionType, /^five9_[a-z0-9_]+$/, `bad action type ${e.actionType}`);
    assert.ok(!seenAction.has(e.actionType), `duplicate action type ${e.actionType}`);
    seenAction.add(e.actionType);
    assert.equal(e.kind, 'write', 'a read must never enter the write registry');
    assert.ok(['enabled', 'gated'].includes(e.tier), `${e.actionType} is registered at tier ${e.tier}`);
    assert.ok(Array.isArray(e.guards));
    assert.equal(typeof e.readBeforeWrite, 'boolean');
    assert.ok(e.builder && typeof e.builder === 'string');
  }
});

test('every gated registry entry declares what makes it gated', () => {
  // The rule from the handoff: if you cannot write the specific guard in one
  // sentence it is denied, not gated. A gated entry with no confirm_token and
  // no guards has nothing gating it.
  for (const e of OP_REGISTRY.filter((x) => x.tier === 'gated')) {
    assert.ok(
      e.confirmToken || e.guards.length,
      `${e.actionType} is gated but declares neither a confirm_token nor a guard`
    );
  }
  // And the confirm_token set must match requiredConfirmToken()'s reality.
  const tokened = OP_REGISTRY.filter((e) => e.confirmToken).map((e) => e.actionType).sort();
  assert.deepEqual(tokened, [
    // Phase H PR4 — campaign composition. Every one restates the campaign
    // name; create_list is deliberately absent (a new list is empty and
    // attached to nothing, so there is no target to confirm).
    'five9_add_dispositions_to_campaign',
    'five9_add_lists_to_campaign',
    'five9_add_skills_to_campaign',
    'five9_async_delete_records_from_list',
    // Phase H PR4 — web connectors; both restate the connector name.
    'five9_create_outbound_campaign',
    'five9_create_user_profile',
    'five9_create_web_connector',
    'five9_modify_campaign_lists',
    'five9_modify_campaign_profile',
    'five9_modify_ivr_script',
    'five9_modify_user_profile',
    'five9_modify_web_connector',
    'five9_remove_dnis_from_campaign',
    'five9_remove_lists_from_campaign',
    'five9_remove_skills_from_campaign',
    'five9_reset_campaign',
    'five9_reset_campaign_dispositions',
    'five9_reset_list_position',
    'five9_set_campaign_strategies',
    'five9_set_outbound_campaign',
  ]);
});

test('PR4 — every registry confirmToken agrees with requiredConfirmToken()', async () => {
  // The registry is a DECLARATION; requiredConfirmToken() is what actually
  // runs. A tranche that declares a token it never enforces would read as
  // gated and behave as enabled, which is the failure this pins.
  const { requiredConfirmToken } = await import('../src/five9/admin-writes.js');
  for (const e of OP_REGISTRY) {
    const subtype = e.actionType.replace(/^five9_/, '');
    const payload = { campaign_name: 'C', profile_name: 'P', list_name: 'L', name: 'N', connector_name: 'W' };
    const actual = requiredConfirmToken(subtype, payload);
    if (e.confirmToken) {
      assert.equal(actual, payload[e.confirmToken],
        `${e.actionType} declares confirmToken "${e.confirmToken}" but requiredConfirmToken() returned ${JSON.stringify(actual)}`);
    } else {
      assert.equal(actual, null,
        `${e.actionType} declares no confirmToken but requiredConfirmToken() demands ${JSON.stringify(actual)}`);
    }
  }
});

test('the registry matches the handler map that is actually wired up', async () => {
  const { ACTION_HANDLERS } = await import('../src/actions/index.js');
  const live = Object.keys(ACTION_HANDLERS).filter((k) => k.startsWith('five9_')).sort();
  const registered = OP_REGISTRY.map((e) => e.actionType).sort();
  assert.deepEqual(registered, live, 'registry and ACTION_HANDLERS have diverged');
  // PR3 registered 24 and no more. PR4 adds 13: the web connector pair plus
  // 11 campaign-composition ops. 2026-09-21 adds the 38th, the one welded
  // re-entry DNC lift. The number is pinned so the NEXT tranche moves it
  // deliberately, in that PR, rather than by accident here.
  assert.equal(live.length, 38, 'PR3’s 24 + PR4’s 13 + the re-entry DNC lift');
});

test('PR4 — removeDispositionsFromCampaign is BUILT but UNREGISTERED', async () => {
  // The op exists in admin-writes.js and must stay unreachable: its required
  // guard (refuse any disposition in the CC payroll bonus mapping) has no
  // authoritative source, and a guard keyed on a guessed list reads as
  // protection while protecting nothing. This pins BOTH halves — the executor
  // exists, and nothing can queue it.
  const writes = await import('../src/five9/admin-writes.js');
  assert.equal(typeof writes.executeRemoveDispositionsFromCampaign, 'function',
    'the executor must remain built, so registering it later is a wiring change, not a rewrite');

  const { ACTION_HANDLERS } = await import('../src/actions/index.js');
  assert.equal(Object.hasOwn(ACTION_HANDLERS, 'five9_remove_dispositions_from_campaign'), false,
    'must not be queueable while its payroll guard has no source');
  assert.equal(
    OP_REGISTRY.some((e) => e.actionType === 'five9_remove_dispositions_from_campaign'), false,
    'must not appear in OP_REGISTRY');
  assert.equal(OP_CLASSIFICATION.removeDispositionsFromCampaign.status, 'not-built',
    'classification must report it as not shipped');

  // And the guard itself must refuse rather than pass while unenforceable —
  // the failure mode to prevent is a mapping-less guard that quietly allows.
  const verdict = writes.checkPayrollDispositions(['NoRehash']);
  assert.equal(verdict.ok, false, 'an unenforceable payroll guard must REFUSE, never allow');
  assert.equal(verdict.unenforceable, true);
});

test('the registry declares buildFromSchema for exactly the migrated ops', () => {
  // PR3 migrated one op (plus its modify sibling). PR4 adds 13 more, all of
  // them schema-walked: every request wrapper in that tranche is itself a
  // complexType, so there is no hand-written field order in it at all.
  const migrated = OP_REGISTRY.filter((e) => e.builder === 'buildFromSchema').map((e) => e.actionType).sort();
  assert.deepEqual(migrated, [
    'five9_add_dispositions_to_campaign',
    'five9_add_lists_to_campaign',
    'five9_add_skills_to_campaign',
    'five9_create_campaign_profile',
    'five9_create_list',
    'five9_create_outbound_campaign',
    'five9_create_web_connector',
    'five9_modify_campaign_lists',
    'five9_modify_campaign_profile',
    'five9_modify_web_connector',
    'five9_remove_lists_from_campaign',
    'five9_remove_skills_from_campaign',
    'five9_reset_campaign_dispositions',
    'five9_reset_list_position',
    'five9_set_campaign_strategies',
  ]);
});

/* ====================================================================== *
 * 3. the deny-list — the part that must never go quiet
 * ====================================================================== */

test('no denied operation is registered', () => {
  const violations = OP_REGISTRY
    .filter((e) => isDenied(e.soapOperation))
    .map((e) => `${e.actionType} → ${e.soapOperation}: ${DENIED_OPERATIONS[e.soapOperation]}`);
  assert.deepEqual(violations, [], 'a DENIED operation has an action type');
});

test('no denied operation has a reachable handler', async () => {
  const { ACTION_HANDLERS } = await import('../src/actions/index.js');
  const byAction = registryByActionType();
  for (const actionType of Object.keys(ACTION_HANDLERS).filter((k) => k.startsWith('five9_'))) {
    const entry = byAction.get(actionType);
    assert.ok(entry, `${actionType} is dispatchable but not in the registry`);
    assert.equal(
      isDenied(entry.soapOperation), false,
      `${actionType} dispatches to DENIED ${entry.soapOperation}`
    );
  }
});

test('forbidden action types resolve to nothing at all', async () => {
  const { ACTION_HANDLERS } = await import('../src/actions/index.js');
  for (const actionType of FORBIDDEN_ACTION_TYPES) {
    assert.equal(
      Object.hasOwn(ACTION_HANDLERS, actionType), false,
      `${actionType} must not be registered`
    );
    // This is the exact lookup executeSingleAction performs. undefined is what
    // sends the row down the "Unknown action type: ..." path.
    assert.equal(ACTION_HANDLERS[actionType], undefined);
  }
});

test('five9_remove_numbers_from_dnc still resolves to "Unknown action type"', async () => {
  // Ruled by Mark 2026-08-21 and removed outright. AMENDED 2026-09-21: a
  // consumer who re-enters through a fresh first-party submission is lifted
  // everywhere, Five9 included. That amendment reaches the SOAP method
  // through ONE welded action type and changes nothing here — the GENERAL
  // action type is still unknown, and that is the invariant this test exists
  // for. The op EXISTS in v13; our refusal is what keeps it unreachable.
  const { ACTION_HANDLERS } = await import('../src/actions/index.js');
  assert.equal(ACTION_HANDLERS.five9_remove_numbers_from_dnc, undefined);
  assert.equal(Object.hasOwn(ACTION_HANDLERS, 'five9_remove_numbers_from_dnc'), false);
  assert.ok(FORBIDDEN_ACTION_TYPES.includes('five9_remove_numbers_from_dnc'),
    'the general type must stay on the forbidden list, amendment or not');

  assert.ok(schema.operations.removeNumbersFromDnc, 'precondition: the SOAP op does exist in v13');

  // Exactly one caller, and it is the welded one. A SECOND entry here is the
  // change that would quietly restore general removal.
  const callers = OP_REGISTRY.filter((e) => e.soapOperation === 'removeNumbersFromDnc');
  assert.deepEqual(callers.map((e) => e.actionType), ['five9_remove_numbers_from_dnc_reentry'],
    'removeNumbersFromDnc may have exactly ONE caller, the re-entry lift');
  assert.equal(callers[0].tier, 'gated', 'it is gated, never enabled — the gate is the whole design');

  // The classification must still carry the original ruling, so the next
  // reader sees what was amended rather than only what is allowed now.
  assert.match(OP_CLASSIFICATION.removeNumbersFromDnc.reason, /2026-08-21/);
  assert.match(OP_CLASSIFICATION.removeNumbersFromDnc.reason, /DNC_LIFT_ON_REENTRY_E0/);
});

test('the re-entry lift REFUSES every caller but its one rule', async () => {
  // The structural pins above say only one action type reaches the SOAP
  // method. This one says the op itself does not trust that: it re-checks
  // rule_applied at execution, so a row queued by anything else is refused
  // even if someone wires it up.
  const writes = await import('../src/five9/admin-writes.js');
  await assert.rejects(
    () => writes.executeRemoveNumbersFromDncReentry(
      { id: 1, target_id: 'c1', rule_applied: 'DNC_LIFT_ON_REENGAGEMENT_LP', action_payload: {} }, {}),
    /REFUSED: five9_remove_numbers_from_dnc_reentry runs only for DNC_LIFT_ON_REENTRY_E0/,
  );
});

test('DNC removal is reachable ONLY through the re-entry lift', () => {
  const adds = OP_REGISTRY.filter((e) => e.soapOperation === 'addNumbersToDnc');
  assert.equal(adds.length, 1);
  assert.equal(adds[0].actionType, 'five9_add_numbers_to_dnc');
  const dncOps = OP_REGISTRY.filter((e) => /Dnc/i.test(e.soapOperation)).map((e) => e.soapOperation).sort();
  assert.deepEqual(dncOps, ['addNumbersToDnc', 'removeNumbersFromDnc'],
    'adds, plus the one welded removal — nothing else may touch DNC');
});

test('deleteIVRScript stays create-compensation only, never an action type', () => {
  assert.ok(isDenied('deleteIVRScript'));
  assert.equal(OP_REGISTRY.some((e) => e.soapOperation === 'deleteIVRScript'), false);
  assert.match(DENIED_OPERATIONS.deleteIVRScript, /create-compensation/);
});

test('the explicitly-ruled delete* family is denied, by name', () => {
  // These sixteen were ruled by name. Pinned individually so a later edit has
  // to argue with a named operation rather than silently widen a pattern.
  const RULED_DENIED = [
    'deleteUser', 'deleteList', 'deleteCampaign', 'deleteCampaignProfile',
    'deleteSkill', 'deleteAgentGroup', 'deleteIVRScript', 'deleteContactField',
    'deleteCallVariable', 'deleteCallVariablesGroup', 'deleteWebConnector',
    'deleteUserProfile', 'deleteReasonCode', 'deleteReasonCodeByType',
    'deleteAllFromList', 'deleteFromContacts',
  ];
  for (const op of RULED_DENIED) {
    assert.ok(schema.operations[op], `precondition: ${op} exists in v13`);
    assert.equal(OP_CLASSIFICATION[op]?.tier, 'denied', `${op} must be denied`);
    assert.ok(isDenied(op));
  }
  // deleteFromContacts* — the CSV and FTP variants ride the same ruling.
  for (const op of ['deleteFromContactsCsv', 'deleteFromContactsFtp']) {
    assert.equal(OP_CLASSIFICATION[op]?.tier, 'denied', `${op} must be denied`);
  }
});

test('no delete* operation is unclassified, and none is newly enabled', () => {
  // A sweep so a Five9 version bump that ADDS a delete* operation fails here
  // rather than slipping in unclassified.
  //
  // The ruling's blanket phrasing ("every delete* operation") and its own
  // enumeration disagree on exactly one op: deleteRecordFromList, which is not
  // in the enumeration and has shipped as five9_delete_record_from_list since
  // Phase C. It removes ONE record from a dialing list by dial key — it
  // destroys no configuration object and no history, which is the property the
  // rest of the family is denied for. It is allowlisted here, by name, rather
  // than the pattern being loosened.
  const ALREADY_SHIPPED = new Set(['deleteRecordFromList']);
  const deletes = Object.keys(schema.operations).filter((op) => /^delete/.test(op));
  assert.ok(deletes.length >= 15, `expected the delete* family, found ${deletes.length}`);

  for (const op of deletes) {
    const row = OP_CLASSIFICATION[op];
    assert.ok(row, `${op} is unclassified`);
    if (ALREADY_SHIPPED.has(op)) {
      assert.equal(row.status, 'shipped', `${op} is allowlisted but no longer ships`);
      continue;
    }
    assert.ok(
      row.tier === 'denied' || row.tier === 'skip',
      `${op} is tier ${row.tier} — a delete* operation may only be denied or skipped`
    );
    if (row.tier === 'skip') {
      assert.match(row.reason, /already ships|redundant/i, `${op} is skipped without a redundancy reason`);
    }
  }
});

/* ====================================================================== *
 * 4. the classification document
 * ====================================================================== */

test('classification covers exactly the 182 v13 operations', () => {
  assert.deepEqual(unknownOperations(schema), [], 'classified operations that do not exist in v13');
  assert.deepEqual(unclassifiedOperations(schema), [], 'v13 operations with no classification row');
  assert.equal(Object.keys(OP_CLASSIFICATION).length, schema.operationCount);
  assert.equal(schema.operationCount, 182);
});

test('every classification row is complete — no blanks', () => {
  for (const [op, row] of Object.entries(OP_CLASSIFICATION)) {
    assert.ok(KINDS.includes(row.kind), `${op}: kind ${row.kind}`);
    assert.ok(TIERS.includes(row.tier), `${op}: tier ${row.tier}`);
    assert.ok(STATUSES.includes(row.status), `${op}: status ${row.status}`);
    assert.ok(row.reason && row.reason.trim().length > 0, `${op}: empty reason`);
  }
});

test('every denied and gated row carries a specific reason', () => {
  // "Specific" is not fully machine-checkable, but a generic caution is short
  // and a specific one is not. This catches "too risky" and "be careful".
  for (const tier of ['denied', 'gated']) {
    for (const [op, row] of byTier(tier)) {
      assert.ok(
        row.reason.trim().length >= 40,
        `${op} (${tier}) reason is too short to be specific: ${JSON.stringify(row.reason)}`
      );
      assert.doesNotMatch(
        row.reason, /^(too risky|dangerous|be careful|unsafe|not safe)\.?$/i,
        `${op} (${tier}) reason is a generic caution`
      );
    }
  }
});

test('reads are never registered as agent actions', () => {
  const registeredOps = new Set(OP_REGISTRY.map((e) => e.soapOperation));
  for (const [op, row] of Object.entries(OP_CLASSIFICATION)) {
    if (row.kind !== 'read') continue;
    assert.equal(registeredOps.has(op), false, `${op} is a read but sits in the write registry`);
    assert.ok(
      row.tier === 'skip' || row.tier === 'denied',
      `${op} is a read at tier ${row.tier} — reads are skip (or denied by a ruling)`
    );
  }
});

test('every shipped write op in the classification has a registry entry', () => {
  const registeredOps = new Set(OP_REGISTRY.map((e) => e.soapOperation));
  // forceStopCampaign rides five9_stop_campaign; deleteIVRScript is
  // create-compensation. Both are shipped without an action type of their own,
  // and both say so in their reason.
  const RIDES_ANOTHER_TYPE = new Set(['forceStopCampaign', 'deleteIVRScript']);
  for (const [op, row] of Object.entries(OP_CLASSIFICATION)) {
    if (row.kind !== 'write' || row.status !== 'shipped') continue;
    if (RIDES_ANOTHER_TYPE.has(op)) continue;
    assert.ok(registeredOps.has(op), `${op} is marked shipped but has no registry entry`);
  }
});

test('the four v9.5 ghost operations stay absent', () => {
  // Named in earlier planning as real; none exist in v13. Pinned so nobody
  // reintroduces them from the same stale reference.
  for (const ghost of [
    'getCallLogReport', 'getCallLogReportCsv',
    'getAgentAuditReport', 'getAgentAuditReportCsv',
    'resetListPositions',
  ]) {
    assert.equal(schema.operations[ghost], undefined, `${ghost} appeared in v13`);
    assert.equal(OP_CLASSIFICATION[ghost], undefined, `${ghost} must not be classified`);
  }
  assert.ok(schema.operations.resetListPosition, 'the real name is singular');
  assert.ok(OP_CLASSIFICATION.resetListPosition);
});

test('the two never-considered surfaces are classified and flagged', () => {
  for (const op of ['createSpeedDialNumber', 'removeSpeedDialNumber']) {
    assert.ok(OP_CLASSIFICATION[op], `${op} unclassified`);
    assert.match(OP_CLASSIFICATION[op].reason, /NEW SURFACE|available if needed/);
  }
  // getSpeedDialNumbers stopped being a never-considered surface in PR4: it
  // ships inside five9_get_config. Its row is asserted here rather than
  // dropped, so the surface stays covered by a test either way.
  assert.equal(OP_CLASSIFICATION.getSpeedDialNumbers.status, 'shipped');
  assert.match(OP_CLASSIFICATION.getSpeedDialNumbers.reason, /five9_get_config/);
  for (const op of [
    'getIvrIcons', 'setIvrIcons', 'removeIvrIcons',
    'getIvrScriptOwnership', 'setIvrScriptOwnership', 'removeIvrScriptOwnership',
  ]) {
    assert.ok(OP_CLASSIFICATION[op], `${op} unclassified`);
    assert.match(OP_CLASSIFICATION[op].reason, /NEW SURFACE/);
  }
  // The schema is what says ownership is not an access-control grant.
  assert.deepEqual(schema.operations.setIvrScriptOwnership.fields, ['ivrScriptName', 'othersCanCopy']);
});

test('docs/five9/op-classification.md is regenerated and current', () => {
  // The doc is generated, so "no blanks, all 182" is a property of the
  // generator. This asserts the committed file matches what it would produce.
  execFileSync(
    process.execPath,
    [resolve(HERE, 'five9-gen-op-classification.js'), '--check'],
    { stdio: 'pipe' }
  );
});
