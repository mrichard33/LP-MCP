/**
 * incidents.js — one incident per problem, and the only legal ways it moves
 * (System Health Phase 1, 2026-10-15).
 *
 * An incident is keyed on a FINGERPRINT (the condition, never a live value).
 * The partial unique index `incidents_open_fingerprint` keeps one non-terminal
 * incident per fingerprint, so a second open of the same problem touches the
 * first instead (a 23505 from a race is read the same way). One incident means
 * one Slack card, edited in place (src/jobs/incident-notifier.js).
 *
 * Every move goes through transition(), which checks it against TRANSITIONS
 * (anything else throws), applies it with the `from` status in the WHERE so a
 * concurrent move cannot be overwritten, and appends an incident_events row
 * naming the actor: 'system', 'aios', or a person's email.
 *
 * deps: { client } — the LP supabase client (default), so tests run offline.
 */

import supabase from '../supabase.js';

export const TERMINAL = Object.freeze(['resolved', 'closed_no_action']);
export const NON_TERMINAL = Object.freeze(['open', 'acknowledged', 'investigating', 'fix_proposed', 'approved', 'fixing', 'verifying', 'snoozed']);
export const SYSTEM_ACTORS = Object.freeze(['system', 'aios']);

const HOUR = 3_600_000;
export const REOPEN_WINDOW_MS = 24 * HOUR;
export const FLAP_REOPENS = 3;
export const SUPPRESS_DAYS = 7;

export const isPerson = (actor) => !!actor && !SYSTEM_ACTORS.includes(actor);

/**
 * The legal moves. `who`: 'person' | 'system' | 'aios' (any listed may make
 * it). `kind`: the incident_events kind written. `needs`: fields the move
 * requires in opts.
 */
const T = (from, to, who, kind, needs = []) => ({ from, to, who, kind, needs });
export const TRANSITIONS = Object.freeze([
  T('open', 'acknowledged', ['person'], 'acknowledged'),
  T('open', 'investigating', ['system', 'aios'], 'investigation_started'),
  T('acknowledged', 'investigating', ['system', 'aios'], 'investigation_started'),
  T('investigating', 'fix_proposed', ['aios'], 'fix_proposed'),
  T('fix_proposed', 'approved', ['person'], 'approved'),
  T('fix_proposed', 'investigating', ['person'], 'rejected', ['reason']),
  T('approved', 'fixing', ['system'], 'executed'),
  T('fixing', 'verifying', ['system'], 'result'),
  // A pass on a check whose incident nobody is fixing yet moves it to verifying
  // (the notifier); a fail inside verifying sends it back (a reopen).
  T('open', 'verifying', ['system'], 'result'),
  T('acknowledged', 'verifying', ['system'], 'result'),
  T('investigating', 'verifying', ['system'], 'result'),
  T('verifying', 'resolved', ['system'], 'resolved'),
  T('verifying', 'investigating', ['system'], 'reopened'),
  // Snooze ends on its own at snooze_until.
  T('snoozed', 'open', ['system'], 'reopened'),
  ...NON_TERMINAL.filter((s) => s !== 'snoozed').map((s) => T(s, 'snoozed', ['person'], 'snoozed', ['reason', 'snooze_until'])),
  ...NON_TERMINAL.map((s) => T(s, 'closed_no_action', ['person'], 'closed_no_action', ['reason'])),
]);

/** The rule for from → to by this actor, or a reason it is not allowed. Pure. */
export function checkTransition(from, to, actor, opts = {}) {
  const rule = TRANSITIONS.find((t) => t.from === from && t.to === to);
  if (!rule) return { ok: false, error: `illegal move ${from} → ${to}` };
  const role = isPerson(actor) ? 'person' : actor;
  if (!rule.who.includes(role)) return { ok: false, error: `${from} → ${to} is not a move ${role === 'person' ? 'a person' : `'${role}'`} can make` };
  for (const need of rule.needs) {
    if (opts[need] === undefined || opts[need] === null || opts[need] === '') return { ok: false, error: `${from} → ${to} requires ${need}` };
  }
  return { ok: true, rule };
}

export class IllegalTransition extends Error {}

