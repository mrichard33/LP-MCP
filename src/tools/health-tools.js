import { z } from 'zod';
import { incidentAction, runCheckNow, runAllChecks } from '../health/ops-actions.js';

/**
 * System health tools (2026-10-15, System Health 1.6) — the dashboard's
 * incident buttons call these (Server Actions → lpMcp), the same logic as the
 * /ops routes and the Slack buttons (src/health/ops-actions.js).
 */
export function registerHealthTools(server) {
  server.tool(
    'incident_action',
    'Act on a system-health incident as a person: ack, snooze (needs reason; minutes default 120), close (close with no action; needs reason; quiets the fingerprint 7 days) or run (run its check now). The actor email is written to incident_events. Returns { ok, incident?, error? }.',
    {
      action: z.enum(['ack', 'snooze', 'close', 'run']),
      incident_id: z.number().int().positive(),
      actor: z.string().min(3).describe('The person\'s email'),
      reason: z.string().optional(),
      minutes: z.number().int().positive().optional(),
    },
    async ({ action, incident_id: id, actor, reason, minutes }) => {
      const out = await incidentAction(action, id, { actor, reason, minutes });
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    },
  );

  server.tool(
    'health_run_check',
    'Run one system-health check now (check_id), or every on-demand check (check_id "all"), and record the results to health_results. Read-only against LP, Five9, GHL and n8n.',
    {
      check_id: z.string().min(3),
      actor: z.string().optional(),
    },
    async ({ check_id: checkId, actor }) => {
      const out = checkId === 'all' ? await runAllChecks({ actor }) : await runCheckNow(checkId, { actor });
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    },
  );
}
