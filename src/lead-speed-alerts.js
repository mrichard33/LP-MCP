/**
 * Lead-leak alerting — src/lead-speed-alerts.js
 *
 * Pure and dependency-free, like every alert module here (CLAUDE.md,
 * "Alerting"): a shouldAlert* decision with a three-way verdict and a format*
 * body for each of the three alarms. src/jobs/lead-leak-monitor.js owns the
 * reads, the mode switch and delivery through reportAlertCondition.
 *
 *   lead_speed_slow      the typical time to first call is getting worse
 *   lead_uncalled_fresh  owed leads are sitting past the grace with no call
 *   lead_intake_gap      GHL contacts that never became an LP lead
 *
 * Every card NAMES the leads — "the specific details of the lead we are not
 * communicating with" (2026-09-26) — as first name + last initial and the
 * last four digits of the phone. It goes to the internal ops channel, but a
 * full number in a chat log is still a number nobody needs to copy from there;
 * the dashboard page and LP hold the rest.
 *
 * `insufficient_evidence` is never "all clear": a failed read, or too few
 * leads to say anything, maps to reportAlertCondition's `active: null`.
 */

import { LEAK_REASONS } from './lead-leak-classify.js';

// ─── Thresholds — one place; each is env-overridable in alertConfig() ────────
export const ALERT_DEFAULTS = Object.freeze({
  recentDays: 3,        // the "now" window: this many complete ET days before today
  baselineDays: 28,     // compared against the this-many days before that
  slowFactor: 1.5,      // recent median > baseline median × this …
  minMedianMin: 30,     // … and above this many working minutes, to page
  shareRise: 0.10,      // or the share not called within 24h rises by 10 points
  minLeads: 30,         // fewer owed leads than this in either window → can't tell
  graceHours: 2,        // an owed lead uncalled this long (working time) is named
  maxNamed: 15,         // leads listed on one card; the page has the rest
});

export const ALERT_MODES = Object.freeze(['off', 'shadow', 'live']);

