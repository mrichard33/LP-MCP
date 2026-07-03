/**
 * Internal Routes — src/services/internal-routes.js
 *
 * Endpoints intended for in-cluster callers (HL MCP advisory checks, etc.).
 * Bearer-protected if MCP_AUTH_TOKEN is configured; otherwise open within
 * the trust boundary of the deployment.
 */

import { checkLock } from './outbound-locks.js';
import { checkAgenticSlot } from './agentic-reply-locks.js';

function guard(req, res) {
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token) return true;
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${token}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

export function registerInternalRoutes(app) {
  app.post('/internal/check-outbound-lock', async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const { contact_id, trigger_id } = req.body || {};
      if (!contact_id || !trigger_id) {
        return res.status(400).json({ error: 'contact_id and trigger_id required' });
      }
      // 2026-07-03 — the response now also carries the ENFORCING per-contact
      // agentic slot (single-flight + cooldown), so external callers (HL MCP)
      // see the same gate the executor enforces. `held` is true when either
      // layer would block a send.
      const [result, agentic] = await Promise.all([
        checkLock(contact_id, trigger_id),
        checkAgenticSlot(contact_id),
      ]);
      res.json({
        ...result,
        held: !!(result.held || agentic.held),
        trigger_lock: { held: !!result.held },
        agentic_slot: agentic,
      });
    } catch (err) {
      console.error('[internal-routes] check-outbound-lock error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}
