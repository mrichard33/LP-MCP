/**
 * Offline unit tests for the Phase C Five9 write-side builders and
 * guardrails. No network, no DB. Run:
 *   node --test scripts/test-five9-admin-writes.js
 *
 * Mirrors the scripts/test-five9-list-dispatch.js pattern: only pure
 * exported builders/predicates are exercised, plus the flag-off
 * short-circuit that proves the module ships dark.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  five9WritesEnabled,
  refuseIfInbound,
  checkCompliancePatch,
  validateDncRemovals,
  buildCampaignNameXml,
  buildNumbersXml,
  secondsToTimerXml,
  buildModifyOutboundCampaignXml,
  buildAddRecordToListXml,
  buildDeleteRecordFromListXml,
  PATCHABLE_FIELDS,
  MAX_RECORDS_PER_ACTION,
  executeStartCampaign,
  decideLifecycleNoop,
  requiredConfirmToken,
  checkConfirmToken,
  // 2026-08-05 Phase D
  buildUserSkillXml,
  buildCampaignProfileXml,
  checkProfileCompliance,
  exactUserPattern,
  actionFieldXml,
  PROFILE_PATCHABLE_FIELDS,
  MAX_PROFILE_ATTEMPTS_LIMIT,
  // 2026-08-06 Phase E
  MIN_CRM_REDIAL_SEC_LIMIT,
  OUTBOUND_CAMPAIGN_FIELD_ORDER,
  // 2026-08-06 Phase E-2 — timer read-back verification
  timerStructToSeconds,
  verifyPatchReadBack,
} from '../src/five9/admin-writes.js';

test('five9WritesEnabled: ships dark — unset/false off, only literal "true" on', () => {
  const saved = process.env.FIVE9_WRITES_ENABLED;
  try {
    delete process.env.FIVE9_WRITES_ENABLED;
    assert.equal(five9WritesEnabled(), false);
    process.env.FIVE9_WRITES_ENABLED = 'false';
    assert.equal(five9WritesEnabled(), false);
    process.env.FIVE9_WRITES_ENABLED = '1';
    assert.equal(five9WritesEnabled(), false);
    process.env.FIVE9_WRITES_ENABLED = 'true';
    assert.equal(five9WritesEnabled(), true);
  } finally {
    if (saved === undefined) delete process.env.FIVE9_WRITES_ENABLED;
    else process.env.FIVE9_WRITES_ENABLED = saved;
  }
});

test('flag-off = DRY-RUN: reads still run (fails on missing creds here), write seam never fires', async () => {
  // With FIVE9_WRITES_ENABLED unset the gate goes dry-run: guardrail reads
  // execute for real (previous_state capture). In this offline env there are
  // no creds, so the read fails loudly BEFORE any write path — proving the
  // dry-run path cannot silently mutate and never bypasses the read gate.
  const saved = { flag: process.env.FIVE9_WRITES_ENABLED, u: process.env.FIVE9_USERNAME, p: process.env.FIVE9_PASSWORD };
  try {
    delete process.env.FIVE9_WRITES_ENABLED;
    delete process.env.FIVE9_USERNAME;
    delete process.env.FIVE9_PASSWORD;
    await assert.rejects(
      executeStartCampaign({
        id: 1,
        action_type: 'five9_start_campaign',
        requires_approval: true,
        action_payload: { campaign_name: 'X' },
      }),
      /credentials not configured/
    );
  } finally {
    for (const [k, env] of [['flag', 'FIVE9_WRITES_ENABLED'], ['u', 'FIVE9_USERNAME'], ['p', 'FIVE9_PASSWORD']]) {
      if (saved[k] === undefined) delete process.env[env];
      else process.env[env] = saved[k];
    }
  }
});

test('decideLifecycleNoop: start/stop preconditions, reset unconditional', () => {
  assert.equal(decideLifecycleNoop('start_campaign', 'RUNNING'), 'already_running');
  assert.equal(decideLifecycleNoop('start_campaign', 'NOT_RUNNING'), null);
  assert.equal(decideLifecycleNoop('stop_campaign', 'NOT_RUNNING'), 'already_stopped');
  assert.equal(decideLifecycleNoop('stop_campaign', 'RUNNING'), null);
  assert.equal(decideLifecycleNoop('reset_campaign', 'RUNNING'), null);
  assert.equal(decideLifecycleNoop('reset_campaign', 'NOT_RUNNING'), null);
});

test('confirm_token: the two highest-risk writes must restate their target verbatim', () => {
  // set_outbound_campaign — token = campaign name
  assert.equal(requiredConfirmToken('set_outbound_campaign', { campaign_name: 'Rehash' }), 'Rehash');
  assert.doesNotThrow(() => checkConfirmToken('set_outbound_campaign', { campaign_name: 'Rehash', confirm_token: 'Rehash' }));
  assert.throws(() => checkConfirmToken('set_outbound_campaign', { campaign_name: 'Rehash' }), /confirm_token mismatch/);
  assert.throws(() => checkConfirmToken('set_outbound_campaign', { campaign_name: 'Rehash', confirm_token: 'rehash' }), /confirm_token mismatch/);
  // remove_numbers_from_dnc — token = comma-joined numbers
  const payload = { removals: [{ number: '5551234567', reason: 'r1' }, { number: ' 5559876543 ', reason: 'r2' }] };
  assert.equal(requiredConfirmToken('remove_numbers_from_dnc', payload), '5551234567,5559876543');
  assert.doesNotThrow(() => checkConfirmToken('remove_numbers_from_dnc', { ...payload, confirm_token: '5551234567,5559876543' }));
  assert.throws(() => checkConfirmToken('remove_numbers_from_dnc', { ...payload, confirm_token: '5551234567' }), /confirm_token mismatch/);
  assert.throws(() => checkConfirmToken('remove_numbers_from_dnc', payload), /confirm_token mismatch/);
  // other ops are not double-gated
  assert.equal(requiredConfirmToken('start_campaign', { campaign_name: 'X' }), null);
  assert.doesNotThrow(() => checkConfirmToken('start_campaign', { campaign_name: 'X' }));
});

test('refuseIfInbound: INBOUND throws, OUTBOUND/AUTODIAL pass', () => {
  assert.throws(() => refuseIfInbound({ name: 'Main Number', type: 'INBOUND' }), /INBOUND campaigns are immutable/);
  assert.throws(() => refuseIfInbound({ type: 'inbound' }), /immutable/);
  assert.doesNotThrow(() => refuseIfInbound({ type: 'OUTBOUND' }));
  assert.doesNotThrow(() => refuseIfInbound({ type: 'AUTODIAL' }));
});

test('checkCompliancePatch: FCC/FTC boundaries', () => {
  // At the limits — allowed
  assert.equal(checkCompliancePatch({ maxQueueTime: 2, maxDroppedCallsPercentage: 3 }).ok, true);
  // Over either limit — refused
  assert.equal(checkCompliancePatch({ maxQueueTime: 2.5 }).ok, false);
  assert.equal(checkCompliancePatch({ maxDroppedCallsPercentage: 3.1 }).ok, false);
  const both = checkCompliancePatch({ maxQueueTime: 3, maxDroppedCallsPercentage: 3.5 });
  assert.equal(both.ok, false);
  assert.equal(both.violations.length, 2);
  // Explicit override passes but records the violations
  const ov = checkCompliancePatch({ maxQueueTime: 3 }, { complianceOverride: true });
  assert.equal(ov.ok, true);
  assert.equal(ov.overridden, true);
  // Strict === true: truthy lookalikes do NOT override
  assert.equal(checkCompliancePatch({ maxQueueTime: 3 }, { complianceOverride: 'true' }).ok, false);
  assert.equal(checkCompliancePatch({ maxQueueTime: 3 }, { complianceOverride: 1 }).ok, false);
  // Fields absent from the patch are not judged
  assert.equal(checkCompliancePatch({ dialingMode: 'POWER' }).ok, true);
});

test('validateDncRemovals: per-number reason is mandatory', () => {
  assert.throws(() => validateDncRemovals([]), /requires removals/);
  assert.throws(() => validateDncRemovals(undefined), /requires removals/);
  assert.throws(() => validateDncRemovals([{ number: '5551234567' }]), /missing reason/);
  assert.throws(() => validateDncRemovals([{ number: '5551234567', reason: '   ' }]), /missing reason/);
  assert.throws(() => validateDncRemovals([{ reason: 'typo entry' }]), /missing number/);
  const ok = validateDncRemovals([{ number: ' 5551234567 ', reason: ' customer re-consented 2026-07-20 ' }]);
  assert.deepEqual(ok, [{ number: '5551234567', reason: 'customer re-consented 2026-07-20' }]);
});

test('buildCampaignNameXml: snapshot + escaping + required', () => {
  assert.equal(buildCampaignNameXml('DIAL ASAP'), '<campaignName>DIAL ASAP</campaignName>');
  assert.equal(buildCampaignNameXml("O'Brien & Sons"), '<campaignName>O&apos;Brien &amp; Sons</campaignName>');
  assert.throws(() => buildCampaignNameXml(''), /required/);
  assert.throws(() => buildCampaignNameXml('   '), /required/);
});

test('buildNumbersXml: repeated elements, trimming, escaping', () => {
  assert.equal(buildNumbersXml(['5551234567', ' 5559876543 ']), '<numbers>5551234567</numbers><numbers>5559876543</numbers>');
  assert.throws(() => buildNumbersXml([]), /required/);
  assert.throws(() => buildNumbersXml(['', '  ']), /required/);
});

test('secondsToTimerXml: decomposition and validation', () => {
  assert.equal(secondsToTimerXml('maxQueueTime', 2),
    '<maxQueueTime><days>0</days><hours>0</hours><minutes>0</minutes><seconds>2</seconds></maxQueueTime>');
  assert.equal(secondsToTimerXml('maxQueueTime', 90),
    '<maxQueueTime><days>0</days><hours>0</hours><minutes>1</minutes><seconds>30</seconds></maxQueueTime>');
  assert.equal(secondsToTimerXml('maxPreviewTime', 86400 + 3661),
    '<maxPreviewTime><days>1</days><hours>1</hours><minutes>1</minutes><seconds>1</seconds></maxPreviewTime>');
  assert.throws(() => secondsToTimerXml('maxQueueTime', -1), /non-negative/);
  assert.throws(() => secondsToTimerXml('maxQueueTime', 'soon'), /non-negative/);
});

test('buildModifyOutboundCampaignXml: xs:sequence order — base fields before extension fields', () => {
  const xml = buildModifyOutboundCampaignXml('Rehash', {
    dialingMode: 'POWER',
    dialingRatio: 2,
    maxDroppedCallsPercentage: 3,
    maxQueueTime: 2,
    callsAgentRatio: 1.5,
  });
  assert.match(xml, /^<campaign><name>Rehash<\/name>/);
  assert.match(xml, /<\/campaign>$/);
  const order = ['<name>', '<callsAgentRatio>', '<dialingMode>', '<dialingRatio>', '<maxDroppedCallsPercentage>', '<maxQueueTime>'];
  const idx = order.map(t => xml.indexOf(t));
  assert.ok(idx.every(i => i >= 0), `all fields present: ${xml}`);
  for (let i = 1; i < idx.length; i++) {
    assert.ok(idx[i] > idx[i - 1], `${order[i]} must come after ${order[i - 1]} (WSDL sequence): ${xml}`);
  }
  // Timer fields serialize as structs
  assert.match(xml, /<maxQueueTime><days>0<\/days><hours>0<\/hours><minutes>0<\/minutes><seconds>2<\/seconds><\/maxQueueTime>/);
});

test('buildModifyOutboundCampaignXml: only supplied fields; unknown/non-whitelisted keys throw', () => {
  const xml = buildModifyOutboundCampaignXml('Rehash', { dialingMode: 'PREDICTIVE' });
  assert.doesNotMatch(xml, /<dialingRatio>/);
  assert.doesNotMatch(xml, /<maxQueueTime>/);
  assert.doesNotMatch(xml, /<state>/);
  assert.throws(() => buildModifyOutboundCampaignXml('Rehash', { maxQueTime: 2 }), /not a patchable/); // typo guard
  assert.throws(() => buildModifyOutboundCampaignXml('Rehash', { state: 'RUNNING' }), /not a patchable/); // lifecycle is start/stop, not a patch
  assert.throws(() => buildModifyOutboundCampaignXml('Rehash', {}), /at least one field/);
  assert.throws(() => buildModifyOutboundCampaignXml('', { dialingMode: 'POWER' }), /required/);
  assert.ok(PATCHABLE_FIELDS.has('dialingMode') && !PATCHABLE_FIELDS.has('state'));
});

test('buildAddRecordToListXml: WSDL-correct record (<fields>), schema-required booleans, key on number1', () => {
  const xml = buildAddRecordToListXml('Callbacks', ['number1', 'first_name'], ['5551234567', "O'Brien"]);
  assert.match(xml, /^<listName>Callbacks<\/listName>/);
  assert.match(xml, /<fieldsMapping><columnNumber>1<\/columnNumber><fieldName>number1<\/fieldName><key>true<\/key><\/fieldsMapping>/);
  assert.match(xml, /<fieldsMapping><columnNumber>2<\/columnNumber><fieldName>first_name<\/fieldName><key>false<\/key><\/fieldsMapping>/);
  // basicImportSettings base field precedes the extension fields
  assert.ok(xml.indexOf('<skipHeaderLine>false</skipHeaderLine>') < xml.indexOf('<cleanListBeforeUpdate>false</cleanListBeforeUpdate>'));
  assert.match(xml, /<crmAddMode>ADD_NEW<\/crmAddMode><crmUpdateMode>UPDATE_FIRST<\/crmUpdateMode><listAddMode>ADD_FIRST<\/listAddMode>/);
  // recordData is repeated <fields>, not <values> (report-row type)
  assert.match(xml, /<record><fields>5551234567<\/fields><fields>O&apos;Brien<\/fields><\/record>$/);
  assert.doesNotMatch(xml, /<values>/);
  assert.throws(() => buildAddRecordToListXml('L', ['a'], ['x', 'y']), /mismatch/);
});

test('buildDeleteRecordFromListXml: settings order, delete mode enum, null values', () => {
  const xml = buildDeleteRecordFromListXml('Callbacks', ['number1'], ['5551234567']);
  assert.match(xml, /<listDeleteSettings><fieldsMapping><columnNumber>1<\/columnNumber><fieldName>number1<\/fieldName><key>true<\/key><\/fieldsMapping><skipHeaderLine>false<\/skipHeaderLine><listDeleteMode>DELETE_ALL<\/listDeleteMode><\/listDeleteSettings>/);
  assert.match(xml, /<record><fields>5551234567<\/fields><\/record>$/);
  const xml2 = buildDeleteRecordFromListXml('L', ['number1', 'notes'], ['5551234567', null], 'DELETE_EXCEPT_FIRST');
  assert.match(xml2, /<listDeleteMode>DELETE_EXCEPT_FIRST<\/listDeleteMode>/);
  assert.match(xml2, /<fields>5551234567<\/fields><fields><\/fields>/); // null -> empty
  assert.throws(() => buildDeleteRecordFromListXml('L', ['a'], ['x'], 'NUKE_EVERYTHING'), /invalid list_delete_mode/);
  assert.throws(() => buildDeleteRecordFromListXml('L', ['a', 'b'], ['x']), /mismatch/);
});

test('MAX_RECORDS_PER_ACTION is the documented 50-record cap', () => {
  assert.equal(MAX_RECORDS_PER_ACTION, 50);
});

/* ---------------------------------------------------------------------- *
 * Phase D (2026-08-05) — user skills, campaign profiles, and the Phase C
 * complex-type serialization regression.
 * ---------------------------------------------------------------------- */

