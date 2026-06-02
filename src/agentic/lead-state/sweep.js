/**
 * Lead-State Sweep — src/agentic/lead-state/sweep.js
 *
 * The PERIODIC invoker for the lead-state intelligence layer. On a timer
 * (or on demand via the admin route), selects a bounded batch of candidate
 * contacts, classifies each (writing agentic_lead_states), and runs the
 * result through the S4.5 enrollment gate (enrollment.js). The reactive
 * handler (handlers/lead-state.js) does the same per-contact on an event;
 * this sweep is the steady-state drain that catches dormancy/stall-based
 * eligibility that no single event would trigger.
 *
 * Why bounded + incremental (NOT classify-everything)
 * ───────────────────────────────────────────────────
 * classifyLeadState() builds context with skipCache:true, which makes
 * ~3–4 GHL API calls per contact (contact + opportunity + conversation +
 * pipeline). The shared GHL limiter is 40 calls/min. Classifying the full
 * ~7.4k-contact universe every cycle would take >12h and starve every
 * other GHL consumer. So each run:
 *   - excludes contacts classified within LEAD_STATE_REFRESH_DAYS,
 *   - scans lp_leads newest-synced first (cap LEAD_STATE_SWEEP_MAX_SCAN),
 *   - takes at most LEAD_STATE_SWEEP_BATCH candidates.
 * Over successive runs this drains the never-classified backlog, then
 * settles into refreshing the stalest rows. The suppression shape does the
 * authoritative eligibility filtering — the candidate query is only a
 * cost-control prefilter.
 *
 * Two independent flags
 * ─────────────────────
 *   LEAD_STATE_SWEEP_ENABLED  — does the TIMER fire? (default false)
 *   S45_ENROLLMENT_ENABLED    — does enrollment actually POST, or shadow?
 *                               (read inside enrollment.js; default false)
 * Both default OFF so nothing auto-runs or auto-enrolls until explicitly
 * turned on. The admin route works regardless of the timer flag, so Mark
 * can drive controlled runs before enabling the schedule.
 *
 * v0.1.0 — 2026-06-02. Phase 2.
 */

import supabase from '../../supabase.js';
import { classifyLeadState } from './classifier.js';
import { enrollIfEligible, enrollmentConfig } from './enrollment.js';

// ── Config (env-overridable) ────────────────────────────────────────
const SWEEP_ENABLED      = process.env.LEAD_STATE_SWEEP_ENABLED === 'true';
const SWEEP_INTERVAL_MS  = Number(process.env.LEAD_STATE_SWEEP_INTERVAL_MS || 6 * 60 * 60 * 1000); // 6h
const SWEEP_BATCH        = Number(process.env.LEAD_STATE_SWEEP_BATCH || 150);
const REFRESH_DAYS       = Number(process.env.LEAD_STATE_REFRESH_DAYS || 7);
const MAX_SCAN           = Number(process.env.LEAD_STATE_SWEEP_MAX_SCAN || 5000);
const BOOT_DELAY_MS      = Number(process.env.LEAD_STATE_SWEEP_BOOT_DELAY_MS || 8 * 60 * 1000); // 8m after boot

// Module-level in-flight guard — one sweep at a time (covers the timer and
// the admin route stacking).
let sweepRunning = false;

/**
 * Select up to `limit` candidate ghl_contact_ids to classify this run.
 *
 * Universe: lp_leads with a ghl_contact_id, not closed_won (closed-won is a
 * customer — suppressed anyway, no point spending a GHL call). Excludes any
 * contact already classified within REFRESH_DAYS. Newest-synced first so
 * the freshest LP data gets classified soonest.
 */
async function selectCandidates(limit) {
  // 1. Set of contacts classified recently enough to skip.
  const cutoff = new Date(Date.now() - REFRESH_DAYS * 86400000).toISOString();
  const freshSet = new Set();
  {
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from('agentic_lead_states')
        .select('contact_id, state_classified_at')
        .gte('state_classified_at', cutoff)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`fresh-state scan failed at ${from}: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const r of data) if (r.contact_id) freshSet.add(r.contact_id);
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }

  // 2. Walk lp_leads newest-synced first, collecting candidates not in the
  //    fresh set, until we have `limit` or hit the scan cap.
  const candidates = [];
  const seen = new Set();
  const PAGE = 1000;
  let from = 0;
  let scanned = 0;
  while (candidates.length < limit && scanned < MAX_SCAN) {
    const { data, error } = await supabase
      .from('lp_leads')
      .select('ghl_contact_id, closed_won, synced_at')
      .not('ghl_contact_id', 'is', null)
      .order('synced_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`lp_leads candidate scan failed at ${from}: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) {
      scanned++;
      const id = row.ghl_contact_id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (row.closed_won === true) continue;
      if (freshSet.has(id)) continue;
      candidates.push(id);
      if (candidates.length >= limit) break;
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }

  return { candidates, scanned, fresh_skipped: freshSet.size };
}

