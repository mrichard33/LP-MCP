/**
 * Tests for the memory integrity layer (sql/098, 2026-09-08). No env needed —
 * every database and OpenAI call is a fake. Pure, so a second run makes the
 * same assertions with the same results (idempotent by construction).
 *
 * Covers section 11 of the handoff where it can be covered without a live
 * database:
 *   - retro checkpoint without a source is rejected with the guard's message
 *   - retro checkpoint with a source: session retro, dated from the chat,
 *     ledger row in the same sequence, link exact
 *   - live checkpoint dated in the future or > 400 days back is rejected
 *   - batch pattern: shadow logs + writes, live rejects
 *   - conflict rule: cosine ≥ threshold with no supersedes_id / same_as_id →
 *     shadow logs, live rejects naming the id; supersedes_id supersedes;
 *     same_as_id re-confirms instead of inserting
 *   - memory_precheck verdicts
 *   - validation checks / repairs / log rows; conflict scan; draft checkpoints
 *   - admin routes: n8n event door (never a decision), manual validate
 *   - sql/098 file guards and the boot presence check
 *
 * Run: node --test scripts/test-memory-integrity.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateCheckpoint, planCheckpoint, applyCheckpoint, CheckpointError, RETRO_SOURCE_MESSAGE,
  getGuardMode, getConflictThreshold, getMaxDateAgeDays, decisionText, checkpointKeyFor,
} from '../src/memory/memory-checkpoint.js';
import { memoryPrecheck, classify, NEXT_STEP } from '../src/memory/memory-precheck.js';
import { fuseResults, dateConfidenceWeight, originWeight, statusWeight } from '../src/memory/memory-gate.js';
import { MEMORY_MIGRATIONS } from '../src/memory/memory-migrations.js';
import {
  VALIDATION_CHECKS, REPAIR_METADATA_SYNC_SQL, REPAIR_ORPHANS_SQL, validationLogSql,
  runMemoryValidation, runDraftCheckpoints, draftSessionRow, DRAFT_CANDIDATES_SQL,
} from '../src/jobs/memory-validate.js';
import { conflictScanSql, conflictInsertSql, normalizePairs, runConflictScan, thresholdFor } from '../src/jobs/memory-conflicts.js';
import { parseEvent, writeEvent, registerAdminMemoryRoutes } from '../src/routes/admin-memory.js';
import { runMemoryNightly, formatDigest, DIGEST_CONFLICTS_SQL, DIGEST_UNLINKED_SQL, DIGEST_VALIDATION_SQL } from '../src/jobs/memory-nightly.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql098 = fs.readFileSync(path.join(__dirname, '..', 'sql', '098_memory_integrity.sql'), 'utf8');
const sql100 = fs.readFileSync(path.join(__dirname, '..', 'sql', '100_provenance_inherit_narrow.sql'), 'utf8');
const queriesRef = fs.readFileSync(path.join(__dirname, '..', 'docs', 'skills', 'reece-session-continuity', 'references', 'queries.md'), 'utf8');

const NOW = new Date('2026-09-08T16:00:00Z');          // 12:00 ET, 2026-09-08
const NO_RETRY = false;
const ENV_LIVE = { MEMORY_GUARD_MODE: 'live' };
const ENV_SHADOW = { MEMORY_GUARD_MODE: 'shadow' };
const ENV_OFF = { MEMORY_GUARD_MODE: 'off' };

/**
 * Chainable fake Supabase client. seed:
 *   session      row for a lookup by id
 *   liveRecent   count returned for the batch-pattern query
 *   rpc          (name, args) => { data, error }
 *   rows         (ctx) => data for a plain select (by table)
 */
function fakeDb(seed = {}) {
  const calls = [];
  let nextId = 900;
  const make = (table) => {
    const ctx = { table, op: null, payload: null, filters: [], count: false, orFilter: null };
    const chain = {
      select(_cols, opts) { if (opts && opts.count) ctx.count = true; return chain; },
      eq(k, v) { ctx.filters.push([k, v]); return chain; },
      gte(k, v) { ctx.filters.push([`${k}>=`, v]); return chain; },
      in(k, v) { ctx.filters.push([`${k} in`, v]); return chain; },
      or(expr) { ctx.orFilter = expr; return chain; },
      order() { return chain; }, limit() { return chain; },
      insert(p) { ctx.op = 'insert'; ctx.payload = p; return chain; },
      update(p) { ctx.op = 'update'; ctx.payload = p; return chain; },
      upsert(p) { ctx.op = 'upsert'; ctx.payload = p; return chain; },
      single() { return finish(); }, maybeSingle() { return finish(true); },
      then(res, rej) { return finish().then(res, rej); },
    };
    const finish = async (maybe) => {
      calls.push({ ...ctx });
      if (ctx.count) return { data: null, count: seed.liveRecent ?? 0, error: null };
      if (ctx.op === 'insert') return { data: { id: nextId++ }, error: null };
      if (ctx.op === null && seed.rows) { const r = seed.rows(ctx); if (r !== undefined) return { data: r, error: null }; }
      if (ctx.op === null && table === 'claude_session_logs' && maybe) return { data: seed.session ?? null, error: null };
      if (ctx.op === null && table === 'claude_pending_items') return { data: [], error: null };
      if (ctx.op === null && table === 'claude_known_issues') return { data: [], error: null };
      if (ctx.op === null && table === 'claude_memory_conflicts') return { data: seed.conflicts ?? [], error: null };
      return { data: null, error: null };
    };
    return chain;
  };
  return { from: (t) => make(t), rpc: async (name, args) => (seed.rpc ? seed.rpc(name, args) : { data: [], error: null }), calls };
}
const ins = (db, table) => db.calls.filter((c) => c.table === table && c.op === 'insert');
const upd = (db, table) => db.calls.filter((c) => c.table === table && c.op === 'update');

const live = {
  session: { title: 'Live T', summary: 'S', search_keys: ['sql/098', 'memory_precheck', 'claude_memory_conflicts'], surface: 'chat' },
};
const retroSource = { chat_url: 'https://claude.ai/chat/abc', chat_title: 'Old chat', chat_updated_at: '2026-04-02T15:00:00Z' };
const retro = { mode: 'retro', source: retroSource, session: { ...live.session, title: 'Retro T' } };

// ─── sql/098 file guards ─────────────────────────────────────────────────────
test('sql/098 is additive and idempotent: IF NOT EXISTS columns/tables, OR REPLACE functions/triggers, no data deletes', () => {
  assert.equal((sql098.match(/ADD COLUMN IF NOT EXISTS/g) || []).length, 8, '3 session + 2 decision + 1 issue + 2 embedding columns');
  assert.match(sql098, /CREATE TABLE IF NOT EXISTS claude_memory_conflicts \(/);
  assert.match(sql098, /CREATE TABLE IF NOT EXISTS claude_memory_validation_log \(/);
  assert.match(sql098, /UNIQUE \(kind, row_a, row_b\)/);
  assert.equal((sql098.match(/CREATE OR REPLACE TRIGGER/g) || []).length, 3);
  const body = sql098.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(body, /\bDELETE\b|\bTRUNCATE\b|DROP TABLE|DROP COLUMN/i);
  const drops = body.match(/DROP FUNCTION IF EXISTS \w+/g) || [];
  assert.deepEqual(drops, ['DROP FUNCTION IF EXISTS match_memory_embeddings', 'DROP FUNCTION IF EXISTS claude_memory_search'], 'only the two signature changes drop, and both are recreated');
  assert.match(sql098, /ROLLBACK/);
});

test('sql/098 guard trigger: retro needs a source, a live burst is relabelled (marked, never rejected); children inherit provenance', () => {
  assert.match(sql098, /IF NEW\.log_origin = 'retro' AND \(NEW\.chat_url IS NULL OR NEW\.source_chat_updated_at IS NULL\) THEN\s+RAISE EXCEPTION 'retro session requires chat_url and source_chat_updated_at'/);
  assert.match(sql098, /IF recent_live >= 3 THEN[^\n]*\n\s+NEW\.log_origin\s+:= 'retro';\s+NEW\.date_confidence\s+:= 'write_date';\s+NEW\.validation_status := 'flagged';/);
  assert.doesNotMatch(sql098.slice(sql098.indexOf('recent_live >= 3'), sql098.indexOf('claude_inherit_provenance')), /RAISE EXCEPTION/, 'the batch rule marks, it never rejects');
  assert.match(sql098, /'batch_pattern_relabeled'/);
  assert.match(sql098, /BEFORE INSERT ON claude_session_logs\s+FOR EACH ROW EXECUTE FUNCTION claude_guard_session_insert\(\)/);
  assert.match(sql098, /IF p_origin = 'retro' AND coalesce\(NEW\.origin, 'live'\) = 'live' THEN\s+NEW\.origin := 'retro';/);
  assert.match(sql098, /IF p_date_conf = 'write_date' AND coalesce\(NEW\.date_confidence, 'exact'\) = 'exact' THEN\s+NEW\.date_confidence := 'write_date';/);
  assert.match(sql098, /BEFORE INSERT ON claude_decision_log\s+FOR EACH ROW EXECUTE FUNCTION claude_inherit_provenance\(\)/);
  assert.match(sql098, /BEFORE INSERT ON claude_known_issues\s+FOR EACH ROW EXECUTE FUNCTION claude_inherit_provenance\(\)/);
});

test('sql/098 search: closed rows hidden by default on both legs, date_confidence returned, same parameter names as sql/094', () => {
  assert.match(sql098, /filter_kind\s+TEXT\s+DEFAULT NULL,[^)]*include_closed\s+BOOLEAN DEFAULT false/);
  assert.match(sql098, /severity TEXT, category TEXT, row_date DATE, similarity FLOAT8, date_confidence TEXT/);
  assert.match(sql098, /AND NOT e\.stale_embedding/);
  assert.match(sql098, /\(include_closed OR coalesce\(e\.status,''\) NOT IN\s+\('superseded','rejected','resolved','done','dropped','archived','expired','wont_fix'\)\)/);
  assert.match(sql098, /CREATE OR REPLACE FUNCTION claude_memory_search\(p_query text, p_limit integer DEFAULT 20, p_include_closed boolean DEFAULT false\)/);
  assert.match(sql098, /left\(d\.decision, 300\) AS text, d\.origin, d\.status,/, 'decisions return their real status now');
  assert.match(sql098, /p_include_closed OR coalesce\(d\.status,'active'\) NOT IN \('superseded','rejected','duplicate','expired'\)/);
  assert.match(sql098, /FROM claude_memory_search\(p_topic, 20\)\)/, 'the pack still makes the two-argument call');
});

