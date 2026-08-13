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
  // 2026-08-12 Phase F — bulk async list deletion
  buildAsyncDeleteRecordsFromListXml,
  buildAsyncAddRecordsToListXml,
  checkListDeleteCompliance,
  assertDeclaredRecordCount,
  decideImportPollReschedule,
  verifyListDeleteCounts,
  executeAsyncDeleteRecordsFromList,
  MAX_LIST_DELETE_LIMIT,
  MAX_LIST_DELETE_PROPORTION,
  ASYNC_DELETE_FIELD_ORDER,
  LIST_DELETE_SETTINGS_FIELD_ORDER,
  // 2026-08-13 Phase G — config surface (IVR / inbound campaign / DNIS / TTS)
  buildIvrScriptNameXml,
  buildIvrScriptDefXml,
  buildCallWrapupXml,
  buildInboundCampaignXml,
  buildCampaignDnisXml,
  buildSetDefaultIvrScheduleXml,
  buildPromptTtsXml,
  assertWellFormedXml,
  checkDnisSteal,
  exactNamePattern,
  IVR_SCRIPT_DEF_FIELD_ORDER,
  CAMPAIGN_CALL_WRAPUP_FIELD_ORDER,
  INBOUND_CAMPAIGN_FIELD_ORDER,
  INBOUND_CAMPAIGN_SETTABLE_FIELDS,
  WRAPUP_DEFAULT_DISPOSITION,
} from '../src/five9/admin-writes.js';
import { buildImportIdentifierXml } from '../src/five9-admin.js';

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

