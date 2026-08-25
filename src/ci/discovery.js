/**
 * Call Intelligence discovery — src/ci/discovery.js
 *
 * Pulls the Five9 Call Log for a window, evaluates eligibility deterministically,
 * and upserts one ci_calls row per call. Idempotent by construction: the upsert
 * keys on five9_call_id and NEVER overwrites an existing row, so re-running a
 * window (reconciliation, a retried n8n tick, an overlapping backfill) is a
 * no-op rather than a reset of in-flight pipeline state.
 *
 * THE 5000-ROW CAP. The saved report truncates at 5000 rows and does not say
 * so — you just get 5000 and no error. Nothing else in this repo handles it.
 * So: pull in windows, and ASSERT the returned row count is under the cap. A
 * window that hits the cap is split and re-pulled rather than accepted, because
 * accepting it means silently losing calls with no trace.
 *
 * TIMEZONE. Report criteria and report output are both Pacific; ci_calls stores
 * UTC timestamptz. All conversion goes through src/ci/time.js — see the
 * three-zone note there. A row whose timestamp will not parse is recorded
 * ineligible with a reason, never given a guessed call_start.
 *
 * TEAM RESOLUTION, in this order: the AGENT NAME suffix (teams.js), then
 * ci_agent_map by login, then 'unknown'. The suffix is first because it is
 * what the dialer recorded against the call and it is how partner agents are
 * identified; the map is the fallback for Reece's in-house agents, whose names
 * carry no suffix at all. Both maps are read ONCE per run and threaded down —
 * a per-call lookup would be one round trip per row, 5000 on a capped window.
 */

import supabase from '../supabase.js';
import { runReportAndWait } from '../five9-admin.js';
import { getConfig } from './config.js';
import {
  splitWindows,
  toPacificCriteriaString,
  parsePacificReportTimestamp,
  last10,
  last4,
} from './time.js';
import { teamFromName, stripTeamSuffix, normalizeAgentField } from './teams.js';

const LOG = '[CIDiscovery]';

/** Five9 truncates the saved report here, silently. */
export const REPORT_ROW_CAP = 5000;

/** Report identity — the saved report this pipeline reads. */
export const REPORT_FOLDER = 'Call Log Reports';
export const REPORT_NAME = 'Call Log';

/**
 * Column-name candidates, lowercased. Five9 saved reports are configured
 * per-domain and the header text is not guaranteed, so each logical field
 * accepts several spellings. An unresolved REQUIRED column is a hard error at
 * the top of the pull — better one loud failure than 5000 rows of nulls.
 */
const COLUMN_ALIASES = {
  callId: ['call id', 'callid'],
  sessionId: ['session id', 'sessionid'],
  timestamp: ['timestamp', 'date', 'call time', 'start time', 'datetime'],
  duration: ['call time', 'duration', 'talk time', 'call duration'],
  direction: ['call type', 'calltype', 'direction'],
  ani: ['ani', 'caller id', 'from'],
  dnis: ['dnis', 'to', 'number dialed'],
  campaign: ['campaign'],
  skill: ['skill', 'skill name'],
  disposition: ['disposition', 'disposition name'],
  // TWO DISTINCT COLUMNS, verified live 2026-08-21. AGENT is the Five9 login
  // ('jmanieri'); AGENT NAME is the display name ('John Manieri', and on
  // partner agents 'Shari Walker - LF'). They are not interchangeable: the
  // login is what joins to ci_agent_map, and the display name is what carries
  // the team suffix. Listing 'agent' under agentName would silently resolve
  // the display field to the login column.
  agentUsername: ['agent'],
  agentName: ['agent name'],
  // NOTE: this domain's Call Log has NO agent-id column, so agent_five9_id
  // cannot be read from the report — the login is the join key instead.
  agentId: ['agent id', 'agentid'],
  recordings: ['recordings', 'recording'],
};

/** Required to key and time a call; without these the row is unusable. */
const REQUIRED = ['callId', 'timestamp'];

/**
 * Resolve report headers to column indexes. Pure — exported for tests.
 * @returns {{index: object, missing: string[]}}
 */
