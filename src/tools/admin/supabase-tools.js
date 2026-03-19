// ─── Supabase Admin MCP Tools (Tools 30–33) ──────────────────────
import { z } from 'zod';
import supabase from '../../supabase.js';
import { runSQL, listTables, getTableSchema } from '../../admin/supabase-admin.js';

export function registerSupabaseAdminTools(server) {

  // Tool 30: supabase_run_query [READ/WRITE]
  // Supabase is the analytics mirror — reads and writes are allowed.
  // Only DROP/TRUNCATE require explicit confirmation.
  server.tool(
    'supabase_run_query',
    'Execute a SQL query against Supabase (SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER all allowed). Only DROP/TRUNCATE require confirm_destructive: true.',
    {
      query: z.string().describe('SQL query. Example: "SELECT COUNT(*) FROM lp_leads"'),
      confirm_destructive: z.boolean().optional().describe('Required only for DROP/TRUNCATE statements (default: false)'),
    },
    async ({ query, confirm_destructive }) => {
      if (!query) return { content: [{ type: 'text', text: 'Error: query is required.' }] };

      try {
        const result = await runSQL(query, confirm_destructive === true);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, result }, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: err.message }, null, 2) }],
        };
      }
    }
  );

  // Tool 31: supabase_list_tables [READ]
  server.tool(
    'supabase_list_tables',
    'List all lp_* tables with approximate row counts.',
    {
      prefix: z.string().optional().describe('Table name prefix filter (default: "lp_")'),
    },
    async ({ prefix }) => {
      const result = await listTables(prefix || 'lp_');
      return {
        content: [{ type: 'text', text: JSON.stringify({ tables: result }, null, 2) }],
      };
    }
  );

  // Tool 32: supabase_get_table_schema [READ]
  server.tool(
    'supabase_get_table_schema',
    'Full column definitions, types, defaults, and constraints for a table.',
    {
      table_name: z.string().describe('Table name. Example: "lp_leads"'),
    },
    async ({ table_name }) => {
      if (!table_name) return { content: [{ type: 'text', text: 'Error: table_name is required.' }] };

      const result = await getTableSchema(table_name);
      return {
        content: [{ type: 'text', text: JSON.stringify({ table: table_name, columns: result }, null, 2) }],
      };
    }
  );

  // Tool 33: supabase_get_sync_errors [READ]
  server.tool(
    'supabase_get_sync_errors',
    'Unresolved sync errors for diagnosis. Filter by resolved status and sync type.',
    {
      resolved: z.boolean().optional().describe('Filter by resolved status (default: false = unresolved only)'),
      limit: z.number().optional().describe('Max records to return (default: 50)'),
      sync_type: z.string().optional().describe('Filter by sync type: "full", "incremental", or "reconcile"'),
    },
    async ({ resolved, limit, sync_type }) => {
      if (!supabase) return { content: [{ type: 'text', text: 'Error: Supabase not configured.' }] };

      let query = supabase.from('lp_sync_errors')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit || 50);

      // Default to unresolved only
      const showResolved = resolved === true;
      query = query.eq('resolved', showResolved);

      if (sync_type) {
        query = query.eq('sync_type', sync_type);
      }

      const { data, error } = await query;
      if (error) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: error.message }, null, 2) }] };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({
          count: data?.length || 0,
          filter: { resolved: showResolved, sync_type: sync_type || 'all' },
          errors: data,
        }, null, 2) }],
      };
    }
  );
}
