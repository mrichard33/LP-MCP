/**
 * sql-guard — is this SQL text a single read-only statement? (2026-10-07)
 *
 * WHY. The 2026-09-23 IT/GoCloud security review flagged that the
 * `supabase_run_query` MCP tool accepts INSERT / UPDATE / DELETE / CREATE /
 * ALTER and runs them through `public.run_sql`, which is SECURITY DEFINER —
 * any MCP client could rewrite or drop production data (AI OS CANON.SEC.007
 * least privilege, SEC.002 schema-validated tool args). The fix splits the
 * tool: reads stay on `supabase_run_query`, writes move to an audited
 * `supabase_write_query`. This module is the read-only test both use.
 *
 * WHY A TOKENIZER, NOT A REGEX. The old HL guard (`assertReadOnly` in
 * src/admin/hl-client.js) upper-cases the text and greps for keywords, so
 *   SELECT * FROM notes WHERE body ILIKE '%update%'   → refused (false alarm)
 *   SELECT set_config('role', 'x', false)             → allowed (real write)
 *   SELECT run_sql('DELETE FROM lp_leads')            → allowed only because the
 *                                                       keyword sits in a string
 * Here keywords are read only from code: string literals ('…', E'…'),
 * dollar-quoted bodies ($$…$$, $tag$…$tag$), quoted identifiers ("update") and
 * comments (--, nested /* *\/) are skipped as units. Anything unterminated is
 * refused — fail closed, never guessed.
 *
 * WHAT IS REFUSED (readOnly: false):
 *   - empty text, or text that does not tokenize cleanly
 *   - more than one statement (`;` followed by anything but whitespace/comments)
 *   - a statement that does not start with SELECT, WITH, EXPLAIN, VALUES or
 *     TABLE (a leading "(" is fine)
 *   - a write keyword ANYWHERE in code: INSERT, UPDATE, DELETE, MERGE, INTO
 *     (SELECT … INTO creates a table), TRUNCATE, DROP, ALTER, CREATE, GRANT,
 *     REVOKE, COPY. This also catches data-modifying CTEs and FOR UPDATE.
 *     An unquoted column literally named "update" is refused too — quote it.
 *   - FOR SHARE / FOR KEY SHARE / FOR NO KEY UPDATE row locks
 *   - a call to a function that writes, signals, sleeps or reaches outside:
 *     run_sql / exec_sql (they execute their argument), set_config, nextval,
 *     setval, dblink*, lo_*, http* / net.* (pgsql-http, pg_net), query_to_xml
 *     and cursor_to_xml (they execute a query string), and every pg_* function
 *     except a short read-only allowlist (sizes, *def getters, pg_typeof…).
 *   - any reference to the `vault` schema (Supabase secrets)
 *
 * WHAT THIS CANNOT SEE. A user-defined VOLATILE function called from a SELECT
 * can still write (`SELECT record_consent_change(...)`). The guard is a
 * least-privilege filter, not a sandbox: the database-enforced answer is
 * sql/154 (`run_sql_readonly`, which forces the transaction read-only, and the
 * `mcp_readonly` role). Pure module, no I/O.
 */

const START_OK = new Set(['SELECT', 'WITH', 'EXPLAIN', 'VALUES', 'TABLE']);

const WRITE_WORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'INTO', 'TRUNCATE', 'DROP', 'ALTER',
  'CREATE', 'GRANT', 'REVOKE', 'COPY',
]);

// Exact function names that write, execute a string, or reach outside.
const BLOCKED_FUNCS = new Set([
  'run_sql', 'exec_sql', 'run_sql_readonly',
  'set_config', 'nextval', 'setval',
  'query_to_xml', 'query_to_xml_and_xmlschema', 'query_to_xmlschema',
  'cursor_to_xml', 'cursor_to_xmlschema',
  'http', 'txid_current', 'pg_sleep',
]);
const BLOCKED_FUNC_PREFIXES = ['dblink', 'lo_', 'http_', 'pg_'];
const BLOCKED_SCHEMAS = new Set(['net', 'dblink', 'vault']);

// pg_* functions that only read. Everything else under pg_ is refused
// (pg_terminate_backend, pg_cancel_backend, pg_reload_conf, pg_read_file,
// pg_ls_dir, pg_stat_reset*, pg_advisory_lock*, pg_notify, pg_switch_wal, …).
const PG_READ_FUNCS = new Set([
  'pg_typeof', 'pg_size_pretty', 'pg_size_bytes', 'pg_column_size',
  'pg_relation_size', 'pg_total_relation_size', 'pg_table_size', 'pg_indexes_size',
  'pg_database_size', 'pg_get_viewdef', 'pg_get_functiondef', 'pg_get_function_arguments',
  'pg_get_function_result', 'pg_get_indexdef', 'pg_get_constraintdef', 'pg_get_triggerdef',
  'pg_get_expr', 'pg_get_userbyid', 'pg_get_serial_sequence', 'pg_is_in_recovery',
  'pg_postmaster_start_time', 'pg_backend_pid', 'pg_last_xact_replay_timestamp',
  'pg_has_role', 'pg_table_is_visible', 'pg_function_is_visible', 'pg_encoding_to_char',
  'pg_get_keywords', 'pg_input_is_valid', 'pg_xact_commit_timestamp',
]);

