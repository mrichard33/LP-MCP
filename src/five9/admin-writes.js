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
 *     NOT_RUNNING one is a skipped no-op, never a blind re-fire. Resetting a
 *     RUNNING one is different in kind — it REFUSES (Guardrail 11), because
 *     the request is dangerous rather than already-satisfied.
 *   - confirm_token double-gate on the highest-risk writes: the payload must
 *     restate its target verbatim. A typo gate for the creator — the human
 *     forgery gate remains approve_action itself. requiredConfirmToken() is
 *     the authority on which ops carry it and what the token must be; as of
 *     2026-08-21 that is set_outbound_campaign (campaign name),
 *     reset_campaign (campaign name), modify_campaign_profile (profile name),
 *     async_delete_records_from_list (list name), modify_ivr_script (script
 *     name), and remove_dnis_from_campaign (campaign name).
 *   - DNC is ADD-ONLY. There is no removal op and no gate that yields one;
 *     five9_remove_numbers_from_dnc was deleted on 2026-08-21. Do not
 *     reintroduce it.
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

import { readFileSync } from 'node:fs';

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
  returnBlocks,
  tag,
  asArray,
  getUsersGeneralInfo,
  // 2026-08-12 Phase F — async import job triad (read-only followers for the
  // job handle asyncDeleteRecordsFromList returns).
  isImportRunning,
  getListImportResult,
  // 2026-08-13 Phase G — config-surface reads used for read-before-write,
  // name-collision checks, the DNIS-steal guard, and read-back verification.
  getIVRScripts,
  getPrompts,
  getDnisMap,
  getCampaignDNISList,
  getInboundCampaign,
  // 2026-08-21 Phase H PR4 — read-before-write and existence checks for the
  // web-connector pair and the campaign-composition tranche.
  getWebConnector,
  getSkills,
  getDispositions,
  getCampaignStrategies,
} from '../five9-admin.js';
// 2026-08-05 Phase D — read-before-write for user-skill ops. getUsersFullInfo
// takes a Five9 userNamePattern regex and returns assigned skills with levels.
import { getUsersFullInfo, getUserProfile } from '../five9-users-info.js';
import { tryAcquireLock, releaseLock, decideLockHeldReschedule } from '../services/outbound-locks.js';
import { emitEvent } from '../event-emitter.js';
import { resolveContactDncNumbers } from '../actions/resolvers.js';
import { ghlFetch } from '../actions/helpers.js';
import supabase from '../supabase.js';

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
 * Guardrail 9 (2026-08-12 Phase F) — ceilings on BULK list deletion.
 *
 * asyncDeleteRecordsFromList is the highest-blast-radius write in this file:
 * one approved action can empty a dialing list, and there is no true undo
 * (see the rollback note on executeAsyncDeleteRecordsFromList — re-adding
 * restores dial keys, never the non-key columns Five9 held).
 *
 * Two independent lines, because they catch different failures:
 *   - the ABSOLUTE ceiling catches "this cohort is far bigger than anyone
 *     intended to delete in one action";
 *   - the PROPORTION line catches a bad cohort query that nukes the list
 *     instead of the intended subset. A 1,500-record delete is unremarkable
 *     against a 40,000-record list and catastrophic against a 2,000-record
 *     one, and the absolute ceiling cannot tell those apart.
 *
 * `limit` is injectable so the ceiling is testable without re-importing the
 * module — MAX_LIST_DELETE_LIMIT is frozen at module load like every other
 * numeric limit here, so process.env cannot move it after import.
 * Override is deliberate and audited, never a default.
 * ---------------------------------------------------------------------- */

export const MAX_LIST_DELETE_LIMIT = Math.max(
  1,
  parseInt(process.env.FIVE9_MAX_LIST_DELETE || '2000', 10),
);

// >50% of the list is a cohort-query failure until proven otherwise.
export const MAX_LIST_DELETE_PROPORTION = 0.5;

export function checkListDeleteCompliance(
  { requested, listSize } = {},
  { complianceOverride = false, limit = MAX_LIST_DELETE_LIMIT } = {},
) {
  const violations = [];
  const n = Number(requested);
  if (Number.isFinite(n) && n > limit) {
    violations.push(`${n} records > ${limit} per-action ceiling (FIVE9_MAX_LIST_DELETE)`);
  }
  // listSize null/unknown (list not found in getListsInfo) is NOT a pass —
  // an unreadable denominator means the proportion line cannot be evaluated,
  // and silently skipping it is the same lie as a permanent false negative.
  const size = Number(listSize);
  if (!Number.isFinite(size) || size <= 0) {
    violations.push(`list size unknown (${listSize}) — proportion guard cannot be evaluated`);
  } else if (Number.isFinite(n) && n > size * MAX_LIST_DELETE_PROPORTION) {
    const pct = ((n / size) * 100).toFixed(1);
    violations.push(
      `${n} of ${size} records = ${pct}% > ${MAX_LIST_DELETE_PROPORTION * 100}% of the list`,
    );
  }
  if (violations.length && complianceOverride !== true) {
    return { ok: false, violations };
  }
  return { ok: true, violations, overridden: violations.length > 0 };
}

/* ---------------------------------------------------------------------- *
 * Guardrail 10 (2026-08-12 Phase F) — declared-count gate on bulk deletes.
 * The payload must state how many records it believes it is deleting, and
 * that number must equal the records actually serialized. A silent off-by-N
 * on a delete is unrecoverable, so the two are reconciled before the SOAP
 * body is ever sent.
 * ---------------------------------------------------------------------- */

export function assertDeclaredRecordCount(expected, actual) {
  if (expected === undefined || expected === null || expected === '') {
    throw new Error(
      'REFUSED: bulk list deletion requires action_payload.expected_record_count — ' +
      'restate how many records you intend to delete',
    );
  }
  if (!Number.isInteger(Number(expected)) || Number(expected) < 0) {
    throw new Error(`REFUSED: expected_record_count must be a non-negative integer (got ${JSON.stringify(expected)})`);
  }
  if (Number(expected) !== Number(actual)) {
    throw new Error(
      `REFUSED: expected_record_count ${expected} !== ${actual} records in payload — ` +
      'a miscounted bulk delete is unrecoverable',
    );
  }
  return Number(actual);
}

/* Guardrail 6 — RETIRED 2026-08-21, number not reused.
 *
 * It required a per-number written reason on every DNC removal. The op it
 * guarded (five9_remove_numbers_from_dnc) has been deleted outright rather
 * than tightened, so validateDncRemovals went with it — see the block above
 * executeAddNumbersToDnc. The number is left vacant so that Guardrail 6 in
 * any older audit event, commit message, or handoff still resolves to the
 * thing it actually meant.
 */

/* ---------------------------------------------------------------------- *
 * confirm_token double-gate — the highest-risk writes must restate their
 * target verbatim in the payload. Six ops as of 2026-08-21; the branches
 * below are the authority on which. Pure, exported for tests.
 * ---------------------------------------------------------------------- */

export function requiredConfirmToken(op, payload) {
  if (op === 'set_outbound_campaign') {
    return String(payload?.campaign_name || '').trim();
  }
  // 2026-08-21 — resetCampaign clears dispositions and list positions for an
  // ENTIRE campaign: every record in it becomes re-dialable at once. On
  // `Previous Customer` or `Data Leads` that is a mass re-dial event with TCPA
  // exposure and a support-queue spike behind it, and nothing about the
  // approval prompt made that visible — reset reads like the mildest of the
  // three lifecycle ops next to start and stop. Restating the campaign name
  // is what makes the blast radius legible to the approver.
  if (op === 'reset_campaign') {
    return String(payload?.campaign_name || '').trim();
  }
  // 2026-08-05 Phase D — a campaign profile is shared. `Data Leads` alone
  // serves five campaigns, so one typo here is a five-campaign blast radius.
  // Restating the profile name is the typo gate; approve_action stays the
  // human gate. (Live as of Phase D-2, 2026-08-06.)
  if (op === 'modify_campaign_profile') {
    return String(payload?.profile_name || '').trim();
  }
  // 2026-08-12 Phase F — bulk deletion outranks every write above it. One
  // approved action can remove thousands of records with no lossless undo,
  // so the creator restates the list name verbatim. approve_action remains
  // the human gate; this is the typo gate.
  if (op === 'async_delete_records_from_list') {
    return String(payload?.list_name || '').trim();
  }
  // 2026-08-13 Phase G — an IVR script is the routing itself. Rewriting one
  // that a RUNNING inbound campaign answers on changes what every caller
  // hears, with no staging step between save and live.
  if (op === 'modify_ivr_script') {
    return String(payload?.name || '').trim();
  }
  // 2026-08-13 Phase G — removing a DNIS dead-ends a live marketing number:
  // calls to it stop reaching the campaign the moment this lands, and the
  // number looks fine from the outside. Restate the campaign.
  if (op === 'remove_dnis_from_campaign') {
    return String(payload?.campaign_name || '').trim();
  }
  // 2026-08-21 Phase H — a user profile is shared by construction: "Level 1
  // Setter Profile" carries five agents at once, so a mistake lands on all of
  // them simultaneously. modify additionally re-checks the token against the
  // LIVE profile name inside the executor, which is what makes it a check on
  // the target rather than on the payload's own spelling.
  if (op === 'create_user_profile' || op === 'modify_user_profile') {
    return String(payload?.profile_name || '').trim();
  }
  // 2026-08-21 Phase H PR4 — a web connector posts live call and contact data
  // from the agent desktop. Guardrail 13 constrains WHERE it can post; the
  // token is the typo gate on WHICH connector is being rewritten, and modify
  // additionally re-checks it against Five9's own spelling of the live name.
  if (op === 'create_web_connector' || op === 'modify_web_connector') {
    return String(payload?.connector_name || '').trim();
  }
  // 2026-08-21 Phase H PR4 — campaign composition. Each of these changes what
  // a campaign dials, who it routes to, or how it paces, and every one of them
  // lands on a named campaign whose blast radius is the whole floor working
  // it. Restating the campaign is what makes that legible to the approver.
  // create_list is deliberately absent: a new list is empty and attached to
  // nothing, so there is no target to confirm.
  if (CAMPAIGN_TOKEN_OPS.has(op)) {
    return String(payload?.campaign_name || '').trim();
  }
  return null; // op not double-gated
}

/**
 * Ops whose confirm_token is the campaign name. A Set rather than a chain of
 * `if`s because this group grows per tranche and the group IS the rule.
 *
 * reset_list_position is in here on the CAMPAIGN name, not a list name. The
 * Phase H PR4 handoff specified "confirm_token on the LIST name", but the v13
 * schema is unambiguous — resetListPosition takes exactly one argument,
 * <campaignName> — so the op is campaign-scoped and a list-name token would
 * confirm a target the call never receives. Schema wins (standing rule).
 */
export const CAMPAIGN_TOKEN_OPS = Object.freeze(new Set([
  'create_outbound_campaign',
  'add_lists_to_campaign',
  'remove_lists_from_campaign',
  'modify_campaign_lists',
  'add_skills_to_campaign',
  'remove_skills_from_campaign',
  'add_dispositions_to_campaign',
  'remove_dispositions_from_campaign',
  'reset_campaign_dispositions',
  'set_campaign_strategies',
  'reset_list_position',
]));

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
  return null; // reset's precondition is a REFUSAL, not a no-op — see below
}

/* ---------------------------------------------------------------------- *
 * Guardrail 11 (2026-08-21) — resetCampaign refuses a RUNNING campaign.
 *
 * Distinct from decideLifecycleNoop on purpose. Those two preconditions
 * describe transitions that are already satisfied, so skipping is the honest
 * answer. This one is the opposite: resetting a live campaign is a state the
 * caller must not be in, so it throws rather than returning { skipped }. A
 * silent skip here would read as "nothing needed doing" when what actually
 * happened is that a dangerous request was declined.
 *
 * Reset while RUNNING re-arms every record underneath an actively dialing
 * campaign — agents start getting the re-dials mid-shift, with no pause in
 * between to notice. Stop first, reset, then start: three approved actions,
 * each individually visible, instead of one that quietly does all three.
 *
 * Pure and exported for offline tests.
 * ---------------------------------------------------------------------- */

export function checkResetCampaignState(campaignName, state) {
  if (String(state || '').toUpperCase() === 'RUNNING') {
    throw new Error(`REFUSED: reset_campaign on a RUNNING campaign — ${campaignName} is dialing now, and resetting it makes every record in it immediately re-dialable underneath the agents on it. Stop the campaign, reset it, then start it again as separate approved actions.`);
  }
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

/* ---------------------------------------------------------------------- *
 * PR3 (2026-08-21) — buildFromSchema: one serializer, read from the WSDL.
 *
 * Every builder above this line is a hand transcription of an xs:sequence.
 * That is roughly a day of WSDL archaeology per operation, and the failure
 * mode is silent: a transcription slip does not fail locally, it ships and
 * comes back as a Five9 500 three retries deep. wsdl-schema.json (PR1) made
 * the sequence machine-readable, so the transcription step can go away.
 *
 * WHAT IT ENFORCES, and why each one is a throw rather than a warning:
 *   - element order            — JAXB rejects out-of-order elements outright.
 *   - minOccurs=1 present      — the server's error for a missing required
 *                                element names the TYPE, not the field.
 *   - no unknown payload keys  — this is the typo gate. Five9 ignores an
 *                                element it does not recognise, so a
 *                                misspelled field is not an error there: the
 *                                write "succeeds" having silently set
 *                                nothing. Catching it here is the only place
 *                                it is catchable.
 *
 * TYPE DISPATCH IS SCHEMA-DRIVEN, NOT A HARD-CODED FIELD LIST. The three
 * cases the hand-written builders special-case by name are all visible in
 * the artifact as the field's `type`:
 *   tns:timer                 → secondsToTimerXml  (see the asymmetry note
 *                               on that function: Five9 ACCEPTS an integer of
 *                               seconds and RETURNS a struct, so recursing
 *                               into {days,hours,minutes,seconds} would emit
 *                               what the read side produces, not what the
 *                               write side takes)
 *   any other tns: complexType → recurse, wrapped in the field's own element.
 *                               This is what covers callWrapup,
 *                               defaultIvrSchedule, and the campaignDialingAction
 *                               pair — actionOnQueueExpiration with
 *                               { actionType } emits exactly what
 *                               actionFieldXml emits, because actionArgument
 *                               and maxWaitTime are absent and therefore
 *                               omitted.
 *   anything else              → scalar. xs: builtins and tns: SIMPLE types
 *                               (the enums: dialingMode, mediaType, …) both
 *                               land here, which is correct — a simpleType is
 *                               a restricted scalar, not a nested element.
 *
 * WHERE IT DOES NOT GO. If a type needs a serializer this generic path
 * cannot express, the registry entry names a custom builder instead of
 * bending buildFromSchema to fit. Two live examples: actionFieldXml also
 * accepts a bare string (buildFromSchema requires the object form, since a
 * string is not a tns:campaignDialingAction), and the list-record bodies
 * emit a positional <fieldsMapping>/<fields> pairing that is not an
 * xs:sequence walk at all.
 *
 * MISSPELLINGS SURVIVE BY CONSTRUCTION. dispostionName, userProfileNamePatern,
 * intlligentRouting and maxAlowed are Five9's, not ours; reading names from
 * the artifact reproduces them without anyone having to remember. Asserted in
 * scripts/test-five9-op-registry.js rather than left to chance.
 * ---------------------------------------------------------------------- */

const SCHEMA_URL = new URL('./wsdl-schema.json', import.meta.url);
let _wsdlSchema = null;

/** The PR1 artifact, parsed once. */
export function wsdlSchema() {
  if (!_wsdlSchema) _wsdlSchema = JSON.parse(readFileSync(SCHEMA_URL, 'utf8'));
  return _wsdlSchema;
}

/**
 * A complexType's fields, inheritance-flattened, base sequence first —
 * the order JAXB unmarshals in, and the order the hand-written
 * *_FIELD_ORDER arrays were transcribed into by hand.
 */
export function flattenType(typeName, schema = wsdlSchema(), seen = new Set()) {
  const t = schema.complexTypes[typeName];
  if (!t) throw new Error(`buildFromSchema: complexType "${typeName}" is not in wsdl-schema.json`);
  if (seen.has(typeName)) throw new Error(`buildFromSchema: inheritance cycle at ${typeName}`);
  seen.add(typeName);
  const inherited = t.extends ? flattenType(t.extends, schema, seen) : [];
  return inherited.concat(t.fields);
}

function serializeOne(field, value, schema, path) {
  if (field.type === 'timer') return secondsToTimerXml(field.name, value);

  if (schema.complexTypes[field.type]) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(
        `buildFromSchema(${path}): "${field.name}" is tns:${field.type}, a complex type — ` +
        `expected an object, got ${Array.isArray(value) ? 'an array' : typeof value}`
      );
    }
    return buildFromSchema(field.type, value, { wrapper: field.name, path });
  }

  return `<${field.name}>${escapeXml(value)}</${field.name}>`;
}

function serializeField(field, value, schema, path) {
  if (field.maxOccurs === 'unbounded') {
    const items = Array.isArray(value) ? value : [value];
    if (!items.length) {
      throw new Error(`buildFromSchema(${path}): "${field.name}" is repeatable but the array is empty`);
    }
    return items.map((v) => serializeOne(field, v, schema, path)).join('');
  }
  if (Array.isArray(value)) {
    throw new Error(
      `buildFromSchema(${path}): "${field.name}" is not repeatable ` +
      `(maxOccurs=${field.maxOccurs ?? 1}) — got an array`
    );
  }
  return serializeOne(field, value, schema, path);
}

/**
 * Serialize `payload` as tns:<typeName>, in WSDL xs:sequence order.
 *
 * @param {string} typeName  a complexType name in wsdl-schema.json
 * @param {object} payload   field name → value; absent optional fields omitted
 * @param {object} [opts]
 * @param {string|null} [opts.wrapper]  element to wrap the body in (the
 *        operation's childElement — e.g. `campaignProfile` for
 *        createCampaignProfile). Omit for a bare body.
 * @returns {string} XML
 */
export function buildFromSchema(typeName, payload, { wrapper = null, path = typeName } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`buildFromSchema(${path}): payload must be an object`);
  }
  const schema = wsdlSchema();
  const fields = flattenType(typeName, schema);
  const known = new Set(fields.map((f) => f.name));

  // The typo gate. Five9 silently ignores an element it does not know, so an
  // unknown key here is a write that reports success and sets nothing.
  for (const key of Object.keys(payload)) {
    if (!known.has(key)) {
      throw new Error(
        `buildFromSchema(${path}): "${key}" is not a field of tns:${typeName} ` +
        `(schema fields: ${[...known].join(', ')})`
      );
    }
  }

  let xml = '';
  for (const field of fields) {
    const v = payload[field.name];
    if (v === undefined || v === null) {
      if (field.minOccurs >= 1) {
        throw new Error(
          `buildFromSchema(${path}): required field "${field.name}" ` +
          `(minOccurs=${field.minOccurs}) is missing`
        );
      }
      continue;
    }
    xml += serializeField(field, v, schema, `${path}.${field.name}`);
  }

  return wrapper ? `<${wrapper}>${xml}</${wrapper}>` : xml;
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
export const CALL_NOW_MODES = new Set(['NONE', 'NEW_CRM_ONLY', 'NEW_LIST_ONLY', 'ANY']);

