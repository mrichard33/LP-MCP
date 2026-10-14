/**
 * No dates or ids in GHL tags (Mark, 2026-10-14). The rehash sweep had put
 * rehash-lead:<lds>, rehash-since:<date> and rehash-done:<lds> on 646 contacts.
 * Covers: the add_tag guard (uniqueValueTagReason), the one-time cleanup's
 * parser and its run (backfill rehash_stage, then queue the removals).
 *
 * Run: node --test scripts/test-rehash-tag-cleanup.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { uniqueValueTagReason, executeAddTag } from '../src/actions/handlers/tags.js';
import {
  parseLegacyRehashTags, stageRowsFor, isLegacyRehashTag, runRehashTagCleanup, RULE_KEY,
} from '../src/services/rehash-tag-cleanup.js';

// ── the guard ───────────────────────────────────────────────────────────────

test('guard: a date or a trailing :id is refused', () => {
  for (const t of ['rehash-since:2026-10-13', 'rehash-lead:582714', 'rehash-done:438100', 'followup-2026-11-01', 'x:1']) {
    assert.match(uniqueValueTagReason(t), /^unique_value_tag_blocked/, t);
  }
});

test('guard: plain labels pass, including ones with digits that are not an id', () => {
  for (const t of ['rehash', 'active-f.0', 'nepq:handoff:price', 'lp-dnc:c', 'active-w5.2', 'bot-off:dq',
    'source:canvass', 'guide-pending-name:hurricane', 'entry:canvassing', 'p3:reactivation', 'f.0-v2', 'w03-done', '']) {
    assert.equal(uniqueValueTagReason(t), null, t);
  }
});

test('guard: executeAddTag refuses before any GHL call', async () => {
  await assert.rejects(
    executeAddTag({ target_id: 'c1', action_payload: { tag: 'rehash-lead:582714' }, rule_applied: 'TEST' }),
    /unique_value_tag_blocked/,
  );
});

test('guard: the executor fails the row with the reason, before marking it executing (source)', () => {
  const src = fs.readFileSync(new URL('../src/actions/index.js', import.meta.url), 'utf8');
  const gate = src.indexOf("const blocked = uniqueValueTagReason(action.action_payload?.tag);");
  const executing = src.indexOf("status: 'executing',", src.indexOf('async function executeSingleActionUntracked'));
  assert.ok(gate > 0 && gate < executing, 'the gate runs before the row is marked executing');
  assert.match(src.slice(gate, gate + 800), /status: 'failed'/);
  assert.match(src.slice(gate, gate + 800), /reason: 'unique_value_tag_blocked'/);
});

test('the sweep source writes no rehash-lead / rehash-since / rehash-done tag any more', () => {
  for (const f of ['../src/jobs/rehash-tag-sweep.js', '../src/agentic/rehash-state.js']) {
    const code = fs.readFileSync(new URL(f, import.meta.url), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    assert.doesNotMatch(code.join('\n'), /rehash-(lead|since|done):/, f);
  }
});

// ── the parser ──────────────────────────────────────────────────────────────

test('parse: rehash + lead + since → an open row; the old tags are listed for removal', () => {
  const p = parseLegacyRehashTags(['rehash', 'rehash-lead:582714', 'rehash-since:2026-10-13', 'canvass-v2']);
  assert.deepEqual(p.active, { lp_lead_id: '582714', demo_date: '2026-10-13' });
  assert.deepEqual(p.done, []);
  assert.deepEqual(p.remove, ['rehash-lead:582714', 'rehash-since:2026-10-13']);
});

test('parse: each rehash-done → an ended row; unknown stays unknown; rehash stays', () => {
  const p = parseLegacyRehashTags(['rehash-done:438100', 'rehash-done:unknown', 'Rehash-Done:500001']);
  assert.equal(p.active, null);
  assert.deepEqual(p.done.sort(), ['438100', '500001', 'unknown']);
  assert.ok(!p.remove.includes('rehash'));
  const rows = stageRowsFor('c1', p, '2026-10-14T00:00:00.000Z');
  assert.ok(rows.every((r) => r.end_reason === 'backfill_done_tag' && r.ended_at));
});

test('parse: lead/since with no rehash tag are only removed; an open lead wins over its own done tag', () => {
  const leftover = parseLegacyRehashTags(['rehash-lead:1', 'rehash-since:2026-09-01']);
  assert.equal(leftover.active, null);
  assert.equal(leftover.remove.length, 2);
  const both = parseLegacyRehashTags(['rehash', 'rehash-lead:7', 'rehash-done:7', 'rehash-done:6']);
  assert.deepEqual(both.active, { lp_lead_id: '7', demo_date: null });
  assert.deepEqual(both.done, ['6']);
  assert.equal(isLegacyRehashTag('rehash'), false);
});

// ── the run ─────────────────────────────────────────────────────────────────

function fakeDb({ snapshot = {}, history = [], failUpsert = false } = {}) {
  const upserts = [];
  const queued = [];
  const from = (table) => {
    const f = {};
    const res = () => {
      if (table === 'agent_actions' && f.op === 'insert') { queued.push(...f.payload); return { error: null }; }
      if (table === 'agent_actions') return { data: f.eq?.rule_applied === 'REHASH_TAG_SWEEP' ? history.map((id) => ({ target_id: id })) : [], error: null };
      if (table === 'rehash_stage') {
        if (failUpsert) return { error: { message: 'no table' } };
        upserts.push(...f.payload);
        return { error: null };
      }
      if (table === 'contact_tag_snapshot') {
        if (f.in) return { data: f.in.filter((id) => snapshot[id]).map((id) => ({ ghl_contact_id: id, tags: snapshot[id] })), error: null };
        return { data: Object.entries(snapshot).filter(([, t]) => t.includes('rehash')).map(([id]) => ({ ghl_contact_id: id })), error: null };
      }
      return { data: [], error: null };
    };
    const chain = {
      select: () => chain, order: () => chain, range: () => chain, contains: () => chain, limit: () => chain,
      eq: (k, v) => { (f.eq ||= {})[k] = v; return chain; },
      in: (k, v) => { if (k === 'ghl_contact_id') f.in = v; return chain; },
      insert: (p) => { f.op = 'insert'; f.payload = p; return Promise.resolve(res()); },
      upsert: (p) => { f.payload = p; return Promise.resolve(res()); },
      then: (a, b) => Promise.resolve(res()).then(a, b),
    };
    return chain;
  };
  return { from, upserts, queued };
}

const LIVE = {
  ras: ['rehash', 'rehash-lead:582714', 'rehash-since:2026-10-13'],
  old: ['rehash-done:438100'],
  clean: ['rehash'],
};

test('run (dry): counts only, writes nothing', async () => {
  const db = fakeDb({ snapshot: LIVE, history: ['old', 'ras'] });
  const r = await runRehashTagCleanup({ dryRun: true, throttleMs: 0 }, {
    supabase: db, getContact: async (id) => ({ tags: LIVE[id] }), log: () => {},
  });
  assert.equal(r.contacts_found, 2, 'the contact with only `rehash` is not a candidate');
  assert.deepEqual(r.rows_backfilled, { active: 1, ended: 1 });
  assert.equal(r.tags_queued_for_removal, 3);
  assert.equal(db.upserts.length + db.queued.length, 0);
});

test('run (live): backfills then queues one remove_tag per old tag; rehash is never removed', async () => {
  const db = fakeDb({ snapshot: LIVE, history: ['old', 'ras'] });
  const r = await runRehashTagCleanup({ dryRun: false, throttleMs: 0 }, {
    supabase: db, getContact: async (id) => ({ tags: LIVE[id] }), log: () => {},
  });
  assert.equal(r.tags_queued_for_removal, 3);
  assert.deepEqual(db.upserts.find((x) => x.ghl_contact_id === 'ras'), { ghl_contact_id: 'ras', lp_lead_id: '582714', demo_date: '2026-10-13' });
  assert.ok(db.queued.every((q) => q.action_type === 'remove_tag' && q.rule_applied === RULE_KEY && q.action_payload.tag !== 'rehash'));
});

test('run (live): the LIVE tags decide, not the snapshot; a failed backfill queues no removal', async () => {
  const db = fakeDb({ snapshot: { ras: LIVE.ras }, failUpsert: true });
  const r = await runRehashTagCleanup({ dryRun: false, throttleMs: 0 }, {
    supabase: db, getContact: async () => ({ tags: ['rehash', 'rehash-lead:999', 'rehash-since:2026-10-12'] }), log: () => {},
  });
  assert.equal(db.queued.length, 0);
  assert.equal(r.errors.length, 1);
});

test('run: an unreadable contact is retried with backoff, then skipped and listed', async () => {
  const db = fakeDb({ snapshot: { ras: LIVE.ras } });
  let calls = 0;
  const waits = [];
  const r = await runRehashTagCleanup({ dryRun: false, throttleMs: 0 }, {
    supabase: db, getContact: async () => { calls++; throw new Error('GHL 429'); }, sleep: async (ms) => { waits.push(ms); }, log: () => {},
  });
  assert.equal(calls, 4);
  assert.deepEqual(waits, [1000, 2000, 4000]);
  assert.deepEqual([r.unreadable, r.unreadable_ids], [1, ['ras']]);
  assert.equal(db.queued.length, 0);
});