/**
 * Split SQL into code tokens. Strings, quoted identifiers and comments are
 * returned as opaque tokens (type 'string' | 'ident' | 'comment') so their
 * contents are never read as keywords.
 *
 * @returns {{ ok: true, tokens: Array<{type: string, value: string}> } | { ok: false, reason: string }}
 */
export function tokenizeSql(sql) {
  const s = String(sql ?? '');
  const tokens = [];
  let i = 0;
  const n = s.length;
  const isWordStart = (c) => /[A-Za-z_\u0080-￿]/.test(c);
  const isWord = (c) => /[A-Za-z0-9_$\u0080-￿]/.test(c);

  while (i < n) {
    const c = s[i];
    const next = s[i + 1];

    if (/\s/.test(c)) { i++; continue; }

    // -- line comment
    if (c === '-' && next === '-') {
      const end = s.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
      tokens.push({ type: 'comment', value: '' });
      continue;
    }

    // /* block comment */ — Postgres nests these.
    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (s[i] === '/' && s[i + 1] === '*') { depth++; i += 2; continue; }
        if (s[i] === '*' && s[i + 1] === '/') { depth--; i += 2; continue; }
        i++;
      }
      if (depth > 0) return { ok: false, reason: 'unterminated_comment' };
      tokens.push({ type: 'comment', value: '' });
      continue;
    }

    // E'…' escape string: backslash escapes apply.
    if ((c === 'E' || c === 'e') && next === "'") {
      i += 2;
      let closed = false;
      while (i < n) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === "'") {
          if (s[i + 1] === "'") { i += 2; continue; }
          i++; closed = true; break;
        }
        i++;
      }
      if (!closed) return { ok: false, reason: 'unterminated_string' };
      tokens.push({ type: 'string', value: '' });
      continue;
    }

    // '…' standard string ('' escapes a quote). Also covers B'', X'', U&''
    // because their prefix letter tokenizes as a word just before.
    if (c === "'") {
      i++;
      let closed = false;
      while (i < n) {
        if (s[i] === "'") {
          if (s[i + 1] === "'") { i += 2; continue; }
          i++; closed = true; break;
        }
        i++;
      }
      if (!closed) return { ok: false, reason: 'unterminated_string' };
      tokens.push({ type: 'string', value: '' });
      continue;
    }

    // "quoted identifier" ("" escapes a quote)
    if (c === '"') {
      i++;
      let closed = false;
      let val = '';
      while (i < n) {
        if (s[i] === '"') {
          if (s[i + 1] === '"') { val += '"'; i += 2; continue; }
          i++; closed = true; break;
        }
        val += s[i];
        i++;
      }
      if (!closed) return { ok: false, reason: 'unterminated_identifier' };
      tokens.push({ type: 'ident', value: val });
      continue;
    }

    // $tag$ … $tag$ dollar quoting. `$1` is a parameter, not a quote.
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i));
      if (m) {
        const tag = m[0];
        const end = s.indexOf(tag, i + tag.length);
        if (end === -1) return { ok: false, reason: 'unterminated_dollar_quote' };
        i = end + tag.length;
        tokens.push({ type: 'string', value: '' });
        continue;
      }
      // positional parameter $1
      let j = i + 1;
      while (j < n && /[0-9]/.test(s[j])) j++;
      tokens.push({ type: 'param', value: s.slice(i, j) });
      i = j;
      continue;
    }

    if (isWordStart(c)) {
      let j = i + 1;
      while (j < n && isWord(s[j])) j++;
      tokens.push({ type: 'word', value: s.slice(i, j) });
      i = j;
      continue;
    }

    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(next || ''))) {
      let j = i + 1;
      while (j < n && /[0-9.eE_]/.test(s[j])) j++;
      tokens.push({ type: 'number', value: s.slice(i, j) });
      i = j;
      continue;
    }

    tokens.push({ type: 'punct', value: c });
    i++;
  }
  return { ok: true, tokens };
}

function funcBlocked(name) {
  const f = name.toLowerCase();
  if (BLOCKED_FUNCS.has(f)) return true;
  if (f.startsWith('pg_')) return !PG_READ_FUNCS.has(f);
  return BLOCKED_FUNC_PREFIXES.some((p) => p !== 'pg_' && f.startsWith(p));
}

/**
 * Decide whether `sql` is one read-only statement.
 *
 * @returns {{ readOnly: boolean, reason: string|null, firstKeyword: string|null,
 *             statements: number, destructive: boolean }}
 *   `reason` names the first thing that failed (for the refusal message and
 *   the audit row). `destructive` is true when DROP or TRUNCATE appears in
 *   code anywhere (incl. ALTER TABLE … DROP COLUMN) — the write tool's
 *   confirm_destructive gate reads it.
 */
