/**
 * Lead-Selection Engine — src/agentic/lead-selection/index.js
 *
 * Routes:
 *   POST /admin/lead-selection/run    { dry_run?, limit?, mode:'score'|'enroll' }
 *       mode 'score'  (default) → select + score + upsert agentic_reengagement_candidates
 *       mode 'enroll'           → gated S1.3 enrollment of top-N candidates
 *   POST /admin/lead-selection/report → read-back tallies of the candidate table
 *
 * Registered from src/index.js bootstrap, same as the enroll-existing routes.
 *
 * v1.0 — 2026-06-15.
 */

import { runScorePass, getSelectionReport } from './select.js';
import { enrollTopN, enrollConfig } from './enroll.js';

export { runScorePass, getSelectionReport, enrollTopN, enrollConfig };

export function registerLeadSelectionRoutes(app) {
  // POST /admin/lead-selection/run  { dry_run?, limit?, mode? }
  app.post('/admin/lead-selection/run', async (req, res) => {
    try {
      const dryRun = req.body?.dry_run === true;
      const limit = parseInt(req.body?.limit, 10) || undefined;
      const mode = (req.body?.mode || 'score').toLowerCase();
      let result;
      if (mode === 'enroll') {
        result = await enrollTopN({ limit, dryRun });
      } else if (mode === 'score') {
        result = await runScorePass({ limit, dryRun });
      } else {
        return res.status(400).json({ success: false, error: `unknown mode '${mode}' (expected 'score'|'enroll')` });
      }
      res.json(result);
    } catch (err) {
      console.error('[LeadSelection] run route error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /admin/lead-selection/report
  app.post('/admin/lead-selection/report', async (_req, res) => {
    try {
      const report = await getSelectionReport();
      res.json({ ...report, enroll_config: enrollConfig() });
    } catch (err) {
      console.error('[LeadSelection] report route error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('[LeadSelection] Registered: POST /admin/lead-selection/run | /admin/lead-selection/report');
}