test('buildUserSkillXml: WSDL xs:sequence order — id, level, skillName, userName', () => {
  const xml = buildUserSkillXml({ userName: 'cdeer', skillName: 'Dispatch', level: 2 });
  assert.equal(xml, '<userSkill><level>2</level><skillName>Dispatch</skillName><userName>cdeer</userName></userSkill>');
  // <id> is never sent — userName + skillName are the natural key
  assert.doesNotMatch(xml, /<id>/);
  // level precedes skillName precedes userName (WSDL sequence, not payload order)
  const order = ['<level>', '<skillName>', '<userName>'];
  const idx = order.map(t => xml.indexOf(t));
  for (let i = 1; i < idx.length; i++) {
    assert.ok(idx[i] > idx[i - 1], `${order[i]} must come after ${order[i - 1]}: ${xml}`);
  }
});

test('buildUserSkillXml: userName and skillName are both required', () => {
  assert.throws(() => buildUserSkillXml({ skillName: 'Dispatch', level: 1 }), /userName is required/);
  assert.throws(() => buildUserSkillXml({ userName: 'cdeer', level: 1 }), /skillName is required/);
  assert.throws(() => buildUserSkillXml({ userName: '  ', skillName: 'Dispatch', level: 1 }), /userName is required/);
});

test('buildUserSkillXml: level is schema-required and bounded 1–9', () => {
  assert.throws(() => buildUserSkillXml({ userName: 'cdeer', skillName: 'Dispatch', level: 0 }), /level must be/);
  assert.throws(() => buildUserSkillXml({ userName: 'cdeer', skillName: 'Dispatch', level: 10 }), /level must be/);
  // omitted level is NOT allowed — <level> is the one element in the WSDL
  // userSkill type without minOccurs="0"
  assert.throws(() => buildUserSkillXml({ userName: 'cdeer', skillName: 'Dispatch' }), /level must be/);
  assert.doesNotThrow(() => buildUserSkillXml({ userName: 'cdeer', skillName: 'Dispatch', level: 3 }));
  assert.match(buildUserSkillXml({ userName: 'cdeer', skillName: 'Dispatch', level: 9 }), /<level>9<\/level>/);
});

