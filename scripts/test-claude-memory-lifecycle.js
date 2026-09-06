/**
 * Parity test for sql/091_memory_lifecycle_pending_items.sql.
 *
 * Like sql/090, this migration is NOT mirrored in runMigrations() (the
 * claude_* tables are written by the reece-session-continuity skill, not by
 * LP-MCP's request path). The test guards the file: the columns the skill v4
 * writes, the pending-items table and its provenance UNIQUE, and the rules
 * the context pack v3 encodes (defect-only counts, active-only decisions,
 * table-sourced pending work).
 *
 * Run: node --test scripts/test-claude-memory-lifecycle.js
 * (also picked up by `npm test`, which runs scripts/test-*.js)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', '091_memory_lifecycle_pending_items.sql'), 'utf8');

test('issue triage columns are all added, idempotently', () => {
  for (const col of ['merged_into', 'issue_type', 'verified_at', 'verification_note', 'stale']) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\b`), `${col} missing`);
  }
  assert.match(sql, /issue_type\s+text\s+NOT NULL DEFAULT 'defect'/);
  assert.match(sql, /stale\s+boolean NOT NULL DEFAULT false/);
});

test('decision lifecycle columns are added with the active default', () => {
  assert.match(sql, /ALTER TABLE claude_decision_log[\s\S]*ADD COLUMN IF NOT EXISTS status\s+text NOT NULL DEFAULT 'active'/);
  assert.match(sql, /superseded_by integer REFERENCES claude_decision_log\(id\)/);
});

test('claude_pending_items exists with provenance uniqueness and both session FKs', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS claude_pending_items/);
  assert.match(sql, /UNIQUE \(source_session_id, source_field, source_index\)/);
  assert.match(sql, /source_session_id\s+integer NOT NULL REFERENCES claude_session_logs\(id\)/);
  assert.match(sql, /resolved_session_id integer REFERENCES claude_session_logs\(id\)/);
  assert.match(sql, /raw\s+jsonb/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_claude_pending_status_date/);
});

test('context pack v3 encodes the triage rules', () => {
  const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION claude_memory_context'));
  assert.ok(fn.length > 1000, 'function body present');
  // defect-only issue list and counts
  assert.ok((fn.match(/issue_type = 'defect'/g) || []).length >= 6, 'defect filter on list + counts');
  // fresh before stale, live before retro
  assert.match(fn, /ORDER BY \(origin = 'live'\) DESC, stale ASC/);
  // active decisions only
  assert.match(fn, /AND status = 'active'/);
  // pending work comes from the table, never from session JSON
  assert.match(fn, /FROM claude_pending_items p/);
  assert.doesNotMatch(fn, /jsonb_array_elements\([^)]*pending_items/, 'v3 must not read pending_items JSON');
  // caps intact
  for (const cap of ['LIMIT 25', 'LIMIT 15', 'LIMIT 20', 'left(l.raw_summary, 1500)']) {
    assert.ok(fn.includes(cap), `cap missing: ${cap}`);
  }
});

test('file is explicitly not mirrored and never destructive', () => {
  assert.match(sql, /NOT mirrored in runMigrations\(\)/);
  const body = sql.replace(/--[^\n]*/g, '');           // strip comments (ROLLBACK notes live there)
  assert.doesNotMatch(body, /\bDROP\b/i);
  assert.doesNotMatch(body, /\bDELETE\b/i);
  assert.doesNotMatch(body, /\bTRUNCATE\b/i);
});
