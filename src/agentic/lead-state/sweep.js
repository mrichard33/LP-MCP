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
 * Why bounded + CHANGE-DETECTED (NOT classify-everything, NOT time-refresh)
 * ─────────────────────────────────────────────────────────────────────────
 * classifyLeadState() builds context with skipCache:true, which makes
 * ~3–4 GHL API calls + ~5 Supabase reads per contact. The shared GHL
 * limiter is 40 calls/min and the Supabase pool contends with the LP sync.
 * Classifying contacts whose inputs HAVEN'T CHANGED is pure waste — it
 * re-derives the identical state and burns the budget that a genuinely
 * changed contact needs.
 *
 * v0.2.0 change: the candidate selector is now CHANGE-DETECTED, not
 * time-windowed. A contact is a candidate iff:
 *   (a) it has never been classified, OR
 *   (b) its LP lead row changed since we last classified it
 *       (lp_leads.synced_at > agentic_lead_states.state_classified_at).
 * lp_leads.synced_at is a true change signal: the sync is incremental and
 * only bumps synced_at for leads LP reports as changed (verified: ~30 of
 * ~209k leads move in a 2h window). The classification inputs the shapes
 * read today — disposition_code, demo_completed, appointment_set,
 * closed_won — all live on lp_leads and bump synced_at when they change.
 *
 * This both (1) eliminates the LP-sync ↔ sweep Supabase pool contention
 * that made passes crawl (we now touch only the handful that changed), and
 * (2) keeps each contact's state an accurate reflection of its CURRENT
 * relationship stage — re-evaluated when something actually moved, which
 * is the right trigger for a Brunson follow-up-funnel entry decision.
 *
 * Engagement/intent changes (opens, clicks, replies) do NOT bump
 * lp_leads.synced_at — those are caught by the REACTIVE handler
 * (handlers/lead-state.js) on ghl.reply_received / engagement events, which
 * reclassifies the single contact immediately. Sweep = LP-data changes;
 * reactive = GHL-engagement changes. The two are complementary and both
 * update state_classified_at, so they never redundantly re-do each other's
 * work.
 *
 * FOLLOW-UP (point 2, separate PR): when notes/calls become classification
 * inputs (rep-note decline/timing signals feeding eligibility), extend the
 * change-detection MAX() to include the latest lp_notes / lp_call_logs
 * timestamp for the lead, so a new note re-triggers classification. Until
 * then lp_leads.synced_at is the complete change signal for the inputs the
 * shapes actually read.
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
 * v0.2.0 — 2026-06-03. Change-detected candidate selection (replaces the
 *          LEAD_STATE_REFRESH_DAYS time window). Selects never-classified
 *          contacts + contacts whose lp_leads.synced_at advanced past their
 *          last classification. Kills the sync/sweep pool contention and
 *          stops redundant re-classification of static contacts.
 *          LEAD_STATE_REFRESH_DAYS is retained ONLY as a safety re-floor
 *          (see STALE_REFLOOR_DAYS) so a contact can't go forever without a
 *          refresh even if its lead row is dormant.
 */

import supabase from '../../supabase.js';
import { classifyLeadState } from './classifier.js';
import { enrollIfEligible, enrollmentConfig } from './enrollment.js';

// ── Config (env-overridable) ────────────────────────────────────────
const SWEEP_ENABLED      = process.env.LEAD_STATE_SWEEP_ENABLED === 'true';
const SWEEP_INTERVAL_MS  = Number(process.env.LEAD_STATE_SWEEP_INTERVAL_MS || 6 * 60 * 60 * 1000); // 6h
const SWEEP_BATCH        = Number(process.env.LEAD_STATE_SWEEP_BATCH || 150);
const MAX_SCAN           = Number(process.env.LEAD_STATE_SWEEP_MAX_SCAN || 5000);
const BOOT_DELAY_MS      = Number(process.env.LEAD_STATE_SWEEP_BOOT_DELAY_MS || 8 * 60 * 1000); // 8m after boot

