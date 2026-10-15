/**
 * incident-notifier.js — turn health_results into incidents and ONE Slack card
 * per incident, edited in place (System Health Phase 1, 2026-10-15).
 *
 * Every minute:
 *   1. read health_results since the last processed id;
 *   2. a `fail` on a check whose row says mode='live' opens or touches the
 *      incident for its fingerprint (src/health/incidents.js). A check in
 *      shadow never opens one: it only writes results;
 *   3. a `pass` moves an open / acknowledged / investigating / fixing incident
 *      to verifying, and counts passes there: 2 in a row resolve it (1 for a
 *      daily check), verified_by 'system'. A fail inside verifying reopens it;
 *   4. `unknown` on a P1 live check, sustained 30 min, opens a P2 "could not
 *      read <system>" (could-not-tell never clears and never pages as a fail);
 *   5. cards: posted only once the incident is still failing 10 min after it
 *      opened (FLAP_SUSTAIN_MS semantics; a daily check posts at once), to
 *      #ops-alerts, and P1 lead / dialer / appointment cards to #contact-center
 *      too. A state change edits the same card; a resolve adds one thread
 *      reply. Never a second card for a fingerprint;
 *   6. escalation from escalation_policy: an unacknowledged card gets a thread
 *      reminder past ack_within_min; an escalate_to entry with no `to` yet
 *      (Mark has not named one) is skipped and logged once;
 *   7. a snooze ends at snooze_until (the incident reopens).
 *
 * INCIDENT_NOTIFIER_MODE off | shadow | live (default shadow). Shadow writes
 * incidents and events and logs the card it WOULD post; it sends nothing.
 * Slack is the destination of record here (the ts is stored), so it posts with
 * postToSlack, like src/notifications/slack-sale.js.
 */

import { runJob } from '../job-runner.js';
import { loadHealthChecks } from '../health/registry.js';
import { openOrTouchIncident, transition, noteIncident, NON_TERMINAL, TERMINAL } from '../health/incidents.js';
import { buildIncidentCard, resolvedReply, formatDuration } from '../health/incident-card.js';
import { cadenceMinutes } from '../health/window.js';
import { etWhen } from '../health/plain.js';
import { syncLegacyIncidents } from '../health/alert-key-map.js';
import { recordThrottled } from '../health/watchdog-results.js';
import { recordHealthResult } from '../health/record.js';

export const JOB_ID = 'incident-notifier';
export const TICK_MS = 60_000;
export const SUSTAIN_MS = Number(process.env.ALERT_FLAP_SUSTAIN_MS) || 10 * 60_000;
export const UNKNOWN_SUSTAIN_MS = 30 * 60_000;
export const PASSES_TO_RESOLVE = 2;
export const CONTACT_CENTER_FAMILIES = Object.freeze(['lead', 'dialer', 'appointment']);
const FIRST_PASS_LOOKBACK_MS = 15 * 60_000;
const READ_LIMIT = 2000;
const STILL_FAILING = new Set(['open', 'acknowledged', 'investigating', 'fix_proposed', 'approved', 'fixing']);

export function notifierMode(env = process.env) {
  const raw = String(env.INCIDENT_NOTIFIER_MODE ?? '').trim().toLowerCase();
  return ['off', 'shadow', 'live'].includes(raw) ? raw : 'shadow';
}

export const contactCenterChannel = (env = process.env) => env.SLACK_CHANNEL_CONTACT_CENTER || env.SLACK_CHANNEL_SERVICE || 'C0C6BNY30TB';
const isDaily = (row) => (cadenceMinutes(row?.cadence) ?? 0) >= 24 * 60;
export const passesToResolve = (row) => (isDaily(row) ? 1 : PASSES_TO_RESOLVE);
const fpOf = (r) => r.fingerprint || r.check_id;

/** "Leads waiting with no Five9 call" or "Expected campaigns are RUNNING — DIAL ASAP". */
export function incidentTitle(row, fingerprint) {
  const label = row?.label || fingerprint;
  const i = String(fingerprint).indexOf(':');
  return i > 0 && !fingerprint.startsWith('unknown:') ? `${label} — ${fingerprint.slice(i + 1)}` : label;
}

