/**
 * Retro-validation of the hand-written Five9 SOAP field orders against the
 * generated WSDL artifact. No network, no DB. Run:
 *   node --test scripts/test-five9-wsdl-schema.js
 *
 * Every *_FIELD_ORDER in src/five9/admin-writes.js is a hand transcription of
 * an xs:sequence. JAXB rejects out-of-order elements, so a transcription slip
 * ships as a Five9 500 rather than a local failure. These tests diff each array
 * against src/five9/wsdl-schema.json, which scripts/five9-extract-wsdl-schema.js
 * generates straight from the live schema.
 *
 * IF ONE OF THESE FAILS, DO NOT EDIT THE JSON TO MATCH THE CODE. The WSDL is
 * authoritative: a mismatch means a latent bug in a shipped operation. Report
 * the operation and stop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  OUTBOUND_CAMPAIGN_FIELD_ORDER,
  INBOUND_CAMPAIGN_FIELD_ORDER,
  LIST_DELETE_SETTINGS_FIELD_ORDER,
  ASYNC_DELETE_FIELD_ORDER,
  ASYNC_ADD_FIELD_ORDER,
  IVR_SCRIPT_DEF_FIELD_ORDER,
  CAMPAIGN_CALL_WRAPUP_FIELD_ORDER,
  IVR_SCRIPT_SCHEDULE_FIELD_ORDER,
  USER_SKILL_FIELD_ORDER,
  CAMPAIGN_PROFILE_FIELD_ORDER,
} from '../src/five9/admin-writes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(resolve(HERE, '../src/five9/wsdl-schema.json'), 'utf8')
);

/**
 * Flatten a complexType's inheritance chain, base fields first.
 *
 * This is the whole reason the artifact records `extends`. The shipped arrays
 * are inheritance-FLATTENED — OUTBOUND_CAMPAIGN_FIELD_ORDER concatenates
 * campaign -> generalCampaign -> baseOutboundCampaign -> outboundCampaign —
 * because base-first is the order JAXB unmarshals in. Comparing against a
 * single type's own fields would fail on every derived type.
 */
function flatten(typeName, seen = new Set()) {
  const t = schema.complexTypes[typeName];
  assert.ok(t, `complexType ${typeName} missing from wsdl-schema.json`);
  assert.ok(!seen.has(typeName), `inheritance cycle at ${typeName}`);
  seen.add(typeName);
  const inherited = t.extends ? flatten(t.extends, seen) : [];
  return inherited.concat(t.fields.map((f) => f.name));
}

const opFields = (op) => {
  const o = schema.operations[op];
  assert.ok(o, `operation ${op} missing from wsdl-schema.json`);
  return o.fields;
};

/* -- the artifact itself -------------------------------------------------- */

test('artifact is populated and self-describing', () => {
  assert.equal(schema.wsdlVersion, '13.0.00/13');
  assert.match(schema.wsdlSha256, /^[0-9a-f]{64}$/);
  assert.ok(schema.complexTypeCount >= 400, 'too few complexTypes');
  assert.ok(schema.operationCount >= 150, 'too few operations');
  assert.equal(Object.keys(schema.complexTypes).length, schema.complexTypeCount);
  assert.equal(Object.keys(schema.operations).length, schema.operationCount);
});

test('artifact carries the types the write surface builds', () => {
  for (const t of [
    'campaignProfileInfo', 'userSkill', 'inboundCampaign', 'outboundCampaign',
    'listDeleteSettings', 'vccConfiguration', 'campaignCallWrapup', 'ivrScriptDef',
  ]) {
    assert.ok(schema.complexTypes[t], `missing complexType ${t}`);
  }
});

/* -- field-order retro-validation ---------------------------------------- */

const COMPLEX_TYPE_CASES = [
  ['OUTBOUND_CAMPAIGN_FIELD_ORDER', OUTBOUND_CAMPAIGN_FIELD_ORDER, 'outboundCampaign'],
  ['INBOUND_CAMPAIGN_FIELD_ORDER', INBOUND_CAMPAIGN_FIELD_ORDER, 'inboundCampaign'],
  ['LIST_DELETE_SETTINGS_FIELD_ORDER', LIST_DELETE_SETTINGS_FIELD_ORDER, 'listDeleteSettings'],
  ['IVR_SCRIPT_DEF_FIELD_ORDER', IVR_SCRIPT_DEF_FIELD_ORDER, 'ivrScriptDef'],
  ['CAMPAIGN_CALL_WRAPUP_FIELD_ORDER', CAMPAIGN_CALL_WRAPUP_FIELD_ORDER, 'campaignCallWrapup'],
  ['IVR_SCRIPT_SCHEDULE_FIELD_ORDER', IVR_SCRIPT_SCHEDULE_FIELD_ORDER, 'ivrScriptSchedule'],
  ['USER_SKILL_FIELD_ORDER', USER_SKILL_FIELD_ORDER, 'userSkill'],
  ['CAMPAIGN_PROFILE_FIELD_ORDER', CAMPAIGN_PROFILE_FIELD_ORDER, 'campaignProfileInfo'],
];

for (const [label, order, typeName] of COMPLEX_TYPE_CASES) {
  test(`${label} matches WSDL xs:sequence for tns:${typeName}`, () => {
    assert.deepEqual(order, flatten(typeName));
  });
}

