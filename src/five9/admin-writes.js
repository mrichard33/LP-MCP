/**
 * Five9 Admin WRITE operations — src/five9/admin-writes.js (Phase C)
 *
 * DOCTRINE (enforced, not aspirational):
 *   - NEVER called from MCP tools. The ONLY caller is the action executor
 *     (src/actions/handlers/five9.js) after a row went through
 *     create_agent_action(requires_approval:true) → approve_action.
 *   - Ships dark: FIVE9_WRITES_ENABLED master flag, default false — every
 *     execute function refuses (skipped) until Mark flips the Railway var.
 *   - INBOUND campaigns are immutable: start/stop/reset/modify refuse
 *     type=INBOUND. Main Number / Dispatch are never at risk from here.
 *   - Read-before-write + read-back: previous_state captured before the
 *     SOAP write, new_state re-read after, both carried on the
 *     five9.admin_write audit event emitted on EVERY execution — success
 *     or failure.
 *   - Serialized: one Five9 write in flight fleet-wide (outbound_locks row
 *     under the synthetic key "five9_admin:write"); concurrent Five9 admin
 *     session limits are undisclosed, so we don't probe them.
 *   - Compliance: maxQueueTime > 2s or abandon (maxDroppedCallsPercentage)
 *     > 3% refused unless the action payload carries compliance_override
 *     === true (FCC/FTC abandonment-rate lines).
 *   - DNC removals require a per-number reason string, logged verbatim to
 *     the audit event.
 *
 * SOAP bodies are built by pure exported builders (offline snapshot tests
 * in scripts/test-five9-admin-writes.js). Element order follows the WSDL
 * xs:sequence — JAXB unmarshals base-type fields BEFORE extension fields,
 * and an out-of-order element is an unmarshalling fault.
 *
 * Reuses five9SoapCall/escapeXml and the Phase B readers from
 * ../five9-admin.js (same endpoint, same credential path — extended, not
 * duplicated). NOTE: list record bodies here emit <fields> per the WSDL
 * recordData type; the older list-dispatch builder emits <values>, which
 * matches the report-row type instead — kept untouched there because that
 * module is wired to a live route, but new code follows the WSDL.
 */

import {
  five9SoapCall,
  escapeXml,
  getCampaigns,
  getCampaignState,
  getOutboundCampaign,
  getListsInfo,
  checkDncForNumbers,
} from '../five9-admin.js';
import { tryAcquireLock, releaseLock, decideLockHeldReschedule } from '../services/outbound-locks.js';
import { emitEvent } from '../event-emitter.js';

/* ---------------------------------------------------------------------- *
 * Guardrail 1 — master flag (ships dark).
 * ---------------------------------------------------------------------- */

export function five9WritesEnabled() {
  return (process.env.FIVE9_WRITES_ENABLED || 'false') === 'true';
}

/* ---------------------------------------------------------------------- *
 * Guardrail 2 — INBOUND campaigns are immutable.
 * ---------------------------------------------------------------------- */

export function refuseIfInbound(campaign) {
  const type = String(campaign?.type || '').toUpperCase();
  if (type === 'INBOUND') {
    throw new Error(`REFUSED: INBOUND campaigns are immutable — ${campaign?.name || 'campaign'} (Main Number/Dispatch class) cannot be started, stopped, reset, or modified from here`);
  }
}

/* ---------------------------------------------------------------------- *
 * Guardrail 5 — FCC/FTC compliance lines on dialing patches.
 * maxQueueTime is expressed in SECONDS in patches (converted to the Five9
 * timer struct at build time).
 * ---------------------------------------------------------------------- */

export const MAX_QUEUE_TIME_SEC_LIMIT = 2;
export const MAX_ABANDON_PCT_LIMIT = 3;

