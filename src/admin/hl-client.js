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

export function isSelectish(queryText) {
  const upper = (queryText || '').trim().toUpperCase();
  return upper.startsWith('SELECT') || upper.startsWith('WITH');
}

/**
 * Throw unless a SELECT came back as a row array.
 *
 * Pure so it can be tested without a Supabase client. See the note on
 * hlRunSQL: a non-array here means HL's run_sql is still the pre-013 body,
 * which answers a multi-column SELECT with its first column and drops the
 * rest. There is no safe way to use that value, so this refuses it.
 */
export function assertRowArray(queryText, data) {
  if (!isSelectish(queryText) || Array.isArray(data)) return data;
  throw new Error(
    'HL run_sql returned a non-array for a SELECT, which means migration '
    + '014_run_sql_full_resultset.sql is NOT applied on this HL Supabase. '
    + 'Refusing the result: the old function body returns only the first column '
    + 'of the first row, so this value is silently truncated. Apply '
    + 'HL-MCP/supabase/migrations/014_run_sql_full_resultset.sql (the Supabase '
    + 'branching workflow does this on merge; by hand, use the SQL editor — it '
    + 'cannot be applied through the MCP admin tool).',
  );
}

/**
 * Run SQL against the HL Supabase and return ROWS.
 *
 * A SELECT always returns an array of row objects — `[]` for zero rows, and a
 * single-row single-column result stays `[{col: value}]` rather than collapsing
 * to a bare scalar.
 *
 * ─── History (2026-08-30) ─────────────────────────────────────────────────
 * This used to wrap every SELECT in json_agg client-side and then un-nest the
 * reply, because HL's run_sql carried the original
 * `EXECUTE query_text INTO result` body — which captures only the FIRST COLUMN
 * of the FIRST ROW and silently discards everything else. HL-MCP migration
 * 014_run_sql_full_resultset.sql fixes that server-side (the function is now
 * byte-identical to LP's own sql/run_sql.sql), so the workaround is gone and
 * both Supabase clients in this repo behave the same way.
 *
 * The guard below exists because that migration is applied BY HAND. Against an
 * un-migrated instance the old body would answer a multi-column SELECT with one
 * plausible-looking scalar, and every caller here would quietly act on
 * truncated data. Failing loudly is the only safe response — a wrong number
 * that looks right is worse than an outage.
 */
export async function hlRunSQL(queryText) {
  const supabase = getHlSupabase();
  const { data, error } = await supabase.rpc('run_sql', { query_text: queryText });
  if (error) throw new Error(`HL SQL error: ${error.message}`);
  return assertRowArray(queryText, data);
}

/** This path has NO bind parameters — every interpolated value needs this. */
export function esc(s) {
  return String(s).replace(/'/g, "''");
}