test('exactUserPattern: anchored and regex-escaped so jflanders cannot match jflanders2', () => {
  assert.equal(exactUserPattern('jflanders'), '^jflanders$');
  // a dot in an email-style login stays literal
  assert.equal(exactUserPattern('r.lymych@x.com'), '^r\\.lymych@x\\.com$');
  const re = new RegExp(exactUserPattern('jflanders'));
  assert.equal(re.test('jflanders'), true);
  assert.equal(re.test('jflanders2'), false);
  assert.equal(re.test('xjflanders'), false);
});

test('buildCampaignProfileXml: WSDL xs:sequence order — name lands seventh, not first', () => {
  const xml = buildCampaignProfileXml('Data Leads', { numberOfAttempts: 8, ANI: '7275133151' });
  assert.match(xml, /^<campaignProfile>/);
  assert.match(xml, /<\/campaignProfile>$/);
  // ANI, ..., name, numberOfAttempts — the read-response order was NOT reversed
  const order = ['<ANI>', '<name>', '<numberOfAttempts>'];
  const idx = order.map(t => xml.indexOf(t));
  assert.ok(idx.every(i => i >= 0), `all fields present: ${xml}`);
  for (let i = 1; i < idx.length; i++) {
    assert.ok(idx[i] > idx[i - 1], `${order[i]} must come after ${order[i - 1]} (WSDL sequence): ${xml}`);
  }
});

