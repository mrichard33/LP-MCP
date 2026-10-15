/**
 * ops-actions.js — what a person can do to an incident or a check, from any
 * front door (System Health 1.6, 2026-10-15): the /ops HTTP routes
 * (src/routes/ops.js), the dashboard's MCP tools (src/tools/health-tools.js)
 * and the Slack Acknowledge / Snooze buttons (src/slack-approvals.js).
 * One module, so the three doors cannot drift apart.
 *
 * Every incident action writes an incident_events row naming the actor (an
 * email, or the Slack user id when no email can be found). Snooze and close
 * require a reason. Nothing here posts to Slack: the incident notifier edits
 * the card on its next minute because the status changed.
 */

import { transition, getIncident, noteIncident, IllegalTransition } from './incidents.js';
import { recordHealthResults } from './record.js';

export const DEFAULT_SNOOZE_MIN = 120;

const fail = (status, error) => ({ ok: false, status, error });

function requireActor(actor) {
  return typeof actor === 'string' && actor.trim().length > 0 ? actor.trim() : null;
}

async function move(id, to, opts, deps) {
  try {
    const incident = await transition(id, to, opts, deps);
    return { ok: true, incident };
  } catch (err) {
    if (err instanceof IllegalTransition) return fail(409, err.message);
    return fail(500, err.message);
  }
}

export async function ackIncident(id, { actor, nowMs } = {}, deps = {}) {
  const who = requireActor(actor);
  if (!who) return fail(400, 'actor (an email) is required');
  return move(id, 'acknowledged', { actor: who, nowMs }, deps);
}

export async function snoozeIncident(id, { actor, reason, minutes = DEFAULT_SNOOZE_MIN, until, nowMs = Date.now() } = {}, deps = {}) {
  const who = requireActor(actor);
  if (!who) return fail(400, 'actor (an email) is required');
  if (!reason || !String(reason).trim()) return fail(400, 'a reason is required to snooze');
  const snoozeUntil = until ? new Date(until).toISOString() : new Date(nowMs + Number(minutes) * 60_000).toISOString();
  if (!Number.isFinite(Date.parse(snoozeUntil)) || Date.parse(snoozeUntil) <= nowMs) return fail(400, 'snooze_until must be in the future');
  return move(id, 'snoozed', { actor: who, reason: String(reason).trim(), snooze_until: snoozeUntil, nowMs }, deps);
}

export async function closeIncident(id, { actor, reason, nowMs } = {}, deps = {}) {
  const who = requireActor(actor);
  if (!who) return fail(400, 'actor (an email) is required');
  if (!reason || !String(reason).trim()) return fail(400, 'a reason is required to close with no action');
  return move(id, 'closed_no_action', { actor: who, reason: String(reason).trim(), nowMs }, deps);
}

/** The runner for one check: the job that owns it, run now for that check only. */
export async function defaultCheckRunners() {
  return {
    'health-checks': async (checkId) => {
      const { runHealthChecks } = await import('../jobs/health-checks.js');
      return runHealthChecks({ force: true, only: checkId ? [checkId] : null });
    },
    'dialer-sla-check': async (checkId) => {
      const { runDialerSlaCheck } = await import('./dialer-sla.js');
      return runDialerSlaCheck({ force: true, only: checkId ? [checkId] : null });
    },
    'appointment-pipeline-check': async (checkId) => {
      const { runAppointmentPipelineCheck } = await import('./appointment-pipeline.js');
      return runAppointmentPipelineCheck({ force: true, only: checkId ? [checkId] : null });
    },
  };
}

/**
 * Run one check now and record its results. Only checks whose owner job can
 * run a single check on demand; the others say which job runs them.
 */
export async function runCheckNow(checkId, { actor, client } = {}, deps = {}) {
  const { loadHealthChecks } = await import('./registry.js');
  const registry = deps.registry || (await loadHealthChecks({ client }));
  const row = registry.get(checkId);
  if (!row) return fail(404, `no check ${checkId}`);
  const runners = deps.runners || (await defaultCheckRunners());
  const run = runners[row.owner_job_id];
  if (!run) return fail(409, `${checkId} is run by ${row.owner_job_id} on its own schedule; it cannot be run on demand`);
  const out = await run(checkId);
  if (out?.skipped) return fail(409, out.reason || 'the job is off');
  const health = (out?.health || []).filter((h) => h.check_id === checkId);
  const written = await recordHealthResults(health, { client });
  return { ok: true, check_id: checkId, results: health.length, written: written.written, actor: actor || null };
}

/** "Run check now" from an incident page: runs its check and notes who asked. */
export async function runIncidentCheck(id, { actor, client, nowMs } = {}, deps = {}) {
  const who = requireActor(actor);
  if (!who) return fail(400, 'actor (an email) is required');
  const inc = await getIncident(id, deps);
  if (!inc) return fail(404, `incident #${id} not found`);
  const checkId = inc.check_id;
  const res = await runCheckNow(checkId, { actor: who, client }, deps);
  await noteIncident(id, { actor: who, kind: 'note', body: res.ok ? `ran ${checkId} now (${res.results} result(s))` : `asked to run ${checkId}: ${res.error}`, nowMs }, deps);
  return res;
}

/** "Run all checks now": every job that can run on demand, all its checks. */
export async function runAllChecks({ actor, client } = {}, deps = {}) {
  const runners = deps.runners || (await defaultCheckRunners());
  const report = {};
  let written = 0;
  for (const [job, run] of Object.entries(runners)) {
    try {
      const out = await run(null);
      if (out?.skipped) { report[job] = `skipped: ${out.reason}`; continue; }
      const w = await recordHealthResults(out?.health || [], { client });
      written += w.written;
      report[job] = `${(out?.health || []).length} result(s)`;
    } catch (err) {
      report[job] = `error: ${err.message}`;
    }
  }
  return { ok: true, written, jobs: report, actor: actor || null };
}

/** One incident action by name, for the MCP tool and the Slack buttons. */
export async function incidentAction(action, id, args = {}, deps = {}) {
  switch (action) {
    case 'ack': return ackIncident(id, args, deps);
    case 'snooze': return snoozeIncident(id, args, deps);
    case 'close': return closeIncident(id, args, deps);
    case 'run': return runIncidentCheck(id, args, deps);
    default: return fail(400, `unknown action ${action}`);
  }
}
