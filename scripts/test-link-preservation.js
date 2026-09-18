#!/usr/bin/env node
/**
 * The link must survive the sync — scripts/test-link-preservation.js
 *
 * THE REGRESSION GUARD for the defect that has now been fixed three separate
 * times, each round found months late by someone chasing something else:
 *
 *   2026-06-02  sync-leads.js v10.1     lp_leads stopped being nulled
 *   2026-08-31  sync-children.js #784   lp_jobs, then lp_job_milestones
 *   2026-09-18  sync-children.js        lp_notes and lp_call_logs (this change)
 *
 * THE BUG, in one sentence: a child-row builder writes
 * `ghl_contact_id: ghlContactId || null`, the job-changes sweep and
 * syncAllChildRecords call these functions with a null contact for every record
 * they could not resolve, and the upsert therefore erases a link that was
 * already correct.
 *
 * WHAT IT COST. Measured 2026-09-18, rows carrying NULL against a LINKED parent
 * lead: lp_jobs 0 and lp_job_milestones 0 (fixed and drained by the Tier A
 * backfill), lp_notes 27,349 and lp_call_logs 236,961 (never covered). The
 * downstream symptom is a contact-id-keyed query that quietly returns less than
 * the truth — which is how 344 open P2 opportunities became unreconcilable.
 *
 * WHY "OMITTED" AND NOT "NULLED" IS THE WHOLE FIX. PostgREST's ON CONFLICT DO
 * UPDATE only sets the columns present on the row object. A key that is absent
 * is left alone; a key present with a null value overwrites. So the row builders
 * spread `...(ghlContactId ? { ghl_contact_id: ghlContactId } : {})`.
 *
 * AND WHY THAT IS SAFE INSIDE A BULK UPSERT. These rows go to PostgREST as an
 * ARRAY, and a batch whose objects carry different key sets silently defaults
 * columns. `ghlContactId` is a single function parameter for the whole call, so
 * every row in one batch either carries the key or none of them does. The
 * uniform-keys test below pins exactly that.
 *
 * Run: node --test scripts/test-link-preservation.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ─── Seam ────────────────────────────────────────────────────────
// Same approach as scripts/test-child-sync-batching.js: sync-children.js has no
// DI hook, so force dummy env BEFORE importing src/supabase.js and then shadow
// `from` on the shared client instance.
process.env.SUPABASE_URL = 'http://sb.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
delete process.env.GHL_API_KEY;

globalThis.fetch = async () => ({
  ok: false, status: 599, statusText: 'blocked-by-test',
  headers: { get: () => null }, text: async () => '', json: async () => ({}),
});

const upserts = [];
const existingIds = new Map();   // table → Set of ids that already exist

function from(table) {
  const s = { table, op: null, payload: null, options: null, filters: [], single: false };
  const chain = {
    select(cols, opts) { s.op ??= 'select'; s.payload = cols; if (opts) s.options = opts; return chain; },
    insert(p, o) { s.op = 'insert'; s.payload = p; s.options = o ?? null; return chain; },
    upsert(p, o) { s.op = 'upsert'; s.payload = p; s.options = o ?? null; return chain; },
    update(p) { s.op = 'update'; s.payload = p; return chain; },
    delete() { s.op = 'delete'; return chain; },
    eq(c, v) { s.filters.push(['eq', c, v]); return chain; },
    in(c, v) { s.filters.push(['in', c, v]); return chain; },
    not(c, o, v) { s.filters.push(['not', c, o, v]); return chain; },
    order(c, o) { s.filters.push(['order', c, o]); return chain; },
    limit(n) { s.filters.push(['limit', n]); return chain; },
    single() { s.single = true; return chain; },
    maybeSingle() { s.single = true; return chain; },
    then(resolve, reject) {
      return Promise.resolve().then(() => {
        if (s.op === 'upsert') {
          upserts.push({ table: s.table, payload: s.payload, options: s.options });
          return { data: null, error: null };
        }
        if (s.op === 'select') {
          if (s.options?.head) return { data: null, count: 0, error: null };
          const inF = s.filters.find((f) => f[0] === 'in');
          if (inF) {
            const [, col, ids] = inF;
            const have = existingIds.get(s.table) ?? new Set();
            return { data: ids.filter((id) => have.has(id)).map((id) => ({ [col]: id })), error: null };
          }
          return s.single ? { data: null, error: null } : { data: [], error: null };
        }
        return { data: null, error: null };
      }).then(resolve, reject);
    },
  };
  return chain;
}

const supabase = (await import('../src/supabase.js')).default;
assert.ok(supabase, 'supabase client must exist — check the env writes above');
Object.defineProperty(supabase, 'from', { value: from, writable: true, configurable: true });

const { loggedFirstKeys } = await import('../src/sync-utils.js');
for (const k of ['call', 'note']) loggedFirstKeys.add(k);

const { syncCallLogs, syncNotes, getChildSkipStats } = await import('../src/sync-children.js');

const LEAD = 'L1';
const CONTACT = 'ZbJFTZNhvzHJRQ3MHXmX';

const mkCall = (o = {}) => ({
  id: 'c1', calldatetime: '2026-06-01T09:00:00', agent: 'E77', agentname: 'Dana R',
  duration: 120, resultcode: 'CONN', calltype: 'O', notes: 'spoke', ...o,
});
const mkNote = (o = {}) => ({
  id: 'n1', enteredon: '2026-06-01T09:00:00', enteredby: 'Dana R',
  note: 'Customer called back', category: 'GEN', rectype: 'GEN', ...o,
});

function fresh() { upserts.length = 0; existingIds.clear(); getChildSkipStats(); }
const rowsFor = (table) => {
  const hit = upserts.find((u) => u.table === table && Array.isArray(u.payload));
  return hit ? hit.payload : null;
};

// ═══════════════════════════════════════════════════════════════════
// 9. An upsert carrying NO contact must not erase a stored link
// ═══════════════════════════════════════════════════════════════════

test('9a. lp_notes: a null contact OMITS ghl_contact_id, so a stored link survives', async () => {
  // The live caller is syncAllChildRecords, which passes ghlId=null for every
  // lead it could not resolve — and the note-edit branch re-upserts on
  // lp_note_id, so before this fix an edited note wiped a correct link.
  fresh();
  await syncNotes(LEAD, null, [mkNote()]);
  const rows = rowsFor('lp_notes');
  assert.ok(rows, 'expected a bulk upsert on lp_notes');
  assert.equal(
    'ghl_contact_id' in rows[0], false,
    'ghl_contact_id must be ABSENT, not null — a present null overwrites the stored link',
  );
});

test('9b. lp_call_logs: a null contact OMITS ghl_contact_id', async () => {
  fresh();
  await syncCallLogs(LEAD, null, [mkCall()]);
  const rows = rowsFor('lp_call_logs');
  assert.ok(rows, 'expected a bulk upsert on lp_call_logs');
  assert.equal('ghl_contact_id' in rows[0], false);
});

test('9c. an undefined or empty-string contact behaves the same as null', async () => {
  // The sweep has produced all three over time. `|| null` treated them
  // identically and so must the omission.
  for (const absent of [undefined, '']) {
    fresh();
    await syncNotes(LEAD, absent, [mkNote()]);
    assert.equal('ghl_contact_id' in rowsFor('lp_notes')[0], false, `failed for ${JSON.stringify(absent)}`);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 10. An upsert that DOES carry a contact must write it
// ═══════════════════════════════════════════════════════════════════

test('10a. lp_notes: a known contact WRITES ghl_contact_id', async () => {
  fresh();
  await syncNotes(LEAD, CONTACT, [mkNote()]);
  assert.equal(rowsFor('lp_notes')[0].ghl_contact_id, CONTACT);
});

test('10b. lp_call_logs: a known contact WRITES ghl_contact_id', async () => {
  fresh();
  await syncCallLogs(LEAD, CONTACT, [mkCall()]);
  assert.equal(rowsFor('lp_call_logs')[0].ghl_contact_id, CONTACT);
});

test('10c. the link lands on a row that is otherwise unchanged', async () => {
  // The #784 lesson: whatever skip-unchanged logic exists must never be what
  // stops a first link from landing. These two tables have no skip gate today,
  // so this pins that the row is still written and still carries the id.
  fresh();
  await syncNotes(LEAD, CONTACT, [mkNote()]);
  const rows = rowsFor('lp_notes');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ghl_contact_id, CONTACT);
});

// ═══════════════════════════════════════════════════════════════════
// The bulk-upsert invariant that makes the omission safe
// ═══════════════════════════════════════════════════════════════════

test('every row in one bulk payload carries the SAME key set', async () => {
  // PostgREST silently defaults columns when a batch has ragged keys. The
  // omission is safe only because ghlContactId is one parameter per call, so
  // the key is present on all rows or on none.
  for (const contact of [CONTACT, null]) {
    fresh();
    await syncNotes(LEAD, contact, [
      mkNote({ id: 'n1' }),
      mkNote({ id: 'n2', enteredon: '2026-07-02T11:00:00' }),
      mkNote({ id: 'n3', note: '' }),           // an empty body must not drop keys
    ]);
    const rows = rowsFor('lp_notes');
    assert.ok(rows.length >= 2, 'need several rows to compare key sets');
    const first = Object.keys(rows[0]).sort().join(',');
    for (const r of rows) {
      assert.equal(Object.keys(r).sort().join(','), first,
        `ragged keys in one batch (contact=${contact})`);
    }
    assert.equal('ghl_contact_id' in rows[0], contact !== null);
  }
});
