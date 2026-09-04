// src/services/backstop-notify.js
//
// Backstop notification module — the exception gate for both LP backstop
// sweeps.
//
// DESIGN: a healthy sweep is silent. Cards fire only on lead errors
// (`failing`), cap-driven backlog pressure (`degraded`, cooled down), or a
// sweep that threw before producing a summary. Every card carries LP source
// and sub-source — including multi-lead runs via summarizeSources, and
// including all-errors runs, which fall back to the errored leads' sources.
// The narrative is model-written by generateBackstopInsight, called ONLY
// after the gate decides to send, with a deterministic template as fallback.

import { formatLpSource } from '../format-helpers.js';
import { buildClassifiedNotification } from '../actions/notification-classifier.js';
import { sendGroupMeMessage } from '../groupme.js';
import { generateBackstopInsight } from './backstop-insight.js';
import { reportAlertCondition, __resetAlertStateFallback } from '../alert-state.js';

/**
 * Source line for the card header, covering BOTH the single-lead and
 * multi-lead cases. The classifier renders `📋 Src:` from
 * formatLpSource(lpSource, lpSourceDetail), so:
 *   - one distinct source  → pass parent + detail, rendering "Parent > Detail"
 *   - several              → pass a pre-joined summary as lpSource with no
 *                            detail, rendering "Internet > Modernize (2), Iheart > Simpletext (1)"
 * Never returns null — an unresolvable source renders "Unknown", which is
 * itself signal (same doctrine as Prospect: NONE).
 *
 * `errors` is a FALLBACK, used only when nothing was touched. An all-errors
 * run has an empty `results` (errored leads never get a result object), and
 * that is precisely the card where source matters most — "all four that
 * failed were Modernize" is the whole finding. Called with one argument the
 * behaviour is exactly as before, so existing callers are unaffected.
 */
export function summarizeSources(results = [], errors = []) {
  const touched = (results || []).filter((r) => r && (r.action === 'created' || r.action === 'linked'));
  const rows = touched.length > 0 ? touched : (errors || []).filter(Boolean);
  if (rows.length === 0) return { lpSource: undefined, lpSourceDetail: undefined };

  const counts = new Map(); // display string -> { n, source, detail }
  for (const r of rows) {
    const display = formatLpSource(r.lead_source, r.lead_source_detail) || 'Unknown';
    const cur = counts.get(display) || { n: 0, source: r.lead_source || null, detail: r.lead_source_detail || null };
    cur.n++;
    counts.set(display, cur);
  }

  if (counts.size === 1) {
    const [, only] = [...counts.entries()][0];
    return { lpSource: only.source || 'Unknown', lpSourceDetail: only.detail || undefined };
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1].n - a[1].n);
  const shown = ranked.slice(0, 3).map(([display, v]) => `${display} (${v.n})`);
  const rest = ranked.slice(3).reduce((sum, [, v]) => sum + v.n, 0);
  if (rest > 0) shown.push(`+${rest} more`);
  return { lpSource: shown.join(', '), lpSourceDetail: undefined };
}

// ─── Exception gate ──────────────────────────────────────────────────

export const DEFAULT_NOTIFY_MODE = 'exception';   // 'exception' | 'all' | 'off'
export const DEFAULT_DEFER_THRESHOLD = 1;
export const DEFAULT_COOLDOWN_MIN = 240;
export const DEFAULT_FAILURE_COOLDOWN_MIN = 60;
export const MAX_DETAIL_LEADS = 5;

// ─── Aggregate failure alerting (2026-08-23, issues #292 / #291) ─────
//
// Errors used to mean severity 'failing' at errorCount > 0, AND they bypassed
// the cooldown outright ("they are rare and each names different leads"). That
// held while sweeps ran 25 leads at a time. It stops holding for the 95,702-
// lead #222 drain: a sweep every 15 minutes, each with a handful of unavoidable
// transient GHL failures, posts a card every 15 minutes for the length of the
// drain — the exact channel-destroying noise #291 flags, and it would drown the
// cards that matter.
//
// So alert on AGGREGATE failure instead: a run must fail at least
// DEFAULT_MIN_ERROR_COUNT leads AND exceed DEFAULT_ERROR_RATE_THRESHOLD of what
// it processed, and then only once per DEFAULT_ERROR_COOLDOWN_MIN per sweep
// mode. Below that bar the run is silent — which is now safe in a way it was
// not before, because every errored lead is persisted to lp_sync_errors by
// persistSweepErrors() and is queryable long after the card would have scrolled
// away. Silence is no longer forgetting.
//
// Plain constants, not env reads: this ships with no new configuration (a
// deliberate constraint of this change). Both are parameters of classifyRun so
// tests pin behaviour without touching process.env.
export const DEFAULT_ERROR_RATE_THRESHOLD = 0.2;   // >20% of processed leads
export const DEFAULT_MIN_ERROR_COUNT = 3;          // floor: 1/2 of 2 isn't a trend
export const DEFAULT_ERROR_COOLDOWN_MIN = 60;

