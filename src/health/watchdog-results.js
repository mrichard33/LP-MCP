/**
 * watchdog-results.js — turn what an existing watchdog already decided into
 * health_results entries (System Health Phase 0, 2026-10-15).
 *
 * The rule: no watchdog changes what it posts. Each one adds `health: [...]`
 * to the value it already returns (runJob writes them), or, for the two that
 * do not run under runJob (reply SLA, executor heartbeat), calls
 * recordThrottled(). The builders here are pure: they take the watchdog's own
 * verdict and numbers and return entries the recorder resolves against the
 * check's config (src/health/record.js resolveStatus), so the warn band is a
 * row in health_checks, never a constant here.
 *
 * Tri-state, every time: a watchdog that could not tell gives status
 * 'unknown'. Outside a check's active window the entry is 'skipped' (the check
 * was not asked), never 'pass'.
 */

import { recordHealthResult } from './record.js';
import { displayName } from '../lead-speed-alerts.js';
import { count as countOf, dayWords, duration, money } from './plain.js';

const MIN = 60_000;

/** Lead line for a detail list: who, which source, how long, what it is worth. */
export function leadLine(o, nowMs) {
  const waitingMs = Number.isFinite(o?.waitingMs) ? o.waitingMs
    : Number.isFinite(o?.createdMs) ? nowMs - o.createdMs : null;
  return {
    lp_lead_id: o?.lp_lead_id != null ? String(o.lp_lead_id) : null,
    name: displayName(o?.first_name, o?.last_name),
    // The full 10 digits (the user, 2026-10-13: never the last four on a card).
    phone10: o?.phone10 ? String(o.phone10).replace(/\D/g, '').slice(-10) : null,
    source: o?.lead_source ?? o?.source ?? null,
    reason: o?.reason ?? null,
    waiting_min: waitingMs == null ? null : Math.round(waitingMs / MIN),
    est_value: Number.isFinite(Number(o?.est_value)) ? Math.round(Number(o.est_value)) : null,
  };
}

const verdictActive = (verdict) => (verdict === 'alert' ? true : verdict === 'healthy' ? false : null);

/* ── lead-uncalled-check → lead.uncalled_live ───────────────────────────── */

/**
 * value = the longest wait (minutes). fail at fail_wait_min, or when
 * fail_count_over_warn+ leads are past warn_wait_min; warn at warn_wait_min.
 */
export function uncalledLiveRule(_value, config, lines) {
  const warn = Number(config.warn_wait_min ?? 30);
  const fail = Number(config.fail_wait_min ?? 60);
  const failCount = Number(config.fail_count_over_warn ?? 3);
  const waits = lines.map((l) => l.waiting_min).filter((n) => Number.isFinite(n));
  const max = waits.length ? Math.max(...waits) : 0;
  const overWarn = waits.filter((w) => w >= warn).length;
  if (max >= fail || overWarn >= failCount) return 'fail';
  if (max >= warn) return 'warn';
  return 'pass';
}