test('buildCampaignProfileXml: refuses non-whitelisted fields and empty patches', () => {
  assert.throws(
    () => buildCampaignProfileXml('Data Leads', { dialingSchedule: {} }),
    /REFUSED: "dialingSchedule" is not a patchable campaign profile field/,
  );
  assert.throws(() => buildCampaignProfileXml('Data Leads', { name: 'Renamed' }), /REFUSED: "name"/);
  assert.throws(() => buildCampaignProfileXml('Data Leads', {}), /at least one field/);
  assert.throws(() => buildCampaignProfileXml('', { ANI: '1' }), /profile_name is required/);
  assert.equal(PROFILE_PATCHABLE_FIELDS.has('dialingSchedule'), false);
});

test('checkProfileCompliance: attempts ceiling mirrors the abandon-rate line', () => {
  assert.equal(MAX_PROFILE_ATTEMPTS_LIMIT, 12);
  assert.equal(checkProfileCompliance({ numberOfAttempts: 12 }).ok, true);
  // the live Data Leads value
  const over = checkProfileCompliance({ numberOfAttempts: 100 });
  assert.equal(over.ok, false);
  assert.equal(over.violations.length, 1);
  const ov = checkProfileCompliance({ numberOfAttempts: 100 }, { complianceOverride: true });
  assert.equal(ov.ok, true);
  assert.equal(ov.overridden, true);
  // Strict === true: truthy lookalikes do NOT override
  assert.equal(checkProfileCompliance({ numberOfAttempts: 100 }, { complianceOverride: 'true' }).ok, false);
  assert.equal(checkProfileCompliance({ numberOfAttempts: 100 }, { complianceOverride: 1 }).ok, false);
  // Fields absent from the patch are not judged
  assert.equal(checkProfileCompliance({ ANI: '7275133151' }).ok, true);
});

