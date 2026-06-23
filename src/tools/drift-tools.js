import { z } from 'zod';
import { getEnrichedDriftCandidates } from '../services/drift-detector.js';

export function registerDriftTools(server) {

  // Tool: get_drift_candidates
  // Contacts marked closed in GHL (carrying the closure tag) but whose LP
  // disposition is still active — cross-references HL drift candidates against
  // current LP dispositions. Backs the dashboard Issues-page "drift" tile, which
  // calls this with no arguments (defaults apply). Read-only: emits no event,
  // writes nothing. Returns { rows: [...] } matching the dashboard DriftCandidate type.
  server.tool(
    'get_drift_candidates',
    'Contacts marked closed/won in GHL (carrying the closure tag, e.g. stage:long-term-nurture) but still active in LP. Cross-references HL drift candidates against current LP dispositions. Read-only; returns { rows: [{ contact_id, name, reason, ghl_status, lp_status, last_lp_activity_at }] }.',
    {
      closure_tag: z.string().optional().describe('GHL closure tag (default: stage:long-term-nurture)'),
      closed_for_hours: z.number().optional().describe('Min hours since GHL close (default: 24)'),
      limit: z.number().optional().describe('Max candidates to scan (default: 1000)'),
    },
    async ({ closure_tag, closed_for_hours, limit } = {}) => {
      try {
        const out = await getEnrichedDriftCandidates({ closure_tag, closed_for_hours, limit });
        return { content: [{ type: 'text', text: JSON.stringify(out) }] };
      } catch (err) {
        // Degrade to an empty result so the dashboard tile renders rather than errors.
        return { content: [{ type: 'text', text: JSON.stringify({ rows: [], error: err.message }) }] };
      }
    }
  );
}