export function analyzeSql(sql) {
  const t = tokenizeSql(sql);
  if (!t.ok) return { readOnly: false, reason: t.reason, firstKeyword: null, statements: 0, destructive: false };
  const code = t.tokens.filter((x) => x.type !== 'comment');

  // Statements: split on top-level ';'. Trailing empty statements are fine.
  const stmts = [[]];
  for (const tok of code) {
    if (tok.type === 'punct' && tok.value === ';') stmts.push([]);
    else stmts[stmts.length - 1].push(tok);
  }
  const nonEmpty = stmts.filter((x) => x.length > 0);
  const destructive = code.some((x) => x.type === 'word' && /^(DROP|TRUNCATE)$/i.test(x.value));
  const firstWord = nonEmpty[0]?.find((x) => x.type === 'word');
  const firstKeyword = firstWord ? firstWord.value.toUpperCase() : null;
  const out = (readOnly, reason) => ({ readOnly, reason, firstKeyword, statements: nonEmpty.length, destructive });

  if (nonEmpty.length === 0) return out(false, 'empty');
  if (nonEmpty.length > 1) return out(false, 'multiple_statements');

  const stmt = nonEmpty[0];
  // Leading parentheses: "(SELECT …) UNION (SELECT …)".
  let k = 0;
  while (k < stmt.length && stmt[k].type === 'punct' && stmt[k].value === '(') k++;
  const lead = stmt[k];
  if (!lead || lead.type !== 'word' || !START_OK.has(lead.value.toUpperCase())) {
    return out(false, `not_a_read:${lead?.type === 'word' ? lead.value.toUpperCase() : 'unknown'}`);
  }

  for (let idx = 0; idx < stmt.length; idx++) {
    const tok = stmt[idx];
    if (tok.type !== 'word') continue;
    const up = tok.value.toUpperCase();
    if (WRITE_WORDS.has(up)) return out(false, `write_keyword:${up}`);
    if (up === 'FOR') {
      const a = stmt[idx + 1]?.type === 'word' ? stmt[idx + 1].value.toUpperCase() : '';
      if (a === 'SHARE' || a === 'KEY' || a === 'NO') return out(false, `row_lock:FOR_${a}`);
    }
    const nxt = stmt[idx + 1];
    // schema.qualified reference: block net.* / dblink.* / vault.*
    if (nxt?.type === 'punct' && nxt.value === '.' && BLOCKED_SCHEMAS.has(tok.value.toLowerCase())) {
      return out(false, `blocked_schema:${tok.value.toLowerCase()}`);
    }
    if (nxt?.type === 'punct' && nxt.value === '(' && funcBlocked(tok.value)) {
      return out(false, `blocked_function:${tok.value.toLowerCase()}`);
    }
  }
  // Quoted identifiers used as schema names ("vault".secrets) — same check.
  for (let idx = 0; idx < stmt.length - 1; idx++) {
    const tok = stmt[idx];
    if (tok.type === 'ident' && stmt[idx + 1].type === 'punct' && stmt[idx + 1].value === '.'
        && BLOCKED_SCHEMAS.has(tok.value.toLowerCase())) {
      return out(false, `blocked_schema:${tok.value.toLowerCase()}`);
    }
    if (tok.type === 'ident' && stmt[idx + 1].type === 'punct' && stmt[idx + 1].value === '(' && funcBlocked(tok.value)) {
      return out(false, `blocked_function:${tok.value.toLowerCase()}`);
    }
  }
  return out(true, null);
}

/** SQL_TOOL_MODE: readwrite (default — today's behaviour) | shadow | readonly. */
export function sqlToolMode(env = process.env) {
  const v = String(env.SQL_TOOL_MODE || '').trim().toLowerCase();
  return v === 'shadow' || v === 'readonly' ? v : 'readwrite';
}

/** SQL_WRITE_TOOL_ENABLED=true registers supabase_write_query. */
export function sqlWriteToolEnabled(env = process.env) {
  return String(env.SQL_WRITE_TOOL_ENABLED || '').trim().toLowerCase() === 'true';
}

/**
 * The mode decision for a read tool, pure.
 * @returns {{ run: boolean, decision: 'allow'|'would_deny'|'deny', analysis }}
 *   `decision` is what the audit row records; reads that pass are 'allow' and
 *   are NOT audited (volume) — only would_deny / deny are.
 */
export function decideReadQuery(sql, mode) {
  const analysis = analyzeSql(sql);
  if (analysis.readOnly || mode === 'readwrite') return { run: true, decision: 'allow', analysis };
  if (mode === 'shadow') return { run: true, decision: 'would_deny', analysis };
  return { run: false, decision: 'deny', analysis };
}
