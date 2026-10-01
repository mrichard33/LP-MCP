/**
 * test-dnc-reentry-sweep.js — a new lead for a blocked number asks for a
 * DNC-lift review on its own (2026-10-01).
 *
 * The user: "The tag should be added automatically, and I did not have one
 * lead that came into the dnc-lift-approval workflow." Two causes, both pinned
 * here: nothing started from a vendor's LP lead, and "blocked" was read from
 * GHL tags / consent only, while 68 of 73 blocked returning leads in one week
 * were blocked only on Five9's DNC list.
 *
 * Offline: runSQL, supabase and the Five9 check are injected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';
process.env.GHL_API_KEY ||= 'test_dummy_key';
process.env.GHL_LOCATION_ID ||= 'test_location';

const core = await import('../src/consent/dnc-reentry.js');
const sweep = await import('../src/jobs/dnc-reentry-sweep.js');
const review = await import('../src/consent/dnc-lift-review.js');
const { JOB_IDS } = await import('../src/job-registry.js');

const lead = (o = {}) => ({
  lp_lead_id: '580022', ghl_contact_id: 'C1', phone10: '3522811388', lead_source: 'Internet',
  lead_source_detail: 'MVP Marketing', disposition_code: 'Data', arrived_at: '2026-10-01T12:00:00.000Z', ...o,
});

// ── the decision ─────────────────────────────────────────────────────────────

test('a lead blocked only on Five9 is asked about — the case the tag check missed', () => {
  const out = core.decideReentryAsks([lead()], { five9Dnc: new Set(['3522811388']) });
  assert.equal(out.ask.length, 1);
  assert.deepEqual(out.ask[0].blocked_in, ['five9']);
});

test('blocked per consent or tags is asked about too; an unblocked lead is settled, not asked', () => {
  const blocks = new Map([['C1', ['consent', 'tags']]]);
  assert.deepEqual(core.decideReentryAsks([lead()], { recordBlocks: blocks }).ask[0].blocked_in, ['consent', 'tags']);
  const clean = core.decideReentryAsks([lead()], {});
  assert.equal(clean.ask.length, 0);
  assert.equal(clean.done[0].reason, 'not_blocked');
});

test('never asks to lift a fresh opt-out', () => {
  const f9 = { five9Dnc: new Set(['3522811388']) };
  assert.equal(core.decideReentryAsks([lead({ disposition_code: 'DNC' })], f9).done[0].reason, 'opted_out_on_this_lead');
  assert.equal(core.decideReentryAsks([lead()], { ...f9, optedOutAfter: new Set(['580022']) }).done[0].reason, 'opted_out_after_arrival');
});

test('one card per contact: already asked, or two leads in one pass', () => {
  const f9 = { five9Dnc: new Set(['3522811388']) };
  assert.equal(core.decideReentryAsks([lead()], { ...f9, alreadyAsked: new Set(['C1']) }).done[0].reason, 'already_asked');
  const two = core.decideReentryAsks([lead(), lead({ lp_lead_id: '580023', lead_source_detail: 'Reecewindows.com' })], f9);
  assert.equal(two.ask.length, 1);
  assert.equal(two.done[0].reason, 'already_asked');
});

test('a lead already decided is skipped; over the cap waits unmarked for the next pass', () => {
  assert.deepEqual(core.decideReentryAsks([lead()], { marked: new Set(['580022']), five9Dnc: new Set(['3522811388']) }),
    { ask: [], done: [], deferred: [] });
  const many = Array.from({ length: 3 }, (_, i) => lead({ lp_lead_id: `L${i}`, ghl_contact_id: `C${i}` }));
  const out = core.decideReentryAsks(many, { five9Dnc: new Set(['3522811388']), max: 2 });
  assert.equal(out.ask.length, 2);
  assert.equal(out.deferred.length, 1);
});

test('the review action names the new lead, its vendor and where it is blocked', () => {
  const a = core.buildReviewAction({ ...lead(), blocked_in: ['five9'] });
  assert.equal(a.action_type, 'request_dnc_lift_review');
  assert.equal(a.rule_applied, 'DNC_REENTRY_SWEEP');
  assert.equal(a.requires_approval, false);
  assert.deepEqual(a.action_payload, { trigger: 'reentry', lead_id: '580022', lead_source: 'Internet', vendor: 'MVP Marketing', blocked_in: ['five9'] });
});

test('record blocks: consent revoked / dnc_full / carrier stop, and the DNC tags', () => {
  assert.deepEqual(core.recordBlocksFor({ consent: { phone_consent: 'revoked' } }), ['consent']);
  assert.deepEqual(core.recordBlocksFor({ tags: ['p3:dnc'] }), ['tags']);
  assert.deepEqual(core.recordBlocksFor({ consent: { phone_consent: 'granted' }, tags: ['customer'] }), []);
});

test('mode defaults to live (it only asks); off and shadow are honoured; registered as a job', () => {
  assert.equal(core.reentryMode({}), 'live');
  assert.equal(core.reentryMode({ DNC_REENTRY_SWEEP_MODE: 'shadow' }), 'shadow');
  assert.equal(core.reentryMode({ DNC_REENTRY_SWEEP_MODE: 'off' }), 'off');
  assert.ok(JOB_IDS.has ? JOB_IDS.has(sweep.JOB_ID) : JOB_IDS.includes(sweep.JOB_ID));
});

test('SQL: LP times are Eastern wall clock; opt-outs after arrival come from consent AND Five9', () => {
  assert.match(sweep.buildLeadsSql(), /AT TIME ZONE 'UTC'\) AT TIME ZONE 'America\/New_York'/);
  const sql = sweep.buildOptedOutAfterSql([lead()]);
  assert.match(sql, /consent_events/);
  assert.match(sql, /five9_events_raw/);
  assert.match(sql, /'Do Not Call','DNC'/);
  assert.match(sql, /'580022', 'C1', '3522811388', '2026-10-01T12:00:00.000Z'::timestamptz/);
});

// ── the pass ─────────────────────────────────────────────────────────────────

function fakes({ leads = [lead()], five9 = ['3522811388'], five9Error = false, opted = [], marked = [] } = {}) {
  const inserted = [];
  const upserts = [];
  const runSQL = async (sql) => {
    if (sql.includes('FROM lp_leads')) return leads.map((l) => ({ ...l, phone: l.phone10 }));
    if (sql.includes('consent_events')) return opted.map((id) => ({ lp_lead_id: id }));
    if (sql.includes('FROM contact_consent') || sql.includes('FROM contact_tag_snapshot')) return [];
    if (sql.includes('agent_actions')) return [];
    throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
  };
  const supabase = {
    from(name) {
      return {
        select() { return this; },
        in: async () => ({ data: marked.map((id) => ({ dedup_key: core.markKey(id) })), error: null }),
        insert(row) { inserted.push({ name, row }); return { select: () => ({ single: async () => ({ data: { id: 9 }, error: null }) }) }; },
        upsert: async (rows) => { upserts.push(...rows); return { error: null }; },
      };
    },
  };
  const checkDnc = async (nums) => {
    if (five9Error) throw new Error('Five9 down');
    return { on_dnc: nums.filter((n) => five9.includes(n)) };
  };
  return { deps: { runSQL, supabase, checkDnc }, inserted, upserts };
}

test('live pass: queues the review and marks the lead', async () => {
  const f = fakes();
  const out = await sweep.runDncReentrySweep({ env: {}, deps: f.deps });
  assert.equal(out.ok, true);
  assert.equal(out.asked, 1);
  assert.equal(f.inserted[0].row.target_id, 'C1');
  assert.deepEqual(f.upserts.map((m) => m.dedup_key), ['dnc-reentry:580022']);
});

test('a Five9 read that fails asks nobody and marks nothing', async () => {
  const f = fakes({ five9Error: true });
  const out = await sweep.runDncReentrySweep({ env: {}, deps: f.deps });
  assert.equal(out.ok, false);
  assert.equal(f.inserted.length, 0);
  assert.equal(f.upserts.length, 0);
});

test('shadow decides but queues and marks nothing', async () => {
  const f = fakes();
  const out = await sweep.runDncReentrySweep({ env: { DNC_REENTRY_SWEEP_MODE: 'shadow' }, deps: f.deps });
  assert.equal(out.would_ask, 1);
  assert.equal(f.inserted.length + f.upserts.length, 0);
});

test('an opt-out after arrival is marked as decided, never asked', async () => {
  const f = fakes({ opted: ['580022'] });
  const out = await sweep.runDncReentrySweep({ env: {}, deps: f.deps });
  assert.equal(out.asked, 0);
  assert.equal(out.settled.opted_out_after_arrival, 1);
  assert.equal(f.upserts.length, 1);
});

// ── the handler sees non-tag blocks ─────────────────────────────────────────

function reviewDb(inserted) {
  return {
    from() {
      const api = {
        select() { return api; }, eq() { return api; }, neq() { return api; }, gte() { return api; },
        limit: async () => ({ data: [], error: null }),
        insert: async (row) => { inserted.push(row); return { error: null }; },
        update() { return { eq: async () => ({ error: null }) }; },
      };
      return api;
    },
  };
}
const reviewDeps = (over = {}) => {
  const inserted = [];
  const posts = [];
  return {
    inserted, posts,
    deps: {
      env: { N8N_DNC_LIFT_REVIEW_WEBHOOK: 'https://n8n.example.com/webhook/x', DNC_LIFT_WEBHOOK_SECRET: 's' },
      supabase: reviewDb(inserted),
      readContact: async () => ({ firstName: 'Pat', phone: '+1 352-281-1388', tags: ['customer'] }),
      getConsent: async () => ({ status: 'ok', consent: null, events: [] }),
      newRequestId: () => 'dnc-lift-t',
      fetch: async (url, init) => { posts.push(JSON.parse(init.body)); return { ok: true, status: 200 }; },
      ...over,
    },
  };
};

test('handler: a contact blocked only on Five9 gets a card that says so, with the lead\'s vendor', async () => {
  const r = reviewDeps({ checkDnc: async () => ({ on_dnc: ['3522811388'] }) });
  const out = await review.executeRequestDncLiftReview(
    { id: 1, target_id: 'C1', action_payload: { trigger: 'reentry', lead_source: 'Internet', vendor: 'MVP Marketing' } }, {}, r.deps);
  assert.equal(out.action, 'review_requested');
  assert.deepEqual(r.posts[0].blocking_tags, [review.BLOCKED_IN_FIVE9]);
  assert.equal(r.posts[0].source, 'Internet');
  assert.equal(r.posts[0].sub_source, 'MVP Marketing');
});

test('handler: blocked per consent alone is enough, and Five9 is not called', async () => {
  let called = 0;
  const r = reviewDeps({
    getConsent: async () => ({ status: 'ok', consent: { phone_consent: 'revoked' }, events: [] }),
    checkDnc: async () => { called += 1; return { on_dnc: [] }; },
  });
  const out = await review.executeRequestDncLiftReview({ id: 1, target_id: 'C1', action_payload: {} }, {}, r.deps);
  assert.equal(out.action, 'review_requested');
  assert.equal(called, 0);
  assert.deepEqual(r.posts[0].blocking_tags, [review.BLOCKED_IN_CONSENT]);
});

test('handler: not on Five9 and nothing else → not_blocked; a failed Five9 read throws so it retries', async () => {
  const clean = reviewDeps({ checkDnc: async () => ({ on_dnc: [] }) });
  assert.equal((await review.executeRequestDncLiftReview({ id: 1, target_id: 'C1', action_payload: {} }, {}, clean.deps)).reason, 'not_blocked');
  const down = reviewDeps({ checkDnc: async () => { throw new Error('soap fault'); } });
  await assert.rejects(() => review.executeRequestDncLiftReview({ id: 1, target_id: 'C1', action_payload: {} }, {}, down.deps), /Five9 DNC check failed/);
  assert.equal(down.inserted.length, 0);
});
