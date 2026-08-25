import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerAllTools } from './tools/index.js';
import { startSyncScheduler, fullSync, incrementalSync, handleWebhookEvent } from './sync-engine.js';
import { testConnection, getLeads } from './lp-client.js';
import { getTokenStatus } from './token-manager.js';
import supabase from './supabase.js';
import { initFieldSync, runBulkFieldSync, logCycleStats } from './ghl-field-bootstrap.js';
import { registerN8nEnrichRoute } from './n8n-enrichment.js';
import { registerN8nHelperRoutes } from './n8n-helpers.js';
import { registerN8nAvatarRoutes } from './n8n-avatar.js';
import { registerDecisionEngineRoutes } from './decision-engine.js';
import { registerActionExecutorRoutes } from './action-executor.js';
import { registerStateRoutes } from './state-routes.js';
// ─── Executor Heartbeat (failover for n8n cron) ──────────────────
import {
  registerExecutorHeartbeatRoutes,
  startExecutorHeartbeatScheduler,
} from './executor-heartbeat.js';
// ─── Decision Engine Heartbeat (failover for n8n cron, Play 2) ───
import {
  registerDecisionEngineHeartbeatRoutes,
  startDecisionEngineHeartbeatScheduler,
} from './decision-engine-heartbeat.js';
// ─── Layer 3: Behavioral Intelligence ────────────────────────────
import { registerContextBuilderRoutes } from './context-builder.js';
import { registerBehavioralEmitterRoutes } from './behavioral-emitter.js';
import { registerMessageAnalyzerRoutes } from './message-analyzer.js';
import { resolveLLM, FUNCTION_GROUPS } from './llm-client.js';
import { registerLlmGatewayRoutes } from './llm-gateway.js';
// ─── Layer 3.5: Intent Scoring + Conversion Engine ───────────────
import { registerIntentScorerRoutes } from './intent-scorer.js';
// ─── Phase 4: KB Vector Ingestion (agentic bot knowledge layer) ──
import { registerKbIngestionRoutes } from './knowledge/ingest-embeddings.js';
// ─── Pause-Workflow Fizzle Sweep ─────────────────────────────────
import {
  registerPauseWorkflowSweepRoutes,
  startPauseWorkflowSweepScheduler,
} from './pause-workflow-sweep.js';
// ─── Approval Escalation Sweep ───────────────────────────────────
import {
  registerApprovalEscalationRoutes,
  startApprovalEscalationScheduler,
} from './approval-escalation-sweep.js';
// ─── REST API for GHL Agent Studio ───────────────────────────────
import { registerRestApiRoutes } from './rest-api.js';
// ─── I.STITCH — Visitor Identity Stitch & Enrichment ─────────────
import { registerSiteStitchRoutes } from './site-stitch.js';
// ─── I.LG — Lead Gurus Daily Pull (paid-media ingest) ────────────
import { registerLeadGurusRoutes } from './leadgurus-ingest.js';
// ─── I.TRACK — Site Event Collector (tracker beacon ingest) ──────
import { registerSiteCollectRoutes } from './site-collect.js';
// ─── Events Router (per-event-type webhook endpoints) ────────────
import { registerEventsRouter } from './events-router.js';
// ─── Objection-State Ghost Sweep (post-booking ghost detection) ──
import {
  registerGhostSweepRoutes,
  startGhostSweepScheduler,
} from './objection-state-ghost-sweep.js';
// ─── Appointment Parity Watchdog (LP<->GHL appointment sync) ─────
import {
  registerAppointmentParityRoutes,
  startAppointmentParityScheduler,
} from './jobs/appointment-parity-watchdog.js';
// ─── LP Callback Re-queue Verification (promised-call closer) ────
import {
  registerLpRequeueVerifyRoutes,
  startLpRequeueVerifyScheduler,
} from './jobs/lp-requeue-verify.js';
// ─── LP Addlead Address Hold + Prospect Address Backfill (Section D) ──
import {
  registerLpAddleadHoldRoutes,
  startLpAddleadHoldScheduler,
} from './jobs/lp-addlead-hold-sweeper.js';
import {
  registerLpAddressBackfillRoutes,
  startLpAddressBackfillScheduler,
} from './jobs/lp-address-backfill.js';
// ─── Objection Fall-Through Sweep (post-routing miss detection) ──
import {
  registerFallthroughSweepRoutes,
  startFallthroughSweepScheduler,
} from './objection-fall-through-sweep.js';
// ─── Agentic Message Engine — MV refresh + snapshot ──────────────
import { registerAgenticMvRefreshRoutes } from './agentic-mv-refresh.js';
// ─── Agentic Appointment Notifications (cancel/reschedule email+SMS) ────
import { registerAppointmentNotificationRoutes } from './notifications/appointment-notifications.js';
// ─── GroupMe Two-Way Integration ─────────────────────────────────
import { registerGroupMeRoutes } from './groupme.js';
// ─── LP Appointment Sync (GHL → LP) ────────────────────────────
import { registerLPAppointmentSyncRoutes } from './lp-appointment-sync.js';
// ─── LP Addlead Validation Proxy (GHL addlead → hour gate → LP) ──
import { registerLpAddleadProxyRoutes } from './lp-addlead-proxy.js';
// ─── Canvassing Intake (I.CC → deterministic time/notes → LP) ────
import { registerCanvassingIntakeRoutes } from './canvassing-intake.js';
// ─── Workflow Completion (tag-based self-enrichment) ─────────────
import { registerWorkflowCompletionRoutes } from './workflow-completion-handler.js';
// ─── Cooling Callbacks ───────────────────────────────────────────
import { registerCoolingCallbackRoutes } from './cooling-callback-handler.js';
// ─── Entry Events (Route B agentic-first entry routing) ─────────
import { registerEntryEventRoutes } from './entry-event-handler.js';
// ─── GHL Tag Webhook Bridge (Wave 1.2) ──────────────────────────
import { registerGhlTagRoutes } from './ghl-tag-handler.js';
// ─── Canvassing Pilot v2 intake (I.CV → LP) ──────────────────────
import { registerCanvassingLeadRoutes } from './canvassing-lead-handler.js';
// ─── Affiliate lead intake (per-affiliate GHL form → LP) ─────────
import { registerAffiliateLeadRoutes } from './affiliate-lead-handler.js';
// ─── IME MIC Integration ─────────────────────────────────────────
import { registerImeRoutes, startImeWorkers } from './ime/index.js';
// ─── MVI v2.5 — Antifragile services ─────────────────────────────
import {
  registerDriftDetectorRoutes,
  startDriftDetectorScheduler,
} from './services/drift-detector.js';
import { registerInternalRoutes } from './services/internal-routes.js';
// ─── Phase 1 #53 — Engagement Summary Refresh ────────────────────
// 2026-05-13: aggregates 90d engagement signals into engagement_summary
// via the refresh_engagement_summary() PL/pgSQL function. Pre-req: run
// sql/phase1_53_refresh_engagement_summary.sql once in Supabase SQL Editor.
import { registerEngagementSummaryRoutes } from './jobs/refresh-engagement-summary.js';
// ─── Phase 1 #54 (bulk) — Bulk Risk Score ────────────────────────
// 2026-05-13: bulk-scores the dormant GHL-linked pool via the
// bulk_compute_risk_scores() PL/pgSQL function. Pre-req: run
// sql/phase1_54_bulk_compute_risk_scores.sql once in Supabase SQL Editor.
// Used for Phase 1 dry-run — distribution analysis before enabling
// production enrollment rules.
import { registerBulkRiskScoreRoutes } from './jobs/bulk-risk-score.js';
// ─── Admin ──────────────────────────────────────────────────────
import { runEmailBackfill } from './admin/email-backfill.js';
import { registerEmailCleanupRoutes } from './admin/email-cleanup.js';
// ─── Pending-probe TTL sweep (2026-07-08, PR #499 follow-up) ──
// Clears stale pending:customer-status-check tags from leads who never
// answered the HDL.3 customer-status probe. Daily scheduler is env-gated
// (PENDING_PROBE_TTL_SWEEP_ENABLED, default off); manual dry-run route
// POST /admin/pending-probe-ttl-sweep.
import { registerPendingProbeTtlSweepRoutes } from './admin/pending-probe-ttl-sweep.js';
import {
  registerDataFreshnessRoutes,
  startDataFreshnessMonitorScheduler,
} from './admin/data-freshness.js';
import {
  registerCohortReconcileRoutes,
  startCohortReconcileScheduler,
} from './admin/lp-cohort-reconcile.js';
import { runGhlContactIdBackfill } from './admin/ghl-contact-id-backfill.js';
import { registerGhlTriggerLinkRoutes } from './admin/ghl-trigger-links.js';
import { registerAgenticLeadStateRoutes } from './admin/agentic-lead-states.js';
// ─── Guest-visitor remediation (Victor Lopez incident 2026-07-04) ──
// One-time sweep exposed over HTTP (POST /admin/remediate-guest-visitors)
// so it can run on Railway without shell access; shares its core with
// scripts/remediate-guest-visitors.js.
import { registerGuestVisitorRemediationRoutes } from './admin/guest-visitor-remediation.js';
// Pre-enforce link-verification sampling (POST /admin/verify-link-sample,
// read-only vs GHL): live-verifies a random sample of cache-classified
// rejected_* rows so the observe-mode rejection rate can be compared to a
// live baseline before LP_LINK_CORROBORATION_MODE=enforce.
import { registerLinkVerifySampleRoutes } from './admin/link-verify-sample.js';
// ─── LP→GHL appointment backfill (2026-07-07) ──
// One-shot gap closer exposed over HTTP (POST /admin/backfill-ghl-appointments,
// dry-run by default) so it can run on Railway without shell access; shares
// its core with scripts/backfill-ghl-appointments.js.
import { registerGhlAppointmentBackfillRoutes } from './admin/ghl-appointment-backfill.js';
// LP contact auto-create backstop — flag-gated 15-min sweep + admin endpoint;
// finds-or-creates the GHL contact for unlinked LP leads then reconciles the
// appointment. Scheduler no-ops unless ENABLE_LP_CONTACT_BACKSTOP=true.
import { registerLpContactBackstopRoutes } from './admin/lp-contact-backstop.js';
// Parity-hardening admin endpoints (2026-07-10): windowed mirror backfill that
// recovers leads the incremental sync drops (emits lp.disposition_changed only
// for recovered upcoming leads); WE calendar same-slot de-dupe; live-GHL
// appointment count for the dashboard; live LP↔GHL parity report.
import { registerLpMirrorBackfillRoutes } from './admin/lp-mirror-backfill.js';
// ─── RTP job-axis backfill (#512) ──
// One-shot, idempotent, dry-runnable sweep that recovers post-sale RTP jobs the
// lead-keyed sync paths structurally miss. Manual only (no scheduler):
// POST /admin/lp-rtp-job-backfill (dry-run default).
import { registerRtpJobBackfillRoutes } from './admin/lp-rtp-job-backfill.js';
import { registerGhlAppointmentDedupeRoutes } from './admin/ghl-appointment-dedupe.js';
import { registerGhlAppointmentCountRoutes } from './admin/ghl-appointment-count.js';
import { registerParityReportRoutes } from './admin/parity-report.js';
// ─── LP Force-AddLead (manual + shared helper for no-lds_id appt failures) ──
// v1.0.0 2026-06-03: POST /admin/lp/force-addlead creates a lead in LP via
// the legacy addlead path with the appointment embedded + lognumber stamped,
// for contacts that booked before LP issued their inbound entry (no lds_id).
// Also exports addLeadWithAppointment() — the building block for the
// syncAppointmentToLP auto-heal fallback. Root cause: Chuck Celeste
// (dhilykpGEfeR7UdCZiT6), inbound 394813 never issued, MV could not sync.
import { registerLPForceAddLeadRoutes } from './admin/lp-force-addlead.js';
// ─── Lead-State Sweep (Phase 2 — periodic classify + S4.5 enroll) ──
// Periodic invoker for the lead-state intelligence layer: classifies a
// bounded candidate batch into agentic_lead_states and runs eligible
// results through the S4.5 enrollment gate. Both the timer
// (LEAD_STATE_SWEEP_ENABLED) and real enrollment (S45_ENROLLMENT_ENABLED)
// default OFF — manual route POST /admin/lead-state/sweep works regardless.
import {
  registerLeadStateSweepRoutes,
  startLeadStateSweepScheduler,
} from './agentic/lead-state/sweep.js';
// ─── Note-Change Analyzer (Point 2 — note-driven re-classification) ──
// Bounded invoker that finds contacts with note/call activity newer than
// their last note analysis, applies the Option-B dormancy gate (skip
// contacts replying within NOTE_CHANGE_QUIET_DAYS — those are on the
// reactive path), runs note-intelligence (writes lead_intelligence fields
// ONLY, emits nothing — zero customer-send risk), then re-classifies so a
// rep's recorded note flows into S4.5 eligibility/suppression. Scheduler
// no-ops unless NOTE_CHANGE_ANALYZER_ENABLED=true; manual route
// POST /admin/lead-state/note-change works regardless.
import {
  registerNoteChangeAnalyzerRoutes,
  startNoteChangeAnalyzerScheduler,
} from './agentic/lead-state/note-change-analyzer.js';
// ─── Enroll-Existing-Eligible (one-time migration for v0.2.0 cutover) ──
// Drains the pre-existing population of contacts already classified into an
// eligible S45_* state during pre-go-live classify-only backfills that were
// never run through the enrollment gate. The change-detected sweep won't
// re-select them (lead row unchanged, inside the re-floor), so this targeted
// pass runs enrollIfEligible() on their EXISTING state (no re-classification).
// Manual/admin-only, no scheduler. POST /admin/lead-state/enroll-existing.
import {
  registerEnrollExistingEligibleRoutes,
} from './agentic/lead-state/enroll-existing-eligible.js';
// ─── Lead-Selection Engine (score the book → ranked/segmented S1.3 candidates) ─
// Daily score-pass scheduler + admin routes. POST /admin/lead-selection/run | /report.
import { registerLeadSelectionRoutes, startLeadSelectionScheduler } from './agentic/lead-selection/index.js';
// Workflow visibility projection sweep (system_events → membership/suppression/delivery).
import { registerWorkflowProjectionRoutes, startWorkflowProjectionLoop } from './jobs/workflow-projection.js';
// Daily goal/variance scorecard actuals ("Monday a.m." report).
import { registerGoalScorecardRoutes, startGoalScorecardScheduler } from './jobs/goal-scorecard-daily.js';
// Nightly per-lead market assignment (feeds the per-market scorecard split).
import { registerMarketAssignmentRoutes, startMarketAssignmentScheduler } from './jobs/market-assignment-daily.js';
// Appointment Capacity Board — 15-min GetSalesSchedule + forward-lead sweep,
// nightly 23:50 ET fill snapshot, unauthenticated GET /board/capacity for the
// dashboard TV board (sql/043).
import { registerCapacityBoardRoutes, startCapacitySweepScheduler } from './jobs/capacity-sweep.js';
// Band-level (slot_id) capacity vs GHL bookings — the dimension v_appt_board
// aggregates away. Read-only diagnostic, authenticated, no scheduler (sql/048).
import { registerCapacityBandRoutes } from './jobs/capacity-bands.js';
// Closed-month per-market funnel RE-DERIVE (real measurement; retires the split).
// The legacy proportional-split backfill (scorecard-market-backfill.js) is left in
// the tree but INTENTIONALLY UNWIRED — no metric may be produced by splitting a
// company total across markets.
import { registerScorecardRederiveRoutes } from './jobs/scorecard-market-rederive.js';
// Net Report RTP net ingest + provisional-vs-net drift (live-month revenue realignment).
import { registerNetReportRoutes } from './jobs/scorecard-rtp-source.js';
import { registerCohortReobservationRoutes } from './jobs/cohort-reobservation.js';
// LP scheduled-report PDF ingest (Report A Net Sales / Report B GB split) — n8n
// posts raw PDF bytes; parse/validate/write happens here, fail-closed.
import { registerLpReportRoutes } from './jobs/lp-report-ingest.js';
import { registerLpCsvRoutes } from './jobs/lp-csv-ingest.js';
// Daily 07:00 ET cross-source recon for the ingested LP reports.
import { registerLpReportReconRoutes, startLpReportReconScheduler } from './jobs/lp-report-recon.js';
// 07:30 ET missing-report watchdog — watches the OUTCOME table, independent
// of every pipeline stage (LP schedule / Gmail / n8n / ingest route).
import { startLpReportWatchdog } from './jobs/lp-report-watchdog.js';
// Clears chunked ingests that began and never finalized. They hold the snapshot
// unique keys, so each one rejects its own corrected re-send until released.
import { startLpCsvOrphanReaper } from './jobs/lp-csv-orphan-reaper.js';
// Nightly scorecard validation + GroupMe tie-out alert.
import { registerScorecardValidateRoutes, startScorecardValidateScheduler } from './jobs/scorecard-validate.js';
// 2026-08-06 Phase E — daily Five9 config snapshot + change log (ships dark)
import { registerFive9SnapshotRoutes, startFive9ConfigSnapshotScheduler } from './jobs/five9-config-snapshot.js';
import { registerCiRoutes } from './ci/routes.js';
import { startCiWorkerScheduler } from './ci/worker.js';
import { logFfmpegStatus } from './ci/recordings.js';
// ─── Agentic Hold-Complete (return-from-hold re-entry) ───────────
import { registerHoldCompleteRoutes } from './agentic/hold-complete.js';
// ─── FB Publish Watchdog (alert on missed WF4 publish window) ────
import { startFbPublishWatchdog } from './fb-publish-watchdog.js';
// ─── Five9 ESS Silence Watchdog (alert on a quiet Five9 feed) ────
import { startFive9SilenceWatchdog } from './five9-silence-watchdog.js';
import {
  registerGhlInboundRoutes,
  startGhlNoteSweep,
  startGhlNoteReconciliation,
} from './ghl-note-pipeline/index.js';

