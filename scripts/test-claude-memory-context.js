/**
 * Parity test for sql/090_claude_memory_context.sql.
 *
 * The migration is NOT mirrored in runMigrations() (see the file header —
 * LP-MCP's request path has no stake in the claude_* tables), so there is no
 * live DDL to compare against. What this test guards is the file itself: the
 * two function signatures the reece-session-continuity skill calls, the three
 * FTS indexes, and the rule that the tsvector expression inside each index is
 * repeated verbatim inside the functions (otherwise the planner cannot use it).
 *
 * Run: node --test scripts/test-claude-memory-context.js
 * (also picked up by `npm test`, which runs scripts/test-*.js)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', '090_claude_memory_context.sql'), 'utf8');

test('sql/090 defines both functions the skill calls', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION claude_memory_context\(p_topic text DEFAULT NULL\)/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION claude_memory_search\(p_query text, p_limit integer DEFAULT 20\)/);
});

test('sql/090 creates the three FTS indexes, plain (not CONCURRENTLY)', () => {
  for (const name of ['idx_claude_decision_fts', 'idx_claude_issues_fts', 'idx_claude_sessions_fts']) {
    assert.match(sql, new RegExp(`CREATE INDEX IF NOT EXISTS ${name}\\b`), `${name} missing`);
  }
  // The header comment mentions the word ("not CONCURRENTLY"); only the DDL form is forbidden.
  assert.doesNotMatch(sql, /CREATE\s+INDEX\s+CONCURRENTLY/i, 'CREATE INDEX CONCURRENTLY must not appear — tables are tiny and the tool wraps in a transaction');
});

test('each index expression is repeated verbatim inside the functions', () => {
  const exprs = [
    "to_tsvector('english', coalesce(decision,'') || ' ' || coalesce(rationale,''))",
    "to_tsvector('english', coalesce(description,'') || ' ' || coalesce(impact,''))",
    "to_tsvector('english', coalesce(session_title,'') || ' ' || coalesce(raw_summary,''))",
  ];
  for (const e of exprs) {
    // once in the index, at least twice in the function bodies (WHERE + ts_rank), aliased with a table prefix
    const bare = sql.split(e).length - 1;
    const aliased = sql.split(e.replace(/coalesce\((\w+)/g, (m, c) => `coalesce(X.${c}`)).length - 1;
    assert.ok(bare >= 1, `index expression missing: ${e}`);
    const prefixed = (sql.match(new RegExp(e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/coalesce\\\((\w+)/g, 'coalesce\\((?:[a-z]\\.)?$1'), 'g')) || []).length;
    assert.ok(prefixed >= 3, `expression not reused in functions (found ${prefixed}): ${e}`);
    void aliased;
  }
});

test('the pack never removes the size caps', () => {
  for (const cap of ['LIMIT 25', 'LIMIT 15', 'LIMIT 20', 'left(raw_summary, 1500)']) {
    assert.ok(sql.includes(cap), `cap missing: ${cap}`);
  }
});

test('sql/090 is explicitly not mirrored in runMigrations()', () => {
  assert.match(sql, /NOT mirrored in runMigrations\(\)/);
});
