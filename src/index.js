import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerAllTools } from './tools/index.js';
import { startSyncScheduler, fullSync, incrementalSync, handleWebhookEvent } from './sync-engine.js';
import { testConnection } from './lp-client.js';
import { getTokenStatus } from './token-manager.js';
import supabase from './supabase.js';

const PORT = process.env.PORT || 3000;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

// Create MCP server
const server = new McpServer({
  name: 'lp-mcp-server',
  version: '5.0.0',
  description: 'Lead Perfection MCP Server — Reece Windows & Doors Revenue Intelligence',
});

// Register all 16 tool functions
registerAllTools(server);

// Express app for SSE transport
const app = express();
app.use(express.json());

// Auth middleware
function authenticate(req, res, next) {
  if (!MCP_AUTH_TOKEN) return next(); // Skip if no token configured
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${MCP_AUTH_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Health check — shows config status for all required env vars
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    server: 'lp-mcp-server',
    version: '5.0.0',
    uptime: process.uptime(),
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
  });
});

// ─── Streamable HTTP transport (Claude.ai remote MCP) ───────────
// Claude.ai connects via POST /mcp with Streamable HTTP protocol.
// Each session gets its own transport+server instance.

const streamableSessions = {};

async function getOrCreateStreamableSession(sessionId) {
  if (sessionId && streamableSessions[sessionId]) {
    return streamableSessions[sessionId].transport;
  }

  // New session — create transport + connect a fresh MCP server instance
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  const sessionServer = new McpServer({
    name: 'lp-mcp-server',
    version: '5.0.0',
    description: 'Lead Perfection MCP Server — Reece Windows & Doors Revenue Intelligence',
  });
  registerAllTools(sessionServer);
  await sessionServer.connect(transport);

  const newId = transport.sessionId;
  if (newId) {
    streamableSessions[newId] = { transport, server: sessionServer };
    transport.onclose = () => delete streamableSessions[newId];
  }

  return transport;
}

app.post('/mcp', authenticate, async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    const transport = await getOrCreateStreamableSession(sessionId);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[MCP] Streamable HTTP error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/mcp', authenticate, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && streamableSessions[sessionId]) {
    await streamableSessions[sessionId].transport.handleRequest(req, res);
  } else {
    res.status(400).json({ error: 'Missing or invalid session' });
  }
});

app.delete('/mcp', authenticate, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && streamableSessions[sessionId]) {
    await streamableSessions[sessionId].transport.handleRequest(req, res);
    delete streamableSessions[sessionId];
  } else {
    res.status(400).json({ error: 'Missing or invalid session' });
  }
});

// ─── Legacy SSE transport (Claude Desktop, Cursor, etc) ─────────
const transports = {};

app.get('/sse', authenticate, async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  transports[transport.sessionId] = transport;

  res.on('close', () => {
    delete transports[transport.sessionId];
  });

  await server.connect(transport);
});

app.post('/messages', authenticate, async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) {
    return res.status(404).json({ error: 'Session not found' });
  }
  await transport.handlePostMessage(req, res);
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

// GET /sync/status — last 5 sync records
app.get('/sync/status', authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('lp_sync_log')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(5);

    if (error) {
      return res.status(500).json({ error: error.message });
    }
    res.json(data);
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
  console.log(`LP MCP Server v5.0 running on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp (Streamable HTTP — Claude.ai)`);
  console.log(`SSE endpoint: http://localhost:${PORT}/sse (legacy — Claude Desktop)`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`LP API test:  http://localhost:${PORT}/lp/test`);
  console.log(`Webhook:      http://localhost:${PORT}/webhook/lp`);

  // Start the sync scheduler — pre-warms token, auto-detects first run vs incremental
  startSyncScheduler();
});