test('maxPreviewTime verifies through raw — it was wrongly hardcoded as skipped', () => {
  // The old code hardcoded maxPreviewTime to undefined, annotated "not
  // surfaced in normalized read". raw.maxPreviewTime is present on every
  // outbound campaign, so that skip reported verified:true for a field nothing
  // had looked at — the same lie as a permanent verified:false, just quieter.
  const after = { raw: { maxPreviewTime: { days: '0', hours: '0', minutes: '0', seconds: '20' } } };
  assert.deepEqual(verifyPatchReadBack({ maxPreviewTime: 20 }, after), [], 'a matching 20s preview must verify clean');
  const drift = verifyPatchReadBack({ maxPreviewTime: 20 }, { raw: { maxPreviewTime: { minutes: '2', seconds: '0' } } });
  assert.equal(drift.length, 1, 'a genuine preview-time drift must surface');
  assert.equal(drift[0].field, 'maxPreviewTime');
  assert.equal(drift[0].expected, 20);
  assert.equal(drift[0].actual, 120);
  // Genuinely absent from the read-back is still skipped, not falsely passed.
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

/* ------------------------------------------------------------------------ *
 * Phase F (2026-08-12) — BULK async list deletion.
 *
 * Someone bulk-loaded ~3,850 records into `Sale - Completed 0-2yrs` on
 * 2026-08-07/08, a large subset of them Fort Myers previous customers that
 * had no business in an east-coast previous-customer motion. Purging them one
 * approval-gated action at a time was the only option before this op.
 *
 * These tests pin the two things most likely to be "corrected" back into
 * bugs: the importData/values/item payload shape (which differs from the SYNC
 * delete op's record/fields, and from list-dispatch's unrelated <values>),
 * and the guardrails that stand between a cohort query and an emptied list.
 * ------------------------------------------------------------------------ */

test('buildAsyncDeleteRecordsFromListXml: WSDL xs:sequence order, base before extension', () => {
  const xml = buildAsyncDeleteRecordsFromListXml(
    'Sale - Completed 0-2yrs', ['number1'], [['5551234567'], ['5559876543']],
  );
  assert.match(xml, /^<listName>Sale - Completed 0-2yrs<\/listName>/);
  const order = ['<listName>', '<listDeleteSettings>', '<fieldsMapping>', '<skipHeaderLine>', '<listDeleteMode>', '</listDeleteSettings>', '<importData>'];
  const idx = order.map(t => xml.indexOf(t));
  assert.ok(idx.every(i => i >= 0), `all elements present: ${xml}`);
  for (let i = 1; i < idx.length; i++) {
    assert.ok(idx[i] > idx[i - 1], `${order[i]} must follow ${order[i - 1]} (WSDL sequence): ${xml}`);
  }
  // The order arrays record the schema, including fields we never emit.
  assert.deepEqual(ASYNC_DELETE_FIELD_ORDER, ['listName', 'listDeleteSettings', 'importData']);
  // skipHeaderLine is the last BASE field; listDeleteMode is the extension.
  assert.equal(LIST_DELETE_SETTINGS_FIELD_ORDER.at(-1), 'listDeleteMode');
  assert.equal(LIST_DELETE_SETTINGS_FIELD_ORDER.at(-2), 'skipHeaderLine');
  assert.ok(LIST_DELETE_SETTINGS_FIELD_ORDER.indexOf('fieldsMapping') < LIST_DELETE_SETTINGS_FIELD_ORDER.indexOf('skipHeaderLine'));
});

test('buildAsyncDeleteRecordsFromListXml: payload is importData/values/item — NOT record/fields', () => {
  const xml = buildAsyncDeleteRecordsFromListXml('L', ['number1'], [['555'], ['666']]);
  // One <values> per record, one <item> per column.
  assert.match(xml, /<importData><values><item>555<\/item><\/values><values><item>666<\/item><\/values><\/importData>$/);
  // REGRESSION GUARD: the async op must never emit the SYNC op's shape. The
  // Phase F handoff asserted "<fields>, not <values>" — true for tns:recordData
  // (the sync deleteRecordFromList), false here: asyncDeleteRecordsFromList
  // takes tns:importData, whose children are <values> of ns1:stringArray.
  assert.doesNotMatch(xml, /<record>/);
  assert.doesNotMatch(xml, /<fields>/);
  // ...and the sync builder must still emit the sync shape, unchanged.
  const sync = buildDeleteRecordFromListXml('L', ['number1'], ['555']);
  assert.match(sync, /<record><fields>555<\/fields><\/record>$/);
  assert.doesNotMatch(sync, /<importData>/);
});

test('buildAsyncDeleteRecordsFromListXml: key=true only on number1, columns numbered from 1', () => {
  const xml = buildAsyncDeleteRecordsFromListXml('L', ['number1', 'notes', 'number2'], [['5551234567', 'x', '5559999999']]);
  assert.match(xml, /<fieldsMapping><columnNumber>1<\/columnNumber><fieldName>number1<\/fieldName><key>true<\/key><\/fieldsMapping>/);
  assert.match(xml, /<fieldsMapping><columnNumber>2<\/columnNumber><fieldName>notes<\/fieldName><key>false<\/key><\/fieldsMapping>/);
  // number2 is a phone column but NOT the dial key — same convention as the
  // sync builders and list-dispatch.
  assert.match(xml, /<fieldsMapping><columnNumber>3<\/columnNumber><fieldName>number2<\/fieldName><key>false<\/key><\/fieldsMapping>/);
  assert.equal((xml.match(/<key>true<\/key>/g) || []).length, 1);
});

test('buildAsyncDeleteRecordsFromListXml: nulls become empty items, values are escaped', () => {
  const xml = buildAsyncDeleteRecordsFromListXml('L', ['number1', 'notes'], [['555', null], ['666', undefined]]);
  assert.match(xml, /<values><item>555<\/item><item><\/item><\/values>/);
  assert.match(xml, /<values><item>666<\/item><item><\/item><\/values>/);
  const esc = buildAsyncDeleteRecordsFromListXml('L & Co', ['number1'], [['<script>&']]);
  assert.match(esc, /<listName>L &amp; Co<\/listName>/);
  assert.match(esc, /<item>&lt;script&gt;&amp;<\/item>/);
});

test('buildAsyncDeleteRecordsFromListXml: mode enum enforced, shape mismatches throw', () => {
  assert.match(
    buildAsyncDeleteRecordsFromListXml('L', ['number1'], [['5']], 'DELETE_EXCEPT_FIRST'),
    /<listDeleteMode>DELETE_EXCEPT_FIRST<\/listDeleteMode>/,
  );
  assert.doesNotThrow(() => buildAsyncDeleteRecordsFromListXml('L', ['number1'], [['5']], 'DELETE_IF_SOLE_CRM_MATCH'));
  assert.throws(() => buildAsyncDeleteRecordsFromListXml('L', ['number1'], [['5']], 'NUKE_EVERYTHING'), /invalid list_delete_mode/);
  assert.throws(() => buildAsyncDeleteRecordsFromListXml('', ['number1'], [['5']]), /list_name is required/);
  assert.throws(() => buildAsyncDeleteRecordsFromListXml('L', ['number1'], []), /records is required/);
  assert.throws(() => buildAsyncDeleteRecordsFromListXml('L', [], [['5']]), /mismatch/);
  // A ragged row is caught with its index — a silently truncated record on a
  // bulk DELETE is exactly the unrecoverable case.
  assert.throws(() => buildAsyncDeleteRecordsFromListXml('L', ['a', 'b'], [['1', '2'], ['3']]), /mismatch at record 1/);
});

test('buildAsyncAddRecordsToListXml: rollback body carries listUpdateSettings + importData', () => {
  const xml = buildAsyncAddRecordsToListXml('L', ['number1'], [['555']]);
  const order = ['<listName>', '<listUpdateSettings>', '<fieldsMapping>', '<skipHeaderLine>', '<cleanListBeforeUpdate>', '<crmAddMode>', '<crmUpdateMode>', '<listAddMode>', '</listUpdateSettings>', '<importData>'];
  const idx = order.map(t => xml.indexOf(t));
  assert.ok(idx.every(i => i >= 0), `all elements present: ${xml}`);
  for (let i = 1; i < idx.length; i++) {
    assert.ok(idx[i] > idx[i - 1], `${order[i]} must follow ${order[i - 1]}: ${xml}`);
  }
  assert.match(xml, /<importData><values><item>555<\/item><\/values><\/importData>$/);
  assert.doesNotMatch(xml, /<listDeleteMode>/);
});

test('buildImportIdentifierXml: importIdentifier is DOUBLE-nested, unlike the report ops', () => {
  // tns:isImportRunning takes identifier: tns:importIdentifier, and
  // importIdentifier's only child is itself named `identifier`. Flattening
  // this to a single <identifier> is an unmarshalling fault.
  assert.equal(buildImportIdentifierXml('abc123'), '<identifier><identifier>abc123</identifier></identifier>');
  assert.equal(
    buildImportIdentifierXml('abc123', { waitTimeSec: 5 }),
    '<identifier><identifier>abc123</identifier></identifier><waitTime>5</waitTime>',
  );
  assert.equal(buildImportIdentifierXml('a', { waitTimeSec: -3 }), '<identifier><identifier>a</identifier></identifier><waitTime>0</waitTime>');
  assert.throws(() => buildImportIdentifierXml(''), /identifier is required/);
});

test('requiredConfirmToken: bulk deletion is confirm_token-gated on the list name', () => {
  assert.equal(
    requiredConfirmToken('async_delete_records_from_list', { list_name: 'Sale - Completed 0-2yrs' }),
    'Sale - Completed 0-2yrs',
  );
  // The single-record sync delete is deliberately NOT gated — one record is
  // not a blast radius. Bulk is.
  assert.equal(requiredConfirmToken('delete_record_from_list', { list_name: 'X' }), null);
  assert.throws(
    () => checkConfirmToken('async_delete_records_from_list', { list_name: 'A', confirm_token: 'B' }),
    /confirm_token mismatch/,
  );
  assert.doesNotThrow(
    () => checkConfirmToken('async_delete_records_from_list', { list_name: 'A', confirm_token: 'A' }),
  );
});

test('assertDeclaredRecordCount: missing or mismatched declared count refuses', () => {
  assert.equal(assertDeclaredRecordCount(2, 2), 2);
  assert.throws(() => assertDeclaredRecordCount(undefined, 2), /requires action_payload\.expected_record_count/);
  assert.throws(() => assertDeclaredRecordCount(null, 2), /requires action_payload\.expected_record_count/);
  assert.throws(() => assertDeclaredRecordCount('', 2), /requires action_payload\.expected_record_count/);
  assert.throws(() => assertDeclaredRecordCount(3, 2), /expected_record_count 3 !== 2/);
  assert.throws(() => assertDeclaredRecordCount(1.5, 2), /non-negative integer/);
  assert.throws(() => assertDeclaredRecordCount(-1, 2), /non-negative integer/);
  assert.throws(() => assertDeclaredRecordCount('abc', 2), /non-negative integer/);
  // A string that IS the right integer is accepted — payloads arrive as JSON.
  assert.equal(assertDeclaredRecordCount('2', 2), 2);
});

test('checkListDeleteCompliance: absolute ceiling refuses without override, passes with it', () => {
  assert.equal(MAX_LIST_DELETE_LIMIT, 2000, 'FIVE9_MAX_LIST_DELETE default');
  const big = { requested: 2500, listSize: 100000 };
  const refused = checkListDeleteCompliance(big);
  assert.equal(refused.ok, false);
  assert.match(refused.violations.join(';'), /2500 records > 2000 per-action ceiling/);
  const overridden = checkListDeleteCompliance(big, { complianceOverride: true });
  assert.equal(overridden.ok, true);
  assert.equal(overridden.overridden, true, 'override must be recorded on the audit event');
  // Injectable limit — MAX_LIST_DELETE_LIMIT is frozen at module load, so the
  // env var cannot be moved after import (same as MAX_PROFILE_ATTEMPTS_LIMIT).
  assert.equal(checkListDeleteCompliance({ requested: 50, listSize: 100000 }, { limit: 10 }).ok, false);
  assert.equal(checkListDeleteCompliance({ requested: 50, listSize: 100000 }, { limit: 100 }).ok, true);
});

test('checkListDeleteCompliance: proportion guard catches the cohort query that nukes the list', () => {
  assert.equal(MAX_LIST_DELETE_PROPORTION, 0.5);
  // 1,500 of 40,000 is unremarkable; 1,500 of 2,000 is the list.
  assert.equal(checkListDeleteCompliance({ requested: 1500, listSize: 40000 }).ok, true);
  const nuke = checkListDeleteCompliance({ requested: 1500, listSize: 2000 });
  assert.equal(nuke.ok, false);
  assert.match(nuke.violations.join(';'), /1500 of 2000 records = 75\.0% > 50% of the list/);
  assert.equal(checkListDeleteCompliance({ requested: 1500, listSize: 2000 }, { complianceOverride: true }).ok, true);
  // Exactly 50% passes; one over does not.
  assert.equal(checkListDeleteCompliance({ requested: 1000, listSize: 2000 }).ok, true);
  assert.equal(checkListDeleteCompliance({ requested: 1001, listSize: 2000 }).ok, false);
  // Against the live 2026-08-12 list (3,879) the proportion line bites at
  // 1,940 — BEFORE the 2,000 absolute ceiling. Both guards are load-bearing.
  assert.equal(checkListDeleteCompliance({ requested: 1950, listSize: 3879 }).ok, false);
});

test('checkListDeleteCompliance: an unknown list size is a refusal, not a pass', () => {
  // getListsInfo not finding the list yields size null. Skipping the
  // proportion check there would be the same lie as a permanent false
  // negative — it refuses instead.
  for (const listSize of [null, undefined, 0, 'abc']) {
    const r = checkListDeleteCompliance({ requested: 10, listSize });
    assert.equal(r.ok, false, `size ${JSON.stringify(listSize)} must refuse`);
    assert.match(r.violations.join(';'), /list size unknown|proportion guard cannot be evaluated/);
  }
});

test('decideImportPollReschedule: backs off, then stops deferring forever', () => {
  const now = Date.parse('2026-08-12T12:00:00Z');
  const first = decideImportPollReschedule(0, now);
  assert.equal(first.reschedule, true);
  assert.equal(first.attempt, 1, 'attempt counter advances so the ceiling is reachable');
  assert.equal(first.reason, 'five9_import_running');
  assert.equal(first.retryAt, new Date(now + 15_000).toISOString());
  // Monotonic backoff, clamped.
  const delays = [0, 1, 2, 3, 4, 10].map(a => decideImportPollReschedule(a, now).delayMs);
  for (let i = 1; i < delays.length; i++) assert.ok(delays[i] >= delays[i - 1], `backoff must not shrink: ${delays}`);
  assert.ok(delays.every(d => d <= 120_000), `clamped to maxMs: ${delays}`);
  // A wedged job eventually stops deferring instead of parking forever.
  const done = decideImportPollReschedule(40, now);
  assert.equal(done.reschedule, false);
  assert.equal(done.reason, 'five9_import_poll_attempts_exhausted');
  assert.equal(decideImportPollReschedule(3, now, { maxAttempts: 3 }).reschedule, false);
});

test('verifyListDeleteCounts: agreement verifies, disagreement REPORTS and never throws', () => {
  // All three agree — verified.
  assert.deepEqual(verifyListDeleteCounts({ declared: 2, deletedReported: 2, sizeDelta: 2 }), []);
  // Five9 deleted fewer than asked: reported, with both numbers, not thrown.
  const short = verifyListDeleteCounts({ declared: 500, deletedReported: 480, sizeDelta: 480 });
  assert.equal(short.length, 2);
  assert.deepEqual(short[0], { field: 'listRecordsDeleted', expected: 500, actual: 480 });
  assert.deepEqual(short[1], { field: 'size_delta', expected: 500, actual: 480 });
  // The delete count is right but the list moved by less — the incremental
  // feed landed mid-job. Reported on size_delta alone, so the operator can
  // see WHICH signal disagreed rather than a bare verified:false.
  const feed = verifyListDeleteCounts({ declared: 2, deletedReported: 2, sizeDelta: 1 });
  assert.deepEqual(feed, [{ field: 'size_delta', expected: 2, actual: 1 }]);
});

test('verifyListDeleteCounts: an unreadable count is a mismatch, never a silent pass', () => {
  // The quiet-lie case: if listRecordsDeleted or the size delta cannot be
  // read, "no mismatch found" would report verified:true for something
  // nothing looked at. Both null cases must surface.
  assert.deepEqual(
    verifyListDeleteCounts({ declared: 2, deletedReported: null, sizeDelta: 2 }),
    [{ field: 'listRecordsDeleted', expected: 2, actual: null }],
  );
  assert.deepEqual(
    verifyListDeleteCounts({ declared: 2, deletedReported: 2, sizeDelta: null }),
    [{ field: 'size_delta', expected: 2, actual: null }],
  );
  assert.equal(verifyListDeleteCounts({ declared: 2 }).length, 2, 'both unreadable → both reported');
  // Numeric strings off the SOAP parse still compare by value.
  assert.deepEqual(verifyListDeleteCounts({ declared: 2, deletedReported: '2', sizeDelta: '2' }), []);
});

test('executeAsyncDeleteRecordsFromList: payload errors fire BEFORE any read or lock', async () => {
  // Every rejection below happens before withFive9WriteGate is entered, so
  // they need no creds, no DB and no network — which is exactly the point:
  // a malformed bulk-delete payload must never reach the write path, and
  // must never acquire the fleet-wide lock on its way to failing.
  const base = {
    id: 1,
    action_type: 'five9_async_delete_records_from_list',
    requires_approval: true,
  };
  const ok = {
    list_name: 'L',
    field_names: ['number1'],
    records: [['555'], ['666']],
    confirm_token: 'L',
    expected_record_count: 2,
  };
  await assert.rejects(
    executeAsyncDeleteRecordsFromList({ ...base, action_payload: { ...ok, list_name: '' } }),
    /requires action_payload\.list_name/,
  );
  // Builder validation precedes the token check.
  await assert.rejects(
    executeAsyncDeleteRecordsFromList({ ...base, action_payload: { ...ok, list_delete_mode: 'NUKE' } }),
    /invalid list_delete_mode/,
  );
  await assert.rejects(
    executeAsyncDeleteRecordsFromList({ ...base, action_payload: { ...ok, records: [['555'], ['666', 'x']] } }),
    /mismatch at record 1/,
  );
  // confirm_token must restate the list name verbatim.
  await assert.rejects(
    executeAsyncDeleteRecordsFromList({ ...base, action_payload: { ...ok, confirm_token: 'l' } }),
    /confirm_token mismatch/,
  );
  await assert.rejects(
    executeAsyncDeleteRecordsFromList({ ...base, action_payload: { ...ok, confirm_token: undefined } }),
    /confirm_token mismatch/,
  );
  // ...and the declared count must reconcile with what was serialized.
  await assert.rejects(
    executeAsyncDeleteRecordsFromList({ ...base, action_payload: { ...ok, expected_record_count: undefined } }),
    /requires action_payload\.expected_record_count/,
  );
  await assert.rejects(
    executeAsyncDeleteRecordsFromList({ ...base, action_payload: { ...ok, expected_record_count: 3 } }),
    /expected_record_count 3 !== 2/,
  );
});

test('executeAsyncDeleteRecordsFromList: a well-formed payload reaches the read gate, not a mutation', async () => {
  // With the flag off and no creds, a VALID payload gets past every pure
  // guardrail and dies on the read-before-write (getListsInfo) — proving the
  // guardrails passed it through rather than short-circuiting, and that the
  // dry-run path still cannot mutate. Same shape as the Phase C ships-dark
  // test above.
  const saved = { flag: process.env.FIVE9_WRITES_ENABLED, u: process.env.FIVE9_USERNAME, p: process.env.FIVE9_PASSWORD };
  try {
    delete process.env.FIVE9_WRITES_ENABLED;
    delete process.env.FIVE9_USERNAME;
    delete process.env.FIVE9_PASSWORD;
    await assert.rejects(
      executeAsyncDeleteRecordsFromList({
        id: 1,
        action_type: 'five9_async_delete_records_from_list',
        requires_approval: true,
        action_payload: {
          list_name: 'Sale - Completed 0-2yrs',
          field_names: ['number1'],
          records: [['5551234567'], ['5559876543']],
          confirm_token: 'Sale - Completed 0-2yrs',
          expected_record_count: 2,
        },
      }),
      /credentials not configured/,
    );
  } finally {
    for (const [k, env] of [['flag', 'FIVE9_WRITES_ENABLED'], ['u', 'FIVE9_USERNAME'], ['p', 'FIVE9_PASSWORD']]) {
      if (saved[k] === undefined) delete process.env[env];
      else process.env[env] = saved[k];
    }
  }
});

/* ---------------------------------------------------------------------- *
 * Phase G (2026-08-13) — config surface: IVR scripts, inbound campaigns,
 * the default IVR schedule, DNIS assignment, TTS prompts.
 *
 * Field order is WSDL-derived; verbatim schema in
 * docs/five9/phase-g-wsdl-v13.md. The tests that matter most here are the
 * ones pinning things that look wrong and are not.
 * ---------------------------------------------------------------------- */

test('THE TYPO IS FIVE9\'S: campaignCallWrapup emits dispostionName, not dispositionName', () => {
  // Occurs exactly once in the 961KB schema; the correct spelling occurs 9
  // times on OTHER types, which is what makes this look like our mistake.
  // Emitting the correct spelling raises no error and silently sets no
  // wrapup disposition — so this test exists to stop a well-meaning fix.
  assert.equal(CAMPAIGN_CALL_WRAPUP_FIELD_ORDER[1], 'dispostionName');
  assert.ok(!CAMPAIGN_CALL_WRAPUP_FIELD_ORDER.includes('dispositionName'),
    'the correctly-spelled field is NOT in the WSDL sequence');

  const xml = buildCallWrapupXml({
    agentNotReady: true, dispostionName: 'No Disposition', enabled: true, timeout: 180,
  });
  assert.match(xml, /<dispostionName>No Disposition<\/dispostionName>/);
  assert.ok(!/<dispositionName>/.test(xml), 'must never emit the correct spelling');
  // timeout is tns:timer, not a scalar — all four parts, always.
  assert.match(xml, /<timeout><days>0<\/days><hours>0<\/hours><minutes>3<\/minutes><seconds>0<\/seconds><\/timeout>/);
  assert.equal(xml, '<callWrapup><agentNotReady>true</agentNotReady><dispostionName>No Disposition</dispostionName><enabled>true</enabled><timeout><days>0</days><hours>0</hours><minutes>3</minutes><seconds>0</seconds></timeout></callWrapup>');
});

test('buildIvrScriptDefXml: xs:sequence puts description BEFORE name', () => {
  // Alphabetical, like every sequence in this schema. Assuming name leads is
  // the natural mistake and produces an unmarshalling fault.
  assert.deepEqual(IVR_SCRIPT_DEF_FIELD_ORDER, ['description', 'name', 'xmlDefinition']);
  const xml = buildIvrScriptDefXml('Canvass Confirmation Routing', {
    description: 'Inbound canvass line',
    xmlDefinition: '<ivr><play/></ivr>',
  });
  assert.equal(xml,
    '<scriptDef><description>Inbound canvass line</description><name>Canvass Confirmation Routing</name>' +
    '<xmlDefinition>&lt;ivr&gt;&lt;play/&gt;&lt;/ivr&gt;</xmlDefinition></scriptDef>');
  // The definition must be escaped, never passed through raw.
  assert.ok(!xml.includes('<ivr>'), 'xmlDefinition must be entity-escaped');

  // description is optional; omitting it must not shift the others.
  const bare = buildIvrScriptDefXml('X', { xmlDefinition: '<a/>' });
  assert.equal(bare, '<scriptDef><name>X</name><xmlDefinition>&lt;a/&gt;</xmlDefinition></scriptDef>');
  assert.throws(() => buildIvrScriptDefXml('  '), /script name is required/);
  assert.equal(buildIvrScriptNameXml('Canvass'), '<name>Canvass</name>');
  assert.throws(() => buildIvrScriptNameXml(''), /script name is required/);
});

test('buildInboundCampaignXml: 16-field flattened sequence, base types first', () => {
  // campaign -> generalCampaign -> inboundCampaign. JAXB unmarshals base
  // fields before extension fields; out of order is a fault.
  assert.equal(INBOUND_CAMPAIGN_FIELD_ORDER.length, 16);
  assert.deepEqual(INBOUND_CAMPAIGN_FIELD_ORDER.slice(0, 7),
    ['description', 'mode', 'name', 'profileName', 'state', 'trainingMode', 'type']);
  assert.deepEqual(INBOUND_CAMPAIGN_FIELD_ORDER.slice(-2), ['defaultIvrSchedule', 'maxNumOfLines']);
  // The line-count field is maxNumOfLines, NOT maxLines.
  assert.ok(INBOUND_CAMPAIGN_FIELD_ORDER.includes('maxNumOfLines'));
  assert.ok(!INBOUND_CAMPAIGN_FIELD_ORDER.includes('maxLines'));

  // Keys deliberately supplied in the WRONG order — emission must follow the
  // WSDL sequence, not Object.keys.
  const xml = buildInboundCampaignXml({
    maxNumOfLines: 10, autoRecord: true, name: 'Canvass Confirmation - Inbound',
    type: 'INBOUND', mode: 'BASIC', trainingMode: false, useFtp: false,
    callWrapup: { agentNotReady: true, dispostionName: 'No Disposition', enabled: true, timeout: 180 },
  });
  const order = ['<mode>', '<name>', '<trainingMode>', '<type>', '<autoRecord>', '<callWrapup>', '<useFtp>', '<maxNumOfLines>'];
  const idx = order.map(t => xml.indexOf(t));
  assert.ok(idx.every(i => i >= 0), `all fields present: ${xml}`);
  for (let i = 1; i < idx.length; i++) {
    assert.ok(idx[i] > idx[i - 1], `${order[i]} must follow ${order[i - 1]} (WSDL sequence): ${xml}`);
  }
  assert.match(xml, /^<campaign>/);
  assert.match(xml, /<\/campaign>$/);
});

test('REGRESSION: inbound order-array membership does NOT grant settability', () => {
  // Same invariant as OUTBOUND_CAMPAIGN_FIELD_ORDER. The array is a faithful
  // copy of the WSDL; the Set is the permission list, and they differ on
  // purpose. FTP credentials and live state are in one and not the other.
  for (const field of ['ftpHost', 'ftpPassword', 'ftpUser', 'state', 'profileName', 'defaultIvrSchedule', 'recordingNameAsSid']) {
    assert.ok(INBOUND_CAMPAIGN_FIELD_ORDER.includes(field), `${field} should be in the order array`);
    assert.equal(INBOUND_CAMPAIGN_SETTABLE_FIELDS.has(field), false, `${field} must NOT be settable`);
    assert.throws(
      () => buildInboundCampaignXml({ name: 'X', [field]: 'v' }),
      new RegExp(`REFUSED: "${field}" is not a settable inbound campaign field`),
      `${field} must be refused at build time`,
    );
  }
});

test('every INBOUND_CAMPAIGN_SETTABLE_FIELD has a position in the order array', () => {
  // A settable field missing from the order array silently never emits — no
  // error, just a campaign created without it.
  const missing = [...INBOUND_CAMPAIGN_SETTABLE_FIELDS].filter(f => !INBOUND_CAMPAIGN_FIELD_ORDER.includes(f));
  assert.deepEqual(missing, [], `settable fields absent from the order array: ${missing.join(', ')}`);
});

test('buildCampaignDnisXml: DNISList is capitalised and repeats per number', () => {
  const xml = buildCampaignDnisXml('Canvass Confirmation - Inbound', ['9045551234', ' 9045559999 ']);
  assert.equal(xml,
    '<campaignName>Canvass Confirmation - Inbound</campaignName>' +
    '<DNISList>9045551234</DNISList><DNISList>9045559999</DNISList>');
  assert.ok(!/<dnisList>|<dnis>/.test(xml), 'the element is DNISList, not dnis/dnisList');
  assert.throws(() => buildCampaignDnisXml('X', []), /dnis\[\] is required/);
  assert.throws(() => buildCampaignDnisXml('X', ['  ']), /dnis\[\] is required/);
  assert.throws(() => buildCampaignDnisXml('', ['9045551234']), /campaign_name is required/);
});

test('buildSetDefaultIvrScheduleXml + buildPromptTtsXml: sequence order', () => {
  assert.equal(
    buildSetDefaultIvrScheduleXml('Canvass Confirmation - Inbound', 'Canvass Confirmation Routing'),
    '<campaignName>Canvass Confirmation - Inbound</campaignName><scriptName>Canvass Confirmation Routing</scriptName>',
  );
  assert.throws(() => buildSetDefaultIvrScheduleXml('', 'S'), /campaign_name is required/);
  assert.throws(() => buildSetDefaultIvrScheduleXml('C', ''), /script_name is required/);

  // promptInfo: description, languages[], name, type — then a sibling ttsInfo.
  const xml = buildPromptTtsXml({ name: 'Canvass Greeting', description: 'Inbound greeting', text: 'Thanks for calling.' });
  assert.equal(xml,
    '<prompt><description>Inbound greeting</description><languages>en-US</languages>' +
    '<name>Canvass Greeting</name><type>TTSGenerated</type></prompt>' +
    '<ttsInfo><language>en-US</language><text>Thanks for calling.</text></ttsInfo>');
  assert.throws(() => buildPromptTtsXml({ name: 'X', text: '   ' }), /prompt text is required/);
  assert.throws(() => buildPromptTtsXml({ name: '', text: 'hi' }), /prompt name is required/);
});

test('assertWellFormedXml: catches the ways a pasted script actually arrives broken', () => {
  assert.doesNotThrow(() => assertWellFormedXml('<ivr><menu key="1"/><play>hi</play></ivr>'));
  assert.doesNotThrow(() => assertWellFormedXml('<?xml version="1.0"?><!-- note --><ivr><![CDATA[<not a tag>]]></ivr>'));
  // A '>' inside an attribute value must not terminate the tag early.
  assert.doesNotThrow(() => assertWellFormedXml('<ivr><node cond="a > b"/></ivr>'));

  assert.throws(() => assertWellFormedXml(''), /is empty/);
  assert.throws(() => assertWellFormedXml('   '), /is empty/);
  assert.throws(() => assertWellFormedXml('<ivr><play></ivr>'), /<\/ivr> closes <play>/);
  assert.throws(() => assertWellFormedXml('<ivr><play>'), /unclosed <play>/);
  assert.throws(() => assertWellFormedXml('<ivr>'), /unclosed <ivr>/);
  assert.throws(() => assertWellFormedXml('</ivr>'), /closes nothing/);
  assert.throws(() => assertWellFormedXml('plain text'), /contains no XML elements/);
  // Truncation mid-tag — the realistic copy/paste failure.
  assert.throws(() => assertWellFormedXml('<ivr><play na'), /not well-formed XML/);
  assert.throws(() => assertWellFormedXml('<ivr>< broken></ivr>'), /not well-formed XML/);
  // The label appears in the message so the operator knows which field failed.
  assert.throws(() => assertWellFormedXml('<a>', 'xml_definition'), /REFUSED: xml_definition/);
});

test('checkDnisSteal: a number owned by another campaign is refused without override', () => {
  const assignments = {
    '9045551234': 'Main Number',
    '9045559999': 'Canvass Confirmation - Inbound',
  };

  // Clean: unassigned number onto the target campaign.
  const clean = checkDnisSteal(['9045550000'], assignments, 'Canvass Confirmation - Inbound');
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.conflicts, []);

  // Already on the TARGET campaign is a no-op re-add, not a steal.
  const sameCampaign = checkDnisSteal(['9045559999'], assignments, 'Canvass Confirmation - Inbound');
  assert.equal(sameCampaign.ok, true);
  assert.deepEqual(sameCampaign.conflicts, []);

  // Owned by a DIFFERENT campaign — this is the P1 case.
  const steal = checkDnisSteal(['9045551234'], assignments, 'Canvass Confirmation - Inbound');
  assert.equal(steal.ok, false);
  assert.deepEqual(steal.conflicts, [{ dnis: '9045551234', current_campaign: 'Main Number' }]);
  assert.match(steal.violations[0], /9045551234 currently routes to "Main Number"/);

  // Override is the ONLY way through, and it must be exactly true.
  assert.equal(checkDnisSteal(['9045551234'], assignments, 'C', { complianceOverride: true }).ok, true);
  assert.equal(checkDnisSteal(['9045551234'], assignments, 'C', { complianceOverride: true }).overridden, true);
  for (const truthy of ['true', 1, {}, 'yes']) {
    assert.equal(checkDnisSteal(['9045551234'], assignments, 'C', { complianceOverride: truthy }).ok, false,
      `compliance_override must be identity-true, not merely truthy (${JSON.stringify(truthy)})`);
  }
  // Campaign match is case-insensitive — Five9 names are not case-normalised.
  assert.equal(checkDnisSteal(['9045559999'], assignments, 'canvass confirmation - inbound').ok, true);
});

test('confirm_token: the two Phase G ops restate their target verbatim', () => {
  // modify_ivr_script — token is the script name.
  assert.equal(requiredConfirmToken('modify_ivr_script', { name: 'Canvass Confirmation Routing' }), 'Canvass Confirmation Routing');
  assert.doesNotThrow(() => checkConfirmToken('modify_ivr_script', { name: 'Canvass Confirmation Routing', confirm_token: 'Canvass Confirmation Routing' }));
  assert.throws(() => checkConfirmToken('modify_ivr_script', { name: 'Canvass Confirmation Routing' }), /confirm_token mismatch/);
  assert.throws(() => checkConfirmToken('modify_ivr_script', { name: 'Canvass Confirmation Routing', confirm_token: 'canvass confirmation routing' }), /confirm_token mismatch/);

  // remove_dnis_from_campaign — token is the campaign name, NOT the numbers.
  const payload = { campaign_name: 'Canvass Confirmation - Inbound', dnis: ['9045551234'] };
  assert.equal(requiredConfirmToken('remove_dnis_from_campaign', payload), 'Canvass Confirmation - Inbound');
  assert.doesNotThrow(() => checkConfirmToken('remove_dnis_from_campaign', { ...payload, confirm_token: 'Canvass Confirmation - Inbound' }));
  assert.throws(() => checkConfirmToken('remove_dnis_from_campaign', { ...payload, confirm_token: '9045551234' }), /confirm_token mismatch/);

  // The rest of Phase G is single-gated: creates are attached to nothing yet,
  // and add_dnis carries the steal guard instead.
  for (const op of ['create_ivr_script', 'create_inbound_campaign', 'set_default_ivr_schedule', 'add_dnis_to_campaign', 'create_prompt_tts']) {
    assert.equal(requiredConfirmToken(op, { name: 'X', campaign_name: 'X' }), null, `${op} must not be double-gated`);
    assert.doesNotThrow(() => checkConfirmToken(op, { name: 'X' }));
  }
});

test('exactNamePattern: anchors and escapes so a prefix cannot match a longer name', () => {
  assert.equal(exactNamePattern('Canvass'), '^Canvass$');
  assert.equal(exactNamePattern, exactUserPattern, 'aliased, not duplicated');
  // Regex metacharacters in a script name stay literal.
  assert.equal(exactNamePattern('Main (v2).ivr'), '^Main \\(v2\\)\\.ivr$');
  const re = new RegExp(exactNamePattern('Canvass'));
  assert.equal(re.test('Canvass'), true);
  assert.equal(re.test('Canvass Confirmation'), false, 'a prefix must not match a longer script name');
});