function db(deps) {
  return deps?.client !== undefined ? deps.client : supabase;
}

const iso = (ms) => new Date(ms).toISOString();

async function addEvent(c, incidentId, { actor, kind, body = null, data = {}, nowMs }) {
  const { error } = await c.from('incident_events').insert({ incident_id: incidentId, at: iso(nowMs), actor, kind, body, data });
  if (error) console.error(`[Incident] event ${kind} for #${incidentId} not written: ${error.message}`);
}

/** Is this fingerprint suppressed by a close-with-no-action in the check's config? Pure. */
export function isSuppressed(config, fingerprint, nowMs) {
  const list = Array.isArray(config?.suppress) ? config.suppress : [];
  return list.some((s) => s?.fingerprint === fingerprint && Date.parse(s.until) > nowMs);
}

/**
 * Open an incident, or touch the open one with the same fingerprint.
 * Returns { incident, created, suppressed? }. Never throws on a lost race.
 */
export async function openOrTouchIncident({
  check_id: checkId, fingerprint, severity, system, title, summary = null, business_impact: businessImpact = null,
  est_value_at_risk: estValue = null, detail = null, nowMs = Date.now(), checkConfig = null,
}, deps = {}) {
  const c = db(deps);
  if (!fingerprint) throw new Error('openOrTouchIncident: fingerprint required');
  if (checkConfig && isSuppressed(checkConfig, fingerprint, nowMs)) return { incident: null, created: false, suppressed: true };

  const touch = async (row) => {
    const patch = {
      last_seen_at: iso(nowMs),
      ...(summary ? { summary } : {}),
      ...(estValue !== null && estValue !== undefined ? { est_value_at_risk: estValue } : {}),
      data: { ...(row.data || {}), ...(detail ? { detail } : {}) },
    };
    const { data, error } = await c.from('incidents').update(patch).eq('id', row.id).select('*');
    if (error) throw new Error(`incident touch: ${error.message}`);
    return { incident: (data && data[0]) || { ...row, ...patch }, created: false };
  };

  const existing = await findOpen(c, fingerprint);
  if (existing) return touch(existing);

  let knownIssueId = null;
  try {
    const { data } = await c.from('claude_known_issues').select('id').eq('rec_group_key', checkId).eq('status', 'open').limit(1);
    knownIssueId = data?.[0]?.id ?? null;
  } catch { /* a known-issue link is a nicety; never blocks an open */ }

  const row = {
    fingerprint, check_id: checkId, system, severity, status: 'open', title: String(title || checkId).slice(0, 200),
    summary, business_impact: businessImpact, est_value_at_risk: estValue, occurrence_count: 1,
    opened_at: iso(nowMs), last_seen_at: iso(nowMs), known_issue_id: knownIssueId, data: detail ? { detail } : {},
  };
  const { data, error } = await c.from('incidents').insert(row).select('*');
  if (error) {
    if (error.code === '23505' || /duplicate key/i.test(error.message || '')) {
      const won = await findOpen(c, fingerprint);
      if (won) return touch(won);
    }
    throw new Error(`incident open: ${error.message}`);
  }
  const incident = (data && data[0]) || row;
  await addEvent(c, incident.id, { actor: 'system', kind: 'opened', body: summary, data: { check_id: checkId }, nowMs });
  return { incident, created: true };
}

async function findOpen(c, fingerprint) {
  const { data, error } = await c.from('incidents').select('*').eq('fingerprint', fingerprint).in('status', NON_TERMINAL).limit(1);
  if (error) throw new Error(`incident read: ${error.message}`);
  return data?.[0] || null;
}

export async function getIncident(id, deps = {}) {
  const { data, error } = await db(deps).from('incidents').select('*').eq('id', id).limit(1);
  if (error) throw new Error(`incident read: ${error.message}`);
  return data?.[0] || null;
}

/**
 * Move an incident. opts: { actor, body, data, reason, snooze_until, nowMs,
 * verified_by }. Throws IllegalTransition for a move the table does not allow,
 * or when the incident moved under us. Returns the updated row.
 */
