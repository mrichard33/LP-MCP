/**
 * Parity test for sql/093_memory_area_trigger.sql.
 *
 * Not mirrored in runMigrations() (claude_* tables are the skill's, not the
 * request path's). Guards the file: one BEFORE INSERT trigger on each of the
 * four memory tables, the early return that protects an explicitly supplied
 * area, the 'general' → parent-session fallback, and the rule that the file
 * never drops or deletes anything (CREATE OR REPLACE TRIGGER, not DROP + CREATE).
 *
 * Run: node --test scripts/test-claude-memory-area-trigger.js
 * (also picked up by `npm test`, which runs scripts/test-*.js)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', '093_memory_area_trigger.sql'), 'utf8');

const TABLES = ['claude_session_logs', 'claude_decision_log', 'claude_known_issues', 'claude_pending_items'];

test('claude_set_area is a plpgsql trigger function that never overwrites a supplied area', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION claude_set_area\(\)\s+RETURNS trigger LANGUAGE plpgsql/);
  assert.match(sql, /IF NEW\.area IS NOT NULL THEN RETURN NEW; END IF;/);
  assert.match(sql, /NEW\.area := COALESCE\(a, 'general'\);/);
});

test('every memory table gets one BEFORE INSERT trigger via CREATE OR REPLACE', () => {
  for (const t of TABLES) {
    assert.match(
      sql,
      new RegExp(`CREATE OR REPLACE TRIGGER trg_claude_set_area BEFORE INSERT ON ${t}\\s+FOR EACH ROW EXECUTE FUNCTION claude_set_area\\(\\);`),
      `${t} missing trigger`,
    );
  }
  assert.equal((sql.match(/CREATE OR REPLACE TRIGGER trg_claude_set_area/g) || []).length, 4);
});

test('function branches on all four tables and falls back to the parent session area', () => {
  for (const t of TABLES) assert.ok(sql.includes(`WHEN '${t}' THEN`), `no CASE branch for ${t}`);
  assert.match(sql, /IF a = 'general' AND parent_id IS NOT NULL THEN/);
  assert.match(sql, /SELECT COALESCE\(area, 'general'\) INTO a FROM claude_session_logs WHERE id = parent_id;/);
  assert.match(sql, /a := claude_area_for\(txt\);/);
});

test('file is explicitly not mirrored and never destructive', () => {
  assert.match(sql, /NOT mirrored in runMigrations\(\)/);
  const body = sql.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(body, /\bDROP\b/i);
  assert.doesNotMatch(body, /\bDELETE\b/i);
  assert.doesNotMatch(body, /\bTRUNCATE\b/i);
});
