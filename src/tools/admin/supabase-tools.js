// ─── Supabase Admin MCP Tools (Tools 30–33) ──────────────────────
import { z } from 'zod';
import supabase from '../../supabase.js';
import { runSQL, listTables, getTableSchema } from '../../admin/supabase-admin.js';
import { analyzeSql, decideReadQuery, sqlToolMode, sqlWriteToolEnabled } from '../../security/sql-guard.js';
import { recordToolAudit, sqlFingerprint, actorFromExtra } from '../../security/tool-audit.js';

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

// 2026-10-07 (IT/GoCloud review, CANON.SEC.007): the read path's RPC. Default
// `run_sql` is today's function. After sql/154 is applied, SQL_READONLY_RPC=
// run_sql_readonly makes the DATABASE refuse writes too (it forces the
// transaction read-only), which also covers a user-defined function that
// writes — the one thing sql-guard cannot see. Only used in readonly mode.
export function readonlyRpcName(env = process.env) {
  return String(env.SQL_READONLY_RPC || '').trim() === 'run_sql_readonly' ? 'run_sql_readonly' : 'run_sql';
}

async function runReadonlyRpc(query, env = process.env) {
  const fn = readonlyRpcName(env);
  if (fn === 'run_sql') return runSQL(query, false);
  if (!supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase.rpc(fn, { query_text: query });
  if (error) throw new Error(`Supabase SQL error (${fn}): ${error.message}`);
  return data;
}

/**
 * supabase_run_query's handler, with seams (2026-10-07).
 *
 * SQL_TOOL_MODE:
 *   readwrite (default) — today's behaviour exactly: anything goes through
 *     run_sql, DROP/TRUNCATE still need confirm_destructive. No audit row.
 *   shadow    — same execution; a statement that is not a single read logs
 *     `[SQLGuard] would_block` and writes a would_deny audit row.
 *   readonly  — only a single SELECT / WITH…SELECT / EXPLAIN / VALUES runs; the
 *     rest is refused with a pointer to supabase_write_query.
 */
export function makeRunQueryHandler({ run = runSQL, runReadonly = runReadonlyRpc, audit = recordToolAudit, env = process.env, log = (m) => console.warn(m) } = {}) {
  return async ({ query, confirm_destructive }, extra) => {
    if (!query) return { content: [{ type: 'text', text: 'Error: query is required.' }] };
    const mode = sqlToolMode(env);
    const d = decideReadQuery(query, mode);
    if (d.decision !== 'allow') {
      const who = actorFromExtra(extra);
      audit({
        tool: 'supabase_run_query', actor: who.actor, mode, decision: d.decision,
        reason: d.analysis.reason,
        detail: { session_id: who.session_id, first_keyword: d.analysis.firstKeyword, ...sqlFingerprint(query) },
      }, env);
      log(`[SQLGuard] ${d.decision === 'deny' ? 'blocked' : 'would_block'} supabase_run_query reason=${d.analysis.reason} actor=${who.actor} (SQL_TOOL_MODE=${mode})`);
    }
    if (!d.run) {
      const writeOn = sqlWriteToolEnabled(env);
      return text({
        error: 'read_only_tool',
        reason: d.analysis.reason,
        detail: 'supabase_run_query is read-only (SQL_TOOL_MODE=readonly): one SELECT / WITH / EXPLAIN statement, no writes, ' +
          'no ;-chained statements, no SELECT … INTO, no admin functions. ' +
          (writeOn
            ? 'Use supabase_write_query with a reason and confirm: true for writes.'
            : 'Writes go through supabase_write_query, which is not enabled on this server (SQL_WRITE_TOOL_ENABLED); DDL goes through the Supabase dashboard.'),
      });
    }
    try {
      const result = (mode === 'readonly')
        ? await runReadonly(query, env)
        : await run(query, confirm_destructive === true);
      return text({ success: true, result });
    } catch (err) {
      return text({ error: err.message });
    }
  };
}

/**
 * supabase_write_query's handler (2026-10-07). Every call — preview, refusal
 * or execution — writes one tool_audit_log row BEFORE anything runs: who, the
 * reason they gave, the sql sha256 and its first 500 characters.
 */
export function makeWriteQueryHandler({ run = runSQL, audit = recordToolAudit, env = process.env, log = (m) => console.warn(m) } = {}) {
  return async ({ query, reason, confirm, confirm_destructive }, extra) => {
    const who = actorFromExtra(extra);
    const fp = sqlFingerprint(query);
    const a = analyzeSql(query);
    const base = { session_id: who.session_id, first_keyword: a.firstKeyword, statements: a.statements, destructive: a.destructive, ...fp };
    const record = (decision, why) => audit({ tool: 'supabase_write_query', actor: who.actor, mode: 'write', decision, reason: why, detail: { ...base, given_reason: String(reason ?? '').slice(0, 500) } }, env);

    if (!query) { record('deny', 'query_missing'); return { content: [{ type: 'text', text: 'Error: query is required.' }] }; }
    const why = String(reason ?? '').trim();
    if (why.length < 8) {
      record('deny', 'reason_missing');
      return text({ error: 'reason_required', detail: 'Give a reason (8+ characters) saying what this write is for; it is stored in the audit log.' });
    }
    if (confirm !== true) {
      record('deny', 'preview_confirm_missing');
      return text({
        preview: true,
        first_keyword: a.firstKeyword,
        statements: a.statements,
        destructive: a.destructive,
        sql_sha256: fp.sql_sha256,
        warning: 'This will run against the production LP Supabase as service_role. Re-call with confirm: true to execute.' +
          (a.destructive ? ' It contains DROP/TRUNCATE, so confirm_destructive: true is needed as well.' : ''),
      });
    }
    // DROP / TRUNCATE anywhere in code (ALTER TABLE … DROP COLUMN included),
    // read by the tokenizer — stricter than runSQL's start-of-text regex.
    if (a.destructive && confirm_destructive !== true) {
      record('deny', 'destructive_confirm_missing');
      return text({ error: 'confirm_destructive_required', detail: 'Destructive statement detected (DROP/TRUNCATE). Set confirm_destructive: true to execute.' });
    }
    record('allow', why);
    log(`[SQLGuard] supabase_write_query executing actor=${who.actor} sha=${fp.sql_sha256.slice(0, 12)} reason="${why.slice(0, 80)}"`);
    try {
      const result = await run(query, confirm_destructive === true);
      return text({ success: true, result, sql_sha256: fp.sql_sha256 });
    } catch (err) {
      log(`[SQLGuard] supabase_write_query failed sha=${fp.sql_sha256.slice(0, 12)}: ${err.message}`);
      return text({ error: err.message, sql_sha256: fp.sql_sha256 });
    }
  };
}

export function registerSupabaseAdminTools(server, { env = process.env } = {}) {
  const mode = sqlToolMode(env);

  // Tool 30: supabase_run_query [READ; READ/WRITE only while SQL_TOOL_MODE=readwrite]
  // Until 2026-10-07 this was the only SQL tool and took writes too. It still
  // does by default (readwrite) so this change merges as a no-op; see
  // makeRunQueryHandler for the modes.
  server.tool(
    'supabase_run_query',
    mode === 'readonly'
      ? 'Run ONE read-only SQL statement against the LP Supabase (SELECT / WITH…SELECT / EXPLAIN). Writes are refused — use supabase_write_query.'
      : 'Execute a SQL query against Supabase (SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER all allowed). Only DROP/TRUNCATE require confirm_destructive: true.',
    {
      query: z.string().describe('SQL query. Example: "SELECT COUNT(*) FROM lp_leads"'),
      confirm_destructive: z.boolean().optional().describe('Required only for DROP/TRUNCATE statements (default: false)'),
    },
    makeRunQueryHandler({ env })
  );

  // Tool 30b: supabase_write_query [WRITE, audited] — registered only when
  // SQL_WRITE_TOOL_ENABLED=true (2026-10-07).
  if (sqlWriteToolEnabled(env)) {
    server.tool(
      'supabase_write_query',
      'Run a WRITE (INSERT / UPDATE / DELETE / DDL) against the LP Supabase as service_role. Requires a reason and confirm: true; ' +
        'DROP/TRUNCATE also need confirm_destructive: true. Every call is recorded in tool_audit_log. Prefer supabase_run_query for reads.',
      {
        query: z.string().describe('SQL to run. Assert row counts: WITH u AS (UPDATE … RETURNING 1) SELECT count(*) FROM u'),
        reason: z.string().describe('Why this write is needed (8+ characters). Stored in the audit log.'),
        confirm: z.boolean().optional().describe('Must be true to execute; otherwise a preview is returned.'),
        confirm_destructive: z.boolean().optional().describe('Required for DROP/TRUNCATE anywhere in the statement.'),
      },
      makeWriteQueryHandler({ env })
    );
  }

  // Tool 31: supabase_list_tables [READ]
  server.tool(
    'supabase_list_tables',
    'List all lp_* tables with approximate row counts.',
    {
      prefix: z.string().optional().describe('Table name prefix filter (default: "lp_")'),
    },
    async ({ prefix }) => {
      // 2026-10-07 (SEC.002): the prefix is spliced into SQL unescaped by
      // listTables, so `x' UNION SELECT run_sql('…') --` would have run a
      // write through a "read" tool. Table-name characters only.
      if (prefix && !/^[A-Za-z0-9_]*$/.test(prefix)) {
        return { content: [{ type: 'text', text: 'Error: prefix may contain only letters, digits and underscores.' }] };
      }
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