export function uncalledLiveResults({ decision, offenders, nowMs, errors = [] }) {
  if (!decision || decision.verdict === 'insufficient_evidence') {
    return [{ check_id: 'lead.uncalled_live', status: 'unknown', summary: `Can't tell right now: ${errors.join('; ') || 'the lead or Five9 read failed'}`.slice(0, 300), fingerprint: 'lead.uncalled_live' }];
  }
  const lines = (offenders || []).map((o) => leadLine(o, nowMs)).sort((a, b) => (b.waiting_min ?? 0) - (a.waiting_min ?? 0));
  // 2026-10-15: "6 leads are waiting for a first call" when 4 of the 6 had been
  // called once and were waiting on a SECOND call. Only never-called leads
  // count toward red; a missing follow-up call is yellow, said as what it is.
  // 2026-10-16: a lead whose After DIAL ASAP attempts ran out was called too.
  const calledAlready = (r) => r === 'called_no_retry' || r === 'attempts_exhausted_not_handed';
  const never = lines.filter((l) => !calledAlready(l.reason));
  const retry = lines.filter((l) => calledAlready(l.reason));
  const max = never.length ? (never[0].waiting_min ?? 0) : 0;
  const atRisk = lines.reduce((s, l) => s + (l.est_value || 0), 0);
  const parts = [];
  if (never.length) parts.push(`${countOf(never.length, 'lead')} ${never.length === 1 ? 'has' : 'have'} not had a first call yet; the longest has waited ${duration(max)}.`);
  if (retry.length) parts.push(`${countOf(retry.length, 'lead')} ${retry.length === 1 ? 'was' : 'were'} called once and ${retry.length === 1 ? 'is' : 'are'} waiting on a second call (the longest for ${duration(retry[0].waiting_min ?? 0)}).`);
  return [{
    check_id: 'lead.uncalled_live',
    value: max,
    rule: (_v, config) => {
      const verdict = uncalledLiveRule(max, config, never);
      return verdict === 'pass' && retry.length ? 'warn' : verdict;
    },
    summary: parts.length ? parts.join(' ') : 'Every lead that should have been called has been called.',
    detail: { waiting: never.length, waiting_second_call: retry.length, est_value_at_risk: atRisk, leads: lines },
    fingerprint: 'lead.uncalled_live',
  }];
}

/* ── lead-leak-monitor (daily) ──────────────────────────────────────────── */

function reasonCount(summary, reasons) {
  const by = summary?.by_reason || {};
  let leads = 0;
  let value = 0;
  for (const r of reasons) {
    leads += Number(by[r]?.leads || 0);
    value += Number(by[r]?.est_value || by[r]?.est_value_at_risk || 0);
  }
  return { leads, value: Math.round(value) };
}

function reasonLeads(rows, reasons, nowMs) {
  return (rows || []).filter((r) => reasons.includes(r.reason)).map((r) => {
    const createdMs = Date.parse(r.detail?.created_utc || '');
    return {
      ...leadLine({ ...(r.detail || {}), lp_lead_id: r.lp_lead_id, lead_source: r.lead_source, reason: r.reason, est_value: r.est_value }, nowMs),
      created_ms: Number.isFinite(createdMs) ? createdMs : null,
    };
  });
}

/**
 * 2026-10-15 (the user): "Leads that never reached Five9" was Urgent every
 * morning for the same 13 leads from Aug 22 to Sep 17. Mark's rule is "post
 * only what is new", so a lead from the last NEW_LEAK_DAYS days decides the
 * color; older open ones stay listed, yellow, as a cleanup for a person.
 */
export const NEW_LEAK_DAYS = 2;
export function splitNewOld(lines, nowMs) {
  const cut = nowMs - NEW_LEAK_DAYS * 24 * 3600e3;
  const isNew = (l) => l.created_ms == null || l.created_ms >= cut;
  return { fresh: lines.filter(isNew), old: lines.filter((l) => !isNew(l)) };
}

function dayRange(lines) {
  const days = lines.map((l) => l.created_ms).filter(Number.isFinite).sort((a, b) => a - b);
  if (!days.length) return '';
  const fmt = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }).format(new Date(ms));
  const a = fmt(days[0]);
  const b = fmt(days[days.length - 1]);
  return a === b ? ` (${a})` : ` (${a} to ${b})`;
}

/**
 * The daily leak pass. `m` is measureLeadLeak's result, `retired` the retired
 * code decision, `speedRow` yesterday's lead_call_speed_daily row (or null),
 * `inboundQueueSplit` true once the in_inbound_queue reason exists (Phase 1.9).
 */