export function checkCompliancePatch(patch, { complianceOverride = false } = {}) {
  const violations = [];
  const q = patch?.maxQueueTime;
  if (q !== undefined && q !== null && Number(q) > MAX_QUEUE_TIME_SEC_LIMIT) {
    violations.push(`maxQueueTime ${q}s > ${MAX_QUEUE_TIME_SEC_LIMIT}s`);
  }
  const a = patch?.maxDroppedCallsPercentage;
  if (a !== undefined && a !== null && Number(a) > MAX_ABANDON_PCT_LIMIT) {
    violations.push(`abandon ${a}% > ${MAX_ABANDON_PCT_LIMIT}%`);
  }
  if (violations.length && complianceOverride !== true) {
    return { ok: false, violations };
  }
  return { ok: true, violations, overridden: violations.length > 0 };
}

/* ---------------------------------------------------------------------- *
 * Guardrail 6 — DNC removals need a per-number reason.
 * ---------------------------------------------------------------------- */

export function validateDncRemovals(removals) {
  if (!Array.isArray(removals) || !removals.length) {
    throw new Error('five9_remove_numbers_from_dnc requires removals: [{ number, reason }]');
  }
  for (const r of removals) {
    const number = String(r?.number ?? '').trim();
    const reason = String(r?.reason ?? '').trim();
    if (!number) throw new Error('REFUSED: DNC removal entry missing number');
    if (!reason) throw new Error(`REFUSED: DNC removal of ${number} missing reason — every removal must carry a per-number reason string`);
  }
  return removals.map(r => ({ number: String(r.number).trim(), reason: String(r.reason).trim() }));
}

/* ---------------------------------------------------------------------- *
 * Pure SOAP-body builders (exported for offline snapshot tests).
 * ---------------------------------------------------------------------- */

export function buildCampaignNameXml(name) {
  const n = String(name || '').trim();
  if (!n) throw new Error('campaign_name is required');
  return `<campaignName>${escapeXml(n)}</campaignName>`;
}

export function buildNumbersXml(numbers) {
  const list = (Array.isArray(numbers) ? numbers : [numbers])
    .map(n => String(n ?? '').trim()).filter(Boolean);
  if (!list.length) throw new Error('numbers[] is required');
  return list.map(n => `<numbers>${escapeXml(n)}</numbers>`).join('');
}

// timer struct serializer — WSDL tns:timer{days,hours,minutes,seconds}.
export function secondsToTimerXml(tagName, totalSeconds) {
  const total = parseInt(totalSeconds, 10);
  if (!Number.isFinite(total) || total < 0) {
    throw new Error(`${tagName}: seconds must be a non-negative integer, got ${totalSeconds}`);
  }
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `<${tagName}><days>${days}</days><hours>${hours}</hours><minutes>${minutes}</minutes><seconds>${seconds}</seconds></${tagName}>`;
}

/**
 * modifyOutboundCampaign body. There is NO "setOutboundCampaign" in the
 * WSDL — the modify op takes a tns:outboundCampaign object and (per Five9
 * Config API semantics) changes only the fields supplied. All fields are
 * minOccurs=0, but any field that IS sent must sit at its xs:sequence
 * position: campaign base fields, then baseOutboundCampaign, then
 * outboundCampaign extension fields (WSDL-verified order below).
 */
const OUTBOUND_CAMPAIGN_FIELD_ORDER = [
  // tns:campaign base sequence
  'description', 'mode', 'name', 'profileName', 'state', 'trainingMode', 'type',
  // tns:baseOutboundCampaign sequence — none patchable in v1
  // tns:outboundCampaign extension sequence
  'actionOnAnswerMachine', 'actionOnQueueExpiration', 'callAnalysisMode',
  'callsAgentRatio', 'dialNumberOnTimeout', 'dialingMode', 'dialingPriority',
  'dialingRatio', 'distributionAlgorithm', 'distributionTimeFrame',
  'limitPreviewTime', 'maxDroppedCallsPercentage', 'maxPreviewTime',
  'maxQueueTime', 'monitorDroppedCalls', 'previewDialImmediately',
  'useTelemarketingMaxQueTimeEq1',
];

