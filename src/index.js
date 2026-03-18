import 'dotenv/config';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { registerAllTools } from './tools/index.js';
import { startSyncScheduler, fullSync, incrementalSync, handleWebhookEvent } from './sync-engine.js';
import { testConnection } from './lp-client.js';
import supabase from './supabase.js';

const PORT = process.env.PORT || 3000;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

// Create MCP server
const server = new McpServer({
  name: 'lp-mcp-server',
  version: '4.0.0',
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

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    server: 'lp-mcp-server',
    version: '4.1.0',
    uptime: process.uptime(),
    lp_config: {
      server_id: process.env.LP_SERVER_ID ? 'set' : 'MISSING',
      client_id: process.env.LP_CLIENT_ID ? 'set' : 'MISSING',
      username: process.env.LP_USERNAME ? 'set' : 'MISSING',
      password: process.env.LP_PASSWORD ? 'set' : 'MISSING',
      app_key: process.env.LP_APP_KEY ? 'set' : 'MISSING',
    },
    supabase: process.env.SUPABASE_URL ? 'configured' : 'MISSING',
    ghl: process.env.GHL_API_KEY ? 'configured' : 'MISSING',
  });
});

// SSE transport for MCP
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

// ─── Manual sync endpoints (fire-and-forget per v4 spec) ─────────

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

// ─── Webhook endpoint for LP (if LP supports outbound webhooks) ──

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
  console.log(`LP MCP Server v4.1 running on port ${PORT}`);
  console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Webhook:      http://localhost:${PORT}/webhook/lp`);

  // Start the sync scheduler — auto-detects first run vs incremental
  startSyncScheduler();
});