/**
 * Run one sweep pass.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.limit]        candidates this run (default SWEEP_BATCH)
 * @param {boolean} [opts.classifyOnly] classify but skip the enrollment gate
 *                                       entirely (pure state refresh)
 * @returns {Promise<object>} summary with state + enrollment distributions
 */
export async function runLeadStateSweep({ limit = SWEEP_BATCH, classifyOnly = false } = {}) {
  if (sweepRunning) {
    return { success: true, skipped: true, reason: 'already_running' };
  }
  sweepRunning = true;
  const startedAt = Date.now();

  try {
    const { candidates, scanned, fresh_skipped } = await selectCandidates(limit);

    const stateCounts = {};
    const enrollCounts = {};
    let classified = 0, errors = 0, enrolled = 0, shadow = 0;
    const errorSample = [];

    for (const contactId of candidates) {
      try {
        const c = await classifyLeadState(contactId, { triggerSource: 'sweep' });
        stateCounts[c.state] = (stateCounts[c.state] || 0) + 1;
        classified++;

        if (!classifyOnly) {
          const e = await enrollIfEligible({
            contactId,
            state: c.state,
            confidence: c.confidence,
            classifierVersion: c.classifier_version,
            stateReason: c.state_reason,
          });
          enrollCounts[e.reason] = (enrollCounts[e.reason] || 0) + 1;
          if (e.enrolled) enrolled++;
          if (e.shadow) shadow++;
        }
      } catch (err) {
        errors++;
        if (errorSample.length < 10) {
          errorSample.push({ contact_id: contactId, error: (err.message || 'unknown').slice(0, 200) });
        }
      }
    }

    const elapsed_ms = Date.now() - startedAt;
    const summary = {
      success: true,
      candidates: candidates.length,
      lp_leads_scanned: scanned,
      recently_classified_skipped: fresh_skipped,
      classified,
      errors,
      error_sample: errorSample,
      classify_only: classifyOnly,
      enrolled,
      shadow_would_enroll: shadow,
      state_distribution: stateCounts,
      enrollment_outcomes: enrollCounts,
      enrollment_config: enrollmentConfig(),
      elapsed_ms,
    };
    console.log(
      `[LeadStateSweep] done: classified ${classified}/${candidates.length}, ` +
      `enrolled ${enrolled}, shadow ${shadow}, errors ${errors} (${elapsed_ms}ms)`
    );
    return summary;
  } finally {
    sweepRunning = false;
  }
}

// ── Express route ───────────────────────────────────────────────────

export function registerLeadStateSweepRoutes(app) {
  // POST /admin/lead-state/sweep  { limit?, classify_only? }
  // Manual trigger — works regardless of LEAD_STATE_SWEEP_ENABLED.
  app.post('/admin/lead-state/sweep', async (req, res) => {
    try {
      const limit = parseInt(req.body?.limit, 10) || SWEEP_BATCH;
      const classifyOnly = req.body?.classify_only === true;
      const result = await runLeadStateSweep({ limit, classifyOnly });
      res.json(result);
    } catch (err) {
      console.error('[LeadStateSweep] route error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /admin/lead-state/sweep/config — current flags + thresholds.
  app.get('/admin/lead-state/sweep/config', (req, res) => {
    res.json({
      sweep_enabled: SWEEP_ENABLED,
      sweep_interval_ms: SWEEP_INTERVAL_MS,
      sweep_batch: SWEEP_BATCH,
      refresh_days: REFRESH_DAYS,
      max_scan: MAX_SCAN,
      enrollment: enrollmentConfig(),
    });
  });

  console.log('[LeadStateSweep] Registered: POST /admin/lead-state/sweep | GET /admin/lead-state/sweep/config');
}

// ── Scheduler ───────────────────────────────────────────────────────

export function startLeadStateSweepScheduler() {
  if (!SWEEP_ENABLED) {
    console.log('[LeadStateSweep] scheduler DISABLED (set LEAD_STATE_SWEEP_ENABLED=true to enable). Manual route still available.');
    return;
  }
  console.log(`[LeadStateSweep] scheduler ENABLED — first run in ${Math.round(BOOT_DELAY_MS / 60000)}m, then every ${Math.round(SWEEP_INTERVAL_MS / 3600000)}h`);
  // Boot delay so the sweep doesn't fire during Railway deploy churn.
  setTimeout(() => {
    runLeadStateSweep().catch(e => console.error('[LeadStateSweep] initial run:', e.message));
    setInterval(() => {
      runLeadStateSweep().catch(e => console.error('[LeadStateSweep] scheduled run:', e.message));
    }, SWEEP_INTERVAL_MS);
  }, BOOT_DELAY_MS);
}