const num = (raw, fallback) => {
  const n = Number(String(raw ?? '').trim());
  return String(raw ?? '').trim() !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function alertConfig(env = process.env) {
  const d = ALERT_DEFAULTS;
  return {
    recentDays: num(env.LEAD_SPEED_RECENT_DAYS, d.recentDays),
    baselineDays: num(env.LEAD_SPEED_BASELINE_DAYS, d.baselineDays),
    slowFactor: num(env.LEAD_SPEED_SLOW_FACTOR, d.slowFactor),
    minMedianMin: num(env.LEAD_SPEED_MIN_MEDIAN_MIN, d.minMedianMin),
    shareRise: num(env.LEAD_SPEED_SHARE_RISE, d.shareRise),
    minLeads: num(env.LEAD_SPEED_MIN_LEADS, d.minLeads),
    graceHours: num(env.LEAD_UNCALLED_GRACE_HOURS, d.graceHours),
    maxNamed: num(env.LEAD_ALERT_MAX_NAMED, d.maxNamed),
  };
}

/** off | shadow | live, default shadow; anything unrecognised is shadow. */
export function alertMode(env = process.env) {
  const raw = String(env.LEAD_LEAK_ALERT_MODE ?? '').trim().toLowerCase();
  return ALERT_MODES.includes(raw) ? raw : 'shadow';
}

// ─── Plain-English reasons, for cards and the daily post ─────────────────────
export const REASON_LABELS = Object.freeze({
  not_issued_call_center: 'Not issued to a rep (call center, NIS)',
  not_covered_by_rep: 'Set, but no rep covered it (NOC)',
  rep_hold_expired: 'Rep hold over, back in play',
  routing_or_automation_failure: 'Never dialled — Five9 has the number',
  not_in_five9: 'Never dialled — not in Five9 at all',
  unverified: 'Never dialled',
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' shifted by n days. */
export function shiftDay(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Median of an array, or null. */
function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** The speed numbers of one window of lead items. */
function windowStats(items) {
  const owed = items.filter((l) => l.expected);
  const settled = owed.filter((l) => l.settled24h);
  const slow = settled.filter((l) => l.minutes == null || l.minutes > 24 * 60).length;
  return {
    owed: owed.length,
    median_min: median(items.filter((l) => l.minutes != null).map((l) => l.minutes)),
    pct_not_called_24h: settled.length ? slow / settled.length : null,
  };
}

/**
 * Is the typical time to first call getting worse?
 *
 * `leads` items: { createdDay, minutes, expected, settled24h }
 *   minutes     working minutes to the first Five9 call, null = never
 *   expected    the lead was owed a call (called, or uncalled for a leak reason)
 *   settled24h  24 working hours have passed, or it was called within them —
 *               only these can say whether "called within 24h" happened
 * `todayDay` is today's ET date; today is never in either window (partial).
 */
export function shouldAlertSpeed({ leads, todayDay }, cfg = ALERT_DEFAULTS) {
  const recentStart = shiftDay(todayDay, -cfg.recentDays);
  const baseStart = shiftDay(recentStart, -cfg.baselineDays);
  const recentItems = (leads || []).filter((l) => l.createdDay >= recentStart && l.createdDay < todayDay);
  const baseItems = (leads || []).filter((l) => l.createdDay >= baseStart && l.createdDay < recentStart);
  const recent = windowStats(recentItems);
  const baseline = windowStats(baseItems);

  if (recent.owed < cfg.minLeads || baseline.owed < cfg.minLeads || baseline.median_min == null) {
    return { verdict: 'insufficient_evidence', recent, baseline, reasons: [] };
  }
  const reasons = [];
  if (recent.median_min != null
    && recent.median_min > baseline.median_min * cfg.slowFactor
    && recent.median_min > cfg.minMedianMin) {
    reasons.push('slower');
  }
  if (recent.pct_not_called_24h != null && baseline.pct_not_called_24h != null
    && recent.pct_not_called_24h - baseline.pct_not_called_24h > cfg.shareRise) {
    reasons.push('more_uncalled');
  }
  return { verdict: reasons.length ? 'alert' : 'healthy', recent, baseline, reasons };
}

/**
 * Owed leads waiting past the grace with no Five9 call. `readOk` false (a
 * failed read upstream) → insufficient_evidence, never a false all-clear.
 */
export function shouldAlertUncalled(offenders, { readOk = true } = {}) {
  if (!readOk || !Array.isArray(offenders)) return { verdict: 'insufficient_evidence', count: null };
  return { verdict: offenders.length ? 'alert' : 'healthy', count: offenders.length };
}

/** GHL contacts that never became an LP lead and were never rung. */
export function shouldAlertIntakeGap(gapRows, { readOk = true } = {}) {
  if (!readOk || !Array.isArray(gapRows)) return { verdict: 'insufficient_evidence', count: null };
  const missing = gapRows.filter((r) => r.class === 'not_in_lp');
  return { verdict: missing.length ? 'alert' : 'healthy', count: missing.length, missing };
}

/** Map a verdict onto reportAlertCondition's tri-state `active`. */
export const verdictToActive = (verdict) => (verdict === 'alert' ? true : verdict === 'healthy' ? false : null);

// ─── Card bodies ──────────────────────────────────────────────────────────────

/** "Jane D." — first name and last initial. Never a pronoun (CLAUDE.md). */
export function displayName(first, last) {
  const f = String(first ?? '').trim();
  const l = String(last ?? '').trim();
  if (!f && !l) return 'No name';
  return l ? `${f || '?'} ${l[0].toUpperCase()}.` : f;
}

/** "…3161" — the last four digits only. */
export const phoneTail = (phone10) => (phone10 ? `…${String(phone10).slice(-4)}` : 'no phone');

/** "3h 10m" / "2d 4h" / "12m". */
export function formatWait(ms) {
  if (!Number.isFinite(ms)) return '?';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h}h ${mins % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "1h 5m" for a minutes figure, or "n/a". */
export const formatMinutes = (m) => (m == null ? 'n/a' : formatWait(m * 60000));
const pct = (x) => (x == null ? 'n/a' : `${Math.round(x * 100)}%`);

/**
 * One line per named lead. `offenders` items:
 *   { first_name, last_name, phone10, lead_source, reason, waitingMs, lp_lead_id }
 */
function offenderLines(offenders, max) {
  const shown = offenders.slice(0, max).map((o) => `• ${displayName(o.first_name, o.last_name)} · ${phoneTail(o.phone10)}`
    + ` · ${o.lead_source || 'no source'} · waiting ${formatWait(o.waitingMs)}`
    + ` · ${REASON_LABELS[o.reason] || o.reason} · LP ${o.lp_lead_id}`);
  if (offenders.length > max) shown.push(`…and ${offenders.length - max} more`);
  return shown;
}

const linkLine = (dashboardUrl) => (dashboardUrl ? `Full list: ${dashboardUrl}` : 'Full list: Dashboard → Lead Leaks');

export function formatSpeedAlert(decision, offenders, { cfg = ALERT_DEFAULTS, dashboardUrl } = {}) {
  const r = decision.recent;
  const b = decision.baseline;
  const why = [];
  if (decision.reasons.includes('slower')) {
    why.push(`Typical time to first call is ${formatMinutes(r.median_min)} over the last ${cfg.recentDays} days,`
      + ` up from ${formatMinutes(b.median_min)} over the ${cfg.baselineDays} days before.`);
  }
  if (decision.reasons.includes('more_uncalled')) {
    why.push(`${pct(r.pct_not_called_24h)} of leads were not called within 24 working hours,`
      + ` up from ${pct(b.pct_not_called_24h)}.`);
  }
  return [
    '🐢 *Leads are being called more slowly* (Five9 call records)',
    ...why,
    '',
    offenders.length ? `Leads waiting right now with no call (${offenders.length}):` : 'No lead is waiting past the grace right now.',
    ...offenderLines(offenders, cfg.maxNamed),
    '',
    linkLine(dashboardUrl),
  ].join('\n');
}

export function formatSpeedRecovered(decision) {
  return `✅ Time to first call is back to normal: ${formatMinutes(decision.recent?.median_min)} over the last few days.`;
}

export function formatUncalledAlert(offenders, { cfg = ALERT_DEFAULTS, dashboardUrl } = {}) {
  return [
    `📵 *${offenders.length} lead${offenders.length === 1 ? '' : 's'} waiting more than ${cfg.graceHours}h with no Five9 call*`,
    '(clock counts call-center hours only)',
    ...offenderLines(offenders, cfg.maxNamed),
    '',
    linkLine(dashboardUrl),
  ].join('\n');
}

export const formatUncalledRecovered = () => '✅ Every owed lead has now had a Five9 call.';

export function formatIntakeGapAlert(missing, { cfg = ALERT_DEFAULTS, dashboardUrl } = {}) {
  const lines = missing.slice(0, cfg.maxNamed).map((g) => `• ${displayName(g.first_name, g.last_name)} · ${phoneTail(g.phone10)}`
    + ` · ${g.source || 'no source'} · in GHL since ${String(g.date_added ?? '').slice(0, 10)} · GHL ${g.ghl_contact_id}`);
  if (missing.length > cfg.maxNamed) lines.push(`…and ${missing.length - cfg.maxNamed} more`);
  return [
    `🚪 *${missing.length} lead${missing.length === 1 ? '' : 's'} in GHL never reached LP* — so Five9 could never dial them`,
    ...lines,
    '',
    linkLine(dashboardUrl),
  ].join('\n');
}

export const formatIntakeGapRecovered = () => '✅ Every GHL lead from the window has reached LP (or been called).';

export { LEAK_REASONS };