export function leadLeakResults({ m, nowMs, retiredDecision, speedRow = null, inboundQueueSplit = false }) {
  if (!m || m.verdict === 'insufficient_evidence') {
    const why = `Can't tell right now: ${(m?.errors || []).join('; ') || 'the lead or Five9 read failed'}`.slice(0, 300);
    return ['lead.not_in_five9', 'lead.in_inbound_queue', 'lead.routing_failure', 'sync.retired_code', 'lead.first_call_p90']
      .map((id) => ({ check_id: id, status: 'unknown', summary: why, fingerprint: id }));
  }
  const out = [];
  const add = (checkId, reasons, label) => {
    const lines = reasonLeads(m.rows, reasons, nowMs);
    const { leads: total, value: totalValue } = reasonCount(m.summary, reasons);
    const { fresh, old } = splitNewOld(lines, nowMs);
    const sum = (list) => list.reduce((s, l) => s + (l.est_value || 0), 0);
    // Leads counted in the summary with no row to date them count as new.
    const undated = Math.max(0, total - lines.length);
    const undatedValue = Math.max(0, totalValue - sum(lines));
    const leads = fresh.length + undated;
    const value = Math.round(sum(fresh) + undatedValue);
    const oldValue = Math.round(sum(old));
    const parts = [];
    if (leads) parts.push(`${countOf(leads, old.length ? 'new lead' : 'lead')} ${label} (worth about ${money(value)}).`);
    if (old.length) parts.push(`${countOf(old.length, 'older lead')}${dayRange(old)} ${label} and ${old.length === 1 ? 'is' : 'are'} still open (worth about ${money(oldValue)}): someone should call or close ${old.length === 1 ? 'it' : 'them'}.`);
    out.push({
      check_id: checkId,
      value: leads,
      rule: (_v, c) => {
        if (leads >= Number(c.fail_leads ?? Infinity) || (c.fail_value != null && value > Number(c.fail_value))) return 'fail';
        if (leads >= Number(c.warn_leads ?? Infinity) || old.length) return 'warn';
        return 'pass';
      },
      summary: parts.length ? parts.join(' ') : `No leads ${label}.`,
      detail: { leads_count: leads, est_value_at_risk: value, older_count: old.length, older_value: oldValue, leads: [...fresh, ...old].map(({ created_ms, ...l }) => ({ ...l, created: created_ms ? new Date(created_ms).toISOString() : null, older: !!(created_ms && old.some((o) => o.lp_lead_id === l.lp_lead_id)) })) },
      fingerprint: checkId,
    });
  };
  add('lead.not_in_five9', ['not_in_five9'], 'never reached Five9');
  if (inboundQueueSplit) add('lead.in_inbound_queue', ['in_inbound_queue'], 'were still waiting in Lead Perfection to be turned into a lead');
  else out.push({ check_id: 'lead.in_inbound_queue', status: 'unknown', summary: 'Coming later.', fingerprint: 'lead.in_inbound_queue' });
  add('lead.routing_failure', ['routing_or_automation_failure', 'on_list_not_dialed'], 'were lost to a routing or automation problem');

  const fresh = retiredDecision?.verdict === 'insufficient_evidence' ? null : (m.retiredFresh || []);
  out.push(fresh === null
    ? { check_id: 'sync.retired_code', status: 'unknown', summary: "Can't tell right now: the retired codes couldn't be read.", fingerprint: 'sync.retired_code' }
    : {
      check_id: 'sync.retired_code',
      value: fresh.length,
      eval: {},
      active: false,
      summary: fresh.length ? `${countOf(fresh.length, 'lead')} got an old, retired result code in the last day.` : 'No lead got an old, retired result code in the last day.',
      detail: { leads: fresh.slice(0, 50) },
      fingerprint: 'sync.retired_code',
    });

  if (!speedRow) {
    out.push({ check_id: 'lead.first_call_p90', status: 'unknown', summary: "Can't tell yet: yesterday's call-speed numbers aren't in.", fingerprint: 'lead.first_call_p90' });
  } else {
    const p90 = Number(speedRow.p90_min);
    const never = Number(speedRow.never_called ?? 0);
    const expected = Number(speedRow.expected ?? speedRow.leads ?? 0);
    const neverPct = expected > 0 ? (never / expected) * 100 : 0;
    out.push({
      check_id: 'lead.first_call_p90',
      value: Number.isFinite(p90) ? p90 : null,
      rule: (_v, c) => {
        if (!Number.isFinite(p90)) return 'unknown';
        if (p90 > Number(c.fail_p90_min ?? Infinity) || neverPct > Number(c.fail_never_called_pct ?? Infinity)) return 'fail';
        if (p90 > Number(c.warn_p90_min ?? Infinity)) return 'warn';
        return 'pass';
      },
      summary: `${dayWords(speedRow.created_day)}: 9 in 10 new leads were called within ${Number.isFinite(p90) ? duration(p90) : 'an unknown time'}${never ? `; ${never} of ${expected} were never called` : ''}.`,
      detail: { day: speedRow.created_day, p90_min: p90, never_called: never, expected, never_called_pct: Math.round(neverPct * 10) / 10 },
      fingerprint: 'lead.first_call_p90',
    });
  }
  return out;
}