const PORT = process.env.PORT || 8080;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const FIELD_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const SERVER_VERSION = '6.5.1';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const AUTH_SOFT_LAUNCH = process.env.AUTH_SOFT_LAUNCH === 'true';

function authenticate(req, res, next) {
  if (!MCP_AUTH_TOKEN) return next();

  const authHeader = req.headers.authorization;
  if (authHeader === `Bearer ${MCP_AUTH_TOKEN}`) return next();

  if (AUTH_SOFT_LAUNCH) {
    console.warn(`[Auth] SOFT_LAUNCH: unauthenticated ${req.method} ${req.path} from ${req.ip} ua="${req.headers['user-agent'] || 'none'}" — would reject in enforce mode`);
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized' });
}

async function runMigrations() {
  try {
    const { error } = await supabase.rpc('exec_sql', {
      sql: `CREATE TABLE IF NOT EXISTS groupme_approval_requests (
        id SERIAL PRIMARY KEY,
        short_ref TEXT UNIQUE NOT NULL,
        batch_id TEXT,
        action_ids INTEGER[] NOT NULL DEFAULT '{}',
        rule_applied TEXT,
        target_id TEXT,
        contact_name TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        resolved_by TEXT,
        resolved_at TIMESTAMPTZ,
        requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`
    });
    if (error) {
      const { error: testErr } = await supabase.from('groupme_approval_requests').select('id').limit(1);
      if (testErr && testErr.code === '42P01') {
        console.warn('[Migration] groupme_approval_requests table missing — please create manually in Supabase SQL editor');
      } else {
        console.log('[Migration] groupme_approval_requests table exists');
      }
    } else {
      console.log('[Migration] groupme_approval_requests table ready');
    }
  } catch (err) {
    console.warn('[Migration] Skipped:', err.message);
  }

  // #512: audit columns for the RTP job-axis backfill's side-effect suppression.
  // When the backfill upserts a historical completion with ghl_tag_fired=true to
  // keep the milestones.js sweeper from re-firing it, these mark the row as a
  // deliberate suppression (vs a genuinely-fired tag). Idempotent / additive.
  try {
    await supabase.rpc('exec_sql', {
      sql: `ALTER TABLE lp_job_milestones
              ADD COLUMN IF NOT EXISTS tag_suppressed_backfill BOOLEAN NOT NULL DEFAULT FALSE,
              ADD COLUMN IF NOT EXISTS tag_suppressed_at TIMESTAMPTZ`,
    });
    console.log('[Migration] lp_job_milestones tag-suppression columns ready');
  } catch (err) {
    console.warn('[Migration] tag-suppression columns skipped:', err.message);
  }

  // #512-market: lp_jobs.branch_code — revenue-authoritative branch for market
  // attribution (job branch ties the Net Report 1,710/1,710; lead ZIP mis-routes
  // 147 sold jobs to OUT_OF_AREA). Column + index here; the historical backfill
  // lives in sql/039 (a mass UPDATE, not re-run on every boot). Additive.
  try {
    await supabase.rpc('exec_sql', {
      sql: `ALTER TABLE lp_jobs ADD COLUMN IF NOT EXISTS branch_code TEXT;
            CREATE INDEX IF NOT EXISTS idx_lp_jobs_branch_code ON lp_jobs(branch_code)`,
    });
    console.log('[Migration] lp_jobs.branch_code ready');
  } catch (err) {
    console.warn('[Migration] lp_jobs.branch_code skipped:', err.message);
  }

  // Appointment Capacity Board substrate (sql/043 — the file is the source of
  // truth; this boot-time mirror guarantees the schema exists before the first
  // capacity sweep AND before the first lead upsert writes the new
  // appointment_confirmed/appointment_verified columns, and the sql/049 LP
  // attribution + latching outcome columns. Additive/idempotent.
  //
  // Runs through the run_sql RPC (which THROWS on failure via runSQL), NOT the
  // exec_sql pattern used by the older blocks above: supabase.rpc() reports
  // failure in its { error } return without throwing, so `await` + catch never
  // sees it — on 2026-07-22 that silently skipped this schema in production and
  // every lead upsert failed on the missing appointment_confirmed column until
  // the DDL was applied by hand. runSQL surfaces the failure for real.
  try {
    const { runSQL } = await import('./admin/supabase-admin.js');
    await runSQL(`CREATE TABLE IF NOT EXISTS lp_capacity_slots (
              slot_date        date NOT NULL,
              slr_id           text NOT NULL,
              rep_home_market  text NOT NULL,
              slot_id          int  NOT NULL,
              has_appt         boolean NOT NULL,
              swept_at         timestamptz NOT NULL,
              PRIMARY KEY (slot_date, slr_id, slot_id));
            CREATE INDEX IF NOT EXISTS idx_lp_capacity_slots_date ON lp_capacity_slots(slot_date);
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS appointment_confirmed boolean;
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS appointment_verified  boolean;
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS set_by_name       text;
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS confirmed_by_name text;
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS verified_by_name  text;
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS set_date          timestamptz;
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS confirmed_date    timestamptz;
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS ever_set          boolean;
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS ever_confirmed    boolean;
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS ever_sat          boolean;
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS ever_issued       boolean;
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS ever_net_issued   boolean;
            CREATE OR REPLACE VIEW v_appt_board AS
              SELECT slot_date,
                     COALESCE(bm.market_code, 'UNRESOLVED') AS market,
                     count(*) AS requested,
                     count(*) FILTER (WHERE cs.has_appt) AS booked
              FROM lp_capacity_slots cs
              LEFT JOIN lp_branch_market_map bm
                ON UPPER(TRIM(bm.brn_id)) = UPPER(TRIM(cs.rep_home_market))
              GROUP BY 1, 2;
            CREATE TABLE IF NOT EXISTS lp_appt_fill_snapshot (
              snapshot_date date NOT NULL,
              slot_date     date NOT NULL,
              market        text NOT NULL,
              requested     int  NOT NULL DEFAULT 0,
              confirmed     int  NOT NULL DEFAULT 0,
              set_pending   int  NOT NULL DEFAULT 0,
              days_out      int  GENERATED ALWAYS AS (slot_date - snapshot_date) STORED,
              PRIMARY KEY (snapshot_date, slot_date, market));
            ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS lp_branch_id text;
            CREATE INDEX IF NOT EXISTS idx_lp_leads_branch ON lp_leads(lp_branch_id);
            CREATE TABLE IF NOT EXISTS lp_appt_fill_hourly (
              snapshot_hour timestamptz NOT NULL,
              slot_date     date NOT NULL,
              market        text NOT NULL,
              requested     int  NOT NULL DEFAULT 0,
              confirmed     int  NOT NULL DEFAULT 0,
              set_pending   int  NOT NULL DEFAULT 0,
              days_out      int  NOT NULL,
              PRIMARY KEY (snapshot_hour, slot_date, market));
            CREATE INDEX IF NOT EXISTS idx_lp_appt_fill_hourly_slot ON lp_appt_fill_hourly(slot_date, snapshot_hour);`);
    console.log('[Migration] capacity board schema (sql/043 + 044 + 045) ready');
  } catch (err) {
    console.error('[Migration] capacity board schema FAILED (board + lead upserts depend on it — apply sql/043 manually):', err.message);
  }

  // Band-level capacity views (sql/048 — the file is the source of truth). Two
  // CREATE OR REPLACE VIEWs on NEW names: v_appt_board is untouched and the TV
  // board is unaffected. Depends on lp_capacity_slots + lp_branch_market_map,
  // both established by the block above, so ordering here matters. runSQL
  // (throws) rather than exec_sql (silently skips) for the same reason.
  //
  // Nothing else in the process depends on these views — only the read-only
  // /admin/capacity-bands route and the get_capacity_vs_ghl tool — so a failure
  // here logs and continues rather than blocking boot.
  try {
    const { runSQL } = await import('./admin/supabase-admin.js');
    await runSQL(`
            CREATE OR REPLACE VIEW v_appt_board_bands AS
            SELECT cs.slot_date,
                   COALESCE(bm.market_code, 'UNRESOLVED') AS market,
                   cs.slot_id,
                   CASE cs.slot_id WHEN 1 THEN 'M' WHEN 2 THEN 'A' WHEN 3 THEN 'E'
                                   ELSE '?' END            AS band,
                   count(*)                                AS capacity,
                   count(*) FILTER (WHERE cs.has_appt)     AS booked,
                   count(*) FILTER (WHERE NOT cs.has_appt) AS open_slots
            FROM lp_capacity_slots cs
            LEFT JOIN lp_branch_market_map bm
              ON UPPER(TRIM(bm.brn_id)) = UPPER(TRIM(cs.rep_home_market))
            GROUP BY 1, 2, 3, 4;
            CREATE OR REPLACE VIEW v_capacity_submission_horizon AS
            SELECT COALESCE(bm.market_code, 'UNRESOLVED') AS market,
                   max(cs.slot_date)                      AS horizon_date,
                   count(DISTINCT cs.slot_date) FILTER (
                     WHERE cs.slot_date >= (now() AT TIME ZONE 'America/New_York')::date
                   )                                      AS days_filed,
                   max(cs.swept_at)                       AS last_swept_at
            FROM lp_capacity_slots cs
            LEFT JOIN lp_branch_market_map bm
              ON UPPER(TRIM(bm.brn_id)) = UPPER(TRIM(cs.rep_home_market))
            GROUP BY 1;`);
    console.log('[Migration] capacity band views (sql/048) ready');
  } catch (err) {
    console.error('[Migration] capacity band views FAILED (GET /admin/capacity-bands and get_capacity_vs_ghl depend on them — apply sql/048 manually):', err.message);
  }

  // Link corroboration + identity sync substrate (sql/046 — the file is the
  // source of truth; this mirror guarantees the schema exists before the
  // first lead upsert writes ghl_link_source in observe mode). runSQL (throws
  // on failure) for the same reason as the capacity-board block above. The
  // legacy_unverified backfill UPDATE in sql/046 is data-op-sized and is NOT
  // mirrored here.
  try {
    const { runSQL } = await import('./admin/supabase-admin.js');
    await runSQL(`ALTER TABLE lp_leads
              ADD COLUMN IF NOT EXISTS ghl_link_source text,
              ADD COLUMN IF NOT EXISTS ghl_identity_synced_at timestamptz,
              ADD COLUMN IF NOT EXISTS ghl_identity_hash text;
            CREATE INDEX IF NOT EXISTS lp_leads_ghl_link_source_idx ON lp_leads (ghl_link_source);
            CREATE TABLE IF NOT EXISTS lp_link_conflicts (
              id                bigserial PRIMARY KEY,
              lp_lead_id        text NOT NULL,
              lp_prospect_id    text,
              lognumber_ghl_id  text,
              verified_ghl_id   text,
              existing_ghl_id   text,
              resolution        text NOT NULL,
              reason            text,
              lp_phone          text,
              lp_email          text,
              ghl_phone         text,
              ghl_email         text,
              detail            jsonb NOT NULL DEFAULT '{}',
              seen_count        integer NOT NULL DEFAULT 1,
              detected_at       timestamptz NOT NULL DEFAULT now(),
              last_seen_at      timestamptz NOT NULL DEFAULT now(),
              resolved_at       timestamptz);
            CREATE INDEX IF NOT EXISTS lp_link_conflicts_lead_idx ON lp_link_conflicts (lp_lead_id, detected_at DESC);
            CREATE UNIQUE INDEX IF NOT EXISTS lp_link_conflicts_natural_key_idx
              ON lp_link_conflicts (lp_lead_id, coalesce(lognumber_ghl_id, ''), coalesce(verified_ghl_id, ''), resolution);
            CREATE TABLE IF NOT EXISTS lp_link_verifications (
              lp_lead_id      text NOT NULL,
              ghl_contact_id  text NOT NULL,
              verdict         text NOT NULL CHECK (verdict IN ('pass', 'fail', 'no_identity')),
              verify_source   text NOT NULL DEFAULT 'ghl_live',
              detail          jsonb NOT NULL DEFAULT '{}',
              verified_at     timestamptz NOT NULL DEFAULT now(),
              PRIMARY KEY (lp_lead_id, ghl_contact_id));`);
    console.log('[Migration] link corroboration schema (sql/046) ready');
  } catch (err) {
    console.error('[Migration] link corroboration schema FAILED (observe-mode lead upserts depend on it — apply sql/046 manually):', err.message);
  }

  // Note-push terminal state (sql/050 — the file is the source of truth; this
  // mirror guarantees the columns exist before initFieldSync() starts the 90s
  // notes cycle, whose select now filters on ghl_note_push_terminal and would
  // throw without them). runSQL (throws on failure) for the same reason as the
  // blocks above.
  try {
    const { runSQL } = await import('./admin/supabase-admin.js');
    await runSQL(`ALTER TABLE lp_notes
              ADD COLUMN IF NOT EXISTS ghl_note_push_attempts integer NOT NULL DEFAULT 0,
              ADD COLUMN IF NOT EXISTS ghl_note_push_error    text,
              ADD COLUMN IF NOT EXISTS ghl_note_push_terminal boolean NOT NULL DEFAULT false,
              ADD COLUMN IF NOT EXISTS note_origin            text NOT NULL DEFAULT 'lp';
            CREATE INDEX IF NOT EXISTS idx_lp_notes_pending
              ON lp_notes (created_at_lp)
              WHERE ghl_note_pushed = false AND ghl_note_push_terminal = false;
            CREATE INDEX IF NOT EXISTS idx_lp_notes_origin
              ON lp_notes (note_origin) WHERE note_origin <> 'lp';
            ALTER TABLE ghl_note_log
              ADD COLUMN IF NOT EXISTS lp_write_confirmed boolean;`);
    console.log('[Migration] note push terminal state (sql/050) ready');
  } catch (err) {
    console.error('[Migration] note push terminal state FAILED (pushNotesToGHL selects on ghl_note_push_terminal — apply sql/050 manually):', err.message);
  }

  // Canvassing intake marks (sql/052 — the file is the source of truth; this
  // mirror guarantees the table exists before the first POST /webhooks/
  // canvassing-lead, whose duplicate pre-check reads it). The table was
  // referenced from the day the endpoint shipped but never created, and every
  // access is fail-open, so its absence silently disabled 24h idempotency
  // rather than erroring — a GHL retry double-posted the lead to LP. runSQL
  // (throws on failure) for the same reason as the blocks above.
  try {
    const { runSQL } = await import('./admin/supabase-admin.js');
    await runSQL(`CREATE TABLE IF NOT EXISTS canvassing_intake_marks (
              dedup_key              text PRIMARY KEY,
              ghl_contact_id         text,
              phone                  text,
              in1_id                 text,
              appt_date              text,
              appt_time              text,
              flagged_beyond_window  boolean NOT NULL DEFAULT false,
              status                 text NOT NULL DEFAULT 'processing',
              created_at             timestamptz NOT NULL DEFAULT now());
            CREATE INDEX IF NOT EXISTS idx_canvassing_intake_marks_created
              ON canvassing_intake_marks (created_at DESC);`);
    console.log('[Migration] canvassing intake marks (sql/052) ready');
  } catch (err) {
    console.error('[Migration] canvassing intake marks FAILED (canvassing-lead idempotency reads it — apply sql/052 manually):', err.message);
  }

  // Rep + setter reporting RPCs (sql/functions.sql and sql/053 are the source
  // of truth; this mirror lets a fresh deploy self-heal them). Unlike every
  // other block here this one defines FUNCTIONS, not DDL — the reporting layer
  // had drifted out of the boot path entirely, which is how get_rep_performance
  // sat broken returning [] for every date range.
  //
  // The DROP is required, not cosmetic: sql/functions.sql adds sit_rate to the
  // RETURNS TABLE, and Postgres rejects a return-type change on CREATE OR
  // REPLACE. IF EXISTS keeps it idempotent; 0 dependents, so no CASCADE.
  //
  // $fn$ dollar-quoting, not $$: this string is itself inside a JS template
  // literal and two functions are defined in one call, so the bodies need a
  // tag that cannot collide.
  //
  // Nothing at boot reads these RPCs — only the MCP tool layer — so a failure
  // logs and continues rather than blocking startup.
  try {
    const { runSQL } = await import('./admin/supabase-admin.js');
    await runSQL(`
            DROP FUNCTION IF EXISTS get_rep_performance(TIMESTAMPTZ, TIMESTAMPTZ);
            CREATE OR REPLACE FUNCTION get_rep_performance(p_start_date TIMESTAMPTZ, p_end_date TIMESTAMPTZ)
            RETURNS TABLE (
              rep_id              TEXT,
              rep_name            TEXT,
              total_leads         BIGINT,
              total_calls         BIGINT,
              demos_set           BIGINT,
              demos_completed     BIGINT,
              closed_won_count    BIGINT,
              total_revenue       NUMERIC,
              avg_job_value       NUMERIC,
              set_rate            NUMERIC,
              sit_rate            NUMERIC,
              close_rate          NUMERIC,
              avg_calls_per_lead  NUMERIC
            ) AS $fn$
              SELECT
                l.rep_id,
                l.rep_name,
                COUNT(DISTINCT l.lp_lead_id) AS total_leads,
                SUM(l.call_count) AS total_calls,
                COUNT(*) FILTER (WHERE l.appointment_set) AS demos_set,
                COUNT(*) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS'))) AS demos_completed,
                COUNT(*) FILTER (WHERE l.closed_won) AS closed_won_count,
                ROUND(SUM(l.job_value) FILTER (WHERE l.closed_won), 0) AS total_revenue,
                ROUND(AVG(l.job_value) FILTER (WHERE l.closed_won), 0) AS avg_job_value,
                ROUND(100.0 * COUNT(*) FILTER (WHERE l.appointment_set) / NULLIF(COUNT(*), 0), 1) AS set_rate,
                ROUND(100.0 * COUNT(l.demo_date) / NULLIF(COUNT(l.appointment_date), 0), 1) AS sit_rate,
                ROUND(100.0 * COUNT(*) FILTER (WHERE l.closed_won) / NULLIF(COUNT(*) FILTER (WHERE (l.demo_completed AND l.disposition_code NOT IN ('NOC','NIS'))), 0), 1) AS close_rate,
                ROUND(SUM(l.call_count)::NUMERIC / NULLIF(COUNT(DISTINCT l.lp_lead_id), 0), 1) AS avg_calls_per_lead
              FROM lp_leads l
              WHERE l.appointment_date >= p_start_date
                AND l.appointment_date <  p_end_date
                AND l.rep_name IS NOT NULL
                AND btrim(l.rep_name) <> ''
              GROUP BY l.rep_id, l.rep_name
              ORDER BY total_revenue DESC NULLS LAST;
            $fn$ LANGUAGE sql;

            CREATE OR REPLACE FUNCTION get_setter_performance(
              p_start_date TIMESTAMPTZ,
              p_end_date   TIMESTAMPTZ,
              p_min_appts  INT DEFAULT 5
            )
            RETURNS TABLE (
              set_by_name        TEXT,
              lead_source_detail TEXT,
              set_channel        TEXT,
              appts_scheduled    BIGINT,
              appts_ran          BIGINT,
              sit_rate           NUMERIC,
              confirmed_count    BIGINT,
              confirm_rate       NUMERIC,
              closed_won_count   BIGINT,
              close_rate_on_net  NUMERIC,
              total_revenue      NUMERIC
            ) AS $fn$
              SELECT
                l.set_by_name,
                l.lead_source_detail,
                CASE
                  WHEN l.set_by_name = 'No, Setter' AND l.lead_source_detail = 'Canvass'
                    THEN 'canvass_field'
                  WHEN l.set_by_name = 'No, Setter'
                    THEN 'unset_inbound'
                  WHEN l.set_by_name = 'Integration, GoHighLevel'
                    THEN 'integration'
                  WHEN l.set_by_name LIKE '%- LF,%'
                    THEN 'partner_phone'
                  ELSE 'phone_setter'
                END AS set_channel,
                COUNT(*)                                   AS appts_scheduled,
                COUNT(l.demo_date)                         AS appts_ran,
                ROUND(100.0 * COUNT(l.demo_date) / NULLIF(COUNT(*), 0), 1) AS sit_rate,
                COUNT(*) FILTER (WHERE l.ever_confirmed)   AS confirmed_count,
                ROUND(100.0 * COUNT(*) FILTER (WHERE l.ever_confirmed) / NULLIF(COUNT(*), 0), 1) AS confirm_rate,
                COUNT(*) FILTER (WHERE l.closed_won)       AS closed_won_count,
                ROUND(100.0 * COUNT(*) FILTER (WHERE l.closed_won) / NULLIF(COUNT(l.demo_date), 0), 1) AS close_rate_on_net,
                ROUND(SUM(l.job_value) FILTER (WHERE l.closed_won), 0) AS total_revenue
              FROM lp_leads l
              WHERE l.appointment_date >= p_start_date
                AND l.appointment_date <  p_end_date
                AND l.set_by_name IS NOT NULL
              GROUP BY l.set_by_name, l.lead_source_detail
              HAVING COUNT(*) >= p_min_appts
              ORDER BY appts_scheduled DESC;
            $fn$ LANGUAGE sql;`);
    console.log('[Migration] rep + setter reporting RPCs (sql/functions.sql + sql/053) ready');
  } catch (err) {
    console.error('[Migration] reporting RPCs FAILED (get_rep_performance / get_setter_performance — apply sql/functions.sql + sql/053 manually):', err.message);
  }

  // Scorecard revenue realignment (sql/040): live-month RTP-net + provisional-gross columns,
  // the Net Report staging table, and the source-precedence view. Additive/idempotent — the
  // one-shot label relabels (sql/040 §C) are NOT run here (data ops, applied once via migration).
  try {
    await supabase.rpc('exec_sql', {
      sql: `ALTER TABLE lp_market_scorecard_daily
              ADD COLUMN IF NOT EXISTS revenue_as_of             DATE,
              ADD COLUMN IF NOT EXISTS provisional_gross_dollars NUMERIC,
              ADD COLUMN IF NOT EXISTS provisional_days          INTEGER;
            ALTER TABLE lp_market_scorecard_daily ALTER COLUMN net_sales DROP NOT NULL;
            ALTER TABLE lp_market_scorecard_daily ALTER COLUMN good_business DROP NOT NULL;
            CREATE TABLE IF NOT EXISTS lp_net_report_rtp (
              market TEXT NOT NULL, report_month DATE NOT NULL, report_as_of DATE NOT NULL,
              released_net NUMERIC NOT NULL, rows_counted INTEGER,
              ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
              PRIMARY KEY (market, report_month, report_as_of));
            CREATE INDEX IF NOT EXISTS idx_lp_net_report_rtp_month ON lp_net_report_rtp(report_month, market);
            CREATE OR REPLACE VIEW lp_market_scorecard_resolved AS
              SELECT DISTINCT ON (market, period_start) *
              FROM (
                SELECT s.*,
                  CASE
                    WHEN revenue_basis = 'rtp_net_by_milestone_date'               THEN 1
                    WHEN revenue_basis = 'rtp_gross_by_milestone_date_provisional' THEN 2
                    ELSE 9
                  END AS source_rank
                FROM lp_market_scorecard_daily s
                WHERE computed_from NOT IN ('backfill_split_sql', 'backfill_split')
              ) ranked
              ORDER BY market, period_start, source_rank ASC, as_of_date DESC;`,
    });
    console.log('[Migration] scorecard revenue-realignment schema (sql/040) ready');
  } catch (err) {
    console.warn('[Migration] scorecard revenue-realignment schema skipped:', err.message);
  }

  // 2026-08-06 Phase E — Five9 config snapshot history (sql/055). Mirrored so a
  // fresh deploy self-heals. Indexes are PLAIN here, not CONCURRENTLY: that
  // keyword cannot run inside a transaction block and there is no code path in
  // this repo that runs statements outside one. On a fresh deploy the tables are
  // empty, so a blocking build is instantaneous. The CONCURRENTLY forms live in
  // sql/055 under a RUN SEPARATELY banner for the existing-table case.
  try {
    const { runSQL } = await import('./admin/supabase-admin.js');
    await runSQL(`CREATE TABLE IF NOT EXISTS five9_config_snapshots (
      id             bigserial PRIMARY KEY,
      snapshot_date  date        NOT NULL DEFAULT (now() AT TIME ZONE 'America/New_York')::date,
      captured_at    timestamptz NOT NULL DEFAULT now(),
      entity_type    text        NOT NULL,
      entity_name    text        NOT NULL,
      config         jsonb       NOT NULL,
      config_hash    text        NOT NULL,
      CONSTRAINT five9_config_snapshots_uniq UNIQUE (snapshot_date, entity_type, entity_name)
    );
    CREATE TABLE IF NOT EXISTS five9_config_changes (
      id                   bigserial PRIMARY KEY,
      detected_at          timestamptz NOT NULL DEFAULT now(),
      entity_type          text        NOT NULL,
      entity_name          text        NOT NULL,
      field_path           text        NOT NULL,
      previous_value       jsonb,
      new_value            jsonb,
      previous_snapshot_id bigint REFERENCES five9_config_snapshots(id) ON DELETE SET NULL,
      new_snapshot_id      bigint REFERENCES five9_config_snapshots(id) ON DELETE SET NULL
    );
    ALTER TABLE five9_config_changes
      ADD COLUMN IF NOT EXISTS detection text NOT NULL DEFAULT 'cross_day';
    CREATE INDEX IF NOT EXISTS idx_f9_snap_entity_date
      ON five9_config_snapshots (entity_type, entity_name, snapshot_date DESC);
    CREATE INDEX IF NOT EXISTS idx_f9_changes_detected
      ON five9_config_changes (detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_f9_changes_detection
      ON five9_config_changes (detection, detected_at DESC);`);
    console.log('[Migration] five9 config snapshot schema (sql/055) ready');
  } catch (err) {
    console.error('[Migration] five9 config snapshot schema FAILED (snapshot job depends on it — apply sql/055 manually):', err.message);
  }

  // Hash gate substrate (sql/059 — the file is the source of truth; this
  // mirror guarantees the column exists before the first gated sweep, whose
  // hash prefetch and lead upserts reference lp_payload_hash). The sweep
  // fails open without it, but a fresh deploy should self-heal rather than
  // run permanently ungated.
  try {
    const { runSQL } = await import('./admin/supabase-admin.js');
    await runSQL(`ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS lp_payload_hash text;`);
    console.log('[Migration] sync hash gate substrate (sql/059) ready');
  } catch (err) {
    console.error('[Migration] sync hash gate substrate FAILED (hash gate runs ungated — apply sql/059 manually):', err.message);
  }

  // Addlead address hold (sql/060 — the file is the source of truth; this
  // mirror guarantees the table exists before the address gate's first hold
  // and before the hold sweeper's first pass). The gate fails open without
  // it (a lead is never dropped), but a fresh deploy should self-heal.
  try {
    const { runSQL } = await import('./admin/supabase-admin.js');
    await runSQL(`CREATE TABLE IF NOT EXISTS lp_addlead_address_hold (
              id              bigserial PRIMARY KEY,
              ghl_contact_id  text NOT NULL,
              payload         jsonb NOT NULL,
              missing_fields  text[] NOT NULL,
              attempts        int NOT NULL DEFAULT 0,
              next_attempt_at timestamptz NOT NULL,
              released_at     timestamptz,
              release_reason  text,
              lp_in1_id       text,
              created_at      timestamptz DEFAULT now()
            );
            CREATE UNIQUE INDEX IF NOT EXISTS uq_lp_addlead_address_hold_active
              ON lp_addlead_address_hold (ghl_contact_id) WHERE released_at IS NULL;
            CREATE INDEX IF NOT EXISTS idx_lp_addlead_address_hold_due
              ON lp_addlead_address_hold (next_attempt_at) WHERE released_at IS NULL;`);
    console.log('[Migration] addlead address hold substrate (sql/060) ready');
  } catch (err) {
    console.error('[Migration] addlead address hold substrate FAILED (address gate holds disabled — apply sql/060 manually):', err.message);
  }

  // Call Intelligence substrate (sql/061 — the file is the source of truth;
  // this mirror guarantees the ci_* tables exist before the pipeline workers
  // land in PRs 2–6). Everything is additive and ci_-prefixed; no existing
  // table or view is touched. The claim-path index is mirrored as a plain
  // CREATE INDEX IF NOT EXISTS — never CONCURRENTLY here (run_sql wraps in a
  // transaction); on any deploy where this mirror creates the schema the
  // table is empty, and the CONCURRENTLY form stays in sql/061 under its
  // RUN SEPARATELY banner for the populated-table case.
  try {
    const { runSQL } = await import('./admin/supabase-admin.js');
    await runSQL(`CREATE TABLE IF NOT EXISTS ci_calls (
              id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              five9_call_id     text NOT NULL,
              five9_session_id  text,
              call_start        timestamptz NOT NULL,
              call_end          timestamptz,
              duration_seconds  integer,
              direction         text,
              ani               text,
              dnis              text,
              customer_phone    text,
              customer_phone_e164 text,
              campaign          text,
              skill             text,
              disposition       text,
              agent_five9_id    text,
              agent_name        text,
              team              text NOT NULL DEFAULT 'unknown',
              was_transferred   boolean DEFAULT false,
              raw_metadata      jsonb,
              eligible          boolean NOT NULL DEFAULT true,
              ineligible_reason text,
              status            text NOT NULL DEFAULT 'discovered'
                                CHECK (status IN ('discovered','fetched','transcribed','analyzed',
                                                  'matched','syncing','completed','skipped','review','failed')),
              status_detail     text,
              review_reason     text,
              attempts          integer NOT NULL DEFAULT 0,
              next_retry_at     timestamptz,
              locked_until      timestamptz,
              locked_by         text,
              created_at        timestamptz NOT NULL DEFAULT now(),
              updated_at        timestamptz NOT NULL DEFAULT now(),
              UNIQUE (five9_call_id)
            );
            CREATE TABLE IF NOT EXISTS ci_recordings (
              id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              call_id          uuid NOT NULL REFERENCES ci_calls(id),
              five9_recording_id text,
              source           text NOT NULL CHECK (source IN ('sftp','manual','five9_api')),
              source_filename  text,
              file_sha256      text,
              file_bytes       bigint,
              mime              text,
              channels         integer,
              storage_path     text,
              fetched_at       timestamptz DEFAULT now(),
              purged_at        timestamptz,
              UNIQUE (call_id, source_filename)
            );
            CREATE TABLE IF NOT EXISTS ci_transcripts (
              id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              call_id            uuid NOT NULL UNIQUE REFERENCES ci_calls(id),
              engine             text NOT NULL,
              engine_model       text NOT NULL,
              language           text,
              diarization_method text NOT NULL CHECK (diarization_method IN ('stereo_channels','none')),
              transcript_text    text NOT NULL,
              segments           jsonb,
              confidence         numeric,
              low_confidence     boolean NOT NULL DEFAULT false,
              audio_seconds      integer,
              created_at         timestamptz NOT NULL DEFAULT now()
            );
            CREATE TABLE IF NOT EXISTS ci_summaries (
              id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              call_id         uuid NOT NULL REFERENCES ci_calls(id),
              model           text NOT NULL,
              prompt_version  text NOT NULL,
              schema_version  text NOT NULL,
              output          jsonb NOT NULL,
              summary_text    text NOT NULL,
              outcome         text NOT NULL,
              outcome_confidence numeric NOT NULL,
              review_flags    text[] NOT NULL DEFAULT '{}',
              usage           jsonb,
              is_current      boolean NOT NULL DEFAULT true,
              created_at      timestamptz NOT NULL DEFAULT now()
            );
            CREATE UNIQUE INDEX IF NOT EXISTS ci_summaries_current_uq
              ON ci_summaries (call_id) WHERE is_current;
            CREATE TABLE IF NOT EXISTS ci_matches (
              id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              call_id      uuid NOT NULL UNIQUE REFERENCES ci_calls(id),
              lp_cst_id    integer,
              lp_lds_id    integer,
              ghl_contact_id text,
              method       text NOT NULL,
              tier         text NOT NULL CHECK (tier IN ('exact','high','probable','ambiguous','none')),
              confidence   numeric,
              candidates   jsonb,
              evidence     jsonb,
              decided_by   text NOT NULL DEFAULT 'auto' CHECK (decided_by IN ('auto','human')),
              decided_at   timestamptz NOT NULL DEFAULT now()
            );
            CREATE TABLE IF NOT EXISTS ci_syncs (
              id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              call_id         uuid NOT NULL REFERENCES ci_calls(id),
              target          text NOT NULL CHECK (target IN ('lp','ghl')),
              status          text NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','shadow','synced','failed','skipped')),
              idempotency_key text NOT NULL UNIQUE,
              note_body       text,
              request         jsonb,
              response        jsonb,
              external_ref    text,
              error           text,
              attempts        integer NOT NULL DEFAULT 0,
              synced_at       timestamptz,
              created_at      timestamptz NOT NULL DEFAULT now(),
              UNIQUE (call_id, target)
            );
            CREATE TABLE IF NOT EXISTS ci_agent_map (
              agent_five9_id  text PRIMARY KEY,
              agent_name      text,
              lp_emp_id       integer,
              team            text NOT NULL DEFAULT 'reece',
              active          boolean NOT NULL DEFAULT true,
              updated_at      timestamptz NOT NULL DEFAULT now()
            );
            CREATE TABLE IF NOT EXISTS ci_campaign_map (
              campaign          text PRIMARY KEY,
              team              text,
              eligible          boolean NOT NULL DEFAULT true,
              excluded_dispositions text[] NOT NULL DEFAULT '{}',
              match_strategy    text NOT NULL DEFAULT 'phone',
              updated_at        timestamptz NOT NULL DEFAULT now()
            );
            CREATE TABLE IF NOT EXISTS ci_transfer_target_map (
              dnis        text PRIMARY KEY,
              team        text NOT NULL,
              label       text,
              updated_at  timestamptz NOT NULL DEFAULT now()
            );
            CREATE TABLE IF NOT EXISTS ci_events (
              id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
              call_id    uuid REFERENCES ci_calls(id),
              stage      text NOT NULL,
              event      text NOT NULL,
              detail     jsonb,
              created_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE TABLE IF NOT EXISTS ci_qa_reviews (
              id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              call_id       uuid NOT NULL REFERENCES ci_calls(id),
              reviewer      text NOT NULL,
              transcript_ok boolean, summary_ok boolean, outcome_ok boolean, match_ok boolean,
              notes         text,
              created_at    timestamptz NOT NULL DEFAULT now()
            );
            CREATE INDEX IF NOT EXISTS ci_calls_status_retry_idx
              ON ci_calls (status, next_retry_at, call_start);
            CREATE OR REPLACE VIEW v_ci_pipeline_health AS
            SELECT status, count(*) AS calls,
                   min(call_start AT TIME ZONE 'America/New_York') AS oldest_et,
                   max(call_start AT TIME ZONE 'America/New_York') AS newest_et
            FROM ci_calls GROUP BY status;`);
    // v_ci_review_queue is NOT created here even though sql/061 defines it.
    // sql/066 supersedes that definition (newest-match LATERAL + decided_by),
    // and CREATE OR REPLACE VIEW cannot DROP a column — so re-asserting the
    // 12-column sql/061 shape over the 13-column sql/066 one fails with
    // "cannot drop columns from view" on EVERY deploy once 066 has run.
    // Observed live 2026-08-23. One object, one owner: sql/066 owns this view,
    // and its block runs below on a fresh database too.
    console.log('[Migration] call intelligence substrate (sql/061) ready');
  } catch (err) {
    console.error('[Migration] call intelligence substrate FAILED (CI pipeline tables missing, PRs 2+ workers cannot run — apply sql/061 manually):', err.message);
  }

  // Call Intelligence v2 recording→call join (sql/062 — the file is the
  // source of truth). Kept as its own block rather than folded into the 061
  // mirror above so each block still mirrors exactly one file: on a fresh
  // deploy 061 creates the v1 shape and this alters it forward. The Call ID
  // is not in the recording filename, so a recording is inserted unlinked and
  // matched on campaign+ANI+time afterwards — hence call_id nullable and
  // uniqueness on source_path. Purely additive; no DROP TABLE.
  try {
    const { runSQL } = await import('./admin/supabase-admin.js');
    await runSQL(`ALTER TABLE ci_recordings ALTER COLUMN call_id DROP NOT NULL;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS source_path         text;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS campaign_dir        text;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS date_dir            text;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS ani                 text;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS agent_username      text;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS ivr_module          text;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS filename_clock_text text;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS recorded_at         timestamptz;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS match_method        text;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS match_confidence    numeric;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS excluded            boolean NOT NULL DEFAULT false;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS excluded_reason     text;
            ALTER TABLE ci_recordings DROP CONSTRAINT IF EXISTS ci_recordings_call_id_source_filename_key;
            CREATE UNIQUE INDEX IF NOT EXISTS ci_recordings_source_path_uq
              ON ci_recordings (source_path);
            ALTER TABLE ci_campaign_map ADD COLUMN IF NOT EXISTS excluded_ivr_modules text[] NOT NULL DEFAULT
              '{ThirdPartyTransfer,ThirdPartyTransfer2,"Third Party Transfer"}';`);
    console.log('[Migration] call intelligence v2 recording join (sql/062) ready');
  } catch (err) {
    console.error('[Migration] call intelligence v2 recording join FAILED (recording ingest cannot match calls — apply sql/062 manually):', err.message);
  }

  // CI worker claim function (sql/063 — the file is the source of truth). The
  // claim is a data-modifying CTE, which is only legal at the top level of a
  // statement, and runSQL wraps what it is given in a SELECT — so the locking
  // lives inside a SQL function and the call site stays a plain SELECT. The
  // worker falls back to a non-claiming SELECT without it (single-driver
  // only), so a fresh deploy should self-heal rather than run unleased.
  try {
    const { runSQL } = await import('./admin/supabase-admin.js');
    await runSQL(`CREATE OR REPLACE FUNCTION claim_ci_calls(
              p_statuses      text[],
              p_limit         integer,
              p_lease_seconds integer,
              p_worker        text
            )
            RETURNS SETOF ci_calls
            LANGUAGE sql
            AS $fn$
              WITH claimed AS (
                SELECT id FROM ci_calls
                WHERE status = ANY(p_statuses)
                  AND eligible
                  AND (next_retry_at IS NULL OR next_retry_at <= now())
                  AND (locked_until  IS NULL OR locked_until  <  now())
                ORDER BY call_start DESC
                LIMIT GREATEST(1, p_limit)
                FOR UPDATE SKIP LOCKED
              )
              UPDATE ci_calls c
              SET locked_until = now() + make_interval(secs => GREATEST(30, p_lease_seconds)),
                  locked_by    = p_worker,
                  updated_at   = now()
              FROM claimed cl
              WHERE c.id = cl.id
              RETURNING c.*;
            $fn$;`);
    console.log('[Migration] call intelligence claim function (sql/063) ready');
  } catch (err) {
    console.error('[Migration] call intelligence claim function FAILED (worker runs unleased, single-driver — apply sql/063 manually):', err.message);
  }

  // CI agent join-by-login (sql/064 — the file is the source of truth). This
  // domain's Call Log has NO agent-id column: it carries the login ('jmanieri')
  // and the display name ('Shari Walker - LF'). ci_agent_map was seeded keyed
  // on the numeric Five9 id, which appears nowhere in the report, so without
  // this column the map cannot be joined and every call falls to team
  // 'unknown'. Additive.
  try {
    const { runSQL } = await import('./admin/supabase-admin.js');
    await runSQL(`ALTER TABLE ci_calls     ADD COLUMN IF NOT EXISTS agent_username text;
            ALTER TABLE ci_agent_map ADD COLUMN IF NOT EXISTS agent_username text;
            CREATE INDEX IF NOT EXISTS ci_agent_map_username_idx
              ON ci_agent_map (agent_username);`);
    console.log('[Migration] call intelligence agent join-by-login (sql/064) ready');
  } catch (err) {
    console.error('[Migration] call intelligence agent join-by-login FAILED (agent map unjoinable, teams fall to unknown — apply sql/064 manually):', err.message);
  }

  // CI matching indexes (sql/065 — the file is the source of truth). §8 phone
  // matching probes lp_prospects, which had no phone index at all: 140,600
  // rows scanned per matched call, twice. Plain (not CONCURRENT) builds because
  // runMigrations cannot run CONCURRENTLY inside a transaction; IF NOT EXISTS
  // makes it a no-op once built. Additive — no column or row changes.
  try {
    const { runSQL } = await import('./admin/supabase-admin.js');
    await runSQL(`CREATE INDEX IF NOT EXISTS idx_lp_prospects_phone     ON lp_prospects (phone);
            CREATE INDEX IF NOT EXISTS idx_lp_prospects_phone_alt ON lp_prospects (phone_alt);
            CREATE INDEX IF NOT EXISTS idx_lp_leads_phone_alt     ON lp_leads (phone_alt);
            CREATE INDEX IF NOT EXISTS idx_lp_leads_prospect_id   ON lp_leads (lp_prospect_id);`);
    console.log('[Migration] call intelligence matching indexes (sql/065) ready');
  } catch (err) {
    console.error('[Migration] call intelligence matching indexes FAILED (LP phone match will seq-scan 140k rows per call — apply sql/065 manually):', err.message);
  }

  // CI reconciliation support (sql/066 — the file is the source of truth).
  // v_ci_review_queue joined ci_matches without picking a row; now that the
  // table is append-only (system row + human correction), a plain join lists
  // the same call twice with disagreeing verdicts. LATERAL takes the newest.
  // Also indexes the per-call recording lookup reconciliation performs.
  try {
    const { runSQL } = await import('./admin/supabase-admin.js');
    await runSQL(`CREATE OR REPLACE VIEW v_ci_review_queue AS
            SELECT c.id, c.five9_call_id,
                   (c.call_start AT TIME ZONE 'America/New_York') AS call_et,
                   c.agent_name, c.team, c.customer_phone_e164, c.disposition,
                   c.review_reason, s.summary_text, s.outcome,
                   m.tier, m.candidates, m.decided_by
              FROM ci_calls c
              LEFT JOIN ci_summaries s ON s.call_id = c.id AND s.is_current
              LEFT JOIN LATERAL (
                     SELECT tier, candidates, decided_by FROM ci_matches
                      WHERE call_id = c.id ORDER BY decided_at DESC LIMIT 1
                   ) m ON true
             WHERE c.status = 'review'
             ORDER BY c.call_start;
            CREATE INDEX IF NOT EXISTS ci_recordings_call_id_idx ON ci_recordings (call_id);`);
    console.log('[Migration] call intelligence reconciliation support (sql/066) ready');
  } catch (err) {
    console.error('[Migration] call intelligence reconciliation support FAILED (review queue may list a call twice — apply sql/066 manually):', err.message);
  }

  // CI canvasser roster (sql/067 — the file is the source of truth).
  // The ANI on canvass work is the canvasser at the door, not the customer;
  // without this table the global guard has nothing to check and those calls
  // phone-match to an employee. The PK is composite because 11 numbers in the
  // roster are carried by more than one Pro ID.
  try {
    const { runSQL } = await import('./admin/supabase-admin.js');
    await runSQL(`CREATE TABLE IF NOT EXISTS ci_canvassers (
              pro_id       integer     NOT NULL,
              name         text,
              market       text,
              phone_last10 text        NOT NULL,
              phone_source text,
              active       boolean     NOT NULL DEFAULT true,
              updated_at   timestamptz NOT NULL DEFAULT now(),
              PRIMARY KEY (pro_id, phone_last10)
            );
            CREATE INDEX IF NOT EXISTS ci_canvassers_phone_idx ON ci_canvassers (phone_last10);`);
    console.log('[Migration] call intelligence canvasser roster (sql/067) ready');
  } catch (err) {
    console.error('[Migration] call intelligence canvasser roster FAILED (canvasser ANIs will phone-match as customers — apply sql/067 manually):', err.message);
  }

  // CI recording links (sql/068 — the file is the source of truth).
  // link_token is the ENTIRE access control on the public GET /ci/rec/:token
  // route, so the index must be UNIQUE: the route looks a token up as its only
  // key and a duplicate would make that lookup ambiguous.
  try {
    const { runSQL } = await import('./admin/supabase-admin.js');
    await runSQL(`ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS link_token      text;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS link_expires_at timestamptz;
            CREATE UNIQUE INDEX IF NOT EXISTS ci_recordings_link_token_uq ON ci_recordings (link_token);`);
    console.log('[Migration] call intelligence recording links (sql/068) ready');
  } catch (err) {
    console.error('[Migration] call intelligence recording links FAILED (notes will carry no Recording: line — apply sql/068 manually):', err.message);
  }

  // CI agent display name (sql/069 — the file is the source of truth).
  // ci_agent_map.agent_name comes from the Five9 user record and can be an
  // administrative label ('Mark R (Keep Old Edwin Account)') that must never
  // reach a customer record. display_name overrides it; NULL means "use
  // agent_name" and is deliberately NOT backfilled — a copy would go stale the
  // next time Five9 renames someone.
  try {
    const { runSQL } = await import('./admin/supabase-admin.js');
    await runSQL('ALTER TABLE ci_agent_map ADD COLUMN IF NOT EXISTS display_name text;');
    console.log('[Migration] call intelligence agent display name (sql/069) ready');
  } catch (err) {
    console.error('[Migration] call intelligence agent display name FAILED (CRM notes may show administrative agent labels — apply sql/069 manually):', err.message);
  }

  // CI recording MP3 derivative (sql/070 — the file is the source of truth).
  // Five9 writes GSM 6.10 (WAVE format tag 0x0031), which no browser decodes,
  // so the shareable link opened and nothing played. These two columns locate
  // the MP3 copy. Both nullable and NULL is a normal state — pre-070 rows, a
  // purged recording, or a transcode that failed — and the route falls back to
  // the WAV, which is exactly the behaviour that shipped before. storage_path
  // is NOT touched: the WAV stays the archival copy and the Whisper input.
  try {
    const { runSQL } = await import('./admin/supabase-admin.js');
    await runSQL(`ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS mp3_storage_path text;
            ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS mp3_bytes        bigint;`);
    console.log('[Migration] call intelligence recording mp3 (sql/070) ready');
  } catch (err) {
    console.error('[Migration] call intelligence recording mp3 FAILED (recording links will serve unplayable GSM WAVs — apply sql/070 manually):', err.message);
  }
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', server: 'lp-mcp-server', version: SERVER_VERSION, port: PORT });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    server: 'lp-mcp-server',
    version: SERVER_VERSION,
    uptime: process.uptime(),
    active_sessions: Object.keys(streamableSessions).length,
    lp_config: {
      api_base_url: process.env.LP_API_BASE_URL ? 'set' : 'MISSING',
      client_id:    process.env.LP_CLIENT_ID    ? 'set' : 'MISSING',
      username:     process.env.LP_USERNAME      ? 'set' : 'MISSING',
      password:     process.env.LP_PASSWORD      ? 'set' : 'MISSING',
      app_key:      process.env.LP_APP_KEY       ? 'set' : 'MISSING',
    },
    lp_token: getTokenStatus(),
    supabase: process.env.SUPABASE_URL ? 'configured' : 'MISSING',
    ghl: process.env.GHL_API_KEY ? 'configured' : 'MISSING',
    engagement_summary: {
      refresh: 'POST /n8n/engagement/refresh',
      status: 'GET /n8n/engagement/status',
      function_required: 'refresh_engagement_summary (PL/pgSQL — run sql/phase1_53_refresh_engagement_summary.sql)',
    },
    risk_score: {
      bulk_compute: 'POST /n8n/risk-score/bulk-compute',
      distribution: 'GET /n8n/risk-score/distribution',
      function_required: 'bulk_compute_risk_scores (PL/pgSQL — run sql/phase1_54_bulk_compute_risk_scores.sql)',
    },
    anthropic: process.env.ANTHROPIC_API_KEY ? 'configured' : 'MISSING',
  });
});

