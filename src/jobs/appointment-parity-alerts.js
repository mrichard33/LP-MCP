/**
 * Appointment parity alerting — src/jobs/appointment-parity-alerts.js
 *
 * 2026-09-14. Pure, dependency-free helpers that turn a parity sweep's
 * findings into an alert decision and an ops card body. Kept dependency-free
 * like limiter-health-alerts.js and its siblings, so they unit-test without
 * importing supabase, GroupMe or Slack. The watchdog owns the query, the
 * claim state and the send.
 *
 * WHY
 * ───
 * PARITY_AUTOHEAL was switched on 2026-09-14 ~15:30Z and the sweep reported
 * "4 healed, 27 escalated" every 30 minutes. It had healed nothing and
 * escalated nothing: all 27 escalation events were dropped at event intake
 * (appointment.parity_gap is not on the default-DROP allowlist, and emitEvent
 * returns {filtered:true} WITHOUT throwing, so the caller counted them as
 * writes), and the 4 "heals" were an unconditional counter bump after a call
 * that had early-returned. Two sweeps 29 minutes apart were byte-identical
 * and LP-missing never moved.
 *
 * The escalation path had no route to a human at all — no rule consumes
 * appointment.parity_gap, so even the events that WOULD have landed reached
 * nobody. This module is that route.
 *
 * DESIGN
 * ──────
 * Set-valued and edge-triggered, NOT a per-sweep digest. There are ~27
 * standing gaps; a card every 30 minutes would be muted inside a day, and a
 * muted alarm is how the 2026-08-02 47-hour outage and the 71-day Decision
 * Engine blind spot both stayed invisible. The watchdog claims one alert key
 * per contact (see claimAlertConditionSet in ../alert-state.js) so a standing
 * gap announces once and only a genuinely NEW gap speaks.
 *
 * shouldAlertParityGaps therefore returns a three-way verdict rather than a
 * boolean, matching the house convention: 'alert' / 'healthy' /
 * 'insufficient_evidence'. The third is the one people get wrong — a sweep
 * whose reads failed must neither page nor announce a recovery nobody earned.
 */

const MAX_LISTED = 10;

const LABELS = {
  ghl_missing_appointment: 'Booked in LP, missing from GHL',
  cancellation_drift: 'Cancelled in GHL, still set in LP',
};

/** Divergence classes that mean a human has to look. */
const ESCALATION_CLASSES = new Set(['ghl_missing_appointment', 'cancellation_drift']);

/**
 * Decide whether a sweep's escalations are worth a card.
 *
 * Deliberately does NOT consider the heal classes. A heal that worked needs no
 * card, and a heal that did not is reported through the sweep's own counters
 * (already_present / dedup_suppressed / not_attempted) — folding those into an
 * operator page would fire on the healthy case, which is exactly the habit that
 * gets an alarm muted.
 *
 * @param {object} sweep
 * @param {Array<{class:string, contact_id:string}>} [sweep.findings]
 * @param {number} [sweep.errors]   read/write errors during the sweep
 * @param {boolean} [sweep.readOk]  false when a book read failed outright
 * @returns {{verdict:'alert'|'healthy'|'insufficient_evidence',
 *            gaps:Array, reason:string}}
 */
export function shouldAlertParityGaps(sweep = {}) {
  const findings = Array.isArray(sweep.findings) ? sweep.findings : null;

  // A sweep that could not read both books proves nothing. Neither page nor
  // clear — the claim set is left exactly as it was.
  if (findings === null || sweep.readOk === false) {
    return { verdict: 'insufficient_evidence', gaps: [], reason: 'books_unreadable' };
  }

  const gaps = findings.filter(
    (f) => f && ESCALATION_CLASSES.has(f.class) && f.contact_id,
  );

  if (gaps.length === 0) {
    return { verdict: 'healthy', gaps: [], reason: 'no_escalation_class_findings' };
  }

  return { verdict: 'alert', gaps, reason: 'escalation_class_findings' };
}

/** Stable alert key for one contact's gap. Class is part of it on purpose: a
 *  contact whose gap changes class is a different condition and should speak
 *  again rather than hide behind the first one's claim. */
export function parityAlertKey(prefix, finding) {
  return `${prefix}${finding.class}:${finding.contact_id}`;
}

/**
 * Build the ops card.
 *
 * Names only what is NEW; the standing backlog rides along as context so the
 * card is honest about scale without implying all of it just happened. Same
 * shape as the intake-journal card (src/intake-journal.js) for consistency in
 * #ops-alerts.
 *
 * @param {Array} newGaps      findings being announced this sweep
 * @param {object} context     { totalGaps, healed, alreadyPresent, dedupSuppressed, asOf }
 * @returns {string}
 */
export function formatParityGapCard(newGaps, context = {}) {
  const byClass = new Map();
  for (const g of newGaps) {
    if (!byClass.has(g.class)) byClass.set(g.class, []);
    byClass.get(g.class).push(g);
  }

  const lines = [
    `🚨 APPOINTMENT PARITY — ${newGaps.length} new divergence(s) need a human.`,
  ];

  for (const [cls, items] of [...byClass.entries()].sort()) {
    lines.push('');
    lines.push(`${LABELS[cls] || cls} (${items.length}):`);
    for (const g of items.slice(0, MAX_LISTED)) {
      const who = g.name ? g.name : g.contact_id;
      const when = g.lp_appointment_date ? ` — ${String(g.lp_appointment_date).slice(0, 16)}` : '';
      const disp = g.lp_disposition ? ` [${g.lp_disposition}]` : '';
      lines.push(`  • ${who}${when}${disp}`);
    }
    if (items.length > MAX_LISTED) {
      lines.push(`  • …and ${items.length - MAX_LISTED} more`);
    }
  }

  lines.push('');
  lines.push(`Standing gaps: ${context.totalGaps ?? newGaps.length} total.`);

  // Heal accounting, when the sweep was allowed to write. These three are the
  // counters that replaced the old lying "healed" number — surfacing them here
  // is what makes a no-op sweep visible instead of reading as success.
  if (context.autoheal) {
    lines.push(
      `Heals this sweep: ${context.healed ?? 0} written`
      + `, ${context.alreadyPresent ?? 0} already in LP`
      + `, ${context.dedupSuppressed ?? 0} blocked by dedup mark.`,
    );
  } else {
    lines.push('PARITY_AUTOHEAL is off — nothing was repaired, only reported.');
  }

  lines.push('These are reported once. A gap that persists will not re-alert.');
  return lines.join('\n');
}

// Exported for tests + introspection.
export const __testing = { ESCALATION_CLASSES, LABELS, MAX_LISTED };