test('confirm_token: modify_campaign_profile restates the profile name', () => {
  assert.equal(requiredConfirmToken('modify_campaign_profile', { profile_name: 'Data Leads' }), 'Data Leads');
  assert.doesNotThrow(() =>
    checkConfirmToken('modify_campaign_profile', { profile_name: 'Data Leads', confirm_token: 'Data Leads' }));
  // wrong case is a mismatch — exact restatement only
  assert.throws(
    () => checkConfirmToken('modify_campaign_profile', { profile_name: 'Data Leads', confirm_token: 'data leads' }),
    /confirm_token mismatch/,
  );
  assert.throws(
    () => checkConfirmToken('modify_campaign_profile', { profile_name: 'Data Leads' }),
    /confirm_token mismatch/,
  );
});

test('actionFieldXml: complex action fields emit a nested <actionType>', () => {
  assert.equal(
    actionFieldXml('actionOnQueueExpiration', { actionType: 'DROP_CALL' }),
    '<actionOnQueueExpiration><actionType>DROP_CALL</actionType></actionOnQueueExpiration>',
  );
  // a bare string is accepted as shorthand
  assert.equal(
    actionFieldXml('actionOnAnswerMachine', 'HANGUP'),
    '<actionOnAnswerMachine><actionType>HANGUP</actionType></actionOnAnswerMachine>',
  );
  assert.throws(() => actionFieldXml('actionOnQueueExpiration', {}), /expected \{ actionType/);
  assert.throws(() => actionFieldXml('actionOnQueueExpiration', ''), /expected \{ actionType/);
});

test('buildModifyOutboundCampaignXml: REGRESSION — actionOnQueueExpiration is not "[object Object]"', () => {
  // Phase C whitelisted this field but ran escapeXml() over it, so every v1
  // patch touching it serialized the literal string "[object Object]".
  const xml = buildModifyOutboundCampaignXml('Rehash', {
    actionOnQueueExpiration: { actionType: 'DROP_CALL' },
  });
  assert.match(xml, /<actionOnQueueExpiration><actionType>DROP_CALL<\/actionType><\/actionOnQueueExpiration>/);
  assert.doesNotMatch(xml, /\[object Object\]/);
});

test('buildModifyOutboundCampaignXml: v2 whitelist fields land at their sequence positions', () => {
  const xml = buildModifyOutboundCampaignXml('DIAL ASAP', {
    profileName: 'Data-Hot',
    distributionAlgorithm: 'LongestReadyTime',
    previewDialImmediately: true,
    callAnalysisMode: 'FAX_AND_ANSWERING_MACHINE',
    dialingPriority: 1,
    limitPreviewTime: true,
    distributionTimeFrame: 'minutes15',
  });
  // base sequence (name, profileName) precedes the outboundCampaign extension
  const order = [
    '<name>', '<profileName>', '<callAnalysisMode>', '<dialingPriority>',
    '<distributionAlgorithm>', '<distributionTimeFrame>', '<limitPreviewTime>',
    '<previewDialImmediately>',
  ];
  const idx = order.map(t => xml.indexOf(t));
  assert.ok(idx.every(i => i >= 0), `all fields present: ${xml}`);
  for (let i = 1; i < idx.length; i++) {
    assert.ok(idx[i] > idx[i - 1], `${order[i]} must come after ${order[i - 1]} (WSDL sequence): ${xml}`);
  }
});

test('buildModifyOutboundCampaignXml: lifecycle fields stay refused after the v2 widening', () => {
  for (const field of ['state', 'type', 'trainingMode']) {
    assert.throws(
      () => buildModifyOutboundCampaignXml('Rehash', { [field]: 'X' }),
      new RegExp(`REFUSED: "${field}" is not a patchable outbound campaign field`),
      `${field} must stay refused`,
    );
    assert.equal(PATCHABLE_FIELDS.has(field), false);
  }
  // and the v2 additions ARE allowed
  for (const field of ['distributionAlgorithm', 'previewDialImmediately', 'profileName']) {
    assert.equal(PATCHABLE_FIELDS.has(field), true, `${field} should be patchable in v2`);
  }
});

/* ---------------------------------------------------------------------- *
 * Phase D-2 (2026-08-06) — five9_modify_campaign_profile.
 * The modifyCampaignProfile request wrapper is WSDL-verified as a single
 * child element name="campaignProfile" type="tns:campaignProfileInfo",
 * identical to createCampaignProfile — hence one shared builder.
 * ---------------------------------------------------------------------- */

test('buildCampaignProfileXml: one body serves BOTH create and modify — <campaignProfile>, never <profileName>', () => {
  // Regression guard: modifyCampaignProfile takes the same wrapper as
  // createCampaignProfile. A future "fix" to <profileName> would be a fault.
  const patch = { numberOfAttempts: 8 };
  const xml = buildCampaignProfileXml('Data Leads', patch);
  assert.match(xml, /^<campaignProfile>/);
  assert.match(xml, /<\/campaignProfile>$/);
  assert.doesNotMatch(xml, /<profileName>/);
  // byte-identical regardless of which op consumes it
  assert.equal(xml, buildCampaignProfileXml('Data Leads', patch));
});

test('buildCampaignProfileXml: modify patch keeps WSDL order — ANI before name before numberOfAttempts', () => {
  const xml = buildCampaignProfileXml('Data Leads', { numberOfAttempts: 8, ANI: '7275133151' });
  // patch key order is numberOfAttempts-first; emitted order must NOT follow it
  const order = ['<ANI>', '<name>', '<numberOfAttempts>'];
  const idx = order.map(t => xml.indexOf(t));
  assert.ok(idx.every(i => i >= 0), `all fields present: ${xml}`);
  for (let i = 1; i < idx.length; i++) {
    assert.ok(idx[i] > idx[i - 1], `${order[i]} must come after ${order[i - 1]} (WSDL sequence): ${xml}`);
  }
  assert.match(xml, /<name>Data Leads<\/name>/);
});

test('buildCampaignProfileXml: nested dialingSchedule stays non-patchable on the modify path', () => {
  assert.throws(
    () => buildCampaignProfileXml('Data Leads', { dialingSchedule: {} }),
    /REFUSED: "dialingSchedule" is not a patchable campaign profile field/,
  );
  assert.equal(PROFILE_PATCHABLE_FIELDS.has('dialingSchedule'), false);
});

test('modify_campaign_profile: confirm_token is required and case-sensitive', () => {
  assert.equal(requiredConfirmToken('modify_campaign_profile', { profile_name: 'Data Leads' }), 'Data Leads');
  assert.doesNotThrow(() =>
    checkConfirmToken('modify_campaign_profile', { profile_name: 'Data Leads', confirm_token: 'Data Leads' }));
  assert.throws(
    () => checkConfirmToken('modify_campaign_profile', { profile_name: 'Data Leads', confirm_token: 'data leads' }),
    /confirm_token mismatch/,
  );
});

test('modify_campaign_profile: attempts ceiling refuses the live Data Leads value without override', () => {
  assert.equal(MAX_PROFILE_ATTEMPTS_LIMIT, 12);
  assert.equal(checkProfileCompliance({ numberOfAttempts: 8 }).ok, true);
  assert.equal(checkProfileCompliance({ numberOfAttempts: 100 }).ok, false);
  // Rolling BACK to 100 is itself over the line — the rollback payload must
  // carry compliance_override:true. That is deliberate, not an oversight.
  const rollback = checkProfileCompliance({ numberOfAttempts: 100 }, { complianceOverride: true });
  assert.equal(rollback.ok, true);
  assert.equal(rollback.overridden, true);
});

/* ---------------------------------------------------------------------- *
 * Phase E (2026-08-06) — CRMRedialTimeout patchability.
 * The field lives in tns:baseOutboundCampaign, a level the v1 order array
 * skipped entirely. It is a tns:timer struct, not a scalar.
 * ---------------------------------------------------------------------- */

test('buildModifyOutboundCampaignXml: CRMRedialTimeout serializes as a timer struct, not an integer', () => {
  const xml = buildModifyOutboundCampaignXml('DIAL ASAP', { CRMRedialTimeout: 300 });
  assert.match(
    xml,
    /<CRMRedialTimeout><days>0<\/days><hours>0<\/hours><minutes>5<\/minutes><seconds>0<\/seconds><\/CRMRedialTimeout>/,
  );
  // the failure mode this guards: a bare integer
  assert.doesNotMatch(xml, /<CRMRedialTimeout>300<\/CRMRedialTimeout>/);
});

test('buildModifyOutboundCampaignXml: CRMRedialTimeout precedes the outboundCampaign extension', () => {
  // baseOutboundCampaign comes before the outboundCampaign extension in the chain
  const xml = buildModifyOutboundCampaignXml('DIAL ASAP', { CRMRedialTimeout: 300, dialingRatio: 10 });
  assert.ok(
    xml.indexOf('<CRMRedialTimeout>') < xml.indexOf('<dialingRatio>'),
    `CRMRedialTimeout must precede dialingRatio (WSDL sequence): ${xml}`,
  );
});

test('buildModifyOutboundCampaignXml: campaign base precedes CRMRedialTimeout', () => {
  // profileName is tns:campaign (level 1); CRMRedialTimeout is baseOutboundCampaign (level 3)
  const xml = buildModifyOutboundCampaignXml('DIAL ASAP', { profileName: 'X', CRMRedialTimeout: 300 });
  assert.ok(
    xml.indexOf('<profileName>') < xml.indexOf('<CRMRedialTimeout>'),
    `profileName must precede CRMRedialTimeout (WSDL sequence): ${xml}`,
  );
});

test('checkCompliancePatch: CRMRedialTimeout floor — 300s is the intended value and passes', () => {
  assert.equal(MIN_CRM_REDIAL_SEC_LIMIT, 300);
  assert.equal(checkCompliancePatch({ CRMRedialTimeout: 300 }).ok, true);
  assert.equal(checkCompliancePatch({ CRMRedialTimeout: 60 }).ok, false);
  const ov = checkCompliancePatch({ CRMRedialTimeout: 60 }, { complianceOverride: true });
  assert.equal(ov.ok, true);
  assert.equal(ov.overridden, true);
  // Strict === true, consistent with the other two lines
  assert.equal(checkCompliancePatch({ CRMRedialTimeout: 60 }, { complianceOverride: 'true' }).ok, false);
  // absent from the patch = not judged
  assert.equal(checkCompliancePatch({ dialingMode: 'POWER' }).ok, true);
});

test('REGRESSION: order-array membership does NOT grant patchability', () => {
  // The single most important test in Phase E. generalCampaign and
  // baseOutboundCampaign fields were added to OUTBOUND_CAMPAIGN_FIELD_ORDER so
  // the sequence is faithful to the WSDL. That must not make them writable.
  for (const field of ['autoRecord', 'analyzeLevel', 'listDialingMode', 'stateDialingRule', 'timeZoneAssignment']) {
    assert.ok(OUTBOUND_CAMPAIGN_FIELD_ORDER.includes(field), `${field} should be in the order array`);
    assert.equal(PATCHABLE_FIELDS.has(field), false, `${field} must NOT be patchable`);
    assert.throws(
      () => buildModifyOutboundCampaignXml('DIAL ASAP', { [field]: 'X' }),
      new RegExp(`REFUSED: "${field}" is not a patchable outbound campaign field`),
      `${field} must be refused at build time`,
    );
  }
});

test('every PATCHABLE_FIELD has a position in OUTBOUND_CAMPAIGN_FIELD_ORDER', () => {
  // A field in the whitelist but missing from the order array silently never
  // emits — no error, just a patch that does nothing.
  const missing = [...PATCHABLE_FIELDS].filter(f => !OUTBOUND_CAMPAIGN_FIELD_ORDER.includes(f));
  assert.deepEqual(missing, [], `whitelisted fields absent from the order array: ${missing.join(', ')}`);
});

/* ---------------------------------------------------------------------- *
 * Phase E-2 (2026-08-06) — tns:timer read-back verification.
 *
 * Regression origin: action 283332 set CRMRedialTimeout on DIAL ASAP from
 * 2h to 300s. The write landed correctly and Five9 read it back as
 * {days:'0',hours:'0',minutes:'5',seconds:'0'} — which IS 300 seconds — but
 * the verifier compared String(struct) to String(300), i.e. "[object Object]"
 * to "300", and reported verified:false. A permanent false negative on the
 * one field that says a gated write actually landed.
 * ---------------------------------------------------------------------- */

test('timerStructToSeconds: struct forms', () => {
  assert.equal(timerStructToSeconds({ days: '0', hours: '0', minutes: '5', seconds: '0' }), 300);
  assert.equal(timerStructToSeconds({ days: '0', hours: '2', minutes: '0', seconds: '0' }), 7200);
  assert.equal(timerStructToSeconds({ days: '1', hours: '0', minutes: '0', seconds: '0' }), 86400);
  // Partial structs: absent keys count as zero, matching the read-path helper.
  assert.equal(timerStructToSeconds({ minutes: '5' }), 300);
  assert.equal(timerStructToSeconds({}), 0);
});

test('timerStructToSeconds: scalar forms the write side produces', () => {
  // A patch value arrives as an integer, or as a numeric string off JSON.
  assert.equal(timerStructToSeconds(300), 300);
  assert.equal(timerStructToSeconds('300'), 300);
  assert.equal(timerStructToSeconds(0), 0);
});

test('timerStructToSeconds: unrecognizable input is null, not a silent zero', () => {
  assert.equal(timerStructToSeconds(null), null);
  assert.equal(timerStructToSeconds(undefined), null);
  assert.equal(timerStructToSeconds('abc'), null);
  assert.equal(timerStructToSeconds('12abc'), null);
  assert.equal(timerStructToSeconds(NaN), null);
  assert.equal(timerStructToSeconds(true), null);
});

test('REGRESSION action 283332: a correct timer write verifies clean', () => {
  // Exactly the shape Five9 returned on 2026-08-06.
  const after = { raw: { CRMRedialTimeout: { days: '0', hours: '0', minutes: '5', seconds: '0' } } };
  const mismatches = verifyPatchReadBack({ CRMRedialTimeout: 300 }, after);
  assert.deepEqual(mismatches, [], 'a landed 300s write must not report drift');
  assert.equal(mismatches.length === 0, true, 'verified must be true');
});

test('timer read-back: a genuinely wrong timer is still caught', () => {
  // The fix must not blanket-pass timers. 2h read back against a 300s patch
  // is real drift and has to surface.
  const after = { raw: { CRMRedialTimeout: { days: '0', hours: '2', minutes: '0', seconds: '0' } } };
  const mismatches = verifyPatchReadBack({ CRMRedialTimeout: 300 }, after);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].field, 'CRMRedialTimeout');
  assert.equal(mismatches[0].expected, 300);
  assert.equal(mismatches[0].actual, 7200);
  // The raw struct is carried so an operator can see what Five9 actually sent.
  assert.deepEqual(mismatches[0].actual_raw, { days: '0', hours: '2', minutes: '0', seconds: '0' });
});

