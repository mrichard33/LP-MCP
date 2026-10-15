// ─── Five9 "Call Journey" report → rows: the rules — src/five9/call-journey.js ───
//
// WHY (the user, 2026-10-15, Call Journey handoff)
//   The saved report "Shared Reports / Call Journey" lists every call leg
//   Five9 placed or took, unanswered and busy dials included, which the
//   five9_events_raw webhook mirror never sees (69 calls for 13:00-13:16 UTC
//   against 150 in the report). One row per leg gives every lead its
//   dial-by-dial history and is the basis for auditing the 3-in-24 cap.
//   This is NOT the CI "Call Log" report (src/ci/*, ci_calls): a different
//   report, a different zone, and untouched.
//
// THE REPORT (verified 2026-10-15)
//   Its time zone is set to EASTERN in Five9: the window passed to runReport
//   is read in Eastern, and TIMESTAMP cells ("Thu, 15 Oct 2026 09:10:20") are
//   Eastern wall clock. Columns, resolved BY NAME (a missing one is a hard
//   failure, never a shifted column):
//     TIMESTAMP, DNIS, LPRecKey, lead_id, CAMPAIGN, LIST NAME, SKILL,
//     CALL TYPE, DISPOSITION, AGENT NAME, Number of attempts, ANI, CALL ID
//   Empty cells come back as JSON null; "[None]" means none.
//
// This module is PURE: the job (src/jobs/five9-call-journey-sync.js) does every read and write.

import { zonedWallClockToUtc } from '../ci/time.js';
import { teamFromName, stripTeamSuffix } from '../ci/teams.js';

export const JOURNEY_TZ = 'America/New_York';
export const REPORT_ROW_CAP = 50_000;

/** Every header the report must carry, and the field each one feeds. */
export const JOURNEY_COLUMNS = Object.freeze({
  TIMESTAMP: 'timestamp',
  DNIS: 'dnis',
  LPRECKEY: 'lp_rec_key',
  LEAD_ID: 'lp_lead_id',
  CAMPAIGN: 'campaign',
  'LIST NAME': 'list_name',
  SKILL: 'skill',
  'CALL TYPE': 'call_type',
  DISPOSITION: 'disposition',
  'AGENT NAME': 'agent_name',
  'NUMBER OF ATTEMPTS': 'attempts',
  ANI: 'ani',
  'CALL ID': 'call_id',
});

/** Call types where the customer is the number WE dialed (DNIS); otherwise the caller (ANI). */
export const DIALED_CALL_TYPES = Object.freeze(new Set(['outbound', 'preview', 'manual']));

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/**
 * Header name → column index. Case and spacing do not matter; a missing
 * header throws and names it, because a shifted column would silently store
 * every value under the wrong field.
 */
export function resolveJourneyColumns(columns) {
  const index = new Map((columns || []).map((c, i) => [String(c ?? '').trim().replace(/\s+/g, ' ').toUpperCase(), i]));
  const out = {};
  const missing = [];
  for (const [header, field] of Object.entries(JOURNEY_COLUMNS)) {
    if (index.has(header)) out[field] = index.get(header);
    else missing.push(header);
  }
  if (missing.length) throw new Error(`Call Journey report is missing column(s): ${missing.join(', ')}`);
  return out;
}

/**
 * "Thu, 15 Oct 2026 09:10:20" (weekday optional) on the Eastern wall clock →
 * a UTC Date, daylight saving aware. Anything else → null (the caller counts
 * it as a reject and alerts; a parser that silently returned null for every
 * row once meant zero inserts and no error).
 */
