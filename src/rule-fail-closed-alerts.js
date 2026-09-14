/**
 * Rule fail-closed alerting — src/rule-fail-closed-alerts.js
 *
 * 2026-09-12. Pure, dependency-free helpers that turn a rolling window of
 * rule.condition_failed_closed events into an alert decision + a card body.
 * Kept dependency-free — like agentic-silence-alerts.js, executor-queue-alerts.js
 * and limiter-health-alerts.js — so they unit-test without importing supabase or
 * the senders. The decision-engine heartbeat owns the query, the state and the
 * throttle, and routes the card to the ops channel (mirrored to Slack
 * #ops-alerts — Reece is migrating off GroupMe).
 *
 * WHY
 * ───
 * The 2026-07-03 fail-closed doctrine made the engine suppress a rule whenever
 * the data its conditions reference is unreadable, and emit
 * rule.condition_failed_closed so the suppression is observable. The emit was
 * the whole point — and nothing ever read it. By 2026-09-12 the table held
 * 433,748 of them going back to the day the doctrine shipped, and the first
 * anyone looked was a manual sweep 71 days later.
 *
 * Two fixes landed together. The engine stopped manufacturing non-events (99%
 * of that volume was contact-scoped conditions evaluated against dialer traffic
 * carrying no GHL contact at all — nothing was read, so nothing failed). This
 * module reads what is left.
 *
 * NOT EVERY SUPPRESSION IS A FAULT
 * ────────────────────────────────
 * Same discipline as the eligible-replies split in agentic-silence-alerts.js: an
 * alarm that fires on the healthy case gets muted, and a muted alarm is how you
 * get another 71 silent days. Three classes, only two of which page:
 *
 *   AUTHORING — 'unknown condition operator', 'malformed spec …'. The rule
 *     references an operator the engine does not implement, so it can NEVER
 *     fire. This is a dead rule, and one occurrence proves it: it pages at any
 *     volume. EMAIL_ENRICH_FROM_LP sat dead this way for 1,970 evaluations
 *     across 1,956 contacts before anyone noticed.
 *
 *   INFRA — 'contact tags unreadable', 'appointment lookup unavailable',
 *     'lp_leads lookup failed: …', and the rest of the read-broke family. The
 *     rule is fine; GHL or Supabase was not. Each one is a gate that was
 *     skipped blind — including DNC and suppression gates, which is the
 *     compliance-relevant half. Background is ~1 per 6h, so this pages on a
 *     burst, not a blip.
 *
 *   EXPECTED — 'contact has no LP record — disposition gate cannot pass'. A GHL
 *     contact that genuinely has no LP row. The gate is doing its job. Reported
 *     as context in the body, never as a trigger.
 */

/**
 * Detail strings that mean "a rule can never fire as written". Matched as
 * prefixes because the malformed-spec details carry the expected shape inline.
 */
const AUTHORING_DETAIL_PREFIXES = [
  'unknown condition operator',
  'malformed spec',
];

/**
 * Detail strings that mean "the gate was skipped because a read broke".
 * Prefixes again — the lookup failures append the driver's error message.
 */
const INFRA_DETAIL_PREFIXES = [
  'contact tags unreadable',
  'contact custom fields unreadable',
  'inbound history unreadable',
  'appointment lookup unavailable',
  'last inbound age unknown',
  'lp_leads lookup failed',
  'system_events lookup failed',
  'system_events count',
];

/**
 * Classify one fail-closed detail string.
 *
 * Unrecognised details classify as 'infra' on purpose. A detail this module has
 * not been taught is a suppression nobody has triaged, and the fail-closed
 * doctrine's whole posture is that unknown must not read as fine.
 *
 * @param {string|null} detail
 * @returns {'authoring'|'infra'|'expected'}
 */
export function classifyFailClosedDetail(detail) {
  const d = typeof detail === 'string' ? detail : '';
  if (AUTHORING_DETAIL_PREFIXES.some(p => d.startsWith(p))) return 'authoring';
  if (d.startsWith('contact has no LP record')) return 'expected';
  if (INFRA_DETAIL_PREFIXES.some(p => d.startsWith(p))) return 'infra';
  return 'infra';
}

/**
 * Roll a window of fail-closed rows up into per-class counts and the worst
 * offenders, so the alert body can name what is suppressed instead of just how
 * often.
 *
 * @param {Array<{rule_key?:string, detail?:string, ghl_contact_id?:string|null}>} rows
 * @param {number} windowHours
 * @returns {{authoring:number, infra:number, expected:number, total:number,
 *            windowHours:number, contacts:number,
 *            topOffenders:Array<{ruleKey:string, detail:string, klass:string, count:number}>}}
 */
