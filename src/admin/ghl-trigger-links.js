/**
 * GHL Trigger Links — admin HTTP routes
 *
 * Thin wrapper around src/admin/ghl-trigger-link-client.js. Same routes
 * as before plus a new POST /admin/ghl-links/seed-s4-5 for bulk-creating
 * S4.5 nurture trigger links idempotently.
 *
 * GoHighLevel "trigger links" are short, trackable URLs that:
 *   1. fire the "Email Link Clicked" trigger on click (which feeds
 *      our I.ENG engagement webhook), and
 *   2. carry UTMs and per-contact tracking IDs via {{contact.*}}
 *      merge tags that GHL substitutes at click-time.
 *
 * Naming convention (locked to match the existing library):
 *   - lowercase-hyphenated or "Category — Identifier" pattern
 *   - no UUIDs, no dates, no version suffixes
 *   - examples: book, calculator, "S4.5 Booking — WK2 Epiphany SA3"
 */

import {
  isReady,
  readinessError,
  listLinks,
  findLinkById,
  createLink,
  updateLink,
  deleteLink,
  seedS45Links,
} from './ghl-trigger-link-client.js';

function ensureReady(res) {
  if (!isReady()) {
    res.status(500).json({ ok: false, error: readinessError() });
    return false;
  }
  return true;
}

export function registerGhlTriggerLinkRoutes(app) {

  // ───────────────────────────────────────────────────────────────
  // GET /admin/ghl-links — list all trigger links for the location
  // ───────────────────────────────────────────────────────────────
  app.get('/admin/ghl-links', async (req, res) => {
    if (!ensureReady(res)) return;
    try {
      const links = await listLinks();
      res.json({ ok: true, count: links.length, links });
    } catch (err) {
      console.error(`[GHL Links] list failed: ${err.message}`);
      res.status(502).json({ ok: false, error: 'ghl_list_failed', message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────
  // POST /admin/ghl-links — create a new trigger link
  // Body: { name: string, redirectTo: string }
  // ───────────────────────────────────────────────────────────────
  app.post('/admin/ghl-links', async (req, res) => {
    if (!ensureReady(res)) return;
    const { name, redirectTo } = req.body || {};
    try {
      const link = await createLink({ name, redirectTo });
      console.log(`[GHL Links] Created "${name}" → ${redirectTo} (id=${link?.id})`);
      res.json({ ok: true, link });
    } catch (err) {
      console.error(`[GHL Links] create failed: ${err.message}`);
      res.status(err.message?.includes('required') ? 400 : 502).json({
        ok: false,
        error: 'ghl_create_failed',
        message: err.message,
      });
    }
  });

  // ───────────────────────────────────────────────────────────────
  // POST /admin/ghl-links/seed-s4-5 — bulk-create S4.5 trigger links
  //
  // Idempotent. Creates/updates the 8 S4.5 nurture trigger links and
  // writes trigger_link_id + trigger_link_field_key back into the
  // agentic_messaging_prompts table by prompt_code. Safe to run
  // repeatedly — uses list-then-match-by-name semantics.
  //
  // Usage:
  //   curl -X POST https://lp-mcp-production.up.railway.app/admin/ghl-links/seed-s4-5
  //
  // Optional preview mode:
  //   curl -X POST .../admin/ghl-links/seed-s4-5 -d '{"preview":true}'
  //   → returns the spec list without making any GHL or DB changes.
  // ───────────────────────────────────────────────────────────────
  app.post('/admin/ghl-links/seed-s4-5', async (req, res) => {
    if (!ensureReady(res)) return;
    if (req.body?.preview === true) {
      // Lazy import to avoid circular-init issues — we already imported
      // seedS45Links above, but the spec constant lives in the same module
      // and we want a preview path that doesn't run the full reconcile.
      const { S45_LINK_SPECS } = await import('./ghl-trigger-link-client.js');
      return res.json({ ok: true, preview: true, specs: S45_LINK_SPECS });
    }
    try {
      const result = await seedS45Links();
      console.log(`[GHL Links] Seed S4.5: created=${result.summary?.created || 0} updated=${result.summary?.updated || 0} unchanged=${result.summary?.unchanged || 0}`);
      res.json(result);
    } catch (err) {
      console.error(`[GHL Links] seed-s4-5 failed: ${err.message}`);
      res.status(502).json({ ok: false, error: 'seed_failed', message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────
  // GET /admin/ghl-links/:id — get a single trigger link
  // ───────────────────────────────────────────────────────────────
  app.get('/admin/ghl-links/:id', async (req, res) => {
    if (!ensureReady(res)) return;
    try {
      const link = await findLinkById(req.params.id);
      if (!link) return res.status(404).json({ ok: false, error: 'not_found' });
      res.json({ ok: true, link });
    } catch (err) {
      res.status(502).json({ ok: false, error: 'ghl_get_failed', message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────
  // PUT /admin/ghl-links/:id — update name and/or redirectTo
  // ───────────────────────────────────────────────────────────────
  app.put('/admin/ghl-links/:id', async (req, res) => {
    if (!ensureReady(res)) return;
    const { name, redirectTo } = req.body || {};
    if (!name && !redirectTo) {
      return res.status(400).json({ ok: false, error: 'nothing to update' });
    }
    try {
      const link = await updateLink(req.params.id, { name, redirectTo });
      console.log(`[GHL Links] Updated id=${req.params.id} → ${redirectTo || '(name only)'}`);
      res.json({ ok: true, link });
    } catch (err) {
      const status = err.message === 'not_found' ? 404 : 502;
      res.status(status).json({ ok: false, error: 'ghl_update_failed', message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────
  // DELETE /admin/ghl-links/:id — delete
  // ───────────────────────────────────────────────────────────────
  app.delete('/admin/ghl-links/:id', async (req, res) => {
    if (!ensureReady(res)) return;
    try {
      const result = await deleteLink(req.params.id);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(502).json({ ok: false, error: 'ghl_delete_failed', message: err.message });
    }
  });

  console.log('[GHL Links] Registered: GET|POST /admin/ghl-links | GET|PUT|DELETE /admin/ghl-links/:id | POST /admin/ghl-links/seed-s4-5');
}