/** escalate_to entries with no `to` yet, already logged — so the log says it once. */
const skippedEscalations = new Set();

let cursor;

/**
 * One pass. deps: { client, postToSlack, updateSlackMessage, opsChannel,
 * registry, loadCursor }. Never throws for a single incident: each is isolated.
 */
export async function runIncidentNotifier({ env = process.env, nowMs = Date.now(), deps = {} } = {}) {
  const mode = notifierMode(env);
  if (mode === 'off') return { skipped: true, reason: 'INCIDENT_NOTIFIER_MODE=off' };
  const d = { ...(await defaultDeps(deps)), ...deps };
  const c = d.client;
  const live = mode === 'live';
  const registry = d.registry || (await loadHealthChecks({ client: c, nowMs }));
  if (!registry.size) return { checked: false, readFailed: true, reason: 'health_checks registry unreadable' };
  const out = { mode, processed: 0, opened: 0, touched: 0, verifying: 0, reopened: 0, resolved: 0, posted: 0, updated: 0, escalated: 0, errors: [] };
  const err = (where, e) => { out.errors.push(`${where}: ${e.message || e}`); console.error(`[IncidentNotifier] ${where}: ${e.message || e}`); };

  // 1. New results.
  if (cursor === undefined) cursor = d.loadCursor ? await d.loadCursor() : null;
  let q = c.from('health_results').select('*');
  q = cursor ? q.gt('id', cursor) : q.gte('observed_at', new Date(nowMs - FIRST_PASS_LOOKBACK_MS).toISOString());
  const { data: results, error } = await q.order('id', { ascending: true }).limit(READ_LIMIT);
  if (error) return { checked: false, readFailed: true, reason: `health_results read: ${error.message}` };

  // Legacy alert_conditions rows that map onto a registry check (1.4): adopt
  // the ones already firing, keep sets current, resolve the ones that cleared.
  try {
    const legacy = await (d.syncLegacy || syncLegacyIncidents)({ client: c, registry, nowMs });
    for (const h of legacy?.health || []) recordThrottled(h, { intervalMs: 60 * 60_000, nowMs, record: (e) => recordHealthResult({ ...e, client: c }) });
    out.legacy = { ...legacy, health: undefined };
  } catch (e) {
    err('legacy alert sync', e);
  }

  // The open incidents, by fingerprint, kept current as this pass moves them.
  const open = new Map();
  {
    const { data, error: e } = await c.from('incidents').select('*').in('status', NON_TERMINAL);
    if (e) return { checked: false, readFailed: true, reason: `incidents read: ${e.message}` };
    for (const i of data || []) open.set(i.fingerprint, i);
  }
  const unknownChecks = new Map();

  for (const r of results || []) {
    out.processed += 1;
    if (typeof r.id === 'number' || /^\d+$/.test(String(r.id))) cursor = Math.max(Number(cursor) || 0, Number(r.id));
    const row = registry.get(r.check_id);
    if (!row || row.mode !== 'live' || row.enabled === false) continue; // shadow checks never open incidents
    const fp = fpOf(r);
    try {
      if (r.status === 'fail') {
        await onFail({ c, row, r, fp, open, out, nowMs });
      } else if (r.status === 'pass') {
        await onPass({ c, row, fp, open, out, nowMs });
      }
      if (r.status === 'unknown') {
        if (row.severity === 'P1') unknownChecks.set(r.check_id, row);
      } else {
        unknownChecks.delete(r.check_id);
        // Any real answer ends a "could not read" incident.
        if (r.status !== 'skipped') await onPass({ c, row, fp: `unknown:${r.check_id}`, open, out, nowMs });
      }
    } catch (e) {
      err(`result ${r.id} (${fp})`, e);
    }
  }

  // 4. Could-not-read, sustained.
  for (const [checkId, row] of unknownChecks) {
    try {
      const since = await unknownStreakStart(c, checkId);
      if (since && nowMs - Date.parse(since) >= UNKNOWN_SUSTAIN_MS) {
        const res = await openOrTouchIncident({
          check_id: checkId, fingerprint: `unknown:${checkId}`, severity: 'P2', system: row.system,
          title: `Can't check: ${row.label}`,
          summary: `This check hasn't been able to tell whether things are working since ${etWhen(Date.parse(since))}.`, business_impact: row.business_impact, nowMs, checkConfig: row.config,
        }, { client: c });
        if (res.incident) open.set(res.incident.fingerprint, res.incident);
        if (res.created) out.opened += 1;
      }
    } catch (e) {
      err(`unknown ${checkId}`, e);
    }
  }

  // 7. Snoozes that ran out.
  for (const inc of [...open.values()]) {
    if (inc.status === 'snoozed' && inc.snooze_until && Date.parse(inc.snooze_until) <= nowMs) {
      try {
        open.set(inc.fingerprint, await transition(inc.id, 'open', { actor: 'system', body: 'snooze ended', nowMs }, { client: c }));
      } catch (e) {
        err(`unsnooze #${inc.id}`, e);
      }
    }
  }

  // 5 + 6. Cards and escalation for open incidents.
  for (const inc of open.values()) {
    try {
      await syncCard({ c, d, inc, row: registry.get(inc.check_id), live, env, nowMs, out });
      if (live) await escalate({ c, d, inc, nowMs, out });
    } catch (e) {
      err(`card #${inc.id}`, e);
    }
  }
  // Resolved / closed incidents whose card has not said so yet (this pass, or
  // closed by a person through /ops or a button).
  try {
    const { data: done } = await c.from('incidents').select('*').in('status', TERMINAL).gte('resolved_at', new Date(nowMs - 24 * 3_600_000).toISOString());
    for (const inc of done || []) {
      if (!inc.slack_ts || inc.data?.resolved_posted) continue;
      await syncCard({ c, d, inc, row: registry.get(inc.check_id), live, env, nowMs, out });
    }
  } catch (e) {
    err('resolved cards', e);
  }

  out.cursor_out = cursor ?? null;
  out.summary = `${out.processed} result(s): +${out.opened} opened, ${out.touched} touched, ${out.resolved} resolved, ${out.posted} posted, ${out.updated} card update(s)`;
  return { ok: out.errors.length === 0, ...out };
}

