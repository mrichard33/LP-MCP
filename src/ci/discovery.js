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
  agentName: ['agent', 'agent name'],
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

/** Zip a positional report row into a named object using a resolved index. */
export function zipRow(row, index) {
  const out = {};
  for (const [field, at] of Object.entries(index)) {
    out[field] = row[at] === undefined ? null : String(row[at]).trim();
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
  if (!call.agent_name && !call.agent_five9_id && !call.was_transferred) {
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
 * Build a ci_calls row from a grouped set of report legs. Pure — exported so
 * the whole shaping path is testable without Five9 or Supabase.
 *
 * @returns {{row: object|null, reject: string|null}}
 */
export function buildCallRow(legs, campaignRow, cfg) {
  const primary = legs.find((l) => !/3rd party transfer|third party transfer/i.test(String(l.direction ?? ''))) || legs[0];

  const startedAt = parsePacificReportTimestamp(primary.timestamp);
  if (!startedAt) {
    // No usable time means no join, no window, no ordering. Reject loudly
    // rather than inventing one.
    return { row: null, reject: 'unparseable_timestamp' };
  }

  const durationSeconds = legs
    .map((l) => durationToSeconds(l.duration))
    .filter((n) => Number.isFinite(n))
    .reduce((a, b) => Math.max(a, b), 0) || null;

  const segments = legs.flatMap((l) => parseRecordingSegments(l.recordings));
  const wasTransferred = isTransferGroup(legs);

  const row = {
    five9_call_id: primary.callId,
    five9_session_id: primary.sessionId || null,
    call_start: startedAt.toISOString(),
    duration_seconds: durationSeconds,
    direction: primary.direction || null,
    ani: primary.ani || null,
    dnis: primary.dnis || null,
    customer_phone: primary.ani || null,
    customer_phone_e164: last10(primary.ani) ? `+1${last10(primary.ani)}` : null,
    campaign: primary.campaign || null,
    skill: primary.skill || null,
    disposition: primary.disposition || null,
    agent_five9_id: primary.agentId || null,
    agent_name: primary.agentName || null,
    was_transferred: wasTransferred,
    raw_metadata: {
      legs,
      recording_segments: segments,
      expected_recording_count: segments.length,
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
export async function pullWindow(from, to, { cfg, campaignMap, deps = {}, depth = 0 } = {}) {
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
    const left = await pullWindow(from, mid, { cfg, campaignMap, deps, depth: depth + 1 });
    const right = await pullWindow(mid, to, { cfg, campaignMap, deps, depth: depth + 1 });
    return {
      rows: [...left.rows, ...right.rows],
      windows: left.windows + right.windows,
      capHits: 1 + left.capHits + right.capHits,
    };
  }

  const rows = [];
  for (const [callId, legs] of groupByCallId(raw)) {
    const campaignRow = campaignMap?.get(legs[0].campaign) || null;
    const { row, reject } = buildCallRow(legs, campaignRow, cfg);
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
  const windows = splitWindows(start, end, windowHours);

  let shaped = [];
  let windowsPulled = 0;
  let capHits = 0;
  for (const w of windows) {
    const out = await pullWindow(w.from, w.to, { cfg, campaignMap, deps });
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
export default { discoverCalls, pullWindow, loadCampaignMap };
