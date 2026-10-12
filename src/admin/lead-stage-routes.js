// ─── GET /admin/lead-stage/:contactId — src/admin/lead-stage-routes.js ──────
//
// 2026-10-12 (Lead Conversation Stage): where a lead's conversation stands,
// for a person. Returns the stored stage, its GHL label, the facts, the last
// 50 changes and the live NEPQ Stage dropdown (its field id, its options, and
// any label we write that the dropdown lacks). Read only.
//
// Auth is the /admin/bot-simulate pattern: x-admin-token against
// ADMIN_API_TOKEN, staged by AUTH_ENFORCE_MODE (src/security/request-auth.js).

import { checkRequestSecret } from '../security/request-auth.js';
import { readStageReport } from '../services/lead-stage-io.js';

const CONTACT_ID_RX = /^[A-Za-z0-9_-]{6,64}$/;

export function registerLeadStageRoutes(app, { readReport = readStageReport } = {}) {
  app.get('/admin/lead-stage/:contactId', async (req, res) => {
    const d = checkRequestSecret(req, { route: req.path || 'admin-lead-stage', secret: process.env.ADMIN_API_TOKEN, headers: ['x-admin-token'] });
    if (!d.allow) {
      return res.status(d.status).json(d.status === 503 ? { error: 'ADMIN_API_TOKEN is not set; this endpoint is closed' } : { error: 'x-admin-token required' });
    }
    const contactId = String(req.params.contactId || '');
    if (!CONTACT_ID_RX.test(contactId)) return res.status(400).json({ error: 'bad contact id' });
    try {
      return res.json(await readReport(contactId));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
}