const errorCooldownMs = () => DEFAULT_ERROR_COOLDOWN_MIN * 60000;

const notifyMode = () => String(process.env.LP_BACKSTOP_NOTIFY_MODE || DEFAULT_NOTIFY_MODE).toLowerCase();
const deferThreshold = () => Math.max(1, parseInt(process.env.LP_BACKSTOP_DEFER_ALERT_THRESHOLD || String(DEFAULT_DEFER_THRESHOLD), 10));
const cooldownMs = () => Math.max(0, parseInt(process.env.LP_BACKSTOP_ALERT_COOLDOWN_MIN || String(DEFAULT_COOLDOWN_MIN), 10)) * 60000;
const failureCooldownMs = () => Math.max(0, parseInt(process.env.LP_BACKSTOP_FAILURE_COOLDOWN_MIN || String(DEFAULT_FAILURE_COOLDOWN_MIN), 10)) * 60000;

// 2026-09-05 (follow-on to PR #845): the cooldown Map moved into
// alert_conditions. Six conditions live here — contact/intake × errors/backlog/
// failure — and each is now a durable row, so a chronic backlog or a crash loop
// posts ONE card until it resolves rather than one per cooldown window, and a
// redeploy no longer re-announces everything that is still wrong.
//
// The old cooldowns survive as fallbackCooldownMs: if alert_conditions is
// unusable, alert-state.js degrades to exactly this file's previous behavior.
const ALERT_PREFIX = 'backstop:';
const alertKey = (sweepMode, kind) => `${ALERT_PREFIX}${sweepMode}:${kind}`;

/** Test hook — clears the degraded-path cooldown state. */
export function __resetCooldowns() { __resetAlertStateFallback(); }

/**
 * Severity of a completed run. Errors outrank backlog: a run can be both,
 * and errored leads are the more actionable fact.
 *   failing  — errors crossed the aggregate bar (count AND rate). Those leads
 *              are still unlinked, and the shape says systemic, not transient.
 *   degraded — the per-run cap left eligible leads unprocessed.
 *   healthy  — nothing worth a card. Covers both a clean run and a run whose
 *              errors stayed under the aggregate bar; `reason` distinguishes
 *              them, and either way the errored leads are in lp_sync_errors.
 *
 * `errorRate` is always returned so the card can state the shape of the
 * failure rather than just its count.
 */
export function classifyRun({
  counts = {},
  scan = {},
  processed = null,
  errorRateThreshold = DEFAULT_ERROR_RATE_THRESHOLD,
  minErrorCount = DEFAULT_MIN_ERROR_COUNT,
} = {}) {
  const errorCount = counts.error || 0;
  const total = Number.isFinite(processed)
    ? processed
    : (Array.isArray(scan.targets) ? scan.targets.length : (scan.processed || 0));
  // A run that processed nothing but still errored is 100% failed, not 0%.
  const errorRate = total > 0 ? errorCount / total : (errorCount > 0 ? 1 : 0);
  const deferred = scan.deferredCapped || 0;

  if (errorCount >= minErrorCount && errorRate >= errorRateThreshold) {
    return { severity: 'failing', reason: 'lead_error_rate', errorCount, errorRate, processed: total };
  }
  if (deferred >= deferThreshold()) {
    return { severity: 'degraded', reason: 'backlog_pressure', errorCount, errorRate, processed: total };
  }
  if (errorCount > 0) {
    // Persisted, queryable, below the alert bar. Deliberately silent (#291).
    return { severity: 'healthy', reason: 'errors_below_threshold', errorCount, errorRate, processed: total };
  }
  return { severity: 'healthy', reason: 'clean_run', errorCount, errorRate, processed: total };
}

