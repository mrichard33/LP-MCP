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
import { workingMsBetween } from './lead-speed.js';

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
// 2026-09-29 — `unverified` used to read plain "Never dialled", which is what
// every line on the waiting card said because the hourly pass never looked a
// lead up. It now means only "we could not check", and says so.
export const REASON_LABELS = Object.freeze({
  called_no_retry: 'Called, no retry since',
  not_on_dial_list: 'In Five9 but not on any dialing list',
  // The group header; each line names the list (reasonText).
  on_list_not_dialed: 'On a Five9 list but no call recorded',
  not_issued_call_center: 'Not issued to a rep (call center, NIS)',
  not_covered_by_rep: 'Not Covered (no rep)',
  noc_out_of_area: 'NOC — out of area (review)',
  rep_hold_expired: 'Rep hold over, back in play',
  routing_or_automation_failure: 'Never dialled — Five9 has the number',
  not_in_five9: 'Not in Five9 at all',
  unverified: 'Not verified — Five9 lookup failed or skipped',
});

// Tie-break order for groups on the waiting card, the most actionable first.
// Groups are ordered by how many FRESH leads they hold (groupedOffenderLines);
// this only decides between groups with equal counts.
export const CARD_REASON_ORDER = Object.freeze([
  'called_no_retry', 'not_on_dial_list', 'on_list_not_dialed', 'routing_or_automation_failure', 'not_in_five9',
  'not_issued_call_center', 'not_covered_by_rep', 'rep_hold_expired', 'unverified',
]);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Freshest leads first (2026-09-29). The cards used to list the longest wait
// first, so on the daily card (60-day window) the 15 named lines were all
// August leads and a lead from this morning — the one still worth saving —
// never made the card. "Fresh" for group ordering is the last 24 CALL-CENTER
// hours, so a lead from Friday evening still counts as fresh on Monday morning.
export const FRESH_WORKING_MS = 24 * HOUR_MS;
// The daily speed card names only leads created in the last this-many days;
// older ones are one count line pointing at the dashboard.
export const SPEED_CARD_NAMED_DAYS = 7;

/**
 * When the lead was created (ms), or null. The job sets `createdMs`; a caller
 * that only has the wait falls back to now − wait, which orders the same way.
 */
export function offenderCreatedMs(o, nowMs = Date.now()) {
  if (Number.isFinite(o?.createdMs)) return o.createdMs;
  return Number.isFinite(o?.waitingMs) ? nowMs - o.waitingMs : null;
}

/** Sort comparator: newest lead first; an unknown creation time goes last. */
export function newestFirst(a, b, nowMs = Date.now()) {
  const ca = offenderCreatedMs(a, nowMs);
  const cb = offenderCreatedMs(b, nowMs);
  if (ca == null || cb == null) return (ca == null) - (cb == null);
  return cb - ca;
}

/** { reason: count } over every offender — the endpoint's waiting_by_reason. */
export function countByReason(offenders) {
  const out = {};
  for (const o of offenders || []) out[o.reason] = (out[o.reason] || 0) + 1;
  return out;
}

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
 * The reason as the card prints it. called_no_retry carries its own numbers:
 * "Called 2× (last: Answering Machine, 20h 3m ago) — no retry since".
 * `o.calls` = { count, lastMs, lastDispo } when the job had them; `nowMs` is
 * the clock the age is measured against.
 */
export function reasonText(o, nowMs = Date.now()) {
  if (o.reason === 'called_no_retry' && o.calls) {
    const last = [o.calls.lastDispo || 'no disposition', Number.isFinite(o.calls.lastMs)
      ? `${formatWait(nowMs - o.calls.lastMs)} ago` : null].filter(Boolean).join(', ');
    return `Called ${o.calls.count}× (last: ${last}) — no retry since`;
  }
  if (o.reason === 'on_list_not_dialed' && o.five9_record?.list) {
    return `On ${o.five9_record.list} in Five9 but no call recorded`;
  }
  return REASON_LABELS[o.reason] || o.reason;
}

/**
 * One line per named lead. `offenders` items:
 *   { first_name, last_name, phone10, lead_source, reason, waitingMs, lp_lead_id, calls? }
 */
function offenderLine(o, nowMs) {
  return `• ${displayName(o.first_name, o.last_name)} · ${phoneTail(o.phone10)}`
    + ` · ${o.lead_source || 'no source'} · waiting ${formatWait(o.waitingMs)}`
    + ` · ${reasonText(o, nowMs)} · LP ${o.lp_lead_id}`;
}

/**
 * Split `max` named lines across groups of these sizes, round-robin in group
 * order: every group gets a line before any gets a second, so each gets 3 (or
 * all it has) before any gets a 4th — the handoff's floor — and one large
 * group can no longer use up the whole card. Returns lines per group.
 */
export function allocateLines(sizes, max) {
  const shown = sizes.map(() => 0);
  let left = Math.max(0, Math.floor(max));
  while (left > 0) {
    let gave = false;
    for (let i = 0; i < sizes.length && left > 0; i += 1) {
      if (shown[i] < sizes[i]) { shown[i] += 1; left -= 1; gave = true; }
    }
    if (!gave) break;
  }
  return shown;
}