// v1 patch whitelist: the dialing-settings surface only. Anything else
// (state, type, profileName, ...) is refused loudly — no typo pass-through.
export const PATCHABLE_FIELDS = new Set([
  'dialingMode', 'dialingRatio', 'callsAgentRatio', 'maxDroppedCallsPercentage',
  'maxQueueTime', 'maxPreviewTime', 'actionOnQueueExpiration',
  'monitorDroppedCalls', 'dialNumberOnTimeout', 'useTelemarketingMaxQueTimeEq1',
]);

const TIMER_FIELDS = new Set(['maxQueueTime', 'maxPreviewTime']);

export function buildModifyOutboundCampaignXml(campaignName, patch) {
  const name = String(campaignName || '').trim();
  if (!name) throw new Error('campaign_name is required');
  if (!patch || typeof patch !== 'object' || !Object.keys(patch).length) {
    throw new Error('patch with at least one field is required');
  }
  for (const key of Object.keys(patch)) {
    if (!PATCHABLE_FIELDS.has(key)) {
      throw new Error(`REFUSED: "${key}" is not a patchable outbound campaign field (allowed: ${[...PATCHABLE_FIELDS].join(', ')})`);
    }
  }
  const merged = { name, ...patch };
  let xml = '';
  for (const field of OUTBOUND_CAMPAIGN_FIELD_ORDER) {
    const v = merged[field];
    if (v === undefined || v === null) continue;
    xml += TIMER_FIELDS.has(field)
      ? secondsToTimerXml(field, v)
      : `<${field}>${escapeXml(v)}</${field}>`;
  }
  return `<campaign>${xml}</campaign>`;
}

// fieldsMapping entries shared by add/delete list bodies (WSDL tns:fieldEntry).
// key=true on number1 — the dial-key column, same convention as list-dispatch.
function fieldsMappingXml(fieldNames) {
  return fieldNames.map((name, i) =>
    `<fieldsMapping><columnNumber>${i + 1}</columnNumber>` +
    `<fieldName>${escapeXml(name)}</fieldName>` +
    `<key>${name === 'number1'}</key></fieldsMapping>`
  ).join('');
}

// WSDL tns:recordData is repeated <fields> (nillable) — NOT <values>.
function recordXml(values) {
  return `<record>${values.map(v => `<fields>${escapeXml(v ?? '')}</fields>`).join('')}</record>`;
}

/**
 * addRecordToList body — generalized from list-dispatch's builder, but
 * schema-correct: record uses <fields>, and the schema-required booleans
 * (skipHeaderLine from basicImportSettings, cleanListBeforeUpdate from
 * listUpdateSettings) are sent explicitly false in sequence position.
 */
export function buildAddRecordToListXml(listName, fieldNames, values) {
  const list = String(listName || '').trim();
  if (!list) throw new Error('list_name is required');
  if (!Array.isArray(fieldNames) || !Array.isArray(values) || fieldNames.length !== values.length || !fieldNames.length) {
    throw new Error(`fieldsMapping/values mismatch: ${fieldNames?.length ?? 0} fields vs ${values?.length ?? 0} values`);
  }
  return (
    `<listName>${escapeXml(list)}</listName>` +
    `<listUpdateSettings>${fieldsMappingXml(fieldNames)}` +
    `<skipHeaderLine>false</skipHeaderLine>` +
    `<cleanListBeforeUpdate>false</cleanListBeforeUpdate>` +
    `<crmAddMode>ADD_NEW</crmAddMode>` +
    `<crmUpdateMode>UPDATE_FIRST</crmUpdateMode>` +
    `<listAddMode>ADD_FIRST</listAddMode>` +
    `</listUpdateSettings>` +
    recordXml(values)
  );
}

export const LIST_DELETE_MODES = new Set(['DELETE_ALL', 'DELETE_IF_SOLE_CRM_MATCH', 'DELETE_EXCEPT_FIRST']);

