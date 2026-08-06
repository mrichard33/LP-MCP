/**
 * Five9 Admin WRITE operations — src/five9/admin-writes.js (Phase C)
 *
 * DOCTRINE (enforced, not aspirational):
 *   - NEVER called from MCP tools. The ONLY caller is the action executor
 *     (src/actions/handlers/five9.js) after a row went through
 *     create_agent_action(requires_approval:true) → approve_action.
 *   - Ships dark: FIVE9_WRITES_ENABLED master flag, default false. While
 *     unset, every execute runs in DRY-RUN: all reads and guardrails run
 *     for real, the exact SOAP body is built and logged
 *     ("[FIVE9 WRITES][DRY-RUN] <method> ..."), the audit event fires with
 *     dry_run:true — but the mutating SOAP call is never made and the
 *     action completes as (dry-run). Only the literal string 'true' arms
 *     live writes.
 *   - INBOUND campaigns are immutable: start/stop/reset/modify refuse
 *     type=INBOUND. Main Number / Dispatch are never at risk from here.
 *   - State preconditions: starting a RUNNING campaign or stopping a
 *     NOT_RUNNING one is a skipped no-op, never a blind re-fire.
 *   - confirm_token double-gate on the two highest-risk writes
 *     (five9_set_outbound_campaign, five9_remove_numbers_from_dnc): the
 *     payload must restate its target verbatim (campaign name / the
 *     comma-joined numbers). A typo gate for the creator — the human
 *     forgery gate remains approve_action itself.
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
  getCampaignProfiles,
  getListsInfo,
  checkDncForNumbers,
  timerToSeconds,
} from '../five9-admin.js';
// 2026-08-05 Phase D — read-before-write for user-skill ops. getUsersFullInfo
// takes a Five9 userNamePattern regex and returns assigned skills with levels.
import { getUsersFullInfo } from '../five9-users-info.js';
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

// Guardrail 8 (2026-08-06 Phase E) — floor on CRMRedialTimeout. Shortening the
// redial gate is the whole point of the speed-to-lead change, but there is a
// line past which "fast follow-up" is just repeat-dialing the same consumer.
// 300s (5 min) is the intended operational value and the floor sits exactly
// there, so the intended change passes and anything tighter is deliberate.
export const MIN_CRM_REDIAL_SEC_LIMIT = Math.max(
  0,
  parseInt(process.env.FIVE9_MIN_CRM_REDIAL_SEC || '300', 10),
);

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
  const r = patch?.CRMRedialTimeout;
  if (r !== undefined && r !== null && Number(r) < MIN_CRM_REDIAL_SEC_LIMIT) {
    violations.push(`CRMRedialTimeout ${r}s < ${MIN_CRM_REDIAL_SEC_LIMIT}s`);
  }
  if (violations.length && complianceOverride !== true) {
    return { ok: false, violations };
  }
  return { ok: true, violations, overridden: violations.length > 0 };
}

/* ---------------------------------------------------------------------- *
 * Guardrail 7 (2026-08-05 Phase D) — attempts ceiling on campaign profiles.
 * Same spirit as the abandon-rate line: a number that is defensible at 8 is
 * not defensible at 100. The live `Data Leads` profile was found at 100
 * attempts per record, driving five campaigns.
 * Override is deliberate and audited, never a default.
 * ---------------------------------------------------------------------- */

export const MAX_PROFILE_ATTEMPTS_LIMIT = Math.max(
  1,
  parseInt(process.env.FIVE9_MAX_PROFILE_ATTEMPTS || '12', 10),
);

