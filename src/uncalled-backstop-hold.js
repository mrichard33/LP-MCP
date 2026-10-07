// ─── Uncalled-leads card waits for the backstop — src/uncalled-backstop-hold.js ───
//
// WHY (Mark, 2026-10-07: "make the uncalled-leads card wait for the backstop
// first"). The hourly lead-leak card (src/jobs/lead-leak-monitor.js,
// runLeadUncalledCheck) names every owed lead 2+ working hours without a Five9
// call. Since 2026-10-06 the new-lead dial backstop (src/jobs/new-lead-dial-
// backstop.js, every 5 min) puts exactly those leads on a Five9 list itself.
// The card did not know: it named leads the backstop had pushed minutes earlier
// and leads it was still waiting on, i.e. it fired before the self-healing pass
// had its cycle (the 2026-10-07 #contact-center / #ops rule).
//
// A lead is HELD off the card while the backstop has it in hand:
//   pushed_recently   the backstop put it on a list less than `graceMin` dial
//                     minutes ago (the backstop's own watchdog window, 30).
//                     Still uncalled after that, it IS named — a push that
//                     Five9 never dials is exactly what a person must chase.
//   backstop_waiting  the backstop's latest pass is waiting on it (too new,
//                     LP_ASAP's 30 dial minutes, a Five9 read to retry, the
//                     per-pass cap). The backstop's own #ops watchdog names it
//                     if that lasts.
//   named_by_backstop the backstop's #ops watchdog already named it
//                     (audit dial_backstop_unhandled): never the same lead twice.
//
// Holding needs a backstop that can fix anything: mode live AND an ok pass in
// the last `freshMin` minutes. Otherwise nothing is held — a stopped backstop
// must never silence the card that would catch what it misses. Any read that
// fails also holds nothing (the card fires as it did before).
//
// PURE: every read arrives as data.

import { dialWindowStartMs } from './five9/callback-dial-check.js';

// The backstop's "wait" and "deferred" results (src/new-lead-dial-backstop.js
// prefilter / finalDecision / the per-pass cap).
export const BACKSTOP_WAIT_REASONS = Object.freeze(new Set([
  'too_new', 'queued_elsewhere', 'dnc_unreadable', 'five9_record_unreadable', 'deferred',
]));

export const HOLD_TEXT = Object.freeze({
  pushed_recently: 'put on a Five9 list by the backstop, giving Five9 time to dial',
  backstop_waiting: 'the backstop is still working on it',
  named_by_backstop: 'already named by the backstop watchdog',
});

/** The LP lead id a backstop push carries: its record's lead_id, else its card_line. */
export function leadIdFromPush(payload = {}) {
  const names = Array.isArray(payload.field_names) ? payload.field_names : [];
  const rec = Array.isArray(payload.records) && Array.isArray(payload.records[0]) ? payload.records[0] : null;
  const i = names.indexOf('lead_id');
  if (rec && i >= 0 && String(rec[i] ?? '').trim()) return String(rec[i]).trim();
  const m = String(payload.card_line ?? '').match(/LP lead (\d+)/);
  return m ? m[1] : null;
}

/**
 * What the backstop knows, from its newest job_runs row and its push rows.
 * @param {{ mode: string, run: object|null, pushRows: Array<{created_at, action_payload}>, nowMs: number, freshMin?: number }} a
 * @returns {{ active: boolean, why?: string, pushes: Map<string, number>, waiting: Set<string> }}
 */
export function backstopView({ mode, run, pushRows = [], nowMs, freshMin = 15 }) {
  const empty = { pushes: new Map(), waiting: new Set() };
  if (mode !== 'live') return { active: false, why: `backstop mode ${mode}`, ...empty };
  const startedMs = Date.parse(run?.started_at);
  if (!run || run.status !== 'ok' || !Number.isFinite(startedMs) || nowMs - startedMs > freshMin * 60000) {
    return { active: false, why: run ? `backstop's last pass ${run.status} at ${run.started_at}` : 'no recent backstop pass', ...empty };
  }
  const pushes = new Map();
  for (const r of pushRows) {
    const id = leadIdFromPush(r.action_payload || {});
    const at = Date.parse(r.created_at);
    if (!id || !Number.isFinite(at)) continue;
    if (!pushes.has(id) || pushes.get(id) < at) pushes.set(id, at);
  }
  const waiting = new Set();
  for (const [reason, ids] of Object.entries(run.detail?.by_reason || {})) {
    if (!BACKSTOP_WAIT_REASONS.has(reason) || !Array.isArray(ids)) continue;
    for (const id of ids) waiting.add(String(id));
  }
  return { active: true, pushes, waiting };
}

/** Why a lead is held off the card, or null to name it. */
export function holdReason(leadId, { view, namedByBackstop = new Set(), nowMs, graceMin = 30 }) {
  const id = String(leadId ?? '');
  if (!id || !view?.active) return null;
  if (namedByBackstop.has(id)) return 'named_by_backstop';
  const pushedMs = view.pushes.get(id);
  if (Number.isFinite(pushedMs) && nowMs < dialWindowStartMs(pushedMs) + graceMin * 60000) return 'pushed_recently';
  if (view.waiting.has(id)) return 'backstop_waiting';
  return null;
}

/**
 * Split the card's offenders into the ones to name and the ones held.
 * @returns {{ named: object[], held: Array<{ lp_lead_id: string, hold: string }> }}
 */
export function applyBackstopHold(offenders, opts) {
  const named = [];
  const held = [];
  for (const o of offenders || []) {
    const hold = holdReason(o?.lp_lead_id, opts);
    if (hold) held.push({ lp_lead_id: String(o.lp_lead_id), hold });
    else named.push(o);
  }
  return { named, held };
}