async function onFail({ c, row, r, fp, open, out, nowMs }) {
  const current = open.get(fp);
  if (current?.status === 'verifying') {
    const moved = await transition(current.id, 'investigating', { actor: 'system', body: r.summary, nowMs }, { client: c });
    open.set(fp, moved);
    out.reopened += 1;
  }
  const res = await openOrTouchIncident({
    check_id: r.check_id, fingerprint: fp, severity: row.severity, system: row.system,
    title: incidentTitle(row, fp), summary: r.summary, business_impact: row.business_impact,
    est_value_at_risk: r.detail?.est_value_at_risk ?? null, detail: r.detail || null,
    // The incident opened when the check first failed, not when this pass read it.
    nowMs: Math.min(nowMs, Date.parse(r.observed_at) || nowMs), checkConfig: row.config,
  }, { client: c });
  if (!res.incident) return; // suppressed by a close-with-no-action
  open.set(fp, res.incident);
  if (res.created) out.opened += 1; else out.touched += 1;
}

async function onPass({ c, row, fp, open, out, nowMs }) {
  const inc = open.get(fp);
  if (!inc) return;
  if (['open', 'acknowledged', 'investigating', 'fixing'].includes(inc.status)) {
    const moved = await transition(inc.id, 'verifying', { actor: 'system', body: 'check passed', nowMs, data: { passes: 1 } }, { client: c });
    open.set(fp, moved);
    out.verifying += 1;
    if ((moved.data?.passes ?? 1) >= passesToResolve(row)) await resolve({ c, inc: moved, fp, open, out, nowMs });
    return;
  }
  if (inc.status === 'verifying') {
    const passes = (inc.data?.passes ?? 0) + 1;
    if (passes >= passesToResolve(row)) return resolve({ c, inc, fp, open, out, nowMs });
    const data = { ...(inc.data || {}), passes };
    const { data: rows, error } = await c.from('incidents').update({ data }).eq('id', inc.id).eq('status', 'verifying').select('*');
    if (error) throw new Error(error.message);
    open.set(fp, rows?.[0] || { ...inc, data });
  }
}

