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

const PORT = process.env.PORT || 8080;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const FIELD_SYNC_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes, offset from LP sync

// Express app — all MCP sessions create per-session server instances
const app = express();
app.use(express.json());

// CORS — required for browser-based MCP clients (Claude.ai)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Auth middleware
function authenticate(req, res, next) {
  if (!MCP_AUTH_TOKEN) return next(); // Skip if no token configured
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${MCP_AUTH_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Root — quick status for browser checks
app.get('/', (req, res) => {
  res.json({ status: 'ok', server: 'lp-mcp-server', version: '5.4.0', port: PORT });
});

// Health check — shows config status for all required env vars
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    server: 'lp-mcp-server',
    version: '5.4.0',
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

// ─── Streamable HTTP transport (Claude.ai remote MCP) ───────────
// Claude.ai connects via POST /mcp with Streamable HTTP protocol.
// Each session gets its own transport+server instance.
//
// SESSION RECOVERY (v5.4 — fixed):
// When Railway redeploys, all in-memory sessions are lost. Claude.ai
// sends requests with the old mcp-session-id. Per MCP spec, we return
// HTTP 404 for unknown sessions, which signals the client to start a
// fresh initialize handshake automatically. No manual reconnect needed.
//
// Previous approach (v5.3) tried to auto-create sessions for non-initialize
// requests, but the MCP SDK rejects non-initialize on fresh transports.

const streamableSessions = {};

function isInitializeRequest(body) {
  if (Array.isArray(body)) {
    return body.some(msg => msg.method === 'initialize');
  }
  return body?.method === 'initialize';
}

/**
 * Create a new MCP session (transport + server with all tools registered).
 */
function createMCPSession() {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  const sessionServer = new McpServer({
    name: 'lp-mcp-server',
    version: '5.4.0',
    description: 'Lead Perfection MCP Server — Reece Windows & Doors Revenue Intelligence',
  });

  registerAllTools(sessionServer);
  return { transport, server: sessionServer };
}

/**
 * Register a session in the sessions map with cleanup handler.
 */
function registerSession(sessionId, transport, server) {
  if (!sessionId) return;
  streamableSessions[sessionId] = { transport, server };
  console.log(`[MCP] Session registered: ${sessionId}`);
  transport.onclose = () => {
    delete streamableSessions[sessionId];
    console.log(`[MCP] Session closed: ${sessionId}`);
  };
}

app.post('/mcp', authenticate, async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];

    // ── Known session — route to its transport
    if (sessionId && streamableSessions[sessionId]) {
      await streamableSessions[sessionId].transport.handleRequest(req, res, req.body);
      return;
    }

    // ── Initialize request — create new session (normal path)
    if (isInitializeRequest(req.body)) {
      const { transport, server } = createMCPSession();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);

      const newId = transport.sessionId;
      registerSession(newId, transport, server);
      return;
    }

    // ── Unknown session + NOT initialize = session lost after redeploy
    // Return 404 per MCP spec — this signals the client to start a fresh
    // initialize handshake. The client will automatically reconnect.
    if (sessionId) {
      console.log(`[MCP] Session recovery: unknown session ${sessionId.slice(0, 8)}... — returning 404 to trigger client re-initialize`);
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found. Server was redeployed. Please reinitialize.' },
        id: null,
      });
      return;
    }

    // ── No session ID at all and not initialize — reject
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Bad Request: No valid session. Send an initialize request first.' },
      id: null,
    });
  } catch (err) {
    console.error('[MCP] Streamable HTTP error:', err.stack);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/mcp', authenticate, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && streamableSessions[sessionId]) {
    await streamableSessions[sessionId].transport.handleRequest(req, res);
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

app.delete('/mcp', authenticate, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && streamableSessions[sessionId]) {
    await streamableSessions[sessionId].transport.handleRequest(req, res);
    delete streamableSessions[sessionId];
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// ─── Legacy SSE transport (Claude Desktop, Cursor, etc) ─────────
// Per-session servers — same isolation pattern as Streamable HTTP
const sseSessions = {};

app.get('/sse', authenticate, async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  const sessionServer = new McpServer({
    name: 'lp-mcp-server',
    version: '5.4.0',
    description: 'Lead Perfection MCP Server — Reece Windows & Doors Revenue Intelligence',
  });
  registerAllTools(sessionServer);
  sseSessions[transport.sessionId] = { transport, server: sessionServer };
  console.log(`[MCP] New SSE session: ${transport.sessionId}`);

  res.on('close', () => {
    delete sseSessions[transport.sessionId];
    console.log(`[MCP] SSE session closed: ${transport.sessionId}`);
  });

  await sessionServer.connect(transport);
});

app.post('/messages', authenticate, async (req, res) => {
  const sessionId = req.query.sessionId;
  const session = sseSessions[sessionId];
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  await session.transport.handlePostMessage(req, res);
});

// ─── Manual sync endpoints ───────────────────────────────────────

app.post('/sync/full', authenticate, async (req, res) => {
  res.json({ status: 'started', type: 'full' });
  fullSync().catch(err => console.error('[Sync] Manual full sync failed:', err.message));
});

app.post('/sync/incremental', authenticate, async (req, res) => {
  res.json({ status: 'started', type: 'incremental' });
  incrementalSync().catch(err => console.error('[Sync] Manual incremental sync failed:', err.message));
});

// POST /sync/fields — manually trigger GHL field writeback
app.post('/sync/fields', authenticate, async (req, res) => {
  res.json({ status: 'started', type: 'field_sync' });
  runBulkFieldSync().catch(err => console.error('[FieldSync] Manual field sync failed:', err.message));
});

// POST /sync/reconcile — compare LP count vs Supabase count [v5.1]
app.post('/sync/reconcile', authenticate, async (req, res) => {
  try {
    const { startdate = '2020-01-01', enddate } = req.body || {};
    const end = enddate || new Date().toISOString().slice(0, 10);
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // Count leads in LP (page through to get total)
    let lpCount = 0;
    let idx = 1;
    while (true) {
      const r = await getLeads({
        startdate,
        enddate: end,
        PageSize: 200,
        StartIndex: idx,
      });
      const items = Array.isArray(r) ? r : (r?.data || r?.leads || r?.results || []);
      if (!items || items.length === 0) break;
      lpCount += items.length;
      idx += items.length;
      await sleep(300);
    }

    // Count leads in Supabase
    const { count: sbCount } = await supabase.from('lp_leads')
      .select('id', { count: 'exact', head: true })
      .gte('created_at_lp', startdate)
      .lte('created_at_lp', end);

    const drift = Math.abs(lpCount - (sbCount || 0));
    const driftPct = lpCount > 0 ? ((drift / lpCount) * 100).toFixed(2) : '0';

    const result = {
      lp_count: lpCount,
      supabase_count: sbCount || 0,
      drift,
      drift_percent: driftPct,
      status: drift === 0 ? 'synced' : 'drift_detected',
      date_range: { startdate, enddate: end },
    };

    console.log(`[Reconcile] LP: ${lpCount}, SB: ${sbCount}, Drift: ${drift} (${driftPct}%)`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /sync/status — last 5 sync records + health metrics [v5.1 enhanced]
app.get('/sync/status', authenticate, async (req, res) => {
  try {
    const [syncLog, totalLeads, unmatchedLeads, unresolvedErrors] = await Promise.all([
      supabase.from('lp_sync_log').select('*').order('started_at', { ascending: false }).limit(5),
      supabase.from('lp_leads').select('id', { count: 'exact', head: true }),
      supabase.from('lp_leads').select('id', { count: 'exact', head: true }).is('ghl_contact_id', null),
      supabase.from('lp_sync_errors').select('id', { count: 'exact', head: true }).eq('resolved', false),
    ]);

    if (syncLog.error) {
      return res.status(500).json({ error: syncLog.error.message });
    }

    res.json({
      recent_syncs: syncLog.data,
      total_leads: totalLeads.count || 0,
      unmatched_leads: unmatchedLeads.count || 0,
      unresolved_errors: unresolvedErrors.count || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LP API connection diagnostic ────────────────────────────────

app.get('/lp/test', authenticate, async (req, res) => {
  try {
    const status = await testConnection();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Webhook endpoint for LP ─────────────────────────────────────

app.post('/webhook/lp', async (req, res) => {
  // Validate webhook secret if configured
  const webhookSecret = process.env.N8N_WEBHOOK_SECRET;
  if (webhookSecret) {
    const provided = req.headers['x-webhook-secret'] || req.query.secret;
    if (provided !== webhookSecret) {
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }
  }

  const event = req.body.event || req.headers['x-lp-event'] || 'lead.updated';
  const payload = req.body.data || req.body;

  console.log(`[Webhook] Received event: ${event}`);

  // Respond immediately — process async
  res.json({ status: 'accepted', event });

  handleWebhookEvent(event, payload).catch(err =>
    console.error(`[Webhook] Processing failed for ${event}:`, err.message)
  );
});

app.listen(PORT, () => {
  console.log(`LP MCP Server v5.4 running on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp (Streamable HTTP — Claude.ai)`);
  console.log(`SSE endpoint: http://localhost:${PORT}/sse (legacy — Claude Desktop)`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`LP API test:  http://localhost:${PORT}/lp/test`);
  console.log(`Webhook:      http://localhost:${PORT}/webhook/lp`);
  console.log(`Field sync:   POST http://localhost:${PORT}/sync/fields (manual trigger)`);

  // Initialize GHL field sync system
  initFieldSync();

  // Start the LP sync scheduler — pre-warms token, auto-detects first run vs incremental
  startSyncScheduler();

  // ─── GHL Field Sync Scheduler ──────────────────────────────────
  // Runs every 15 minutes, offset by 7.5 min from LP sync to avoid overlap.
  setTimeout(() => {
    console.log('[FieldSync] Scheduler started — field sync every 15 minutes');

    // Run initial field sync 2 minutes after boot (let LP sync populate data first)
    setTimeout(async () => {
      try {
        await runBulkFieldSync();
        logCycleStats();
      } catch (err) {
        console.error('[FieldSync] Initial field sync failed:', err.message);
      }
    }, 120000); // 2 minutes after boot

    // Schedule periodic field syncs
    setInterval(async () => {
      try {
        await runBulkFieldSync();
        logCycleStats();
      } catch (err) {
        console.error('[FieldSync] Scheduled field sync failed:', err.message);
      }
    }, FIELD_SYNC_INTERVAL_MS);
  }, 450000); // Start scheduler 7.5 min after boot (offset from LP sync)
});
