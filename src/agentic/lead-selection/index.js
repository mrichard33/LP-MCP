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

// ── Periodic score pass (keeps agentic_reengagement_candidates fresh) ──
// Score-only: writes the candidate table (analysis output — never a GHL write
// or a send), so it is safe to run unattended. Enrollment stays the separate,
// gated step (mode:'enroll'). Default ON; disable with
// LEAD_SELECTION_SCORE_ENABLED=false. First run is offset from the field-sync
// boot job to avoid a thundering herd.
const LEAD_SELECTION_SCORE_ENABLED   = process.env.LEAD_SELECTION_SCORE_ENABLED !== 'false';
const LEAD_SELECTION_SCAN_INTERVAL_MS = Number(process.env.LEAD_SELECTION_SCAN_INTERVAL_MS || 24 * 60 * 60 * 1000);
const LEAD_SELECTION_FIRST_RUN_MS     = Number(process.env.LEAD_SELECTION_FIRST_RUN_MS || 3 * 60 * 1000);

export function startLeadSelectionScheduler() {
  if (!LEAD_SELECTION_SCORE_ENABLED) {
    console.log('[LeadSelection] score scheduler disabled (LEAD_SELECTION_SCORE_ENABLED=false)');
    return;
  }
  const runOnce = async () => {
    try {
      const r = await runScorePass({});
      console.log(`[LeadSelection] scheduled score pass: ${r.enrollable} enrollable / ${r.scanned} scanned`);
    } catch (e) {
      console.error('[LeadSelection] scheduled score pass failed:', e.message);
    }
  };
  setTimeout(() => { runOnce(); setInterval(runOnce, LEAD_SELECTION_SCAN_INTERVAL_MS); }, LEAD_SELECTION_FIRST_RUN_MS);
  console.log(`[LeadSelection] score scheduler armed (first run ${Math.round(LEAD_SELECTION_FIRST_RUN_MS/1000)}s, then every ${Math.round(LEAD_SELECTION_SCAN_INTERVAL_MS/3600000)}h)`);
}

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