export function buildDeleteRecordFromListXml(listName, fieldNames, values, listDeleteMode = 'DELETE_ALL') {
  const list = String(listName || '').trim();
  if (!list) throw new Error('list_name is required');
  if (!Array.isArray(fieldNames) || !Array.isArray(values) || fieldNames.length !== values.length || !fieldNames.length) {
    throw new Error(`fieldsMapping/values mismatch: ${fieldNames?.length ?? 0} fields vs ${values?.length ?? 0} values`);
  }
  if (!LIST_DELETE_MODES.has(listDeleteMode)) {
    throw new Error(`invalid list_delete_mode "${listDeleteMode}" (allowed: ${[...LIST_DELETE_MODES].join(', ')})`);
  }
  return (
    `<listName>${escapeXml(list)}</listName>` +
    `<listDeleteSettings>${fieldsMappingXml(fieldNames)}` +
    `<skipHeaderLine>false</skipHeaderLine>` +
    `<listDeleteMode>${listDeleteMode}</listDeleteMode>` +
    `</listDeleteSettings>` +
    recordXml(values)
  );
}

/* ---------------------------------------------------------------------- *
 * Shared write gate: flag → lock → execute → release → audit event.
 * ---------------------------------------------------------------------- */

const LOCK_CONTACT = 'five9_admin';
const LOCK_TRIGGER = 'write';
const WRITE_LOCK_TTL_SEC = parseInt(process.env.FIVE9_WRITE_LOCK_TTL_SEC || '120', 10);

// Per-record loop cap for list adds — bigger batches belong in asyncAddRecordsToList (not implemented).
export const MAX_RECORDS_PER_ACTION = 50;

// Response failure counters (same class of check as list-dispatch): a
// silently-dropped record must be a loud failure, not a quiet success.
function assertNoRecordFailures(method, xml) {
  const m = /<(failuresCount|failedToImport|failedRecords)>(\d+)<\/\1>/i.exec(xml);
  if (m && parseInt(m[2], 10) > 0) {
    throw new Error(`Five9 ${method}: response reports ${m[2]} failed record(s)`);
  }
}

async function withFive9WriteGate({ action, subtype, entityType, entityId }, fn) {
  // Guardrail 1 first — before lock, before any network. Terminal skip:
  // retrying cannot succeed until the Railway config changes.
  if (!five9WritesEnabled()) {
    console.log(`[FIVE9 WRITES] ${subtype} refused — FIVE9_WRITES_ENABLED != true (ships dark)`);
    return { skipped: true, reason: 'five9_writes_disabled (FIVE9_WRITES_ENABLED != true)' };
  }

  // Guardrail 4 — serialize: one Five9 admin write in flight, fleet-wide.
  const lock = await tryAcquireLock({
    contact_id: LOCK_CONTACT,
    trigger_id: LOCK_TRIGGER,
    sender: 'five9_admin_writes',
    message_preview: `${subtype}:${entityId}`,
    ttl_seconds: WRITE_LOCK_TTL_SEC,
  });
  if (!lock.acquired) {
    const d = decideLockHeldReschedule(lock.expires_at, Date.now(), { attempt: action.retry_count || 0 });
    return d.reschedule
      ? { deferred: true, retry_at: d.retryAt, reason: 'five9_write_lock_held' }
      : { skipped: true, reason: 'five9_write_lock_retry_exhausted' };
  }

  // Guardrail 3 — ctx lets fn record previous/new state progressively so the
  // failure path still carries whatever was captured before the throw.
  const ctx = { previous_state: null, new_state: null, event_extra: {} };
  let result = null;
  let error = null;
  try {
    result = await fn(ctx);
  } catch (err) {
    error = err;
  } finally {
    await releaseLock(LOCK_CONTACT, LOCK_TRIGGER, { expected_expires_at: lock.expires_at });
  }

  await emitEvent({
    event_type: 'five9.admin_write',
    event_subtype: subtype,
    source: 'claude',
    entity_type: entityType,
    entity_id: String(entityId || ''),
    payload: {
      action_id: action.id ?? null,
      op: subtype,
      success: !error,
      error: error ? error.message : null,
      request: action.action_payload ?? null,
      ...ctx.event_extra,
    },
    previous_state: ctx.previous_state,
    new_state: ctx.new_state,
    priority: 'normal',
    bypass_filter: true,
    idempotency_key: action.id ? `five9_write_${action.id}_${subtype}` : null,
  }).catch(err => console.warn(`[FIVE9 WRITES] ${subtype} audit emit failed: ${err.message}`));

  if (error) throw error;
  return { ...result, previous_state: ctx.previous_state, new_state: ctx.new_state };
}

