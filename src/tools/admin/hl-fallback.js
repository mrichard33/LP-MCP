// ─── HL MCP Data Fallback Tools — src/tools/admin/hl-fallback.js ──
//
// Reverse failover: read-only access to the HL MCP Supabase (the GHL
// workflow-intelligence data: workflows, contacts, conversations,
// opportunities, pipelines, etc.) so it stays queryable from LP when
// the HL MCP service is down. Mirror of HL MCP's lp-fallback.ts.
//
// Requires HL_SUPABASE_URL + HL_SUPABASE_SERVICE_ROLE_KEY on the LP
// MCP service. If unset, the tools return a clear "not configured"
// error rather than throwing at boot.
//
// All tools are READ-ONLY (SELECT/WITH only). Uses HL's run_sql RPC,
// whose result variable is json-typed, so every SELECT is wrapped in
// json_agg before execution.
//
// The client and query helpers moved to src/admin/hl-client.js
// (2026-07-25) so non-tool consumers — src/jobs/capacity-bands.js — can
// reach the HL warehouse without importing this tool module and its zod
// dependency. Same lazily-memoized client, one instance for all callers.

import { z } from 'zod';
import { getHlSupabase, assertReadOnly, hlRunSQL, esc } from '../../admin/hl-client.js';

// Re-exported so existing importers of this module keep working unchanged.
export { hlRunSQL, esc };

export async function resolveWorkflowIdByCanonicalCode(canonicalCode) {
  if (!canonicalCode) return null;
  // canonical_code is unique today; ordering is defensive — prefer active, then
  // freshest. (Registry statuses are active/draft/legacy — never 'published'.)
  const q =
    `SELECT workflow_id FROM workflow_registry ` +
    `WHERE canonical_code = '${esc(canonicalCode)}' ` +
    `ORDER BY (status = 'active') DESC, updated_at DESC LIMIT 1`;
  let rows;
  try {
    rows = await hlRunSQL(q);
  } catch (err) {
    // HL down / not configured / RPC error — distinguishable from "no row".
    console.warn(`[HlFallback] registry lookup FAILED for ${canonicalCode}: ${err.message}`);
    throw err;                                     // caller decides fail-soft policy
  }
  // hlRunSQL pipes through unwrapSingleValue(): a single-row, single-column result
  // collapses to the bare workflow_id STRING; no row → null. Handle array/object too.
  let id = null;
  if (typeof rows === 'string') id = rows || null;
  else if (Array.isArray(rows) && rows.length) id = rows[0]?.workflow_id || null;
  else if (rows && typeof rows === 'object') id = rows.workflow_id || null;
  if (!id) console.warn(`[HlFallback] registry lookup: no row for canonical_code "${canonicalCode}"`);
  return id;
}

export function registerHlFallbackTools(server) {

  // hl_query [READ-ONLY] — generic escape hatch
  server.tool(
    'hl_query',
    'FALLBACK: Run a read-only SELECT against the HL MCP Supabase (use when HL MCP is down). SELECT/WITH only. Tables include: workflows, workflow_registry, workflow_steps, workflow_actions, workflow_connections, workflow_triggers, contacts, conversations, messages, opportunities, pipelines, appointments, tags, templates, trigger_links, lead_events.',
    {
      query: z.string().describe('SQL SELECT query against HL Supabase. Example: "SELECT id, name, status FROM workflows LIMIT 20"'),
    },
    async ({ query }) => {
      const safe = assertReadOnly(query);
      const result = await hlRunSQL(safe);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // hl_list_tables [READ]
  server.tool(
    'hl_list_tables',
    'FALLBACK: List tables in the HL MCP Supabase with approximate row counts.',
    {
      prefix: z.string().optional().describe('Filter by table name prefix (e.g. "workflow_")'),
    },
    async ({ prefix }) => {
      let inner = `SELECT relname AS table_name, n_live_tup AS approximate_row_count FROM pg_stat_user_tables WHERE schemaname = 'public'`;
      if (prefix) inner += ` AND relname LIKE '${esc(prefix)}%'`;
      inner += ' ORDER BY relname';
      const result = await hlRunSQL(inner);
      return { content: [{ type: 'text', text: JSON.stringify({ tables: result }, null, 2) }] };
    }
  );

  // hl_get_table_schema [READ]
  server.tool(
    'hl_get_table_schema',
    'FALLBACK: Get column definitions for a table in the HL MCP Supabase.',
    {
      table: z.string().describe('Table name. Example: "workflows"'),
    },
    async ({ table }) => {
      if (!/^[a-z_][a-z0-9_]*$/i.test(table)) {
        return { content: [{ type: 'text', text: 'Error: invalid table name.' }] };
      }
      const inner = `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${esc(table)}' ORDER BY ordinal_position`;
      const result = await hlRunSQL(inner);
      return { content: [{ type: 'text', text: JSON.stringify({ table, columns: result }, null, 2) }] };
    }
  );

  // hl_get_workflows [READ]
  server.tool(
    'hl_get_workflows',
    'FALLBACK: List/search GHL workflows from the HL MCP Supabase (use when HL MCP is down).',
    {
      search: z.string().optional().describe('Case-insensitive match across the whole workflow row (name, status, id, etc.)'),
      limit: z.number().optional().describe('Max rows (default 50, max 200)'),
    },
    async ({ search, limit }) => {
      const n = Math.min(limit || 50, 200);
      let q = `SELECT * FROM workflows`;
      if (search) q += ` WHERE workflows::text ILIKE '%${esc(search)}%'`;
      q += ` LIMIT ${n}`;
      const result = await hlRunSQL(q);
      return { content: [{ type: 'text', text: JSON.stringify({ count: Array.isArray(result) ? result.length : 0, workflows: result }, null, 2) }] };
    }
  );

  // hl_search_contacts [READ]
  server.tool(
    'hl_search_contacts',
    'FALLBACK: Search GHL contacts from the HL MCP Supabase by any field (use when HL MCP is down).',
    {
      query: z.string().describe('Search term — matched across the whole contact row (name, email, phone, id, tags).'),
      limit: z.number().optional().describe('Max rows (default 25, max 100)'),
    },
    async ({ query, limit }) => {
      const n = Math.min(limit || 25, 100);
      const q = `SELECT * FROM contacts WHERE contacts::text ILIKE '%${esc(query)}%' LIMIT ${n}`;
      const result = await hlRunSQL(q);
      return { content: [{ type: 'text', text: JSON.stringify({ count: Array.isArray(result) ? result.length : 0, contacts: result }, null, 2) }] };
    }
  );
}