export function checkProfileCompliance(profile, { complianceOverride = false } = {}) {
  const violations = [];
  const n = profile?.numberOfAttempts;
  if (n !== undefined && n !== null && Number(n) > MAX_PROFILE_ATTEMPTS_LIMIT) {
    violations.push(`numberOfAttempts ${n} > ${MAX_PROFILE_ATTEMPTS_LIMIT}`);
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
 * confirm_token double-gate — the two highest-risk writes must restate
 * their target verbatim in the payload. Pure, exported for tests.
 * ---------------------------------------------------------------------- */

export function requiredConfirmToken(op, payload) {
  if (op === 'set_outbound_campaign') {
    return String(payload?.campaign_name || '').trim();
  }
  if (op === 'remove_numbers_from_dnc') {
    return (Array.isArray(payload?.removals) ? payload.removals : [])
      .map(r => String(r?.number ?? '').trim()).filter(Boolean).join(',');
  }
  // 2026-08-05 Phase D — a campaign profile is shared. `Data Leads` alone
  // serves five campaigns, so one typo here is a five-campaign blast radius.
  // Restating the profile name is the typo gate; approve_action stays the
  // human gate. (Live as of Phase D-2, 2026-08-06.)
  if (op === 'modify_campaign_profile') {
    return String(payload?.profile_name || '').trim();
  }
  return null; // op not double-gated
}

export function checkConfirmToken(op, payload) {
  const required = requiredConfirmToken(op, payload);
  if (required === null) return;
  if (String(payload?.confirm_token ?? '') !== required) {
    throw new Error(`REFUSED: confirm_token mismatch for ${op} — payload.confirm_token must exactly equal "${required}" (restate the target to confirm)`);
  }
}

/* ---------------------------------------------------------------------- *
 * State preconditions — lifecycle ops never blind-fire a no-op transition.
 * Pure, exported for tests.
 * ---------------------------------------------------------------------- */

export function decideLifecycleNoop(subtype, state) {
  if (subtype === 'start_campaign' && state === 'RUNNING') return 'already_running';
  if (subtype === 'stop_campaign' && state === 'NOT_RUNNING') return 'already_stopped';
  return null; // reset has no precondition (valid on stopped campaigns)
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
 * Inverse of secondsToTimerXml, for read-back verification.
 *
 * Five9 ACCEPTS an integer of seconds on write but RETURNS tns:timer as a
 * {days,hours,minutes,seconds} struct on read. The two sides of a read-back
 * comparison are therefore different shapes and must be normalized before
 * they can be compared at all.
 *
 * Struct arithmetic is delegated to timerToSeconds (src/five9-admin.js) rather
 * than reimplemented — that function already backs maxQueueTimeSeconds on the
 * read path and has its own tests. This wrapper adds only the scalar forms the
 * WRITE side produces (a patch value is a number, or a numeric string off a
 * JSON payload). Returns null when the value is not a recognizable timer.
 */
export function timerStructToSeconds(t) {
  if (t === null || t === undefined) return null;
  if (typeof t === 'number') return Number.isFinite(t) ? t : null;
  if (typeof t === 'string') {
    const s = t.trim();
    return /^\d+$/.test(s) ? Number(s) : null;
  }
  return timerToSeconds(t); // objects → struct math; anything else → null
}

/**
 * modifyOutboundCampaign body. There is NO "setOutboundCampaign" in the
 * WSDL — the modify op takes a tns:outboundCampaign object and (per Five9
 * Config API semantics) changes only the fields supplied. All fields are
 * minOccurs=0, but any field that IS sent must sit at its xs:sequence
 * position: campaign base fields, then baseOutboundCampaign, then
 * outboundCampaign extension fields (WSDL-verified order below).
 */
// FULL xs:sequence for tns:outboundCampaign, WSDL-verified 2026-08-06 against
// api.five9.com/wsadmin/v13. The inheritance chain is four levels deep and
// JAXB unmarshals base-type fields BEFORE extension fields, so every level's
// sequence must appear in order even when only one field from it is sent.
//
// v1 of this array skipped tns:generalCampaign and tns:baseOutboundCampaign
// entirely. That was harmless only because nothing in either level was
// patchable. CRMRedialTimeout (baseOutboundCampaign, position 2) is the first
// field from those levels to become patchable — hence the correction here.
//
// ALL FOUR LEVELS ARE QUOTED FROM THE WSDL, not inferred from a read response.
// Re-verified 2026-08-06 by extracting each xs:sequence and concatenating them
// in inheritance order (note: that is NOT the order they appear in the
// document — offsets below are where each type is DEFINED):
//
//   tns:campaign               defined @ 42,369  …  7 fields
//   tns:generalCampaign        defined @ 41,624  …  7 fields
//   tns:baseOutboundCampaign   defined @ 40,695* …  8 fields
//   tns:outboundCampaign       defined @ 44,807* … 17 fields
//                                                = 39 fields, byte-identical
//                                                  to the array below
//
// CRMRedialTimeout lands at index 15 overall — second within
// baseOutboundCampaign, immediately after analyzeLevel.
//
// * An earlier pass reported these two levels as unreachable behind the
//   http_request 100k cap. That was wrong: all four types sit inside the first
//   100k chars and the cap never applied to this chain. The real cause was an
//   extraction regex anchored on `<xs:complexType name="X">`, which cannot
//   match baseOutboundCampaign (abstract="true") or outboundCampaign
//   (final="extension restriction") — exactly the two that came back empty,
//   and an empty match is indistinguishable from a truncated fetch. Nothing
//   about this ordering was ever unverifiable. See the FETCH NOTE in the
//   Phase D profile section for the corrected pattern.
//
// NOTE: presence in this array does NOT make a field patchable. This is a
// faithful copy of the WSDL sequence; PATCHABLE_FIELDS is the permission list,
// and the two are deliberately different sizes.
export const OUTBOUND_CAMPAIGN_FIELD_ORDER = [
  // tns:campaign base sequence
  'description', 'mode', 'name', 'profileName', 'state', 'trainingMode', 'type',
  // tns:generalCampaign sequence — none patchable
  'autoRecord', 'callWrapup', 'ftpHost', 'ftpPassword', 'ftpUser',
  'recordingNameAsSid', 'useFtp',
  // tns:baseOutboundCampaign sequence — CRMRedialTimeout patchable as of Phase E
  'analyzeLevel', 'CRMRedialTimeout', 'dnisAsAni', 'enableListDialingRatios',
  'listDialingMode', 'noOutOfNumbersAlert', 'stateDialingRule',
  'timeZoneAssignment',
  // tns:outboundCampaign extension sequence
  'actionOnAnswerMachine', 'actionOnQueueExpiration', 'callAnalysisMode',
  'callsAgentRatio', 'dialNumberOnTimeout', 'dialingMode', 'dialingPriority',
  'dialingRatio', 'distributionAlgorithm', 'distributionTimeFrame',
  'limitPreviewTime', 'maxDroppedCallsPercentage', 'maxPreviewTime',
  'maxQueueTime', 'monitorDroppedCalls', 'previewDialImmediately',
  'useTelemarketingMaxQueTimeEq1',
];

// v2 patch whitelist (2026-08-05 Phase D). Still the dialing/routing surface
// only — `state`, `type`, and `trainingMode` stay refused; lifecycle has its
// own ops and training mode is not an agentic decision.
//
// Added in v2, all of them already present in OUTBOUND_CAMPAIGN_FIELD_ORDER
// and already accepted by modifyOutboundCampaign — v1 simply never allowed
// them through:
//   distributionAlgorithm   — DIAL ASAP ran RoundRobin, which ignores skill
//                             LEVEL, on the highest-yield campaign
//   previewDialImmediately  — false + 2min maxPreviewTime on a speed-to-lead
//                             campaign is agent-hesitation latency by config
//   profileName             — required to move a campaign onto a per-tier
//                             profile without recreating the campaign
//   dialingPriority, callAnalysisMode, actionOnAnswerMachine,
//   limitPreviewTime, distributionTimeFrame — round out the surface
export const PATCHABLE_FIELDS = new Set([
  'dialingMode', 'dialingRatio', 'callsAgentRatio', 'maxDroppedCallsPercentage',
  'maxQueueTime', 'maxPreviewTime', 'actionOnQueueExpiration',
  'monitorDroppedCalls', 'dialNumberOnTimeout', 'useTelemarketingMaxQueTimeEq1',
  'distributionAlgorithm', 'previewDialImmediately', 'profileName',
  'dialingPriority', 'callAnalysisMode', 'actionOnAnswerMachine',
  'limitPreviewTime', 'distributionTimeFrame',
  // v3 (2026-08-06 Phase E) — CRMRedialTimeout: the minimum time before the
  // same CRM record may be dialed again by this campaign. Both DIAL ASAP and
  // After DIAL ASAP sat at 2 hours, which is what put an hour-plus gap between
  // a new lead's first and second call.
  'CRMRedialTimeout',
]);

// tns:timer struct fields — serialized via secondsToTimerXml, never escapeXml.
const TIMER_FIELDS = new Set(['maxQueueTime', 'maxPreviewTime', 'CRMRedialTimeout']);

// Phase C defect (fixed here): actionOnQueueExpiration was already in the v1
// whitelist, but the builder ran escapeXml() over it. It is a complex type
// ({ actionType: 'DROP_CALL' }), so it serialized as the literal string
// "[object Object]". Any v1 patch touching it was malformed. These two fields
// emit a nested <actionType> element instead.
const COMPLEX_ACTION_FIELDS = new Set(['actionOnQueueExpiration', 'actionOnAnswerMachine']);

export function actionFieldXml(tagName, value) {
  const actionType = typeof value === 'string' ? value : value?.actionType;
  const at = String(actionType ?? '').trim();
  if (!at) {
    throw new Error(`${tagName}: expected { actionType: "..." } or a string, got ${JSON.stringify(value)}`);
  }
  return `<${tagName}><actionType>${escapeXml(at)}</actionType></${tagName}>`;
}

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
    if (TIMER_FIELDS.has(field)) {
      xml += secondsToTimerXml(field, v);
    } else if (COMPLEX_ACTION_FIELDS.has(field)) {
      xml += actionFieldXml(field, v);
    } else {
      xml += `<${field}>${escapeXml(v)}</${field}>`;
    }
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
 * Phase D builders — user skills + campaign profiles.
 *
 * FIELD ORDER BELOW IS WSDL-DERIVED, quoted from the live v13 schema on
 * 2026-08-06 (api.five9.com/wsadmin/v13/AdminWebService?wsdl). Read-response
 * order was NOT used to derive it. Both sequences are flat — neither type
 * uses xs:extension, so there is no base sequence to emit first.
 *
 *   <xs:complexType name="campaignProfileInfo"><xs:sequence>
 *     ANI, description, dialingSchedule, dialingTimeout,
 *     initialCallPriority, maxCharges, name, numberOfAttempts
 *
 *   <xs:complexType name="userSkill"><xs:sequence>
 *     id, level, skillName, userName
 *
 * NOTE: in userSkill, <level> is the ONE element without minOccurs="0" —
 * it is schema-required on every userSkill* call, including remove. We never
 * send <id>; userName + skillName are the natural key.
 * ---------------------------------------------------------------------- */

const USER_SKILL_FIELD_ORDER = ['id', 'level', 'skillName', 'userName'];

// `dialingSchedule` is a nested complex type and is deliberately NOT patchable
// in v1 — only scalars are emitted. It stays in the order array so the
// sequence stays a faithful copy of the WSDL.
const CAMPAIGN_PROFILE_FIELD_ORDER = [
  'ANI', 'description', 'dialingSchedule', 'dialingTimeout',
  'initialCallPriority', 'maxCharges', 'name', 'numberOfAttempts',
];

export const PROFILE_PATCHABLE_FIELDS = new Set([
  'description', 'ANI', 'numberOfAttempts', 'dialingTimeout',
  'initialCallPriority', 'maxCharges',
]);

export const SKILL_LEVEL_MIN = 1;
export const SKILL_LEVEL_MAX = 9;

// getUsersFullInfo takes a Five9-side regex. Anchor + escape so "jflanders"
// cannot match "jflanders2" and a dot in an email-style login stays literal.
export function exactUserPattern(userName) {
  return `^${String(userName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

export function buildUserSkillXml(userSkill) {
  const userName = String(userSkill?.userName || '').trim();
  const skillName = String(userSkill?.skillName || '').trim();
  if (!userName) throw new Error('userSkill.userName is required');
  if (!skillName) throw new Error('userSkill.skillName is required');

  // <level> is schema-required (the only element in the type without
  // minOccurs="0"), so it is never optional here.
  const lvl = parseInt(userSkill?.level, 10);
  if (!Number.isFinite(lvl) || lvl < SKILL_LEVEL_MIN || lvl > SKILL_LEVEL_MAX) {
    throw new Error(`userSkill.level must be ${SKILL_LEVEL_MIN}–${SKILL_LEVEL_MAX}, got ${userSkill?.level}`);
  }

  const merged = { level: lvl, skillName, userName };
  let xml = '';
  for (const field of USER_SKILL_FIELD_ORDER) {
    const v = merged[field];
    if (v === undefined || v === null) continue;
    xml += `<${field}>${escapeXml(v)}</${field}>`;
  }
  return `<userSkill>${xml}</userSkill>`;
}

export function buildCampaignProfileXml(profileName, patch) {
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
  // Guardrail 1 — FIVE9_WRITES_ENABLED unset/false means DRY-RUN, never a
  // mutation: reads and guardrails run for real, the exact SOAP body is
  // built and logged, but ctx.soap short-circuits the write itself.
  const dryRun = !five9WritesEnabled();
  if (dryRun) {
    console.log(`[FIVE9 WRITES][DRY-RUN] ${subtype} — FIVE9_WRITES_ENABLED != true, previewing only`);
  }

  // Guardrail 4 — serialize: one Five9 admin write in flight, fleet-wide.
  // Held in dry-run too, so previews exercise the exact live path.
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
  // ctx.soap is the single mutation seam: live it calls five9SoapCall, in
  // dry-run it records + logs the envelope and returns null.
  const ctx = {
    dry_run: dryRun,
    previous_state: null,
    new_state: null,
    event_extra: {},
    envelopes: [],
    soap: async (method, innerXml) => {
      if (dryRun) {
        ctx.envelopes.push({ method, innerXml });
        console.log(`[FIVE9 WRITES][DRY-RUN] would send ${method}: ${innerXml}`);
        return null;
      }
      return five9SoapCall(method, innerXml);
    },
  };
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
      dry_run: dryRun,
      error: error ? error.message : null,
      request: action.action_payload ?? null,
      ...(dryRun ? { envelopes: ctx.envelopes } : {}),
      ...ctx.event_extra,
    },
    previous_state: ctx.previous_state,
    new_state: ctx.new_state,
    priority: 'normal',
    bypass_filter: true,
    idempotency_key: action.id ? `five9_write_${action.id}_${subtype}` : null,
  }).catch(err => console.warn(`[FIVE9 WRITES] ${subtype} audit emit failed: ${err.message}`));

  if (error) throw error;
  if (result?.skipped) return result; // precondition no-op — pass through untouched
  return {
    ...(dryRun ? { dry_run: true, envelope_preview: ctx.envelopes } : {}),
    ...result,
    previous_state: ctx.previous_state,
    new_state: ctx.new_state,
  };
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
    const noop = decideLifecycleNoop(subtype, hit.state);
    if (noop) return { skipped: true, reason: noop, campaign: hit.name, state: hit.state };
    const method = methodFor(payload);
    await ctx.soap(method, buildCampaignNameXml(hit.name));
    if (!ctx.dry_run) ctx.new_state = await getCampaignState(hit.name);
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

/**
 * Read-back verification for a modifyOutboundCampaign patch: report drift,
 * never mask a landed write. Returns the mismatch rows; empty === verified.
 *
 * Pure and exported so the comparison can be tested against a simulated
 * read-back without standing up the write gate — this is the function that
 * decides whether `verified` is true, so it needs direct coverage.
 *
 * tns:timer fields are the subtle case. They are WRITTEN as an integer of
 * seconds and READ BACK as a {days,hours,minutes,seconds} struct, so a naive
 * String(actual) !== String(expected) compares "[object Object]" against "300"
 * and is true forever — a PERMANENT false negative on the one field that says
 * a gated write actually landed.
 *
 * Found live on action 283332 (2026-08-06, CRMRedialTimeout 2h → 300s): the
 * write was correct, the read-back was {hours:'0',minutes:'5'}, and it still
 * reported verified:false. In practice CRMRedialTimeout was the only field
 * exposed — maxQueueTime resolves to the already-normalized
 * maxQueueTimeSeconds, and maxPreviewTime is not surfaced by the reader at all
 * — but the timer branch covers all three, because TIMER_FIELDS is exactly the
 * tns:timer set and those two exemptions are properties of the current reader
 * rather than of the protocol.
 */
export function verifyPatchReadBack(patch, after) {
  const mismatches = [];
  for (const [field, expected] of Object.entries(patch || {})) {
    const actual = field === 'maxQueueTime' ? after?.maxQueueTimeSeconds
      : field === 'maxPreviewTime' ? undefined // not surfaced in normalized read
      : after?.[field] ?? after?.raw?.[field];
    if (actual === undefined) continue;
    if (TIMER_FIELDS.has(field)) {
      const a = timerStructToSeconds(actual);
      const e = timerStructToSeconds(expected);
      // A timer that will not normalize is NOT a pass. Silently treating an
      // unreadable read-back as verified is the same defect in a new shape,
      // so it is reported rather than skipped.
      if (a === null || e === null || a !== e) {
        mismatches.push({ field, expected: e ?? expected, actual: a, actual_raw: actual });
      }
      continue;
    }
    if (String(actual) !== String(expected)) {
      mismatches.push({ field, expected, actual });
    }
  }
  return mismatches;
}

export function executeSetOutboundCampaign(action) {
  const payload = action.action_payload || {};
  const name = String(payload.campaign_name || '').trim();
  const patch = payload.patch;
  if (!name) throw new Error('five9_set_outbound_campaign requires action_payload.campaign_name');
  return withFive9WriteGate({ action, subtype: 'set_outbound_campaign', entityType: 'five9_campaign', entityId: name }, async (ctx) => {
    // Build + token-check first — payload errors should fire before any read.
    const bodyXml = buildModifyOutboundCampaignXml(name, patch);
    checkConfirmToken('set_outbound_campaign', payload);
    const before = await getOutboundCampaign(name);
    if (before.error) throw new Error(`campaign_not_found: ${name}`);
    ctx.previous_state = before;
    refuseIfInbound(before);
    const compliance = checkCompliancePatch(patch, { complianceOverride: payload.compliance_override === true });
    ctx.event_extra.compliance = compliance;
    if (!compliance.ok) {
      throw new Error(`REFUSED: compliance — ${compliance.violations.join('; ')} (FCC/FTC lines; requires explicit compliance_override: true)`);
    }
    await ctx.soap('modifyOutboundCampaign', bodyXml);
    if (ctx.dry_run) {
      return { campaign: name, patched: Object.keys(patch) };
    }
    const after = await getOutboundCampaign(name);
    ctx.new_state = after;
    const verify_mismatches = verifyPatchReadBack(patch, after);
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
      const xml = await ctx.soap('addRecordToList', buildAddRecordToListXml(listName, fieldNames, values));
      if (xml !== null) assertNoRecordFailures('addRecordToList', xml);
      added += 1;
    }
    if (!ctx.dry_run) ctx.new_state = await sizeOf();
    return { list: listName, records_added: ctx.dry_run ? 0 : added, records_previewed: ctx.dry_run ? added : undefined };
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
    const xml = await ctx.soap('deleteRecordFromList', bodyXml);
    if (xml !== null) assertNoRecordFailures('deleteRecordFromList', xml);
    if (!ctx.dry_run) ctx.new_state = await sizeOf();
    return { list: listName, record_deleted: !ctx.dry_run };
  });
}

export function executeAddNumbersToDnc(action) {
  const payload = action.action_payload || {};
  const numbers = (Array.isArray(payload.numbers) ? payload.numbers : [])
    .map(n => String(n ?? '').trim()).filter(Boolean);
  if (!numbers.length) throw new Error('five9_add_numbers_to_dnc requires action_payload.numbers[]');
  return withFive9WriteGate({ action, subtype: 'add_numbers_to_dnc', entityType: 'five9_dnc', entityId: 'dnc' }, async (ctx) => {
    ctx.previous_state = await checkDncForNumbers(numbers);
    await ctx.soap('addNumbersToDnc', buildNumbersXml(numbers));
    if (ctx.dry_run) return { numbers_submitted: numbers.length };
    ctx.new_state = await checkDncForNumbers(numbers); // read-back proves the add
    return { numbers_submitted: numbers.length, now_on_dnc: ctx.new_state.on_dnc.length };
  });
}

export function executeRemoveNumbersFromDnc(action) {
  const payload = action.action_payload || {};
  const removals = validateDncRemovals(payload.removals); // throws before the gate — loud
  checkConfirmToken('remove_numbers_from_dnc', payload); // restate-the-target double gate
  const numbers = removals.map(r => r.number);
  return withFive9WriteGate({ action, subtype: 'remove_numbers_from_dnc', entityType: 'five9_dnc', entityId: 'dnc' }, async (ctx) => {
    ctx.event_extra.dnc_reasons = removals; // guardrail 6: per-number reasons on the event, verbatim
    ctx.previous_state = await checkDncForNumbers(numbers);
    await ctx.soap('removeNumbersFromDnc', buildNumbersXml(numbers));
    if (ctx.dry_run) return { numbers_submitted: numbers.length };
    ctx.new_state = await checkDncForNumbers(numbers); // read-back proves the removal
    return { numbers_submitted: numbers.length, still_on_dnc: ctx.new_state.on_dnc.length };
  });
}

/* ---------------------------------------------------------------------- *
 * Phase D executes — user skills.
 *
 * All three ops take the same <userSkill> object (WSDL-confirmed: the
 * userSkillAdd / userSkillModify / userSkillRemove request wrappers each
 * hold exactly one element, name="userSkill" type="tns:userSkill").
 *
 * Read-before-write reads the ONE user by exact-match pattern, so the audit
 * event carries that user's full skill set before and after. Skill routing is
 * the difference between a staffed queue and an 8-minute hold; the diff needs
 * to be legible six months later.
 * ---------------------------------------------------------------------- */

async function readUserSkills(userName) {
  const res = await getUsersFullInfo(exactUserPattern(userName));
  const users = res?.users || [];
  const hit = users.find(u => String(u.userName).toLowerCase() === String(userName).toLowerCase());
  if (!hit) return { userName, found: false, skills: [] };
  return { userName: hit.userName, found: true, active: hit.active, skills: hit.skills || [] };
}

// five9-users-info.js normalizes the wire tag <skillName> to `name`.
const heldSkill = (skills, skillName) =>
  (skills || []).find(s => String(s.name) === skillName) || null;

function userSkillOp(action, subtype, method) {
  const payload = action.action_payload || {};
  const userName = String(payload.user_name || '').trim();
  const skillName = String(payload.skill_name || '').trim();
  if (!userName) throw new Error(`${subtype} requires action_payload.user_name`);
  if (!skillName) throw new Error(`${subtype} requires action_payload.skill_name`);

  return withFive9WriteGate(
    { action, subtype, entityType: 'five9_user_skill', entityId: `${userName}:${skillName}` },
    async (ctx) => {
      const before = await readUserSkills(userName);
      if (!before.found) throw new Error(`user_not_found: ${userName}`);
      ctx.previous_state = before;

      const held = heldSkill(before.skills, skillName);
      if (subtype === 'user_skill_add' && held) {
        return { skipped: true, reason: 'already_holds_skill', user: userName, skill: skillName };
      }
      if ((subtype === 'user_skill_remove' || subtype === 'user_skill_modify') && !held) {
        return { skipped: true, reason: 'does_not_hold_skill', user: userName, skill: skillName };
      }

      // <level> is schema-required on every userSkill* call. Add/modify take it
      // from the payload; remove has nothing to change it to, so it restates
      // the level the user currently holds.
      const level = subtype === 'user_skill_remove' ? (held?.level ?? SKILL_LEVEL_MIN) : payload.level;
      const bodyXml = buildUserSkillXml({ userName, skillName, level });

      await ctx.soap(method, bodyXml);
      if (ctx.dry_run) return { user: userName, skill: skillName, method };

      const after = await readUserSkills(userName);
      ctx.new_state = after;
      const nowHeld = !!heldSkill(after.skills, skillName);
      const expected = subtype !== 'user_skill_remove';
      ctx.event_extra.verified = nowHeld === expected;
      return {
        user: userName,
        skill: skillName,
        method,
        verified: nowHeld === expected,
        skill_count: after.skills.length,
      };
    },
  );
}

export function executeUserSkillAdd(action) {
  return userSkillOp(action, 'user_skill_add', 'userSkillAdd');
}

export function executeUserSkillModify(action) {
  return userSkillOp(action, 'user_skill_modify', 'userSkillModify');
}

export function executeUserSkillRemove(action) {
  return userSkillOp(action, 'user_skill_remove', 'userSkillRemove');
}

/* ---------------------------------------------------------------------- *
 * Phase D executes — campaign profiles.
 *
 * RESOLVED 2026-08-06 (Phase D-2). Both ops take the SAME wrapper, verified
 * against the live v13 WSDL:
 *
 *   <xs:complexType name="modifyCampaignProfile"><xs:sequence>
 *     <xs:element minOccurs="0" name="campaignProfile"
 *                 type="tns:campaignProfileInfo"/>
 *
 * ...identical to createCampaignProfile, so buildCampaignProfileXml is reused
 * unchanged for both.
 *
 * FETCH NOTE (do not re-derive this): the WSDL endpoint requires a `user`
 * QUERY parameter — a bare "?wsdl" with no credentials 403s with faultstring
 * 'No user name ("user") parameter provided'. The param is NOT validated, so
 * any value works and no Basic auth is needed for the document itself.
 * The document is ~962KB on a SINGLE line, so line-oriented grep finds
 * nothing — extract with a DOTALL regex, not grep.
 * SEPARATELY: the LP-MCP http_request tool caps response bodies at 100,000
 * chars (MAX_BODY_CHARS, src/tools/admin/http-tools.js), which is what
 * actually blocked Phase D — modifyCampaignProfile sits at offset ~142,593,
 * past that cut on every WSDL build, with or without auth. Fetch from a host
 * without that cap:
 *   curl -s "https://api.five9.com/wsadmin/v13/AdminWebService?wsdl&user=x" \
 *     | python3 -c "import re,sys; \
 *         print(re.search(r'<xs:complexType[^>]*\bname=\"NAME\"[^>]*>.*?</xs:complexType>', \
 *         sys.stdin.read(), re.S).group(0))"
 *
 * USE THAT EXACT PATTERN. An earlier version anchored on
 * `<xs:complexType name="NAME">`, which matches only types whose FIRST
 * attribute is `name` — it silently returns nothing for any abstract or final
 * type (`<xs:complexType abstract="true" name="...">`). A no-match is
 * indistinguishable from a truncated fetch, so the failure reads as "past the
 * 100k cap" when the type is really sitting well inside it. That misread cost
 * a full detour on the outboundCampaign chain; see OUTBOUND_CAMPAIGN_FIELD_ORDER.
 *
 * The naming inconsistency across this op family is real but not ambiguous:
 * every op taking a full campaignProfileInfo OBJECT uses "campaignProfile"
 * (create, modify); ops taking a profile NAME string use either
 * "profileName" (ModifyCrmCriteria, ModifyDispositions) or "campaignProfile"
 * as xs:string (ModifyFilterOrder). Do not relitigate.
 *
 * MODIFY is confirm_token-gated (restate the profile name) because a profile
 * is shared — `Data Leads` serves five campaigns. CREATE is not: a new profile
 * is attached to nothing until a separate five9_set_outbound_campaign patch
 * moves a campaign onto it.
 * ---------------------------------------------------------------------- */

async function readProfile(profileName) {
  const res = await getCampaignProfiles();
  const list = res?.profiles || [];
  return list.find(p => String(p.name).toLowerCase() === String(profileName).toLowerCase()) || null;
}

export function executeCreateCampaignProfile(action) {
  const payload = action.action_payload || {};
  const name = String(payload.profile_name || '').trim();
  const profile = payload.profile;
  if (!name) throw new Error('five9_create_campaign_profile requires action_payload.profile_name');
  if (!profile || typeof profile !== 'object') {
    throw new Error('five9_create_campaign_profile requires action_payload.profile');
  }

  return withFive9WriteGate(
    { action, subtype: 'create_campaign_profile', entityType: 'five9_campaign_profile', entityId: name },
    async (ctx) => {
      const bodyXml = buildCampaignProfileXml(name, profile);
      const existing = await readProfile(name);
      // Check before assigning previous_state: the gate returns `skipped`
      // results untouched, so state set here would be dropped anyway.
      if (existing) {
        return { skipped: true, reason: 'profile_already_exists', profile: name };
      }
      ctx.previous_state = existing;

      const compliance = checkProfileCompliance(profile, {
        complianceOverride: payload.compliance_override === true,
      });
      ctx.event_extra.compliance = compliance;
      if (!compliance.ok) {
        throw new Error(`REFUSED: compliance — ${compliance.violations.join('; ')} (attempts ceiling; requires explicit compliance_override: true)`);
      }

      await ctx.soap('createCampaignProfile', bodyXml);
      if (ctx.dry_run) return { profile: name, created: false, previewed: true };

      ctx.new_state = await readProfile(name);
      return { profile: name, created: !!ctx.new_state };
    },
  );
}

export function executeModifyCampaignProfile(action) {
  const payload = action.action_payload || {};
  const name = String(payload.profile_name || '').trim();
  const patch = payload.patch;
  if (!name) throw new Error('five9_modify_campaign_profile requires action_payload.profile_name');

  return withFive9WriteGate(
    { action, subtype: 'modify_campaign_profile', entityType: 'five9_campaign_profile', entityId: name },
    async (ctx) => {
      // Build + token-check first — payload errors fire before any read.
      const bodyXml = buildCampaignProfileXml(name, patch);
      checkConfirmToken('modify_campaign_profile', payload);

      const before = await readProfile(name);
      if (!before) throw new Error(`profile_not_found: ${name}`);
      ctx.previous_state = before;

      const compliance = checkProfileCompliance(patch, {
        complianceOverride: payload.compliance_override === true,
      });
      ctx.event_extra.compliance = compliance;
      if (!compliance.ok) {
        throw new Error(`REFUSED: compliance — ${compliance.violations.join('; ')} (attempts ceiling; requires explicit compliance_override: true)`);
      }

      await ctx.soap('modifyCampaignProfile', bodyXml);
      if (ctx.dry_run) return { profile: name, patched: Object.keys(patch) };

      const after = await readProfile(name);
      ctx.new_state = after;
      // Read-back verification: report drift, never mask a landed write.
      const verify_mismatches = [];
      for (const [field, expected] of Object.entries(patch)) {
        const actual = after?.[field] ?? after?.raw?.[field];
        if (actual !== undefined && String(actual) !== String(expected)) {
          verify_mismatches.push({ field, expected, actual });
        }
      }
      ctx.event_extra.verify_mismatches = verify_mismatches;
      return {
        profile: name,
        patched: Object.keys(patch),
        verified: verify_mismatches.length === 0,
        verify_mismatches,
      };
    },
  );
}