/* ---------------------------------------------------------------------- *
 * Execute functions — called ONLY by src/actions/handlers/five9.js.
 * ---------------------------------------------------------------------- */

async function campaignLifecycle(action, subtype, methodFor) {
  const payload = action.action_payload || {};
  const name = String(payload.campaign_name || '').trim();
  if (!name) throw new Error(`${subtype} requires action_payload.campaign_name`);
  return withFive9WriteGate({ action, subtype, entityType: 'five9_campaign', entityId: name }, async (ctx) => {
    const { campaigns } = await getCampaigns();
    const hit = campaigns.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (!hit) throw new Error(`campaign_not_found: ${name}`);
    ctx.previous_state = hit;
    refuseIfInbound(hit);
    const method = methodFor(payload);
    await five9SoapCall(method, buildCampaignNameXml(hit.name));
    ctx.new_state = await getCampaignState(hit.name);
    return { campaign: hit.name, method, state: ctx.new_state?.state ?? null };
  });
}

export function executeStartCampaign(action) {
  return campaignLifecycle(action, 'start_campaign', () => 'startCampaign');
}

export function executeStopCampaign(action) {
  return campaignLifecycle(action, 'stop_campaign',
    (payload) => (payload.force === true ? 'forceStopCampaign' : 'stopCampaign'));
}

export function executeResetCampaign(action) {
  return campaignLifecycle(action, 'reset_campaign', () => 'resetCampaign');
}

export function executeSetOutboundCampaign(action) {
  const payload = action.action_payload || {};
  const name = String(payload.campaign_name || '').trim();
  const patch = payload.patch;
  if (!name) throw new Error('five9_set_outbound_campaign requires action_payload.campaign_name');
  return withFive9WriteGate({ action, subtype: 'set_outbound_campaign', entityType: 'five9_campaign', entityId: name }, async (ctx) => {
    // Build first — payload validation errors should fire before any read.
    const bodyXml = buildModifyOutboundCampaignXml(name, patch);
    const before = await getOutboundCampaign(name);
    if (before.error) throw new Error(`campaign_not_found: ${name}`);
    ctx.previous_state = before;
    refuseIfInbound(before);
    const compliance = checkCompliancePatch(patch, { complianceOverride: payload.compliance_override === true });
    ctx.event_extra.compliance = compliance;
    if (!compliance.ok) {
      throw new Error(`REFUSED: compliance — ${compliance.violations.join('; ')} (FCC/FTC lines; requires explicit compliance_override: true)`);
    }
    await five9SoapCall('modifyOutboundCampaign', bodyXml);
    const after = await getOutboundCampaign(name);
    ctx.new_state = after;
    // Read-back verification: report drift, never mask a landed write.
    const verify_mismatches = [];
    for (const [field, expected] of Object.entries(patch)) {
      const actual = field === 'maxQueueTime' ? after.maxQueueTimeSeconds
        : field === 'maxPreviewTime' ? undefined // not surfaced in normalized read
        : after[field] ?? after.raw?.[field];
      if (actual !== undefined && String(actual) !== String(expected)) {
        verify_mismatches.push({ field, expected, actual });
      }
    }
    ctx.event_extra.verify_mismatches = verify_mismatches;
    return { campaign: name, patched: Object.keys(patch), verified: verify_mismatches.length === 0, verify_mismatches };
  });
}

