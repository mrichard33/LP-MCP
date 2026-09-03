/**
 * GHL Trigger Link Client — pure functions wrapping the GHL /links/ API.
 *
 * Used by:
 *   - src/admin/ghl-trigger-links.js (HTTP admin routes)
 *   - src/tools/admin/ghl-trigger-link-tools.js (MCP tools)
 *   - seedS45Links() for idempotent reconciliation of S4.5 nurture links
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
// S4.5 SEED — idempotent reconciliation of nurture trigger links
// ═══════════════════════════════════════════════════════════════════

/**
 * Canonical destinations.
 *
 * v1.1 (2026-09-03): the S4.5 Offer is the Tier-1 Protection Profile
 * Review (15-min call), never the in-home Window Estimate page. The
 * booking base is the GHL custom value so a calendar change is a
 * one-place edit. Resource destinations are explicit per spec below.
 *
 * History: the June spec pointed `booking` at
 * landing.reecewindows.com/window-estimate and `resource` at a
 * /calculator placeholder, and named the resource links differently
 * from what was later created by hand. Running that spec against the
 * live location would have re-pointed six PPR links back to the
 * estimate page and created two duplicate resource links.
 */
const BOOKING_BASE = '{{custom_values.protection_profile_review}}';

/**
 * Build the standard S4.5 redirect: contact merge tags + fixed UTMs.
 * GHL substitutes {{contact.*}} and {{custom_values.*}} at click-time.
 */
function buildRedirect(base, utmContent) {
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
 * The 9 S4.5 trigger links. Names match the live GHL location exactly
 * (verified 2026-09-03 via ghl_links_list) so the seed reconciles rather
 * than duplicates.
 *
 *   prompt_codes  — every agentic_messaging_prompts row bound to the link
 *   redirectTo    — explicit when the destination is not the PPR pattern
 */
const S45_LINK_SPECS = [
  // Weekly PPR booking links — soft_booking_offer / direct_assessment_ask
  { prompt_codes: ['S4.5-WK2-EPIPHANY-SA3-V1'],     name: 'S4.5 Booking — WK2 Epiphany SA3',  redirectTo: buildRedirect(BOOKING_BASE, 'wk2-epiphany-sa3') },
  { prompt_codes: ['S4.5-WK5-EPIPHANY-SA4-V1'],     name: 'S4.5 Booking — WK5 Epiphany SA4',  redirectTo: buildRedirect(BOOKING_BASE, 'wk5-epiphany-sa4') },
  { prompt_codes: ['S4.5-WK8-EPIPHANY-SA2-V1'],     name: 'S4.5 Booking — WK8 Epiphany SA2',  redirectTo: buildRedirect(BOOKING_BASE, 'wk8-epiphany-sa2') },
  { prompt_codes: ['S4.5-WK11-EPIPHANY-SA1-V1'],    name: 'S4.5 Booking — WK11 Epiphany SA1', redirectTo: buildRedirect(BOOKING_BASE, 'wk11-epiphany-sa1') },
  { prompt_codes: ['S4.5-WK12-EDUCATIONAL-SA3-V1'], name: 'S4.5 Booking — WK12 Direct',        redirectTo: buildRedirect(BOOKING_BASE, 'wk12-direct-sa3') },
  { prompt_codes: ['S4.5-FALLBACK-V1'],             name: 'S4.5 Booking — Fallback',           redirectTo: buildRedirect(BOOKING_BASE, 'fallback') },

  // Escape hatch — one PPR link shared by every week whose body close is a
  // reply / reflection / self-id cue. The P.S. always carries it (S4.5 v1.1).
  {
    prompt_codes: [
      'S4.5-WK1-EPISODE-SA1-V1',
      'S4.5-WK4-EPISODE-SA5-V1',
      'S4.5-WK6-EDUCATIONAL-SA1-V1',
      'S4.5-WK7-EPISODE-SA3-V1',
      'S4.5-WK10-EPISODE-SA4-V1',
    ],
    name: 'S4.5 Escape Hatch — PPR',
    redirectTo: buildRedirect(BOOKING_BASE, 'escape-hatch-ppr'),
  },

  // Resource links — resource_offer weeks. Destinations are the live assets.
  {
    prompt_codes: ['S4.5-WK3-EDUCATIONAL-SA2-V1'],
    name: 'S4.5 Resource — WK3 Home Risk Report',
    redirectTo: buildRedirect('https://landing.reecewindows.com/risk-report-step1', 'wk3-risk-report-sa2'),
  },
  {
    prompt_codes: ['S4.5-WK9-EDUCATIONAL-SA5-V1'],
    name: 'S4.5 Resource — WK9 Hurricane Preparedness Guide',
    // Static PDF — no merge tags or UTMs (GHL storage ignores the query string).
    redirectTo: 'https://storage.googleapis.com/msgsndr/SsBG7j5KQAIP1SFP2Sca/media/69335bfd81eaa1bd84c19ea7.pdf',
  },
];

/**
 * Idempotent seed. For each spec:
 *   1. Look up existing link by exact name
 *   2. If exists with matching redirectTo → no-op
 *   3. If exists with different redirectTo → UPDATE
 *   4. If not exists → CREATE
 *   5. Write { trigger_link_id, trigger_link_field_key } back to every
 *      agentic_messaging_prompts row in spec.prompt_codes
 *
 * Returns a per-spec status report plus DB writeback status.
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
    const wantRedirect = spec.redirectTo;
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

    // Write the trigger link mapping back to every bound prompt row.
    const { error: dbErr, count } = await supabase
      .from('agentic_messaging_prompts')
      .update({
        trigger_link_id: link.id,
        trigger_link_field_key: link.fieldKey,
        updated_at: new Date().toISOString(),
      }, { count: 'exact' })
      .in('prompt_code', spec.prompt_codes);

    report.push({
      prompt_codes: spec.prompt_codes,
      name: spec.name,
      action,
      link_id: link.id,
      field_key: link.fieldKey,
      db_write: dbErr ? 'failed' : 'ok',
      db_rows: dbErr ? 0 : count,
      ...(dbErr ? { db_error: dbErr.message } : {}),
    });
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
