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

const notifyMode = () => String(process.env.LP_BACKSTOP_NOTIFY_MODE || DEFAULT_NOTIFY_MODE).toLowerCase();
const deferThreshold = () => Math.max(1, parseInt(process.env.LP_BACKSTOP_DEFER_ALERT_THRESHOLD || String(DEFAULT_DEFER_THRESHOLD), 10));
const cooldownMs = () => Math.max(0, parseInt(process.env.LP_BACKSTOP_ALERT_COOLDOWN_MIN || String(DEFAULT_COOLDOWN_MIN), 10)) * 60000;
const failureCooldownMs = () => Math.max(0, parseInt(process.env.LP_BACKSTOP_FAILURE_COOLDOWN_MIN || String(DEFAULT_FAILURE_COOLDOWN_MIN), 10)) * 60000;

// key -> last-sent ms. In-memory; resets on redeploy. Same trade-off already
// accepted for the admin job registry in src/admin/lp-contact-backstop.js.
const lastAlertAt = new Map();

/** Test hook — clears cooldown state. */
export function __resetCooldowns() { lastAlertAt.clear(); }

/**
 * Severity of a completed run. Errors outrank backlog: a run can be both,
 * and errored leads are the more actionable fact.
 *   failing  — leads errored; those leads are still unlinked.
 *   degraded — the per-run cap left eligible leads unprocessed.
 *   healthy  — everything attempted succeeded. Silent by default.
 */
export function classifyRun({ counts = {}, scan = {} } = {}) {
  const errorCount = counts.error || 0;
  const deferred = scan.deferredCapped || 0;
  if (errorCount > 0) return { severity: 'failing', reason: 'lead_errors' };
  if (deferred >= deferThreshold()) return { severity: 'degraded', reason: 'backlog_pressure' };
  return { severity: 'healthy', reason: 'clean_run' };
}

/**
 * Gate. Mutates cooldown state when it returns send:true for a degraded run,
 * so callers must call this exactly once per run. Chronic backlog would
 * otherwise alert every 15 minutes — exactly the noise this removes. Errors
 * bypass the cooldown: they are rare and each names different leads.
 */
export function shouldNotify({ severity, sweepMode, nowMs = Date.now() }) {
  const mode = notifyMode();
  if (mode === 'off') return { send: false, reason: 'notify_off' };
  if (mode === 'all') return { send: true, reason: 'notify_all' };
  if (severity === 'healthy') return { send: false, reason: 'clean_run' };
  if (severity === 'failing') return { send: true, reason: 'errors_bypass_cooldown' };

  const key = `${sweepMode}:backlog`;
  const last = lastAlertAt.get(key) || 0;
  if (nowMs - last < cooldownMs()) return { send: false, reason: 'backlog_cooldown' };
  lastAlertAt.set(key, nowMs);
  return { send: true, reason: 'backlog_pressure' };
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
    verb = `${label} — ERRORS`;
    status = `${counts.error} lead(s) failed`;
    narrative =
      `${counts.error} of ${processed} lead(s) failed mid-sweep and still have no GHL contact — ` +
      `no speed-to-lead, no routing, invisible to the dashboard until a later sweep succeeds. ` +
      `${counts.created || 0} created, ${counts.linked || 0} linked this run.`;
    nextStep = 'Same leads erroring next sweep means systemic, not transient — check the error text below before touching the sweep config.';
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
export async function notifyBackstopRun({ sweepMode, scan, counts, errors, results, maxPerRun, intervalMin = 15 }) {
  try {
    const { severity } = classifyRun({ counts, scan });
    const gate = shouldNotify({ severity, sweepMode });
    if (!gate.send) return { sent: false, severity, reason: gate.reason };

    const insight = await generateBackstopInsight({ sweepMode, severity, counts, scan, errors, results, maxPerRun });
    const card = buildBackstopCard({ sweepMode, severity, scan, counts, errors, results, maxPerRun, intervalMin, insight });
    if (!card) return { sent: false, severity, reason: 'no_card' };

    await sendGroupMeMessage(card, { flushNow: true });
    return { sent: true, severity, reason: gate.reason, insight_used: Boolean(insight) };
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
export async function notifyBackstopFailure({ sweepMode, error, nowMs = Date.now() }) {
  try {
    if (notifyMode() === 'off') return { sent: false, reason: 'notify_off' };
    const key = `${sweepMode}:failure`;
    const last = lastAlertAt.get(key) || 0;
    if (nowMs - last < failureCooldownMs()) return { sent: false, reason: 'failure_cooldown' };
    lastAlertAt.set(key, nowMs);

    const label = sweepMode === 'intake' ? 'LP INTAKE BACKSTOP' : 'LP CONTACT BACKSTOP';
    const msg = String(error?.message || error || 'unknown').slice(0, 300);
    const card = buildClassifiedNotification({
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
    });
    await sendGroupMeMessage(card, { flushNow: true });
    return { sent: true };
  } catch (e) {
    console.warn(`[BackstopNotify] ${sweepMode} failure notification failed: ${e.message}`);
    return { sent: false, reason: 'send_failed' };
  }
}