// ─── LLM provider/model diagnostics ──────────────────────────────────
// Shows the provider + model the shared client (src/llm-client.js) resolves
// for every logical function from the CURRENT env — so the live config can be
// confirmed after an env change without guessing. Read-only, no LLM calls.
app.get('/diag/llm', (req, res) => {
  const functions = {};
  for (const fn of Object.keys(FUNCTION_GROUPS)) functions[fn] = resolveLLM(fn);
  res.json({
    status: 'ok',
    credentials: {
      anthropic: process.env.ANTHROPIC_API_KEY ? 'set' : 'MISSING',
      openai: process.env.OPENAI_API_KEY ? 'set' : 'MISSING',
    },
    timeout_ms: parseInt(process.env.LLM_TIMEOUT_MS || '30000', 10),
    functions,
  });
});

const streamableSessions = {};

function isInitializeRequest(body) {
  if (Array.isArray(body)) return body.some(msg => msg.method === 'initialize');
  return body?.method === 'initialize';
}

function createMCPSession() {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
  const sessionServer = new McpServer({ name: 'lp-mcp-server', version: SERVER_VERSION, description: 'Lead Perfection MCP Server — Reece Windows & Doors Revenue Intelligence' });
  registerAllTools(sessionServer);
  return { transport, server: sessionServer };
}