export function summarizeFailClosed(rows, windowHours) {
  const list = Array.isArray(rows) ? rows : [];
  const counts = { authoring: 0, infra: 0, expected: 0 };
  const byPair = new Map();
  const contacts = new Set();

  for (const row of list) {
    const detail = row?.detail ?? null;
    const klass = classifyFailClosedDetail(detail);
    counts[klass] += 1;
    if (row?.ghl_contact_id) contacts.add(row.ghl_contact_id);
    if (klass === 'expected') continue; // context only — never ranked

    const ruleKey = row?.rule_key || 'unknown-rule';
    const pairKey = `${ruleKey}\u0000${detail || 'no detail'}`;
    const seen = byPair.get(pairKey);
    if (seen) seen.count += 1;
    else byPair.set(pairKey, { ruleKey, detail: detail || 'no detail', klass, count: 1 });
  }

  const topOffenders = [...byPair.values()]
    .sort((a, b) => b.count - a.count || a.ruleKey.localeCompare(b.ruleKey))
    .slice(0, 5);

  return {
    ...counts,
    total: list.length,
    windowHours: windowHours ?? 6,
    contacts: contacts.size,
    topOffenders,
  };
}

/**
 * Decide whether the fail-closed stream warrants a page.
 *
 * @param {ReturnType<typeof summarizeFailClosed>} summary
 * @param {{infraThreshold:number}} thresholds
 *   infraThreshold — infra-class suppressions in the window before this pages.
 *   Background since 2026-07-03 is ~1 per 6h (829 across 71 days), so the
 *   default of 25 stays quiet on the normal case and still catches an outage.
 * @returns {{alert:boolean, reasons:string[], critical:boolean, verdict:string}}
 *   verdict distinguishes the two reasons for alert:false, exactly as
 *   shouldAlertAgenticSilence does, because src/alert-state.js is edge-triggered
 *   and must not announce a recovery nobody earned:
 *     'alert'  — something is suppressed that should not be
 *     'healthy' — the window was read and held nothing actionable
 *     'insufficient_evidence' — the window could not be read; touch nothing
 */
export function shouldAlertFailClosed(summary, thresholds) {
  if (!summary) {
    return {
      alert: false,
      reasons: [],
      critical: false,
      verdict: 'insufficient_evidence',
    };
  }

  const infraThreshold = thresholds?.infraThreshold ?? 25;
  const authoring = summary.authoring ?? 0;
  const infra = summary.infra ?? 0;
  const reasons = [];

  // A rule that cannot fire as written is always worth one card. It is not a
  // volume problem — it is a rule that does nothing, and volume only tells you
  // how long it has done nothing for.
  if (authoring > 0) {
    reasons.push(
      `${authoring} suppression${authoring === 1 ? '' : 's'} from unimplemented/malformed conditions ` +
      `(rule cannot fire as written)`
    );
  }
  if (infra > infraThreshold) {
    reasons.push(`${infra} gates skipped on unreadable data > ${infraThreshold}`);
  }

  return {
    alert: reasons.length > 0,
    reasons,
    critical: authoring > 0,
    verdict: reasons.length > 0 ? 'alert' : 'healthy',
  };
}

/**
 * Build the alert body. Names the offending rules — the count alone sends an
 * operator back to SQL, which is the friction that let this sit for 71 days.
 *
 * @param {ReturnType<typeof summarizeFailClosed>} summary
 * @param {string[]} reasons
 * @returns {string}
 */
export function formatFailClosedAlert(summary, reasons) {
  const s = summary || {};
  const windowHours = s.windowHours ?? 6;
  const expectedNote = (s.expected ?? 0) > 0
    ? `\n(${s.expected} more excluded — contacts with no LP record, gate working as intended)`
    : '';

  const offenders = (s.topOffenders || [])
    .map(o => `  • ${o.ruleKey} — ${o.detail} ×${o.count}`)
    .join('\n');

  return (
    `⚠️ Rules suppressed on unreadable data\n` +
    `dead-rule: ${s.authoring ?? 0} | skipped gates: ${s.infra ?? 0} | ` +
    `contacts: ${s.contacts ?? 0} | window: ${windowHours}h${expectedNote}\n` +
    `triggered: ${(reasons || []).join('; ') || 'unspecified'}\n` +
    (offenders ? `${offenders}\n` : '') +
    `a DNC or suppression gate in this list means it was skipped blind — check those first`
  );
}

export default {
  classifyFailClosedDetail,
  summarizeFailClosed,
  shouldAlertFailClosed,
  formatFailClosedAlert,
};
