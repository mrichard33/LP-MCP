/**
 * GHL Trigger Link Client — pure functions wrapping the GHL /links/ API.
 *
 * Used by:
 *   - src/admin/ghl-trigger-links.js (HTTP admin routes)
 *   - src/tools/admin/ghl-trigger-link-tools.js (MCP tools)
 *   - seedS45Links() for one-shot bulk creation of S4.5 nurture links
 *
 * GHL API reference: GET/POST/PUT/DELETE /links with locationId in body/query.
 * Auth: same Bearer GHL_API_KEY + Version 2021-07-28 as src/ghl.js.
 */

import axios from 'axios';
import supabase from '../supabase.js';

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

export function isReady() {
  return !!(client && GHL_LOCATION_ID);
}

export function readinessError() {
  if (!client) return 'GHL_API_KEY not configured';
  if (!GHL_LOCATION_ID) return 'GHL_LOCATION_ID not configured';
  return null;
}

function shapeError(err) {
  const status = err.response?.status || 0;
  const body = err.response?.data || err.message;
  return { status, body };
}

/**
 * List all trigger links for the configured location.
 * Returns { id, name, redirectTo, fieldKey, locationId }[].
 */
export async function listLinks() {
  const { data } = await client.get('/links/', {
    params: { locationId: GHL_LOCATION_ID },
  });
  const links = Array.isArray(data?.links) ? data.links : (Array.isArray(data) ? data : []);
  return links.map(l => ({
    id: l.id,
    name: l.name,
    redirectTo: l.redirectTo,
    fieldKey: l.fieldKey,
    locationId: l.locationId,
  }));
}

/** Find a link by exact name (case-sensitive). Returns null if not found. */
export async function findLinkByName(name) {
  const all = await listLinks();
  return all.find(l => l.name === name) || null;
}

/** Find a link by id. Returns null if not found. */
export async function findLinkById(id) {
  const all = await listLinks();
  return all.find(l => l.id === id) || null;
}

/** Create a new trigger link. */
export async function createLink({ name, redirectTo }) {
  if (!name || typeof name !== 'string') throw new Error('name required (string)');
  if (!redirectTo || typeof redirectTo !== 'string') throw new Error('redirectTo required (string URL)');

  const { data } = await client.post('/links/', {
    name,
    redirectTo,
    locationId: GHL_LOCATION_ID,
  });
  const link = data?.link || data;
  return {
    id: link?.id,
    name: link?.name,
    redirectTo: link?.redirectTo,
    fieldKey: link?.fieldKey,
    locationId: link?.locationId,
  };
}

/**
 * Update a trigger link's name and/or redirectTo. Both fields are passed
 * in the PUT body because GHL's PUT /links/:id requires `name` to always
 * be present. If caller omits either, we read the existing record first
 * to preserve the value.
 *
 * Important: GHL returns 422 if `locationId` is included in PUT body.
 */
export async function updateLink(id, { name, redirectTo } = {}) {
  if (!name && !redirectTo) throw new Error('nothing to update');

  let resolvedName = name;
  let resolvedRedirect = redirectTo;

  if (!resolvedName || !resolvedRedirect) {
    const existing = await findLinkById(id);
    if (!existing) throw new Error('not_found');
    resolvedName = resolvedName || existing.name;
    resolvedRedirect = resolvedRedirect || existing.redirectTo;
  }

  const { data } = await client.put(`/links/${id}`, {
    name: resolvedName,
    redirectTo: resolvedRedirect,
  });
  return data?.link || data;
}

/** Delete a trigger link by id. */
export async function deleteLink(id) {
  await client.delete(`/links/${id}`, {
    params: { locationId: GHL_LOCATION_ID },
  });
  return { id, deleted: true };
}

// ═══════════════════════════════════════════════════════════════════
// S4.5 SEED — idempotent bulk creation of nurture booking links
// ═══════════════════════════════════════════════════════════════════

/**
 * Canonical destination URLs by CTA type.
 * Resource destination is a placeholder — Mark can PUT a real URL later
 * via updateLink() once the calculator funnel landing page is final.
 */
const DESTINATIONS = {
  booking: 'https://landing.reecewindows.com/window-estimate',
  resource: 'https://landing.reecewindows.com/calculator',
};

/**
 * Build the redirect URL for a given S4.5 trigger link.
 * Preserves the existing utm_medium=email & utm_campaign=s4-5-seinfeld
 * standards from the direct-URL approach in nurture-booking-link.js.
 * GHL substitutes {{contact.*}} merge tags at click-time.
 */
function buildRedirect(destinationKey, utmContent) {
  const base = DESTINATIONS[destinationKey];
  const params = [
    'first_name={{contact.first_name}}',
    'last_name={{contact.last_name}}',
    'phone={{contact.phone}}',
    'email={{contact.email}}',
    'utm_source=ghl',
    'utm_medium=email',
    'utm_campaign=s4-5-seinfeld',
    `utm_content=${encodeURIComponent(utmContent)}`,
  ];
  return `${base}?${params.join('&')}`;
}