function registerSession(sessionId, transport, server) {
  if (!sessionId) return;
  streamableSessions[sessionId] = { transport, server };
  console.log(`[MCP] Session registered: ${sessionId}`);
  transport.onclose = () => { delete streamableSessions[sessionId]; console.log(`[MCP] Session closed: ${sessionId}`); };
}

app.post('/mcp', authenticate, async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && streamableSessions[sessionId]) { await streamableSessions[sessionId].transport.handleRequest(req, res, req.body); return; }
    if (isInitializeRequest(req.body)) {
      const { transport, server } = createMCPSession(); await server.connect(transport); await transport.handleRequest(req, res, req.body);
      registerSession(transport.sessionId, transport, server); return;
    }
    if (sessionId) { res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found. Please reinitialize.' }, id: null }); return; }
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Bad Request: Send an initialize request first.' }, id: null });
  } catch (err) { console.error('[MCP] Error:', err.stack); if (!res.headersSent) res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/mcp', authenticate, async (req, res) => { const s = req.headers['mcp-session-id']; if (s && streamableSessions[s]) { await streamableSessions[s].transport.handleRequest(req, res); } else { res.status(404).json({ error: 'Session not found' }); } });
app.delete('/mcp', authenticate, async (req, res) => { const s = req.headers['mcp-session-id']; if (s && streamableSessions[s]) { await streamableSessions[s].transport.handleRequest(req, res); delete streamableSessions[s]; } else { res.status(404).json({ error: 'Session not found' }); } });

const sseSessions = {};
app.get('/sse', authenticate, async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  const ss = new McpServer({ name: 'lp-mcp-server', version: SERVER_VERSION, description: 'Lead Perfection MCP Server — Reece Windows & Doors Revenue Intelligence' });
  registerAllTools(ss); sseSessions[transport.sessionId] = { transport, server: ss };
  res.on('close', () => { delete sseSessions[transport.sessionId]; }); await ss.connect(transport);
});
app.post('/messages', authenticate, async (req, res) => { const s = sseSessions[req.query.sessionId]; if (!s) return res.status(404).json({ error: 'Session not found' }); await s.transport.handlePostMessage(req, res); });