/* ── five9-silence-watchdog → dialer.silence ────────────────────────────── */

export function five9SilenceResults({ active, reason, latest, nowMs }) {
  if (reason === 'outside_business_hours') {
    return [{ check_id: 'dialer.silence', status: 'skipped', summary: 'Only checked during calling hours (Monday to Saturday, 9 AM to 6 PM Eastern).', fingerprint: 'dialer.silence' }];
  }
  const ageMin = latest?.received_at ? Math.round((nowMs - Date.parse(latest.received_at)) / MIN) : null;
  return [{
    check_id: 'dialer.silence',
    active,
    value: ageMin,
    summary: active === null
      ? `Can't tell right now: ${reason}`
      : ageMin <= 5 ? 'Five9 is sending call activity normally.' : `No call activity from Five9 for ${duration(ageMin)}.`,
    detail: { reason, last_event_at: latest?.received_at ?? null },
    fingerprint: 'dialer.silence',
  }];
}

/* ── lp-report-watchdog → sync.lp_reports (one result per report) ───────── */

const REPORT_NUMBER = /Report (\d{3})/;

/** minutes past midnight ET of `nowMs`. */
export function etMinuteOfDay(nowMs) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(nowMs));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

const hhmm = (s) => {
  const [h, m] = String(s || '').split(':').map(Number);
  return Number.isFinite(h) ? h * 60 + (m || 0) : null;
};

/**
 * One entry per watched report. `state`: 'ok' | 'missing' | 'read_failed' |
 * 'unarmed' | 'never_scheduled'. A daily report missing before warn_at_et is
 * not late yet ('pass', said so); a monthly one past its grace day is 'fail'.
 */
export function lpReportResult({ type, label, cadence = 'daily', state, lastEtDay, nowMs }) {
  const num = REPORT_NUMBER.exec(label || '')?.[1] || null;
  const name = label || type;
  const fp = `sync.lp_reports:${type}`;
  const detail = { report_type: type, report_number: num, report: name, cadence, last_ingested_et: lastEtDay ?? null };
  if (state === 'read_failed') return { check_id: 'sync.lp_reports', status: 'unknown', summary: `${name}: can't tell right now (the report log couldn't be read).`, detail, fingerprint: fp };
  if (state === 'unarmed') return { check_id: 'sync.lp_reports', status: 'unknown', summary: `${name}: arriving, but not through the usual email route yet, so a missed day won't be noticed.`, detail, fingerprint: fp };
  if (state === 'never_scheduled') return { check_id: 'sync.lp_reports', status: 'skipped', summary: `${name}: not scheduled in Lead Perfection yet.`, detail, fingerprint: fp };
  if (state === 'ok') return { check_id: 'sync.lp_reports', status: 'pass', summary: `${name}: arrived ${lastEtDay ? dayWords(lastEtDay) : 'today'}.`, detail, fingerprint: fp };
  const minute = etMinuteOfDay(nowMs);
  return {
    check_id: 'sync.lp_reports',
    value: minute,
    rule: (_v, c) => {
      if (cadence === 'monthly') return 'fail';
      const fail = hhmm(c.fail_at_et ?? '10:00');
      const warn = hhmm(c.warn_at_et ?? '08:30');
      if (fail !== null && minute >= fail) return 'fail';
      if (warn !== null && minute >= warn) return 'warn';
      return 'pass';
    },
    summary: `${name}: not arrived ${cadence === 'monthly' ? 'this month' : 'today'} (last one: ${lastEtDay ? dayWords(lastEtDay) : 'never'}).`,
    detail,
    fingerprint: fp,
  };
}