test('timer read-back: an unnormalizable read-back is reported, not passed', () => {
  // Silently calling an unreadable read-back "verified" is the same defect in
  // a new shape, so it must surface rather than skip.
  const mismatches = verifyPatchReadBack({ CRMRedialTimeout: 300 }, { raw: { CRMRedialTimeout: 'garbage' } });
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].actual, null);
  assert.equal(mismatches[0].actual_raw, 'garbage');
});

test('maxQueueTime verifies off the already-normalized seconds field', () => {
  // maxQueueTime never hit the [object Object] bug — the reader surfaces
  // maxQueueTimeSeconds. Both directions must keep working.
  assert.deepEqual(verifyPatchReadBack({ maxQueueTime: 2 }, { maxQueueTimeSeconds: 2 }), []);
  const drift = verifyPatchReadBack({ maxQueueTime: 2 }, { maxQueueTimeSeconds: 30 });
  assert.equal(drift.length, 1);
  assert.equal(drift[0].actual, 30);
});

test('maxPreviewTime is not surfaced by the reader, so it stays unverified', () => {
  // Documents current reality: absent from the normalized read means skipped,
  // NOT silently passed on a value we never looked at.
  assert.deepEqual(verifyPatchReadBack({ maxPreviewTime: 10 }, { raw: {} }), []);
});

test('non-timer fields keep exact string comparison', () => {
  assert.deepEqual(verifyPatchReadBack({ dialingRatio: 10 }, { dialingRatio: 10 }), []);
  const drift = verifyPatchReadBack({ dialingRatio: 10 }, { dialingRatio: 12 });
  assert.deepEqual(drift, [{ field: 'dialingRatio', expected: 10, actual: 12 }]);
  // A field absent from the read-back is skipped, not reported as drift.
  assert.deepEqual(verifyPatchReadBack({ dialingRatio: 10 }, { raw: {} }), []);
});

test('mixed patch: timer and non-timer fields verify independently', () => {
  const after = {
    raw: { CRMRedialTimeout: { days: '0', hours: '0', minutes: '5', seconds: '0' } },
    dialingRatio: 12,
  };
  const mismatches = verifyPatchReadBack({ CRMRedialTimeout: 300, dialingRatio: 10 }, after);
  assert.equal(mismatches.length, 1, 'only the genuinely drifted field should surface');
  assert.equal(mismatches[0].field, 'dialingRatio');
});