/**
 * Policy only: does this severity warrant a card at all? PURE as of
 * 2026-09-05 — it used to mutate the cooldown Map as a side effect of being
 * asked, which meant callers had to invoke it exactly once per run and could
 * never ask twice. Debouncing now lives in alert_conditions, keyed on the
 * condition rather than on elapsed time.
 *
 * 2026-08-23 (#292/#291): failing runs are debounced per sweep mode too, rather
 * than bypassing the cooldown. N failing runs while the condition persists
 * produce ONE card, not N. Losing the extra cards costs nothing now that every
 * errored lead is written to lp_sync_errors — see the header note above.
 *
 * `kind` names which condition row the caller should report against.
 */
export function shouldNotify({ severity, sweepMode }) {
  const mode = notifyMode();
  if (mode === 'off') return { send: false, reason: 'notify_off' };
  if (severity === 'failing') {
    return { send: true, reason: 'lead_error_rate', kind: 'errors', cooldownMs: errorCooldownMs() };
  }
  if (severity === 'degraded') {
    return { send: true, reason: 'backlog_pressure', kind: 'backlog', cooldownMs: cooldownMs() };
  }
  // healthy. 'all' still posts every run, so it keeps bypassing the condition
  // layer entirely — it is a debugging mode, not an alerting one.
  if (mode === 'all') return { send: true, reason: 'notify_all', kind: null };
  return { send: false, reason: 'clean_run', kind: null };
}

// ─── Card composition ────────────────────────────────────────────────

/** Per-lead detail lines. Every line — touched OR errored — carries a source. */
function detailLines(results = [], errors = []) {
  const out = [];
  const touched = (results || []).filter((r) => r && (r.action === 'created' || r.action === 'linked'));
  const errs = errors || [];

  for (const r of touched.slice(0, MAX_DETAIL_LEADS)) {
    const nm = r.name || '(no name)';
    const verb = r.action === 'created' ? 'created' : 'linked';
    const src = formatLpSource(r.lead_source, r.lead_source_detail) || 'Unknown';
    const sup = r.suppressed ? ` [${r.suppress_reason}]` : '';
    out.push(`• ${nm} — ${src} — lead ${r.lp_lead_id} → contact ${r.contact_id || '?'} (${verb})${sup}`);
  }
  if (touched.length > MAX_DETAIL_LEADS) out.push(`• …and ${touched.length - MAX_DETAIL_LEADS} more`);

  for (const e of errs.slice(0, MAX_DETAIL_LEADS)) {
    const src = formatLpSource(e.lead_source, e.lead_source_detail) || 'Unknown';
    out.push(`⚠ lead ${e.lp_lead_id} — ${src} — ${e.error}`);
  }
  if (errs.length > MAX_DETAIL_LEADS) out.push(`⚠ …and ${errs.length - MAX_DETAIL_LEADS} more errored`);

  return out;
}

/**
 * Compose the card. SYNCHRONOUS — `insight` is generated by the caller and
 * passed in, so tests can build cards without touching a model.
 *
 * Source is ALWAYS passed via summarizeSources, single-lead or not. Contact
 * id / name / prospect only carry real values when exactly one lead was
 * touched; source is required either way.
 */
