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
