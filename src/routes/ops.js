/**
 * ops.js — the command-center routes (System Health 1.6, 2026-10-15).
 *
 *   POST /ops/incidents/:id/ack     { actor }
 *   POST /ops/incidents/:id/snooze  { actor, reason, minutes? | until? }
 *   POST /ops/incidents/:id/close   { actor, reason }       (close with no action)
 *   POST /ops/incidents/:id/run     { actor }               (run its check now)
 *   POST /ops/checks/:check_id/run  { actor? }
 *   POST /ops/checks/run-all        { actor? }
 *
 * Behind `authenticate` (the MCP bearer token). The actor is the person's
 * email, written to incident_events; snooze and close need a reason. The logic
 * is src/health/ops-actions.js, shared with the MCP tools and the Slack buttons.
 */

import {
  ackIncident, snoozeIncident, closeIncident, runIncidentCheck, runCheckNow, runAllChecks,
} from '../health/ops-actions.js';

const reply = (res, out) => res.status(out.ok ? 200 : (out.status || 500)).json(out);

export function registerOpsRoutes(app, authenticate, deps = {}) {
  const guard = typeof authenticate === 'function' ? [authenticate] : [];
  const id = (req) => Number(req.params.id);
  const wrap = (fn) => async (req, res) => {
    try {
      reply(res, await fn(req));
    } catch (err) {
      console.error(`[Ops] ${req.method} ${req.path} failed: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  };
  app.post('/ops/incidents/:id/ack', ...guard, wrap((req) => ackIncident(id(req), { actor: req.body?.actor }, deps)));
  app.post('/ops/incidents/:id/snooze', ...guard, wrap((req) => snoozeIncident(id(req), {
    actor: req.body?.actor, reason: req.body?.reason, minutes: req.body?.minutes, until: req.body?.until,
  }, deps)));
  app.post('/ops/incidents/:id/close', ...guard, wrap((req) => closeIncident(id(req), { actor: req.body?.actor, reason: req.body?.reason }, deps)));
  app.post('/ops/incidents/:id/run', ...guard, wrap((req) => runIncidentCheck(id(req), { actor: req.body?.actor }, deps)));
  // run-all before :check_id, or Express reads "run-all" as a check id.
  app.post('/ops/checks/run-all', ...guard, wrap((req) => runAllChecks({ actor: req.body?.actor }, deps)));
  app.post('/ops/checks/:check_id/run', ...guard, wrap((req) => runCheckNow(req.params.check_id, { actor: req.body?.actor }, deps)));
  console.log('[Ops] Registered: POST /ops/incidents/:id/{ack,snooze,close,run}, /ops/checks/:check_id/run, /ops/checks/run-all');
}