app.post('/sync/full', authenticate, async (req, res) => { res.json({ status: 'started', type: 'full' }); fullSync().catch(e => console.error('[Sync]', e.message)); });
app.post('/sync/incremental', authenticate, async (req, res) => { res.json({ status: 'started', type: 'incremental' }); incrementalSync().catch(e => console.error('[Sync]', e.message)); });
app.post('/sync/fields', authenticate, async (req, res) => { res.json({ status: 'started', type: 'field_sync' }); runBulkFieldSync().catch(e => console.error('[FieldSync]', e.message)); });

app.post('/sync/reconcile', authenticate, async (req, res) => {
  try {
    const { startdate = '2020-01-01', enddate } = req.body || {};
    const end = enddate || new Date().toISOString().slice(0, 10);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    let lpCount = 0, idx = 1;
    while (true) { const r = await getLeads({ startdate, enddate: end, PageSize: 200, StartIndex: idx }); const items = Array.isArray(r) ? r : (r?.data || r?.leads || r?.results || []); if (!items?.length) break; lpCount += items.length; idx += items.length; await sleep(300); }
    const { count: sbCount } = await supabase.from('lp_leads').select('id', { count: 'exact', head: true }).gte('created_at_lp', startdate).lte('created_at_lp', end);
    const drift = Math.abs(lpCount - (sbCount || 0));
    res.json({ lp_count: lpCount, supabase_count: sbCount || 0, drift, drift_percent: lpCount > 0 ? ((drift / lpCount) * 100).toFixed(2) : '0', status: drift === 0 ? 'synced' : 'drift_detected', date_range: { startdate, enddate: end } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/sync/status', authenticate, async (req, res) => {
  try {
    const [syncLog, totalLeads, unmatchedLeads, unresolvedErrors] = await Promise.all([
      supabase.from('lp_sync_log').select('*').order('started_at', { ascending: false }).limit(5),
      supabase.from('lp_leads').select('id', { count: 'exact', head: true }),
      supabase.from('lp_leads').select('id', { count: 'exact', head: true }).is('ghl_contact_id', null),
      supabase.from('lp_sync_errors').select('id', { count: 'exact', head: true }).eq('resolved', false),
    ]);
    if (syncLog.error) return res.status(500).json({ error: syncLog.error.message });
    res.json({ recent_syncs: syncLog.data, total_leads: totalLeads.count || 0, unmatched_leads: unmatchedLeads.count || 0, unresolved_errors: unresolvedErrors.count || 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/lp/test', authenticate, async (req, res) => { try { res.json(await testConnection()); } catch (err) { res.status(500).json({ error: err.message }); } });

app.post('/webhook/lp', async (req, res) => {
  const webhookSecret = process.env.N8N_WEBHOOK_SECRET;
  if (webhookSecret) { const p = req.headers['x-webhook-secret'] || req.query.secret; if (p !== webhookSecret) return res.status(401).json({ error: 'Invalid webhook secret' }); }
  const event = req.body.event || req.headers['x-lp-event'] || 'lead.updated';
  const payload = req.body.data || req.body;
  res.json({ status: 'accepted', event });
  handleWebhookEvent(event, payload).catch(e => console.error(`[Webhook] ${event}:`, e.message));
});

// ─── n8n APIs ─────────────────────────────────────────────────────
registerN8nEnrichRoute(app);
registerN8nHelperRoutes(app);
registerN8nAvatarRoutes(app);

// ─── LLM gateway (env-controlled provider/model for n8n + HL MCP) ─
registerLlmGatewayRoutes(app);

// ─── Agentic Decision Engine + Action Executor ───────────────────
registerDecisionEngineRoutes(app);
registerActionExecutorRoutes(app);
registerStateRoutes(app);
registerHoldCompleteRoutes(app);

// ─── Executor Heartbeat (failover for n8n cron) ──────────────────
registerExecutorHeartbeatRoutes(app);

// ─── Decision Engine Heartbeat (failover for n8n cron, Play 2) ───
registerDecisionEngineHeartbeatRoutes(app);

// ─── Layer 3: Behavioral Intelligence ────────────────────────────
registerContextBuilderRoutes(app);
registerBehavioralEmitterRoutes(app);
registerMessageAnalyzerRoutes(app);

// ─── Layer 3.5: Intent Scoring ───────────────────────────────────
registerIntentScorerRoutes(app);

// ─── Phase 4: KB Vector Ingestion ────────────────────────────────
registerKbIngestionRoutes(app);

// ─── Pause-Workflow Fizzle Sweep ─────────────────────────────────
registerPauseWorkflowSweepRoutes(app);

// ─── Approval Escalation Sweep ───────────────────────────────────
registerApprovalEscalationRoutes(app);

// ─── REST API for GHL Agent Studio ───────────────────────────────
registerRestApiRoutes(app, authenticate);

// ─── Events Router (per-event-type webhook endpoints) ────────────
// S5.2 v2 workflow steps POST to /events/workflow_started, /workflow_exit,
// /state_transition, /routing_failure. Closes a 404 gap that existed because
// only /webhook/ghl-event was registered. Each endpoint creates a system_event
// the Decision Engine then picks up on the next cycle.
registerEventsRouter(app);

// ─── Objection-State Ghost Sweep ─────────────────────────────────
// Emits `confirmation_unacknowledged` events for contacts whose
// appointment has passed without a disposition or inbound reply.
// Feeds the BEHAVIORAL_GHOST_AFTER_BOOKING STATE_CLASSIFICATION rule.
registerGhostSweepRoutes(app);

// ─── Appointment Parity Watchdog ─────────────────────────────────
// POST /n8n/appointments/parity-check — on-demand bidirectional
// LP<->GHL appointment reconciliation. Dry-run unless PARITY_AUTOHEAL
// is 'true'; reports the divergence classes and their findings.
registerAppointmentParityRoutes(app);

// ─── LP Callback Re-queue Verification ───────────────────────────
// 2026-08-18 (handoff C4): POST /n8n/lp-requeue/verify-sweep — verify
// every completed lp_callback_requeue became dialable (new lds issued via
// LP's ~60s callback) or escalate a priority GroupMe inside the bounded
// window. A promised call is never silently dropped.
registerLpRequeueVerifyRoutes(app);

// ─── LP Addlead Address Hold + Prospect Address Backfill ─────────
// 2026-08-18 (Section D): POST /n8n/lp-addlead-hold/sweep works the
// hold-and-enrich queue (never drop — exhausted holds forward stamped);
// POST /n8n/lp-address-backfill/sweep repairs blank LP prospect addresses
// from GHL via UpdateProspectInfo with read-back verification;
// GET /n8n/lp-address-backfill/dry-run-count is the shadow report number.
registerLpAddleadHoldRoutes(app);
registerLpAddressBackfillRoutes(app);

// ─── Objection Fall-Through Sweep ────────────────────────────────
// 2026-05-20 (Option 1 Step 4): detects intent.objection_detected
// events where NO routing rule (new state classifier OR legacy Rules
// 214/215) picked the contact up within a 3min grace window. Emits a
// `priority`-class GroupMe notification for genuine misses only —
// successful routing produces its own accurate "ROUTED TO X" intelligence
// notification via the state handler v1.6 + Rules 214/215 send_notification
// actions, so this sweep covers the remaining gap (competitor / DIY
// objections, undetermined-funnel-state contacts, handler crashes).
registerFallthroughSweepRoutes(app);

// ─── GroupMe Two-Way Integration ─────────────────────────────────
registerGroupMeRoutes(app);

// ─── LP Appointment Sync (GHL → LP) ──────────────────────────────
registerLPAppointmentSyncRoutes(app);

// ─── LP Addlead Validation Proxy (GHL addlead → hour gate → LP) ──
registerLpAddleadProxyRoutes(app);

// ─── Canvassing Intake (I.CC → deterministic time/notes → LP) ────
registerCanvassingIntakeRoutes(app);

// ─── Workflow Completion ─────────────────────────────────────────
registerWorkflowCompletionRoutes(app);

// ─── Cooling Callbacks ───────────────────────────────────────────
registerCoolingCallbackRoutes(app);

// ─── Entry Events ────────────────────────────────────────────────
registerEntryEventRoutes(app);

// ─── GHL Tag Webhook Bridge ──────────────────────────────────────
registerGhlTagRoutes(app);

// ─── Canvassing Pilot v2 intake (I.CV → LP) ──────────────────────
registerCanvassingLeadRoutes(app);

// ─── Affiliate lead intake (per-affiliate GHL form → LP) ─────────
// Deliberately separate from the canvassing route: different dedup table,
// different sender, its own fail-closed SubSource registry, and a 21-day
// booking window. See src/affiliate-lead-handler.js.
//   POST /webhooks/affiliate-lead
registerAffiliateLeadRoutes(app);

// ─── GHL Inbound → LP Note pipeline ──────────────────────────────
// Turns GHL inbound conversations into one clean facts-only LP note per
// conversation session for the call center. GHL-only, independent of Revin.
//   POST /ghl/inbound-message
registerGhlInboundRoutes(app);

// ─── IME MIC Integration ─────────────────────────────────────────
registerImeRoutes(app);

// ─── MVI v2.5 — Antifragile services ─────────────────────────────
registerDriftDetectorRoutes(app);
registerInternalRoutes(app);

// ─── Phase 1 #53 — Engagement Summary Refresh ────────────────────
// 2026-05-13: aggregates 90d engagement signals into engagement_summary.
// Calls refresh_engagement_summary() PL/pgSQL function.
//   POST /n8n/engagement/refresh  { mode, contact_ids?, dry_run? }
//   GET  /n8n/engagement/status
registerEngagementSummaryRoutes(app);

// ─── Phase 1 #54 (bulk) — Bulk Risk Score ────────────────────────
// 2026-05-13: scores the dormant GHL-linked pool in one SQL aggregation.
// Calls bulk_compute_risk_scores() PL/pgSQL function. Used for Phase 1
// dry-run distribution analysis before enabling enrollment rules.
//   POST /n8n/risk-score/bulk-compute  { contact_ids?, dormant_days?, limit?, ttl_days? }
//   GET  /n8n/risk-score/distribution
registerBulkRiskScoreRoutes(app);

// ─── Admin ──────────────────────────────────────────────────────
app.post('/admin/email-backfill', async (req, res) => {
  try {
    const dryRun = req.query.dryRun !== 'false';
    const limit = parseInt(req.query.limit || '500', 10);
    const results = await runEmailBackfill({ dryRun, limit });
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
registerEmailCleanupRoutes(app);

app.post('/admin/backfill-ghl-contact-id-from-lognumber', async (req, res) => {
  try {
    const body = req.body || {};
    const dryRun = !(body.dry_run === false || req.query.dryRun === 'false' || body.dryRun === false);
    const limit = parseInt(body.limit || req.query.limit || '500', 10);
    const concurrency = parseInt(body.concurrency || req.query.concurrency || '3', 10);
    const afterProspectId = body.after_prospect_id || body.afterProspectId
      || req.query.after_prospect_id || req.query.afterProspectId || null;
    const liveVerify = body.live_verify === true || req.query.live_verify === 'true';
    const maxLiveReads = parseInt(body.max_live_reads || req.query.max_live_reads || '200', 10);
    const results = await runGhlContactIdBackfill({ dryRun, limit, afterProspectId, concurrency, liveVerify, maxLiveReads });
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

registerDataFreshnessRoutes(app);
registerCohortReconcileRoutes(app);
registerAgenticMvRefreshRoutes(app);
registerSiteStitchRoutes(app);
registerLeadGurusRoutes(app);
registerSiteCollectRoutes(app);
registerAppointmentNotificationRoutes(app);
registerGhlTriggerLinkRoutes(app);
registerAgenticLeadStateRoutes(app);
registerGuestVisitorRemediationRoutes(app);
registerLinkVerifySampleRoutes(app); // 2026-07-23 — pre-enforce cache-vs-live rejection sampling (read-only vs GHL)
registerPendingProbeTtlSweepRoutes(app); // 2026-07-08 — stale pending:customer-status-check TTL sweep (scheduler env-gated, default off)
registerGhlAppointmentBackfillRoutes(app); // 2026-07-07 — LP→GHL appointment backfill trigger (dry-run default)
registerLpContactBackstopRoutes(app); // 2026-07-09 — LP contact auto-create backstop (scheduler env-gated, default off)
registerLpMirrorBackfillRoutes(app); // 2026-07-10 — windowed cursor-independent mirror recovery (dry-run default)
registerRtpJobBackfillRoutes(app); // 2026-07-10 (#512) — one-shot RTP job-axis backfill (dry-run default)
registerGhlAppointmentDedupeRoutes(app); // 2026-07-10 — WE same-slot de-dupe (dry-run default)
registerGhlAppointmentCountRoutes(app); // 2026-07-10 — live-GHL appointment count for the dashboard
registerParityReportRoutes(app); // 2026-07-10 — live LP↔GHL parity report
registerLPForceAddLeadRoutes(app);
registerLeadStateSweepRoutes(app);
registerNoteChangeAnalyzerRoutes(app);
registerEnrollExistingEligibleRoutes(app);
registerLeadSelectionRoutes(app);
registerWorkflowProjectionRoutes(app);
registerGoalScorecardRoutes(app);
registerMarketAssignmentRoutes(app);
registerCapacityBoardRoutes(app); // 2026-07-22 — TV capacity board aggregate (GET /board/capacity, unauthenticated by design)
// 2026-07-25 — GET /admin/capacity-bands: per-band LP capacity vs GHL bookings.
// Read-only. Takes `authenticate` (an admin diagnostic, not a kiosk feed);
// registered separately from the board so the two stay independently removable.
registerCapacityBandRoutes(app, authenticate);
registerScorecardRederiveRoutes(app);
registerNetReportRoutes(app);
registerCohortReobservationRoutes(app); // 2026-08-12 — cohort re-observation staleness (§8)
registerLpReportRoutes(app);
registerLpCsvRoutes(app);
registerLpReportReconRoutes(app);
registerScorecardValidateRoutes(app);
registerFive9SnapshotRoutes(app, authenticate);
registerCiRoutes(app, authenticate);            // 2026-08-21 — Call Intelligence ingest (PR 2; worker ships disarmed)

app.listen(PORT, async () => {
  console.log(`LP MCP Server v${SERVER_VERSION} running on port ${PORT}`);
  console.log(`Decision:     POST /n8n/decision-engine/process | /execute | /execute-action | /heartbeat | /heartbeat-de`);
  console.log(`Engagement:   POST /n8n/engagement/refresh | GET /n8n/engagement/status`);
  console.log(`Risk Score:   POST /n8n/risk-score/bulk-compute | GET /n8n/risk-score/distribution`);
  console.log(`Heartbeat:    POST /n8n/decision-engine/heartbeat | /heartbeat-de (6min stale threshold)`);
  console.log(`MCP:          http://localhost:${PORT}/mcp`);
  console.log(`Health:       http://localhost:${PORT}/health`);
  await runMigrations();
  initFieldSync();
  startSyncScheduler();
  startImeWorkers();
  startPauseWorkflowSweepScheduler();
  startGhostSweepScheduler();
  startAppointmentParityScheduler();
  startLpRequeueVerifyScheduler();
  startLpAddleadHoldScheduler();
  startLpAddressBackfillScheduler();
  startFallthroughSweepScheduler();
  startApprovalEscalationScheduler();
  startDataFreshnessMonitorScheduler();
  startCohortReconcileScheduler();
  startExecutorHeartbeatScheduler();
  startDecisionEngineHeartbeatScheduler();
  startDriftDetectorScheduler();
  startLeadStateSweepScheduler();
  startNoteChangeAnalyzerScheduler();
  startLeadSelectionScheduler();
  startWorkflowProjectionLoop();
  startMarketAssignmentScheduler();
  startCapacitySweepScheduler();
  startGoalScorecardScheduler();
  startScorecardValidateScheduler();
  startFive9ConfigSnapshotScheduler();
  // Probe ffmpeg, which transcodes Five9's GSM 6.10 recordings to a format a
  // browser can actually play. A CLEAR LOG LINE, NOT A CRASH: without it the
  // whole pipeline still runs and links still resolve, they just serve the
  // unplayable original. Deliberately not awaited — a boot must not wait on it.
  logFfmpegStatus().catch(() => {});
  startCiWorkerScheduler();
  startLpReportReconScheduler();
  startLpReportWatchdog();
  startLpCsvOrphanReaper();
  startFbPublishWatchdog();
  startFive9SilenceWatchdog();
  startGhlNoteSweep();
  startGhlNoteReconciliation();
  // First field-sync ~60s after boot (was ~9.5 min), then every 15 min.
  setTimeout(async () => {
    try { await runBulkFieldSync(); logCycleStats(); } catch (e) { console.error('[FieldSync]', e.message); }
    setInterval(async () => { try { await runBulkFieldSync(); logCycleStats(); } catch (e) { console.error('[FieldSync]', e.message); } }, FIELD_SYNC_INTERVAL_MS);
  }, 60000);
});
