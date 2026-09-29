/**
 * Why an uncalled lead is not being called — src/lead-leak-explain.js
 *
 * Pure and dependency-free, like src/lead-leak-classify.js. The daily pass in
 * src/jobs/lead-leak-monitor.js collects the facts; this module turns a reason
 * plus those facts into one plain-English sentence that the dashboard's Lead
 * Leaks page shows under each lead.
 *
 * WHY (2026-09-29)
 *   "I want to make sure on our lead leaks page it shows why they're not being
 *   called. We need the reasoning." The page showed only a reason label, e.g.
 *   "Never dialled — Five9 has the number", which says WHAT but not WHY. The
 *   facts that answer why — which Five9 list the lead sits on, which LP call
 *   queue it is in and how many times LP says it was dialled, where a DNC comes
 *   from, whether the phone was ever DNC before — were either not collected or
 *   never reached the page.
 *
 * RULE: a fact the pass could not read is written as "couldn't check", never
 * guessed. `null` = could not tell; `false` / 'none' = checked and absent.
 */

// LP Data call queues (src/services/lp-callback-requeue.js DATA_QUEUE_IDS).
export const LP_QUEUE_NAMES = Object.freeze({
  8: 'Data - Hot Leads <7',
  30: 'Data - Warm Leads <30',
  9: 'Data - Leads >30',
  31: 'Data - Catch All',
  26: 'Data - Old >180',
});

export const DNC_SOURCE_TEXT = Object.freeze({
  lp_code: 'LP codes it DNC',
  five9_list: 'the phone is on the Five9 do-not-call list',
  sms_stop: 'the lead texted STOP',
  opt_out: 'an opt-out is recorded for this contact',
});

const s = (v) => (v == null ? '' : String(v).trim());
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "Five9 has it on list X (campaign Y), N dial attempts." or a no-list line. */
function five9Clause(f) {
  const r = f.five9_record;
  if (f.five9_lookup === 'absent') return 'Never loaded into Five9.';
  if (!r) {
    if (f.five9_lookup === 'present') return 'Five9 has the number.';
    return "Couldn't check Five9 today.";
  }
  const attempts = Number.isFinite(r.attempts) ? `, ${plural(r.attempts, 'dial attempt', 'dial attempts')}` : '';
  if (!s(r.list)) return `Five9 has the number but it is on no dialing list${attempts}.`;
  const campaign = s(r.campaign) && s(r.campaign) !== s(r.list) ? ` (campaign ${s(r.campaign)})` : '';
  return `Five9 has it on list "${s(r.list)}"${campaign}${attempts}.`;
}

/** LP's own view: which Data dial queue the lead is in, with LP's attempt count. */
function lpQueueClause(f) {
  const q = f.lp_queue;
  if (q === undefined) return '';
  if (q === null) return "Couldn't check LP's call queues.";
  if (q === 'none') return "LP has it in none of its Data call queues, so LP isn't feeding it to the dialer.";
  if (q === 'unknown') return "Not found in LP's Data call queues (one queue was too long to read fully).";
  const name = LP_QUEUE_NAMES[q.cqd_id] || `queue ${q.cqd_id}`;
  const attempts = Number.isFinite(q.attempts) ? `, ${plural(q.attempts, 'dial attempt', 'dial attempts')}` : '';
  const last = s(q.last_result) ? `, last result "${s(q.last_result)}"` : '';
  return `LP has it in "${name}"${attempts}${last}.`;
}

function dncHistoryClause(f) {
  if (f.ever_dnc === true) return 'This phone was marked DNC before.';
  if (f.ever_dnc === false) return 'No DNC history.';
  return '';
}

function contextClause(f) {
  const parts = [];
  if (s(f.market)) parts.push(`Market ${s(f.market)}`);
  else if (f.market === null) parts.push('No LP market');
  if (Number.isFinite(f.age_days)) parts.push(`${plural(f.age_days, 'day', 'days')} old`);
  return parts.length ? `${parts.join(', ')}.` : '';
}

const join = (...xs) => xs.filter(Boolean).join(' ');

/**
 * One sentence for an uncalled lead.
 *   reason  the classifier's reason (src/lead-leak-classify.js REASONS)
 *   f       facts: five9_lookup, five9_record, lp_queue, dnc_source, ever_dnc,
 *           market, age_days, hold_started, hold_date_unknown, calls
 */
export function explainUncalled(reason, f = {}) {
  switch (reason) {
    case 'not_in_five9':
      return join('Never loaded into Five9.', lpQueueClause(f), dncHistoryClause(f), contextClause(f));
    case 'not_on_dial_list':
    case 'routing_or_automation_failure':
      return join(five9Clause(f), 'Five9 has never dialled it.', lpQueueClause(f), dncHistoryClause(f), contextClause(f));
    case 'unverified':
      return join("Couldn't check Five9 today (the lookup was skipped or failed).", lpQueueClause(f), dncHistoryClause(f), contextClause(f));
    case 'called_no_retry':
      return join('Five9 called it, but has not tried again since.', lpQueueClause(f), contextClause(f));
    case 'dnc': {
      const why = DNC_SOURCE_TEXT[f.dnc_source];
      const base = why ? `Not called because ${why}.` : 'Not called because the phone is on a do-not-call list.';
      const mismatch = f.dnc_source && f.dnc_source !== 'lp_code' && s(f.disposition) && s(f.disposition) !== 'DNC'
        ? `LP still codes it ${s(f.disposition)}.` : '';
      return join(base, mismatch, dncHistoryClause(f) === 'No DNC history.' ? '' : dncHistoryClause(f));
    }
    case 'missing_phone':
      return 'Not called because LP has no usable phone number for it.';
    case 'duplicate':
      return 'Not called because another LP lead with the same phone was already called.';
    case 'missing_source':
      return 'Not called because it has no lead source in LP.';
    case 'dead_status':
      return `Not called because its LP code${s(f.disposition) ? ` (${s(f.disposition)})` : ''} means stop calling.`;
    case 'not_issued_call_center':
      return 'Set, but the call center never issued it to a rep (LP code NIS).';
    case 'not_covered_by_rep':
      return 'Set, but no rep covered it (LP code NOC).';
    case 'noc_out_of_area':
      return 'No rep covered it, and its zip is outside the service area or missing — review.';
    case 'rep_hold':
      return f.hold_date_unknown
        ? 'On a rep hold (NoRehash); LP has no hold date, so it is kept on hold.'
        : 'On a rep hold (NoRehash) for up to 7 days.';
    case 'rep_hold_expired':
      return 'The 7-day rep hold (NoRehash) is over and nobody has called it since.';
    case 'already_progressed':
      return 'Already booked or sold by its LP code; no Five9 call on record.';
    case 'already_progressed_flag':
      return "LP's appointment flag is on, but its code says otherwise; no Five9 call on record.";
    default:
      return '';
  }
}