/* ── link-leak-monitor → sync.lp_ghl_link_pct ───────────────────────────── */

export function linkLeakResults({ decision, sample }) {
  const total = sample?.tables ? Object.values(sample.tables).reduce((s, n) => s + (Number.isFinite(n) ? n : 0), 0) : null;
  return [{
    check_id: 'sync.lp_ghl_link_pct',
    active: verdictActive(decision?.verdict),
    value: total,
    summary: decision?.verdict === 'insufficient_evidence'
      ? `Can't tell right now: ${(sample?.errors || []).join('; ')}`.slice(0, 300)
      : total ? `${countOf(total, 'new Lead Perfection lead')} from the last day ${total === 1 ? 'has' : 'have'} a GHL contact but ${total === 1 ? "isn't" : "aren't"} linked to it.` : 'Every new Lead Perfection lead from the last day is linked to its GHL contact.',
    detail: { tables: sample?.tables ?? null, offenders: decision?.offenders ?? null, measure: 'unlinked count (the monitor counts, it does not compute a %)' },
    fingerprint: 'sync.lp_ghl_link_pct',
  }];
}

/* ── lp-stale-lead-refresh → sync.stale_set_leads ───────────────────────── */

export function staleSetLeadsResult({ count, error, windowDays = 14 }) {
  if (error || !Number.isFinite(count)) {
    return { check_id: 'sync.stale_set_leads', status: 'unknown', summary: `Can't tell right now: ${error || 'no count'}`.slice(0, 300), fingerprint: 'sync.stale_set_leads' };
  }
  return {
    check_id: 'sync.stale_set_leads',
    active: false,
    value: count,
    eval: {},
    summary: count
      ? `${countOf(count, 'appointment')} from the last ${windowDays} days ${count === 1 ? 'has' : 'have'} passed with no result entered in Lead Perfection.`
      : `Every appointment from the last ${windowDays} days has a result in Lead Perfection.`,
    fingerprint: 'sync.stale_set_leads',
  };
}

/* ── five9-config-snapshot → dialer.config_drift ────────────────────────── */

export function configDriftResult({ summary, changes = [] }) {
  const errs = Array.isArray(summary?.errors) ? summary.errors : [];
  const captured = Number(summary?.entities_captured || 0);
  if (!captured || errs.some((e) => e.entity === 'snapshot_upsert' || e.entity === 'supabase')) {
    return { check_id: 'dialer.config_drift', status: 'unknown', summary: `Can't tell right now: the Five9 settings copy didn't finish (${errs.map((e) => e.entity).join(', ') || 'nothing captured'}).`, fingerprint: 'dialer.config_drift' };
  }
  const n = Number(summary.changes_detected || 0);
  return {
    check_id: 'dialer.config_drift',
    value: n,
    rule: (_v, c) => {
      if (!n) return 'pass';
      const p2 = new Set((c.p2_profiles || []).map((s) => String(s).toLowerCase()));
      return changes.some((ch) => p2.has(String(ch.entity_name || '').toLowerCase())) ? 'fail' : 'warn';
    },
    summary: n ? `${countOf(n, 'Five9 setting')} changed since yesterday.` : 'No Five9 settings changed since yesterday.',
    detail: { changes: changes.slice(0, 40).map((ch) => ({ entity_type: ch.entity_type, entity_name: ch.entity_name })), read_errors: errs.length },
    fingerprint: 'dialer.config_drift',
  };
}

/* ── chat-lead-intake / canvass-lead-backstop ───────────────────────────── */

