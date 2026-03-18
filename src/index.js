import 'dotenv/config';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { registerAllTools } from './tools/index.js';

const PORT = process.env.PORT || 3000;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

// Create MCP server
const server = new McpServer({
  name: 'lp-mcp-server',
  version: '3.0.0',
  description: 'Lead Perfection MCP Server — Reece Windows & Doors Revenue Intelligence',
});

// Register all 16 tool functions
registerAllTools(server);

// Express app for SSE transport
const app = express();

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
    version: '3.0.0',
    uptime: process.uptime(),
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

app.listen(PORT, () => {
  console.log(`LP MCP Server v3.0 running on port ${PORT}`);
  console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
