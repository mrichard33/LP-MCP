/**
 * LLM Gateway — src/llm-gateway.js
 *
 * HTTP surface over the env-controlled LLM client (llm-client.js) so other
 * services (n8n workflows; HL MCP if it ever needs an LLM) get the SAME
 * provider/model control without their own client. Provider/model for each
 * `fn` are resolved on THIS service by llm-client's per-function / per-group /
 * global tiers — one env surface for everything.
 *
 * Auth: x-internal-token header (or Bearer) must match HL_INTERNAL_TOKEN or
 * MCP_AUTH_TOKEN. Unauthenticated callers are rejected — this endpoint spends
 * money and must not be open.
 *
 * Routes:
 *   POST /n8n/llm/complete       body { fn, system?, user?, messages?, maxTokens?, temperature?, json? }
 *                                -> { text, provider, model, usage }
 *   POST /n8n/llm/complete-json  same body; parses JSON -> { data, text, provider, model, usage }
 *   GET  /n8n/llm/resolve?fn=... -> { fn, group, provider, model } (debug; no LLM call, no spend)
 */

import { callLLM, callLLMJson, resolveLLM } from './llm-client.js';

const INTERNAL_TOKENS = [process.env.HL_INTERNAL_TOKEN, process.env.MCP_AUTH_TOKEN].filter(Boolean);

function authed(req) {
  const headerTok = req.get('x-internal-token');
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const tok = headerTok || bearer;
  return INTERNAL_TOKENS.length > 0 && tok && INTERNAL_TOKENS.includes(tok);
}

export function registerLlmGatewayRoutes(app) {
  app.get('/n8n/llm/resolve', (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
    const fn = req.query.fn;
    if (!fn) return res.status(400).json({ error: 'fn query param required' });
    return res.json(resolveLLM(fn));
  });

  app.post('/n8n/llm/complete', async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
    const { fn } = req.body || {};
    if (!fn) return res.status(400).json({ error: 'fn required' });
    try {
      const { text, provider, model, usage } = await callLLM(req.body);
      return res.json({ text, provider, model, usage });
    } catch (err) {
      console.error(`[LLMGateway] complete failed for fn=${fn}: ${err.message}`);
      return res.status(502).json({ error: err.message, fn });
    }
  });

  app.post('/n8n/llm/complete-json', async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
    const { fn } = req.body || {};
    if (!fn) return res.status(400).json({ error: 'fn required' });
    try {
      const { data, text, provider, model, usage } = await callLLMJson(req.body);
      return res.json({ data, text, provider, model, usage });
    } catch (err) {
      console.error(`[LLMGateway] complete-json failed for fn=${fn}: ${err.message}`);
      return res.status(502).json({ error: err.message, fn });
    }
  });
}

export default { registerLlmGatewayRoutes };
