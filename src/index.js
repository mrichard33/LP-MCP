import 'dotenv/config';
import { makeAuthenticate } from './auth.js';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerAllTools } from './tools/index.js';
import { startSyncScheduler, fullSync, incrementalSync, handleWebhookEvent } from './sync-engine.js';
import { trackInflight, trackBackground, installGracefulShutdown } from './graceful-shutdown.js';
import { intakeJournal, startIntakeJournalSweeper, registerIntakeJournalRoutes } from './intake-journal.js';
import { startSharedBudgetReporter, registerSharedBudgetRoutes } from './ghl-shared-budget.js';
import { testConnection, getLeads } from './lp-client.js';
import { getTokenStatus } from './token-manager.js';
import { getToken } from './token-manager.js';
import { buildIntegrationsHealth } from './integrations-health.js';
import { five9AuthBreakerStatus, getSkills as five9GetSkills } from './five9-admin.js';
import { getRecentGroupMeMessages } from './groupme-read.js';
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
import { registerMemoryRoutes } from './memory/memory-routes.js';
import { registerRecommendRoutes } from './memory/recommend-routes.js';
import { registerOmiRoutes, omiBodyParser } from './memory/omi-routes.js';
import { registerOmiPullRoutes } from './memory/omi-pull-routes.js';
import { startOmiPullScheduler } from './jobs/omi-pull.js';
import { registerMemoryNightlyRoutes, startMemoryNightlyScheduler } from './jobs/memory-nightly.js';
import { registerAdminMemoryRoutes } from './routes/admin-memory.js';
// 2026-09-11 — Bot Review Phase 0 (handoff §5.1): coverage health + the 30-min
// outcomes job n8n calls. No DDL, no boot-time table creation.
import { registerBotFeedbackRoutes } from './bot-feedback/routes.js';
import { checkMemorySchema } from './memory/memory-migrations.js';
import { runStartupSchema } from './admin/startup-schema.js';
import { STARTUP_MIRRORS } from './admin/startup-mirrors.js';
import { startJobRunner } from './job-runner.js';
import { JOBS } from './job-registry.js';
import { startTier1EmbedSweep } from './knowledge/tier1-semantic.js';
import { startExemplarSweep } from './knowledge/exemplars.js';
import { startCiMomentsSweep } from './knowledge/ci-moments.js';
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
// ─── Slack approval buttons (Approve / Reject on approval cards) ─
import { registerSlackApprovalRoutes, slackRawBodyParser } from './slack-approvals.js';
// ─── LP Appointment Sync (GHL → LP) ────────────────────────────
import { registerLPAppointmentSyncRoutes } from './lp-appointment-sync.js';
// ─── LP Addlead Validation Proxy (GHL addlead → hour gate → LP) ──
import { registerLpAddleadProxyRoutes } from './lp-addlead-proxy.js';
import { registerApIntakeRoutes } from './ap-intake.js';
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
// ─── GHL tag inbox worker (Project 2 — fast-ack durability) ──────
import { startGhlTagProcessor } from './jobs/ghl-tag-processor.js';
// ─── Canvassing Pilot v2 intake (I.CV → LP) ──────────────────────
import { registerCanvassingLeadRoutes } from './canvassing-lead-handler.js';
// ─── Canvass confirmation intake (U.LCF, existing LP prospect) ───
import { registerCanvassConfirmationRoutes } from './canvass-confirmation-handler.js';
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
// 2026-09-03 — capacity-driven Five9 list priority ranker. Ships in shadow
// (CAPACITY_RANKER_MODE=shadow default): computes, logs, never writes.
import { registerCapacityRankerRoutes } from './routes/capacityRanker.js';
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
// Daily 08:00 ET cross-source recon for the ingested LP reports.
import { registerLpReportReconRoutes, startLpReportReconScheduler } from './jobs/lp-report-recon.js';
// Daily 05:30 ET LP-driven source reconciler — diffs LP's authoritative source
// list against lp_source_mapping. Reports only; never writes a mapping.
import { registerSourceReconcileRoutes, startSourceReconcileScheduler } from './jobs/source-reconcile.js';
// 07:30 ET missing-report watchdog — watches the OUTCOME table, independent
// of every pipeline stage (LP schedule / Gmail / n8n / ingest route).
import { startLpReportWatchdog } from './jobs/lp-report-watchdog.js';
import { startApptProspectDupeSweep } from './jobs/appt-prospect-dupe-sweep.js';
// Clears chunked ingests that began and never finalized. They hold the snapshot
// unique keys, so each one rejects its own corrected re-send until released.
import { startLpCsvOrphanReaper } from './jobs/lp-csv-orphan-reaper.js';
// Nightly scorecard validation + GroupMe tie-out alert.
import { registerScorecardValidateRoutes, startScorecardValidateScheduler } from './jobs/scorecard-validate.js';
// 2026-08-06 Phase E — daily Five9 config snapshot + change log (ships dark)
import { registerFive9SnapshotRoutes, startFive9ConfigSnapshotScheduler } from './jobs/five9-config-snapshot.js';
import { registerFreshnessRefreshRoutes, startFreshnessRefreshScheduler } from './jobs/freshness-refresh.js';
// 2026-09-18 — daily watch on the LP↔GHL link write path. The leak this
// catches has been closed twice before and reopened unnoticed both times.
import { registerLinkLeakRoutes, startLinkLeakScheduler } from './jobs/link-leak-monitor.js';
import { registerP2UnresolvableRoutes, startP2UnresolvableScheduler } from './jobs/p2-unresolvable-monitor.js';
import { registerTagHygieneRoutes, startTagHygieneScheduler } from './jobs/tag-hygiene-sweep.js';  // 2026-09-22
import { startOfficePowerRankingScheduler } from './jobs/office-power-ranking.js';  // 2026-09-24
import { startSaleBackstopScheduler } from './jobs/sale-announce-backstop.js';  // 2026-09-25
import { startMissedCallerRecoveryScheduler } from './jobs/missed-caller-recovery.js';  // 2026-09-24
import { registerLeadLeakRoutes, startLeadLeakScheduler } from './jobs/lead-leak-monitor.js';  // 2026-09-26
import { registerCiRoutes } from './ci/routes.js';
import { startCiWorkerScheduler } from './ci/worker.js';
import { startCiDiscoveryScheduler } from './jobs/ci-discovery-scheduler.js';
import { logFfmpegStatus } from './ci/recordings.js';
// ─── Agentic Hold-Complete (return-from-hold re-entry) ───────────
import { registerHoldCompleteRoutes } from './agentic/hold-complete.js';
// 2026-09-26 — website live chat answered synchronously (src/live-chat/).
import { registerLiveChatRoutes } from './live-chat/index.js';
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
// sql/101 — an Omi conversation is far bigger than express.json()'s 100 kB
// default, and the global parser would answer 413 before /memory/omi/ingest
// could apply (and explain) its own OMI_MAX_BODY_BYTES cap. Mounted first, on
// that path only; every other route keeps the default limit.
app.use('/memory/omi', omiBodyParser());
// Slack signs the exact raw bytes. The global urlencoded parser below would
// consume the stream first, so this path gets express.raw and body-parser's
// own already-parsed check makes the global parsers skip it.
app.use('/webhook/slack', slackRawBodyParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Graceful drain: count in-flight requests so SIGTERM waits for them.
app.use(trackInflight);
// Write-ahead journal for lead-carrying routes. Fail-open: a journal error or
// a slow insert never blocks or delays a lead past its 1.5s ceiling.
app.use(intakeJournal());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── I.TRACK — tracker asset + tracking-domain guard ──────────────
// The tracker is loaded on every Reece site from its own first-party
// address, https://track.getreecewindows.com/reece-tracker.js, which is a
// custom domain on this same Railway service. Two things follow.
//
// 1) The file has to be served, and today it is not — nothing mounts
//    public/, so the URL 404s. We keep it unmounted on purpose:
//    express.static('public') would publish every other file in that
//    directory too. So exactly one file is exposed, by an explicit route,
//    read once at boot rather than off disk per request.
// 2) The tracking hostname must not expose the rest of this service. On
//    that host only the tracker, /health and the collector may answer;
//    everything else 404s, which keeps the MCP and admin surfaces
//    unreachable through the tracking domain.
//
// Registered here, ahead of every other route, so both are reachable
// without a token — the same way the /n8n/site/* collector routes are.
const TRACKER_PATH = '/reece-tracker.js';
const TRACKING_HOST = 'track.getreecewindows.com';
const TRACKING_HOST_ALLOWED = new Set([
  `GET ${TRACKER_PATH}`,
  'GET /health',
  'POST /n8n/site/collect',
]);

let trackerBundle = null;
try {
  trackerBundle = readFileSync(new URL('../public/reece-tracker.js', import.meta.url));
  console.log(`[I.TRACK] Loaded public/reece-tracker.js (${trackerBundle.length} bytes)`);
} catch (err) {
  console.error(`[I.TRACK] public/reece-tracker.js unavailable — GET ${TRACKER_PATH} will 404: ${err.message}`);
}

app.use((req, res, next) => {
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  if (host !== TRACKING_HOST) return next();
  if (TRACKING_HOST_ALLOWED.has(`${req.method} ${req.path}`)) return next();
  return res.status(404).json({ error: 'Not found' });
});

app.get(TRACKER_PATH, (req, res) => {
  if (!trackerBundle) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(trackerBundle);
});

const AUTH_SOFT_LAUNCH = process.env.AUTH_SOFT_LAUNCH === 'true';

// The standard operator auth. Lives in src/auth.js so route modules can be
// tested against the real check (2026-09-23); behaviour is unchanged.
const authenticate = makeAuthenticate({ token: MCP_AUTH_TOKEN, softLaunch: AUTH_SOFT_LAUNCH });

// Boot-time schema mirrors. The blocks live in src/admin/startup-mirrors.js
// (moved verbatim 2026-09-26); src/admin/startup-schema.js reads the catalog
// once and runs only the blocks with something missing, so a healthy boot
// takes no table locks and fires no DDL events. See that file's header for the
// lock-timeout / schema-cache false alarms this replaced. Never throws.
async function runMigrations() {
  try {
    const { runSQL } = await import('./admin/supabase-admin.js');
    const { readFile } = await import('node:fs/promises');
    await runStartupSchema(STARTUP_MIRRORS, {
      runSQL,
      readSqlFile: (rel) => readFile(new URL(`../${rel}`, import.meta.url), 'utf8'),
      opsAlert: async (text) => {
        const { sendGroupMeMessage } = await import('./groupme.js');
        return sendGroupMeMessage(text, { channel: 'ops' });
      },
    });
  } catch (err) {
    console.error('[Migration] startup schema check crashed:', err.message);
  }

  // Lead Leak Monitor results (sql/130, 2026-09-26 — the file is the source of
  // truth). Additive: a new table and a view over it, nothing existing altered.
  // A failure makes the scheduled pass fail its write (runJob files it failed);
  // it never touches lp_*, GHL or Five9 either way.
  try {
    const { runSQL } = await import('./admin/supabase-admin.js');
    await runSQL(`CREATE TABLE IF NOT EXISTS lead_leak_daily (
              id bigserial PRIMARY KEY,
              run_date date NOT NULL,
              lp_lead_id text NOT NULL,
              lp_prospect_id text,
              lead_source text,
              disposition text,
              reason text NOT NULL,
              est_value numeric,
              detail jsonb,
              created_at timestamptz DEFAULT now(),
              UNIQUE (run_date, lp_lead_id)
            );`);
    await runSQL(`CREATE OR REPLACE VIEW v_lead_leak_summary AS
            SELECT run_date,
                   reason,
                   count(*)        AS leads,
                   sum(est_value)  AS est_value_at_risk
              FROM lead_leak_daily
             GROUP BY run_date, reason;`);
    console.log('[Migration] lead_leak_daily + v_lead_leak_summary (sql/130) ready');
  } catch (err) {
    console.warn('[Migration] lead_leak_daily (sql/130) skipped — apply it from the dashboard; the lead-leak monitor stores nothing until it exists:', err.message);
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
      // Optional, unlike the five above — unset just means notes are written
      // by the primary credential, so 'not set' is not a fault condition.
      note_username: process.env.LP_NOTE_USERNAME ? 'set' : 'not set (notes use primary)',
      note_password: process.env.LP_NOTE_PASSWORD ? 'set' : 'not set (notes use primary)',
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

// ─── Integration reachability (2026-09-16) ───────────────────────────
// Read-only probes for the services whose credentials live only here: the
// LP API, Five9, Slack and GroupMe. Feeds the dashboard's Integrations grid so
// a dead dialer or a silently no-op'd Slack mirror is visible on a screen
// instead of inferred from a quiet night. Never posts anywhere; see
// src/integrations-health.js for the state vocabulary and the tri-state rule.
app.get('/health/integrations', authenticate, async (req, res) => {
  try {
    const result = await buildIntegrationsHealth({
      env: process.env,
      fetch,
      lp: { getToken, getTokenStatus },
      five9: { breakerStatus: five9AuthBreakerStatus, getSkills: five9GetSkills },
      groupme: { getRecentMessages: getRecentGroupMeMessages },
    });
    res.json({ status: 'ok', ...result });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
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
  trackBackground(handleWebhookEvent(event, payload).catch(e => console.error(`[Webhook] ${event}:`, e.message)));
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
// 2026-09-26 — POST /webhooks/live-chat-inbound, behind LIVE_CHAT_FAST_LANE_MODE (default off).
registerLiveChatRoutes(app);

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
// The older /n8n/kb/* routes stay as they were. POST /n8n/kb/reembed spends
// OpenAI budget and rewrites vectors, so it takes the standard auth.
registerKbIngestionRoutes(app, authenticate);

// ─── Memory vector tier (sql/094): server-side backfill + hybrid search ──
// Operator surface only; nothing in the request path calls it. Authenticated.
registerMemoryRoutes(app, authenticate);
// sql/102: Command Center recommendation backlog. Does nothing at all until
// MEMORY_RECOMMEND_MODE is shadow or live.
registerRecommendRoutes(app, authenticate);
// sql/101: Omi conversation ingest. Its own Bearer token (OMI_INGEST_TOKEN),
// NOT MCP_AUTH_TOKEN — the n8n relay must not hold the key to every admin
// route here. Answers 503 until OMI_INGEST_MODE is set to shadow or live.
registerOmiRoutes(app);
// Admin controls for the outbound pull. Unlike the webhook above these are
// ordinary operator endpoints, so they take the standard auth middleware.
registerOmiPullRoutes(app, authenticate);
registerMemoryNightlyRoutes(app, authenticate);
// sql/098: n8n event door (pending / issue, never decision) + manual validation run.
registerAdminMemoryRoutes(app, authenticate);

// ─── Pause-Workflow Fizzle Sweep ─────────────────────────────────
registerPauseWorkflowSweepRoutes(app);

// ─── Approval Escalation Sweep ───────────────────────────────────
registerApprovalEscalationRoutes(app);

// ─── Bot Review (Phase 0) ────────────────────────────────────────
// GET /api/bot-feedback/health, POST /api/bot-feedback/jobs/outcomes.
registerBotFeedbackRoutes(app, authenticate);

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
// 2026-09-14: was mounted WITHOUT authenticate, unlike every neighbouring
// register*Routes call. POST /n8n/appointments/parity-check accepts
// {dryRun:false}, which runs a live sweep writing to Lead Perfection and GHL —
// so the one unauthenticated route in this group was also the one that could
// mutate both systems. No global middleware covers /n8n/*.
registerAppointmentParityRoutes(app, authenticate);
registerSharedBudgetRoutes(app, authenticate);

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
registerSlackApprovalRoutes(app);

// ─── LP Appointment Sync (GHL → LP) ──────────────────────────────
registerLPAppointmentSyncRoutes(app);

// ─── LP Addlead Validation Proxy (GHL addlead → hour gate → LP) ──
registerLpAddleadProxyRoutes(app);
registerApIntakeRoutes(app);

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
registerIntakeJournalRoutes(app, authenticate);

// ─── Canvassing Pilot v2 intake (I.CV → LP) ──────────────────────
registerCanvassingLeadRoutes(app);

// ─── Canvass confirmation intake (U.LCF → record only) ───────────
// The Lightfire confirmation form, BOTH branches. A submission is an
// unverified intake record, not a lead: a confirmation agent reviews it in P4
// and LP creation happens later, in a separate workflow. So this endpoint
// emits canvass.confirmation_submitted and writes a GHL note, and never
// touches LP on either path.
//   POST /webhooks/canvass-confirmation
registerCanvassConfirmationRoutes(app);

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
registerCapacityRankerRoutes(app); // 2026-09-03 — POST /n8n/capacity-ranker/run: next-day capacity → Five9 list priority (shadow by default)
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
registerSourceReconcileRoutes(app);
registerScorecardValidateRoutes(app);
registerFive9SnapshotRoutes(app, authenticate);
registerFreshnessRefreshRoutes(app);
registerLinkLeakRoutes(app);
registerLeadLeakRoutes(app);
registerP2UnresolvableRoutes(app);
registerTagHygieneRoutes(app, authenticate);
registerCiRoutes(app, authenticate);            // 2026-08-21 — Call Intelligence ingest (PR 2; worker ships disarmed)

const server = app.listen(PORT, async () => {
  console.log(`LP MCP Server v${SERVER_VERSION} running on port ${PORT}`);
  console.log(`Decision:     POST /n8n/decision-engine/process | /execute | /execute-action | /heartbeat | /heartbeat-de`);
  console.log(`Engagement:   POST /n8n/engagement/refresh | GET /n8n/engagement/status`);
  console.log(`Risk Score:   POST /n8n/risk-score/bulk-compute | GET /n8n/risk-score/distribution`);
  console.log(`Heartbeat:    POST /n8n/decision-engine/heartbeat | /heartbeat-de (6min stale threshold)`);
  console.log(`MCP:          http://localhost:${PORT}/mcp`);
  console.log(`Health:       http://localhost:${PORT}/health`);
  await runMigrations();

  // Job run history (2026-09-16, sql/113). Upserts the roster so a silent job
  // is visible as silence, and closes any run left 'running' by the deploy that
  // just replaced this container — that is `interrupted`, never a failure (same
  // lesson as src/sync-log.js:56-70). Never throws: a missing sql/113 must not
  // stop the service booting.
  await startJobRunner(JOBS).catch((err) =>
    console.error('[JobRunner] startup failed:', err.message));
  startTier1EmbedSweep(); // v1.10 — no-op while KB_FAQ_SEMANTIC_MODE=off
  startExemplarSweep();   // v1.11 — no-op while KB_EXEMPLAR_MODE=off
  startCiMomentsSweep();  // v1.12 — no-op while KB_CALL_MOMENTS_MODE=off
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
  // Drains ghl_tag_inbox. /webhooks/ghl-tag only enqueues now, so without
  // this running no tag event ever reaches the Decision Engine.
  startGhlTagProcessor();
  startIntakeJournalSweeper();
  // Measurement only — no-op unless GHL_SHARED_BUDGET_MODE=shadow.
  startSharedBudgetReporter();
  startDriftDetectorScheduler();
  startLeadStateSweepScheduler();
  startNoteChangeAnalyzerScheduler();
  startLeadSelectionScheduler();
  startWorkflowProjectionLoop();
  startMarketAssignmentScheduler();
  startMemoryNightlyScheduler();
    startOmiPullScheduler();
  checkMemorySchema().catch((err) => console.warn('[MemorySchema] boot check failed:', err.message));
  startCapacitySweepScheduler();
  startGoalScorecardScheduler();
  startScorecardValidateScheduler();
  startFive9ConfigSnapshotScheduler();
  startFreshnessRefreshScheduler();
  startLinkLeakScheduler();
  startP2UnresolvableScheduler();
  startTagHygieneScheduler();
  startOfficePowerRankingScheduler();
  startSaleBackstopScheduler();
  startMissedCallerRecoveryScheduler();
  startLeadLeakScheduler();
  // Probe ffmpeg, which transcodes Five9's GSM 6.10 recordings to a format a
  // browser can actually play. A CLEAR LOG LINE, NOT A CRASH: without it the
  // whole pipeline still runs and links still resolve, they just serve the
  // unplayable original. Deliberately not awaited — a boot must not wait on it.
  logFfmpegStatus().catch(() => {});
  startCiWorkerScheduler();
  // Opens the front door: until this existed, calls entered Call Intelligence
  // only when a human called POST /ci/discover. Ships DISARMED.
  startCiDiscoveryScheduler();
  startLpReportReconScheduler();
  startSourceReconcileScheduler();
  startLpReportWatchdog();
  startApptProspectDupeSweep();
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

installGracefulShutdown(server);
