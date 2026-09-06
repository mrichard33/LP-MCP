/**
 * Pure tests for src/memory/memory-gate.js and src/memory/memory-text.js.
 * No env needed. Run: node --test scripts/test-memory-gate.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getMemoryVectorMode, fuseResults, statusWeight, recencyBoost } from '../src/memory/memory-gate.js';
import { stripPii, memoryText, contentHash, toEmbeddingRow, SESSION_TEXT_CAP } from '../src/memory/memory-text.js';

test('mode defaults to off and rejects unknown values', () => {
  assert.equal(getMemoryVectorMode({}), 'off');
  assert.equal(getMemoryVectorMode({ MEMORY_VECTOR_MODE: 'Shadow ' }), 'shadow');
  assert.equal(getMemoryVectorMode({ MEMORY_VECTOR_MODE: 'live' }), 'live');
  assert.equal(getMemoryVectorMode({ MEMORY_VECTOR_MODE: 'yes' }), 'off');
});

test('a row found by both legs outranks a row found by one; vector_only counts the gap', () => {
  const fts = [
    { kind: 'decision', id: 566, date: '2026-08-15', text: 'appointment title', origin: 'live', status: 'active', rank: 0.9 },
    { kind: 'issue', id: 534, date: '2026-08-19', text: 'empty body', origin: 'live', status: 'open', rank: 0.5 },
  ];
  const vec = [
    { kind: 'session', source_id: 142, row_date: '2026-08-11', text: 'title root cause', origin: 'live', status: null, similarity: 0.61 },
    { kind: 'decision', source_id: 566, row_date: '2026-08-15', text: 'appointment title', origin: 'live', status: 'active', similarity: 0.58 },
  ];
  const out = fuseResults(fts, vec, { limit: 10, today: new Date('2026-08-20') });
  assert.equal(out.results[0].kind, 'decision');
  assert.equal(out.results[0].id, 566);
  assert.equal(out.results[0].fts_rank, 1);
  assert.equal(out.results[0].vec_rank, 2);
  assert.equal(out.vector_only, 1);
  assert.equal(out.fts_count, 2);
  assert.equal(out.vector_count, 2);
  assert.equal(out.results.length, 3);
});

test('duplicates never surface; superseded and retro rank below active live rows of equal position', () => {
  const fts = [
    { kind: 'issue', id: 1, date: '2026-01-01', text: 'dup', origin: 'live', status: 'duplicate', rank: 1 },
    { kind: 'decision', id: 2, date: '2026-01-01', text: 'old', origin: 'live', status: 'superseded', rank: 0.9 },
    { kind: 'decision', id: 3, date: '2026-01-01', text: 'retro', origin: 'retro', status: 'active', rank: 0.9 },
    { kind: 'decision', id: 4, date: '2026-01-01', text: 'cur', origin: 'live', status: 'active', rank: 0.9 },
  ];
  const out = fuseResults(fts, [], { today: new Date('2026-06-01') });
  assert.ok(!out.results.some((r) => r.id === 1), 'duplicate leaked');
  assert.ok(statusWeight('superseded') < statusWeight('active'));
  assert.ok(statusWeight('duplicate') < 1); // unknown-ish statuses still get a weight; exclusion is by filter
  const byId = Object.fromEntries(out.results.map((r) => [r.id, r.score]));
  assert.ok(byId[2] < byId[4] * 0.8, 'superseded not penalised enough');
  assert.ok(byId[3] < byId[4], 'retro not below live');
});

test('recency boost is stepped and never negative', () => {
  const today = new Date('2026-09-06');
  assert.equal(recencyBoost('2026-09-01', today), 0.15);
  assert.equal(recencyBoost('2026-07-01', today), 0.05);
  assert.equal(recencyBoost('2026-01-01', today), 0);
  assert.equal(recencyBoost(null, today), 0);
});

test('stripPii replaces phones and emails and leaves ids, codes and uuids alone', () => {
  const s = stripPii('Call (954) 890-1067 or 954.890.1067 or +1 954-890-1067; mail bob@reece.com; contact 8e30ff37 ran S4.5 for 42d4130b-09b4-4c32-8c5b-e56d7db51d53 issue #724');
  assert.ok(!/954/.test(s), 'phone leaked');
  assert.ok(!/@/.test(s), 'email leaked');
  assert.ok(s.includes('8e30ff37') && s.includes('S4.5') && s.includes('#724'));
  assert.ok(s.includes('42d4130b-09b4-4c32-8c5b-e56d7db51d53'));
  assert.equal((s.match(/\[phone\]/g) || []).length, 3);
  assert.equal((s.match(/\[email\]/g) || []).length, 1);
});

test('memoryText builds a typed prefix and caps sessions', () => {
  assert.match(memoryText('decision', { category: 'routing', area: 'appointments', decision: 'X', rationale: 'Y', workflow_code: 'A.WE-1' }),
    /^Decision \(routing, appointments\): X\nRationale: Y\nWorkflow: A\.WE-1$/);
  assert.match(memoryText('issue', { severity: 'high', category: 'data', description: 'D' }), /^Issue \(high, data, general\): D$/);
  const long = memoryText('session', { session_date: '2026-09-06', session_title: 'T', raw_summary: 'x'.repeat(SESSION_TEXT_CAP + 500) });
  assert.ok(long.length < SESSION_TEXT_CAP + 100);
  assert.match(memoryText('pending', { kind: 'next_step', item_type: 'next_step', description: 'P', ref: 'r' }), /^Pending next_step \(next_step, general\): P\nRef: r$/);
  assert.throws(() => memoryText('nope', {}));
});

test('content hash changes on text, status or area; toEmbeddingRow strips PII and maps columns', () => {
  const a = contentHash('t', 'open', 'x'); const b = contentHash('t', 'resolved', 'x'); const c = contentHash('t', 'open', 'y');
  assert.notEqual(a, b); assert.notEqual(a, c); assert.equal(a, contentHash('t', 'open', 'x'));
  const row = toEmbeddingRow('issue', { id: 7, reported_date: '2026-08-01', severity: 'low', category: 'data', description: 'Phone 954-890-1067', impact: null, area: 'five9-dialer', origin: 'retro', status: 'open' });
  assert.equal(row.source_table, 'claude_known_issues');
  assert.equal(row.source_id, 7);
  assert.equal(row.severity, 'low');
  assert.equal(row.origin, 'retro');
  assert.equal(row.row_date, '2026-08-01');
  assert.ok(row.embedded_text.includes('[phone]'));
});