/**
 * The 9 S4.5 trigger links to seed.
 * Skips the 4 no-URL prompts (reflection / reply / self-id CTAs don't
 * reference a URL — no trigger link needed).
 *
 * Updated 2026-05-12 when CTA rotation locked.
 */
const S45_LINK_SPECS = [
  // Booking destination — soft_booking_offer prompts
  { prompt_code: 'S4.5-WK2-EPIPHANY-SA3-V1',     name: 'S4.5 Booking — WK2 Epiphany SA3',     destinationKey: 'booking',  utmContent: 'wk2-epiphany-sa3' },
  { prompt_code: 'S4.5-WK5-EPIPHANY-SA4-V1',     name: 'S4.5 Booking — WK5 Epiphany SA4',     destinationKey: 'booking',  utmContent: 'wk5-epiphany-sa4' },
  { prompt_code: 'S4.5-WK8-EPIPHANY-SA2-V1',     name: 'S4.5 Booking — WK8 Epiphany SA2',     destinationKey: 'booking',  utmContent: 'wk8-epiphany-sa2' },
  { prompt_code: 'S4.5-WK11-EPIPHANY-SA1-V1',    name: 'S4.5 Booking — WK11 Epiphany SA1',    destinationKey: 'booking',  utmContent: 'wk11-epiphany-sa1' },
  // Booking destination — direct_assessment_ask
  { prompt_code: 'S4.5-WK12-EDUCATIONAL-SA3-V1', name: 'S4.5 Booking — WK12 Direct',           destinationKey: 'booking',  utmContent: 'wk12-direct-sa3' },
  // Booking destination — fallback
  { prompt_code: 'S4.5-FALLBACK-V1',             name: 'S4.5 Booking — Fallback',              destinationKey: 'booking',  utmContent: 'fallback' },
  // Resource destination — resource_offer prompts (destination placeholder; Mark can update)
  { prompt_code: 'S4.5-WK3-EDUCATIONAL-SA2-V1',  name: 'S4.5 Resource — WK3 Educational SA2',  destinationKey: 'resource', utmContent: 'wk3-resource-sa2' },
  { prompt_code: 'S4.5-WK9-EDUCATIONAL-SA5-V1',  name: 'S4.5 Resource — WK9 Educational SA5',  destinationKey: 'resource', utmContent: 'wk9-resource-sa5' },
];

/**
 * Idempotent seed. For each spec:
 *   1. Look up existing link by name
 *   2. If exists with matching redirectTo → no-op
 *   3. If exists with different redirectTo → UPDATE
 *   4. If not exists → CREATE
 *   5. After all 9 are reconciled, write { trigger_link_id, trigger_link_field_key }
 *      back to agentic_messaging_prompts by prompt_code
 *
 * Returns a per-spec status report plus the DB writeback count.
 */
export async function seedS45Links() {
  if (!isReady()) {
    return { ok: false, error: readinessError() };
  }
  if (!supabase) {
    return { ok: false, error: 'Supabase not configured' };
  }

  const existing = await listLinks();
  const byName = new Map(existing.map(l => [l.name, l]));

  const report = [];

  for (const spec of S45_LINK_SPECS) {
    const wantRedirect = buildRedirect(spec.destinationKey, spec.utmContent);
    const found = byName.get(spec.name);

    let link;
    let action;

    if (!found) {
      link = await createLink({ name: spec.name, redirectTo: wantRedirect });
      action = 'created';
    } else if (found.redirectTo !== wantRedirect) {
      const updated = await updateLink(found.id, { name: spec.name, redirectTo: wantRedirect });
      link = {
        id: updated?.id || found.id,
        name: updated?.name || spec.name,
        redirectTo: updated?.redirectTo || wantRedirect,
        fieldKey: updated?.fieldKey || found.fieldKey,
      };
      action = 'updated';
    } else {
      link = found;
      action = 'unchanged';
    }

    // Write the trigger link mapping back to the prompts table.
    const { error: dbErr } = await supabase
      .from('agentic_messaging_prompts')
      .update({
        trigger_link_id: link.id,
        trigger_link_field_key: link.fieldKey,
        updated_at: new Date().toISOString(),
      })
      .eq('prompt_code', spec.prompt_code);

    if (dbErr) {
      report.push({
        prompt_code: spec.prompt_code,
        name: spec.name,
        action,
        link_id: link.id,
        field_key: link.fieldKey,
        db_write: 'failed',
        db_error: dbErr.message,
      });
    } else {
      report.push({
        prompt_code: spec.prompt_code,
        name: spec.name,
        action,
        link_id: link.id,
        field_key: link.fieldKey,
        db_write: 'ok',
      });
    }
  }

  const summary = report.reduce((acc, r) => {
    acc[r.action] = (acc[r.action] || 0) + 1;
    if (r.db_write !== 'ok') acc.db_failed = (acc.db_failed || 0) + 1;
    return acc;
  }, { created: 0, updated: 0, unchanged: 0 });

  return {
    ok: true,
    total_specs: S45_LINK_SPECS.length,
    summary,
    report,
  };
}

export { S45_LINK_SPECS, shapeError };
