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
// ─── Events Router (per-event-type webhook endpoints) ────────────
import { registerEventsRouter } from './events-router.js';
// ─── Objection-State Ghost Sweep (post-booking ghost detection) ──
import {
  registerGhostSweepRoutes,
  startGhostSweepScheduler,
} from './objection-state-ghost-sweep.js';
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
// ─── Workflow Completion (tag-based self-enrichment) ─────────────
import { registerWorkflowCompletionRoutes } from './workflow-completion-handler.js';
// ─── Cooling Callbacks ───────────────────────────────────────────
import { registerCoolingCallbackRoutes } from './cooling-callback-handler.js';
// ─── Entry Events (Route B agentic-first entry routing) ─────────
import { registerEntryEventRoutes } from './entry-event-handler.js';
// ─── GHL Tag Webhook Bridge (Wave 1.2) ──────────────────────────
import { registerGhlTagRoutes } from './ghl-tag-handler.js';
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
import {
  registerDataFreshnessRoutes,
  startDataFreshnessMonitorScheduler,
} from './admin/data-freshness.js';
import { runGhlContactIdBackfill } from './admin/ghl-contact-id-backfill.js';
import { registerGhlTriggerLinkRoutes } from './admin/ghl-trigger-links.js';
import { registerAgenticLeadStateRoutes } from './admin/agentic-lead-states.js';
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

// ─── Workflow Completion ─────────────────────────────────────────
registerWorkflowCompletionRoutes(app);

// ─── Cooling Callbacks ───────────────────────────────────────────
registerCoolingCallbackRoutes(app);

// ─── Entry Events ────────────────────────────────────────────────
registerEntryEventRoutes(app);

// ─── GHL Tag Webhook Bridge ──────────────────────────────────────
registerGhlTagRoutes(app);

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
    const results = await runGhlContactIdBackfill({ dryRun, limit, afterProspectId, concurrency });
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

registerDataFreshnessRoutes(app);
registerAgenticMvRefreshRoutes(app);
registerAppointmentNotificationRoutes(app);
registerGhlTriggerLinkRoutes(app);
registerAgenticLeadStateRoutes(app);
registerLPForceAddLeadRoutes(app);
registerLeadStateSweepRoutes(app);

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
  startFallthroughSweepScheduler();
  startApprovalEscalationScheduler();
  startDataFreshnessMonitorScheduler();
  startExecutorHeartbeatScheduler();
  startDecisionEngineHeartbeatScheduler();
  startDriftDetectorScheduler();
  startLeadStateSweepScheduler();
  setTimeout(() => {
    setTimeout(async () => { try { await runBulkFieldSync(); logCycleStats(); } catch (e) { console.error('[FieldSync]', e.message); } }, 120000);
    setInterval(async () => { try { await runBulkFieldSync(); logCycleStats(); } catch (e) { console.error('[FieldSync]', e.message); } }, FIELD_SYNC_INTERVAL_MS);
  }, 450000);
});