async function resolve({ c, inc, fp, open, out, nowMs }) {
  const done = await transition(inc.id, 'resolved', { actor: 'system', verified_by: 'system', body: 'passed verification', nowMs }, { client: c });
  open.delete(fp);
  out.resolved += 1;
  return done;
}

async function unknownStreakStart(c, checkId) {
  const { data: lastGood } = await c.from('health_results').select('observed_at').eq('check_id', checkId)
    .in('status', ['pass', 'warn', 'fail']).order('observed_at', { ascending: false }).limit(1);
  let q = c.from('health_results').select('observed_at').eq('check_id', checkId).eq('status', 'unknown');
  if (lastGood?.[0]?.observed_at) q = q.gt('observed_at', lastGood[0].observed_at);
  const { data } = await q.order('observed_at', { ascending: true }).limit(1);
  return data?.[0]?.observed_at || null;
}

/** Post the card once it is sustained, or edit it when its state changed. */
/**
 * Does this incident get a card from here? A check-born incident only when its
 * check is live. A legacy-born one (alert_conditions) only once
 * LEGACY_ALERT_SUPPRESS_MAPPED=true: until then the legacy card is the card,
 * and a second one would repeat it. Pure.
 */
export function cardEligible(inc, row, env = process.env) {
  if (inc.data?.source === 'legacy') return String(env.LEGACY_ALERT_SUPPRESS_MAPPED || 'false').toLowerCase() === 'true';
  return row?.mode === 'live';
}

async function syncCard({ c, d, inc, row, live, env, nowMs, out }) {
  if (!inc.slack_ts && !cardEligible(inc, row, env)) return;
  const card = buildIncidentCard(inc, { dashboardBaseUrl: env.DASHBOARD_BASE_URL, nowMs });
  const terminal = TERMINAL.includes(inc.status);

  if (!inc.slack_ts) {
    if (terminal || !STILL_FAILING.has(inc.status)) return; // recovered before anyone needed to see it
    const sustained = nowMs - Date.parse(inc.opened_at) >= SUSTAIN_MS || isDaily(row);
    if (!sustained) return;
    if (!live) {
      if (!inc.data?.shadow_logged) {
        console.log(`[IncidentNotifier] shadow — would post #${inc.id}: ${JSON.stringify(card)}`);
        await patchData(c, inc, { shadow_logged: true, card_status: inc.status });
      }
      return;
    }
    const channel = d.opsChannel;
    const res = await d.postToSlack(card.text, channel, { blocks: card.blocks });
    if (!res?.ok) throw new Error(`slack post: ${res?.error || 'failed'}`);
    const data = { ...(inc.data || {}), card_status: inc.status };
    if (inc.severity === 'P1' && CONTACT_CENTER_FAMILIES.includes(row?.family)) {
      const cc = await d.postToSlack(card.text, contactCenterChannel(env), { blocks: card.blocks });
      if (cc?.ok) data.cc = { channel: cc.channel || contactCenterChannel(env), ts: cc.ts };
    }
    await c.from('incidents').update({ slack_channel: res.channel || channel, slack_ts: res.ts, data }).eq('id', inc.id);
    inc.slack_channel = res.channel || channel;
    inc.slack_ts = res.ts;
    inc.data = data;
    await noteIncident(inc.id, { kind: 'slack_posted', body: `posted to ${inc.slack_channel}`, data: { ts: res.ts }, nowMs }, { client: c });
    out.posted += 1;
    return;
  }

  if (inc.data?.card_status === inc.status && !(terminal && !inc.data?.resolved_posted)) return;
  if (!live) return;
  await d.updateSlackMessage(inc.slack_channel, inc.slack_ts, card.text, { blocks: card.blocks });
  if (inc.data?.cc?.ts) await d.updateSlackMessage(inc.data.cc.channel, inc.data.cc.ts, card.text, { blocks: card.blocks });
  const patch = { card_status: inc.status };
  if (inc.status === 'resolved' && !inc.data?.resolved_posted) {
    await d.postToSlack(resolvedReply(inc, nowMs), inc.slack_channel, { threadTs: inc.slack_ts });
    patch.resolved_posted = true;
  } else if (terminal) {
    patch.resolved_posted = true;
  }
  await patchData(c, inc, patch);
  out.updated += 1;
}

