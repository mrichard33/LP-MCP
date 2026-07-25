// ─── HL MCP Supabase client — src/admin/hl-client.js ──────────────
//
// Read-only access to the HL MCP Supabase (the GHL data: workflows, contacts,
// conversations, opportunities, appointments, ...). This is a SECOND, separate
// Supabase project from LP's own (src/supabase.js), so nothing here can be
// cross-joined to LP tables — callers fetch from both and join in JS.
//
// The LP-side counterpart is src/admin/supabase-admin.js.
//
// Extracted from src/tools/admin/hl-fallback.js (2026-07-25) so non-tool
// consumers can reach the HL warehouse without importing a tool module — that
// pulled zod and the MCP tool registration surface into plain job code. The
// client itself is unchanged and still lazily memoized, so there is exactly one
// instance however many callers there are.
//
// Requires HL_SUPABASE_URL + HL_SUPABASE_SERVICE_ROLE_KEY on the LP MCP
// service. If unset, callers get a clear "not configured" error rather than a
// throw at boot.

import { createClient } from '@supabase/supabase-js';

let hlClient = null;

export function getHlSupabase() {
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

export function assertReadOnly(q) {
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

// HL's run_sql RPC returns a json-typed variable, so every SELECT is wrapped in
// json_agg before execution.
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

/**
 * CALLER BEWARE: the json_agg wrap plus unwrapSingleValue mean a zero-row
 * SELECT returns null rather than [], and a single-row single-column result
 * collapses to a bare scalar. Normalize before treating the result as an array.
 */
export async function hlRunSQL(queryText) {
  const supabase = getHlSupabase();
  const wrapped = wrapSelectForJsonAgg(queryText);
  const { data, error } = await supabase.rpc('run_sql', { query_text: wrapped });
  if (error) throw new Error(`HL SQL error: ${error.message}`);
  return unwrapSingleValue(data);
}

/** This path has NO bind parameters — every interpolated value needs this. */
export function esc(s) {
  return String(s).replace(/'/g, "''");
}