export function parseEasternReportTimestamp(text) {
  const s = String(text ?? '').trim();
  const m = /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  const [day, y, h, min, sec] = [Number(m[1]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  if (month === undefined || day < 1 || day > 31 || h > 23 || min > 59 || sec > 59) return null;
  const d = zonedWallClockToUtc(JOURNEY_TZ, y, month, day, h, min, sec);
  // Reject a day that does not exist in that month (31 Sep rolls into Oct).
  const back = new Intl.DateTimeFormat('en-US', { timeZone: JOURNEY_TZ, day: 'numeric' }).format(d);
  return Number(back) === day ? d : null;
}

/** A cell as text: null, empty and "[None]" are null. Never String(null). */
export function cellText(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || /^\[none\]$/i.test(s)) return null;
  return s;
}

const digits10 = (v) => {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
};

/**
 * One report row → a five9_call_journey row, or a reject reason.
 * @returns {{ row: object } | { reject: string }}
 */
export function normalizeJourneyRow(cells, cols, columns) {
  const get = (field) => cellText(cells?.[cols[field]]);
  const tsText = get('timestamp');
  if (!tsText) return { reject: 'no_timestamp' };
  const ts = parseEasternReportTimestamp(tsText);
  if (!ts) return { reject: 'bad_timestamp' };
  const callId = get('call_id');
  if (!callId) return { reject: 'no_call_id' };

  const callType = get('call_type');
  const dnis = get('dnis');
  const ani = get('ani');
  const agentName = get('agent_name');
  const attemptsText = get('attempts');
  const attempts = attemptsText != null && /^\d+$/.test(attemptsText) ? Number(attemptsText) : null;
  const dialed = DIALED_CALL_TYPES.has(String(callType || '').toLowerCase());
  const callTs = ts.toISOString();
  // The raw row, zipped by the report's own header names.
  const raw = {};
  (columns || []).forEach((c, i) => { raw[String(c)] = cells?.[i] ?? null; });

  return {
    row: {
      // One CALL ID can carry several legs; '' stands in for a null so the key is never NULL.
      leg_key: [callId, callTs, callType || '', dnis || ''].join('|'),
      call_ts: callTs,
      call_id: callId,
      call_type: callType,
      campaign: get('campaign'),
      list_name: get('list_name'),
      skill: get('skill'),
      disposition: get('disposition'),
      agent_name: agentName,
      agent_name_clean: agentName ? stripTeamSuffix(agentName) : null,
      team: agentName ? teamFromName(agentName) : null,
      ani,
      dnis,
      // Outbound / preview / manual: the customer is the number we dialed. Inbound: the caller.
      customer_phone: digits10(dialed ? dnis : (ani || dnis)),
      lp_rec_key: get('lp_rec_key'),
      lp_lead_id: get('lp_lead_id'),
      attempts,
      raw,
    },
  };
}

/** A whole report result → rows, reject counts, and the rows the report returned. */
export function parseJourneyReport({ columns, rows }) {
  const out = { rows: [], rejects: {}, returned: (rows || []).length };
  if (!out.returned) return out;
  const cols = resolveJourneyColumns(columns);
  const seen = new Set();
  for (const cells of rows) {
    const r = normalizeJourneyRow(cells, cols, columns);
    if (r.reject) { out.rejects[r.reject] = (out.rejects[r.reject] || 0) + 1; continue; }
    // The same leg twice in one result (a report quirk) is stored once.
    if (seen.has(r.row.leg_key)) continue;
    seen.add(r.row.leg_key);
    out.rows.push(r.row);
  }
  return out;
}

/** An instant as the Eastern wall-clock string runReport reads: 'YYYY-MM-DDTHH:MM:SS'. */
export function toEasternCriteriaString(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: JOURNEY_TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * The windows to pull: from the last good window_end minus the overlap (or,
 * cold, `coldMin` ago) to now minus the lag, in chunks of at most `maxHours`.
 * Overlapping windows are safe: a leg is keyed, so a re-pull stores nothing new.
 */
export function planJourneyWindows({ lastEndMs = null, nowMs, overlapMin = 10, lagMin = 2, coldMin = 30, maxHours = 6 }) {
  const end = nowMs - lagMin * MIN;
  const start = Number.isFinite(lastEndMs) ? lastEndMs - overlapMin * MIN : end - coldMin * MIN;
  if (!(end > start)) return [];
  const out = [];
  for (let t = start; t < end; t += maxHours * HOUR) out.push({ startMs: t, endMs: Math.min(t + maxHours * HOUR, end) });
  return out;
}
