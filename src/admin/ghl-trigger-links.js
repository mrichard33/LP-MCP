/**
 * GHL Trigger Links — admin API
 *
 * GoHighLevel "trigger links" are short, trackable URLs that
 * redirect to an external destination. They:
 *   1. fire the "Email Link Clicked" trigger on click (which feeds
 *      our I.ENG engagement webhook), and
 *   2. carry UTMs and per-contact tracking IDs that the raw
 *      destination URL cannot.
 *
 * Naming convention (locked to match the existing library):
 *   - lowercase-hyphenated semantic name
 *   - no UUIDs, no dates, no version suffixes
 *   - examples: book, calculator, guide-download, mv-confirmation
 *
 * GHL API reference: GET/POST /links with locationId in body/query.
 * Auth: same Bearer GHL_API_KEY + Version 2021-07-28 as src/ghl.js.
 */

import axios from 'axios';

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

const client = GHL_API_KEY ? axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: {
    Authorization: `Bearer ${GHL_API_KEY}`,
    Version: '2021-07-28',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
  timeout: 15000,
}) : null;

function ensureReady(res) {
  if (!client) {
    res.status(500).json({ ok: false, error: 'GHL_API_KEY not configured' });
    return false;
  }
  if (!GHL_LOCATION_ID) {
    res.status(500).json({ ok: false, error: 'GHL_LOCATION_ID not configured' });
    return false;
  }
  return true;
}

function shapeError(err) {
  const status = err.response?.status || 0;
  const body = err.response?.data || err.message;
  return { status, body };
}

async function fetchExistingLink(id) {
  const { data } = await client.get('/links/', {
    params: { locationId: GHL_LOCATION_ID },
  });
  const links = Array.isArray(data?.links) ? data.links : (Array.isArray(data) ? data : []);
  return links.find(l => l.id === id) || null;
}

export function registerGhlTriggerLinkRoutes(app) {

  // ───────────────────────────────────────────────────────────────
  // GET /admin/ghl-links — list all trigger links for the location
  // ───────────────────────────────────────────────────────────────
  app.get('/admin/ghl-links', async (req, res) => {
    if (!ensureReady(res)) return;
    try {
      const { data } = await client.get('/links/', {
        params: { locationId: GHL_LOCATION_ID },
      });
      const links = Array.isArray(data?.links) ? data.links : (Array.isArray(data) ? data : []);
      res.json({
        ok: true,
        count: links.length,
        links: links.map(l => ({
          id: l.id,
          name: l.name,
          redirectTo: l.redirectTo,
          fieldKey: l.fieldKey,           // {{trigger_link.<key>}} merge tag
          locationId: l.locationId,
        })),
      });
    } catch (err) {
      const e = shapeError(err);
      console.error(`[GHL Links] list failed: HTTP ${e.status}`, JSON.stringify(e.body).slice(0, 300));
      res.status(502).json({ ok: false, error: 'ghl_list_failed', status: e.status, body: e.body });
    }
  });

  // ───────────────────────────────────────────────────────────────
  // POST /admin/ghl-links — create a new trigger link
  // Body: { name: string, redirectTo: string }
  // ───────────────────────────────────────────────────────────────
  app.post('/admin/ghl-links', async (req, res) => {
    if (!ensureReady(res)) return;
    const { name, redirectTo } = req.body || {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ ok: false, error: 'name required (string)' });
    }
    if (!redirectTo || typeof redirectTo !== 'string') {
      return res.status(400).json({ ok: false, error: 'redirectTo required (string URL)' });
    }
    try {
      const { data } = await client.post('/links/', {
        name,
        redirectTo,
        locationId: GHL_LOCATION_ID,
      });
      const link = data?.link || data;
      console.log(`[GHL Links] Created "${name}" → ${redirectTo} (id=${link?.id})`);
      res.json({
        ok: true,
        link: {
          id: link?.id,
          name: link?.name,
          redirectTo: link?.redirectTo,
          fieldKey: link?.fieldKey,
          locationId: link?.locationId,
        },
      });
    } catch (err) {
      const e = shapeError(err);
      console.error(`[GHL Links] create failed: HTTP ${e.status}`, JSON.stringify(e.body).slice(0, 300));
      res.status(502).json({ ok: false, error: 'ghl_create_failed', status: e.status, body: e.body });
    }
  });

  // ───────────────────────────────────────────────────────────────
  // GET /admin/ghl-links/:id — get a single trigger link
  // ───────────────────────────────────────────────────────────────
  app.get('/admin/ghl-links/:id', async (req, res) => {
    if (!ensureReady(res)) return;
    try {
      const match = await fetchExistingLink(req.params.id);
      if (!match) return res.status(404).json({ ok: false, error: 'not_found' });
      res.json({ ok: true, link: match });
    } catch (err) {
      const e = shapeError(err);
      res.status(502).json({ ok: false, error: 'ghl_get_failed', status: e.status, body: e.body });
    }
  });

  // ───────────────────────────────────────────────────────────────
  // PUT /admin/ghl-links/:id — update redirectTo / name
  //
  // GHL PUT /links/:id requires:
  //   - `name` to always be present (even on partial update)
  //   - `locationId` to NOT be present (422 if included)
  // If caller omits `name`, we fetch the existing record to preserve it.
  // ───────────────────────────────────────────────────────────────
  app.put('/admin/ghl-links/:id', async (req, res) => {
    if (!ensureReady(res)) return;

    const wantName = req.body?.name;
    const wantRedirect = req.body?.redirectTo;

    if (!wantName && !wantRedirect) {
      return res.status(400).json({ ok: false, error: 'nothing to update' });
    }

    try {
      // Always need to know existing record to preserve `name`
      // when caller is only updating redirectTo.
      let resolvedName = wantName;
      let resolvedRedirect = wantRedirect;

      if (!resolvedName || !resolvedRedirect) {
        const existing = await fetchExistingLink(req.params.id);
        if (!existing) return res.status(404).json({ ok: false, error: 'not_found' });
        resolvedName = resolvedName || existing.name;
        resolvedRedirect = resolvedRedirect || existing.redirectTo;
      }

      const { data } = await client.put(`/links/${req.params.id}`, {
        name: resolvedName,
        redirectTo: resolvedRedirect,
      });
      console.log(`[GHL Links] Updated id=${req.params.id} → ${resolvedRedirect}`);
      res.json({ ok: true, link: data?.link || data });
    } catch (err) {
      const e = shapeError(err);
      console.error(`[GHL Links] update failed: HTTP ${e.status}`, JSON.stringify(e.body).slice(0, 300));
      res.status(502).json({ ok: false, error: 'ghl_update_failed', status: e.status, body: e.body });
    }
  });

  // ───────────────────────────────────────────────────────────────
  // DELETE /admin/ghl-links/:id — delete
  // ───────────────────────────────────────────────────────────────
  app.delete('/admin/ghl-links/:id', async (req, res) => {
    if (!ensureReady(res)) return;
    try {
      await client.delete(`/links/${req.params.id}`, {
        params: { locationId: GHL_LOCATION_ID },
      });
      res.json({ ok: true, deleted: req.params.id });
    } catch (err) {
      const e = shapeError(err);
      res.status(502).json({ ok: false, error: 'ghl_delete_failed', status: e.status, body: e.body });
    }
  });

  console.log('[GHL Links] Registered: GET|POST /admin/ghl-links | GET|PUT|DELETE /admin/ghl-links/:id');
}
