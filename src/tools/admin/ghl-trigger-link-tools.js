// ─── GHL Trigger Link MCP Tools ──────────────────────────────────
//
// Wraps src/admin/ghl-trigger-link-client.js so future MCP sessions can
// manage GHL trigger links programmatically — list, create, update,
// delete, plus the one-shot S4.5 seed.
//
// Naming convention: `ghl_links_<verb>` to group lexicographically in
// tool catalogs and not clash with other admin tools.

import { z } from 'zod';
import {
  isReady,
  readinessError,
  listLinks,
  findLinkById,
  createLink,
  updateLink,
  deleteLink,
  seedS45Links,
  S45_LINK_SPECS,
} from '../../admin/ghl-trigger-link-client.js';

function jsonText(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function notReady() {
  return jsonText({ ok: false, error: readinessError() });
}

export function registerGhlTriggerLinkTools(server) {

  // ───────────────────────────────────────────────────────────────
  // ghl_links_list — list all trigger links for the location
  // ───────────────────────────────────────────────────────────────
  server.tool(
    'ghl_links_list',
    'List all GHL trigger links for the configured location. Returns id, name, redirectTo, and fieldKey (used in {{trigger_link.<fieldKey>}} merge tags).',
    {},
    async () => {
      if (!isReady()) return notReady();
      try {
        const links = await listLinks();
        return jsonText({ ok: true, count: links.length, links });
      } catch (err) {
        return jsonText({ ok: false, error: err.message });
      }
    }
  );

  // ───────────────────────────────────────────────────────────────
  // ghl_links_get — fetch one link by id
  // ───────────────────────────────────────────────────────────────
  server.tool(
    'ghl_links_get',
    'Fetch a single GHL trigger link by id.',
    {
      id: z.string().describe('The trigger link id'),
    },
    async ({ id }) => {
      if (!isReady()) return notReady();
      if (!id) return jsonText({ ok: false, error: 'id required' });
      try {
        const link = await findLinkById(id);
        if (!link) return jsonText({ ok: false, error: 'not_found' });
        return jsonText({ ok: true, link });
      } catch (err) {
        return jsonText({ ok: false, error: err.message });
      }
    }
  );

  // ───────────────────────────────────────────────────────────────
  // ghl_links_create — create a new trigger link
  // ───────────────────────────────────────────────────────────────
  server.tool(
    'ghl_links_create',
    'Create a new GHL trigger link. Name should be lowercase-hyphenated or use the "Category — Identifier" pattern of existing S4.5 links. redirectTo can include {{contact.*}} merge tags — GHL substitutes them at click-time. UTM params are part of redirectTo, not metadata.',
    {
      name: z.string().describe('Trigger link name (must be unique in the location).'),
      redirectTo: z.string().describe('Destination URL. May include {{contact.first_name}}, {{contact.phone}}, etc. UTM params live in the query string.'),
    },
    async ({ name, redirectTo }) => {
      if (!isReady()) return notReady();
      try {
        const link = await createLink({ name, redirectTo });
        return jsonText({ ok: true, link });
      } catch (err) {
        return jsonText({ ok: false, error: err.message });
      }
    }
  );

  // ───────────────────────────────────────────────────────────────
  // ghl_links_update — update name and/or redirectTo
  // ───────────────────────────────────────────────────────────────
  server.tool(
    'ghl_links_update',
    "Update a trigger link's name and/or redirectTo. Either field can be omitted to preserve the existing value. Use this to flip a resource-offer link's destination once the real landing page is built.",
    {
      id: z.string().describe('The trigger link id'),
      name: z.string().optional().describe('New name (optional — preserved if omitted)'),
      redirectTo: z.string().optional().describe('New destination URL (optional — preserved if omitted)'),
    },
    async ({ id, name, redirectTo }) => {
      if (!isReady()) return notReady();
      if (!id) return jsonText({ ok: false, error: 'id required' });
      if (!name && !redirectTo) return jsonText({ ok: false, error: 'nothing to update' });
      try {
        const link = await updateLink(id, { name, redirectTo });
        return jsonText({ ok: true, link });
      } catch (err) {
        return jsonText({ ok: false, error: err.message });
      }
    }
  );

  // ───────────────────────────────────────────────────────────────
  // ghl_links_delete — delete a trigger link
  // ───────────────────────────────────────────────────────────────
  server.tool(
    'ghl_links_delete',
    'Delete a GHL trigger link by id. Permanent — make sure no agentic_messaging_prompts row still references the trigger_link_id.',
    {
      id: z.string().describe('The trigger link id to delete'),
    },
    async ({ id }) => {
      if (!isReady()) return notReady();
      if (!id) return jsonText({ ok: false, error: 'id required' });
      try {
        const result = await deleteLink(id);
        return jsonText({ ok: true, ...result });
      } catch (err) {
        return jsonText({ ok: false, error: err.message });
      }
    }
  );

  // ───────────────────────────────────────────────────────────────
  // ghl_links_seed_s4_5 — bulk-create S4.5 nurture trigger links + map
  // ───────────────────────────────────────────────────────────────
  server.tool(
    'ghl_links_seed_s4_5',
    'Idempotent: creates or updates the 8 S4.5 nurture trigger links and writes trigger_link_id + trigger_link_field_key back to agentic_messaging_prompts. Safe to run repeatedly. Returns a per-spec report of created/updated/unchanged actions.',
    {
      preview: z.boolean().optional().describe('If true, return the spec list without making any GHL or DB changes (default: false).'),
    },
    async ({ preview }) => {
      if (!isReady()) return notReady();
      if (preview === true) {
        return jsonText({ ok: true, preview: true, specs: S45_LINK_SPECS });
      }
      try {
        const result = await seedS45Links();
        return jsonText(result);
      } catch (err) {
        return jsonText({ ok: false, error: err.message });
      }
    }
  );

  console.log('[MCP Tools] Registered: ghl_links_list, ghl_links_get, ghl_links_create, ghl_links_update, ghl_links_delete, ghl_links_seed_s4_5');
}