export function buildBackstopCard({
  sweepMode,               // 'appointment' | 'intake'
  severity,
  scan = {},
  counts = {},
  errors = [],
  results = [],
  maxPerRun = 0,
  intervalMin = 15,
  insight = null,
} = {}) {
  const label = sweepMode === 'intake' ? 'LP INTAKE BACKSTOP' : 'LP CONTACT BACKSTOP';
  const touched = (results || []).filter((r) => r && (r.action === 'created' || r.action === 'linked'));
  const solo = touched.length === 1 ? touched[0] : null;
  const deferred = scan.deferredCapped || 0;
  const processed = Array.isArray(scan.targets) ? scan.targets.length : (scan.processed || 0);
  const srcSummary = summarizeSources(results, errors);

  let verb;
  let status;
  let narrative;
  let nextStep;

  if (severity === 'failing') {
    const pct = processed > 0 ? Math.round(((counts.error || 0) / processed) * 100) : 100;
    verb = `${label} — ERRORS`;
    status = `${counts.error} lead(s) failed (${pct}%)`;
    narrative =
      `${counts.error} of ${processed} lead(s) — ${pct}% — failed mid-sweep and still have no GHL contact: ` +
      `no speed-to-lead, no routing, invisible to the dashboard until a later sweep succeeds. ` +
      `${counts.created || 0} created, ${counts.linked || 0} linked this run. ` +
      `Every failed lead is recorded in lp_sync_errors (sync_type ${sweepMode === 'intake' ? 'backstop_intake' : 'backstop_appointment'}), ` +
      `not just the ${MAX_DETAIL_LEADS} shown below.`;
    nextStep =
      `Query lp_sync_errors for the full list — this card is debounced to one per ${DEFAULT_ERROR_COOLDOWN_MIN} min per sweep mode, ` +
      `so treat it as a signal to go look, not as the complete record.`;
  } else if (severity === 'degraded') {
    const drainMin = maxPerRun > 0 ? Math.ceil((deferred / maxPerRun) * intervalMin) : null;
    verb = `${label} — BACKLOG`;
    status = `${deferred} deferred`;
    narrative =
      `The per-run cap left ${deferred} eligible lead(s) unprocessed ` +
      `(${scan.eligible || 0} eligible, ${processed} processed, cap ${maxPerRun}). ` +
      (drainMin !== null
        ? `At ${maxPerRun}/run every ${intervalMin} min that is roughly ${drainMin} min to drain, assuming no new arrivals. `
        : '') +
      `Deferred leads are waiting, not lost.`;
    nextStep = 'Persistent backlog means LP→GHL webhook delivery has degraded upstream — raise the cap only after confirming the source.';
  } else {
    verb = `${label} — RUN`;
    status = 'Healthy sweep';
    narrative =
      `Routine sweep: ${counts.created || 0} created, ${counts.linked || 0} linked, ` +
      `${counts.skipped_dnc || 0} DNC link-only, ${counts.skipped_no_phone || 0} no-phone, ${deferred} deferred. ` +
      `No action needed — sent because LP_BACKSTOP_NOTIFY_MODE=all.`;
    nextStep = 'Set LP_BACKSTOP_NOTIFY_MODE=exception to silence healthy runs.';
  }

  // Model text IS the narrative when available; template is the fallback.
  // nextStep stays deterministic — standing doctrine must not vary per run.
  const finalNarrative = insight || narrative;

  const card = buildClassifiedNotification({
    notification_class: 'system',
    action_verb: verb,
    name: solo ? (solo.name || 'Unknown') : `${processed} lead(s) swept`,
    contactId: solo ? (solo.contact_id || '—') : '—',
    prospectId: solo ? solo.lp_prospect_id : undefined,
    lpSource: srcSummary.lpSource,
    lpSourceDetail: srcSummary.lpSourceDetail,
    tier: 'Warm',
    status,
    narrative: finalNarrative,
  });

  // The classifier renders "🎯 Next" ONLY for notification_class
  // 'intelligence' (notification-classifier.js), and these cards are
  // deliberately 'system' — passing nextStep to it would silently drop the
  // line. Appended here instead so the class stays 'system' (no reroute, no
  // rep-facing 'priority' misread) and the standing doctrine still ships.
  const parts = [card, `🎯 Next: ${nextStep}`];
  const details = detailLines(results, errors);
  if (details.length) parts.push(details.join('\n'));
  return parts.join('\n\n');
}

// ─── Entry points ────────────────────────────────────────────────────

/**
 * Single entry point for the run functions. NEVER throws — a notification
 * failure must never fail a sweep whose work is already committed.
 *
 * The model is called only AFTER the gate says send, so healthy runs cost
 * nothing.
 */