test('sql/098 pack v5: write_date demotion reaches decisions and issues; open_conflicts and integrity counts added; sql/097 shape kept', () => {
  const issues = sql098.slice(sql098.indexOf("'open_issues_priority'"), sql098.indexOf("'decisions_30d'"));
  assert.match(issues, /coalesce\(s\.date_confidence,'exact'\) = 'write_date' OR coalesce\(i\.date_confidence,'exact'\) = 'write_date'\) ASC/);
  const decisions = sql098.slice(sql098.indexOf("'decisions_30d'"), sql098.indexOf("'resolved_30d'"));
  assert.match(decisions, /AND coalesce\(d\.date_confidence,'exact'\) <> 'write_date'/);
  assert.match(decisions, /coalesce\(s\.date_confidence,'exact'\) <> 'write_date'/);
  assert.match(sql098, /'open_conflicts', \(SELECT jsonb_agg\(r\) FROM \(\s+SELECT id, kind, row_a, row_b/);
  for (const k of ['open_conflicts', 'unlinked_sessions', 'write_date_sessions', 'flagged_sessions']) assert.ok(sql098.includes(`AS ${k}`), `count missing: ${k}`);
  for (const kept of ["WHERE l.date_confidence <> 'write_date'", 'ORDER BY l.session_date DESC, l.created_at DESC LIMIT 1', "AND p.status IN ('open','blocked','deferred')", 'AS open_pending_items_30d', 'AS active_decisions']) {
    assert.ok(sql098.includes(kept), `sql/097 behaviour lost: ${kept}`);
  }
});

test('sql/098, 099 and 100 are mirrored in the boot presence check, in order', () => {
  const m = MEMORY_MIGRATIONS.find((x) => x.file === '098_memory_integrity.sql');
  assert.ok(m); assert.match(m.check, /trg_claude_guard_session_insert/); assert.match(m.check, /claude_memory_conflicts/);
  const k = MEMORY_MIGRATIONS.find((x) => x.file === '099_checkpoint_key_deterministic.sql');
  assert.ok(k); assert.match(k.check, /claude_checkpoint_key/);
  const w = MEMORY_MIGRATIONS.find((x) => x.file === '100_provenance_inherit_narrow.sql');
  assert.ok(w); assert.match(w.check, /claude_inherit_provenance/); assert.match(w.check, /in_parent_window/);
  // Order matters, not position: sql/100 replaces a function sql/098 creates,
  // and sql/101 replaces the pack sql/098 last defined. New files append.
  const order = MEMORY_MIGRATIONS.map((x) => x.file);
  const at = (f) => order.indexOf(f);
  assert.ok(at('098_memory_integrity.sql') < at('099_checkpoint_key_deterministic.sql'));
  assert.ok(at('099_checkpoint_key_deterministic.sql') < at('100_provenance_inherit_narrow.sql'),
    'sql/100 must apply after 098 — it replaces the function 098 creates');
  assert.ok(at('100_provenance_inherit_narrow.sql') < at('101_omi_memory_source.sql'),
    'sql/101 must apply after 098 — it replaces the pack 098 last defined');
});

// ─── sql/101: Omi as an unconfirmed memory source ───────────────────────────
test('sql/101 is mirrored in the boot check as BOTH the writer function and the widened surface CHECK', () => {
  const rows = MEMORY_MIGRATIONS.filter((x) => x.file === '101_omi_memory_source.sql');
  assert.equal(rows.length, 2, 'the function alone is not enough — the constraint has to be there too');
  assert.ok(rows.some((r) => /claude_omi_ingest/.test(r.check)));
  assert.ok(rows.some((r) => /claude_session_logs_surface_check/.test(r.check) && /omi/.test(r.check)));
});

// ─── sql/100: provenance inheritance scoped to the parent's checkpoint ───────
test('sql/100 replaces only the inherit function, scopes both fields to the window, and leaves the session guard alone', () => {
  assert.match(sql100, /CREATE OR REPLACE FUNCTION claude_inherit_provenance\(\) RETURNS trigger/);
  const stmts = sql100.replace(/--[^\n]*/g, '');   // count statements, not the prose describing them
  assert.equal((stmts.match(/CREATE OR REPLACE FUNCTION/g) || []).length, 1, 'one function, nothing else');
  assert.doesNotMatch(stmts, /CREATE OR REPLACE TRIGGER/, 'the sql/098 triggers keep pointing at the replaced function');
  assert.doesNotMatch(stmts, /claude_guard_session_insert/, 'the session guard is not redefined here');
  // the window itself, and the early return that makes a later append stand on its own
  assert.match(sql100, /in_parent_window := p_created IS NOT NULL\s+AND p_created > now\(\) - interval '5 minutes'/);
  assert.match(sql100, /IF NOT in_parent_window THEN RETURN NEW; END IF;/);
  // both inherited fields sit AFTER that return, so both are scoped to the window
  const afterReturn = sql100.slice(sql100.indexOf('IF NOT in_parent_window THEN RETURN NEW; END IF;'));
  assert.match(afterReturn, /NEW\.origin := 'retro';/);
  assert.match(afterReturn, /NEW\.confidence := 'reconstructed';/);
  assert.match(afterReturn, /NEW\.date_confidence := 'write_date';/);
  assert.doesNotMatch(stmts, /\bDELETE\b|\bTRUNCATE\b|DROP TABLE|DROP COLUMN|\bUPDATE\b/i, 'no existing row is rewritten');
  assert.match(sql100, /ROLLBACK: re-run the claude_inherit_provenance\(\) block in/);
});

test('sql/100 uses the same 5-minute window as the checkpoint batch rule', () => {
  const windows = [...sql100.matchAll(/interval '(\d+) minutes'/g)].map((m) => m[1]);
  assert.ok(windows.length >= 1);
  assert.ok(windows.every((w) => w === '5'), `all windows must be 5 minutes, got ${windows.join()}`);
  // sql/098's batch rule and the tool constant agree with it
  assert.match(sql098, /interval '5 minutes'/);
});

test('the nightly provenance check counts only in-window children and reports refreshes separately', () => {
  const c = VALIDATION_CHECKS.find((x) => x.name === 'provenance_mismatch_children');
  assert.ok(c);
  // flagged: child created at or inside the parent's window
  assert.match(c.sql, /d\.created_at <= s\.created_at \+ interval '5 minutes'/);
  assert.match(c.sql, /i\.created_at <= s\.created_at \+ interval '5 minutes'/);
  // excluded and surfaced, not silently dropped
  assert.match(c.sql, /'refresh_children_excluded'/);
  assert.match(c.sql, /d\.created_at > s\.created_at \+ interval '5 minutes'/);
  assert.match(c.sql, /i\.created_at > s\.created_at \+ interval '5 minutes'/);
  assert.match(c.description, /later refresh keeps its own provenance/);
  assert.match(c.sql, /^\s*SELECT/);
  assert.doesNotMatch(c.sql, /\b(UPDATE|DELETE|INSERT|DROP)\b/);
});

// ─── Env defaults ────────────────────────────────────────────────────────────
test('guard mode defaults to shadow, threshold to 0.85, max age to 400 days; bad values fall back', () => {
  assert.equal(getGuardMode({}), 'shadow'); assert.equal(getGuardMode({ MEMORY_GUARD_MODE: 'LIVE ' }), 'live'); assert.equal(getGuardMode({ MEMORY_GUARD_MODE: 'maybe' }), 'shadow');
  assert.equal(getConflictThreshold({}), 0.85); assert.equal(getConflictThreshold({ MEMORY_CONFLICT_THRESHOLD: '0.9' }), 0.9); assert.equal(getConflictThreshold({ MEMORY_CONFLICT_THRESHOLD: '7' }), 0.85);
  assert.equal(getMaxDateAgeDays({}), 400); assert.equal(getMaxDateAgeDays({ MEMORY_MAX_DATE_AGE_DAYS: '30' }), 30);
});

// ─── Retro mode ──────────────────────────────────────────────────────────────
test('retro checkpoint without chat_url / chat_updated_at is rejected with the guard message; retro + session_id is rejected', () => {
  const err = (input) => { try { validateCheckpoint(input, NOW); } catch (e) { return e; } return null; };
  for (const src of [undefined, {}, { chat_url: 'https://claude.ai/chat/x' }, { chat_updated_at: '2026-04-02T15:00:00Z' }, { chat_url: 'https://claude.ai/chat/x', chat_updated_at: 'yesterday' }]) {
    const e = err({ ...retro, source: src });
    assert.ok(e instanceof CheckpointError, `should reject source ${JSON.stringify(src)}`);
    assert.ok(e.message.startsWith(RETRO_SOURCE_MESSAGE) || /must be an ISO timestamp/.test(e.message), e.message);
  }
  assert.throws(() => validateCheckpoint({ ...retro, session_id: 700 }, NOW), /retro mode creates a new session/);
  assert.throws(() => validateCheckpoint({ ...live, mode: 'sweep' }, NOW), /mode must be one of live, retro/);
});

test('retro checkpoint with a source: dated from the chat (ET), url + title from the source, summary prefixed, plan says so', () => {
  const c = validateCheckpoint(retro, NOW);
  assert.equal(c.mode, 'retro'); assert.equal(c.session.date, '2026-04-02'); assert.equal(c.session.date_confidence, 'exact');
  assert.equal(c.session.chat_url, retroSource.chat_url); assert.equal(c.session.chat_title, 'Old chat');
  assert.match(c.session.summary, /^\[RETRO — reconstructed from transcript on 2026-09-08\. Decisions unconfirmed by Mark are marked inferred\.\] S$/);
  const already = validateCheckpoint({ ...retro, session: { ...retro.session, summary: '[RETRO — earlier] S' } }, NOW);
  assert.equal(already.session.summary, '[RETRO — earlier] S', 'an existing prefix is not doubled');
  const p = planCheckpoint(retro, NOW, ENV_SHADOW);
  assert.equal(p.mode, 'retro'); assert.equal(p.guard_mode, 'shadow'); assert.match(p.session, /INSERT claude_session_logs \(chat, 2026-04-02, retro\)/);
  assert.equal(p.ledger, 'retro_written (exact)'); assert.deepEqual(p.source, { ...retroSource, chat_updated_at: '2026-04-02T15:00:00.000Z' });
});

test('apply (retro): session retro/exact with source_chat_updated_at, children retro/reconstructed (Mark quote → confirmed), ledger retro_written in the same sequence', async () => {
  const db = fakeDb();
  const out = await applyCheckpoint({
    ...retro,
    decisions: [{ category: 'routing', decision: 'inferred' }, { category: 'routing', decision: 'Mark said so', confirmed_by_mark: true }],
    issues: [{ severity: 'high', category: 'data', description: 'I' }],
    pending: [{ description: 'P' }],
  }, { db, now: NOW, retry: NO_RETRY, env: ENV_OFF, embed: null });
  assert.equal(out.mode, 'retro'); assert.equal(out.ledger, 'retro_written');
  const sess = ins(db, 'claude_session_logs')[0].payload;
  assert.equal(sess.log_origin, 'retro'); assert.equal(sess.session_date, '2026-04-02'); assert.equal(sess.date_confidence, 'exact');
  assert.equal(sess.link_confidence, 'exact'); assert.equal(sess.chat_url, retroSource.chat_url); assert.equal(sess.source_chat_updated_at, '2026-04-02T15:00:00.000Z');
  const [d1, d2] = ins(db, 'claude_decision_log').map((c) => c.payload);
  assert.equal(d1.origin, 'retro'); assert.equal(d1.confidence, 'reconstructed'); assert.equal(d1.decision_date, '2026-04-02');
  assert.equal(d2.origin, 'retro'); assert.equal(d2.confidence, 'confirmed');
  assert.equal(ins(db, 'claude_known_issues')[0].payload.origin, 'retro'); assert.equal(ins(db, 'claude_known_issues')[0].payload.confidence, 'reconstructed');
  assert.equal(ins(db, 'claude_pending_items')[0].payload.origin, 'retro');
  const ledger = db.calls.find((c) => c.table === 'claude_transcript_ledger');
  assert.equal(ledger.op, 'upsert'); assert.equal(ledger.payload.disposition, 'retro_written');
  assert.equal(ledger.payload.chat_updated_at, '2026-04-02T15:00:00.000Z'); assert.equal(ledger.payload.session_id, out.session_id);
  assert.ok(db.calls.indexOf(ledger) > db.calls.findIndex((c) => c.table === 'claude_session_logs' && c.op === 'insert'), 'ledger follows the session insert in one sequence');
  const liveSess = fakeDb();
  await applyCheckpoint({ ...live, decisions: [{ category: 'routing', decision: 'D' }] }, { db: liveSess, now: NOW, retry: NO_RETRY, env: ENV_OFF, embed: null });
  const lp = ins(liveSess, 'claude_session_logs')[0].payload;
  assert.equal(lp.log_origin, 'live'); assert.equal('source_chat_updated_at' in lp, false, 'live rows do not send the sql/098 column');
  assert.equal('origin' in ins(liveSess, 'claude_decision_log')[0].payload, false, 'live decisions leave origin/confidence to the column defaults and the inherit trigger');
});

// ─── Date sanity ─────────────────────────────────────────────────────────────
test('a live checkpoint dated in the future or more than 400 days back is rejected; 394 days is fine; a refresh without a date is untouched', () => {
  assert.throws(() => validateCheckpoint({ ...live, session: { ...live.session, date: '2026-09-09' } }, NOW), /is in the future \(today ET is 2026-09-08\)/);
  assert.throws(() => validateCheckpoint({ ...live, session: { ...live.session, date: '2025-08-01' } }, NOW), /more than 400 days back/);
  assert.equal(validateCheckpoint({ ...live, session: { ...live.session, date: '2025-08-10' } }, NOW).session.date, '2025-08-10');
  assert.equal(validateCheckpoint({ ...live, session: { ...live.session, date: '2025-08-01' } }, NOW, { MEMORY_MAX_DATE_AGE_DAYS: '500' }).session.date, '2025-08-01');
  assert.equal(validateCheckpoint({ session_id: 700, session: { summary: 'x' } }, NOW).session.date, '2026-09-08');
  assert.throws(() => validateCheckpoint({ session_id: 700, session: { summary: 'x', date: '2027-01-01' } }, NOW), /future/);
});

// ─── Batch pattern ───────────────────────────────────────────────────────────
test('batch pattern: 3 live rows in 5 min → shadow logs and writes; live rejects before any write; off never counts', async () => {
  const shadow = fakeDb({ liveRecent: 3 });
  const out = await applyCheckpoint(live, { db: shadow, now: NOW, retry: NO_RETRY, env: ENV_SHADOW, embed: null });
  assert.equal(out.guard.mode, 'shadow');
  assert.deepEqual(out.guard.checks.map((c) => c.check), ['batch_pattern']); assert.equal(out.guard.checks[0].live_rows_last_5_min, 3);
  assert.equal(ins(shadow, 'claude_session_logs').length, 1, 'shadow still writes');
  const log = ins(shadow, 'claude_memory_validation_log')[0].payload;
  assert.equal(log.check_name, 'guard:batch_pattern'); assert.equal(log.mode, 'shadow'); assert.equal(log.rows_flagged, 1);
  const count = shadow.calls.find((c) => c.count);
  assert.deepEqual(count.filters[0], ['log_origin', 'live']); assert.equal(count.filters[1][0], 'created_at>=');
  assert.equal(count.filters[1][1], new Date(NOW.getTime() - 5 * 60_000).toISOString());

  const strict = fakeDb({ liveRecent: 3 });
  await assert.rejects(() => applyCheckpoint(live, { db: strict, now: NOW, retry: NO_RETRY, env: ENV_LIVE, embed: null }), (e) => e instanceof CheckpointError && /3 live checkpoints already written in the last 5 minutes[\s\S]*mode "retro"/.test(e.message));
  assert.equal(ins(strict, 'claude_session_logs').length, 0);
  assert.equal(strict.calls.filter((c) => c.op && c.table !== 'claude_memory_validation_log').length, 0, 'nothing but the guard log was written');

  const under = fakeDb({ liveRecent: 2 });
  const ok = await applyCheckpoint(live, { db: under, now: NOW, retry: NO_RETRY, env: ENV_LIVE, embed: null });
  assert.deepEqual(ok.guard.checks, []);

  const off = fakeDb({ liveRecent: 9 });
  await applyCheckpoint(live, { db: off, now: NOW, retry: NO_RETRY, env: ENV_OFF, embed: null });
  assert.equal(off.calls.some((c) => c.count), false, 'off mode never runs the count');
  assert.equal(ins(off, 'claude_memory_validation_log').length, 0);

  const yesterday = fakeDb({ liveRecent: 9 });
  const y = await applyCheckpoint({ ...live, session: { ...live.session, date: '2026-09-07' } }, { db: yesterday, now: NOW, retry: NO_RETRY, env: ENV_LIVE, embed: null });
  assert.deepEqual(y.guard.checks, [], 'only rows dated today are the sweep pattern');
});

// ─── Conflict rule ───────────────────────────────────────────────────────────
const hit = (id, similarity, status = 'active') => ({ kind: 'decision', source_id: id, similarity, status, area: 'appointments', text: `Decision #${id}` });
const embedOk = async () => ({ embedding: [0.1, 0.2], tokens: 3, cost_usd: 0 });
const decisionInput = { ...live, decisions: [{ category: 'appointments', decision: 'Quiet hours clamp at 8pm', rationale: 'R' }] };

test('conflict rule: cosine ≥ threshold with no supersedes_id / same_as_id → live rejects naming the id, shadow logs and writes, off skips', async () => {
  const rpcCalls = [];
  const rpc = (name, args) => { rpcCalls.push([name, args]); return { data: [hit(55, 0.91), hit(12, 0.86)], error: null }; };
  const strict = fakeDb({ rpc });
  await assert.rejects(() => applyCheckpoint(decisionInput, { db: strict, now: NOW, retry: NO_RETRY, env: ENV_LIVE, embed: embedOk }),
    (e) => e instanceof CheckpointError && /decisions\[0\] matches active decision #55 \(cosine 0\.91\): pass supersedes_id: 55 .* same_as_id: 55/.test(e.message));
  assert.equal(ins(strict, 'claude_session_logs').length, 0);
  assert.equal(rpcCalls[0][0], 'match_memory_embeddings');
  assert.equal(rpcCalls[0][1].filter_kind, 'decision'); assert.equal(rpcCalls[0][1].include_closed, false); assert.equal(rpcCalls[0][1].match_threshold, 0.85);
  const log = ins(strict, 'claude_memory_validation_log')[0].payload;
  assert.equal(log.check_name, 'guard:conflict'); assert.equal(log.mode, 'live'); assert.equal(log.sample.nearest[0].id, 55);

  const shadow = fakeDb({ rpc });
  const out = await applyCheckpoint(decisionInput, { db: shadow, now: NOW, retry: NO_RETRY, env: ENV_SHADOW, embed: embedOk });
  assert.equal(out.conflict_check, 'ran');
  assert.equal(out.guard.checks[0].check, 'conflict'); assert.equal(out.guard.checks[0].matches[0].id, 55);
  assert.equal(ins(shadow, 'claude_decision_log').length, 1, 'shadow writes the decision');

  const under = fakeDb({ rpc: () => ({ data: [hit(55, 0.7)], error: null }) });
  const ok = await applyCheckpoint(decisionInput, { db: under, now: NOW, retry: NO_RETRY, env: ENV_LIVE, embed: embedOk });
  assert.deepEqual(ok.guard.checks, []);

  const tuned = fakeDb({ rpc: () => ({ data: [hit(55, 0.87)], error: null }) });
  await assert.rejects(() => applyCheckpoint(decisionInput, { db: tuned, now: NOW, retry: NO_RETRY, env: { ...ENV_LIVE, MEMORY_CONFLICT_THRESHOLD: '0.86' }, embed: embedOk }), /#55/);
  const tunedHigher = fakeDb({ rpc: () => ({ data: [hit(55, 0.87)], error: null }) });
  await applyCheckpoint(decisionInput, { db: tunedHigher, now: NOW, retry: NO_RETRY, env: { ...ENV_LIVE, MEMORY_CONFLICT_THRESHOLD: '0.95' }, embed: embedOk });

  const off = fakeDb({ rpc });
  const o = await applyCheckpoint(decisionInput, { db: off, now: NOW, retry: NO_RETRY, env: ENV_OFF, embed: embedOk });
  assert.equal(o.conflict_check, null); assert.equal(off.calls.some((c) => c.table === 'claude_memory_validation_log'), false);
});

test('conflict rule never blocks on OpenAI: no key → skipped; embed failure → skipped, written', async () => {
  const noKey = fakeDb({ rpc: () => { throw new Error('must not be called'); } });
  const a = await applyCheckpoint(decisionInput, { db: noKey, now: NOW, retry: NO_RETRY, env: ENV_LIVE, embed: null });
  assert.equal(a.conflict_check, 'skipped: OPENAI_API_KEY unset'); assert.equal(ins(noKey, 'claude_decision_log').length, 1);
  const failing = fakeDb({ rpc: () => ({ data: [hit(55, 0.99)], error: null }) });
  const b = await applyCheckpoint(decisionInput, { db: failing, now: NOW, retry: NO_RETRY, env: ENV_LIVE, embed: async () => { throw new Error('OpenAI HTTP 503'); } });
  assert.equal(b.conflict_check, 'skipped: OpenAI HTTP 503'); assert.equal(b.guard.checks[0].skipped, 'OpenAI HTTP 503');
  assert.equal(ins(failing, 'claude_decision_log').length, 1);
});

test('supersedes_id: inserted, old row superseded, its embedding status synced; same_as_id: nothing inserted, existing row re-confirmed', async () => {
  const rpc = () => ({ data: [hit(55, 0.91)], error: null });
  const sup = fakeDb({ rpc });
  const out = await applyCheckpoint({ ...live, decisions: [{ ...decisionInput.decisions[0], supersedes_id: 55 }] }, { db: sup, now: NOW, retry: NO_RETRY, env: ENV_LIVE, embed: embedOk });
  assert.equal(sup.calls.some((c) => c.table === 'claude_memory_validation_log'), false, 'naming the decision satisfies the rule — no guard call at all');
  assert.equal(ins(sup, 'claude_decision_log').length, 1); assert.deepEqual(out.superseded, [55]);
  const old = upd(sup, 'claude_decision_log')[0];
  assert.equal(old.payload.status, 'superseded'); assert.equal(old.payload.superseded_by, out.decision_ids[0]); assert.deepEqual(old.filters, [['id', 55]]);
  const emb = upd(sup, 'claude_memory_embeddings')[0];
  assert.deepEqual(emb.payload, { status: 'superseded' }); assert.deepEqual(emb.filters, [['source_table', 'claude_decision_log'], ['source_id', 55]]);

  const same = fakeDb({ rpc });
  const s = await applyCheckpoint({ ...live, decisions: [{ ...decisionInput.decisions[0], same_as_id: 55 }] }, { db: same, now: NOW, retry: NO_RETRY, env: ENV_LIVE, embed: embedOk });
  assert.equal(ins(same, 'claude_decision_log').length, 0, 'no second active decision on the same subject');
  assert.deepEqual(s.confirmed, [55]); assert.deepEqual(s.decision_ids, [55]);
  const conf = upd(same, 'claude_decision_log')[0];
  assert.equal(conf.payload.verified_at, NOW.toISOString()); assert.match(conf.payload.verification_note, /re-confirmed in session #900 \(2026-09-08\)/);
  assert.throws(() => validateCheckpoint({ ...live, decisions: [{ category: 'c', decision: 'd', supersedes_id: 1, same_as_id: 2 }] }, NOW), /mutually exclusive/);
  assert.equal(planCheckpoint({ ...live, decisions: [{ category: 'c', decision: 'd', same_as_id: 2 }] }, NOW).reconfirming, 1);
  assert.equal(decisionText({ category: 'c', decision: 'd', rationale: 'r' }), 'Decision (c): d\nRationale: r');
});

test('a nightly draft refreshed from inside the chat becomes a live session', async () => {
  const db = fakeDb({ session: { id: 800, transcript_search_keys: [], link_confidence: 'exact', chat_url: 'https://claude.ai/chat/d', log_origin: 'nightly' } });
  await applyCheckpoint({ session_id: 800, session: { summary: 'real summary' } }, { db, now: NOW, retry: NO_RETRY, env: ENV_OFF, embed: null });
  const patch = upd(db, 'claude_session_logs')[0].payload;
  assert.equal(patch.log_origin, 'live'); assert.equal(patch.validation_status, 'passed'); assert.equal(patch.raw_summary, 'real summary');
  const db2 = fakeDb({ session: { id: 801, transcript_search_keys: [], link_confidence: 'unlinked', chat_url: null, log_origin: 'live' } });
  await applyCheckpoint({ session_id: 801, session: { summary: 'x' } }, { db: db2, now: NOW, retry: NO_RETRY, env: ENV_OFF, embed: null });
  assert.equal('log_origin' in upd(db2, 'claude_session_logs')[0].payload, false);
});

// ─── Ranker weights ──────────────────────────────────────────────────────────
test('ranker: write_date halves a row, retro is 0.8, closed rows are 0.2; date_confidence flows through both legs', () => {
  assert.equal(dateConfidenceWeight('write_date'), 0.5); assert.equal(dateConfidenceWeight(undefined), 1); assert.equal(originWeight('retro'), 0.8); assert.equal(statusWeight('superseded'), 0.2); assert.equal(statusWeight('expired'), 0.2);
  const fts = [
    { kind: 'decision', id: 1, date: '2026-01-01', text: 'a', origin: 'live', status: 'active', date_confidence: 'write_date', rank: 1 },
    { kind: 'decision', id: 2, date: '2026-01-01', text: 'b', origin: 'live', status: 'active', date_confidence: 'exact', rank: 1 },
  ];
  const vec = [{ kind: 'decision', source_id: 3, row_date: '2026-01-01', text: 'c', origin: 'live', status: 'active', date_confidence: 'write_date', similarity: 0.9 }];
  const out = fuseResults(fts, vec, { today: new Date('2026-06-01') });
  const byId = Object.fromEntries(out.results.map((r) => [r.id, r]));
  assert.ok(Math.abs(byId[1].score - (1 / 61) * 0.5) < 1e-12, 'write_date row at fts rank 1 scores half of the plain rrf');
  assert.ok(Math.abs(byId[2].score - (1 / 62)) < 1e-12, 'exact row at fts rank 2 keeps the full rrf');
  assert.ok(byId[1].score < byId[2].score, 'a write_date row ranks below an exact row one position behind it');
  assert.equal(byId[3].date_confidence, 'write_date');
});

// ─── memory_precheck ─────────────────────────────────────────────────────────
test('precheck verdicts: clear / already_decided / previously_rejected / conflict_open, each with a next step', () => {
  assert.equal(classify({}), 'clear');
  assert.equal(classify({ active: [{ similarity: 0.9 }] }), 'already_decided');
  assert.equal(classify({ active: [{ similarity: 0.7 }] }), 'clear');
  assert.equal(classify({ active: [{ similarity: 0.9 }], closed: [{ similarity: 0.9 }] }), 'previously_rejected');
  assert.equal(classify({ closed: [{ similarity: 0.9 }], conflicts: [{ id: 1 }] }), 'conflict_open');
  for (const v of ['clear', 'already_decided', 'previously_rejected', 'conflict_open']) assert.ok(NEXT_STEP[v].length > 20);
});

test('memoryPrecheck: vector leg with history visible, same area first, conflicts looked up for the matched ids; FTS fallback without a key', async () => {
  const rpcCalls = [];
  const db = fakeDb({
    rpc: (name, args) => { rpcCalls.push([name, args]); return { data: [hit(9, 0.95, 'superseded'), { ...hit(7, 0.9), area: 'memory-system' }, hit(5, 0.88), hit(3, 0.4)], error: null }; },
    conflicts: [{ id: 1, kind: 'decision', row_a: 5, row_b: 7, similarity: 0.9, status: 'open' }],
  });
  const out = await memoryPrecheck('clamp quiet hours to 8pm', { db, area: 'memory-system', embed: embedOk, env: {} });
  assert.equal(out.leg, 'vector'); assert.equal(rpcCalls[0][1].include_closed, true); assert.equal(rpcCalls[0][1].filter_kind, 'decision');
  assert.deepEqual(out.active.map((a) => a.id), [7, 5, 3], 'same area first, then similarity');
  assert.deepEqual(out.closed_matches.map((c) => c.id), [9]);
  assert.equal(out.open_conflicts.length, 1); assert.equal(out.verdict, 'conflict_open');
  const q = db.calls.find((c) => c.table === 'claude_memory_conflicts');
  assert.match(q.orFilter, /row_a\.in\.\((7|5|9|3)(,\d+)*\),row_b\.in\./);

  const rejected = fakeDb({ rpc: () => ({ data: [hit(9, 0.95, 'rejected')], error: null }) });
  assert.equal((await memoryPrecheck('x y z', { db: rejected, embed: embedOk, env: {} })).verdict, 'previously_rejected');
  const decided = fakeDb({ rpc: () => ({ data: [hit(5, 0.9)], error: null }) });
  assert.equal((await memoryPrecheck('x y z', { db: decided, embed: embedOk, env: {} })).verdict, 'already_decided');
  const clear = fakeDb({ rpc: () => ({ data: [], error: null }) });
  assert.equal((await memoryPrecheck('x y z', { db: clear, embed: embedOk, env: {} })).verdict, 'clear');

  const ftsCalls = [];
  const fts = fakeDb({ rpc: (name, args) => { ftsCalls.push([name, args]); return { data: [{ kind: 'decision', id: 4, status: 'active', text: 't' }, { kind: 'issue', id: 8, status: 'open' }], error: null }; } });
  const f = await memoryPrecheck('x y z', { db: fts, embed: null, env: {} });
  assert.equal(f.leg, 'fts'); assert.equal(ftsCalls[0][0], 'claude_memory_search'); assert.equal(ftsCalls[0][1].p_include_closed, true);
  assert.deepEqual(f.active.map((a) => a.id), [4]); assert.equal(f.verdict, 'clear', 'no similarity on the FTS leg → never already_decided');
  await assert.rejects(() => memoryPrecheck('   ', { db: fts, embed: null, env: {} }), /proposal_text/);
});

// ─── Validation checks ───────────────────────────────────────────────────────
test('every validation check is one SELECT with rows_checked / rows_flagged / sample; the log row is escaped', () => {
  assert.equal(VALIDATION_CHECKS.length, 12);
  const names = VALIDATION_CHECKS.map((c) => c.name);
  for (const n of ['unlinked_sessions_7d', 'stale_ledger_timestamps', 'write_date_rows', 'batch_pattern_live', 'duplicate_sessions_24h', 'active_decisions_no_area', 'embedding_coverage', 'orphan_embeddings', 'embedding_metadata_drift', 'conflicts_open', 'provenance_mismatch_children', 'flagged_sessions']) assert.ok(names.includes(n), n);
  for (const c of VALIDATION_CHECKS) {
    assert.match(c.sql, /^\s*SELECT/, c.name);
    for (const col of ['rows_checked', 'rows_flagged', 'sample']) assert.ok(c.sql.includes(`AS ${col}`), `${c.name} lacks ${col}`);
    assert.doesNotMatch(c.sql, /\b(UPDATE|DELETE|INSERT|DROP)\b/);
  }
  const log = validationLogSql({ check_name: "it's", mode: 'nightly', rows_checked: 10, rows_flagged: 2, sample: { a: "b'c" }, notes: null });
  assert.match(log, /^INSERT INTO claude_memory_validation_log/);
  assert.ok(log.includes("'it''s', 'nightly', 10, 2, '{\"a\":\"b''c\"}'::jsonb, NULL"));
  for (const s of REPAIR_METADATA_SYNC_SQL) { assert.match(s, /^UPDATE claude_memory_embeddings e SET/); assert.doesNotMatch(s, /DELETE/); }
  assert.match(REPAIR_ORPHANS_SQL, /SET stale_embedding = true/); assert.doesNotMatch(REPAIR_ORPHANS_SQL, /DELETE/);
  for (const s of [DIGEST_CONFLICTS_SQL, DIGEST_UNLINKED_SQL, DIGEST_VALIDATION_SQL, DRAFT_CANDIDATES_SQL]) assert.match(s, /^\s*SELECT/);
});

// The v4.6 link-sweep fix. The sweep and this check used to sit on opposite
// sides of the same 7-day line, so no sweep could ever reach a flagged row.
test('unlinked_sessions_7d: checked counts every unlinked chat row, flagged only the overdue ones, and the sample is a usable sweep worklist', () => {
  const c = VALIDATION_CHECKS.find((x) => x.name === 'unlinked_sessions_7d');
  assert.ok(c, 'check missing');
  // rows_checked must carry no age window — it is the sweep's whole population,
  // and it has to agree with the pack's windowless unlinked_sessions count.
  // Take the text of each count subquery by slicing back from its alias to the
  // preceding "(SELECT" — a bracket-counting regex trips over coalesce(...).
  const subqueryFor = (alias) => {
    const end = c.sql.indexOf(`)::int AS ${alias}`);
    assert.ok(end > 0, `${alias} missing`);
    return c.sql.slice(c.sql.lastIndexOf('(SELECT', end), end);
  };
  const checked = subqueryFor('rows_checked');
  assert.ok(checked.includes('chat_url IS NULL'), 'rows_checked must count unlinked rows');
  assert.doesNotMatch(checked, /interval/, 'rows_checked must have no age window');
  // rows_flagged is the alarm: unlinked AND past the 7-day line.
  const flagged = subqueryFor('rows_flagged');
  assert.match(flagged, /created_at < now\(\) - interval '7 days'/, 'rows_flagged is the overdue subset');
  // The sample doubles as the worklist: oldest first, search keys attached,
  // because conversation_search matches on keys and not on timestamps.
  assert.match(c.sql, /transcript_search_keys AS search_keys/, 'sample must carry the search keys');
  assert.match(c.sql, /ORDER BY created_at ASC/, 'most overdue first');

  // Mark's 2026-09-15 ruling: a row with no search keys and no reachable chat
  // is not actionable, so it must not pin the alarm — but it is still real, so
  // rows_checked keeps counting it. Nothing is deleted; the mark is reversible.
  const unlinkable = /coalesce\(\(validation_notes->>'link_unlinkable'\)::boolean, false\) = false/;
  assert.match(flagged, unlinkable, 'rows_flagged must exclude rows ruled unlinkable');
  assert.doesNotMatch(checked, unlinkable, 'rows_checked must still count them');
  // The sample is the sweep worklist, so it excludes them too — there is
  // nothing a sweep could do with a row that has no keys.
  const sample = c.sql.slice(c.sql.indexOf('AS title'));
  assert.match(sample, unlinkable, 'the worklist sample must exclude them as well');

  // v4.7: a [FOLDED -> #NNN] row's chat belongs to the row it was folded into,
  // so any match a sweep finds for it is a false positive by construction.
  // Same invariant as link_unlinkable: filtered from the alarm, still counted.
  const folded = /session_title NOT ILIKE '%\[FOLDED%/;
  const foldedNote = /NOT coalesce\(validation_notes \? 'folded_into', false\)/;
  for (const [re, what] of [[folded, 'title marker'], [foldedNote, 'folded_into note']]) {
    assert.match(flagged, re, `rows_flagged must exclude folded rows (${what})`);
    assert.match(sample, re, `the worklist sample must exclude folded rows (${what})`);
    assert.doesNotMatch(checked, re, `rows_checked must still count folded rows (${what})`);
  }

  // validation_notes is NULL on most rows (77 of 78 overdue on 2026-09-15), and
  // `NULL ? 'k'` is NULL rather than false — so a bare
  // `NOT (validation_notes ? 'folded_into')` evaluates NULL and the WHERE drops
  // the row. That reads as a clean alarm while hiding every row with no notes:
  // it took rows_flagged from 78 to 0 in testing. Every jsonb existence test
  // here must be coalesce-wrapped. Missing data is never a wildcard pass.
  for (const clause of c.sql.match(/validation_notes \? '[a-z_]+'/g) || []) {
    const idx = c.sql.indexOf(clause);
    const around = c.sql.slice(Math.max(0, idx - 40), idx + clause.length + 12);
    assert.match(around, /coalesce\(validation_notes \? '[a-z_]+', false\)/,
      `jsonb existence test must be NULL-safe: ${clause}`);
  }
});

// The v4.6 bug was the sweep and the check covering different row sets. The
// sweep's own worklist lives in the skill's queries.md section 4b, so a filter
// added to one and not the other reintroduces it in mirror image.
test('queries.md §4b and the nightly check exclude the same rows', () => {
  const start = queriesRef.indexOf('**4b — Checkpoints still awaiting a transcript link:**');
  assert.ok(start > 0, '§4b missing');
  const block = queriesRef.slice(start, queriesRef.indexOf('###', start));
  for (const re of [/session_title NOT ILIKE '%\[FOLDED%/, /NOT coalesce\(validation_notes \? 'folded_into', false\)/, /link_unlinkable/]) {
    assert.match(block, re, `§4b must carry the same exclusion as unlinked_sessions_7d: ${re}`);
  }
  assert.doesNotMatch(block, /created_at [<>]/, '§4b must stay windowless (v4.6)');
  assert.match(block, /value at REVIEW time, not current/,
    '§4b must carry the stale-column warning');
  assert.match(block, /Never gate on it/, '§4b must forbid gating on chat_updated_at');
  assert.match(block, /Change one, change both/, '§4b must carry the alignment reminder');
});

// Keys establish candidacy, not identity. Without these a September session
// matches a May chat on the same long-running subject and the link is refused
// only after the search budget is already spent.
test('SKILL.md Mechanism 2 states all three identity gates, with the ET conversion', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'docs', 'skills', 'reece-session-continuity', 'SKILL.md'), 'utf8');
  const mech = skill.slice(skill.indexOf('### Mechanism 2'), skill.indexOf('### Mechanism 3'));
  // Gate A is an up-front set, not a per-candidate lookup.
  assert.match(mech, /ONE query|one query/, 'Gate A must load claimed chat_urls once');
  // Gate B must compare in ET; comparing a UTC timestamp to an ET date is an
  // off-by-one that wrongly rejects a chat active late the previous evening.
  assert.match(mech, /AT TIME ZONE 'America\/New_York'/, 'Gate B must convert to ET before comparing');
  assert.match(mech, /Same-day passes/, 'Gate B must allow the same day');
  // Gate C: write_date rows cannot be date-gated at all.
  // Gate B must read the LIVE updated_at, not the ledger's stored column.
  // claude_transcript_ledger.chat_updated_at is the value at review time: when a
  // chat is reopened it stays where it was, so a gate reading it rejects every
  // reopened chat permanently. Session 876 is the case — ledger Mar 27, live
  // search Sep 9, same day as the session — so reading the column would refuse
  // 876's own correct link, and a stale value is indistinguishable from a
  // mis-link, which misreads the whole reopen class.
  assert.match(mech, /never `claude_transcript_ledger\.chat_updated_at`/,
    'Gate B must forbid the stale ledger column by name');
  assert.match(mech, /LIVE value on the `conversation_search`/,
    'Gate B must name the live source');
  assert.match(mech, /write_date/, 'Gate C must name write_date rows');
  assert.match(mech, /not\*{0,2} sufficient|not sufficient/, 'Gate C must say title fit alone is insufficient');
});

// GATE B (2026-09-16). This alarm exists because the stale column was read as
// current: a link sweep compared September session dates against these
// timestamps, concluded 25 September sessions sat on spring chats, and cleared
// 24 correct links (all since restored, two verified by finding each session's
// own memory_checkpoint payload in its chat). It must stay an ALARM — LP-MCP
// cannot call conversation_search, so it cannot learn the live date and has
// nothing it could correctly repair.
test('stale_ledger_timestamps: flags ledger rows whose chat_updated_at predates the session they point at, and only reports', () => {
  const c = VALIDATION_CHECKS.find((x) => x.name === 'stale_ledger_timestamps');
  assert.ok(c, 'check missing');
  // The comparison is the ledger row against the session it points at — not
  // against the clock. A session is written from work done in that chat, so the
  // chat cannot have stopped moving before the session date.
  assert.match(c.sql, /claude_transcript_ledger l\s+JOIN claude_session_logs s ON s\.id = l\.session_id/);
  assert.match(c.sql, /\(l\.chat_updated_at AT TIME ZONE 'America\/New_York'\)::date < s\.session_date/);
  assert.doesNotMatch(c.sql, /now\(\)/, 'staleness is measured against the session, never the clock');
  // Both sides compared as ET calendar dates: a late-evening UTC timestamp would
  // otherwise read as the next day and flag itself.
  assert.match(c.sql, /AT TIME ZONE 'America\/New_York'\)::date::text AS ledger_date/);
  assert.doesNotMatch(c.sql, /\b(UPDATE|DELETE|INSERT)\b/, 'read-only: only the chat surface can refresh these');
  for (const col of ['rows_checked', 'rows_flagged', 'sample']) assert.ok(c.sql.includes(`AS ${col}`), col);
  // The sample is the worklist, so it carries the gap and leads with the worst.
  assert.match(c.sql, /days_stale/);
  assert.match(c.sql, /ORDER BY 4 DESC/);
});

test('runMemoryValidation: dry run logs every check and repairs nothing; live syncs drifted metadata and marks orphans; log:false is SELECT-only', async () => {
  const seed = (s) => {
    if (/AS rows_flagged/.test(s)) {
      if (/e\.date_confidence IS DISTINCT FROM d\.date_confidence/.test(s) && /AS rows_checked/.test(s) && !/AS sample[\s\S]*ORDER BY e\.id LIMIT/.test(s)) return [{ rows_checked: 7415, rows_flagged: 12, sample: [{ source_id: 1 }] }];
      if (/NOT e\.stale_embedding AND NOT \(/.test(s)) return [{ rows_checked: 7415, rows_flagged: 2, sample: [] }];
      return [{ rows_checked: 100, rows_flagged: 0, sample: null }];
    }
    return { status: 'ok' };
  };
  const dryCalls = [];
  const dry = await runMemoryValidation({ dry_run: true, deps: { runSQL: async (s) => { dryCalls.push(s); return seed(s); } } });
  assert.equal(dry.dry_run, true); assert.equal(Object.keys(dry.checks).length, 12); assert.equal(dry.flagged_total, 14);
  assert.equal(dry.checks.embedding_metadata_drift.rows_flagged, 12); assert.equal(dry.checks.orphan_embeddings.rows_flagged, 2);
  assert.equal(dryCalls.filter((s) => /^INSERT INTO claude_memory_validation_log/.test(s)).length, 12, 'one log row per check');
  assert.ok(dryCalls.every((s) => /^\s*SELECT|^INSERT INTO claude_memory_validation_log/.test(s)), 'dry run never UPDATEs');
  assert.ok(dryCalls.some((s) => /'dry_run'/.test(s))); assert.deepEqual(dry.repairs, {});

  const liveCalls = [];
  const out = await runMemoryValidation({ dry_run: false, mode: 'nightly', deps: { runSQL: async (s) => { liveCalls.push(s); return seed(s); } } });
  assert.deepEqual(out.repairs, { embedding_metadata_sync: { affected: 12 }, orphan_embeddings: { affected: 2 } });
  assert.equal(liveCalls.filter((s) => /^UPDATE claude_memory_embeddings e SET status = d\.status/.test(s)).length, 1);
  assert.equal(liveCalls.filter((s) => /SET stale_embedding = true/.test(s)).length, 1);
  assert.ok(liveCalls.some((s) => /'repair:embedding_metadata_sync'/.test(s)) && liveCalls.some((s) => /'repair:orphan_embeddings'/.test(s)));
  assert.ok(liveCalls.some((s) => /'nightly'/.test(s)));

  const quiet = [];
  const q = await runMemoryValidation({ dry_run: true, deps: { runSQL: async (s) => { quiet.push(s); return seed(s); }, log: false } });
  assert.equal(q.logged, false); assert.ok(quiet.every((s) => /^\s*SELECT/.test(s)));

  const broken = await runMemoryValidation({ dry_run: true, deps: { runSQL: async (s) => { if (/claude_memory_conflicts/.test(s) && /AS rows_checked/.test(s)) throw new Error('relation does not exist'); return seed(s); } } });
  assert.match(broken.checks.conflicts_open.error, /does not exist/); assert.equal(broken.errors.length, 1); assert.equal(Object.keys(broken.checks).length, 12, 'one failing check does not stop the rest');
});

// ─── Conflict scan ───────────────────────────────────────────────────────────
test('conflict scan SQL: lateral nearest-3 in the same area and status, threshold, incremental vs full, existing pairs skipped', () => {
  const d = conflictScanSql({ kind: 'decision', threshold: 0.85 });
  assert.match(d, /^\s*SELECT least\(a\.source_id, b\.source_id\) AS row_a, greatest\(a\.source_id, b\.source_id\) AS row_b/);
  assert.match(d, /JOIN LATERAL \(/); assert.match(d, /ORDER BY n\.embedding <=> a\.embedding LIMIT 3/);
  assert.match(d, /n\.area IS NOT DISTINCT FROM a\.area AND n\.status = 'active'/);
  assert.match(d, /a\.source_table = 'claude_decision_log' AND a\.status = 'active'/);
  assert.match(d, /a\.embedded_at > now\(\) - interval '24 hours'/);
  assert.match(d, />= 0\.85/); assert.match(d, /NOT EXISTS \(SELECT 1 FROM claude_memory_conflicts c WHERE c\.kind = 'decision'/);
  const i = conflictScanSql({ kind: 'issue', threshold: 0.9, full: true });
  assert.match(i, /a\.source_table = 'claude_known_issues' AND a\.status = 'open'/); assert.doesNotMatch(i, /embedded_at/); assert.match(i, />= 0\.9/);
  assert.throws(() => conflictScanSql({ kind: 'session', threshold: 0.9 }), /unknown kind/);
  assert.throws(() => conflictScanSql({ kind: 'issue', threshold: 2 }), /threshold/);
  assert.equal(thresholdFor('decision', {}), 0.85); assert.equal(thresholdFor('issue', {}), 0.9); assert.equal(thresholdFor('issue', { MEMORY_ISSUE_DUPLICATE_THRESHOLD: '0.95' }), 0.95);
});

test('normalizePairs orders and dedupes; insert is ON CONFLICT DO NOTHING; runConflictScan dry run counts only', async () => {
  const pairs = normalizePairs([{ row_a: 9, row_b: 4, similarity: 0.91 }, { row_a: 4, row_b: 9, similarity: 0.91 }, { row_a: 4, row_b: 4, similarity: 1 }, { row_a: 'x', row_b: 2 }, { row_a: 1, row_b: 2, similarity: '0.87654' }]);
  assert.deepEqual(pairs, [{ row_a: 4, row_b: 9, similarity: 0.91 }, { row_a: 1, row_b: 2, similarity: 0.8765 }]);
  const sqlText = conflictInsertSql('decision', pairs);
  assert.match(sqlText, /^INSERT INTO claude_memory_conflicts \(kind, row_a, row_b, similarity\)\nVALUES \('decision', 4, 9, 0\.91\),\s+\('decision', 1, 2, 0\.8765\)\nON CONFLICT \(kind, row_a, row_b\) DO NOTHING$/);
  const calls = [];
  const runSQL = async (s) => { calls.push(s); if (/^\s*SELECT/.test(s)) return /claude_decision_log/.test(s) ? [{ row_a: 7, row_b: 3, similarity: 0.9 }] : []; return { status: 'ok' }; };
  const dry = await runConflictScan({ dry_run: true, deps: { runSQL, env: {} } });
  assert.equal(dry.kinds.decision.candidates, 1); assert.equal(dry.kinds.decision.filed, 0); assert.equal(dry.filed, 0); assert.equal(dry.kinds.issue.candidates, 0);
  assert.ok(calls.every((s) => /^\s*SELECT/.test(s)));
  calls.length = 0;
  const liveRun = await runConflictScan({ deps: { runSQL, env: {} } });
  assert.equal(liveRun.filed, 1); assert.deepEqual(liveRun.kinds.decision.sample, [{ row_a: 3, row_b: 7, similarity: 0.9 }]);
  assert.equal(calls.filter((s) => /^INSERT INTO claude_memory_conflicts/.test(s)).length, 1);
  const bad = await runConflictScan({ deps: { runSQL: async () => { throw new Error('boom'); }, env: {} } });
  assert.equal(bad.errors.length, 2); assert.equal(bad.filed, 0);
});

// ─── Draft checkpoints ───────────────────────────────────────────────────────
test('draft checkpoints: deferred ledger rows with no session become origin=nightly sessions with a summary and keys only', async () => {
  const row = draftSessionRow({ chat_url: 'https://claude.ai/chat/z', chat_title: 'Payroll conflict', chat_updated_at: '2026-08-30T22:10:00Z' }, NOW);
  assert.equal(row.log_origin, 'nightly'); assert.equal(row.session_date, '2026-08-30');
  // GATE B (2026-09-16): 'write_date', even though chat_updated_at parsed cleanly
  // and still sets session_date. The ledger column is the chat's last activity AT
  // REVIEW TIME, and a chat reopened afterwards leaves it months behind — so it
  // dates the draft but never proves it. Stamping 'exact' here was self-sealing:
  // the section 1c date self-heal only repairs 'write_date' rows, so a draft
  // mis-dated from a stale row could never be corrected while the context pack
  // went on ranking it as recent.
  assert.equal(row.date_confidence, 'write_date', 'a cleanly parsed ledger timestamp must NEVER produce exact');
  assert.equal(row.link_confidence, 'exact'); assert.equal(row.source_chat_updated_at, '2026-08-30T22:10:00.000Z'); assert.deepEqual(row.transcript_search_keys, ['Payroll conflict']);
  assert.match(row.raw_summary, /^\[NIGHTLY DRAFT 2026-09-08/); assert.deepEqual(row.decisions_made, []);
  // sql/099: the draft's key is its own identity, so a half-finished nightly
  // pass re-run finds this draft instead of adding a second one.
  assert.match(row.checkpoint_key, /^[0-9a-f]{64}$/);
  assert.equal(row.checkpoint_key, checkpointKeyFor({ surface: 'chat', date: '2026-08-30', title: '[DRAFT] Payroll conflict' }));
  assert.deepEqual(draftSessionRow({ chat_url: 'https://claude.ai/chat/z', chat_title: 'Payroll conflict', chat_updated_at: '2026-08-30T22:10:00Z' }, NOW).checkpoint_key, row.checkpoint_key, 'stable across runs');
  const undated = draftSessionRow({ chat_url: 'u', chat_title: null, chat_updated_at: null }, NOW);
  assert.equal(undated.date_confidence, 'write_date'); assert.equal(undated.session_date, '2026-09-08'); assert.equal(undated.source_chat_updated_at, null);

  const cands = [{ chat_url: 'https://claude.ai/chat/z', chat_title: 'Payroll conflict', chat_updated_at: '2026-08-30T22:10:00Z' }];
  const calls = [];
  const runSQL = async (s) => { calls.push(s); return /^\s*SELECT/.test(s) ? cands : { status: 'ok' }; };
  const db = fakeDb();
  const dry = await runDraftCheckpoints({ dry_run: true, now: NOW, deps: { runSQL, db } });
  assert.equal(dry.candidates, 1); assert.deepEqual(dry.drafted, []); assert.equal(db.calls.length, 0);
  const out = await runDraftCheckpoints({ now: NOW, deps: { runSQL, db } });
  assert.deepEqual(out.drafted, [900]);
  assert.equal(ins(db, 'claude_session_logs')[0].payload.log_origin, 'nightly');
  const ledger = upd(db, 'claude_transcript_ledger')[0];
  assert.equal(ledger.payload.session_id, 900); assert.deepEqual(ledger.filters, [['chat_url', 'https://claude.ai/chat/z']]);
  assert.equal(ins(db, 'claude_decision_log').length + ins(db, 'claude_known_issues').length, 0, 'drafts never write decisions or issues');
  assert.ok(calls.some((s) => /'nightly_drafts_written'/.test(s)));
});

// ─── Admin routes ────────────────────────────────────────────────────────────
function fakeApp() {
  const routes = {};
  const reg = (m) => (p, ...h) => { routes[`${m} ${p}`] = h; };
  return { get: reg('GET'), post: reg('POST'), routes };
}
async function call(handlers, req = {}) {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  for (const h of handlers) { let nexted = false; await h(req, res, () => { nexted = true; }); if (!nexted) break; }
  return res;
}

test('n8n event door: never a decision; issue and pending rows carry origin n8n and hang off one session per day; duplicates returned, not refiled', async () => {
  assert.throws(() => parseEvent({ kind: 'decision', description: 'x' }), /never written through the n8n door/);
  assert.throws(() => parseEvent({ kind: 'issue' }), /description/);
  assert.throws(() => parseEvent({ kind: 'issue', description: 'x', severity: 'urgent' }), /severity/);
  assert.throws(() => parseEvent({ kind: 'pending', description: 'x', item_type: 'unconfirmed_decision' }), /item_type/);
  const ev = parseEvent({ kind: 'issue', description: 'LP sync failed', source: 'wf-lp-sync', severity: 'high' });
  assert.equal(ev.category, 'integration'); assert.equal(ev.source, 'wf-lp-sync');

  const db = fakeDb();
  const out = await writeEvent(ev, { db, now: NOW });
  assert.equal(out.kind, 'issue'); assert.equal(out.deduped, false); assert.equal(out.session_id, 900); assert.equal(out.id, 901);
  const sess = ins(db, 'claude_session_logs')[0].payload;
  assert.equal(sess.log_origin, 'n8n'); assert.equal(sess.surface, 'n8n'); assert.equal(sess.checkpoint_key, 'n8n:2026-09-08'); assert.equal(sess.session_date, '2026-09-08');
  const issue = ins(db, 'claude_known_issues')[0].payload;
  assert.equal(issue.origin, 'n8n'); assert.equal(issue.description, '[n8n:wf-lp-sync] LP sync failed'); assert.equal(issue.reported_session_id, 900); assert.equal(issue.severity, 'high');

  const dup = fakeDb({ session: { id: 42 }, rows: (ctx) => (ctx.table === 'claude_known_issues' ? [{ id: 77, status: 'open' }] : undefined) });
  const d = await writeEvent(ev, { db: dup, now: NOW });
  assert.deepEqual(d, { ok: true, kind: 'issue', id: 77, session_id: 42, deduped: true }); assert.equal(ins(dup, 'claude_known_issues').length, 0); assert.equal(ins(dup, 'claude_session_logs').length, 0, 'existing day session reused');

  const pend = fakeDb({ session: { id: 42 }, rows: (ctx) => (ctx.table === 'claude_pending_items' ? [{ source_index: 4 }] : undefined) });
  const p = await writeEvent(parseEvent({ kind: 'pending', description: 'Re-run enrichment', source: 'wf-enrich', item_type: 'action_needed', ref: 'exec 123' }), { db: pend, now: NOW });
  assert.equal(p.kind, 'pending');
  const row = ins(pend, 'claude_pending_items')[0].payload;
  assert.equal(row.origin, 'n8n'); assert.equal(row.source_field, 'n8n'); assert.equal(row.source_index, 5); assert.equal(row.owner, 'n8n'); assert.equal(row.description, '[n8n:wf-enrich] Re-run enrichment');
});

test('routes: authenticated, event returns 201/200/400, validate defaults to dry_run and passes full through', async () => {
  const app = fakeApp();
  const auth = (_r, _s, next) => next();
  const seen = [];
  const db = fakeDb();
  registerAdminMemoryRoutes(app, auth, {
    db, runSQL: async () => [], now: () => NOW,
    validate: async (o) => { seen.push(['validate', o.dry_run, o.mode]); return { dry_run: o.dry_run, checks: {}, repairs: {}, errors: [] }; },
    conflicts: async (o) => { seen.push(['conflicts', o.dry_run, o.full]); return { filed: 0, kinds: {}, errors: [] }; },
  });
  for (const k of ['POST /admin/memory/event', 'POST /admin/memory/validate']) assert.equal(app.routes[k][0], auth, k);
  const bad = await call(app.routes['POST /admin/memory/event'], { body: { kind: 'decision', description: 'x' } });
  assert.equal(bad.code, 400); assert.match(bad.body.error, /never written/);
  const ok = await call(app.routes['POST /admin/memory/event'], { body: { kind: 'pending', description: 'Re-run', source: 'wf' } });
  assert.equal(ok.code, 201); assert.equal(ok.body.kind, 'pending'); assert.equal(ok.body.origin, undefined);
  const v = await call(app.routes['POST /admin/memory/validate'], { body: {} });
  assert.equal(v.code, 200); assert.equal(v.body.dry_run, true); assert.deepEqual(seen.slice(0, 2), [['validate', true, 'dry_run'], ['conflicts', true, false]]);
  const real = await call(app.routes['POST /admin/memory/validate'], { body: { dry_run: false, full: true } });
  assert.equal(real.body.dry_run, false); assert.deepEqual(seen.slice(2), [['validate', false, 'manual'], ['conflicts', false, true]]);
  const open = fakeApp(); registerAdminMemoryRoutes(open, null, { db });
  assert.equal(open.routes['POST /admin/memory/event'].length, 1);
});

// ─── Nightly wiring + digest ─────────────────────────────────────────────────
test('nightly: validation runs after re-embed and before workflow_ref; conflicts and drafts follow; a dry run only SELECTs', async () => {
  const order = [];
  const sqlCalls = [];
  const runSQL = async (s) => { sqlCalls.push(s); if (/claude_workflow_ref/.test(s)) order.push('ref'); return /^\s*SELECT/.test(s) ? [] : { status: 'ok' }; };
  const embed = { planKind: async (kind) => { order.push(`embed:${kind}`); return { kind, total: 0, todo: [], est_tokens: 0, est_cost_usd: 0 }; }, executePlan: async () => ({ written: 0, cost_usd: 0 }) };
  const db = { rpc: async () => ({ data: { counts: {} }, error: null }) };
  const env = { MEMORY_DIGEST_ENABLED: 'false', MEMORY_CONFLICT_THRESHOLD: '0.85' };
  const r = await runMemoryNightly({ deps: {
    runSQL, embed, supabase: db, now: new Date('2026-09-08T07:00:00Z'), env,
    validate: async (o) => { order.push('validate'); assert.equal(o.deps.log, true); return { flagged_total: 3, checks: { x: { rows_checked: 1, rows_flagged: 3 } }, repairs: { orphan_embeddings: { affected: 1 } }, errors: [] }; },
    conflicts: async (o) => { order.push('conflicts'); assert.equal(o.deps.env, env); return { filed: 2, kinds: { decision: { threshold: 0.85, candidates: 2, filed: 2 } }, errors: ['issue: boom'] }; },
    drafts: async () => { order.push('drafts'); return { candidates: 1, drafted: [77], errors: [] }; },
  } });
  assert.deepEqual(order, ['embed:decision', 'embed:issue', 'embed:session', 'embed:pending', 'validate', 'conflicts', 'drafts', 'ref']);
  assert.equal(r.validation.flagged_total, 3); assert.deepEqual(r.validation.checks.x, { checked: 1, flagged: 3 });
  assert.equal(r.conflicts.filed, 2); assert.deepEqual(r.drafts, { candidates: 1, drafted: 1, ids: [77] });
  assert.deepEqual(r.errors, ['conflicts issue: boom']);

  sqlCalls.length = 0;
  const dry = await runMemoryNightly({ dry_run: true, deps: { runSQL, embed, supabase: db, now: new Date('2026-09-08T07:00:00Z'), env } });
  assert.ok(sqlCalls.length >= 12 && sqlCalls.every((s) => /^\s*SELECT/i.test(s)), 'dry run: validation checks, conflict candidates, draft candidates — SELECT only');
  assert.equal(dry.validation.flagged_total, 0); assert.equal(dry.conflicts.filed, 0); assert.equal(dry.drafts.candidates, 0);
});

test('digest: three new sections appear only when there is something to say', () => {
  const base = { waiting: 1, oldest_days: 3, top: [{ id: 1, description: 'A', session_date: '2026-09-01' }], week: [], stale: 0, mode: 'live' };
  const plain = formatDigest(base);
  assert.equal(plain.split('\n').length, 3);
  const full = formatDigest({ ...base,
    conflicts: [{ id: 5, kind: 'decision', row_a: 10, row_b: 12, similarity: 0.912 }], conflict_total: 4,
    unlinked_7d: 6, drafts: 2, validation: [{ check_name: 'write_date_rows', rows_flagged: 76 }, { check_name: 'orphan_embeddings', rows_flagged: 1 }] });
  const lines = full.split('\n');
  assert.equal(lines[2], 'Conflicts awaiting ruling: 4');
  assert.equal(lines[3], '• [conflict #5] decision #10 vs #12  (cosine 0.91)');
  assert.equal(lines[4], 'Unlinked after 7 days: 6 sessions · 2 nightly drafts to confirm or drop');
  assert.equal(lines[5], 'Validation this week: write_date_rows=76 · orphan_embeddings=1');
  assert.match(lines[6], /^Also:/);
  assert.doesNotMatch(full, /⚠️/);
});

// ─── Idempotency of the pure layer ───────────────────────────────────────────
test('re-running the planners gives identical output (idempotent)', () => {
  const a = JSON.stringify(planCheckpoint(retro, NOW, ENV_SHADOW)); const b = JSON.stringify(planCheckpoint(retro, NOW, ENV_SHADOW));
  assert.equal(a, b);
  assert.equal(conflictScanSql({ kind: 'decision', threshold: 0.85 }), conflictScanSql({ kind: 'decision', threshold: 0.85 }));
  assert.deepEqual(VALIDATION_CHECKS.map((c) => c.sql), VALIDATION_CHECKS.map((c) => c.sql));
});

// The C2 heal statement is executed by hand during a link sweep, so the guard
// has to live in the document. As written before v4.6 it set session_date from
// the chat's updated_at for every row it healed — which would have moved ~60
// correct, reconstructed dates to their chat's last-activity date.
test('queries.md §6a: the C2 heal writes the link unconditionally but the date only for write_date rows', () => {
  const heal = queriesRef.slice(queriesRef.indexOf('### Heal a sweep-written session'));
  assert.ok(heal.length > 0, '§6a heal section missing');
  assert.match(heal.slice(0, heal.indexOf('```sql')), /Never re-date a row that already says/, 'the warning must precede the statements');
  // Only the code inside the fence — the prose above it also says "chat_url".
  const open = heal.indexOf('```sql') + '```sql'.length;
  const block = heal.slice(open, heal.indexOf('```', open));

  // The date write and the link write must be separate statements.
  const stmts = block.split(';')
    .map((x) => x.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim())
    .filter(Boolean);
  const dateStmts = stmts.filter((x) => /session_date\s*=/.test(x));
  assert.equal(dateStmts.length, 1, 'exactly one statement may set session_date');
  assert.match(dateStmts[0], /date_confidence = 'write_date'/, 'the date write must be guarded by date_confidence');

  const linkStmts = stmts.filter((x) => /chat_url\s*=/.test(x) && /^UPDATE claude_session_logs/.test(x));
  assert.equal(linkStmts.length, 1, 'exactly one statement may set chat_url');
  assert.doesNotMatch(linkStmts[0], /session_date/, 'the link write must not touch the date');
  assert.match(linkStmts[0], /<> 'exact'/, 'never overwrite an exact link');

  // C3 children follow the parent only while they are still on the write date.
  for (const child of stmts.filter((x) => /^UPDATE claude_(decision_log|known_issues)/.test(x))) {
    assert.match(child, /date_confidence = 'write_date'/, `child re-date must be guarded: ${child.slice(0, 60)}`);
  }
  assert.ok(!/DELETE/.test(block), 'the heal marks, it never deletes');
});

// The sweep in SKILL.md and the nightly check must cover the same rows.
test('SKILL.md Mechanism 2: the sweep has no age window and matches on search keys before timestamps', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'docs', 'skills', 'reece-session-continuity', 'SKILL.md'), 'utf8');
  const mech = skill.slice(skill.indexOf('### Mechanism 2'), skill.indexOf('### Mechanism 3'));
  assert.ok(mech.length > 0, 'Mechanism 2 missing');
  assert.doesNotMatch(mech, /created_at > now\(\) - interval '7 days'/, 'the sweep must not re-introduce the window that made it blind');
  assert.ok(mech.indexOf('conversation_search') < mech.indexOf('recent_chats(n=20)'), 'search keys come before timestamps');
  assert.match(mech, /Never use this on a sweep-written row/, 'the timestamp fallback must be scoped to live rows');
});
