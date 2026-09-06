/**
 * Parity test for sql/092_memory_taxonomy_area_workflow_ref.sql.
 *
 * Not mirrored in runMigrations() (claude_* tables are the skill's, not the
 * request path's). Guards the file: the 19 area values claude_area_for() can
 * return, the 12-category vocabulary named in the header, the workflow_ref
 * cache shape, and the rule that the function is IMMUTABLE (so it can back an
 * index or generated column later).
 *
 * Run: node --test scripts/test-claude-memory-taxonomy.js
 * (also picked up by `npm test`, which runs scripts/test-*.js)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', '092_memory_taxonomy_area_workflow_ref.sql'), 'utf8');

const AREAS = [
  'memory-system', 'call-intelligence', 'payroll-callcenter', 'partners-vendors',
  'five9-dialer', 'scorecard-reporting', 'calculator-lane', 'chatbot-lane',
  'canvassing', 'objections-rescue', 'nurture-reengagement', 'appointments',
  'agentic-engine', 'lp-ghl-sync', 'lead-intake', 'content-copy', 'infrastructure',
  'routing-workflows', 'general',
];

const CATEGORIES = [
  'architecture', 'routing', 'messaging', 'appointments', 'sync', 'integration',
  'data', 'agentic', 'infrastructure', 'reporting', 'compliance', 'operations',
];

test('claude_area_for is IMMUTABLE and returns exactly the 19 documented areas', () => {
  const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION claude_area_for'), sql.indexOf('ALTER TABLE claude_session_logs'));
  assert.match(fn, /LANGUAGE sql IMMUTABLE/);
  const returned = [...fn.matchAll(/THEN '([a-z0-9-]+)'/g)].map(m => m[1]);
  const withElse = [...returned, ...(fn.match(/ELSE 'general'/) ? ['general'] : [])];
  for (const a of AREAS) assert.ok(withElse.includes(a), `area not produced by function: ${a}`);
  for (const r of new Set(withElse)) assert.ok(AREAS.includes(r), `undocumented area produced: ${r}`);
});

test('the 12-category vocabulary is stated and category_raw exists on both tables', () => {
  for (const c of CATEGORIES) assert.ok(sql.includes(c), `category missing from header: ${c}`);
  assert.match(sql, /ALTER TABLE claude_decision_log ADD COLUMN IF NOT EXISTS category_raw text/);
  assert.match(sql, /ALTER TABLE claude_known_issues ADD COLUMN IF NOT EXISTS category_raw text/);
});

test('area is added to all four memory tables', () => {
  for (const t of ['claude_session_logs', 'claude_decision_log', 'claude_known_issues', 'claude_pending_items']) {
    assert.match(sql, new RegExp(`ALTER TABLE ${t}\\s+ADD COLUMN IF NOT EXISTS area text`), `${t} missing area`);
  }
});

test('claude_workflow_ref is a keyed cache with synced_at, and workflow_code exists on decisions + issues', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS claude_workflow_ref \(\s+canonical_code text PRIMARY KEY/);
  assert.match(sql, /synced_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
  assert.match(sql, /ALTER TABLE claude_decision_log ADD COLUMN IF NOT EXISTS workflow_code text/);
  assert.match(sql, /ALTER TABLE claude_known_issues ADD COLUMN IF NOT EXISTS workflow_code text/);
});

test('file is explicitly not mirrored and never destructive', () => {
  assert.match(sql, /NOT mirrored in runMigrations\(\)/);
  const body = sql.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(body, /\bDROP\b/i);
  assert.doesNotMatch(body, /\bDELETE\b/i);
  assert.doesNotMatch(body, /\bTRUNCATE\b/i);
});