export async function notifyBackstopRun({
  sweepMode, scan, counts, errors, results, maxPerRun, intervalMin = 15,
  // Injectable sender, same seam alert-state.js and capacityRanker already use.
  // ES module bindings are read-only, so this is the only way a test can watch
  // what would have been posted without reaching the real GroupMe client.
  send = (text) => sendGroupMeMessage(text, { flushNow: true }),
}) {
  try {
    const { severity, errorRate } = classifyRun({ counts, scan });
    const gate = shouldNotify({ severity, sweepMode });

    // notify_off is INHIBITION, not health — alert-state.js's `null` case by
    // another name. Clearing here would mark every open condition resolved the
    // moment somebody set LP_BACKSTOP_NOTIFY_MODE=off, and re-announce the lot
    // when they set it back. Touch nothing.
    if (gate.reason === 'notify_off') return { sent: false, severity, reason: gate.reason, errorRate };

    // A run that completed is a fresh, first-hand reading of BOTH conditions,
    // so clear whichever this run did not trip. That is what turns a chronic
    // backlog followed by a recovery into two events instead of an endless
    // stream, and it is why the clear happens even on a healthy run.
    // 'failure' is always in this list: reaching here means the sweep ran to
    // completion, which is the only evidence that a crash loop has ended.
    const clears = ['errors', 'backlog', 'failure'].filter((k) => k !== gate.kind);
    for (const kind of clears) {
      await reportAlertCondition({
        key: alertKey(sweepMode, kind), active: false, notifyRecovery: false,
      });
    }

    if (!gate.send) return { sent: false, severity, reason: gate.reason, errorRate };

    // 'all' mode bypasses the condition layer — post every run, as before.
    if (!gate.kind) {
      const insight = await generateBackstopInsight({ sweepMode, severity, counts, scan, errors, results, maxPerRun });
      const card = buildBackstopCard({ sweepMode, severity, scan, counts, errors, results, maxPerRun, intervalMin, insight });
      if (!card) return { sent: false, severity, reason: 'no_card' };
      await send(card);
      return { sent: true, severity, reason: gate.reason, errorRate, insight_used: Boolean(insight) };
    }

    // The body is a thunk so the LLM insight call only happens once the firing
    // edge is won — a silent sweep costs nothing, which is the same reason the
    // pre-2026-09-05 code called the model after the gate rather than before.
    let insightUsed = false;
    const res = await reportAlertCondition({
      key: alertKey(sweepMode, gate.kind),
      active: true,
      label: `${sweepMode} backstop ${gate.kind}`,
      detail: `${severity} — ${gate.reason}`,
      fallbackCooldownMs: gate.cooldownMs,
      notifyRecovery: false,
      send,
      text: async () => {
        const insight = await generateBackstopInsight({ sweepMode, severity, counts, scan, errors, results, maxPerRun });
        insightUsed = Boolean(insight);
        return buildBackstopCard({ sweepMode, severity, scan, counts, errors, results, maxPerRun, intervalMin, insight });
      },
    });

    if (!res.sent) {
      return { sent: false, severity, reason: res.reason || res.action, errorRate };
    }
    return { sent: true, severity, reason: gate.reason, errorRate, insight_used: insightUsed };
  } catch (e) {
    console.warn(`[BackstopNotify] ${sweepMode} run notification failed: ${e.message}`);
    return { sent: false, reason: 'send_failed' };
  }
}

/**
 * A sweep that threw before producing a summary — the loudest case, because
 * zero leads were rescued this cycle. Deliberately deterministic: a total
 * failure may itself be an infrastructure failure, which is exactly when the
 * model is least likely to answer. Cooled down separately so a crash loop
 * cannot post every 15 minutes.
 */
export async function notifyBackstopFailure({
  sweepMode, error, nowMs = Date.now(),
  send = (text) => sendGroupMeMessage(text, { flushNow: true }),
}) {
  try {
    if (notifyMode() === 'off') return { sent: false, reason: 'notify_off' };

    const label = sweepMode === 'intake' ? 'LP INTAKE BACKSTOP' : 'LP CONTACT BACKSTOP';
    const msg = String(error?.message || error || 'unknown').slice(0, 300);

    // The key deliberately omits the error message. A crash loop that reports a
    // different message each cycle — a timeout, then a connection reset, then a
    // 502 — is ONE outage, and keying on the text is what made the capacity
    // watchdog read one dead campaign as three separate problems (PR #845).
    const res = await reportAlertCondition({
      key: alertKey(sweepMode, 'failure'),
      active: true,
      label: `${sweepMode} backstop sweep failing`,
      detail: msg,
      fallbackCooldownMs: failureCooldownMs(),
      notifyRecovery: false,
      nowMs,
      send,
      text: () => buildClassifiedNotification({
        notification_class: 'system',
        action_verb: `${label} — SWEEP FAILED`,
        name: 'Sweep did not complete',
        contactId: '—',
        tier: 'Warm',
        status: 'Sweep failed',
        narrative:
          `The ${sweepMode} sweep failed before processing any leads: ${msg}. ` +
          `No contacts were created this cycle — unlinked LP leads stay unlinked until a sweep succeeds.`,
        nextStep: 'Check LP-MCP Railway deploy logs. Repeated failures mean the backstop is not protecting intake at all.',
      }),
    });

    if (!res.sent) return { sent: false, reason: res.reason || res.action };
    return { sent: true };
  } catch (e) {
    console.warn(`[BackstopNotify] ${sweepMode} failure notification failed: ${e.message}`);
    return { sent: false, reason: 'send_failed' };
  }
}
