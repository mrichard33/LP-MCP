/**
 * Parity test for sql/094_claude_memory_embeddings.sql.
 *
 * Not mirrored in runMigrations() (claude_* tables are the skill's, not the
 * request path's). Guards the file: the table shape the embed module writes,
 * the HNSW index, the RPC signature memory-search.js calls, the duplicate
 * exclusion, the query-log table with vector_only, and the rule that the file
 * never drops or deletes anything.
 *
 * Run: node --test scripts/test-claude-memory-embeddings.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', '094_claude_memory_embeddings.sql'), 'utf8');

test('claude_memory_embeddings has the columns memory-embed.js upserts and a unique source key', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS claude_memory_embeddings \(/);
  for (const col of ['source_table', 'source_id', 'content_hash', 'embedded_text', 'embedding', 'area', 'origin', 'status', 'severity', 'category', 'row_date', 'token_count', 'embedded_at']) {
    assert.ok(new RegExp(`\\n\\s+${col}\\s+`).test(sql), `column missing: ${col}`);
  }
  assert.match(sql, /embedding\s+vector\(1536\) NOT NULL/);
  assert.match(sql, /UNIQUE \(source_table, source_id\)/);
});

test('HNSW cosine index matches the KB tier settings', () => {
  assert.match(sql, /idx_claude_memory_emb_hnsw\s+ON claude_memory_embeddings USING hnsw \(embedding vector_cosine_ops\)\s+WITH \(m = 16, ef_construction = 64\)/);
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ''), /CONCURRENTLY/);
});

test('match_memory_embeddings has the signature memory-search.js calls and excludes duplicates', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION match_memory_embeddings \(\s+query_embedding vector\(1536\),\s+match_threshold FLOAT8\s+DEFAULT 0\.30,\s+match_count\s+INTEGER DEFAULT 20,\s+filter_area\s+TEXT\s+DEFAULT NULL,\s+filter_kind\s+TEXT\s+DEFAULT NULL,[^)]*include_closed\s+BOOLEAN DEFAULT true/);
  assert.match(sql, /coalesce\(e\.status,''\) <> 'duplicate'/);
  for (const k of ['decision', 'issue', 'session', 'pending']) assert.match(sql, new RegExp(`WHEN '${k}'\\s+THEN`), `kind mapping missing: ${k}`);
  assert.match(sql, /LANGUAGE sql STABLE/);
});

test('memory_vector_queries carries the shadow evidence columns', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS memory_vector_queries \(/);
  for (const col of ['mode', 'query_text', 'fts_count', 'vector_count', 'fused_count', 'vector_only', 'top_similarity', 'top_hits', 'latency_ms', 'error']) {
    assert.ok(new RegExp(`\\n\\s+${col}\\s+`).test(sql), `column missing: ${col}`);
  }
});

test('file is explicitly not mirrored and never destructive', () => {
  assert.match(sql, /NOT mirrored in runMigrations\(\)/);
  const body = sql.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(body, /\bDROP\b/i);
  assert.doesNotMatch(body, /\bDELETE\b/i);
  assert.doesNotMatch(body, /\bTRUNCATE\b/i);
});