// These two are request-wrapper sequences, not complexType field lists, so they
// compare against operations[...] rather than complexTypes[...].
const OPERATION_CASES = [
  ['ASYNC_DELETE_FIELD_ORDER', ASYNC_DELETE_FIELD_ORDER, 'asyncDeleteRecordsFromList'],
  ['ASYNC_ADD_FIELD_ORDER', ASYNC_ADD_FIELD_ORDER, 'asyncAddRecordsToList'],
];

for (const [label, order, op] of OPERATION_CASES) {
  test(`${label} matches WSDL request wrapper for ${op}`, () => {
    assert.deepEqual(order, opFields(op));
  });
}

/* -- the specific traps this artifact exists to pin ----------------------- */

test('campaignCallWrapup keeps Five9\'s own dispostionName misspelling', () => {
  // Five9 misspells "disposition" in their published schema. The builder must
  // emit the misspelling verbatim or the call faults. Anyone "correcting" this
  // to dispositionName breaks five9_create_inbound_campaign — this test is the
  // tripwire. See CAMPAIGN_CALL_WRAPUP_FIELD_ORDER in admin-writes.js.
  const fields = schema.complexTypes.campaignCallWrapup.fields.map((f) => f.name);
  assert.ok(fields.includes('dispostionName'), 'misspelling gone from the WSDL');
  assert.ok(!fields.includes('dispositionName'), 'WSDL fixed the spelling — builders must follow');
  assert.ok(CAMPAIGN_CALL_WRAPUP_FIELD_ORDER.includes('dispostionName'));
});

test('userSkill.level is schema-required (no minOccurs)', () => {
  // The Phase G regression (a55200d): <level> is the one element in userSkill
  // without minOccurs="0", so it is required on every userSkill* call —
  // including remove. Pinned so the artifact keeps proving it.
  const level = schema.complexTypes.userSkill.fields.find((f) => f.name === 'level');
  assert.ok(level, 'userSkill.level missing');
  assert.equal(level.minOccurs, 1);
});

test('inheritance metadata matches what the builders assume', () => {
  // admin-writes.js:420-424 depends on these: the anchored complexType regex
  // cannot match a type carrying abstract= or final=, which is how an empty
  // match once got mistaken for a truncated fetch.
  assert.equal(schema.complexTypes.baseOutboundCampaign.abstract, true);
  assert.equal(schema.complexTypes.outboundCampaign.final, 'extension restriction');
  assert.equal(schema.complexTypes.inboundCampaign.final, 'extension restriction');
  assert.equal(schema.complexTypes.outboundCampaign.extends, 'baseOutboundCampaign');
  assert.equal(schema.complexTypes.inboundCampaign.extends, 'generalCampaign');
  assert.equal(schema.complexTypes.listDeleteSettings.extends, 'basicImportSettings');
});

test('defaultIvrSchedule is minOccurs=0 yet runtime-required', () => {
  // Documented contradiction, kept visible on purpose: the schema permits
  // omitting it, Five9 refuses the create without it (action 316167,
  // 2026-08-14). minOccurs tells you what the schema allows, not what the
  // server accepts. See admin-writes.js:1706.
  const f = schema.complexTypes.inboundCampaign.fields.find(
    (x) => x.name === 'defaultIvrSchedule'
  );
  assert.ok(f, 'defaultIvrSchedule missing');
  assert.equal(f.minOccurs, 0);
});

/* -- operations the surface already ships -------------------------------- */

test('every shipped write op exists in the v13 schema', () => {
  // Guards against an operation being renamed or dropped by a Five9 version
  // bump. Names here are the SOAP operations behind the registered
  // five9_* action types.
  const shipped = [
    'startCampaign', 'stopCampaign', 'resetCampaign', 'modifyOutboundCampaign',
    'addRecordToList', 'deleteRecordFromList', 'asyncDeleteRecordsFromList',
    // addNumbersToDnc only. removeNumbersFromDnc still EXISTS in v13 and is
    // deliberately absent from this list: the action type behind it was
    // deleted on 2026-08-21, so it is no longer a shipped op and must not be
    // asserted as one. Re-adding it here would quietly re-legitimize it.
    'addNumbersToDnc',
    'userSkillAdd', 'userSkillModify', 'userSkillRemove',
    'createCampaignProfile', 'modifyCampaignProfile',
    'createIVRScript', 'modifyIVRScript', 'createInboundCampaign',
    'setDefaultIVRSchedule', 'addDNISToCampaign', 'removeDNISFromCampaign',
    'addPromptTTS',
  ];
  const missing = shipped.filter((op) => !schema.operations[op]);
  assert.deepEqual(missing, [], `operations absent from v13: ${missing.join(', ')}`);
});

test('getAgentAuditReport does not exist in v13', () => {
  // Recorded as a finding, not an aspiration. The Phase H handoff specified a
  // five9_get_agent_audit_report read tool wrapping getAgentAuditReport /
  // getAgentAuditReportCsv; neither is in the v13 schema, and the string
  // "audit" appears nowhere in the 961 KB document. Those names came from a
  // v9.5-era reference. Consequence: the Admin API offers NO audit-trail
  // operation, so a change made by a human in the Five9 UI leaves no
  // API-visible trace — which is exactly why the reportsServer edit has no
  // record on our side. If a future Five9 version adds one, this test fails
  // and that is the signal to build the tool.
  assert.equal(schema.operations.getAgentAuditReport, undefined);
  assert.equal(schema.operations.getAgentAuditReportCsv, undefined);
});

test('resetListPosition is singular in v13', () => {
  // The v1 handoff named resetListPositions (plural), which does not exist.
  assert.ok(schema.operations.resetListPosition);
  assert.equal(schema.operations.resetListPositions, undefined);
});
