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
// ─── Layer 3: Behavioral Intelligence ────────────────────────────
import { registerContextBuilderRoutes } from './context-builder.js';
import { registerBehavioralEmitterRoutes } from './behavioral-emitter.js';
import { registerMessageAnalyzerRoutes } from './message-analyzer.js';
// ─── Layer 3.5: Intent Scoring + Conversion Engine ───────────────
import { registerIntentScorerRoutes } from './intent-scorer.js';
// ─── Phase 4: KB Vector Ingestion (agentic bot knowledge layer) ──
import { registerKbIngestionRoutes } from './knowledge/ingest-embeddings.js';
// ─── Pause-Workflow Fizzle Sweep (framework: HOT1 / MOMENTUM ACT-5) ───
import {
  registerPauseWorkflowSweepRoutes,
  startPauseWorkflowSweepScheduler,
} from './pause-workflow-sweep.js';
// ─── Approval Escalation Sweep (30min escalate / 60min auto-exec / 4h auto-reject) ───
import {
  registerApprovalEscalationRoutes,
  startApprovalEscalationScheduler,
} from './approval-escalation-sweep.js';
// ─── REST API for GHL Agent Studio ───────────────────────────────
import { registerRestApiRoutes } from './rest-api.js';
// ─── GroupMe Two-Way Integration ─────────────────────────────────
import { registerGroupMeRoutes } from './groupme.js';
// ─── LP Appointment Sync (GHL → LP) ────────────────────────────
import { registerLPAppointmentSyncRoutes } from './lp-appointment-sync.js';
// ─── Workflow Completion (tag-based self-enrichment) ─────────────
import { registerWorkflowCompletionRoutes } from './workflow-completion-handler.js';
// ─── IME MIC Integration (Sam's Club Construction leads) ─────────
import { registerImeRoutes, startImeWorkers } from './ime/index.js';
// ─── Admin ──────────────────────────────────────────────────────
import { runEmailBackfill } from './admin/email-backfill.js';
import { registerEmailCleanupRoutes } from './admin/email-cleanup.js';
import {
  registerDataFreshnessRoutes,
  startDataFreshnessMonitorScheduler,
} from './admin/data-freshness.js';

