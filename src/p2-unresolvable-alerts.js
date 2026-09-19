/**
 * Unresolvable P2 opportunity alerting — src/p2-unresolvable-alerts.js
 *
 * 2026-09-19. Pure, dependency-free. Turns a measurement of open P2
 * opportunities that have NO lp_jobs row for their contact into an alert
 * decision and a card body. Same shape as link-leak-alerts.js /
 * limiter-health-alerts.js: this file decides, the job owns the query, the
 * state and the throttle.
 *
 * WHAT IS BEING WATCHED
 * ─────────────────────
 * An opportunity in P2 Client Lifecycle means a contract was signed. There is
 * therefore supposed to be a job in Lead Perfection behind it. When no lp_jobs
 * row can be found for the opportunity's ghl_contact_id, the opportunity is
 * UNRESOLVABLE: scripts/reconcile-p2-stages.js explicitly reports those and
 * never touches them, because "the job was never created" and "the contact
 * link is broken" are two different defects with two different fixes and
 * guessing a stage buries the evidence.
 *
 * That was the right call for the repair pass. Its consequence was that the
 * pile had no owner and nothing counted it. Measured 2026-09-19:
 *
 *   open P2 opportunities .......................... 1,107
 *   of those, no lp_jobs row for the contact .......   289   $6,732,863
 *
 * $6.7M of signed contracts that no LP-derived process can see.
 *
 * WHY THIS DOES NOT ALERT ON THAT 289 (CLASSIFY BEFORE YOU THRESHOLD)
 * ──────────────────────────────────────────────────────────────────
 * Because it would fire on day one, every day, and be muted by the end of the
 * week — and a muted alarm is how a 47-hour outage and a 71-day blind spot
 * both went unnoticed (CLAUDE.md). The 289 are a HISTORICAL BACKLOG. They are
 * real and they need a human, but they are not news, and an alarm that only
 * ever repeats what you already know teaches people to close it.
 *
 * What is news is a NEW one. Split by age, the same cohort reads:
 *
 *   added in the last  7 days ......  0    $0
 *   added in the last 30 days ......  1    $15,298
 *   added in the last 90 days ...... 15    $257,105
 *
 * The rate is already near zero, which makes a threshold on it meaningful:
 * it is quiet today, so when it speaks, something changed. The standing
 * backlog goes to the p2_link_health snapshot (sql/123) instead, where it can
 * be queried and trended without paging anyone.
 *
 * THE BACKLOG STILL GETS ONE JOB: IT MUST NOT GROW SILENTLY
 * ─────────────────────────────────────────────────────────
 * A backlog that is not alerted on can still be alerted on for GROWTH. The
 * second rule below fires when the total climbs by more than a tolerance over
 * the previous snapshot — that catches a regression that creates unresolvable
 * opportunities with OLD date_added values, which the window rule would miss
 * entirely. Two rules, two failure modes.
 *
 * THREE-WAY, NOT A BOOLEAN
 * ────────────────────────
 * `verdict` is `alert` / `healthy` / `insufficient_evidence`, and the caller
 * maps the third to reportAlertCondition's `active: null`. A read that failed
 * must neither page nor clear: clearing on "I could not tell" announces a
 * recovery nobody earned.
 */

// A single new unresolvable opportunity is a defect worth a card. The measured
// rate is 0 over 7 days, so this is not a tuning knob that will cry wolf — it
// is the floor, and the whole point of choosing the window over the backlog.
const DEFAULT_WINDOW_THRESHOLD = 0;

// Growth tolerance on the standing total. Not zero: the backlog moves by one
// or two as opportunities open and close for reasons that have nothing to do
// with linking, and a card for that is noise. A jump past this is a regression.
const DEFAULT_GROWTH_THRESHOLD = 5;

const DEFAULT_WINDOW_DAYS = 7;

function envInt(name, fallback) {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

const isNum = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));

/**
 * Decide whether unresolvable P2 opportunities need an operator.
 *
 * @param {object} sample  What the caller measured:
 *   {
 *     windowDays: number,
 *     readOk: boolean,             // false when ANY read failed
 *     openTotal: number|null,      // all open P2 opportunities
 *     unresolvable: number|null,   // of those, no lp_jobs row for the contact
 *     unresolvableValue: number|null,
 *     recent: number|null,         // unresolvable AND added inside the window
 *     recentValue: number|null,
 *     previousUnresolvable: number|null,  // the last snapshot's total, or null
 *                                         // on the very first pass
 *   }
 * @param {{windowThreshold?: number, growthThreshold?: number}} [thresholds]
 * @returns {{verdict:'alert'|'healthy'|'insufficient_evidence', alert:boolean,
 *            reasons:string[], growth:number|null}}
 */