export function intakeSweepResult(checkId, out, { readFailed }) {
  if (readFailed) return { check_id: checkId, status: 'unknown', summary: `Can't tell right now: ${(out.errors || []).join('; ')}`.slice(0, 300), fingerprint: checkId };
  const live = out.mode === 'live';
  const bad = live ? Number(out.failed || 0) : Number(out.would_send || 0);
  return {
    check_id: checkId,
    value: bad,
    // lead.chat_to_lp: "any would_send in shadow" warns, "any failed send in live" fails.
    // lead.canvass_to_lp: undelivered counts against warn/fail thresholds the same way.
    status: !bad ? 'pass' : live ? 'fail' : 'warn',
    summary: live
      ? (out.failed ? `${countOf(out.failed, 'lead')} failed to reach Lead Perfection (${out.sent || 0} sent).` : out.sent ? `${countOf(out.sent, 'missed lead')} sent to Lead Perfection; none failed.` : 'No leads were missing from Lead Perfection.')
      : (out.would_send ? `${countOf(out.would_send, 'lead')} would be sent to Lead Perfection once this is switched on.` : 'No leads are missing from Lead Perfection.'),
    detail: { mode: out.mode, candidates: out.candidates, would_send: out.would_send, sent: out.sent, failed: out.failed, skipped: out.skipped },
    fingerprint: checkId,
  };
}

/* ── after-asap-retry → dialer.connector_after_asap ─────────────────────── */

export function afterAsapResult(out) {
  if (out?.checked === false || out?.readFailed) {
    return { check_id: 'dialer.connector_after_asap', status: 'unknown', summary: `Can't tell right now: Five9 calls couldn't be read (${out.reason || 'no reason given'}).`.slice(0, 300), fingerprint: 'dialer.connector_after_asap' };
  }
  if (out?.ok === false && !out?.counts) {
    return { check_id: 'dialer.connector_after_asap', status: 'unknown', summary: `Can't tell right now: ${(out.errors || []).join('; ')}`.slice(0, 300), fingerprint: 'dialer.connector_after_asap' };
  }
  const missed = Number(out?.counts?.would_push || 0) + Number(out?.counts?.pushed || 0) + Number(out?.counts?.push_failed || 0);
  return {
    check_id: 'dialer.connector_after_asap',
    active: false,
    value: missed,
    eval: {},
    summary: missed ? `${countOf(missed, 'unreached lead')} didn't move to the follow-up list ("After DIAL ASAP") on their own (${out?.candidates ?? 0} checked).` : 'Every unreached lead moved to the follow-up list on its own.',
    detail: { mode: out?.mode, counts: out?.counts || {} },
    fingerprint: 'dialer.connector_after_asap',
  };
}

/* ── rule-target-check → ghl.rule_targets ───────────────────────────────── */

export function ruleTargetResult(out) {
  if (out?.checked === false) return { check_id: 'ghl.rule_targets', status: 'unknown', summary: `Can't tell right now: ${out.summary || out.reason || 'the check could not run'}`, fingerprint: 'ghl.rule_targets' };
  const high = Number(out?.high || 0);
  const low = Number(out?.low || 0);
  return {
    check_id: 'ghl.rule_targets',
    value: high,
    status: high ? 'fail' : low ? 'warn' : 'pass',
    summary: high ? `${countOf(high, 'automation rule')} sends contacts to a GHL workflow that doesn't exist or is switched off.` : low ? `All automation rules reach a live GHL workflow (${countOf(low, 'minor note')} to tidy up).` : 'All automation rules reach a live GHL workflow.',
    detail: { high_findings: out?.high_findings || [] },
    fingerprint: 'ghl.rule_targets',
  };
}

/* ── reply-sla-watchdog → agent.bot_reply_sla ───────────────────────────── */

export function replySlaResult(res) {
  if (!res || res.skipped) return null;
  if (res.error) return { check_id: 'agent.bot_reply_sla', status: 'unknown', summary: `Can't tell right now: ${res.error}`.slice(0, 300), fingerprint: 'agent.bot_reply_sla' };
  const n = Number(res.unanswered || 0);
  return {
    check_id: 'agent.bot_reply_sla',
    value: n,
    status: n ? 'fail' : 'pass',
    summary: n ? `${countOf(n, 'customer text')} waited more than ${res.sla_minutes} minutes for the chatbot to answer.` : 'The chatbot answered every customer text on time.',
    detail: { flagged: (res.flagged || []).slice(0, 25), counts: { answered: res.answered, in_flight: res.in_flight, unknown: res.unknown } },
    fingerprint: 'agent.bot_reply_sla',
  };
}

