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

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

let hlClient = null;
function getHlSupabase() {
  if (hlClient) return hlClient;
  const url = process.env.HL_SUPABASE_URL;
  const key = process.env.HL_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'HL fallback not configured — set HL_SUPABASE_URL and HL_SUPABASE_SERVICE_ROLE_KEY on the LP MCP service.'
    );
  }
  hlClient = createClient(url, key);
  return hlClient;
}

function assertReadOnly(q) {
  const t = (q || '').trim();
  const u = t.toUpperCase();
  if (!(u.startsWith('SELECT') || u.startsWith('WITH'))) {
    throw new Error('Read-only fallback: only SELECT / WITH queries are allowed.');
  }
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|MERGE)\b/.test(u)) {
    throw new Error('Read-only fallback: write/DDL keywords are not allowed.');
  }
  return t;
}

function wrapSelectForJsonAgg(queryText) {
  const trimmed = queryText.trim();
  const upper = trimmed.toUpperCase();
  if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) return trimmed;
  if (upper.includes('JSON_AGG')) return trimmed;
  return `SELECT json_agg(t) FROM (${trimmed}) t`;
}

function unwrapSingleValue(data) {
  if (Array.isArray(data) && data.length === 1 && typeof data[0] === 'object' && data[0] !== null) {
    const keys = Object.keys(data[0]);
    if (keys.length === 1) return data[0][keys[0]];
  }
  return data;
}

async function hlRunSQL(queryText) {
  const supabase = getHlSupabase();
  const wrapped = wrapSelectForJsonAgg(queryText);
  const { data, error } = await supabase.rpc('run_sql', { query_text: wrapped });
  if (error) throw new Error(`HL SQL error: ${error.message}`);
  return unwrapSingleValue(data);
}

function esc(s) {
  return String(s).replace(/'/g, "''");
}

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