/**
 * The lines grouped by reason (2026-09-29, #1079), so the team sees "31 not on
 * a dialing list / 6 called, no retry" at a glance:
 *   - inside each group, newest lead first;
 *   - groups ordered by how many leads from the last 24 call-center hours they
 *     hold, most first (then total, then CARD_REASON_ORDER) — the group with
 *     today's leads is the one someone can still act on;
 *   - `max` named lines split across groups (allocateLines);
 *   - every header carries the group's FULL count, and "(showing N)" when its
 *     lines were cut.
 */
function groupedOffenderLines(offenders, max, nowMs) {
  const groups = new Map();
  for (const o of offenders) groups.set(o.reason, [...(groups.get(o.reason) || []), o]);
  const isFresh = (o) => {
    const c = offenderCreatedMs(o, nowMs);
    return c != null && workingMsBetween(c, nowMs) <= FRESH_WORKING_MS;
  };
  const rank = (r) => { const i = CARD_REASON_ORDER.indexOf(r); return i < 0 ? CARD_REASON_ORDER.length : i; };
  const ordered = [...groups.entries()]
    .map(([reason, list]) => ({
      reason, list: [...list].sort((a, b) => newestFirst(a, b, nowMs)), fresh: list.filter(isFresh).length,
    }))
    .sort((a, b) => b.fresh - a.fresh || b.list.length - a.list.length
      || rank(a.reason) - rank(b.reason) || a.reason.localeCompare(b.reason));
  const shown = allocateLines(ordered.map((g) => g.list.length), max);
  const out = [];
  ordered.forEach((g, i) => {
    const cut = shown[i] < g.list.length ? ` (showing ${shown[i]})` : '';
    out.push(`*${REASON_LABELS[g.reason] || g.reason} — ${g.list.length}${cut}*`);
    for (const o of g.list.slice(0, shown[i])) out.push(offenderLine(o, nowMs));
  });
  const named = shown.reduce((n, x) => n + x, 0);
  if (offenders.length > named) out.push(`…and ${offenders.length - named} more`);
  return out;
}

const linkLine = (dashboardUrl) => (dashboardUrl ? `Full list: ${dashboardUrl}` : 'Full list: Dashboard → Lead Leaks');

export function formatSpeedAlert(decision, offenders, { cfg = ALERT_DEFAULTS, dashboardUrl, nowMs = Date.now() } = {}) {
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
  // Name only the last SPEED_CARD_NAMED_DAYS of leads (2026-09-29): this card
  // runs off the 60-day pass, and its named lines were all August leads.
  const since = nowMs - SPEED_CARD_NAMED_DAYS * DAY_MS;
  const recent = offenders.filter((o) => { const c = offenderCreatedMs(o, nowMs); return c == null || c >= since; });
  const older = offenders.length - recent.length;
  return [
    '🐢 *Leads are being called more slowly* (Five9 call records)',
    ...why,
    '',
    offenders.length ? `Leads waiting right now for a call (${offenders.length}):` : 'No lead is waiting past the grace right now.',
    ...groupedOffenderLines(recent, cfg.maxNamed, nowMs),
    ...(older ? [`+ ${older} older lead${older === 1 ? '' : 's'} (${SPEED_CARD_NAMED_DAYS + 1}+ days) — see dashboard`] : []),
    '',
    linkLine(dashboardUrl),
  ].join('\n');
}

export function formatSpeedRecovered(decision) {
  return `✅ Time to first call is back to normal: ${formatMinutes(decision.recent?.median_min)} over the last few days.`;
}

export function formatUncalledAlert(offenders, { cfg = ALERT_DEFAULTS, dashboardUrl, nowMs = Date.now() } = {}) {
  return [
    `📵 *${offenders.length} lead${offenders.length === 1 ? '' : 's'} waiting more than ${cfg.graceHours}h for a Five9 call*`,
    '(never called, or called and not retried — clock counts call-center hours only)',
    ...groupedOffenderLines(offenders, cfg.maxNamed, nowMs),
    '',
    linkLine(dashboardUrl),
  ].join('\n');
}

export const formatUncalledRecovered = () => '✅ Every owed lead has now had a Five9 call (or a retry).';

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

/**
 * Retired disposition codes put on a lead since the last check (NIS2,
 * 2026-09-28). A data-quality alarm, not a leak bucket: the lead is still
 * classified normally; this names who used the dead code so it gets re-coded.
 * `fresh` items: { lp_lead_id, first_name, last_name, disposition_code }.
 */
export function shouldAlertRetiredCode(fresh, { readOk = true } = {}) {
  if (!readOk || !Array.isArray(fresh)) return { verdict: 'insufficient_evidence', count: null };
  return { verdict: fresh.length ? 'alert' : 'healthy', count: fresh.length };
}

export function formatRetiredCodeAlert(fresh, { cfg = ALERT_DEFAULTS, dashboardUrl } = {}) {
  const lines = fresh.slice(0, cfg.maxNamed).map((l) => `• ${displayName(l.first_name, l.last_name)}`
    + ` · coded ${l.disposition_code} · LP ${l.lp_lead_id}`);
  if (fresh.length > cfg.maxNamed) lines.push(`…and ${fresh.length - cfg.maxNamed} more`);
  return [
    `🏷️ *Retired code used on ${fresh.length} lead${fresh.length === 1 ? '' : 's'} in the last day*`,
    'NIS2 is retired and should not be used. Please re-code these in LP:',
    ...lines,
    '',
    linkLine(dashboardUrl),
  ].join('\n');
}

export const formatRetiredCodeRecovered = () => '✅ No retired codes used in the last day.';

export { LEAK_REASONS };