/* ── executor heartbeat → agent.executor_heartbeat / agent.queue_depth / ghl.rate_limiter ── */

export function executorHeartbeatResult(health) {
  if (!health) return { check_id: 'agent.executor_heartbeat', status: 'unknown', summary: "Can't tell right now.", fingerprint: 'agent.executor_heartbeat' };
  if (!health.has_pending) return { check_id: 'agent.executor_heartbeat', status: 'pass', value: 0, summary: 'Nothing is waiting to be done.', fingerprint: 'agent.executor_heartbeat' };
  const ageMin = health.age_ms == null ? null : Math.round(health.age_ms / MIN);
  if (ageMin === null) return { check_id: 'agent.executor_heartbeat', status: 'unknown', summary: "Work is waiting and there's no record of the worker running.", fingerprint: 'agent.executor_heartbeat' };
  return { check_id: 'agent.executor_heartbeat', active: false, value: ageMin, eval: { suffix: 'min', strict: true }, summary: ageMin <= 2 ? 'The automation worker is running.' : `The automation worker last ran ${duration(ageMin)} ago, and work is waiting.`, fingerprint: 'agent.executor_heartbeat' };
}

export function queueDepthResult(stats) {
  if (!stats || stats.stale) return null;
  const count = Number(stats.pendingCount ?? NaN);
  const ageMin = stats.oldestAgeMs == null ? 0 : Math.round(stats.oldestAgeMs / MIN);
  if (!Number.isFinite(count)) return { check_id: 'agent.queue_depth', status: 'unknown', summary: "Can't tell right now.", fingerprint: 'agent.queue_depth' };
  return {
    check_id: 'agent.queue_depth',
    value: count,
    rule: (_v, c) => {
      if (count > Number(c.fail_count ?? Infinity) || ageMin > Number(c.fail_age_min ?? Infinity)) return 'fail';
      if (count > Number(c.warn_count ?? Infinity) || ageMin > Number(c.warn_age_min ?? Infinity)) return 'warn';
      return 'pass';
    },
    summary: count ? `${countOf(count, 'action')} waiting; the oldest has waited ${duration(ageMin)}.` : 'No actions waiting.',
    detail: { pending: count, oldest_age_min: ageMin, executing: stats.executingCount ?? null },
    fingerprint: 'agent.queue_depth',
  };
}

export function rateLimiterResult({ alert, reasons, error }) {
  if (error) return { check_id: 'ghl.rate_limiter', status: 'unknown', summary: `Can't tell right now: ${error}`.slice(0, 300), fingerprint: 'ghl.rate_limiter' };
  return {
    check_id: 'ghl.rate_limiter',
    active: !!alert,
    summary: alert ? `We are hitting GHL's request limit: ${(reasons || []).join('; ')}`.slice(0, 300) : "Staying within GHL's request limit.",
    detail: { reasons: reasons || [] },
    fingerprint: 'ghl.rate_limiter',
  };
}

/* ── throttled direct recording (jobs outside runJob) ───────────────────── */

const lastRecorded = new Map();

/**
 * Record at most once per `intervalMs` per check (the reply SLA and executor
 * heartbeat tick every minute; a row a minute per check is noise). Fire and
 * forget: never throws, never awaited by a hot path that cares.
 */
export function recordThrottled(entry, { intervalMs = 60_000, nowMs = Date.now(), record = recordHealthResult } = {}) {
  if (!entry) return false;
  if (lastRecorded.has(entry.check_id) && nowMs - lastRecorded.get(entry.check_id) < intervalMs) return false;
  lastRecorded.set(entry.check_id, nowMs);
  Promise.resolve()
    .then(() => record(entry))
    .catch((err) => console.error(`[Health] ${entry.check_id}: ${err.message}`));
  return true;
}

/** Test seam. */
export function resetThrottle() {
  lastRecorded.clear();
}