export function resolveColumns(columns) {
  const lower = (columns || []).map((c) => String(c ?? '').trim().toLowerCase());
  const index = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    // Exact alias match first, then a contains-match, so 'CALL ID' and
    // 'Call ID (unique)' both resolve without matching 'Call Id Something Else'
    // ahead of a better candidate.
    let at = lower.findIndex((c) => aliases.includes(c));
    if (at < 0) at = lower.findIndex((c) => aliases.some((a) => c === a || c.startsWith(`${a} `)));
    if (at >= 0) index[field] = at;
  }
  const missing = REQUIRED.filter((f) => index[f] === undefined);
  return { index, missing };
}

/** Duration cells arrive as 'HH:MM:SS', 'MM:SS', or plain seconds. */
export function durationToSeconds(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const parts = s.split(':').map((p) => parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

/**
 * Parse the RECORDINGS column: space-separated 'HH:MM:SS(M:SS)' segments, one
 * per recording. Presence/duration metadata only — it serves no audio — but it
 * is the authoritative completeness check for reconciliation: a call with
 * segments and no ingested audio is a gap, and a call with none is not.
 */
export function parseRecordingSegments(text) {
  const s = String(text ?? '').trim();
  if (!s) return [];
  const out = [];
  for (const m of s.matchAll(/(\d{1,2}:\d{2}:\d{2})\s*\(([^)]*)\)/g)) {
    out.push({ at: m[1], duration: m[2] });
  }
  return out;
}

/**
 * Zip a positional report row into a named object using a resolved index.
 *
 * A JSON null must come out as null, not the string 'null'. The live Call Log
 * returns null (not '') for every empty cell — AGENT NAME on an agentless leg,
 * DISPOSITION on a transfer leg, RECORDINGS on a no-answer — so a bare
 * String() here would write the four characters "null" into ci_calls, where it
 * is truthy and sails past every emptiness check downstream.
 */
export function zipRow(row, index) {
  const out = {};
  for (const [field, at] of Object.entries(index)) {
    const cell = row[at];
    out[field] = cell === undefined || cell === null ? null : String(cell).trim();
  }
  return out;
}

/**
 * Group report rows by Call ID. Two rows sharing a Call ID is a successful
 * third-party transfer (verified live 2026-08-18: the second leg carries CALL
 * TYPE '3rd party transfer'). The group becomes ONE ci_calls row with
 * was_transferred=true and both raw rows retained.
 */
export function groupByCallId(rows) {
  const groups = new Map();
  for (const r of rows) {
    const id = r.callId;
    if (!id) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(r);
  }
  return groups;
}

/** Does any leg in the group look like a transfer leg? */
export function isTransferGroup(legs) {
  if (legs.length > 1) return true;
  return legs.some((l) => /3rd party transfer|third party transfer/i.test(String(l.direction ?? '')));
}

/**
 * Deterministic eligibility (handoff "Eligibility"). Evaluated at discovery,
 * never re-litigated later.
 *
 * Eligible = duration >= floor AND an agent is present AND the campaign map
 * says eligible AND the disposition is not excluded for that campaign.
 *
 * Ineligible calls are RECORDED as skipped with a reason — never dropped —
 * so a wrong floor or a bad map entry is visible instead of invisible.
 *
 * @returns {{eligible: boolean, reason: string|null}}
 */
export function evaluateEligibility(call, campaignRow, cfg) {
  if (!Number.isFinite(call.duration_seconds)) {
    return { eligible: false, reason: 'no_duration' };
  }
  if (call.duration_seconds < cfg.minSeconds) {
    return { eligible: false, reason: 'below_min_seconds' };
  }
  // Transfer legs are agentless by nature and are still in scope — they
  // classify by IVR module instead. Only a NON-transfer call with no agent is
  // ineligible (a queue abandon, an IVR-only call).
  if (!call.agent_name && !call.agent_username && !call.agent_five9_id && !call.was_transferred) {
    return { eligible: false, reason: 'no_agent' };
  }
  if (campaignRow && campaignRow.eligible === false) {
    return { eligible: false, reason: 'campaign_not_eligible' };
  }
  if (campaignRow && Array.isArray(campaignRow.excluded_dispositions) && call.disposition) {
    if (campaignRow.excluded_dispositions.includes(call.disposition)) {
      return { eligible: false, reason: 'disposition_excluded' };
    }
  }
  return { eligible: true, reason: null };
}

/**
 * The ci_agent_map fallback: login → team.
 *
 * Pure, and deliberately NOT in teams.js — that module owns the STRING rules
 * (a name's suffix, an email's domain) and has no opinion about how a map is
 * shaped or loaded. This one is about the loaded map, so it lives next to
 * loadAgentMap() where the two can only ever be changed together.
 *
 * BOTH SIDES ARE LOWERCASED. The live map holds mixed case as seeded from the
 * Five9 user records — 'Bleadbeater2254', 'Mcole2321',
 * 'C.garner@reecewindows.com' — while the call log's AGENT column is the login
 * as typed. Case-sensitive lookup would silently miss those agents and send
 * every one of their calls to review, which is exactly the failure this
 * fallback exists to end.
 *
 * A row whose team is null/empty resolves to null, so the caller falls through
 * to 'unknown' rather than writing an empty team.
 */
export function teamFromAgentMap(agentMap, agentUsername) {
  const key = String(agentUsername ?? '').trim().toLowerCase();
  if (!key || typeof agentMap?.get !== 'function') return null;
  const team = String(agentMap.get(key)?.team ?? '').trim();
  return team || null;
}

/**
 * WHICH NUMBER ON THIS CALL BELONGS TO THE CUSTOMER.
 *
 * ══ INBOUND IS THE SPECIAL CASE, NOT THE DEFAULT ══
 * On an INBOUND call the customer dialled us, so the ANI is theirs. On
 * everything else — Outbound, Manual, Preview — the dialer placed the call, so
 * the ANI is a REECE local-presence caller ID and the DNIS is the customer.
 * Verified live 2026-08-24:
 *   300000010259677  Manual   ani 8555768943 (Reece toll-free)  dnis 9125520152
 *   300000010259676  Preview  ani 3213429858                    dnis 4436170733
 *   300000010259655  Preview  ani 3527223289                    dnis 3212765070
 *
 * This function previously did not exist and buildCallRow took the ANI
 * unconditionally. That was wrong on 13,944 of 15,114 live rows (92%), and it
 * was wrong in two directions at once: the recording join searched a Reece
 * number and found nothing (Five9 names recording files after the number
 * DIALLED), and — the dangerous one — customer_phone_e164 fed the phone-tier
 * LP/GHL match, so an outbound note either failed to match or attached to
 * whatever record happens to hold that Reece caller ID. Silently.
 *
 * ══ AN UNRECOGNISED DIRECTION TAKES THE OUTBOUND BRANCH ══
 * Treating an unknown direction as inbound is precisely what produced the bug,
 * so the test is `contains 'inbound'` and EVERYTHING else falls through to
 * DNIS. That is deliberate on the live values this does not name: '3rd party
 * conference' and 'Internal' both take the DNIS, as does any value Five9 adds
 * later. 'Inbound Voicemail' contains 'inbound' and correctly takes the ANI.
 *
 * ══ THE FALLBACK IS ONE-WAY ══
 * A non-inbound call with no DNIS falls back to the ANI — a poor answer, but
 * the only number the call has. Inbound does NOT fall back to the DNIS: a
 * withheld caller ID leaves the ANI empty, and the DNIS on an inbound call is
 * REECE'S OWN inbound number. Falling back there would write a Reece number
 * into customer_phone and hand the matcher a company line to resolve, which is
 * the same class of failure this function exists to end. Null is the honest
 * answer.
 *
 * Pure, and takes anything carrying {direction, ani, dnis} — a zipped report
 * leg here, a ci_calls row in scripts/repair-ci-customer-phone.js. Both callers
 * MUST use this function: two implementations of "which number is the
 * customer" would be two chances to disagree, and the disagreement would be
 * invisible until a note landed on a stranger's record.
 *
 * @param {{direction?: string, ani?: string, dnis?: string}} row
 * @returns {string|null} the customer's number as stored, raw
 */
export function customerNumberFor(row) {
  const clean = (v) => {
    const s = String(v ?? '').trim();
    return s || null;
  };
  const ani = clean(row?.ani);
  const dnis = clean(row?.dnis);
  if (String(row?.direction ?? '').toLowerCase().includes('inbound')) return ani;
  return dnis || ani;
}

/** The '+1' form of whatever customerNumberFor() chose — never of a different field. */
export function customerE164For(row) {
  const ten = last10(customerNumberFor(row));
  return ten ? `+1${ten}` : null;
}

/**
 * Build a ci_calls row from a grouped set of report legs. Pure — exported so
 * the whole shaping path is testable without Five9 or Supabase.
 *
 * The agent map is an ARGUMENT, never a read from here: this function shapes
 * up to 5000 rows per window, and a Supabase call inside it would be one round
 * trip per call. It is also what keeps the whole shaping path testable.
 *
 * @param {Array}  legs         report rows sharing one Call ID
 * @param {object} campaignRow  ci_campaign_map row, or null
 * @param {object} cfg          resolved CI config
 * @param {Map}    agentMap     login (LOWERCASED) → ci_agent_map row
 * @returns {{row: object|null, reject: string|null}}
 */
export function buildCallRow(legs, campaignRow, cfg, agentMap = null) {
  const primary = legs.find((l) => !/3rd party transfer|third party transfer/i.test(String(l.direction ?? ''))) || legs[0];

  const startedAt = parsePacificReportTimestamp(primary.timestamp);
  if (!startedAt) {
    // No usable time means no join, no window, no ordering. Reject loudly
    // rather than inventing one.
    return { row: null, reject: 'unparseable_timestamp' };
  }

  // A no-answer dial has CALL TIME '00:00:00' — a real, parsed duration of
  // zero, NOT a missing one. Collapsing the two ('|| null') would file every
  // routine no-answer under ineligible_reason 'no_duration', which is the
  // bucket that means "the report gave us something we could not parse". The
  // review queue would fill with no-answers and a genuine parse regression
  // would be invisible inside them. Empty list → null; otherwise the max,
  // zero included.
  const legSeconds = legs
    .map((l) => durationToSeconds(l.duration))
    .filter((n) => Number.isFinite(n));
  const durationSeconds = legSeconds.length ? Math.max(...legSeconds) : null;

  const segments = legs.flatMap((l) => parseRecordingSegments(l.recordings));
  const wasTransferred = isTransferGroup(legs);

  // Five9 writes '[None]' for an agentless leg rather than leaving the cell
  // empty. Left raw it is a truthy "name" that sails past the no_agent check.
  const agentUsername = normalizeAgentField(primary.agentUsername);
  const agentDisplay = normalizeAgentField(primary.agentName);

  // ── TEAM: suffix, then the agent map, then 'unknown' ─────────────────────
  //
  // The display name carries the team suffix on partner agents ('Shari
  // Walker - LF'), which is handoff decision #5's rule and the most direct
  // signal available at discovery. Store the person's name without the
  // suffix so it matches the seeded ci_agent_map row.
  const suffixTeam = teamFromName(agentDisplay);

  // The suffix STAYS FIRST. It is what the dialer records against this
  // specific call, and it is how partner agents are identified; the map is a
  // fallback for agents the dialer gives no suffix, not an override of what
  // the dialer said.
  //
  // Without this fallback every Reece in-house agent — who has no suffix at
  // all — landed at 'unknown' and was flagged unknown_team into review.
  // Measured live 2026-08-24 before the change: of 31 eligible calls, 15 sat
  // at 'unknown', 10 of them belonging to five named Reece agents whose
  // ci_agent_map rows said 'reece' the whole time.
  const mappedTeam = teamFromAgentMap(agentMap, agentUsername);

  const row = {
    five9_call_id: primary.callId,
    five9_session_id: primary.sessionId || null,
    call_start: startedAt.toISOString(),
    duration_seconds: durationSeconds,
    direction: primary.direction || null,
    // ani and dnis stay RAW and unchanged — they are the audit trail, and the
    // repair script recomputes the two derived columns from them.
    ani: primary.ani || null,
    dnis: primary.dnis || null,
    // Both derived columns come from the SAME helper, so they can never name
    // different fields of the same call.
    customer_phone: customerNumberFor(primary),
    customer_phone_e164: customerE164For(primary),
    campaign: primary.campaign || null,
    skill: primary.skill || null,
    disposition: primary.disposition || null,
    agent_five9_id: normalizeAgentField(primary.agentId),
    agent_username: agentUsername,
    agent_name: agentDisplay ? stripTeamSuffix(agentDisplay) : null,
    team: suffixTeam || mappedTeam || 'unknown',
    was_transferred: wasTransferred,
    raw_metadata: {
      legs,
      recording_segments: segments,
      expected_recording_count: segments.length,
      // THE RAW CELL, kept deliberately. parseRecordingSegments reads the
      // 'HH:MM:SS(M:SS)' timing form and discards everything else, so if Five9
      // ever changes what this column carries — a recording id or URL once the
      // API user has recording permission, for instance — the parse would
      // silently yield [] and we would be guessing about why. Keeping the
      // string turns that into a query. It is short (a few dozen bytes) and
      // holds no customer data: times and durations only.
      recordings_raw: legs.map((l) => l.recordings).filter(Boolean).join(' | ') || null,
    },
  };

  const { eligible, reason } = evaluateEligibility(row, campaignRow, cfg);
  row.eligible = eligible;
  row.ineligible_reason = reason;
  // Ineligible calls park in 'skipped' immediately — they are recorded, and
  // no worker will ever claim them.
  row.status = eligible ? 'discovered' : 'skipped';

  return { row, reject: null };
}

/**
 * Pull ONE window and return its shaped rows, splitting recursively if the
 * report comes back at the row cap.
 *
 * @returns {Promise<{rows: object[], windows: number, capHits: number}>}
 */
export async function pullWindow(from, to, { cfg, campaignMap, agentMap = null, deps = {}, depth = 0 } = {}) {
  const runReport = deps.runReportAndWait || runReportAndWait;
  const result = await runReport({
    folder: REPORT_FOLDER,
    name: REPORT_NAME,
    startIso: toPacificCriteriaString(from),
    endIso: toPacificCriteriaString(to),
  });

  if (!result?.done) {
    throw new Error(
      `report did not finish for ${from.toISOString()}..${to.toISOString()}` +
      `${result?.identifier ? ` (identifier ${result.identifier})` : ''}`,
    );
  }

  const { index, missing } = resolveColumns(result.columns);
  if (missing.length) {
    throw new Error(`Call Log report is missing required column(s): ${missing.join(', ')} — headers were [${(result.columns || []).join(', ')}]`);
  }

  const raw = (result.rows || []).map((r) => zipRow(r, index));

  // THE CAP. At or above it the report truncated; splitting is the only way to
  // see what was cut. Depth-limited so a genuinely dense minute cannot recurse
  // forever — at the floor we surface it rather than pretending.
  if (raw.length >= REPORT_ROW_CAP) {
    const spanMs = to.getTime() - from.getTime();
    if (depth >= 6 || spanMs <= 60 * 1000) {
      throw new Error(
        `Call Log hit the ${REPORT_ROW_CAP}-row cap on a ${Math.round(spanMs / 1000)}s window ` +
        `(${from.toISOString()}..${to.toISOString()}) and cannot be split further — rows are being lost`,
      );
    }
    const mid = new Date(from.getTime() + Math.floor(spanMs / 2));
    console.warn(`${LOG} window ${from.toISOString()}..${to.toISOString()} hit the ${REPORT_ROW_CAP}-row cap — splitting`);
    const left = await pullWindow(from, mid, { cfg, campaignMap, agentMap, deps, depth: depth + 1 });
    const right = await pullWindow(mid, to, { cfg, campaignMap, agentMap, deps, depth: depth + 1 });
    return {
      rows: [...left.rows, ...right.rows],
      windows: left.windows + right.windows,
      capHits: 1 + left.capHits + right.capHits,
    };
  }

  const rows = [];
  for (const [callId, legs] of groupByCallId(raw)) {
    const campaignRow = campaignMap?.get(legs[0].campaign) || null;
    const { row, reject } = buildCallRow(legs, campaignRow, cfg, agentMap);
    if (reject) {
      console.warn(`${LOG} call ${callId} rejected at shaping: ${reject}`);
      continue;
    }
    rows.push(row);
  }

  return { rows, windows: 1, capHits: 0 };
}

/** Load ci_campaign_map into a Map keyed by campaign name (exact, never folded). */
export async function loadCampaignMap(db = supabase) {
  const { data, error } = await db.from('ci_campaign_map').select('*');
  if (error) throw new Error(`ci_campaign_map read failed: ${error.message}`);
  return new Map((data || []).map((r) => [r.campaign, r]));
}

/**
 * Load ci_agent_map into a Map keyed by LOWERCASED agent_username.
 *
 * Read ONCE per discovery run and threaded down, exactly as the campaign map
 * is — the alternative is a query per call, and a 5000-row window would make
 * 5000 of them.
 *
 * The key is folded to lowercase because the map holds the login as Five9's
 * user record spells it (mixed case: 'Bleadbeater2254', 'Mcole2321') while the
 * call log carries the login as typed. teamFromAgentMap() folds the lookup
 * side to match. Rows with no username are skipped rather than keyed on '' —
 * one such row would otherwise become the answer for every agentless leg.
 */
export async function loadAgentMap(db = supabase) {
  const { data, error } = await db.from('ci_agent_map').select('*');
  if (error) throw new Error(`ci_agent_map read failed: ${error.message}`);
  const map = new Map();
  for (const r of data || []) {
    const key = String(r?.agent_username ?? '').trim().toLowerCase();
    if (!key) continue;
    map.set(key, r);
  }
  return map;
}

/**
 * Discover calls in [from, to) and upsert them into ci_calls.
 *
 * IDEMPOTENCY: ignoreDuplicates keeps existing rows untouched. A call already
 * part-way through the pipeline must not be reset to 'discovered' by a
 * re-discovery — that would re-transcribe and re-sync it.
 */
export async function discoverCalls({ from, to, windowHours = 6, deps = {} } = {}) {
  const cfg = deps.cfg || getConfig();
  const db = deps.supabase || supabase;
  if (!db) throw new Error('Supabase not configured');

  const start = from instanceof Date ? from : new Date(from);
  const end = to instanceof Date ? to : new Date(to);
  if (!Number.isFinite(start?.getTime()) || !Number.isFinite(end?.getTime())) {
    throw new Error('from and to must be valid dates');
  }

  const campaignMap = deps.campaignMap || await loadCampaignMap(db);
  const agentMap = deps.agentMap || await loadAgentMap(db);
  const windows = splitWindows(start, end, windowHours);

  let shaped = [];
  let windowsPulled = 0;
  let capHits = 0;
  for (const w of windows) {
    const out = await pullWindow(w.from, w.to, { cfg, campaignMap, agentMap, deps });
    shaped = shaped.concat(out.rows);
    windowsPulled += out.windows;
    capHits += out.capHits;
  }

  // De-dupe within the pull itself: overlapping windows and transfer legs can
  // surface the same Call ID twice, and an upsert with duplicate keys in ONE
  // payload is a Postgres error, not a merge.
  const byId = new Map();
  for (const r of shaped) byId.set(r.five9_call_id, r);
  const rows = [...byId.values()];

  let inserted = 0;
  if (rows.length) {
    const { data, error } = await db
      .from('ci_calls')
      .upsert(rows, { onConflict: 'five9_call_id', ignoreDuplicates: true })
      .select('id');
    if (error) throw new Error(`ci_calls upsert failed: ${error.message}`);
    inserted = (data || []).length;
  }

  const eligible = rows.filter((r) => r.eligible).length;
  console.log(
    `${LOG} ${start.toISOString()}..${end.toISOString()}: ${windowsPulled} window(s)` +
    `${capHits ? `, ${capHits} cap split(s)` : ''} → ${rows.length} call(s), ` +
    `${eligible} eligible, ${rows.length - eligible} skipped, ${inserted} new`,
  );

  return {
    ok: true,
    from: start.toISOString(),
    to: end.toISOString(),
    windows: windowsPulled,
    cap_splits: capHits,
    calls: rows.length,
    eligible,
    skipped: rows.length - eligible,
    inserted,
    duplicates: rows.length - inserted,
  };
}

export const _internal = { last4 };
export default {
  discoverCalls, pullWindow, loadCampaignMap, loadAgentMap,
  customerNumberFor, customerE164For,
};
