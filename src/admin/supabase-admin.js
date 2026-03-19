// ─── Supabase Direct SQL Admin — src/admin/supabase-admin.js ──────
//
// Executes SQL queries against Supabase via the run_sql RPC function.
// Uses the existing Supabase client (service role key).

import supabase from '../supabase.js';

// Statements that modify data — blocked when allowWrite is false
const WRITE_PATTERNS = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b/i;

export const runSQL = async (queryText, allowWrite = false) => {
  if (!supabase) throw new Error('Supabase not configured');

  if (!allowWrite && WRITE_PATTERNS.test(queryText)) {
    throw new Error(
      'Write statement detected but allow_write is false. ' +
      'Set allow_write: true to execute INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/CREATE statements.'
    );
  }

  const { data, error } = await supabase.rpc('run_sql', { query_text: queryText });
  if (error) throw new Error(`Supabase SQL error: ${error.message}`);
  return data;
};

export const listTables = async (prefix = 'lp_') => {
  if (!supabase) throw new Error('Supabase not configured');

  const query = `
    SELECT json_agg(t) FROM (
      SELECT
        tablename AS table_name,
        (SELECT reltuples::bigint FROM pg_class WHERE relname = tablename) AS approx_row_count
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename LIKE '${prefix}%'
      ORDER BY tablename
    ) t
  `;
  const { data, error } = await supabase.rpc('run_sql', { query_text: query });
  if (error) throw new Error(`Supabase error: ${error.message}`);
  return data;
};

export const getTableSchema = async (tableName) => {
  if (!supabase) throw new Error('Supabase not configured');

  // Validate table name to prevent SQL injection
  if (!/^[a-z_][a-z0-9_]*$/.test(tableName)) {
    throw new Error('Invalid table name');
  }

  const query = `
    SELECT json_agg(c) FROM (
      SELECT
        column_name,
        data_type,
        is_nullable,
        column_default,
        character_maximum_length
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = '${tableName}'
      ORDER BY ordinal_position
    ) c
  `;
  const { data, error } = await supabase.rpc('run_sql', { query_text: query });
  if (error) throw new Error(`Supabase error: ${error.message}`);
  return data;
};
