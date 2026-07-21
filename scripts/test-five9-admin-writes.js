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

test('flag-off short-circuit: execute resolves skipped without lock/network/creds', async () => {
  const saved = process.env.FIVE9_WRITES_ENABLED;
  try {
    delete process.env.FIVE9_WRITES_ENABLED;
    const result = await executeStartCampaign({
      id: 1,
      action_type: 'five9_start_campaign',
      requires_approval: true,
      action_payload: { campaign_name: 'X' },
    });
    assert.equal(result.skipped, true);
    assert.match(result.reason, /five9_writes_disabled/);
  } finally {
    if (saved === undefined) delete process.env.FIVE9_WRITES_ENABLED;
    else process.env.FIVE9_WRITES_ENABLED = saved;
  }
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