async function patchData(c, inc, patch) {
  const data = { ...(inc.data || {}), ...patch };
  await c.from('incidents').update({ data }).eq('id', inc.id);
  inc.data = data;
}

/** Thread reminders for an unacknowledged card, from escalation_policy. */
async function escalate({ c, d, inc, nowMs, out }) {
  if (!inc.slack_ts || inc.acknowledged_at || !STILL_FAILING.has(inc.status)) return;
  const policy = (await d.policies(c))[inc.severity];
  if (!policy?.ack_within_min) return;
  const ageMin = (nowMs - Date.parse(inc.opened_at)) / 60_000;
  const level = inc.escalation_level || 0;
  const dueMin = policy.ack_within_min + level * (policy.remind_every_min || policy.ack_within_min);
  if (ageMin < dueMin) return;
  for (const step of Array.isArray(policy.escalate_to) ? policy.escalate_to : []) {
    if (step.to) continue; // a named target is Phase 2 (DM); not sent from here yet
    const key = `${inc.severity}:${step.after_min}`;
    if (!skippedEscalations.has(key)) {
      skippedEscalations.add(key);
      console.warn(`[IncidentNotifier] escalation_policy ${inc.severity} step after ${step.after_min} min has no "to" yet — skipped (Mark to name one)`);
    }
  }
  await d.postToSlack(`⏰ Still not acknowledged after ${formatDuration(nowMs - Date.parse(inc.opened_at))}.`, inc.slack_channel, { threadTs: inc.slack_ts });
  await c.from('incidents').update({
    escalation_level: level + 1,
    next_escalation_at: new Date(Date.parse(inc.opened_at) + (dueMin + (policy.remind_every_min || policy.ack_within_min)) * 60_000).toISOString(),
  }).eq('id', inc.id);
  inc.escalation_level = level + 1;
  await noteIncident(inc.id, { kind: 'escalated', body: `reminder ${level + 1}`, nowMs }, { client: c });
  out.escalated += 1;
}

/** Test seam. */
export function resetNotifierState() {
  cursor = undefined;
  skippedEscalations.clear();
}

async function defaultDeps(given) {
  const out = {};
  if (given.client === undefined) out.client = (await import('../supabase.js')).default;
  if (!given.postToSlack || !given.updateSlackMessage || !given.opsChannel) {
    const slack = await import('../slack.js');
    out.postToSlack = slack.postToSlack;
    out.updateSlackMessage = slack.updateSlackMessage;
    out.opsChannel = slack.opsChannelId();
  }
  if (!given.policies) {
    let cache = null;
    out.policies = async (c) => {
      if (cache) return cache;
      const { data } = await c.from('escalation_policy').select('*');
      cache = Object.fromEntries((data || []).map((p) => [p.severity, p]));
      return cache;
    };
  }
  if (given.loadCursor === undefined) {
    out.loadCursor = async () => {
      const c = given.client !== undefined ? given.client : out.client;
      try {
        const { data } = await c.from('job_runs').select('detail').eq('job_id', JOB_ID).eq('status', 'ok')
          .order('started_at', { ascending: false }).limit(1);
        return data?.[0]?.detail?.cursor_out ?? null;
      } catch {
        return null;
      }
    };
  }
  return out;
}

/* ── scheduler ─────────────────────────────────────────────────────────── */

let timer = null;
let running = false;

export function startIncidentNotifierScheduler(env = process.env) {
  if (timer) return timer;
  if (notifierMode(env) === 'off') {
    console.log('[IncidentNotifier] scheduler not started (INCIDENT_NOTIFIER_MODE=off)');
    return null;
  }
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { value } = await runJob(JOB_ID, () => runIncidentNotifier());
      if (value?.processed) console.log(`[IncidentNotifier] ${value.mode}: ${value.summary}`);
    } catch (e) {
      console.error(`[IncidentNotifier] pass threw: ${e.message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  console.log(`[IncidentNotifier] scheduler started — every minute, mode=${notifierMode(env)}`);
  return timer;
}
