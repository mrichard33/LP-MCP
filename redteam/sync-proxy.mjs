/**
 * Local sync wrapper for Garak's REST generator: POST {"text": "..."} on
 * localhost:8787 → runs one simulator turn → {"text": "<bot reply>"}.
 * Uses the same env as provider.mjs (LP_MCP_URL, ADMIN_API_TOKEN, RT_CHANNEL).
 * Binds to 127.0.0.1 only.
 */
import http from 'node:http';
import Provider from './provider.mjs';

const bot = new Provider();
http.createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  let body = '';
  for await (const chunk of req) body += chunk;
  let text = '';
  try { text = JSON.parse(body).text ?? ''; } catch { res.writeHead(400).end(); return; }
  const r = await bot.callApi(String(text)).catch((e) => ({ error: e.message }));
  res.writeHead(r.error ? 502 : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(r.error ? { error: r.error } : { text: r.output }));
}).listen(8787, '127.0.0.1', () => console.log('red-team sync proxy on http://127.0.0.1:8787'));
