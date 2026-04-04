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

const PORT = process.env.PORT || 8080;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const FIELD_SYNC_INTERVAL_MS = 15 * 60 * 1000;

const app = express();
app.use(express.json());

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

app.get('/', (req, res) => {
  res.json({ status: 'ok', server: 'lp-mcp-server', version: '5.7.0', port: PORT });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    server: 'lp-mcp-server',
    version: '5.7.0',
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
  const sessionServer = new McpServer({ name: 'lp-mcp-server', version: '5.7.0', description: 'Lead Perfection MCP Server — Reece Windows & Doors Revenue Intelligence' });
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
  const ss = new McpServer({ name: 'lp-mcp-server', version: '5.7.0', description: 'Lead Perfection MCP Server — Reece Windows & Doors Revenue Intelligence' });
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

app.listen(PORT, () => {
  console.log(`LP MCP Server v5.7 running on port ${PORT}`);
  console.log(`n8n APIs:     POST /n8n/enrich-lead | /n8n/refresh-token | /n8n/prospect-lookup | /n8n/time-to-appointment`);
  console.log(`Avatar APIs:  POST /n8n/avatar/score | /parse-gpt | /unified-inputs | /pick-best | /build-ghl | /build-notion`);
  console.log(`MCP:          http://localhost:${PORT}/mcp`);
  console.log(`Health:       http://localhost:${PORT}/health`);
  initFieldSync();
  startSyncScheduler();
  setTimeout(() => {
    setTimeout(async () => { try { await runBulkFieldSync(); logCycleStats(); } catch (e) { console.error('[FieldSync]', e.message); } }, 120000);
    setInterval(async () => { try { await runBulkFieldSync(); logCycleStats(); } catch (e) { console.error('[FieldSync]', e.message); } }, FIELD_SYNC_INTERVAL_MS);
  }, 450000);
});