export async function transition(incidentId, to, opts = {}, deps = {}) {
  const c = db(deps);
  const nowMs = opts.nowMs ?? Date.now();
  const actor = opts.actor;
  if (!actor) throw new IllegalTransition('transition: actor required');
  const inc = await getIncident(incidentId, deps);
  if (!inc) throw new IllegalTransition(`incident #${incidentId} not found`);
  const check = checkTransition(inc.status, to, actor, opts);
  if (!check.ok) throw new IllegalTransition(`#${incidentId}: ${check.error}`);

  const data = { ...(inc.data || {}) };
  const patch = { status: to };
  let kind = check.rule.kind;
  if (to === 'acknowledged') Object.assign(patch, { acknowledged_at: iso(nowMs), acknowledged_by: actor });
  if (to === 'investigating' && !inc.investigated_at) patch.investigated_at = iso(nowMs);
  if (to === 'verifying') data.passes = 0;
  if (to === 'resolved') Object.assign(patch, { resolved_at: iso(nowMs), resolved_by: actor, verified_at: iso(nowMs), verified_by: opts.verified_by || actor });
  if (to === 'snoozed') Object.assign(patch, { snooze_until: iso(Date.parse(opts.snooze_until)) });
  if (inc.status === 'snoozed' && to === 'open') patch.snooze_until = null;
  if (to === 'closed_no_action') Object.assign(patch, { resolved_at: iso(nowMs), resolved_by: actor });

  // A fail inside verifying is a reopen: count it, and three reopens in 24h
  // mark the incident flapping (the notifier stops calling it resolved early).
  if (inc.status === 'verifying' && to === 'investigating') {
    const reopens = [...(Array.isArray(data.reopens) ? data.reopens : []), iso(nowMs)]
      .filter((t) => nowMs - Date.parse(t) <= REOPEN_WINDOW_MS);
    data.reopens = reopens;
    if (reopens.length >= FLAP_REOPENS) data.flapping = true;
    patch.occurrence_count = (inc.occurrence_count || 1) + 1;
    kind = 'reopened';
  }
  if (opts.data) Object.assign(data, opts.data);
  patch.data = data;

  const { data: rows, error } = await c.from('incidents').update(patch).eq('id', incidentId).eq('status', inc.status).select('*');
  if (error) throw new Error(`incident move: ${error.message}`);
  if (!rows || rows.length === 0) throw new IllegalTransition(`#${incidentId} moved while ${inc.status} → ${to} was being applied`);

  await addEvent(c, incidentId, {
    actor,
    kind,
    body: opts.body ?? opts.reason ?? null,
    data: { from: inc.status, to, ...(opts.snooze_until ? { snooze_until: opts.snooze_until } : {}) },
    nowMs,
  });

  if (to === 'closed_no_action') await suppressFingerprint(c, inc, { actor, nowMs, reason: opts.reason });
  return rows[0];
}

/** Closing with no action quiets the fingerprint for 7 days (health_checks.config.suppress). */
async function suppressFingerprint(c, inc, { actor, nowMs, reason }) {
  try {
    const { data, error } = await c.from('health_checks').select('config').eq('check_id', inc.check_id).limit(1);
    if (error) throw new Error(error.message);
    const config = { ...((data && data[0]?.config) || {}) };
    const keep = (Array.isArray(config.suppress) ? config.suppress : []).filter((s) => Date.parse(s.until) > nowMs && s.fingerprint !== inc.fingerprint);
    config.suppress = [...keep, { fingerprint: inc.fingerprint, until: iso(nowMs + SUPPRESS_DAYS * 24 * HOUR), by: actor, reason: reason || null, incident_id: inc.id }];
    const up = await c.from('health_checks').update({ config, updated_at: iso(nowMs) }).eq('check_id', inc.check_id).select('check_id');
    if (up.error) throw new Error(up.error.message);
  } catch (err) {
    console.error(`[Incident] #${inc.id}: could not suppress ${inc.fingerprint}: ${err.message}`);
  }
}

/** Append a free note (or a result / slack_posted / escalated marker) without moving the incident. */
export async function noteIncident(incidentId, { actor = 'system', kind = 'note', body = null, data = {}, nowMs = Date.now() } = {}, deps = {}) {
  await addEvent(db(deps), incidentId, { actor, kind, body, data, nowMs });
}