const PORT = process.env.PORT || 8080;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const FIELD_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const SERVER_VERSION = '6.5.0';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function authenticate(req, res, next) {
  if (!MCP_AUTH_TOKEN) return next();
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${MCP_AUTH_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Auto-migrate: create tables if missing ──────────────────────
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
    groupme: {
      bot_id: process.env.GROUPME_BOT_ID ? 'configured' : 'MISSING',
      group_id: process.env.GROUPME_GROUP_ID || 'not set',
      webhook: 'POST /webhook/groupme',
      send: 'POST /groupme/send',
      pending: 'GET /groupme/pending',
    },
    n8n_apis: {
      enrich_lead: 'POST /n8n/enrich-lead',
      refresh_token: 'POST /n8n/refresh-token',
      prospect_lookup: 'POST /n8n/prospect-lookup',
      time_to_appointment: 'POST /n8n/time-to-appointment',
      avatar_score: 'POST /n8n/avatar/score',
      avatar_parse_gpt: 'POST /n8n/avatar/parse-gpt',
      avatar_unified_inputs: 'POST /n8n/avatar/unified-inputs',
      avatar_pick_best: 'POST /n8n/avatar/pick-best',
      avatar_build_ghl: 'POST /n8n/avatar/build-ghl',
      avatar_build_notion: 'POST /n8n/avatar/build-notion',
    },
    decision_engine: {
      process: 'POST /n8n/decision-engine/process',
      execute: 'POST /n8n/decision-engine/execute',
      status: 'GET /n8n/decision-engine/status',
      execution_stats: 'GET /n8n/decision-engine/execution-stats',
      reload_rules: 'POST /n8n/decision-engine/reload-rules',
    },
    layer3_behavioral: {
      context: 'GET /n8n/lead-intelligence/context?contactId=...',
      intelligence: 'GET /n8n/lead-intelligence/intelligence?contactId=...',
      cache_stats: 'GET /n8n/lead-intelligence/cache-stats',
      bump_cache: 'POST /n8n/lead-intelligence/bump-cache',
      analyze_pending: 'POST /n8n/analyze-pending-replies',
      analyze_manual: 'POST /n8n/analyze-message',
      analyzer_status: 'GET /n8n/analyzer-status',
      webhooks: [
        'POST /webhook/ghl/reply',
        'POST /webhook/ghl/appointment',
        'POST /webhook/ghl/engagement',
        'POST /webhook/ghl/lead-score',
        'POST /webhook/ghl/workflow',
        'POST /webhook/ghl/workflow-tag',
        'POST /webhook/ghl/set-lp-appointment',
      ],
    },
    intent_scoring: {
      score_contact: 'POST /n8n/intent/score',
      stall_sweep: 'POST /n8n/intent/sweep',
      breakdown: 'GET /n8n/intent/breakdown?contactId=...',
    },
    knowledge_base: {
      ingest: 'POST /n8n/kb/ingest',
      clear_source: 'POST /n8n/kb/clear-source',
      sources: 'GET /n8n/kb/sources',
      openai_key: process.env.OPENAI_API_KEY ? 'configured' : 'MISSING',
      embedding_model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
    },
    response_generator: {
      anthropic_key: process.env.ANTHROPIC_API_KEY ? 'configured' : 'MISSING',
      send_primary_path: process.env.GHL_SEND_PRIMARY_PATH || 'webhook',
      send_webhook_url: process.env.GHL_SEND_MESSAGE_WEBHOOK_URL ? 'configured' : 'MISSING',
      send_sms_via_webhook: (process.env.GHL_SEND_SMS_VIA_WEBHOOK || 'true').toLowerCase() !== 'false',
      send_email_via_webhook: (process.env.GHL_SEND_EMAIL_VIA_WEBHOOK || 'true').toLowerCase() !== 'false',
    },
    pause_workflow: {
      sweep: 'POST /n8n/pause-workflow/sweep',
      fizzle_threshold_days: 7,
      interval_minutes: 15,
    },
    approval_escalation: {
      sweep: 'POST /n8n/approval-escalation/sweep',
      escalate_after_min: 30,
      auto_execute_after_min: 60,
      auto_reject_send_message_after_hours: 4,
      interval_minutes: 15,
      kill_switch_env: 'APPROVAL_ESCALATION_DISABLED',
    },
    data_freshness: {
      view: 'GET /n8n/admin/freshness',
      check: 'POST /n8n/admin/freshness-check',
      sync_probe: 'GET /n8n/admin/sync-probe?days=3',
      check_interval_min: parseInt(process.env.FRESHNESS_CHECK_INTERVAL_MIN || '30', 10),
      alert_dedup_hours: parseInt(process.env.FRESHNESS_ALERT_DEDUP_HOURS || '6', 10),
    },
    rest_api: {
      prospect: 'GET /api/prospects/:prospectId',
      lead: 'GET /api/leads/:leadId',
      search: 'GET /api/search?phone|ghlContactId|email|name',
      lead_summary: 'GET /api/lead-summary/:contactId',
    },
    anthropic: process.env.ANTHROPIC_API_KEY ? 'configured' : 'MISSING',
    railway: {
      api_token:  process.env.RAILWAY_API_TOKEN  ? 'set' : 'MISSING',
      service_id: process.env.RAILWAY_SERVICE_ID ? 'set' : 'MISSING',
    },
    github: {
      pat:  process.env.GITHUB_PAT  ? 'set' : 'MISSING',
      repo: process.env.GITHUB_REPO ? 'set' : 'MISSING',
    },
  });
});

// ─── Streamable HTTP transport ───────────────────────────────────
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

// ─── Legacy SSE transport ────────────────────────────────────────
const sseSessions = {};
app.get('/sse', authenticate, async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  const ss = new McpServer({ name: 'lp-mcp-server', version: SERVER_VERSION, description: 'Lead Perfection MCP Server — Reece Windows & Doors Revenue Intelligence' });
  registerAllTools(ss); sseSessions[transport.sessionId] = { transport, server: ss };
  res.on('close', () => { delete sseSessions[transport.sessionId]; }); await ss.connect(transport);
});
app.post('/messages', authenticate, async (req, res) => { const s = sseSessions[req.query.sessionId]; if (!s) return res.status(404).json({ error: 'Session not found' }); await s.transport.handlePostMessage(req, res); });

// ─── Sync endpoints ─────────────────────────────────────────────
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

// ─── n8n APIs (replace all Code nodes) ───────────────────────────
registerN8nEnrichRoute(app);
registerN8nHelperRoutes(app);
registerN8nAvatarRoutes(app);

// ─── Agentic Decision Engine + Action Executor ───────────────────
registerDecisionEngineRoutes(app);
registerActionExecutorRoutes(app);

// ─── Layer 3: Behavioral Intelligence ────────────────────────────
registerContextBuilderRoutes(app);
registerBehavioralEmitterRoutes(app);
registerMessageAnalyzerRoutes(app);

// ─── Layer 3.5: Intent Scoring + Conversion Engine ───────────────
registerIntentScorerRoutes(app);

// ─── Phase 4: KB Vector Ingestion (agentic bot knowledge layer) ──
// POST /n8n/kb/ingest        — ingest text into kb_embeddings
// POST /n8n/kb/clear-source  — soft-delete chunks for a source_doc
// GET  /n8n/kb/sources       — list ingested sources with counts
registerKbIngestionRoutes(app);