// Safety re-floor: even with change-detection, re-classify a contact whose
// last classification is older than this many days regardless of whether
// its lead row changed. Catches TIME-DRIVEN state transitions the lead row
// can't signal — e.g. a DEMO_STALL that ages past DEMO_STALL_MAX_AGE_DAYS,
// or a contact crossing the dormancy threshold — so a dormant-but-unchanged
// lead still gets periodically re-evaluated. Default 7d.
const STALE_REFLOOR_DAYS = Number(process.env.LEAD_STATE_REFRESH_DAYS || 7);

// Module-level in-flight guard — one sweep at a time (covers the timer and
// the admin route stacking).
let sweepRunning = false;

/**
 * Select up to `limit` candidate ghl_contact_ids to classify this run.
 *
 * Universe: lp_leads with a ghl_contact_id, not closed_won (closed-won is a
 * customer — suppressed anyway, no point spending the classify cost).
 * Newest-synced first so the freshest LP data gets classified soonest.
 *
 * CHANGE-DETECTED selection (v0.2.0): a scanned lead becomes a candidate iff
 *   - it has no prior classification (never seen), OR
 *   - its lead row changed since we last classified it
 *     (synced_at > state_classified_at), OR
 *   - its last classification is older than STALE_REFLOOR_DAYS (time re-floor
 *     for state transitions the lead row can't signal).
 * A lead whose row is unchanged AND was classified within the re-floor is
 * SKIPPED — re-deriving its state would be identical work.
 */
async function selectCandidates(limit) {
  // 1. Map of contact_id → last state_classified_at (most recent per contact).
  //    One pass over agentic_lead_states; in-memory map keyed by contact.
  const classifiedAt = new Map();
  {
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from('agentic_lead_states')
        .select('contact_id, state_classified_at')
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`state-map scan failed at ${from}: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const r of data) {
        if (!r.contact_id) continue;
        const prev = classifiedAt.get(r.contact_id);
        // Keep the most recent classification timestamp per contact.
        if (!prev || (r.state_classified_at && r.state_classified_at > prev)) {
          classifiedAt.set(r.contact_id, r.state_classified_at || null);
        }
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }

  const reflootCutoffMs = Date.now() - STALE_REFLOOR_DAYS * 86400000;

  // 2. Walk lp_leads newest-synced first. Keep only contacts whose inputs
  //    changed since last classification (or never classified, or stale
  //    past the re-floor).
  const candidates = [];
  const seen = new Set();
  let neverClassified = 0, changed = 0, staleRefloor = 0, skippedUnchanged = 0;
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

      if (!classifiedAt.has(id)) {
        candidates.push(id);
        neverClassified++;
      } else {
        const lastAt = classifiedAt.get(id);
        const lastMs = lastAt ? new Date(lastAt).getTime() : 0;
        const syncedMs = row.synced_at ? new Date(row.synced_at).getTime() : 0;
        if (syncedMs > lastMs) {
          candidates.push(id);
          changed++;
        } else if (lastMs < reflootCutoffMs) {
          candidates.push(id);
          staleRefloor++;
        } else {
          skippedUnchanged++;
          continue;
        }
      }
      if (candidates.length >= limit) break;
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }

  return {
    candidates,
    scanned,
    selection: {
      never_classified: neverClassified,
      changed_since_classified: changed,
      stale_refloor: staleRefloor,
      skipped_unchanged: skippedUnchanged,
    },
  };
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
    const { candidates, scanned, selection } = await selectCandidates(limit);

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
      selection,
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
      `[LeadStateSweep] done: classified ${classified}/${candidates.length} ` +
      `(new ${selection.never_classified}, changed ${selection.changed_since_classified}, ` +
      `refloor ${selection.stale_refloor}, skipped-unchanged ${selection.skipped_unchanged}), ` +
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
      stale_refloor_days: STALE_REFLOOR_DAYS,
      max_scan: MAX_SCAN,
      selection_mode: 'change_detected',
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