export function shouldAlertUnresolvableP2(sample, thresholds) {
  const windowThreshold = thresholds?.windowThreshold
    ?? envInt('P2_UNRESOLVABLE_WINDOW_THRESHOLD', DEFAULT_WINDOW_THRESHOLD);
  const growthThreshold = thresholds?.growthThreshold
    ?? envInt('P2_UNRESOLVABLE_GROWTH_THRESHOLD', DEFAULT_GROWTH_THRESHOLD);

  const reasons = [];
  const recent = sample?.recent;
  const total = sample?.unresolvable;
  const previous = sample?.previousUnresolvable;

  // Rule 1 — a NEW unresolvable opportunity. The one that is actionable: the
  // contract was signed days ago, so whoever owns it is still reachable and
  // the LP record can still be created or relinked.
  if (isNum(recent) && Number(recent) > windowThreshold) {
    const days = sample?.windowDays ?? DEFAULT_WINDOW_DAYS;
    reasons.push(
      `${recent} P2 opportunit${Number(recent) === 1 ? 'y' : 'ies'} created in the last ${days}d `
      + 'with no LP job for the contact',
    );
  }

  // Rule 2 — the backlog GREW. Catches the case rule 1 cannot see: a
  // regression that strands opportunities whose date_added is old (a contact
  // merge, a relink that dropped, a bulk import).
  let growth = null;
  if (isNum(total) && isNum(previous)) {
    growth = Number(total) - Number(previous);
    if (growth > growthThreshold) {
      reasons.push(`the unresolvable backlog grew by ${growth} (${previous} → ${total})`);
    }
  }

  if (reasons.length > 0) {
    return { verdict: 'alert', alert: true, reasons, growth };
  }

  // Nothing bad found, but we did not see everything. Neither page nor clear.
  // `previousUnresolvable` is exempt: it is legitimately null on the first
  // pass, and a monitor that reported insufficient_evidence forever until it
  // had a predecessor would never deliver its first all-clear.
  if (sample?.readOk === false || !isNum(recent) || !isNum(total)) {
    return {
      verdict: 'insufficient_evidence',
      alert: false,
      reasons: [!isNum(total) || !isNum(recent)
        ? 'the unresolvable cohort could not be counted'
        : 'one or more reads failed'],
      growth,
    };
  }

  return { verdict: 'healthy', alert: false, reasons: [], growth };
}

const money = (v) => (isNum(v) ? `$${Math.round(Number(v)).toLocaleString('en-US')}` : '$?');
const count = (v) => (isNum(v) ? String(v) : '?');

/**
 * Build the ops card.
 *
 * Leads with the NEW ones and states the backlog underneath as context rather
 * than as the headline. The reader's job is the new ones; the backlog is there
 * so the number in the card matches the number in p2_link_health and nobody
 * has to reconcile two figures during an incident.
 */
export function formatUnresolvableP2Alert(sample, reasons = []) {
  const days = sample?.windowDays ?? DEFAULT_WINDOW_DAYS;
  const lines = (reasons || []).map((r) => `  • ${r}`).join('\n');
  return (
    '🔴 P2 opportunities with no LP job\n'
    + `${lines || '  • (no reason given)'}\n`
    + `\nlast ${days}d : ${count(sample?.recent)} opportunit`
    + `${Number(sample?.recent) === 1 ? 'y' : 'ies'}  ${money(sample?.recentValue)}`
    + `\nbacklog  : ${count(sample?.unresolvable)} of ${count(sample?.openTotal)} open  `
    + `${money(sample?.unresolvableValue)}\n`
    + '\nA P2 opportunity means a contract was signed, so an LP job should exist.\n'
    + 'Either the job was never created in LP, or the LP↔GHL link is broken.\n'
    + 'Triage: node scripts/repair-lp-ghl-links.js --tier=1,2 (dry run) prints '
    + 'every one with a reason and an owner.'
  );
}

/** The recovery card. Short on purpose: nothing to act on. */
export function formatUnresolvableP2Recovered(sample) {
  const days = sample?.windowDays ?? DEFAULT_WINDOW_DAYS;
  return (
    `✅ P2 unresolvable cleared — 0 new in the last ${days}d, `
    + `backlog steady at ${count(sample?.unresolvable)}.`
  );
}
