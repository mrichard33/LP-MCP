/**
 * Duplicate live appointment alerts — src/services/appt-prospect-dupe-alerts.js
 *
 * PURE and dependency-free, per the convention in CLAUDE.md: the verdict and
 * the card body unit-test without importing supabase, GroupMe or Slack. The
 * job that calls this (jobs/appt-prospect-dupe-sweep.js) owns the query, the
 * state and the throttle.
 *
 * ══ WHAT THIS IS, AND WHAT IT IS NOT ══
 * This is a DETECTOR, not a guard. It reports duplicates after the fact; it
 * prevents nothing. The prevent half lives in
 * services/lp-duplicate-appointment-guard.js and covers only creates that go
 * through our own code — which, measured against all five observed cases on
 * 2026-09-14, is none of them. Three of the five arrived from different
 * vendors posting straight into LP; in every one of the five pairs the NEWER
 * lead was set by a human or vendor, not by "Integration, GoHighLevel".
 *
 * That is precisely why this exists and why SOURCE NAMES are on the card. A
 * duplicate you find by accident is an anecdote. The same two vendor names
 * appearing on a recurring number is a purchasing problem with a price on it.
 *
 * ══ CLASSIFY BEFORE YOU THRESHOLD ══
 * The verdict is three-way, not a boolean, because a boolean cannot tell
 * "clean" from "the read failed". Clearing on a failed read announces a
 * recovery nobody earned; see the `active` contract on reportAlertCondition.
 */

/** @typedef {{ lp_prospect_id: string, slot_date: string, live_rows: number,
 *   lead_ids: string[], dispositions: string[], surnames: string[],
 *   ghl_contact_ids: string[], sources?: Record<string,string> }} DupeRow */

/**
 * @param {DupeRow[]|null} rows  null means the read failed — we cannot tell.
 * @returns {{ verdict: 'alert'|'healthy'|'insufficient_evidence', count: number }}
 */
export function shouldAlertApptProspectDupes(rows) {
  if (rows == null) return { verdict: 'insufficient_evidence', count: 0 };
  if (!rows.length) return { verdict: 'healthy', count: 0 };
  return { verdict: 'alert', count: rows.length };
}

/** reportAlertCondition's three-way `active` from the verdict. */
export function activeFromVerdict(verdict) {
  if (verdict === 'alert') return true;
  if (verdict === 'healthy') return false;
  return null; // could not tell — neither page nor clear
}

/**
 * The ops card.
 *
 * Surnames are printed per row because they DIFFER on the duplicate-with-typo
 * cases (Golden / Gold) — that difference is the tell for how the duplicate was
 * created, and collapsing it to one name hides it.
 */
export function formatApptProspectDupes(rows) {
  const lines = (rows || []).map((r) => {
    const ids = r.lead_ids || [];
    const disps = r.dispositions || [];
    const sources = r.sources || {};
    const pairs = ids.map((id, i) => {
      const disp = disps[i] || '?';
      const src = sources[String(id)] || 'source unknown';
      return `    • ${id} (${disp}) — ${src}`;
    }).join('\n');
    const names = [...new Set(r.surnames || [])].map((n) => String(n).trim()).filter(Boolean);
    return `📅 ${r.slot_date} — prospect ${r.lp_prospect_id} — ${names.join(' / ') || '(no surname)'}\n${pairs}`;
  });

  return `🚨 DUPLICATE LIVE APPOINTMENTS — ${rows.length} prospect${rows.length === 1 ? '' : 's'} holding more than one live lead on the same day\n\n` +
    `${lines.join('\n')}\n\n` +
    `Each of these counts one person twice across confirmed and set. The source on each row is the point: repeated vendor pairs are duplicate acquisition being paid for twice.\n` +
    `This is a DETECTOR, not a guard — these arrive from vendors posting straight into LP and nothing upstream of us can block them.`;
}

/** Recovery card — only sent after a real alert, never on a failed read. */
export function formatApptProspectDupesRecovered() {
  return '✅ DUPLICATE LIVE APPOINTMENTS — clear. No prospect is holding more than one live lead on the same upcoming day.';
}