// ─── Pause-Workflow Fizzle Sweep (framework: HOT1 / MOMENTUM ACT-5) ───
// Releases pause-workflow tag after 7d of customer silence so paused
// drips resume from where they left off. Pairs with momentum-firing
// rules (BEHAVIORAL_FAST_TRACK, INTENT_SPIKE_HOT_WINDOW,
// AGENTIC_RESPOND_POST_CHATBOT) which add the tag, plus
// GHL_APPT_STAGE_ADVANCE which removes it on booking.
registerPauseWorkflowSweepRoutes(app);

// ─── Approval Escalation Sweep ───────────────────────────────────
// 30min: escalate stuck pending_approval to GroupMe.
// 60min: auto-execute SAFE_ACTION_TYPES at confidence >= 0.95.
// 4h: auto-reject stale send_message (rule will regenerate fresh).
// Kill switch: APPROVAL_ESCALATION_DISABLED=true env var.
registerApprovalEscalationRoutes(app);

// ─── REST API for GHL Agent Studio ───────────────────────────────
registerRestApiRoutes(app, authenticate);

// ─── GroupMe Two-Way Integration ─────────────────────────────────
registerGroupMeRoutes(app);

// ─── LP Appointment Sync (GHL → LP) ────────────────────────────
registerLPAppointmentSyncRoutes(app);

// ─── Workflow Completion (tag-based self-enrichment) ─────────────
registerWorkflowCompletionRoutes(app);

// ─── IME MIC Integration (Sam's Club Construction leads) ─────────
registerImeRoutes(app);

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

// Data freshness monitor — auto-detects stale tables + sync watermark issues.
// Fires GroupMe alerts on stale-data detection (with dedup). Apply sql/015
// before relying on the log/dedup features.
registerDataFreshnessRoutes(app);

app.listen(PORT, async () => {
  console.log(`LP MCP Server v${SERVER_VERSION} running on port ${PORT}`);
  console.log(`n8n APIs:     POST /n8n/enrich-lead | /n8n/refresh-token | /n8n/prospect-lookup | /n8n/time-to-appointment`);
  console.log(`Avatar APIs:  POST /n8n/avatar/score | /parse-gpt | /unified-inputs | /pick-best | /build-ghl | /build-notion`);
  console.log(`Decision:     POST /n8n/decision-engine/process | /execute | GET /status | /execution-stats`);
  console.log(`Layer 3:      POST /webhook/ghl/{reply,appointment,engagement,lead-score,workflow,workflow-tag}`);
  console.log(`Intelligence: GET /n8n/lead-intelligence/context | POST /n8n/analyze-pending-replies | /n8n/analyze-message`);
  console.log(`Intent:       POST /n8n/intent/score | /n8n/intent/sweep | GET /n8n/intent/breakdown`);
  console.log(`KB Ingest:    POST /n8n/kb/ingest | /n8n/kb/clear-source | GET /n8n/kb/sources`);
  console.log(`Pause Sweep:  POST /n8n/pause-workflow/sweep (7d fizzle, 15min interval)`);
  console.log(`Approval Esc: POST /n8n/approval-escalation/sweep (30min/60min/4h tiers, 15min interval)`);
  console.log(`Freshness:    GET /n8n/admin/freshness | POST /n8n/admin/freshness-check | GET /n8n/admin/sync-probe`);
  console.log(`REST API:     GET /api/prospects/:id | /api/leads/:id | /api/search | /api/lead-summary/:contactId`);
  console.log(`GroupMe:      POST /webhook/groupme | POST /groupme/send | GET /groupme/pending`);
  console.log(`LP Sync:      POST /webhook/ghl/set-lp-appointment`);
  console.log(`Admin:        POST /admin/email-backfill | /admin/email-cleanup`);
  console.log(`IME:          POST /ime/dispatch | /ime/work-orders/:id/{refetch,appointment,install,close,cancel,complete}`);
  console.log(`MCP:          http://localhost:${PORT}/mcp`);
  console.log(`Health:       http://localhost:${PORT}/health`);
  await runMigrations();
  initFieldSync();
  startSyncScheduler();
  startImeWorkers();
  startPauseWorkflowSweepScheduler();
  startApprovalEscalationScheduler();
  startDataFreshnessMonitorScheduler();
  setTimeout(() => {
    setTimeout(async () => { try { await runBulkFieldSync(); logCycleStats(); } catch (e) { console.error('[FieldSync]', e.message); } }, 120000);
    setInterval(async () => { try { await runBulkFieldSync(); logCycleStats(); } catch (e) { console.error('[FieldSync]', e.message); } }, FIELD_SYNC_INTERVAL_MS);
  }, 450000);
});