export function buildAddRecordToListXml(listName, fieldNames, values, callNowMode = null) {
  const list = String(listName || '').trim();
  if (!list) throw new Error('list_name is required');
  if (!Array.isArray(fieldNames) || !Array.isArray(values) || fieldNames.length !== values.length || !fieldNames.length) {
    throw new Error(`fieldsMapping/values mismatch: ${fieldNames?.length ?? 0} fields vs ${values?.length ?? 0} values`);
  }
  if (callNowMode != null && !CALL_NOW_MODES.has(callNowMode)) {
    throw new Error(`invalid call_now_mode "${callNowMode}" (allowed: ${[...CALL_NOW_MODES].join(', ')})`);
  }
  // callNowMode is what makes a pushed record DIAL rather than wait for the
  // next list pass — verified against the live v13 WSDL 2026-09-04, where
  // listUpdateSettings extends basicImportSettings and the extension sequence
  // opens callNowColumnNumber, callNowMode, callTime, callTimeColumnNumber,
  // cleanListBeforeUpdate, ... So it belongs AFTER skipHeaderLine (the last
  // base element) and BEFORE cleanListBeforeUpdate. JAXB rejects out-of-order
  // elements, so this position is not cosmetic.
  //
  // Omitted by default: every pre-existing caller of this builder appends
  // without dialing, and that behaviour must not change underneath them.
  // Only the callback re-queue passes a mode.
  //
  // (For the record: callAsap, which reads like the obvious field, exists only
  // on listUpdateSimpleSettings — the settings type for addRecordToListSimple,
  // which this repo does not build. callNowMode is this op's equivalent, so no
  // new op was needed. op-registry.js:168 called addRecordToListSimple
  // "redundant with addRecordToList"; that is corrected there.)
  const callNowXml = callNowMode ? `<callNowMode>${callNowMode}</callNowMode>` : '';
  return (
    `<listName>${escapeXml(list)}</listName>` +
    `<listUpdateSettings>${fieldsMappingXml(fieldNames)}` +
    `<skipHeaderLine>false</skipHeaderLine>` +
    callNowXml +
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
 * Phase F builders (2026-08-12) — BULK async list deletion.
 *
 * FIELD ORDER BELOW IS WSDL-DERIVED, quoted from the live v13 schema on
 * 2026-08-12 (api.five9.com/wsadmin/v13/AdminWebService?wsdl), fetched with
 * the DOTALL-regex method in the Phase D FETCH NOTE below. Read-response
 * order was NOT used to derive it.
 *
 * Every type behind this op is quoted verbatim in
 * docs/five9/phase-f-wsdl-v13.md — including the two ops this one pairs with
 * (isImportRunning / getListImportResult) and the rollback path. Read that
 * before changing anything here.
 *
 *   <xs:complexType name="asyncDeleteRecordsFromList"><xs:sequence>
 *     <xs:element minOccurs="0" name="listName" type="xs:string"/>
 *     <xs:element minOccurs="0" name="listDeleteSettings" type="tns:listDeleteSettings"/>
 *     <xs:element minOccurs="0" name="importData" type="tns:importData"/>
 *
 * THE RECORD PAYLOAD IS <importData>/<values>/<item>, NOT <record>/<fields>.
 * This is the one place the sync and async delete ops genuinely diverge, and
 * getting it backwards is an unmarshalling fault, so read the two side by
 * side before "fixing" it:
 *
 *   sync  deleteRecordFromList      → record      : tns:recordData
 *         recordData                → repeated <fields>       (xs:string)
 *   async asyncDeleteRecordsFromList→ importData  : tns:importData
 *         importData                → repeated <values>       (ns1:stringArray)
 *         stringArray               → repeated <item>         (xs:string)
 *
 * So the file header's "<fields> not <values>" rule is a statement about
 * tns:recordData — true for the SYNC ops it was written for, and not
 * transferable here. The async <values> is also NOT list-dispatch's <values>
 * (that one matches the report-row type); it is ns1:stringArray, one <values>
 * per record and one <item> per column. The governing rule is unchanged and
 * settles it: new code follows the WSDL.
 *
 * The first two children are byte-identical to the sync op, so
 * fieldsMappingXml and the listDeleteSettings block are reused as-is rather
 * than re-derived.
 * ---------------------------------------------------------------------- */

/**
 * WSDL xs:sequence for the asyncDeleteRecordsFromList request wrapper.
 * NOTE: presence in this array does NOT imply patchable — it records the
 * order JAXB unmarshals in, nothing about what callers may set.
 */
export const ASYNC_DELETE_FIELD_ORDER = ['listName', 'listDeleteSettings', 'importData'];

/**
 * WSDL xs:sequence for tns:listUpdateSettings, in INHERITANCE order.
 *
 * Added 2026-09-04 alongside callNowMode. Until then this type had no
 * field-order constant and buildAddRecordToListXml's ordering was verified by
 * eye alone — which is exactly the hand-transcription risk the sibling arrays
 * exist to remove, and it is why the callNowMode slot needed the live WSDL to
 * settle. The extension sequence opens with the four callNow and callTime
 * elements, so anything dial-related sits BETWEEN skipHeaderLine and
 * cleanListBeforeUpdate. scripts/test-five9-wsdl-schema.js now diffs this
 * against the artifact, so a future insertion in the wrong slot fails the
 * suite instead of reaching Five9 as an unmarshalling fault.
 * NOTE: presence in this array does NOT imply patchable.
 */
export const LIST_UPDATE_SETTINGS_FIELD_ORDER = [
  // --- tns:basicImportSettings (base) ---
  'allowDataCleanup',
  'callbackAuthProfileName',
  'callbackFormat',
  'callbackUrl',
  'countryCode',
  'failOnFieldParseError',
  'fieldsMapping',
  'reportEmail',
  'separator',
  'skipHeaderLine', // schema-REQUIRED (no minOccurs=0)
  // --- tns:listUpdateSettings (extension) ---
  'callNowColumnNumber',
  'callNowMode',
  'callTime',
  'callTimeColumnNumber',
  'cleanListBeforeUpdate', // schema-REQUIRED (no minOccurs=0)
  'crmAddMode',
  'crmUpdateMode',
  'listAddMode',
];

/**
 * WSDL xs:sequence for tns:listDeleteSettings, in INHERITANCE order: JAXB
 * unmarshals the basicImportSettings base fields BEFORE the extension's
 * listDeleteMode, and an out-of-order element is an unmarshalling fault.
 * We emit only fieldsMapping / skipHeaderLine / listDeleteMode, but they must
 * sit in these relative slots.
 * NOTE: presence in this array does NOT imply patchable.
 */
export const LIST_DELETE_SETTINGS_FIELD_ORDER = [
  // --- tns:basicImportSettings (base) ---
  'allowDataCleanup',
  'callbackAuthProfileName',
  'callbackFormat',
  'callbackUrl',
  'countryCode',
  'failOnFieldParseError',
  'fieldsMapping',
  'reportEmail',
  'separator',
  'skipHeaderLine', // schema-REQUIRED (no minOccurs=0)
  // --- tns:listDeleteSettings (extension) ---
  'listDeleteMode',
];

/**
 * WSDL xs:sequence for the asyncAddRecordsToList request wrapper — carried
 * for the ROLLBACK path only. Nothing in this module executes it.
 * NOTE: presence in this array does NOT imply patchable.
 */
export const ASYNC_ADD_FIELD_ORDER = [
  'listName',
  'listUpdateSettings',
  'importData',
  'resetDispositionsInCampaignsImportData',
];

// tns:importData is repeated <values>, each an ns1:stringArray of <item>.
// One <values> per record, one <item> per column. Nulls serialize as empty
// <item></item>, same convention as recordXml's empty <fields>.
function importDataXml(records) {
  return `<importData>${records.map(row =>
    `<values>${row.map(v => `<item>${escapeXml(v ?? '')}</item>`).join('')}</values>`
  ).join('')}</importData>`;
}

// Shared shape validation for the two async list bodies.
function assertImportRecords(fieldNames, records) {
  if (!Array.isArray(fieldNames) || !fieldNames.length) {
    throw new Error(`fieldsMapping/values mismatch: ${fieldNames?.length ?? 0} fields vs records`);
  }
  if (!Array.isArray(records) || !records.length) {
    throw new Error('records is required: [[values...], ...]');
  }
  records.forEach((row, i) => {
    if (!Array.isArray(row) || row.length !== fieldNames.length) {
      throw new Error(
        `fieldsMapping/values mismatch at record ${i}: ${fieldNames.length} fields vs ${Array.isArray(row) ? row.length : 0} values`,
      );
    }
  });
}

export function buildAsyncDeleteRecordsFromListXml(listName, fieldNames, records, listDeleteMode = 'DELETE_ALL') {
  const list = String(listName || '').trim();
  if (!list) throw new Error('list_name is required');
  assertImportRecords(fieldNames, records);
  if (!LIST_DELETE_MODES.has(listDeleteMode)) {
    throw new Error(`invalid list_delete_mode "${listDeleteMode}" (allowed: ${[...LIST_DELETE_MODES].join(', ')})`);
  }
  return (
    `<listName>${escapeXml(list)}</listName>` +
    `<listDeleteSettings>${fieldsMappingXml(fieldNames)}` +
    `<skipHeaderLine>false</skipHeaderLine>` +
    `<listDeleteMode>${listDeleteMode}</listDeleteMode>` +
    `</listDeleteSettings>` +
    importDataXml(records)
  );
}

/**
 * asyncAddRecordsToList body — built for the ROLLBACK payload only, never
 * executed here. Deliberately NOT registered as an action type: re-adding
 * keys is an operator decision made with a list export in hand, not an
 * automated undo. See the rollback note on executeAsyncDeleteRecordsFromList.
 *
 * Settings block mirrors buildAddRecordToListXml (listUpdateSettings extends
 * the same basicImportSettings base, so fieldsMapping/skipHeaderLine keep
 * their slots and the extension fields follow in xs:sequence order).
 */
export function buildAsyncAddRecordsToListXml(listName, fieldNames, records) {
  const list = String(listName || '').trim();
  if (!list) throw new Error('list_name is required');
  assertImportRecords(fieldNames, records);
  return (
    `<listName>${escapeXml(list)}</listName>` +
    `<listUpdateSettings>${fieldsMappingXml(fieldNames)}` +
    `<skipHeaderLine>false</skipHeaderLine>` +
    `<cleanListBeforeUpdate>false</cleanListBeforeUpdate>` +
    `<crmAddMode>ADD_NEW</crmAddMode>` +
    `<crmUpdateMode>UPDATE_FIRST</crmUpdateMode>` +
    `<listAddMode>ADD_FIRST</listAddMode>` +
    `</listUpdateSettings>` +
    importDataXml(records)
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

export const USER_SKILL_FIELD_ORDER = ['id', 'level', 'skillName', 'userName'];

// `dialingSchedule` is a nested complex type and is deliberately NOT patchable
// in v1 — only scalars are emitted. It stays in the order array so the
// sequence stays a faithful copy of the WSDL.
//
// PR3 (2026-08-21): this array is NO LONGER AN INPUT TO ANY BUILDER.
// buildCampaignProfileXml now reads the sequence from wsdl-schema.json via
// buildFromSchema, so it cannot drift from the WSDL by construction. The array
// survives as the FROZEN EXPECTATION that pins the sequence: the retro-
// validation in test-five9-wsdl-schema.js diffs it against the artifact, which
// is what would catch a schema REGENERATION silently reordering or dropping a
// field. Deleting it would delete that tripwire, not dead weight.
export const CAMPAIGN_PROFILE_FIELD_ORDER = [
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
  // PR3 (2026-08-21) — first op migrated onto buildFromSchema. The guards
  // above are unchanged and stay here: PROFILE_PATCHABLE_FIELDS is a
  // PERMISSION list, deliberately narrower than the schema, and buildFromSchema
  // only knows what the schema permits. It runs second, so a non-patchable but
  // schema-valid key (`name`, `dialingSchedule`) still refuses with the same
  // REFUSED message it always did.
  //
  // Proven byte-identical to the hand-written xs:sequence loop it replaces
  // across every single-field patch, every field pair, both key orders of the
  // full patch, and all four rejection paths — see
  // scripts/test-five9-op-registry.js ("byte-identical migration").
  return buildFromSchema('campaignProfileInfo', { name, ...patch }, { wrapper: 'campaignProfile' });
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

/**
 * idempotencySuffix (2026-08-12 Phase F): the audit event's idempotency_key is
 * per-action, and emitEvent SKIPS SILENTLY on a duplicate key. That is correct
 * for every op that executes in one pass, but an op that defers and re-enters
 * (async_delete_records_from_list) would emit its submission event, then have
 * every later event — including the COMPLETION event carrying new_state,
 * listRecordsDeleted and verified — silently dropped as a duplicate. The
 * evidence the write actually landed is exactly what we'd lose.
 *
 * Passing a per-pass suffix keeps each pass independently auditable. Omitted
 * (every pre-Phase-F op) the key is byte-identical to before.
 */
async function withFive9WriteGate({ action, subtype, entityType, entityId, idempotencySuffix }, fn) {
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
    idempotency_key: action.id
      ? `five9_write_${action.id}_${subtype}${idempotencySuffix ? `_${idempotencySuffix}` : ''}`
      : null,
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
    // Token-checked INSIDE the gate, like every other double-gated op bar
    // one: a refusal here still emits a five9.admin_write event with
    // success:false, so a fumbled reset attempt on a live campaign leaves a
    // record instead of vanishing. No-op for start/stop — requiredConfirmToken
    // returns null for both.
    checkConfirmToken(subtype, payload);
    const { campaigns } = await getCampaigns();
    const hit = campaigns.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (!hit) throw new Error(`campaign_not_found: ${name}`);
    ctx.previous_state = hit;
    refuseIfInbound(hit);
    // Guardrail 11 — read the LIVE state before resetting. getCampaigns
    // already carries it, so this costs no extra SOAP call.
    if (subtype === 'reset_campaign') checkResetCampaignState(hit.name, hit.state);
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
 * reported verified:false.
 *
 * All three TIMER_FIELDS now verify. maxQueueTime resolves through the
 * reader's already-converted maxQueueTimeSeconds; CRMRedialTimeout and
 * maxPreviewTime resolve through raw and normalize here. maxPreviewTime was
 * previously hardcoded to undefined and skipped — see the comment at the
 * resolution site for why that was wrong.
 */
export function verifyPatchReadBack(patch, after) {
  const mismatches = [];
  for (const [field, expected] of Object.entries(patch || {})) {
    // maxQueueTime is the one field the reader renames: it is surfaced already
    // converted, as maxQueueTimeSeconds. Everything else is read under its own
    // name, falling back to the raw SOAP config.
    //
    // maxPreviewTime USED to be hardcoded to undefined here, annotated "not
    // surfaced in normalized read". That was false: raw.maxPreviewTime is
    // present on every outbound campaign (2026-08-06 — {days:0,hours:0,
    // minutes:0,seconds:20} on DIAL ASAP and After DIAL ASAP alike). The skip
    // silently reported verified:true for a field nothing had looked at, which
    // is the same lie as a permanent verified:false, just quieter. Removed —
    // it now resolves through raw and normalizes in the timer branch below.
    const actual = field === 'maxQueueTime'
      ? after?.maxQueueTimeSeconds
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
  // Optional, and validated by the builder. Absent = a plain append, which is
  // what every caller before the 2026-09-04 callback push wanted.
  const callNowMode = payload.call_now_mode ?? null;
  return withFive9WriteGate({ action, subtype: 'add_records_to_list', entityType: 'five9_list', entityId: listName }, async (ctx) => {
    const sizeOf = async () => (await getListsInfo()).lists.find(l => l.name === listName) ?? { name: listName, size: null };
    ctx.previous_state = await sizeOf();
    let added = 0;
    for (const values of records) {
      const xml = await ctx.soap('addRecordToList', buildAddRecordToListXml(listName, fieldNames, values, callNowMode));
      if (xml !== null) assertNoRecordFailures('addRecordToList', xml);
      added += 1;
    }
    if (!ctx.dry_run) ctx.new_state = await sizeOf();
    return {
      list: listName,
      records_added: ctx.dry_run ? 0 : added,
      records_previewed: ctx.dry_run ? added : undefined,
      call_now_mode: callNowMode,
    };
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

/* ---------------------------------------------------------------------- *
 * Phase F execute (2026-08-12) — BULK async list deletion.
 *
 * WHY THIS EXISTS: five9_delete_record_from_list removes ONE record per
 * approval-gated action. Purging the ~3,850 records mis-loaded into
 * `Sale - Completed 0-2yrs` on 2026-08-07/08 that way is hundreds of
 * approvals. This is the bulk path, with guardrails sized to the fact that
 * it is the highest-blast-radius write in this file.
 *
 * THE ASYNC WRINKLE: asyncDeleteRecordsFromList returns a JOB HANDLE, not a
 * result. The fleet-wide write lock (five9_admin:write) must NOT be held for
 * the life of the job, so this op submits under the lock, polls briefly,
 * then RELEASES and defers — returning { deferred: true, retry_at } so the
 * executor re-enters and resumes polling. Same contract the gate already
 * uses for lock contention (see decideLockHeldReschedule above) and that
 * result-status.js maps to status:'pending' with retry_count untouched.
 *
 * The in-action poll budget is deliberately ~22s, NOT the ~55s used by
 * runReportAndWait: the executor's handler watchdog is 60s
 * (HANDLER_TIMEOUT_MS, src/actions/index.js), and a 55s poll leaves no room
 * for the submit plus two getListsInfo reads before the watchdog kills the
 * handler as a zombie. Re-entry makes a long single poll unnecessary anyway.
 *
 * RE-ENTRY SAFETY — the one thing that must never break: on resume the job
 * id is read from action.execution_result and the SOAP submit is SKIPPED. A
 * re-submit would be a second bulk delete. The executor writes
 * execution_result on every pass and claimActions re-selects it with
 * select('*'), so the handle survives the deferral.
 * ---------------------------------------------------------------------- */

// Server-side long-poll per isImportRunning call, and the total in-action
// budget. Both well inside the 60s handler watchdog.
const IMPORT_POLL_WAIT_SEC = 5;
const IMPORT_POLL_BUDGET_MS = 22_000;

/**
 * When a job is still running at the end of a pass, how long before the
 * executor should re-enter. Pure + exported for tests, same shape and spirit
 * as decideLockHeldReschedule.
 *
 * `attempt` is carried on execution_result, NOT action.retry_count — a
 * deferral deliberately leaves retry_count untouched, so the retry budget is
 * never burned by a slow-but-healthy Five9 job. The attempts ceiling is what
 * stops a wedged job deferring forever.
 */
export function decideImportPollReschedule(attempt, now = Date.now(), {
  maxAttempts = 40, baseMs = 15_000, maxMs = 120_000,
} = {}) {
  const n = Math.max(0, parseInt(attempt, 10) || 0);
  if (n >= maxAttempts) {
    return { reschedule: false, attempt: n, reason: 'five9_import_poll_attempts_exhausted' };
  }
  const delayMs = Math.min(maxMs, baseMs * Math.pow(2, Math.min(n, 3)));
  return {
    reschedule: true,
    attempt: n + 1,
    delayMs,
    retryAt: new Date(now + delayMs).toISOString(),
    reason: 'five9_import_running',
  };
}

/**
 * ROLLBACK IS KEYS-ONLY. Read this before trusting rollback_payload.
 *
 * The descriptor below re-adds the SAME DIAL KEYS via asyncAddRecordsToList.
 * That restores what the dialer needs to call the number again — and NOTHING
 * ELSE. Every non-key column Five9 held on those records (dispositions, call
 * history, attempt counters, agent notes, custom fields not in field_names)
 * is gone the moment the delete lands and is NOT recoverable from this
 * payload. A true restore requires a list export taken BEFORE the delete.
 *
 * The presence of a rollback_payload on the audit event must not be read as
 * "this was a reversible operation." It was not.
 */
const ROLLBACK_CAVEAT =
  'KEYS ONLY — re-adding these records restores the dial keys but NOT the ' +
  'non-key columns Five9 held (dispositions, call history, attempt counts, ' +
  'notes, unmapped custom fields). A true restore requires a list export ' +
  'taken BEFORE the delete. Do not treat this as a lossless undo.';

/**
 * Read-back verification for a bulk delete: three numbers must agree — what
 * the payload declared, what Five9's listImportResult says it deleted, and
 * how far the list size actually moved. Returns the mismatch rows; empty
 * === verified.
 *
 * Pure and exported for the same reason verifyPatchReadBack is: this is the
 * function that decides whether `verified` is true, so it needs direct
 * coverage rather than being reachable only through a live SOAP round-trip.
 *
 * A missing number is a MISMATCH, never a skip. Treating an unreadable
 * read-back as verified is the same lie as a permanent false negative, just
 * quieter — the precedent is verifyPatchReadBack's timer branch.
 *
 * listRecordsDeleted is the authoritative signal. size_delta corroborates it
 * and is inherently noisier: these lists take a small incremental feed and
 * repopulate at 6 AM ET, so a delta measured across that boundary can differ
 * from the delete count without either number being wrong. That is exactly
 * why it is REPORTED rather than thrown on.
 */
export function verifyListDeleteCounts({ declared, deletedReported, sizeDelta } = {}) {
  const mismatches = [];
  if (deletedReported === null || deletedReported === undefined) {
    mismatches.push({ field: 'listRecordsDeleted', expected: declared, actual: null });
  } else if (Number(deletedReported) !== Number(declared)) {
    mismatches.push({ field: 'listRecordsDeleted', expected: declared, actual: deletedReported });
  }
  if (sizeDelta === null || sizeDelta === undefined) {
    mismatches.push({ field: 'size_delta', expected: declared, actual: null });
  } else if (Number(sizeDelta) !== Number(declared)) {
    mismatches.push({ field: 'size_delta', expected: declared, actual: sizeDelta });
  }
  return mismatches;
}

function buildRollbackDescriptor(listName, fieldNames, records) {
  return {
    method: 'asyncAddRecordsToList',
    list_name: listName,
    field_names: fieldNames,
    records,
    record_count: records.length,
    keys_only: true,
    caveat: ROLLBACK_CAVEAT,
    envelope: buildAsyncAddRecordsToListXml(listName, fieldNames, records),
  };
}

// <return><identifier>…</identifier></return> off asyncDeleteRecordsFromList.
function extractImportIdentifier(xml) {
  const block = returnBlocks(xml)[0];
  return block ? tag(block, 'identifier') : '';
}

export async function executeAsyncDeleteRecordsFromList(action) {
  const payload = action.action_payload || {};
  const listName = String(payload.list_name || '').trim();
  if (!listName) throw new Error('five9_async_delete_records_from_list requires action_payload.list_name');
  const fieldNames = payload.field_names;
  const records = payload.records;
  const listDeleteMode = payload.list_delete_mode || 'DELETE_ALL';

  // Build + token-check + count-reconcile BEFORE any read, and before the
  // resume branch: payload errors fire first, and a malformed payload must
  // never quietly resume a job it no longer describes.
  const bodyXml = buildAsyncDeleteRecordsFromListXml(listName, fieldNames, records, listDeleteMode);
  checkConfirmToken('async_delete_records_from_list', payload);
  const declared = assertDeclaredRecordCount(payload.expected_record_count, records.length);

  // Resume state from a prior deferred pass.
  const prior = action.execution_result || {};
  const resumeJobId = prior.five9_job_id ? String(prior.five9_job_id) : null;
  const pollAttempt = Math.max(0, parseInt(prior.poll_attempt, 10) || 0);

  const gateResult = await withFive9WriteGate(
    {
      action,
      subtype: 'async_delete_records_from_list',
      entityType: 'five9_list',
      entityId: listName,
      // Per-pass suffix so the completion event is never dropped as a
      // duplicate of the submission event.
      idempotencySuffix: resumeJobId ? `poll${pollAttempt}` : 'submit',
    },
    async (ctx) => {
      const sizeOf = async () =>
        (await getListsInfo()).lists.find(l => l.name === listName) ?? { name: listName, size: null };

      const rollback = buildRollbackDescriptor(listName, fieldNames, records);
      ctx.event_extra.rollback_payload = rollback;
      ctx.event_extra.rollback_is_keys_only = true;
      ctx.event_extra.rollback_caveat = ROLLBACK_CAVEAT;
      ctx.event_extra.expected_record_count = declared;

      // Poll this pass's budget, then either defer or read + verify the
      // result. Split out so the submitting pass can catch everything it
      // throws (see the re-submit hazard note at the call site).
      const followJob = async (jobId) => {
        const deadline = Date.now() + IMPORT_POLL_BUDGET_MS;
        let running = true;
        for (;;) {
          running = await isImportRunning(jobId, IMPORT_POLL_WAIT_SEC);
          if (!running || Date.now() >= deadline) break;
          // isImportRunning blocks server-side for waitTime, but do not rely
          // on that: if Five9 returns immediately this loop would otherwise
          // spin hot for the whole budget. Same client-side nap
          // runReportAndWait keeps for the same reason.
          const napMs = Math.min(IMPORT_POLL_WAIT_SEC * 1000, Math.max(250, deadline - Date.now()));
          await new Promise(r => setTimeout(r, napMs));
        }

        if (running) {
          const d = decideImportPollReschedule(pollAttempt, Date.now());
          if (!d.reschedule) {
            throw new Error(`Five9 asyncDeleteRecordsFromList: job ${jobId} still running after ${d.attempt} poll attempts — check the list and getListImportResult before any retry`);
          }
          return {
            deferred: true,
            retry_at: d.retryAt,
            reason: d.reason,
            five9_job_id: jobId,
            poll_attempt: d.attempt,
            list: listName,
          };
        }

        // ---------- job finished: read the result and verify ----------
        const jobResult = await getListImportResult(jobId);
        ctx.event_extra.import_result = jobResult;
        if (jobResult.found && jobResult.success === false) {
          throw new Error(`Five9 asyncDeleteRecordsFromList: job ${jobId} reported failure — ${jobResult.failureMessage || 'no failureMessage'}`);
        }
        if (Number(jobResult.uploadErrorsCount) > 0) {
          throw new Error(`Five9 asyncDeleteRecordsFromList: job ${jobId} reports ${jobResult.uploadErrorsCount} upload error(s)`);
        }

        ctx.new_state = await sizeOf();

        // A count disagreement is REPORTED (verified:false carrying all three
        // numbers), never thrown and never silently passed. See
        // verifyListDeleteCounts for the reasoning.
        const deletedReported = jobResult.listRecordsDeleted;
        const sizeDelta = (ctx.previous_state?.size != null && ctx.new_state?.size != null)
          ? ctx.previous_state.size - ctx.new_state.size
          : null;
        const verify_mismatches = verifyListDeleteCounts({ declared, deletedReported, sizeDelta });
        const verified = verify_mismatches.length === 0;
        ctx.event_extra.verified = verified;
        ctx.event_extra.verify_mismatches = verify_mismatches;
        ctx.event_extra.deleted_expected = declared;
        ctx.event_extra.deleted_reported = deletedReported;
        ctx.event_extra.size_delta = sizeDelta;

        return {
          list: listName,
          five9_job_id: jobId,
          list_delete_mode: listDeleteMode,
          deleted_expected: declared,
          deleted_reported: deletedReported,
          size_delta: sizeDelta,
          verified,
          verify_mismatches,
          rollback_payload: rollback,
          rollback_is_keys_only: true,
        };
      };

      let jobId = resumeJobId;

      if (!jobId) {
        // ---------- submission pass ----------
        ctx.previous_state = await sizeOf();

        const compliance = checkListDeleteCompliance(
          { requested: declared, listSize: ctx.previous_state.size },
          { complianceOverride: payload.compliance_override === true },
        );
        ctx.event_extra.compliance = compliance;
        if (!compliance.ok) {
          throw new Error(`REFUSED: compliance — ${compliance.violations.join('; ')} (bulk list deletion ceilings; requires explicit compliance_override: true)`);
        }

        const submitXml = await ctx.soap('asyncDeleteRecordsFromList', bodyXml);
        if (submitXml === null) {
          // Dry-run: the real envelope was built and logged, nothing was
          // submitted, and there is no job to poll.
          return {
            list: listName,
            records_previewed: declared,
            list_delete_mode: listDeleteMode,
            rollback_payload: rollback,
            rollback_is_keys_only: true,
          };
        }
        assertNoRecordFailures('asyncDeleteRecordsFromList', submitXml);
        jobId = extractImportIdentifier(submitXml);
        if (!jobId) {
          throw new Error('Five9 asyncDeleteRecordsFromList: response carried no import identifier — job state unknown, do NOT resubmit without checking the list');
        }
      } else {
        // ---------- resume pass: NEVER re-submit ----------
        ctx.previous_state = prior.previous_state ?? null;
        ctx.event_extra.resumed = true;
      }
      ctx.event_extra.five9_job_id = jobId;

      // The job now EXISTS. Until its id reaches execution_result, nothing
      // downstream may throw: the executor's catch path does not write
      // execution_result, so a throw here would leave the next attempt with
      // no job id — and it would re-submit, deleting twice. On the
      // submitting pass we therefore convert ANY downstream failure into a
      // deferral (which does persist the id); from the next pass onward the
      // id is durable and throwing is safe.
      const submittedThisPass = !resumeJobId;
      try {
        return await followJob(jobId);
      } catch (err) {
        if (!submittedThisPass) throw err;
        const d = decideImportPollReschedule(pollAttempt, Date.now());
        ctx.event_extra.deferred_after_submit_error = err.message;
        console.warn(`[FIVE9 WRITES] async_delete_records_from_list: job ${jobId} submitted but unverified (${err.message}) — deferring to persist the job id rather than risking a re-submit`);
        return {
          deferred: true,
          retry_at: d.retryAt || new Date(Date.now() + 15_000).toISOString(),
          reason: 'five9_import_unverified_after_submit',
          five9_job_id: jobId,
          poll_attempt: d.attempt,
          list: listName,
          submit_error: err.message,
        };
      }
    },
  );

  // A lock-contention deferral is produced by the gate BEFORE fn runs, so it
  // carries no job context. On a resume pass that would strip the job id from
  // execution_result and the NEXT pass would re-submit — a second bulk
  // delete. Re-attach it. (When there is no job yet, re-submitting later is
  // the correct behavior, so the id is only restored when one exists.)
  if (gateResult?.deferred === true && !gateResult.five9_job_id && resumeJobId) {
    return { ...gateResult, five9_job_id: resumeJobId, poll_attempt: pollAttempt, list: listName };
  }
  return gateResult;
}

/**
 * Add numbers to the Five9 DNC list.
 *
 * Two ways to supply the numbers:
 *   params.numbers[]               — an explicit list (unchanged, pre-2026-09)
 *   params.numbers_from_contact    — 2026-09-21: resolve every number the
 *                                    CONTACT owns (GHL primary + additional,
 *                                    LP phone + phone_alt across all of the
 *                                    prospect's leads).
 *
 * The second mode exists because a STOP revokes consent for the person, not
 * for the handset that sent it, and a rule row cannot know a contact's numbers
 * at authoring time. resolveContactDncNumbers throws on a failed read and on
 * an empty result, so a resolution problem surfaces as a retried/failed action
 * rather than a Five9 write that quietly suppressed nobody.
 */
export function executeAddNumbersToDnc(action, deps = {}) {
  const payload = action.action_payload || {};
  const fromContact = payload.numbers_from_contact === true;

  const resolveNumbers = async () => {
    if (!fromContact) {
      const explicit = (Array.isArray(payload.numbers) ? payload.numbers : [])
        .map(n => String(n ?? '').trim()).filter(Boolean);
      if (!explicit.length) {
        throw new Error('five9_add_numbers_to_dnc requires action_payload.numbers[] or numbers_from_contact:true');
      }
      return { numbers: explicit, sources: null };
    }
    const contactId = action.target_id;
    if (!contactId) throw new Error('five9_add_numbers_to_dnc numbers_from_contact requires action.target_id');
    const resolver = deps.resolveContactDncNumbers || resolveContactDncNumbers;
    return resolver(contactId, deps.eventContext || {});
  };

  return withFive9WriteGate({ action, subtype: 'add_numbers_to_dnc', entityType: 'five9_dnc', entityId: 'dnc' }, async (ctx) => {
    const { numbers, sources } = await resolveNumbers();
    if (sources) {
      ctx.resolved_from = sources;
      console.log(`[FIVE9 WRITES] add_numbers_to_dnc resolved ${numbers.length} number(s) for ${action.target_id}: ${JSON.stringify(sources)}`);
    }
    ctx.previous_state = await checkDncForNumbers(numbers);
    await ctx.soap('addNumbersToDnc', buildNumbersXml(numbers));
    if (ctx.dry_run) return { numbers_submitted: numbers.length, numbers_from_contact: fromContact, resolved_from: sources || undefined };
    ctx.new_state = await checkDncForNumbers(numbers); // read-back proves the add
    return {
      numbers_submitted: numbers.length,
      now_on_dnc: ctx.new_state.on_dnc.length,
      numbers_from_contact: fromContact,
      resolved_from: sources || undefined,
    };
  });
}

/**
 * DNC removal for ONE case, and one case only: a consumer who came back.
 *
 * 2026-09-21, Mark's ruling: when a lead re-enters through a fresh
 * first-party submission, DNC is lifted everywhere — including Five9. Until
 * now the Five9 arm could not be lifted at all (see the tombstone below), so
 * a re-entered lead was routed, worked, and then silently skipped by the
 * dialer. DNC_LIFT_ON_REENTRY_E0's own notification had to say "Five9 DNC
 * was NOT removed. If this lead should be called, dial manually."
 *
 * THIS IS NOT A GENERAL REMOVAL, AND IT MUST NOT BECOME ONE. The tombstone
 * below still stands for every other path. What makes this op safe is not a
 * gate a caller can satisfy — it is that the op is welded to one rule and
 * re-proves the consent at execution time:
 *
 *   1. action.rule_applied must be exactly DNC_LIFT_ON_REENTRY_E0. Any other
 *      caller is refused outright. There is no reason string, no override,
 *      no approver who can widen this — deliberately, because that is what
 *      the 2026-08-21 ruling removed and it should stay removed.
 *   2. The contact must STILL carry consent:new-submission when the action
 *      runs. The rule checks it at queue time; by execution the tag may have
 *      been removed (the rule removes it itself, at action priority 200) or
 *      the submission may have been retracted. Queue-time consent is not
 *      execution-time consent.
 *   3. The triggering ghl.entry_detected/reentry event must be <= 15 minutes
 *      old. A stale event means this row sat in a queue through an incident
 *      or a deploy; re-consenting someone on the strength of a submission
 *      from hours ago is exactly the kind of drift the freshness check
 *      exists to stop.
 *
 * Any of those failing is a REFUSAL, not a retry: none of them get better by
 * waiting, and a retrying DNC removal is the thing we least want in a queue.
 *
 * Note what this does NOT lift: a contact-initiated STOP. That is
 * suppress:dnc-reply, and DNC_LIFT_ON_REENTRY_E0 refuses to fire at all for
 * a contact carrying it (not_has_any_tag, added 2026-09-16). A person who
 * texted STOP is cleared by a human, deliberately.
 */
export async function executeRemoveNumbersFromDncReentry(action, deps = {}) {
  const ruleApplied = action.rule_applied || null;
  if (ruleApplied !== REENTRY_DNC_LIFT_RULE_KEY) {
    throw new Error(
      `REFUSED: five9_remove_numbers_from_dnc_reentry runs only for ${REENTRY_DNC_LIFT_RULE_KEY}, ` +
      `not "${ruleApplied || 'none'}". Five9 DNC removal has no general path — see the tombstone in src/five9/admin-writes.js.`
    );
  }
  const contactId = action.target_id;
  if (!contactId) throw new Error('five9_remove_numbers_from_dnc_reentry requires action.target_id');

  const readTags = deps.readContactTags || _readContactTagsForReentry;
  const readEvent = deps.readTriggerEvent || _readReentryEventForAction;
  const resolveNumbers = deps.resolveContactDncNumbers || resolveContactDncNumbers;
  const now = deps.now ? deps.now() : Date.now();

  return withFive9WriteGate(
    { action, subtype: 'remove_numbers_from_dnc_reentry', entityType: 'five9_dnc', entityId: 'dnc' },
    async (ctx) => {
      // ── re-prove the consent, at execution time ──
      const tags = await readTags(contactId);
      if (!Array.isArray(tags)) {
        // Unreadable is NOT absent. Fail closed: refuse rather than lift on
        // a read we could not make.
        throw new Error(`REFUSED: could not read tags for ${contactId} — refusing to lift Five9 DNC on an unverified consent`);
      }
      const hasConsent = tags.some((t) => String(t || '').toLowerCase() === REENTRY_CONSENT_TAG);
      if (!hasConsent) {
        throw new Error(`REFUSED: ${contactId} no longer carries ${REENTRY_CONSENT_TAG} — queue-time consent is not execution-time consent`);
      }

      const evt = await readEvent(action);
      if (!evt) throw new Error(`REFUSED: no ghl.entry_detected/reentry event found for action ${action.id}`);
      const ageMs = now - Date.parse(evt.created_at || '');
      if (!Number.isFinite(ageMs)) throw new Error(`REFUSED: re-entry event ${evt.id} has an unreadable created_at`);
      if (ageMs > REENTRY_MAX_EVENT_AGE_MS) {
        throw new Error(
          `REFUSED: re-entry event ${evt.id} is ${Math.round(ageMs / 60000)} min old (max ${REENTRY_MAX_EVENT_AGE_MS / 60000}) — ` +
          'this row sat in a queue; re-consenting on a stale submission is not consent'
        );
      }

      const { numbers, sources } = await resolveNumbers(contactId, {});
      ctx.previous_state = await checkDncForNumbers(numbers);
      await ctx.soap('removeNumbersFromDnc', buildNumbersXml(numbers));

      // The audit event is separate from withFive9WriteGate's own
      // five9.admin_write row on purpose: a DNC REMOVAL is the one write
      // anyone will come looking for by name, and it should not have to be
      // found by filtering a generic write log.
      const emit = deps.emitEvent || emitEvent;
      await emit({
        event_type: 'five9.dnc_removed_reentry',
        source: 'action_executor',
        entity_type: 'contact',
        entity_id: contactId,
        ghl_contact_id: contactId,
        payload: {
          contact_id: contactId,
          numbers,
          number_sources: sources,
          event_id: evt.id,
          event_age_minutes: Math.round(ageMs / 60000),
          consent_tag_seen: true,
          rule_applied: ruleApplied,
          action_id: action.id,
        },
        priority: 'high',
        bypass_filter: true,
        idempotency_key: `five9_dnc_removed_reentry_${action.id}`,
      }).catch((err) => console.warn(`[FIVE9 WRITES] re-entry audit emit failed (write already done): ${err.message}`));

      if (ctx.dry_run) return { numbers_submitted: numbers.length, event_id: evt.id, resolved_from: sources };
      ctx.new_state = await checkDncForNumbers(numbers); // read-back proves the removal
      return {
        numbers_submitted: numbers.length,
        still_on_dnc: ctx.new_state.on_dnc.length,
        event_id: evt.id,
        resolved_from: sources,
      };
    }
  );
}

// The re-entry op's three constants, named so a reader sees the whole
// contract without reading the body.
export const REENTRY_DNC_LIFT_RULE_KEY = 'DNC_LIFT_ON_REENTRY_E0';
export const REENTRY_CONSENT_TAG = 'consent:new-submission';
export const REENTRY_MAX_EVENT_AGE_MS = 15 * 60 * 1000;

async function _readContactTagsForReentry(contactId) {
  try {
    const res = await ghlFetch('GET', `/contacts/${contactId}`);
    const tags = res?.contact?.tags;
    return Array.isArray(tags) ? tags : null;
  } catch (err) {
    console.warn(`[FIVE9 WRITES] re-entry consent read failed for ${contactId}: ${err.message}`);
    return null;
  }
}

async function _readReentryEventForAction(action) {
  if (!action?.event_id) return null;
  const { data } = await supabase
    .from('system_events')
    .select('id, event_type, event_subtype, created_at')
    .eq('id', action.event_id)
    .maybeSingle();
  if (!data) return null;
  if (data.event_type !== 'ghl.entry_detected' || data.event_subtype !== 'reentry') return null;
  return data;
}

/* DNC REMOVAL IS NOT IMPLEMENTED, AND THIS IS NOT AN OVERSIGHT.
 *
 * executeRemoveNumbersFromDnc existed from Phase C (2026-07-21) until
 * 2026-08-21, gated behind a per-number written reason (the old Guardrail 6)
 * and a confirm_token restating the numbers. It never fired.
 *
 * It is gone by explicit ruling rather than tightened: Reece does not take a
 * number off DNC under any circumstance, so there is no reason string, no
 * compliance_override, and no approver who can authorize one. A gate implies
 * a legitimate path through it; there isn't one. `removeNumbersFromDnc` is
 * still a real SOAP method on the Five9 side — nothing here can reach it.
 *
 * addNumbersToDnc above is unaffected: adding to DNC is always allowed and
 * needs no justification.
 *
 * 2026-09-21 AMENDMENT. One narrow exception now exists, directly above:
 * executeRemoveNumbersFromDncReentry, for a consumer who came back with a
 * fresh first-party submission (Mark's ruling). It is welded to
 * DNC_LIFT_ON_REENTRY_E0 and re-proves the consent tag and the event's age
 * at execution time. It does NOT reopen a general path, and it does not lift
 * a contact-initiated STOP. Everything in this comment still applies to
 * every other caller: there is no reason string, no override, and no
 * approver who can remove a number outside that one rule.
 */

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

/* ---------------------------------------------------------------------- *
 * Phase G (2026-08-13) — config surface writes: IVR scripts, inbound
 * campaigns, the default IVR schedule, DNIS assignment, and TTS prompts.
 *
 * FIELD ORDER BELOW IS WSDL-DERIVED, quoted from the live v13 schema on
 * 2026-08-13 (api.five9.com/wsadmin/v13/AdminWebService?wsdl&user=x — plain
 * ?wsdl returns a 403 SOAP Fault, the &user=x suffix is what makes it
 * fetchable). Read-response order was NOT used to derive any of it. Verbatim
 * extracts: docs/five9/phase-g-wsdl-v13.md
 *
 *   <xs:complexType name="ivrScriptDef"><xs:sequence>
 *     description, name, xmlDefinition          ← name is SECOND
 *
 *   <xs:complexType name="campaignCallWrapup"><xs:sequence>
 *     agentNotReady, dispostionName, enabled, reasonCodeName, timeout
 *
 *   inboundCampaign flattened (campaign → generalCampaign → inboundCampaign):
 *     description, mode, name, profileName, state, trainingMode, type,
 *     autoRecord, callWrapup, ftpHost, ftpPassword, ftpUser,
 *     recordingNameAsSid, useFtp, defaultIvrSchedule, maxNumOfLines
 *
 * THREE THINGS HERE LOOK LIKE BUGS AND ARE NOT.
 *
 * 1. `dispostionName` is misspelled — in Five9's schema, not ours. It occurs
 *    exactly once in the whole 961KB document; the correctly spelled
 *    `dispositionName` occurs 9 times on OTHER types, which is precisely what
 *    makes this one look like our typo. Emitting the correct spelling raises
 *    no error and silently sets no wrapup disposition. Do not "fix" it.
 *
 * 2. createIVRScript takes ONLY <name>. The definition cannot ride along, so
 *    creating a working script is necessarily createIVRScript followed by
 *    modifyIVRScript — two calls, not atomic. executeCreateIvrScript owns
 *    that seam and compensates with deleteIVRScript when the second fails.
 *
 * 3. `DNISList` is capitalised, and inboundCampaign carries
 *    final="extension restriction" (so the anchored complexType regex cannot
 *    match it — see the doc's fetch note).
 *
 * deleteIVRScript is used ONLY as create-compensation. It is deliberately not
 * in FIVE9_WRITE_OPS: nothing can queue a script deletion as an action.
 * ---------------------------------------------------------------------- */

export const IVR_SCRIPT_DEF_FIELD_ORDER = ['description', 'name', 'xmlDefinition'];

export const CAMPAIGN_CALL_WRAPUP_FIELD_ORDER = [
  'agentNotReady', 'dispostionName', 'enabled', 'reasonCodeName', 'timeout',
];

export const INBOUND_CAMPAIGN_FIELD_ORDER = [
  // tns:campaign base sequence
  'description', 'mode', 'name', 'profileName', 'state', 'trainingMode', 'type',
  // tns:generalCampaign sequence
  'autoRecord', 'callWrapup', 'ftpHost', 'ftpPassword', 'ftpUser',
  'recordingNameAsSid', 'useFtp',
  // tns:inboundCampaign sequence
  'defaultIvrSchedule', 'maxNumOfLines',
];

// Presence in the order array does NOT make a field settable — same rule as
// OUTBOUND_CAMPAIGN_FIELD_ORDER. The FTP trio and `state` stay in the array
// because it is a faithful copy of the WSDL sequence; they are not settable.
//
// 2026-08-14: defaultIvrSchedule MOVED INTO this set. It was excluded on the
// reading that minOccurs="0" meant optional. It is not — see the
// RUNTIME-REQUIRED note on buildDefaultIvrScheduleXml below. A campaign
// cannot be created without it.
export const INBOUND_CAMPAIGN_SETTABLE_FIELDS = new Set([
  'description', 'mode', 'name', 'trainingMode', 'type',
  'autoRecord', 'callWrapup', 'useFtp', 'defaultIvrSchedule', 'maxNumOfLines',
]);

// tns:ivrScriptSchedule sequence. `name` and `scriptParameters` are both
// minOccurs="0" and we send neither: the live Confirmation - Inbound campaign
// carries only <scriptName> under <ivrSchedule>, so that is the shape Five9
// actually stores for a default row.
export const IVR_SCRIPT_SCHEDULE_FIELD_ORDER = ['name', 'scriptName', 'scriptParameters'];

export const WRAPUP_DEFAULT_DISPOSITION = 'No Disposition';
export const WRAPUP_DEFAULT_SECONDS = 180; // 3 min — matches house campaigns

// Same anchoring/escaping as exactUserPattern: Five9 name patterns are
// regexes on the IVR-script endpoint too, so "Canvass" must not match
// "Canvass Confirmation". Aliased rather than duplicated.
export const exactNamePattern = exactUserPattern;

/**
 * assertWellFormedXml — structural well-formedness check for an IVR script
 * definition, run BEFORE the SOAP call so a truncated or mismatched document
 * is refused here rather than half-applied there.
 *
 * This is a tag-balance scan, NOT a validating parser: it catches unclosed,
 * mismatched, and malformed tags — the realistic ways a pasted script arrives
 * broken — and does not check namespaces, entities, or the Five9 IVR schema
 * itself. Five9 remains the authority on whether the script is *valid*; this
 * only refuses input that is not even *XML*. The repo has no XML dependency
 * (see the five9-admin.js header) and this is not worth adding one for.
 */
export function assertWellFormedXml(xml, label = 'xml_definition') {
  const s = String(xml ?? '');
  if (!s.trim()) throw new Error(`REFUSED: ${label} is empty`);

  // Remove the constructs that legitimately contain angle brackets, so the
  // tag scan below cannot trip over their contents.
  const stripped = s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?[^>]*>/gi, '');

  const stack = [];
  const tagRe = /<\s*(\/?)\s*([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)\s*>/g;
  let m;
  let cursor = 0;
  while ((m = tagRe.exec(stripped)) !== null) {
    // A stray '<' between two well-formed tags is itself malformed.
    if (stripped.slice(cursor, m.index).includes('<')) {
      throw new Error(`REFUSED: ${label} is not well-formed XML — malformed tag near character ${cursor}`);
    }
    cursor = tagRe.lastIndex;
    const closing = m[1];
    const tagName = m[2];
    const selfClosing = m[4];
    if (closing) {
      const open = stack.pop();
      if (open !== tagName) {
        throw new Error(
          `REFUSED: ${label} is not well-formed XML — </${tagName}> closes ${open ? `<${open}>` : 'nothing'}`,
        );
      }
    } else if (!selfClosing) {
      stack.push(tagName);
    }
  }
  if (stripped.slice(cursor).includes('<')) {
    throw new Error(`REFUSED: ${label} is not well-formed XML — malformed tag near character ${cursor}`);
  }
  if (stack.length) {
    throw new Error(`REFUSED: ${label} is not well-formed XML — unclosed <${stack[stack.length - 1]}>`);
  }
  if (!/<[A-Za-z_]/.test(stripped)) {
    throw new Error(`REFUSED: ${label} contains no XML elements`);
  }
}

/**
 * checkDnisSteal — P1 attribution guard. Reassigning a number that already
 * belongs to another campaign silently re-routes a live marketing line: the
 * number keeps working, so nothing looks broken, and every call from that
 * source is attributed to the wrong campaign from then on. Refused unless the
 * payload carries compliance_override === true.
 *
 * A number already on the target campaign is not a conflict — that is a
 * no-op re-add, not a steal.
 */
export function checkDnisSteal(dnisList, assignments, targetCampaign, { complianceOverride = false } = {}) {
  const target = String(targetCampaign || '').toLowerCase();
  const conflicts = [];
  for (const number of dnisList) {
    const owner = assignments?.[number];
    if (owner && String(owner).toLowerCase() !== target) {
      conflicts.push({ dnis: number, current_campaign: owner });
    }
  }
  const violations = conflicts.map(c => `${c.dnis} currently routes to "${c.current_campaign}"`);
  if (violations.length && complianceOverride !== true) {
    return { ok: false, violations, conflicts };
  }
  return { ok: true, violations, conflicts, overridden: violations.length > 0 };
}

/* ---- Phase G pure builders --------------------------------------------- */

// createIVRScript and deleteIVRScript both take a bare <name>.
export function buildIvrScriptNameXml(name) {
  const n = String(name || '').trim();
  if (!n) throw new Error('script name is required');
  return `<name>${escapeXml(n)}</name>`;
}

// modifyIVRScript takes <scriptDef> holding a full ivrScriptDef.
export function buildIvrScriptDefXml(scriptName, { description, xmlDefinition } = {}) {
  const name = String(scriptName || '').trim();
  if (!name) throw new Error('script name is required');
  const merged = { description, name, xmlDefinition };
  let xml = '';
  for (const field of IVR_SCRIPT_DEF_FIELD_ORDER) {
    const v = merged[field];
    if (v === undefined || v === null) continue;
    xml += `<${field}>${escapeXml(v)}</${field}>`;
  }
  return `<scriptDef>${xml}</scriptDef>`;
}

export function buildCallWrapupXml(wrapup = {}) {
  let xml = '';
  for (const field of CAMPAIGN_CALL_WRAPUP_FIELD_ORDER) {
    const v = wrapup[field];
    if (v === undefined || v === null) continue;
    // timeout is tns:timer{days,hours,minutes,seconds}, not a scalar.
    xml += field === 'timeout'
      ? secondsToTimerXml('timeout', v)
      : `<${field}>${escapeXml(v)}</${field}>`;
  }
  return `<callWrapup>${xml}</callWrapup>`;
}

/**
 * buildDefaultIvrScheduleXml — the two-level defaultIvrSchedule wrapper.
 *
 * RUNTIME-REQUIRED, SCHEMA-OPTIONAL. The WSDL marks
 * inboundCampaign/defaultIvrSchedule minOccurs="0", and Phase G read that as
 * optional. Five9 disagrees. Verified against the live domain 2026-08-14,
 * action 316167:
 *
 *   Five9 createInboundCampaign fault:
 *     "campaign.defaultIvrSchedule" is required, but is "null"
 *
 * So an inbound campaign cannot be created without a script attached, and
 * create/attach cannot be two steps the way the Phase G ops were first shaped.
 * The schema is not the authority on requiredness here; the server is.
 *
 * Emits only <ivrSchedule><scriptName>. visualModeSettings is a sibling under
 * inboundIvrScriptSchedule and is deliberately NOT sent — the live campaigns
 * carry real values there (visualModeEnabled, callbackEnabled, xFrameOption),
 * and sending flags we did not compute would overwrite whatever the domain
 * has set. Same reasoning as setDefaultIVRSchedule not sending
 * isVisualModeEnabled / isChatEnabled.
 */
export function buildDefaultIvrScheduleXml(schedule) {
  const scriptName = String(schedule?.scriptName || '').trim();
  if (!scriptName) throw new Error('defaultIvrSchedule.scriptName is required');
  let inner = '';
  for (const field of IVR_SCRIPT_SCHEDULE_FIELD_ORDER) {
    const v = schedule[field];
    if (v === undefined || v === null) continue;
    inner += `<${field}>${escapeXml(v)}</${field}>`;
  }
  return `<defaultIvrSchedule><ivrSchedule>${inner}</ivrSchedule></defaultIvrSchedule>`;
}

export function buildInboundCampaignXml(campaign) {
  const name = String(campaign?.name || '').trim();
  if (!name) throw new Error('campaign name is required');
  for (const key of Object.keys(campaign)) {
    if (!INBOUND_CAMPAIGN_SETTABLE_FIELDS.has(key)) {
      throw new Error(`REFUSED: "${key}" is not a settable inbound campaign field (allowed: ${[...INBOUND_CAMPAIGN_SETTABLE_FIELDS].join(', ')})`);
    }
  }
  let xml = '';
  for (const field of INBOUND_CAMPAIGN_FIELD_ORDER) {
    const v = campaign[field];
    if (v === undefined || v === null) continue;
    // Two nested complex types; everything else is a scalar. Running
    // escapeXml over an object yields "[object Object]" — the Phase C defect.
    if (field === 'callWrapup') xml += buildCallWrapupXml(v);
    else if (field === 'defaultIvrSchedule') xml += buildDefaultIvrScheduleXml(v);
    else xml += `<${field}>${escapeXml(v)}</${field}>`;
  }
  return `<campaign>${xml}</campaign>`;
}

// addDNISToCampaign / removeDNISFromCampaign — note the capitalised DNISList.
export function buildCampaignDnisXml(campaignName, dnis) {
  const name = String(campaignName || '').trim();
  if (!name) throw new Error('campaign_name is required');
  const list = (Array.isArray(dnis) ? dnis : [dnis])
    .map(n => String(n ?? '').trim()).filter(Boolean);
  if (!list.length) throw new Error('dnis[] is required');
  return `<campaignName>${escapeXml(name)}</campaignName>` +
    list.map(n => `<DNISList>${escapeXml(n)}</DNISList>`).join('');
}

// setDefaultIVRSchedule — params / isVisualModeEnabled / isChatEnabled are
// all minOccurs="0" and deliberately not sent: this op exists to point a
// campaign at a script, and sending visual-mode flags we did not compute
// would overwrite whatever the domain has set.
export function buildSetDefaultIvrScheduleXml(campaignName, scriptName) {
  const campaign = String(campaignName || '').trim();
  const script = String(scriptName || '').trim();
  if (!campaign) throw new Error('campaign_name is required');
  if (!script) throw new Error('script_name is required');
  return `<campaignName>${escapeXml(campaign)}</campaignName><scriptName>${escapeXml(script)}</scriptName>`;
}

// addPromptTTS takes promptInfo + ttsInfo as two sibling elements.
//   promptInfo: description, languages[], name, type
//   ttsInfo:    language, sayAs, sayAsFormat, text, voice
export function buildPromptTtsXml({ name, description, text, language = 'en-US' } = {}) {
  const promptName = String(name || '').trim();
  if (!promptName) throw new Error('prompt name is required');
  const body = String(text ?? '');
  if (!body.trim()) throw new Error('prompt text is required');
  const lang = String(language || 'en-US').trim();

  let prompt = '';
  if (description !== undefined && description !== null) {
    prompt += `<description>${escapeXml(description)}</description>`;
  }
  prompt += `<languages>${escapeXml(lang)}</languages>`;
  prompt += `<name>${escapeXml(promptName)}</name>`;
  prompt += '<type>TTSGenerated</type>';

  // sayAs / sayAsFormat left unsent: 'Default' is the schema default and a
  // plain spoken sentence wants no say-as coercion.
  const tts = `<language>${escapeXml(lang)}</language><text>${escapeXml(body)}</text>`;

  return `<prompt>${prompt}</prompt><ttsInfo>${tts}</ttsInfo>`;
}

/* ---- Phase G read-before-write helpers ---------------------------------- */

async function readIvrScript(scriptName, { includeDefinition = false } = {}) {
  const res = await getIVRScripts({
    namePattern: exactNamePattern(scriptName),
    includeDefinition,
  });
  const scripts = res?.scripts || [];
  return scripts.find(s => String(s.name).toLowerCase() === String(scriptName).toLowerCase()) || null;
}

async function readPrompt(promptName) {
  const res = await getPrompts();
  const prompts = res?.prompts || [];
  return prompts.find(p => String(p.name).toLowerCase() === String(promptName).toLowerCase()) || null;
}

async function readCampaignByName(campaignName) {
  const { campaigns } = await getCampaigns();
  return campaigns.find(c => String(c.name).toLowerCase() === String(campaignName).toLowerCase()) || null;
}

/**
 * readIvrScriptUsage — which inbound campaigns answer on this script.
 *
 * The attached script sits at defaultIvrSchedule.ivrSchedule.scriptName —
 * TWO levels down, not defaultIvrSchedule.scriptName. Walks campaigns
 * serially, matching the house Five9 fan-out rule (see the module header:
 * concurrent admin session limits are undisclosed).
 */
async function readIvrScriptUsage(scriptName) {
  const { campaigns } = await getCampaigns({ type: 'INBOUND' });
  const target = String(scriptName).toLowerCase();
  const used_by = [];
  const unreadable = [];
  for (const campaign of campaigns) {
    try {
      const cfg = await getInboundCampaign(campaign.name);
      const attached = cfg?.raw?.defaultIvrSchedule?.ivrSchedule?.scriptName;
      if (attached && String(attached).toLowerCase() === target) {
        used_by.push({ campaign: campaign.name, state: campaign.state });
      }
    } catch (err) {
      // A campaign we cannot read is not evidence the script is unused.
      unreadable.push({ campaign: campaign.name, error: err.message });
    }
  }
  return {
    used_by,
    running: used_by.filter(c => c.state === 'RUNNING'),
    ...(unreadable.length ? { unreadable } : {}),
  };
}

/* ---- Phase G executors -------------------------------------------------- */

export function executeCreateIvrScript(action) {
  const payload = action.action_payload || {};
  const name = String(payload.name || '').trim();
  const xmlDefinition = payload.xml_definition;
  if (!name) throw new Error('five9_create_ivr_script requires action_payload.name');
  if (typeof xmlDefinition !== 'string') {
    throw new Error('five9_create_ivr_script requires action_payload.xml_definition (string)');
  }

  return withFive9WriteGate(
    { action, subtype: 'create_ivr_script', entityType: 'five9_ivr_script', entityId: name },
    async (ctx) => {
      // Validate and build before any network call — payload errors fire first.
      assertWellFormedXml(xmlDefinition, 'xml_definition');
      const defXml = buildIvrScriptDefXml(name, {
        description: payload.description,
        xmlDefinition,
      });

      const existing = await readIvrScript(name);
      if (existing) {
        return { skipped: true, reason: 'ivr_script_already_exists', script: name };
      }
      ctx.previous_state = null;

      await ctx.soap('createIVRScript', buildIvrScriptNameXml(name));
      if (ctx.dry_run) {
        return { script: name, created: false, previewed: true, steps: ['createIVRScript', 'modifyIVRScript'] };
      }

      try {
        await ctx.soap('modifyIVRScript', defXml);
      } catch (err) {
        // Step 1 landed and step 2 did not: an empty shell now holds the name
        // and would block every retry. Remove it — and report plainly whether
        // that worked, because a failed compensation left silent is worse
        // than no compensation at all.
        let compensated = false;
        let compensationError = null;
        try {
          await ctx.soap('deleteIVRScript', buildIvrScriptNameXml(name));
          compensated = true;
        } catch (deleteErr) {
          compensationError = deleteErr.message;
        }
        ctx.event_extra.compensation = { attempted: true, compensated, error: compensationError };
        throw new Error(
          `five9_create_ivr_script: the definition write failed for "${name}" (${err.message}) — ` +
          (compensated
            ? 'the empty script was deleted, so the name is free to retry'
            : `and the empty script could NOT be deleted (${compensationError}). Delete "${name}" in the Five9 UI before retrying`),
        );
      }

      const after = await readIvrScript(name);
      const verified = !!after;
      ctx.new_state = after ? { name: after.name, description: after.description } : null;
      ctx.event_extra.verified = verified;
      return {
        script: name,
        created: verified,
        verified,
        steps: ['createIVRScript', 'modifyIVRScript'],
        definition_bytes: xmlDefinition.length,
        rollback_payload: {
          method: 'deleteIVRScript',
          name,
          note: 'Not queueable as an action — delete via the Five9 UI, or park the script by renaming it.',
        },
      };
    },
  );
}

export function executeModifyIvrScript(action) {
  const payload = action.action_payload || {};
  const name = String(payload.name || '').trim();
  const xmlDefinition = payload.xml_definition;
  if (!name) throw new Error('five9_modify_ivr_script requires action_payload.name');
  if (typeof xmlDefinition !== 'string') {
    throw new Error('five9_modify_ivr_script requires action_payload.xml_definition (string)');
  }

  return withFive9WriteGate(
    { action, subtype: 'modify_ivr_script', entityType: 'five9_ivr_script', entityId: name },
    async (ctx) => {
      assertWellFormedXml(xmlDefinition, 'xml_definition');
      const defXml = buildIvrScriptDefXml(name, {
        description: payload.description,
        xmlDefinition,
      });
      checkConfirmToken('modify_ivr_script', payload);

      // Prior definition is the rollback material — read it WITH the XML.
      const before = await readIvrScript(name, { includeDefinition: true });
      if (!before) throw new Error(`ivr_script_not_found: ${name}`);
      ctx.previous_state = {
        name: before.name,
        description: before.description,
        definition_bytes: (before.xmlDefinition || '').length,
      };

      const usage = await readIvrScriptUsage(name);
      ctx.event_extra.usage = usage;
      // A script on more than one RUNNING campaign has a blast radius wider
      // than the one line the author is thinking about.
      const compliance = usage.running.length > 1 && payload.compliance_override !== true
        ? { ok: false, violations: [`script is live on ${usage.running.length} RUNNING campaigns: ${usage.running.map(c => c.campaign).join(', ')}`] }
        : { ok: true, violations: [], overridden: usage.running.length > 1 };
      ctx.event_extra.compliance = compliance;
      if (!compliance.ok) {
        throw new Error(`REFUSED: compliance — ${compliance.violations.join('; ')} (requires explicit compliance_override: true)`);
      }

      const rollback_payload = {
        method: 'modifyIVRScript',
        name,
        xml_definition: before.xmlDefinition ?? null,
        captured_at_bytes: (before.xmlDefinition || '').length,
        note: before.xmlDefinition
          ? 'Re-applying this restores the exact prior definition.'
          : 'PRIOR DEFINITION NOT CAPTURED — Five9 returned no xmlDefinition. This is not a usable rollback.',
      };
      ctx.event_extra.rollback_payload = rollback_payload;

      await ctx.soap('modifyIVRScript', defXml);
      if (ctx.dry_run) {
        return { script: name, modified: false, previewed: true, usage, rollback_payload };
      }

      const after = await readIvrScript(name, { includeDefinition: true });
      ctx.new_state = after
        ? { name: after.name, description: after.description, definition_bytes: (after.xmlDefinition || '').length }
        : null;
      const verified = (after?.xmlDefinition ?? null) === xmlDefinition;
      ctx.event_extra.verified = verified;
      return {
        script: name,
        modified: true,
        verified,
        ...(verified ? {} : { verify_mismatches: [{ field: 'xmlDefinition', expected_bytes: xmlDefinition.length, actual_bytes: (after?.xmlDefinition || '').length }] }),
        usage,
        rollback_payload,
      };
    },
  );
}

export function executeCreateInboundCampaign(action) {
  const payload = action.action_payload || {};
  const name = String(payload.name || '').trim();
  if (!name) throw new Error('five9_create_inbound_campaign requires action_payload.name');

  // Five9 rejects createInboundCampaign without a default IVR script, despite
  // the WSDL marking defaultIvrSchedule minOccurs="0" — see
  // buildDefaultIvrScheduleXml. Creating the campaign and attaching the script
  // cannot be two steps, so script_name is required here rather than deferred
  // to five9_set_default_ivr_schedule.
  const scriptName = String(payload.script_name || '').trim();
  if (!scriptName) {
    throw new Error('five9_create_inbound_campaign requires action_payload.script_name — Five9 refuses to create an inbound campaign with a null defaultIvrSchedule, so the script must be attached at creation (five9_set_default_ivr_schedule can re-point it afterwards)');
  }

  const mode = String(payload.mode || 'BASIC').toUpperCase();
  if (mode !== 'BASIC' && mode !== 'ADVANCED') {
    throw new Error(`five9_create_inbound_campaign: mode must be BASIC or ADVANCED, got ${payload.mode}`);
  }
  const maxLines = parseInt(payload.max_lines, 10);
  if (!Number.isFinite(maxLines) || maxLines < 1) {
    throw new Error(`five9_create_inbound_campaign: max_lines must be a positive integer, got ${payload.max_lines}`);
  }
  const wrapupSeconds = payload.wrapup_minutes === undefined || payload.wrapup_minutes === null
    ? WRAPUP_DEFAULT_SECONDS
    : Math.round(Number(payload.wrapup_minutes) * 60);
  if (!Number.isFinite(wrapupSeconds) || wrapupSeconds < 0) {
    throw new Error(`five9_create_inbound_campaign: wrapup_minutes must be a non-negative number, got ${payload.wrapup_minutes}`);
  }

  return withFive9WriteGate(
    { action, subtype: 'create_inbound_campaign', entityType: 'five9_campaign', entityId: name },
    async (ctx) => {
      const campaign = {
        name,
        type: 'INBOUND',
        mode,
        maxNumOfLines: maxLines,
        autoRecord: payload.auto_record === true,
        // Explicit rather than omitted: these are the two fields most likely
        // to be wrong-by-default on a hand-made campaign.
        trainingMode: false,
        useFtp: false,
        callWrapup: {
          agentNotReady: true,
          dispostionName: WRAPUP_DEFAULT_DISPOSITION, // sic — see the header
          enabled: true,
          timeout: wrapupSeconds,
        },
        defaultIvrSchedule: { scriptName },
        ...(payload.description ? { description: payload.description } : {}),
      };
      const bodyXml = buildInboundCampaignXml(campaign);

      const existing = await readCampaignByName(name);
      if (existing) {
        return { skipped: true, reason: 'campaign_already_exists', campaign: name, type: existing.type };
      }
      // A missing script is a Five9 fault three retries deep; catch it here as
      // one clear refusal instead.
      const script = await readIvrScript(scriptName);
      if (!script) throw new Error(`ivr_script_not_found: ${scriptName}`);
      ctx.previous_state = null;

      await ctx.soap('createInboundCampaign', bodyXml);
      if (ctx.dry_run) {
        return { campaign: name, created: false, previewed: true, mode, max_lines: maxLines, script: scriptName };
      }

      // createInboundCampaignResponse is empty — the read-back IS the result.
      const after = await readCampaignByName(name);
      ctx.new_state = after;
      // Read the attached script back too: it is now part of what this op
      // writes, so "created" alone would under-report a half-right campaign.
      const cfg = after ? await getInboundCampaign(name) : null;
      const attachedScript = cfg?.raw?.defaultIvrSchedule?.ivrSchedule?.scriptName ?? null;
      const scriptAttached = !!attachedScript
        && String(attachedScript).toLowerCase() === scriptName.toLowerCase();
      const verified = !!after
        && String(after.type).toUpperCase() === 'INBOUND'
        && scriptAttached;
      ctx.event_extra.verified = verified;
      return {
        campaign: name,
        created: !!after,
        verified,
        script: scriptName,
        script_attached: attachedScript,
        ...(verified ? {} : {
          verify_mismatches: [
            ...(after ? [] : [{ field: 'campaign', expected: name, actual: null }]),
            ...(scriptAttached ? [] : [{ field: 'defaultIvrSchedule.ivrSchedule.scriptName', expected: scriptName, actual: attachedScript }]),
          ],
        }),
        mode,
        max_lines: maxLines,
        auto_record: campaign.autoRecord,
        wrapup_seconds: wrapupSeconds,
        rollback_payload: {
          steps: [
            { action_type: 'five9_stop_campaign', payload: { campaign_name: name } },
            { action_type: 'five9_remove_dnis_from_campaign', payload: { campaign_name: name, dnis: [], confirm_token: name } },
          ],
          note: 'No delete op is exposed in this phase. deleteCampaign exists in the WSDL but is not implemented — stop it, strip its DNIS, and remove it via the Five9 UI.',
        },
      };
    },
  );
}

export function executeSetDefaultIvrSchedule(action) {
  const payload = action.action_payload || {};
  const campaignName = String(payload.campaign_name || '').trim();
  const scriptName = String(payload.script_name || '').trim();
  if (!campaignName) throw new Error('five9_set_default_ivr_schedule requires action_payload.campaign_name');
  if (!scriptName) throw new Error('five9_set_default_ivr_schedule requires action_payload.script_name');

  return withFive9WriteGate(
    { action, subtype: 'set_default_ivr_schedule', entityType: 'five9_campaign', entityId: campaignName },
    async (ctx) => {
      const bodyXml = buildSetDefaultIvrScheduleXml(campaignName, scriptName);

      const campaign = await readCampaignByName(campaignName);
      if (!campaign) throw new Error(`campaign_not_found: ${campaignName}`);
      if (String(campaign.type).toUpperCase() !== 'INBOUND') {
        throw new Error(`REFUSED: ${campaignName} is ${campaign.type}, not INBOUND — an IVR schedule only applies to inbound campaigns`);
      }
      const script = await readIvrScript(scriptName);
      if (!script) throw new Error(`ivr_script_not_found: ${scriptName}`);

      const before = await getInboundCampaign(campaignName);
      const priorScript = before?.raw?.defaultIvrSchedule?.ivrSchedule?.scriptName ?? null;
      ctx.previous_state = { campaign: campaignName, scriptName: priorScript, state: campaign.state };

      if (priorScript && String(priorScript).toLowerCase() === scriptName.toLowerCase()) {
        return { skipped: true, reason: 'already_attached', campaign: campaignName, script: scriptName };
      }

      const rollback_payload = priorScript
        ? { action_type: 'five9_set_default_ivr_schedule', payload: { campaign_name: campaignName, script_name: priorScript } }
        : { note: `No prior script was attached to "${campaignName}" — rollback means detaching, which this phase exposes no op for.` };
      ctx.event_extra.rollback_payload = rollback_payload;

      await ctx.soap('setDefaultIVRSchedule', bodyXml);
      if (ctx.dry_run) {
        return { campaign: campaignName, script: scriptName, previous_script: priorScript, previewed: true, rollback_payload };
      }

      const after = await getInboundCampaign(campaignName);
      const nowScript = after?.raw?.defaultIvrSchedule?.ivrSchedule?.scriptName ?? null;
      ctx.new_state = { campaign: campaignName, scriptName: nowScript };
      const verified = !!nowScript && String(nowScript).toLowerCase() === scriptName.toLowerCase();
      ctx.event_extra.verified = verified;
      return {
        campaign: campaignName,
        script: scriptName,
        previous_script: priorScript,
        verified,
        ...(verified ? {} : { verify_mismatches: [{ field: 'defaultIvrSchedule.ivrSchedule.scriptName', expected: scriptName, actual: nowScript }] }),
        rollback_payload,
      };
    },
  );
}

export function executeAddDnisToCampaign(action) {
  const payload = action.action_payload || {};
  const campaignName = String(payload.campaign_name || '').trim();
  const dnis = (Array.isArray(payload.dnis) ? payload.dnis : [])
    .map(n => String(n ?? '').trim()).filter(Boolean);
  if (!campaignName) throw new Error('five9_add_dnis_to_campaign requires action_payload.campaign_name');
  if (!dnis.length) throw new Error('five9_add_dnis_to_campaign requires a non-empty action_payload.dnis[]');

  return withFive9WriteGate(
    { action, subtype: 'add_dnis_to_campaign', entityType: 'five9_campaign', entityId: campaignName },
    async (ctx) => {
      const bodyXml = buildCampaignDnisXml(campaignName, dnis);

      const campaign = await readCampaignByName(campaignName);
      if (!campaign) throw new Error(`campaign_not_found: ${campaignName}`);
      if (String(campaign.type).toUpperCase() !== 'INBOUND') {
        throw new Error(`REFUSED: ${campaignName} is ${campaign.type}, not INBOUND — DNIS route inbound calls`);
      }

      // refresh:true — the steal guard must never read a cached map. A DNIS
      // reassigned since the map was built is exactly the case this catches.
      const map = await getDnisMap({ refresh: true });
      const before = await getCampaignDNISList(campaignName);
      ctx.previous_state = { campaign: campaignName, dnis: before.dnis, count: before.count };

      const steal = checkDnisSteal(dnis, map.assignments, campaignName, {
        complianceOverride: payload.compliance_override === true,
      });
      ctx.event_extra.compliance = steal;
      ctx.event_extra.current_assignments = steal.conflicts;
      if (!steal.ok) {
        throw new Error(
          `REFUSED: DNIS reassignment — ${steal.violations.join('; ')}. ` +
          'Moving a live number silently re-routes a marketing line and breaks its attribution; ' +
          'requires explicit compliance_override: true',
        );
      }

      const alreadyOn = dnis.filter(n => before.dnis.includes(n));
      if (alreadyOn.length === dnis.length) {
        return { skipped: true, reason: 'all_dnis_already_assigned', campaign: campaignName, dnis };
      }

      const rollback_payload = {
        action_type: 'five9_remove_dnis_from_campaign',
        payload: {
          campaign_name: campaignName,
          dnis: dnis.filter(n => !alreadyOn.includes(n)),
          confirm_token: campaignName,
        },
        note: 'Removes only the numbers this action added, not any that were already assigned.',
      };
      ctx.event_extra.rollback_payload = rollback_payload;

      await ctx.soap('addDNISToCampaign', bodyXml);
      if (ctx.dry_run) {
        return { campaign: campaignName, dnis, previewed: true, conflicts: steal.conflicts, rollback_payload };
      }

      const after = await getCampaignDNISList(campaignName);
      ctx.new_state = { campaign: campaignName, dnis: after.dnis, count: after.count };
      const missing = dnis.filter(n => !after.dnis.includes(n));
      const verified = missing.length === 0;
      ctx.event_extra.verified = verified;
      return {
        campaign: campaignName,
        dnis_requested: dnis,
        dnis_added: dnis.filter(n => !alreadyOn.includes(n)),
        already_assigned: alreadyOn,
        count_before: before.count,
        count_after: after.count,
        verified,
        ...(verified ? {} : { verify_mismatches: missing.map(n => ({ dnis: n, expected: 'assigned', actual: 'absent' })) }),
        overridden_conflicts: steal.conflicts,
        rollback_payload,
      };
    },
  );
}

export function executeRemoveDnisFromCampaign(action) {
  const payload = action.action_payload || {};
  const campaignName = String(payload.campaign_name || '').trim();
  const dnis = (Array.isArray(payload.dnis) ? payload.dnis : [])
    .map(n => String(n ?? '').trim()).filter(Boolean);
  if (!campaignName) throw new Error('five9_remove_dnis_from_campaign requires action_payload.campaign_name');
  if (!dnis.length) throw new Error('five9_remove_dnis_from_campaign requires a non-empty action_payload.dnis[]');

  return withFive9WriteGate(
    { action, subtype: 'remove_dnis_from_campaign', entityType: 'five9_campaign', entityId: campaignName },
    async (ctx) => {
      const bodyXml = buildCampaignDnisXml(campaignName, dnis);
      checkConfirmToken('remove_dnis_from_campaign', payload);

      const campaign = await readCampaignByName(campaignName);
      if (!campaign) throw new Error(`campaign_not_found: ${campaignName}`);

      const before = await getCampaignDNISList(campaignName);
      ctx.previous_state = { campaign: campaignName, dnis: before.dnis, count: before.count, state: campaign.state };

      const present = dnis.filter(n => before.dnis.includes(n));
      if (!present.length) {
        return { skipped: true, reason: 'no_matching_dnis_assigned', campaign: campaignName, dnis };
      }

      const rollback_payload = {
        action_type: 'five9_add_dnis_to_campaign',
        payload: { campaign_name: campaignName, dnis: present },
        note: 'Re-adds only the numbers actually removed. The numbers become unassigned in the meantime — inbound calls to them do not reach this campaign until this is applied.',
      };
      ctx.event_extra.rollback_payload = rollback_payload;

      await ctx.soap('removeDNISFromCampaign', bodyXml);
      if (ctx.dry_run) {
        return { campaign: campaignName, dnis, previewed: true, rollback_payload };
      }

      const after = await getCampaignDNISList(campaignName);
      ctx.new_state = { campaign: campaignName, dnis: after.dnis, count: after.count };
      const stillPresent = present.filter(n => after.dnis.includes(n));
      const verified = stillPresent.length === 0;
      ctx.event_extra.verified = verified;
      return {
        campaign: campaignName,
        dnis_requested: dnis,
        dnis_removed: present,
        not_assigned: dnis.filter(n => !present.includes(n)),
        count_before: before.count,
        count_after: after.count,
        verified,
        ...(verified ? {} : { verify_mismatches: stillPresent.map(n => ({ dnis: n, expected: 'absent', actual: 'still assigned' })) }),
        rollback_payload,
      };
    },
  );
}

export function executeCreatePromptTts(action) {
  const payload = action.action_payload || {};
  const name = String(payload.name || '').trim();
  if (!name) throw new Error('five9_create_prompt_tts requires action_payload.name');
  if (typeof payload.text !== 'string' || !payload.text.trim()) {
    throw new Error('five9_create_prompt_tts requires a non-empty action_payload.text');
  }

  return withFive9WriteGate(
    { action, subtype: 'create_prompt_tts', entityType: 'five9_prompt', entityId: name },
    async (ctx) => {
      const bodyXml = buildPromptTtsXml({
        name,
        description: payload.description,
        text: payload.text,
        language: payload.language,
      });

      const existing = await readPrompt(name);
      if (existing) {
        return { skipped: true, reason: 'prompt_already_exists', prompt: name, type: existing.type };
      }
      ctx.previous_state = null;

      await ctx.soap('addPromptTTS', bodyXml);
      if (ctx.dry_run) return { prompt: name, created: false, previewed: true };

      // addPromptTTSResponse is empty — the read-back IS the result.
      const after = await readPrompt(name);
      ctx.new_state = after;
      const verified = !!after;
      ctx.event_extra.verified = verified;
      return {
        prompt: name,
        created: verified,
        verified,
        language: String(payload.language || 'en-US').trim(),
        rollback_payload: {
          method: 'deletePrompt',
          name,
          note: 'deletePrompt exists in the WSDL but is not implemented in this phase — park the prompt by renaming it in the Five9 UI.',
        },
      };
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

/* ====================================================================== *
 * Phase H (2026-08-21) — USER PROFILES.
 *
 * A user profile is a named bundle of roles, skills and membership attached
 * to many users at once. Reece runs two: "Level 1 Setter Profile" (5
 * LightFire agents) and "Level 2 Setter Profile" (1 NC hire).
 *
 * FOUR OPS, TWO RISK CLASSES.
 *
 *   NARROW PATCHES — modifyUserProfileSkills / modifyUserProfileUserList.
 *   Genuine patches: each takes a profile name plus add/remove lists and
 *   touches nothing else. These cover the actual day-to-day work (onboard a
 *   setter onto Level 1, adjust which skills its agents route to) and cannot
 *   alter a role grant at all. Prefer them; reach for the pair below only
 *   when the profile's own definition has to change.
 *
 *   FULL-OBJECT WRITES — createUserProfile / modifyUserProfile. Both take one
 *   complete <userProfile>. modifyUserProfile REPLACES THE WHOLE STRUCT: any
 *   field omitted from the submitted object is not "left alone", it is
 *   dropped. Omit skills and the profile's skills vanish; omit users and
 *   every member is detached; omit roles and every grant it carries is
 *   revoked. Read-modify-write is therefore mandatory, not stylistic, and it
 *   must be built from the RAW read (see the next note).
 *
 * WHY RMW USES profile.raw AND NOT THE NORMALIZED READ. normalizeUserProfile
 * collapses <roles> to { assigned, permissions } for readability, which drops
 * agentRole's three schema-REQUIRED booleans (alwaysRecorded, attachVmToEmail,
 * sendEmailOnVm — all minOccurs="1"). Rebuilding a modify from the normalized
 * shape would emit an agent role missing three required elements: either a
 * JAXB unmarshalling fault, or worse, a silent reset of three recording and
 * voicemail settings on every agent carrying the profile. The raw parsed
 * block is the only lossless base.
 *
 * FIELD ORDER IS WSDL-DERIVED (src/five9/wsdl-schema.json, v13.0.00/13,
 * generated from the live WSDL rather than hand-transcribed):
 *
 *   userProfile:    description, IEXScheduled, locale, mediaTypeConfig,
 *                   name, roles, skills[], users[]
 *   userRoles:      admin, agent, crmManager, reporting, supervisor
 *   agentRole:      alwaysRecorded, attachVmToEmail, permissions[], sendEmailOnVm
 *   other roles:    permissions[]
 *   *Permission:    type, value
 *   mediaTypeConfig: mediaTypes[]
 *   mediaTypeItem:  enabled, intlligentRouting, maxAlowed, type
 *
 * TWO MORE FIVE9 MISSPELLINGS, BOTH LOAD-BEARING: `intlligentRouting` and
 * `maxAlowed` on mediaTypeItem, exactly as `dispostionName` on
 * campaignCallWrapup and `userProfileNamePatern` on the read side. Emitting
 * the correct spelling sends an element the server does not know. Do not
 * "fix" them, and do not let a linter fix them.
 * ====================================================================== */

export const USER_PROFILE_FIELD_ORDER = [
  'description', 'IEXScheduled', 'locale', 'mediaTypeConfig', 'name', 'roles', 'skills', 'users',
];
export const USER_ROLES_FIELD_ORDER = ['admin', 'agent', 'crmManager', 'reporting', 'supervisor'];
export const ROLE_FIELD_ORDER = {
  admin: ['permissions'],
  agent: ['alwaysRecorded', 'attachVmToEmail', 'permissions', 'sendEmailOnVm'],
  crmManager: ['permissions'],
  reporting: ['permissions'],
  supervisor: ['permissions'],
};
// agentRole's minOccurs="1" elements — a modify that drops these silently
// resets recording/voicemail behavior for every user carrying the profile.
export const AGENT_ROLE_REQUIRED_FIELDS = ['alwaysRecorded', 'attachVmToEmail', 'sendEmailOnVm'];
export const MEDIA_TYPE_ITEM_FIELD_ORDER = ['enabled', 'intlligentRouting', 'maxAlowed', 'type'];
const MEDIA_TYPE_ITEM_BOOLEANS = new Set(['enabled', 'intlligentRouting']);

const xmlBool = (v) => String(v === true || v === 'true');

function permissionsXml(perms) {
  return asArray(perms).map((p) => {
    const type = String(p?.type ?? '').trim();
    if (!type) throw new Error('REFUSED: permission entry missing type');
    return `<permissions><type>${escapeXml(type)}</type><value>${xmlBool(p?.value)}</value></permissions>`;
  }).join('');
}

function roleXml(roleName, node) {
  const order = ROLE_FIELD_ORDER[roleName];
  if (!order) throw new Error(`REFUSED: unknown role "${roleName}" — userRoles carries exactly ${USER_ROLES_FIELD_ORDER.join(', ')}`);
  const n = (node && typeof node === 'object') ? node : {};
  let inner = '';
  for (const f of order) {
    if (f === 'permissions') { inner += permissionsXml(n.permissions); continue; }
    const v = n[f];
    if (v === undefined || v === null || v === '') {
      throw new Error(`REFUSED: ${roleName}.${f} is schema-required (minOccurs="1") and missing — submitting the role without it silently resets that setting for every user carrying this profile. Carry it forward from the read-before-write.`);
    }
    inner += `<${f}>${xmlBool(v)}</${f}>`;
  }
  return `<${roleName}>${inner}</${roleName}>`;
}

export function buildUserRolesXml(roles) {
  if (roles === undefined) return '';
  if (roles === null) return '<roles/>';
  if (typeof roles !== 'object' || Array.isArray(roles)) throw new Error('REFUSED: roles must be an object');
  const unknown = Object.keys(roles).filter(k => !USER_ROLES_FIELD_ORDER.includes(k));
  if (unknown.length) {
    throw new Error(`REFUSED: unknown role key(s) ${unknown.join(', ')} — refusing rather than dropping them silently`);
  }
  let inner = '';
  for (const r of USER_ROLES_FIELD_ORDER) {
    if (!Object.hasOwn(roles, r)) continue; // absent = role not granted
    inner += roleXml(r, roles[r]);
  }
  return `<roles>${inner}</roles>`;
}

export function buildMediaTypeConfigXml(cfg) {
  if (cfg === undefined) return '';
  if (cfg === null) return '<mediaTypeConfig/>';
  if (typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('REFUSED: mediaTypeConfig must be an object');
  const unknown = Object.keys(cfg).filter(k => k !== 'mediaTypes');
  if (unknown.length) {
    throw new Error(`REFUSED: unknown mediaTypeConfig field(s) ${unknown.join(', ')} — mediaTypeConfig carries only mediaTypes[]`);
  }
  const items = asArray(cfg.mediaTypes).map((it) => {
    const src = (it && typeof it === 'object') ? it : {};
    const bad = Object.keys(src).filter(k => !MEDIA_TYPE_ITEM_FIELD_ORDER.includes(k));
    if (bad.length) throw new Error(`REFUSED: unknown mediaTypeItem field(s) ${bad.join(', ')}`);
    let inner = '';
    for (const f of MEDIA_TYPE_ITEM_FIELD_ORDER) {
      const v = src[f];
      if (v === undefined || v === null || v === '') continue;
      inner += `<${f}>${MEDIA_TYPE_ITEM_BOOLEANS.has(f) ? xmlBool(v) : escapeXml(v)}</${f}>`;
    }
    return `<mediaTypes>${inner}</mediaTypes>`;
  }).join('');
  return `<mediaTypeConfig>${items}</mediaTypeConfig>`;
}

/**
 * buildUserProfileXml — the COMPLETE <userProfile> element, in WSDL order.
 *
 * Used by BOTH createUserProfile and modifyUserProfile: the WSDL request
 * wrappers are identical (one element, name="userProfile", type="userProfile"),
 * exactly as create/modifyCampaignProfile share buildCampaignProfileXml.
 *
 * Refuses any field it has no order for rather than appending it. An
 * out-of-order element is a JAXB unmarshalling fault, and a silently dropped
 * one is worse — on modify it is a deletion.
 */
export function buildUserProfileXml(profile) {
  if (!profile || typeof profile !== 'object') throw new Error('userProfile object is required');
  const name = String(profile.name ?? '').trim();
  if (!name) throw new Error('userProfile.name is required');
  const unknown = Object.keys(profile).filter(k => !USER_PROFILE_FIELD_ORDER.includes(k));
  if (unknown.length) {
    throw new Error(`REFUSED: unknown userProfile field(s) ${unknown.join(', ')} — userProfile carries exactly ${USER_PROFILE_FIELD_ORDER.join(', ')}`);
  }
  let inner = '';
  for (const f of USER_PROFILE_FIELD_ORDER) {
    if (!Object.hasOwn(profile, f)) continue;
    const v = profile[f];
    if (f === 'roles') { inner += buildUserRolesXml(v); continue; }
    if (f === 'mediaTypeConfig') { inner += buildMediaTypeConfigXml(v); continue; }
    if (f === 'skills' || f === 'users') {
      inner += asArray(v)
        .map(s => String(s ?? '').trim()).filter(Boolean)
        .map(s => `<${f}>${escapeXml(s)}</${f}>`).join('');
      continue;
    }
    if (v === null || v === undefined) continue;
    inner += `<${f}>${f === 'IEXScheduled' ? xmlBool(v) : escapeXml(v)}</${f}>`;
  }
  return `<userProfile>${inner}</userProfile>`;
}

export function buildModifyUserProfileSkillsXml(profileName, addSkills, removeSkills) {
  const name = String(profileName || '').trim();
  if (!name) throw new Error('profile_name is required');
  const list = (arr, tag) => asArray(arr)
    .map(s => String(s ?? '').trim()).filter(Boolean)
    .map(s => `<${tag}>${escapeXml(s)}</${tag}>`).join('');
  return `<userProfileName>${escapeXml(name)}</userProfileName>${list(addSkills, 'addSkills')}${list(removeSkills, 'removeSkills')}`;
}

export function buildModifyUserProfileUserListXml(profileName, addUsers, removeUsers) {
  const name = String(profileName || '').trim();
  if (!name) throw new Error('profile_name is required');
  const list = (arr, tag) => asArray(arr)
    .map(s => String(s ?? '').trim()).filter(Boolean)
    .map(s => `<${tag}>${escapeXml(s)}</${tag}>`).join('');
  return `<userProfileName>${escapeXml(name)}</userProfileName>${list(addUsers, 'addUsers')}${list(removeUsers, 'removeUsers')}`;
}

/* ---------------------------------------------------------------------- *
 * Guardrail 12 (2026-08-21) — role-grant protection.
 *
 * A profile granting `admin` or `supervisor` hands that access to EVERY user
 * carrying it, domain-wide, the moment the write lands. That is the same
 * class of exposure already sitting open and un-reviewed on ssmith3 and
 * swebster; this op family must not become a second, automated way to
 * create it.
 *
 * Deliberately STRICTER than the bulk-delete gate. That one takes
 * compliance_override + confirm_token + a numeric ceiling. This one adds a
 * written legal_basis, persisted verbatim to the audit event, because the
 * blast radius is domain-wide admin AND — per the Phase H finding that the
 * v13 Admin API has no audit-trail operation at all (getAgentAuditReport
 * does not exist) — that audit event is the ONLY record this grant will ever
 * have. There is nothing to reconstruct it from afterwards.
 *
 * WHAT COUNTS AS POPULATED. Absent, null, or {} is fine — {} is
 * indistinguishable from absent once serialized. Anything with content is a
 * grant and needs the override, INCLUDING { permissions: [] }: attaching the
 * admin role with no fine-grained permissions still attaches the admin role.
 *
 * WHAT IS CHECKED. The `changes.roles` a caller SUBMITS, never the merged
 * result. Carrying an existing grant forward untouched through a
 * read-modify-write is not a new grant and must not trip the gate — if it
 * did, every routine edit to an already-privileged profile would demand a
 * legal_basis and the gate would be trained out of people within a week.
 * Dropping a role is de-escalation and is always allowed.
 * ---------------------------------------------------------------------- */

export const ROLE_GRANT_GATED_ROLES = ['admin', 'supervisor'];

// A justification has to actually justify. One character satisfies "a string
// is present" while recording nothing, and this event is the only record.
export const MIN_LEGAL_BASIS_CHARS = Math.max(
  1,
  parseInt(process.env.FIVE9_MIN_LEGAL_BASIS_CHARS || '20', 10),
);

export function isRolePopulated(node) {
  if (node === undefined || node === null) return false;
  if (typeof node !== 'object') return true;
  return Object.keys(node).length > 0;
}

export function checkRoleGrant(rolesBlock, { complianceOverride = false, legalBasis = '' } = {}) {
  const granted = ROLE_GRANT_GATED_ROLES.filter(r => isRolePopulated(rolesBlock?.[r]));
  if (!granted.length) return { ok: true, granted: [], violations: [], legal_basis: null };
  const basis = String(legalBasis ?? '').trim();
  const violations = [];
  if (complianceOverride !== true) {
    violations.push(`grants ${granted.join(' + ')} — requires explicit compliance_override: true`);
  }
  if (basis.length < MIN_LEGAL_BASIS_CHARS) {
    violations.push(`grants ${granted.join(' + ')} — requires a written legal_basis of at least ${MIN_LEGAL_BASIS_CHARS} characters, recorded verbatim on the audit event (the Admin API has no audit trail of its own, so this is the only record)`);
  }
  return {
    ok: violations.length === 0,
    granted,
    violations,
    legal_basis: basis || null,
    overridden: violations.length === 0,
  };
}

/** Anchored alternation so a batch of usernames costs ONE read, not N. */
export function exactUserAlternationPattern(names) {
  const list = asArray(names).map(n => String(n ?? '').trim()).filter(Boolean);
  if (!list.length) throw new Error('names[] is required');
  return `^(?:${list.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`;
}

/* ---------------------------------------------------------------------- *
 * Phase H executes — user profiles.
 *
 * All four share one existence guard: read the profile by exact name FIRST
 * and refuse if it is absent, rather than letting Five9's own error be the
 * only signal. A mistyped profile name is the most likely way any of these
 * goes wrong, and modifyUserProfileUserList in particular can accept a
 * request that does nothing useful without complaining loudly.
 * ---------------------------------------------------------------------- */

/**
 * The existence guard, pure and exported so it is provable offline.
 * Every profile op reads by exact name FIRST and refuses when absent, rather
 * than letting Five9's own error be the only signal — a mistyped profile name
 * is the likeliest way any of these goes wrong.
 */
export function assertUserProfileExists(subtype, profileName, profile) {
  if (!profile) {
    throw new Error(`REFUSED: user_profile_not_found: ${profileName} — read five9_get_user_profiles and restate the name exactly (${subtype})`);
  }
  return profile;
}

async function readUserProfileOrThrow(subtype, profileName) {
  return assertUserProfileExists(subtype, profileName, await getUserProfile(profileName));
}

/**
 * Cross-check the usernames being ADDED against the live user inventory.
 * Pure over the known set, so the refusal is testable without a SOAP call.
 *
 * Five9 accepts an unknown username on modifyUserProfileUserList without
 * erroring: the call reports success and the profile simply never lands on
 * anybody. A typo would look like a completed onboarding.
 */
export function checkAddUsersKnown(addUsers, knownUserNames) {
  const known = knownUserNames instanceof Set ? knownUserNames : new Set(asArray(knownUserNames).map(String));
  const wanted = asArray(addUsers).map(u => String(u ?? '').trim()).filter(Boolean);
  const missing = wanted.filter(u => !known.has(u));
  if (missing.length) {
    throw new Error(`REFUSED: unknown Five9 username(s) in add_users: ${missing.join(', ')} — verified against getUsersGeneralInfo before submitting, because Five9 accepts an unknown username here without erroring and the profile simply never lands`);
  }
  return { checked: wanted.length, found: wanted.length };
}

/**
 * Merge a modify's `changes` onto the RAW read. Pure and exported because
 * this function IS the read-modify-write contract: modifyUserProfile replaces
 * the whole struct, so every field of `base` that `changes` does not name has
 * to survive into the submitted object untouched.
 *
 * `name` is pinned to the live profile's own spelling — a rename via this
 * path would read as "create a different profile and orphan this one".
 */
export function mergeUserProfile(base, changes, liveName) {
  const b = (base && typeof base === 'object') ? base : {};
  const c = (changes && typeof changes === 'object') ? changes : {};
  return { ...b, ...c, name: liveName };
}

const trimmedList = (v) => asArray(v).map(s => String(s ?? '').trim()).filter(Boolean);

export function assertSomethingToDo(subtype, addField, addList, removeField, removeList) {
  if (!asArray(addList).length && !asArray(removeList).length) {
    throw new Error(`REFUSED: ${subtype} requires at least one of action_payload.${addField}[] or action_payload.${removeField}[] to be non-empty — an empty patch is a no-op that still burns an approval`);
  }
}

export function executeModifyUserProfileSkills(action) {
  const payload = action.action_payload || {};
  const name = String(payload.profile_name || '').trim();
  if (!name) throw new Error('five9_modify_user_profile_skills requires action_payload.profile_name');
  const addSkills = trimmedList(payload.add_skills);
  const removeSkills = trimmedList(payload.remove_skills);
  assertSomethingToDo('five9_modify_user_profile_skills', 'add_skills', addSkills, 'remove_skills', removeSkills);

  return withFive9WriteGate(
    { action, subtype: 'modify_user_profile_skills', entityType: 'five9_user_profile', entityId: name },
    async (ctx) => {
      const before = await readUserProfileOrThrow('modify_user_profile_skills', name);
      ctx.previous_state = { name: before.name, skills: before.skills, roles: before.roles.assigned };

      const bodyXml = buildModifyUserProfileSkillsXml(before.name, addSkills, removeSkills);
      await ctx.soap('modifyUserProfileSkills', bodyXml);
      if (ctx.dry_run) return { profile: before.name, add_skills: addSkills, remove_skills: removeSkills, previewed: true };

      const after = await getUserProfile(before.name);
      ctx.new_state = after ? { name: after.name, skills: after.skills, roles: after.roles.assigned } : null;
      const now = new Set(after?.skills || []);
      const verify_mismatches = [
        ...addSkills.filter(s => !now.has(s)).map(s => ({ skill: s, expected: 'present', actual: 'absent' })),
        ...removeSkills.filter(s => now.has(s)).map(s => ({ skill: s, expected: 'absent', actual: 'present' })),
      ];
      ctx.event_extra.verify_mismatches = verify_mismatches;
      return {
        profile: before.name,
        add_skills: addSkills,
        remove_skills: removeSkills,
        skill_count: after?.skills?.length ?? null,
        verified: verify_mismatches.length === 0,
        ...(verify_mismatches.length ? { verify_mismatches } : {}),
      };
    },
  );
}

export function executeModifyUserProfileUserList(action) {
  const payload = action.action_payload || {};
  const name = String(payload.profile_name || '').trim();
  if (!name) throw new Error('five9_modify_user_profile_user_list requires action_payload.profile_name');
  const addUsers = trimmedList(payload.add_users);
  const removeUsers = trimmedList(payload.remove_users);
  assertSomethingToDo('five9_modify_user_profile_user_list', 'add_users', addUsers, 'remove_users', removeUsers);

  return withFive9WriteGate(
    { action, subtype: 'modify_user_profile_user_list', entityType: 'five9_user_profile', entityId: name },
    async (ctx) => {
      const before = await readUserProfileOrThrow('modify_user_profile_user_list', name);
      ctx.previous_state = { name: before.name, users: before.users, roles: before.roles.assigned };

      // Every username being ADDED must exist. Five9 does not reliably error
      // on an unknown one, so a typo would report success and silently leave
      // the setter without the profile — the failure mode this guard exists
      // for. One anchored-alternation read covers the whole batch.
      if (addUsers.length) {
        const res = await getUsersGeneralInfo(exactUserAlternationPattern(addUsers));
        const known = new Set((res?.users || []).map(u => String(u.userName ?? '')));
        // Membership is confirmed LOCALLY against the returned names, so an
        // over-matching pattern cannot manufacture a false positive.
        ctx.event_extra.add_users_verified = checkAddUsersKnown(addUsers, known);
      }
      // removeUsers is deliberately NOT existence-checked: removing a user
      // who is already absent is a harmless no-op, and refusing it would
      // block cleanup of a profile that outlived a deleted account.

      const bodyXml = buildModifyUserProfileUserListXml(before.name, addUsers, removeUsers);
      await ctx.soap('modifyUserProfileUserList', bodyXml);
      if (ctx.dry_run) return { profile: before.name, add_users: addUsers, remove_users: removeUsers, previewed: true };

      const after = await getUserProfile(before.name);
      ctx.new_state = after ? { name: after.name, users: after.users, roles: after.roles.assigned } : null;
      const now = new Set(after?.users || []);
      const verify_mismatches = [
        ...addUsers.filter(u => !now.has(u)).map(u => ({ user: u, expected: 'member', actual: 'absent' })),
        ...removeUsers.filter(u => now.has(u)).map(u => ({ user: u, expected: 'absent', actual: 'member' })),
      ];
      ctx.event_extra.verify_mismatches = verify_mismatches;
      return {
        profile: before.name,
        add_users: addUsers,
        remove_users: removeUsers,
        member_count: after?.users?.length ?? null,
        verified: verify_mismatches.length === 0,
        ...(verify_mismatches.length ? { verify_mismatches } : {}),
      };
    },
  );
}

export function executeCreateUserProfile(action) {
  const payload = action.action_payload || {};
  const name = String(payload.profile_name || '').trim();
  if (!name) throw new Error('five9_create_user_profile requires action_payload.profile_name');
  const profile = payload.profile;
  if (!profile || typeof profile !== 'object') {
    throw new Error('five9_create_user_profile requires action_payload.profile (the full userProfile object)');
  }

  return withFive9WriteGate(
    { action, subtype: 'create_user_profile', entityType: 'five9_user_profile', entityId: name },
    async (ctx) => {
      checkConfirmToken('create_user_profile', payload);

      // On create there is no "before" to diff against, so the role check
      // runs over the WHOLE submitted roles block rather than a delta.
      const roleGrant = checkRoleGrant(profile.roles, {
        complianceOverride: payload.compliance_override === true,
        legalBasis: payload.legal_basis,
      });
      ctx.event_extra.role_grant = roleGrant;
      if (roleGrant.legal_basis) ctx.event_extra.legal_basis = roleGrant.legal_basis;
      if (!roleGrant.ok) {
        throw new Error(`REFUSED: role grant — ${roleGrant.violations.join('; ')}`);
      }

      const bodyXml = buildUserProfileXml({ ...profile, name });

      const existing = await getUserProfile(name);
      if (existing) return { skipped: true, reason: 'user_profile_already_exists', profile: name };
      ctx.previous_state = null;

      await ctx.soap('createUserProfile', bodyXml);
      if (ctx.dry_run) return { profile: name, created: false, previewed: true, role_grant: roleGrant };

      const after = await getUserProfile(name);
      ctx.new_state = after;
      return { profile: name, created: !!after, roles_granted: after?.roles?.assigned ?? [], role_grant: roleGrant };
    },
  );
}

/**
 * modifyUserProfile — READ-MODIFY-WRITE, mandatory.
 *
 * The API replaces the whole struct, so the submitted object is rebuilt from
 * the raw read and only the fields named in changes are overlaid. Every
 * untouched field is carried forward byte-for-byte; anything omitted from
 * the merge would be a deletion, not a no-op.
 */
export function executeModifyUserProfile(action) {
  const payload = action.action_payload || {};
  const name = String(payload.profile_name || '').trim();
  if (!name) throw new Error('five9_modify_user_profile requires action_payload.profile_name');
  const changes = payload.changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new Error('five9_modify_user_profile requires action_payload.changes (an object of userProfile fields to overlay)');
  }
  if (!Object.keys(changes).length) {
    throw new Error('REFUSED: five9_modify_user_profile with empty changes — an empty patch is a no-op that still burns an approval');
  }

  return withFive9WriteGate(
    { action, subtype: 'modify_user_profile', entityType: 'five9_user_profile', entityId: name },
    async (ctx) => {
      checkConfirmToken('modify_user_profile', payload);

      // Only the roles a caller SUBMITS are gated. Carrying an existing grant
      // forward untouched is not a new grant — see Guardrail 12.
      const roleGrant = checkRoleGrant(changes.roles, {
        complianceOverride: payload.compliance_override === true,
        legalBasis: payload.legal_basis,
      });
      ctx.event_extra.role_grant = roleGrant;
      if (roleGrant.legal_basis) ctx.event_extra.legal_basis = roleGrant.legal_basis;
      if (!roleGrant.ok) {
        throw new Error(`REFUSED: role grant — ${roleGrant.violations.join('; ')}`);
      }

      const before = await readUserProfileOrThrow('modify_user_profile', name);
      ctx.previous_state = before;

      // confirm_token must restate the EXISTING profile's name verbatim, not
      // merely the payload's own spelling — that is what makes it a check on
      // the live target rather than a check on itself.
      if (String(payload.confirm_token ?? '') !== String(before.name ?? '')) {
        throw new Error(`REFUSED: confirm_token must exactly equal the existing profile name "${before.name}" (Five9's spelling, including case)`);
      }

      // RMW from the RAW block: the normalized read drops agentRole's three
      // schema-required booleans, and rebuilding from it would reset them.
      const base = (before.raw && typeof before.raw === 'object') ? before.raw : {};
      const merged = mergeUserProfile(base, changes, before.name);
      const bodyXml = buildUserProfileXml(merged);
      ctx.event_extra.changed_fields = Object.keys(changes);

      await ctx.soap('modifyUserProfile', bodyXml);
      if (ctx.dry_run) {
        return { profile: before.name, modified: false, previewed: true, changed_fields: Object.keys(changes), role_grant: roleGrant };
      }

      const after = await getUserProfile(before.name);
      ctx.new_state = after;

      // Verify against INTENT: every field named in changes must read back as
      // submitted, and the fields that were NOT touched must be unchanged.
      const canon = (v) => JSON.stringify(v ?? null);
      const verify_mismatches = [];
      for (const f of Object.keys(changes)) {
        const expected = merged[f];
        const actual = after?.raw?.[f];
        if (canon(expected) !== canon(actual)) verify_mismatches.push({ field: f, expected, actual });
      }
      for (const f of USER_PROFILE_FIELD_ORDER) {
        if (Object.hasOwn(changes, f)) continue;
        if (canon(base[f]) !== canon(after?.raw?.[f])) {
          verify_mismatches.push({ field: f, untouched: true, expected: base[f], actual: after?.raw?.[f] });
        }
      }
      ctx.event_extra.verify_mismatches = verify_mismatches;
      return {
        profile: before.name,
        modified: true,
        changed_fields: Object.keys(changes),
        roles_granted: after?.roles?.assigned ?? [],
        verified: verify_mismatches.length === 0,
        ...(verify_mismatches.length ? { verify_mismatches } : {}),
        role_grant: roleGrant,
      };
    },
  );
}

/* ====================================================================== *
 * Phase H PR4 (2026-08-21) — Guardrail 13: web connector destination
 * allow-list.
 *
 * WHY THIS EXISTS AT ALL. PR3 classified createWebConnector and
 * modifyWebConnector as `denied`, with the reason: "posts live call and
 * contact data to an arbitrary URL from the agent desktop; there is no
 * destination allow-list." Mark ruled the pair allowed on 2026-08-21. The
 * denial's REASONING was not waived — it is answered, by building the
 * allow-list it said was missing. If this guardrail is ever weakened, the
 * ops go back to `denied`; they are not independently safe.
 *
 * deleteWebConnector stays denied under DELETE_RULE.
 *
 * FAIL CLOSED. FIVE9_WEBCONNECTOR_ALLOWED_HOSTS unset means the allow-list is
 * EMPTY, and an empty allow-list REFUSES EVERY DESTINATION. It never means
 * "allow all". A missing env var must disable the feature, not open it.
 *
 * NO compliance_override PATH. Every other gated op here has one; this one
 * deliberately does not. An override would reintroduce exactly the
 * arbitrary-URL hole the denial was about, one approved action at a time. A
 * new destination goes into the env var deliberately, by a human editing
 * Railway — which is also the only record of the decision.
 * ====================================================================== */

export const WEBCONNECTOR_ALLOWED_HOSTS_ENV = 'FIVE9_WEBCONNECTOR_ALLOWED_HOSTS';

/** The four keyValuePair blocks on tns:webConnector (all maxOccurs="unbounded"). */
export const WEBCONNECTOR_KV_BLOCKS = Object.freeze([
  'constants', 'postConstants', 'variables', 'postVariables',
]);

/**
 * Parse the allow-list. Unset / empty / whitespace → an EMPTY Set, which
 * refuses everything. Comma-separated hostnames, case-insensitive.
 */
export function webConnectorAllowedHosts(raw = process.env[WEBCONNECTOR_ALLOWED_HOSTS_ENV]) {
  if (raw instanceof Set) return raw;
  return new Set(
    String(raw ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
  );
}

// Percent-encoding is the cheapest way to smuggle a second destination past a
// substring check, so every value is examined decoded as well as raw.
function decodeMaybe(v) {
  try { return decodeURIComponent(String(v ?? '')); } catch { return String(v ?? ''); }
}

/**
 * Does this value look like it is trying to be a destination? Deliberately
 * BROAD: anything carrying a scheme separator or a protocol-relative prefix
 * is sent to the validator, which refuses whatever it cannot prove safe.
 * A false positive costs a refusal the operator can fix; a false negative
 * ships an exfiltration path.
 */
// A protocol-relative destination is not always at the start of the value —
// inside startPageText it appears as <img src="//host/x">. Requiring a dotted
// hostname after the // keeps an ordinary "// comment" from being flagged,
// while still catching the embedded form.
const PROTOCOL_RELATIVE_RE = /(^|[\s"'=(,;])\/\/[a-z0-9-]+(\.[a-z0-9-]+)+/i;

export function looksLikeDestination(value) {
  const raw = String(value ?? '');
  const dec = decodeMaybe(raw);
  return /:\/\//.test(raw) || /:\/\//.test(dec) ||
    PROTOCOL_RELATIVE_RE.test(raw) || PROTOCOL_RELATIVE_RE.test(dec);
}

// An IP literal can never be a legitimate Reece destination, and a numeric
// host is the classic way to dodge a name-based allow-list.
function isIpLiteralHost(host) {
  if (!host) return true;
  if (host.startsWith('[')) return true;              // IPv6 literal, e.g. [::1]
  if (/^[0-9.]+$/.test(host)) return true;            // dotted-quad or bare integer
  if (host.split('.').some((label) => /^0x/i.test(label))) return true; // hex form
  return false;
}

/**
 * Validate ONE destination against the allow-list. Pure; every refusal
 * carries the specific reason so an approver can see what was wrong.
 */
export function validateWebConnectorDestination(value, allowedHosts = webConnectorAllowedHosts()) {
  const allow = webConnectorAllowedHosts(allowedHosts);
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty destination' };

  let u;
  try {
    u = new URL(decodeMaybe(raw));
  } catch {
    // Protocol-relative ("//host/path") and every other unparseable form land
    // here. Refusing is correct: we cannot prove the scheme, so we cannot
    // prove it is https.
    return { ok: false, reason: `"${raw}" is not a parseable absolute URL (a protocol-relative or malformed destination cannot be proven https)` };
  }

  // https ONLY, checked before the host: an agent desktop posting live call
  // and contact data in plaintext is unacceptable regardless of destination.
  if (u.protocol !== 'https:') {
    return { ok: false, reason: `scheme "${u.protocol}" is not https: — call and contact data must never leave the agent desktop in plaintext` };
  }
  if (u.username || u.password) {
    return { ok: false, reason: 'embedded credentials (user:pass@host) in the destination' };
  }
  if (u.port) {
    return { ok: false, reason: `non-standard port ":${u.port}" — only the default https port is allowed` };
  }

  const host = u.hostname.toLowerCase();
  if (isIpLiteralHost(host)) {
    return { ok: false, reason: `IP-literal host "${u.hostname}" — destinations must be named hosts on the allow-list` };
  }
  if (!allow.size) {
    return { ok: false, reason: `${WEBCONNECTOR_ALLOWED_HOSTS_ENV} is unset or empty — the allow-list refuses every destination (fail closed; it never means "allow all")` };
  }
  // EXACT match only. Suffix matching would let "evil-example.com" pass an
  // entry of "example.com", which is the whole class of bug this prevents.
  if (!allow.has(host)) {
    return { ok: false, reason: `host "${host}" is not in ${WEBCONNECTOR_ALLOWED_HOSTS_ENV} (exact match only — no suffix matching; allowed: ${[...allow].join(', ')})` };
  }
  return { ok: true, host };
}

/**
 * Guardrail 13 — check EVERY destination a connector can reach, not just
 * `url`. A second URL hidden in a POST constant defeats a check that only
 * reads the primary field, so all four keyValuePair blocks are walked.
 *
 * startPageText is checked too. It is not one of the four blocks the ruling
 * named, but it is a free-text field rendered in the agent desktop, so a URL
 * in it is reachable for exactly the same reason — the ruling's stated
 * principle ("a second destination hidden in X defeats a check that only
 * reads url") applies to it unchanged. Called out in the PR body.
 */
export function checkWebConnectorDestinations(connector, { allowedHosts } = {}) {
  const allow = webConnectorAllowedHosts(allowedHosts);
  const violations = [];
  const checked = [];

  const examine = (label, value) => {
    const verdict = validateWebConnectorDestination(value, allow);
    checked.push({ at: label, value: String(value ?? ''), ok: verdict.ok });
    if (!verdict.ok) violations.push(`${label}: ${verdict.reason}`);
  };

  const url = connector?.url;
  if (url === undefined || url === null || String(url).trim() === '') {
    violations.push('url: missing — a web connector with no destination cannot be validated, so it cannot be approved');
  } else {
    examine('url', url);
  }

  for (const block of WEBCONNECTOR_KV_BLOCKS) {
    const rows = Array.isArray(connector?.[block])
      ? connector[block]
      : (connector?.[block] ? [connector[block]] : []);
    rows.forEach((row, i) => {
      const value = row?.value;
      if (value === undefined || value === null) return;
      if (!looksLikeDestination(value)) return; // a plain call variable, not a destination
      examine(`${block}[${i}]${row?.key ? ` (${row.key})` : ''}`, value);
    });
  }

  if (looksLikeDestination(connector?.startPageText)) {
    examine('startPageText', connector.startPageText);
  }

  return {
    ok: violations.length === 0,
    violations,
    checked,
    allowed_hosts: [...allow],
    // Recorded on the audit event so the absence of an override is visible in
    // the record, not just in this file.
    override_available: false,
  };
}

/* ---------------------------------------------------------------------- *
 * Web connector read-modify-write.
 *
 * modifyWebConnector is built as a FULL-OBJECT REPLACE. Every modify* op in
 * this API that takes a named complexType has replaced the whole struct —
 * modifyUserProfile most recently, where omitting `roles` revokes every
 * grant. The schema gives no basis to expect webConnector to behave
 * differently (the operation takes one <connector> of tns:webConnector, the
 * same shape create takes), so it read-modify-writes: read live, overlay the
 * named changes, serialize complete, re-read and diff against intent.
 * ---------------------------------------------------------------------- */

/**
 * Rebuild the exact schema-shaped struct Five9 last returned, from the raw
 * parsed block rather than the reader's normalized view. The normalized view
 * coerces booleans (`x === 'true'`), which turns an ABSENT field into an
 * explicit false — and on a full-object replace an invented false is a
 * silent setting change. The raw block preserves absent-vs-false.
 */
export function webConnectorFromRead(read) {
  const raw = read?.raw;
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const f of flattenType('webConnector')) {
    const v = raw[f.name];
    if (v === undefined || v === null) continue;
    if (f.maxOccurs === 'unbounded') {
      const items = Array.isArray(v) ? v : [v];
      if (items.length) out[f.name] = items;
      continue;
    }
    out[f.name] = v;
  }
  return out;
}

/**
 * Overlay `changes` onto the live struct. The name is pinned to Five9's own
 * spelling: renaming through modify would be a rename, and renames are
 * denied for the same attribution reason campaigns are.
 */
export function mergeWebConnector(existing, changes = {}) {
  const base = webConnectorFromRead(existing);
  if (!base) {
    throw new Error('REFUSED: read-before-write returned no parseable webConnector body — refusing to replace a struct we could not read');
  }
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new Error('five9_modify_web_connector requires action_payload.changes as an object');
  }
  const known = new Set(flattenType('webConnector').map((f) => f.name));
  for (const key of Object.keys(changes)) {
    if (!known.has(key)) {
      throw new Error(`REFUSED: unknown webConnector field "${key}" — webConnector carries exactly ${[...known].sort().join(', ')}`);
    }
  }
  if (Object.hasOwn(changes, 'name') && String(changes.name) !== String(base.name)) {
    throw new Error(`REFUSED: five9_modify_web_connector cannot rename a connector (live name "${base.name}", changes.name "${changes.name}") — create the new one and retire the old one deliberately`);
  }
  return { ...base, ...changes, name: base.name };
}

/** Read-back diff — reports drift on CHANGED and UNTOUCHED fields alike. */
export function verifyWebConnectorReadBack(submitted, after, changedKeys = []) {
  const canon = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
  const actualRaw = after?.raw ?? {};
  const mismatches = [];
  for (const [field, expected] of Object.entries(submitted || {})) {
    const actual = actualRaw[field];
    if (canon(expected) === canon(actual)) continue;
    mismatches.push({
      field,
      untouched: !changedKeys.includes(field),
      expected,
      actual: actual ?? null,
    });
  }
  return mismatches;
}

export function executeCreateWebConnector(action) {
  const payload = action.action_payload || {};
  const name = String(payload.connector_name || '').trim();
  const connector = payload.connector;
  if (!name) throw new Error('five9_create_web_connector requires action_payload.connector_name');
  if (!connector || typeof connector !== 'object' || Array.isArray(connector)) {
    throw new Error('five9_create_web_connector requires action_payload.connector as an object');
  }

  return withFive9WriteGate(
    { action, subtype: 'create_web_connector', entityType: 'five9_web_connector', entityId: name },
    async (ctx) => {
      checkConfirmToken('create_web_connector', payload);
      const submitted = { ...connector, name };

      // Guardrail 13 BEFORE the existence read: a refusal should not depend on
      // whether the name happens to be free.
      const destinations = checkWebConnectorDestinations(submitted);
      ctx.event_extra.destination_check = destinations;
      if (!destinations.ok) {
        throw new Error(`REFUSED: Guardrail 13 — ${destinations.violations.join('; ')}`);
      }

      const existing = await getWebConnector(name);
      ctx.previous_state = existing;
      if (existing) {
        // REFUSE rather than skip: createWebConnector on a live name would
        // either fault or silently replace a connector nobody reviewed.
        throw new Error(`REFUSED: a web connector named "${existing.name}" already exists — use five9_modify_web_connector, or pick a different name`);
      }

      await ctx.soap('createWebConnector', buildFromSchema('webConnector', submitted, { wrapper: 'connector' }));
      if (ctx.dry_run) return { connector: name, created: false, previewed: true, destination_check: destinations };

      ctx.new_state = await getWebConnector(name);
      return { connector: name, created: !!ctx.new_state, destination_check: destinations };
    },
  );
}

export function executeModifyWebConnector(action) {
  const payload = action.action_payload || {};
  const name = String(payload.connector_name || '').trim();
  const changes = payload.changes;
  if (!name) throw new Error('five9_modify_web_connector requires action_payload.connector_name');
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) {
    throw new Error('five9_modify_web_connector requires action_payload.changes with at least one field');
  }

  return withFive9WriteGate(
    { action, subtype: 'modify_web_connector', entityType: 'five9_web_connector', entityId: name },
    async (ctx) => {
      checkConfirmToken('modify_web_connector', payload);

      const existing = await getWebConnector(name);
      if (!existing) throw new Error(`web_connector_not_found: ${name}`);
      ctx.previous_state = existing;

      // Re-check the token against Five9's OWN spelling, like
      // modify_user_profile: that makes it a check on the target rather than
      // on the payload's internal consistency.
      if (String(payload.confirm_token ?? '') !== existing.name) {
        throw new Error(`REFUSED: confirm_token mismatch for modify_web_connector — payload.confirm_token must exactly equal the live connector name "${existing.name}" (including case)`);
      }

      const merged = mergeWebConnector(existing, changes);

      // Guardrail 13 runs on the MERGED struct, not on `changes`: the live
      // connector may already carry a destination that is no longer allowed,
      // and a full-object replace re-submits it.
      const destinations = checkWebConnectorDestinations(merged);
      ctx.event_extra.destination_check = destinations;
      if (!destinations.ok) {
        throw new Error(`REFUSED: Guardrail 13 — ${destinations.violations.join('; ')}`);
      }

      const changedKeys = Object.keys(changes);
      ctx.event_extra.changed_fields = changedKeys;
      ctx.event_extra.replace_semantics = 'full-object replace (read-modify-write); every field is re-submitted, not patched';

      await ctx.soap('modifyWebConnector', buildFromSchema('webConnector', merged, { wrapper: 'connector' }));
      if (ctx.dry_run) {
        return { connector: existing.name, modified: false, previewed: true, changed_fields: changedKeys, destination_check: destinations };
      }

      ctx.new_state = await getWebConnector(name);
      const verify_mismatches = verifyWebConnectorReadBack(merged, ctx.new_state, changedKeys);
      ctx.event_extra.verify_mismatches = verify_mismatches;
      return {
        connector: existing.name,
        modified: true,
        changed_fields: changedKeys,
        verified: verify_mismatches.length === 0,
        ...(verify_mismatches.length ? { verify_mismatches } : {}),
        destination_check: destinations,
      };
    },
  );
}

/* ====================================================================== *
 * Phase H PR4 (2026-08-21) — campaign composition.
 *
 * Lists, skills, dispositions and strategies: what a campaign dials, who it
 * routes to, and how fast. All of it lands on a campaign the floor is
 * working, which is why almost every op here refuses while the target is
 * RUNNING — the exception is documented per-op.
 *
 * SCHEMA NOTE. Every request wrapper in this section IS a complexType in
 * wsdl-schema.json (addListsToCampaign carries campaignName + repeated
 * lists, and so on), so buildFromSchema walks the wrapper directly and there
 * is no hand-written field order in this tranche. That is the mechanism PR3
 * built, used as intended.
 * ====================================================================== */

/**
 * Refuse an op while its campaign is RUNNING.
 *
 * Same shape as Guardrail 11 (checkResetCampaignState) and same reasoning:
 * the request is DANGEROUS, not already-satisfied, so it refuses rather than
 * skipping. Changing what a live campaign dials, or who it routes to,
 * underneath the agents currently on it is not a change you make and then
 * discover — stop it first, change it, start it, as separately approved
 * actions.
 */
export function refuseIfCampaignRunning(op, campaign) {
  const state = String(campaign?.state || '').toUpperCase();
  if (state === 'RUNNING') {
    throw new Error(`REFUSED: ${op} on a RUNNING campaign — "${campaign?.name}" is live and agents are working it; stop the campaign, make the change, and restart it as separately approved actions`);
  }
}

/**
 * Shared spine for the composition ops: read the campaign, refuse INBOUND,
 * check the token, optionally refuse RUNNING, then let the op build its body.
 *
 * `build` receives (ctx, campaign, payload) and returns the inner XML. It may
 * also perform its own reads (existence checks, read-modify-write) — those
 * run after the state guards so a RUNNING refusal never costs extra SOAP
 * calls.
 */
async function campaignCompositionOp(action, subtype, {
  method, build, refuseWhileRunning = true, readBack = null,
}) {
  const payload = action.action_payload || {};
  const name = String(payload.campaign_name || '').trim();
  if (!name) throw new Error(`five9_${subtype} requires action_payload.campaign_name`);

  return withFive9WriteGate(
    { action, subtype, entityType: 'five9_campaign', entityId: name },
    async (ctx) => {
      checkConfirmToken(subtype, payload);
      const { campaigns } = await getCampaigns();
      const hit = campaigns.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (!hit) throw new Error(`campaign_not_found: ${name}`);
      ctx.previous_state = hit;
      refuseIfInbound(hit);
      if (refuseWhileRunning) refuseIfCampaignRunning(subtype, hit);

      const { xml, result = {} } = await build(ctx, hit, payload);
      await ctx.soap(method, xml);
      if (ctx.dry_run) return { campaign: hit.name, method, previewed: true, ...result };

      if (readBack) ctx.new_state = await readBack(hit, payload);
      return { campaign: hit.name, method, ...result };
    },
  );
}

// Every composition op takes a non-empty array of names; an empty array is a
// no-op the caller almost certainly did not mean, and buildFromSchema refuses
// an empty repeatable anyway. Refusing here makes the message specific.
function requireNonEmptyList(value, label, op) {
  const items = Array.isArray(value) ? value.filter((v) => String(v ?? '').trim()) : [];
  if (!items.length) throw new Error(`five9_${op} requires action_payload.${label} as a non-empty array`);
  return items;
}

/**
 * Attached-list names for a campaign.
 *
 * Returns NULL when the lookup failed, [] when the campaign genuinely has no
 * lists. getOutboundCampaign is explicit about that distinction (it fetches
 * lists through a second getListsForCampaign call and leaves `lists` null if
 * that call throws), and collapsing the two would be a fail-open: a failed
 * read would report "nothing attached", which on a REPLACE means "nothing
 * would be detached" — exactly the reassurance you must not invent.
 */
async function attachedListNames(campaignName) {
  const cfg = await getOutboundCampaign(campaignName);
  const rows = cfg?.lists ?? cfg?.raw?.lists ?? null;
  if (rows === null || rows === undefined) return null;
  return asArray(rows).map((l) => String(l?.listName ?? l?.name ?? l ?? '').trim()).filter(Boolean);
}

/**
 * Skill names attached to a campaign. getOutboundCampaign does not normalize
 * skills, so this reads the raw block. Returns [] when the block carries no
 * skills — which for this API is indistinguishable from "none attached", and
 * is why the last-skill guard treats an unreadable set as unsafe rather than
 * as empty (see executeRemoveSkillsFromCampaign).
 */
async function attachedSkillNames(campaignName) {
  const cfg = await getOutboundCampaign(campaignName);
  const rows = cfg?.skills ?? cfg?.raw?.skills ?? null;
  if (rows === null || rows === undefined) return [];
  return asArray(rows).map((s) => String(s?.skillName ?? s?.name ?? s ?? '').trim()).filter(Boolean);
}

/* -- createOutboundCampaign -------------------------------------------- */

/**
 * five9_create_outbound_campaign — creates STOPPED, always.
 *
 * Two guards beyond the token:
 *   1. profileName must name an EXISTING campaign profile. Five9 will accept
 *      a campaign whose profile does not resolve, and the failure surfaces
 *      later as a campaign that will not dial.
 *   2. state is forced to NOT_RUNNING. A campaign that starts dialing the
 *      moment it is created has never been reviewed in the state it runs in;
 *      starting it is five9_start_campaign, separately approved.
 */
export function executeCreateOutboundCampaign(action) {
  const payload = action.action_payload || {};
  const name = String(payload.campaign_name || '').trim();
  const campaign = payload.campaign;
  if (!name) throw new Error('five9_create_outbound_campaign requires action_payload.campaign_name');
  if (!campaign || typeof campaign !== 'object' || Array.isArray(campaign)) {
    throw new Error('five9_create_outbound_campaign requires action_payload.campaign as an object');
  }

  return withFive9WriteGate(
    { action, subtype: 'create_outbound_campaign', entityType: 'five9_campaign', entityId: name },
    async (ctx) => {
      checkConfirmToken('create_outbound_campaign', payload);

      const { campaigns } = await getCampaigns();
      if (campaigns.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`REFUSED: a campaign named "${name}" already exists — campaign names key DNIS→source attribution, so they are never reused`);
      }

      const profileName = String(campaign.profileName ?? '').trim();
      if (!profileName) {
        throw new Error('REFUSED: create_outbound_campaign requires campaign.profileName — a campaign with no profile has no retry or dial settings and will not dial');
      }
      const { profiles } = await getCampaignProfiles();
      const known = asArray(profiles).map((p) => String(p?.name ?? '').trim().toLowerCase());
      if (!known.includes(profileName.toLowerCase())) {
        throw new Error(`REFUSED: campaign profile "${profileName}" does not exist (known: ${known.filter(Boolean).join(', ') || 'none readable'}) — Five9 accepts an unresolvable profile and the campaign then silently fails to dial`);
      }

      // Forced, not defaulted: an explicit RUNNING in the payload is a refusal,
      // not something to quietly overwrite.
      const requestedState = String(campaign.state ?? '').trim().toUpperCase();
      if (requestedState && requestedState !== 'NOT_RUNNING') {
        throw new Error(`REFUSED: create_outbound_campaign creates only with state=NOT_RUNNING (payload asked for "${campaign.state}") — start it with five9_start_campaign as a separately approved action`);
      }
      const submitted = { ...campaign, name, state: 'NOT_RUNNING' };
      ctx.event_extra.forced_state = 'NOT_RUNNING';

      await ctx.soap('createOutboundCampaign', buildFromSchema('outboundCampaign', submitted, { wrapper: 'campaign' }));
      if (ctx.dry_run) return { campaign: name, created: false, previewed: true, profileName };

      ctx.new_state = await getOutboundCampaign(name).catch(() => null);
      return { campaign: name, created: !!ctx.new_state, profileName, state: 'NOT_RUNNING' };
    },
  );
}

/* -- lists ------------------------------------------------------------- */

// tns:listState carries campaignName/listName plus optional dialing priority
// and ratio. Callers pass either a bare list name or the full struct.
function toListState(entry, campaignName, op) {
  if (typeof entry === 'string') {
    const listName = entry.trim();
    if (!listName) throw new Error(`five9_${op}: empty list name`);
    return { campaignName, listName };
  }
  if (!entry || typeof entry !== 'object') {
    throw new Error(`five9_${op}: each list must be a name or a { listName, dialingPriority?, dialingRatio?, priority? } object`);
  }
  const listName = String(entry.listName ?? entry.name ?? '').trim();
  if (!listName) throw new Error(`five9_${op}: each list entry requires listName`);
  const out = { campaignName, listName };
  for (const k of ['dialingPriority', 'dialingRatio', 'priority']) {
    if (entry[k] !== undefined && entry[k] !== null) out[k] = entry[k];
  }
  return out;
}

async function assertListsExist(names, op) {
  const { lists } = await getListsInfo();
  const known = new Set(asArray(lists).map((l) => String(l?.name ?? '').trim().toLowerCase()));
  const missing = names.filter((n) => !known.has(n.toLowerCase()));
  if (missing.length) {
    throw new Error(`REFUSED: five9_${op} names ${missing.length} list(s) that do not exist: ${missing.join(', ')} — Five9 accepts an unknown list silently and the campaign then dials nothing from it`);
  }
}

export function executeAddListsToCampaign(action) {
  return campaignCompositionOp(action, 'add_lists_to_campaign', {
    method: 'addListsToCampaign',
    build: async (ctx, campaign, payload) => {
      const entries = requireNonEmptyList(payload.lists, 'lists', 'add_lists_to_campaign');
      const states = entries.map((e) => toListState(e, campaign.name, 'add_lists_to_campaign'));
      await assertListsExist(states.map((s) => s.listName), 'add_lists_to_campaign');
      const before = await attachedListNames(campaign.name);
      ctx.event_extra.lists_before = before; // null = could not read, not "none attached"
      return {
        xml: buildFromSchema('addListsToCampaign', { campaignName: campaign.name, lists: states }),
        result: { lists_added: states.map((s) => s.listName), lists_before: before },
      };
    },
    readBack: (campaign) => getOutboundCampaign(campaign.name).catch(() => null),
  });
}

export function executeRemoveListsFromCampaign(action) {
  return campaignCompositionOp(action, 'remove_lists_from_campaign', {
    method: 'removeListsFromCampaign',
    build: async (ctx, campaign, payload) => {
      const entries = requireNonEmptyList(payload.lists, 'lists', 'remove_lists_from_campaign');
      const states = entries.map((e) => toListState(e, campaign.name, 'remove_lists_from_campaign'));
      const before = await attachedListNames(campaign.name);
      ctx.event_extra.lists_before = before; // null = could not read, not "none attached"
      return {
        xml: buildFromSchema('removeListsFromCampaign', { campaignName: campaign.name, lists: states }),
        result: { lists_removed: states.map((s) => s.listName), lists_before: before },
      };
    },
    readBack: (campaign) => getOutboundCampaign(campaign.name).catch(() => null),
  });
}

/**
 * five9_modify_campaign_lists — REPLACES the campaign's entire list set.
 *
 * Read-modify-write is not optional here: the op is a replace, so a payload
 * naming two lists on a campaign that currently carries five DETACHES the
 * other three. The read-before-write is captured on the audit event so the
 * detachment is visible in the record even when it was intended.
 */
export function executeModifyCampaignLists(action) {
  return campaignCompositionOp(action, 'modify_campaign_lists', {
    method: 'modifyCampaignLists',
    build: async (ctx, campaign, payload) => {
      const entries = requireNonEmptyList(payload.lists, 'lists', 'modify_campaign_lists');
      const states = entries.map((e) => toListState(e, campaign.name, 'modify_campaign_lists'));
      await assertListsExist(states.map((s) => s.listName), 'modify_campaign_lists');

      const before = await attachedListNames(campaign.name);
      // A REPLACE whose current set could not be read is a replace whose blast
      // radius is unknown. Refusing is the only honest option: reporting an
      // empty lists_detached here would tell the approver nothing is being
      // detached, which is precisely the thing we cannot establish.
      if (before === null) {
        throw new Error(`REFUSED: could not read the lists currently attached to "${campaign.name}" — modifyCampaignLists REPLACES the whole set, so proceeding would detach an unknown number of lists`);
      }
      const submitted = states.map((s) => s.listName);
      const detached = before.filter((b) => !submitted.some((s) => s.toLowerCase() === b.toLowerCase()));
      ctx.event_extra.lists_before = before;
      ctx.event_extra.lists_detached = detached;
      ctx.event_extra.replace_semantics = 'modifyCampaignLists REPLACES the whole list set — anything absent from the payload is detached';

      return {
        xml: buildFromSchema('modifyCampaignLists', { campaignName: campaign.name, lists: states }),
        result: { lists_before: before, lists_after_intended: submitted, lists_detached: detached },
      };
    },
    readBack: (campaign) => getOutboundCampaign(campaign.name).catch(() => null),
  });
}

/* -- skills ------------------------------------------------------------ */

async function assertSkillsExist(names, op) {
  const { skills } = await getSkills();
  const known = new Set(asArray(skills).map((s) => String(s?.name ?? '').trim().toLowerCase()));
  const missing = names.filter((n) => !known.has(n.toLowerCase()));
  if (missing.length) {
    throw new Error(`REFUSED: five9_${op} names ${missing.length} skill(s) that do not exist: ${missing.join(', ')}`);
  }
}

export function executeAddSkillsToCampaign(action) {
  return campaignCompositionOp(action, 'add_skills_to_campaign', {
    method: 'addSkillsToCampaign',
    build: async (ctx, campaign, payload) => {
      const skills = requireNonEmptyList(payload.skills, 'skills', 'add_skills_to_campaign');
      await assertSkillsExist(skills, 'add_skills_to_campaign');
      const before = await attachedSkillNames(campaign.name);
      ctx.event_extra.skills_before = before;
      return {
        xml: buildFromSchema('addSkillsToCampaign', { campaignName: campaign.name, skills }),
        result: { skills_added: skills, skills_before: before },
      };
    },
    readBack: (campaign) => getOutboundCampaign(campaign.name).catch(() => null),
  });
}

/**
 * five9_remove_skills_from_campaign — the one composition op that is allowed
 * to run against a RUNNING campaign, and the one with an extra guard.
 *
 * Removing SOME skills from a live campaign is a routing change. Removing the
 * LAST one strands every call already queued on it: there is no skill left to
 * route them to, and they sit until they abandon. So this refuses when the
 * removal would empty the skill set on a RUNNING campaign, and allows the
 * same removal once the campaign is stopped.
 */
export function executeRemoveSkillsFromCampaign(action) {
  return campaignCompositionOp(action, 'remove_skills_from_campaign', {
    method: 'removeSkillsFromCampaign',
    refuseWhileRunning: false, // the LAST-skill guard below is the real check
    build: async (ctx, campaign, payload) => {
      const skills = requireNonEmptyList(payload.skills, 'skills', 'remove_skills_from_campaign');
      const before = await attachedSkillNames(campaign.name);
      const lower = new Set(skills.map((s) => s.toLowerCase()));
      const remaining = before.filter((s) => !lower.has(s.toLowerCase()));
      ctx.event_extra.skills_before = before;
      ctx.event_extra.skills_remaining = remaining;

      if (String(campaign.state || '').toUpperCase() === 'RUNNING') {
        // Fail SAFE, not open: an unreadable skill set on a live campaign
        // means we cannot prove this removal leaves anything to route to.
        if (!before.length) {
          throw new Error(`REFUSED: could not read the skills currently on RUNNING campaign "${campaign.name}" — the last-skill guard cannot be evaluated, and a removal that strands every queued call is not something to take on trust. Stop the campaign first.`);
        }
        if (!remaining.length) {
          throw new Error(`REFUSED: removing ${skills.join(', ')} would leave "${campaign.name}" with NO skills while it is RUNNING — every call already queued on it would be stranded with nothing to route to. Stop the campaign first.`);
        }
      }
      return {
        xml: buildFromSchema('removeSkillsFromCampaign', { campaignName: campaign.name, skills }),
        result: { skills_removed: skills, skills_before: before, skills_remaining: remaining },
      };
    },
    readBack: (campaign) => getOutboundCampaign(campaign.name).catch(() => null),
  });
}

/* -- dispositions ------------------------------------------------------ */

async function assertDispositionsExist(names, op) {
  const { dispositions } = await getDispositions();
  const known = new Set(asArray(dispositions).map((d) => String(d?.name ?? '').trim().toLowerCase()));
  const missing = names.filter((n) => !known.has(n.toLowerCase()));
  if (missing.length) {
    throw new Error(`REFUSED: five9_${op} names ${missing.length} disposition(s) that do not exist: ${missing.join(', ')}`);
  }
}

/**
 * five9_add_dispositions_to_campaign — the one op in this tranche with no
 * RUNNING refusal.
 *
 * Adding a disposition is additive: it widens what an agent can select and
 * cannot change how any existing call is counted. That is a different act
 * from removing one, which is why the pair is not symmetric.
 */
export function executeAddDispositionsToCampaign(action) {
  return campaignCompositionOp(action, 'add_dispositions_to_campaign', {
    method: 'addDispositionsToCampaign',
    refuseWhileRunning: false,
    build: async (ctx, campaign, payload) => {
      const dispositions = requireNonEmptyList(payload.dispositions, 'dispositions', 'add_dispositions_to_campaign');
      await assertDispositionsExist(dispositions, 'add_dispositions_to_campaign');
      const body = { campaignName: campaign.name, dispositions };
      if (payload.is_skip_preview_disposition !== undefined) {
        body.isSkipPreviewDisposition = payload.is_skip_preview_disposition === true;
      }
      return {
        xml: buildFromSchema('addDispositionsToCampaign', body),
        result: { dispositions_added: dispositions },
      };
    },
    readBack: (campaign) => getOutboundCampaign(campaign.name).catch(() => null),
  });
}

/**
 * five9_remove_dispositions_from_campaign — BUILT, DELIBERATELY UNREGISTERED.
 *
 * The Phase H PR4 ruling requires this op to refuse any disposition named in
 * the CC payroll bonus mapping, because removing one silently changes what
 * the call centre gets paid for. That guard needs an authoritative list of
 * which dispositions are payroll-relevant.
 *
 * NO SUCH LIST EXISTS. Searched 2026-08-21: no Bonus_Structure.md in any of
 * the six repos, no payroll/bonus/commission table in Supabase (only
 * lp_dispositions, which carries category / is_recoverable / reactivation_
 * track and nothing about pay), and no CC payroll audit script. The two
 * authoritative Notion documents — "Call Center Bonus Structure (weekly
 * payroll)" and "Call Center Payroll — Weekly (do this every Monday)" —
 * describe the bonus math in full and derive ALL of it from three Lead
 * Perfection reports (Security > Export > Call Center > Setter Payroll, and
 * two Report Generator reports). Payroll is computed from LP demo counts,
 * not from Five9 dispositions. The only disposition either document names is
 * "no-rehash", and it is named precisely because the reports MISCOUNT it —
 * and the two documents contradict each other on which direction to correct
 * ("added to the demo-count/bonus totals" vs "no-rehash leads removed from
 * setter bonus").
 *
 * So the guard has no source. Per the ruling: build it, leave it
 * unregistered. A guard keyed on a made-up list would read as protection
 * while protecting nothing — worse than no op at all, because the next person
 * would trust it.
 *
 * TO REGISTER: define the mapping somewhere authoritative (a Supabase table
 * keyed on Five9 disposition name is the obvious home, since it has to be
 * queryable at execute time), point PAYROLL_PROTECTED_DISPOSITIONS at it, add
 * the action type to FIVE9_WRITE_OPS / ACTION_HANDLERS / the approval test,
 * and flip the OP_CLASSIFICATION row from `not-built` to `shipped`.
 */
export const PAYROLL_PROTECTED_DISPOSITIONS = Object.freeze({
  available: false,
  source: null,
  names: Object.freeze([]),
  reason: 'No authoritative CC payroll disposition mapping exists as of 2026-08-21. Payroll is computed from Lead Perfection reports, not Five9 dispositions; the only disposition the payroll documents name is "no-rehash", and they contradict each other on how it is corrected.',
});

export function checkPayrollDispositions(names, mapping = PAYROLL_PROTECTED_DISPOSITIONS) {
  if (!mapping?.available) {
    return {
      ok: false,
      unenforceable: true,
      violations: [`the CC payroll disposition guard has no authoritative source — ${mapping?.reason ?? 'mapping unavailable'}`],
    };
  }
  const protectedSet = new Set(mapping.names.map((n) => String(n).toLowerCase()));
  const hits = names.filter((n) => protectedSet.has(String(n).toLowerCase()));
  return {
    ok: hits.length === 0,
    unenforceable: false,
    violations: hits.map((n) => `"${n}" is in the CC payroll bonus mapping (${mapping.source}) — removing it changes what the floor is paid for`),
  };
}

export function executeRemoveDispositionsFromCampaign(action) {
  return campaignCompositionOp(action, 'remove_dispositions_from_campaign', {
    method: 'removeDispositionsFromCampaign',
    refuseWhileRunning: false,
    build: async (ctx, campaign, payload) => {
      const dispositions = requireNonEmptyList(payload.dispositions, 'dispositions', 'remove_dispositions_from_campaign');
      const verdict = checkPayrollDispositions(dispositions);
      ctx.event_extra.payroll_check = verdict;
      if (!verdict.ok) {
        throw new Error(`REFUSED: ${verdict.violations.join('; ')}`);
      }
      return {
        xml: buildFromSchema('removeDispositionsFromCampaign', { campaignName: campaign.name, dispositions }),
        result: { dispositions_removed: dispositions, payroll_check: verdict },
      };
    },
    readBack: (campaign) => getOutboundCampaign(campaign.name).catch(() => null),
  });
}

/**
 * five9_reset_campaign_dispositions — same blast radius as Guardrail 11,
 * scoped to dispositions: clearing them makes every record carrying one
 * re-dialable. Refuses while RUNNING for exactly that reason.
 *
 * `after` / `before` are optional dateTime bounds that narrow the reset to a
 * window; passing neither resets the whole campaign's dispositions.
 */
export function executeResetCampaignDispositions(action) {
  return campaignCompositionOp(action, 'reset_campaign_dispositions', {
    method: 'resetCampaignDispositions',
    build: async (ctx, campaign, payload) => {
      const dispositions = requireNonEmptyList(payload.dispositions, 'dispositions', 'reset_campaign_dispositions');
      await assertDispositionsExist(dispositions, 'reset_campaign_dispositions');
      const body = { campaignName: campaign.name, dispositions };
      if (payload.after) body.after = payload.after;
      if (payload.before) body.before = payload.before;
      ctx.event_extra.window = { after: payload.after ?? null, before: payload.before ?? null };
      if (!payload.after && !payload.before) {
        ctx.event_extra.window_note = 'no after/before bound — every record carrying these dispositions becomes re-dialable';
      }
      return {
        xml: buildFromSchema('resetCampaignDispositions', body),
        result: { dispositions_reset: dispositions, after: payload.after ?? null, before: payload.before ?? null },
      };
    },
  });
}

/* -- strategies -------------------------------------------------------- */

/**
 * five9_set_campaign_strategies — dial pacing. This is the compliance-exposed
 * dimension of a campaign (it governs how aggressively Five9 dials against
 * agent availability, which is what abandonment rate is downstream of), so it
 * refuses while RUNNING rather than re-pacing a live campaign mid-shift.
 */
export function executeSetCampaignStrategies(action) {
  return campaignCompositionOp(action, 'set_campaign_strategies', {
    method: 'setCampaignStrategies',
    build: async (ctx, campaign, payload) => {
      const strategies = payload.campaign_strategies ?? payload.strategies;
      if (!strategies || typeof strategies !== 'object') {
        throw new Error('five9_set_campaign_strategies requires action_payload.campaign_strategies (a tns:campaignStrategies object, i.e. { strategies: [...] })');
      }
      const wrapped = Array.isArray(strategies) ? { strategies } : strategies;
      if (!asArray(wrapped.strategies).length) {
        throw new Error('five9_set_campaign_strategies requires at least one strategy in campaign_strategies.strategies');
      }
      const before = await getCampaignStrategies(campaign.name).catch(() => null);
      ctx.event_extra.strategies_before = before;
      ctx.event_extra.replace_semantics = 'setCampaignStrategies REPLACES the campaign strategy set';
      return {
        xml: buildFromSchema('setCampaignStrategies', { campaignName: campaign.name, campaignStrategies: wrapped }),
        result: { strategy_count: asArray(wrapped.strategies).length, strategies_before: before },
      };
    },
    readBack: (campaign) => getCampaignStrategies(campaign.name).catch(() => null),
  });
}

/* -- lists: create + position ------------------------------------------ */

/**
 * five9_create_list — the only `enabled` op in this tranche.
 *
 * A new list is EMPTY and attached to NOTHING: it cannot dial anyone, change
 * what any campaign dials, or affect a live call. approve_action alone is the
 * right amount of ceremony. Populating it (five9_add_records_to_list) and
 * attaching it (five9_add_lists_to_campaign) are the gated steps.
 */
export function executeCreateList(action) {
  const payload = action.action_payload || {};
  const listName = String(payload.list_name || '').trim();
  if (!listName) throw new Error('five9_create_list requires action_payload.list_name');

  return withFive9WriteGate(
    { action, subtype: 'create_list', entityType: 'five9_list', entityId: listName },
    async (ctx) => {
      const { lists } = await getListsInfo();
      const existing = asArray(lists).find((l) => String(l?.name ?? '').toLowerCase() === listName.toLowerCase());
      if (existing) {
        // Already-satisfied, not dangerous: skip rather than refuse.
        return { skipped: true, reason: 'list_already_exists', list: existing.name, size: existing.size };
      }
      ctx.previous_state = null;

      await ctx.soap('createList', buildFromSchema('createList', { listName }));
      if (ctx.dry_run) return { list: listName, created: false, previewed: true };

      const after = await getListsInfo();
      ctx.new_state = asArray(after.lists).find((l) => String(l?.name ?? '').toLowerCase() === listName.toLowerCase()) ?? null;
      return { list: listName, created: !!ctx.new_state };
    },
  );
}

/**
 * five9_reset_list_position — rewinds a campaign's dialing position so its
 * lists are worked from the top again.
 *
 * SCHEMA CONTRADICTION, REPORTED. The PR4 handoff specified "confirm_token on
 * the LIST name; refuse while any campaign using the list is RUNNING". The
 * v13 schema says resetListPosition takes exactly one argument and it is
 * <campaignName> — there is no list argument to key a list-name token on, and
 * "any campaign using the list" is not a set this operation can address. The
 * op is campaign-scoped, so the token restates the CAMPAIGN and the guard
 * refuses that campaign while it is RUNNING. Standing rule: the schema wins.
 *
 * The intent survives the correction — rewinding position on a live campaign
 * re-dials records the floor already worked, which is exactly what the
 * handoff's RUNNING refusal was protecting against.
 */
export function executeResetListPosition(action) {
  return campaignCompositionOp(action, 'reset_list_position', {
    method: 'resetListPosition',
    build: async (ctx, campaign) => {
      const lists = await attachedListNames(campaign.name);
      ctx.event_extra.lists_affected = lists; // null = could not read, not "none attached"
      return {
        xml: buildFromSchema('resetListPosition', { campaignName: campaign.name }),
        result: { lists_affected: lists },
      };
    },
  });
}