export function executeAddRecordsToList(action) {
  const payload = action.action_payload || {};
  const listName = String(payload.list_name || '').trim();
  const fieldNames = payload.field_names;
  const records = payload.records;
  if (!listName) throw new Error('five9_add_records_to_list requires action_payload.list_name');
  if (!Array.isArray(records) || !records.length) throw new Error('five9_add_records_to_list requires action_payload.records: [[values...], ...]');
  if (records.length > MAX_RECORDS_PER_ACTION) {
    throw new Error(`REFUSED: ${records.length} records > ${MAX_RECORDS_PER_ACTION} per action cap`);
  }
  return withFive9WriteGate({ action, subtype: 'add_records_to_list', entityType: 'five9_list', entityId: listName }, async (ctx) => {
    const sizeOf = async () => (await getListsInfo()).lists.find(l => l.name === listName) ?? { name: listName, size: null };
    ctx.previous_state = await sizeOf();
    let added = 0;
    for (const values of records) {
      const xml = await five9SoapCall('addRecordToList', buildAddRecordToListXml(listName, fieldNames, values));
      assertNoRecordFailures('addRecordToList', xml);
      added += 1;
    }
    ctx.new_state = await sizeOf();
    return { list: listName, records_added: added };
  });
}

export function executeDeleteRecordFromList(action) {
  const payload = action.action_payload || {};
  const listName = String(payload.list_name || '').trim();
  if (!listName) throw new Error('five9_delete_record_from_list requires action_payload.list_name');
  return withFive9WriteGate({ action, subtype: 'delete_record_from_list', entityType: 'five9_list', entityId: listName }, async (ctx) => {
    const bodyXml = buildDeleteRecordFromListXml(listName, payload.field_names, payload.values, payload.list_delete_mode || 'DELETE_ALL');
    const sizeOf = async () => (await getListsInfo()).lists.find(l => l.name === listName) ?? { name: listName, size: null };
    ctx.previous_state = await sizeOf();
    const xml = await five9SoapCall('deleteRecordFromList', bodyXml);
    assertNoRecordFailures('deleteRecordFromList', xml);
    ctx.new_state = await sizeOf();
    return { list: listName, record_deleted: true };
  });
}

export function executeAddNumbersToDnc(action) {
  const payload = action.action_payload || {};
  const numbers = (Array.isArray(payload.numbers) ? payload.numbers : [])
    .map(n => String(n ?? '').trim()).filter(Boolean);
  if (!numbers.length) throw new Error('five9_add_numbers_to_dnc requires action_payload.numbers[]');
  return withFive9WriteGate({ action, subtype: 'add_numbers_to_dnc', entityType: 'five9_dnc', entityId: 'dnc' }, async (ctx) => {
    ctx.previous_state = await checkDncForNumbers(numbers);
    await five9SoapCall('addNumbersToDnc', buildNumbersXml(numbers));
    ctx.new_state = await checkDncForNumbers(numbers); // read-back proves the add
    return { numbers_submitted: numbers.length, now_on_dnc: ctx.new_state.on_dnc.length };
  });
}

export function executeRemoveNumbersFromDnc(action) {
  const payload = action.action_payload || {};
  const removals = validateDncRemovals(payload.removals); // throws before the gate — loud
  const numbers = removals.map(r => r.number);
  return withFive9WriteGate({ action, subtype: 'remove_numbers_from_dnc', entityType: 'five9_dnc', entityId: 'dnc' }, async (ctx) => {
    ctx.event_extra.dnc_reasons = removals; // guardrail 6: per-number reasons on the event, verbatim
    ctx.previous_state = await checkDncForNumbers(numbers);
    await five9SoapCall('removeNumbersFromDnc', buildNumbersXml(numbers));
    ctx.new_state = await checkDncForNumbers(numbers); // read-back proves the removal
    return { numbers_submitted: numbers.length, still_on_dnc: ctx.new_state.on_dnc.length };
  });
}
