/**
 * Tests — the Sale → P2 backstop
 * scripts/test-p2-sale-backstop.js
 *
 * 2026-10-03: LP's webhook to GHL I.LP-IN stopped on 2026-09-24, so `deal-won`
 * stopped and C.0-IN stopped building P2 cards: 41 recent LP sales (~$1.1M)
 * had no P2 opportunity at all. What matters here:
 *   - a contact with ANY P2 card (mirror or live) is left alone;
 *   - a live sale with no `deal-won` gets the tag (the normal path), never a
 *     second card of our own;
 *   - `deal-won` already there and still no card → create it directly, but
 *     not within an hour of our own tag (C.0-IN is not raced);
 *   - a do-not-contact sale never gets `deal-won` (that starts onboarding);
 *   - a cancelled sale is created Lost with its lost reason, and goes to L.6;
 *   - no price → report only; anything unreadable → nothing written;
 *   - shadow writes nothing; the per-pass cap holds; a placeholder job is
 *     never the one chosen; the grace period lets the normal path win.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
process.env.GHL_API_KEY = process.env.GHL_API_KEY || 'test-ghl-key';

const {
  planForSale, firstSeenMs, findSalesMissingP2, runSaleP2Backstop, backstopMode,
  GRACE_MS, RETAG_WAIT_MS, P2_PIPELINE_ID,
} = await import('../src/p2-sale-backstop.js');
const { lostReasonIdForJobStatus } = await import('../src/lp-lost-reasons.js');

const NOW = Date.parse('2026-10-03T16:00:00Z');
const HOUR = 3_600_000;
const quiet = { log() {}, warn() {}, error() {} };
const iso = (ms) => new Date(ms).toISOString();

const liveJob = { lp_job_id: '60111', job_status: 'RTP Await recission', job_value: 74889, contractdate: '2026-10-01T00:00:00' };
const contact = (tags = []) => ({ id: 'c', firstName: 'Ann', lastName: 'Buyer', tags });

// ── planForSale (pure) ──────────────────────────────────────────────────

test('plan: any P2 card (open, won or lost) means leave it alone', () => {
  for (const status of ['open', 'won', 'lost']) {
    const p = planForSale({ verdict: 'live', job: liveJob, p2Opps: [{ id: 'o', status }], contact: contact(), nowMs: NOW });
    assert.deepEqual(p, { action: 'skip', reason: 'has_p2' });
  }
});

test('plan: an unreadable P2 search or contact writes nothing', () => {
  assert.equal(planForSale({ verdict: 'live', job: liveJob, p2Opps: null, contact: contact(), nowMs: NOW }).action, 'skip');
  assert.equal(planForSale({ verdict: 'live', job: liveJob, p2Opps: [], contact: null, nowMs: NOW }).reason, 'contact_unreadable');
});

test('plan: live sale, no deal-won → add the tag (the normal C.0 path)', () => {
  assert.equal(planForSale({ verdict: 'live', job: liveJob, p2Opps: [], contact: contact(['lp-status:closed-won']), nowMs: NOW }).action, 'tag_deal_won');
});

test('plan: deal-won already there → create directly, but never within an hour of our own tag', () => {
  const c = contact(['deal-won']);
  assert.equal(planForSale({ verdict: 'live', job: liveJob, p2Opps: [], contact: c, nowMs: NOW }).action, 'create_open');
  assert.equal(planForSale({ verdict: 'live', job: liveJob, p2Opps: [], contact: c, taggedAtMs: NOW - 10 * 60_000, nowMs: NOW }).action, 'wait');
  assert.equal(planForSale({ verdict: 'live', job: liveJob, p2Opps: [], contact: c, taggedAtMs: NOW - RETAG_WAIT_MS - 1, nowMs: NOW }).action, 'create_open');
});

test('plan: a do-not-contact sale gets the card directly, never deal-won', () => {
  for (const tag of ['stop-bot', 'DNC', 'suppress-outbound', 'dnc-sms']) {
    assert.equal(planForSale({ verdict: 'live', job: liveJob, p2Opps: [], contact: contact([tag]), nowMs: NOW }).action, 'create_open', tag);
  }
});

test('plan: cancelled / credit-declined → Lost; Paid In Full → Won; no price → report', () => {
  assert.equal(planForSale({ verdict: 'terminal_lost', job: { ...liveJob, job_status: 'Credit Decline' }, p2Opps: [], contact: null, nowMs: NOW }).action, 'create_lost');
  assert.equal(planForSale({ verdict: 'terminal_lost', job: { ...liveJob, job_status: 'Mystery' }, p2Opps: [], contact: null, nowMs: NOW }).action, 'report');
  assert.equal(planForSale({ verdict: 'terminal_won', job: { ...liveJob, job_status: 'Paid In Full' }, p2Opps: [], contact: null, nowMs: NOW }).action, 'create_won');
  assert.deepEqual(planForSale({ verdict: 'live', job: { ...liveJob, job_value: null }, p2Opps: [], contact: contact(), nowMs: NOW }), { action: 'report', reason: 'no_price_yet' });
});

test('firstSeen: our own Sale event wins; else the end of the contract day in Eastern time', () => {
  assert.equal(firstSeenMs({ saleEventAt: '2026-10-02T16:44:08Z', contractDate: '2026-10-01T00:00:00' }), Date.parse('2026-10-02T16:44:08Z'));
  assert.equal(firstSeenMs({ contractDate: '2026-10-02T00:00:00' }), Date.parse('2026-10-03T04:00:00Z'));
  assert.ok(Number.isNaN(firstSeenMs({ contractDate: 'NEW' })));
});

test('mode: shadow by default, unknown values fall back to shadow', () => {
  assert.equal(backstopMode({}), 'shadow');
  assert.equal(backstopMode({ SALE_P2_BACKSTOP_MODE: 'LIVE' }), 'live');
  assert.equal(backstopMode({ SALE_P2_BACKSTOP_MODE: 'yes' }), 'shadow');
});

// ── findSalesMissingP2 / runSaleP2Backstop with fakes ────────────────────

/** Minimal PostgREST-shaped fake over in-memory tables. */
function fakeDb(tables) {
  return {
    from(table) {
      const filters = [];
      const field = (k) => (k === 'raw_lp_data->>contractdate' ? 'contractdate' : k);
      const q = {
        select() { return q; },
        eq(k, v) { filters.push((r) => r[field(k)] === v); return q; },
        in(k, vs) { filters.push((r) => vs.map(String).includes(String(r[field(k)]))); return q; },
        gte(k, v) { filters.push((r) => r[field(k)] != null && String(r[field(k)]) >= String(v)); return q; },
        order() { return q; },
        range() { return q; },
        then(res, rej) {
          return Promise.resolve({ data: (tables[table] || []).filter((r) => filters.every((f) => f(r))), error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
}

function world() {
  const jobs = [
    // c-has: already has a P2 card in the mirror
    { lp_job_id: '1', lp_lead_id: 'L1', ghl_contact_id: 'c-has', job_status: 'RTP Await recission', job_value: 9000, contractdate: '2026-09-30T00:00:00' },
    // c-tag: live sale, no deal-won
    { lp_job_id: '2', lp_lead_id: 'L2', ghl_contact_id: 'c-tag', job_status: 'HOLD - HOA', job_value: 49995, contractdate: '2026-09-29T00:00:00' },
    // c-lost: cancelled after the sale
    { lp_job_id: '3', lp_lead_id: 'L3', ghl_contact_id: 'c-lost', job_status: 'Cancelled', job_value: 23231, contractdate: '2026-09-24T00:00:00' },
    // c-fresh: sold 10 minutes ago — the normal path still has its grace
    { lp_job_id: '4', lp_lead_id: 'L4', ghl_contact_id: 'c-fresh', job_status: 'RTP Await recission', job_value: 15000, contractdate: '2026-10-03T00:00:00' },
    // c-lead: the job carries no contact; its lead does
    { lp_job_id: '5', lp_lead_id: 'L5', ghl_contact_id: null, job_status: 'Awaiting Loan Docs', job_value: 28018, contractdate: '2026-09-28T00:00:00' },
    // c-noprice: a contract with no value yet
    { lp_job_id: '6', lp_lead_id: 'L6', ghl_contact_id: 'c-noprice', job_status: 'Awaiting Paperwork', job_value: null, contractdate: '2026-09-18T00:00:00' },
    // nobody: no contact anywhere
    { lp_job_id: '7', lp_lead_id: 'L7', ghl_contact_id: null, job_status: 'New', job_value: 5000, contractdate: '2026-09-28T00:00:00' },
  ];
  const tables = {
    lp_jobs: jobs,
    lp_leads: [{ lp_lead_id: 'L5', ghl_contact_id: 'c-lead' }],
    system_events: [
      { event_type: 'lp.disposition_changed', event_subtype: 'Sale', lp_lead_id: 'L4', created_at: iso(NOW - 10 * 60_000) },
      { event_type: 'lp.disposition_changed', event_subtype: 'Sale', lp_lead_id: 'L2', created_at: iso(NOW - 4 * 24 * HOUR) },
    ],
  };
  const ghlCalls = [];
  const contacts = {
    'c-tag': contact(['lp-status:closed-won']),
    'c-lost': contact(['lp-status:closed-won']),
    'c-lead': contact(['deal-won']),
    'c-noprice': contact(['deal-won']),
  };
  const deps = {
    __noDefaults: true,
    supabase: fakeDb(tables),
    hlRunSQL: async (sql) => {
      assert.match(sql, new RegExp(P2_PIPELINE_ID));
      return sql.includes("'c-has'") ? [{ ghl_contact_id: 'c-has' }] : [];
    },
    ghlFetch: async (method, path, body) => {
      ghlCalls.push({ method, path, body });
      if (method === 'GET' && path.startsWith('/opportunities/search')) return { opportunities: [] };
      if (method === 'GET' && path.startsWith('/contacts/')) return { contact: contacts[path.split('/')[2]] || null };
      if (method === 'POST') return { opportunity: { id: 'new-opp' } };
      return {};
    },
    jobsForContact: async (cid) => ({ jobs: jobs.filter((j) => j.ghl_contact_id === cid || (cid === 'c-lead' && j.lp_lead_id === 'L5')), leads: [], error: null }),
    applyGHLTag: async (cid, tag) => { ghlCalls.push({ method: 'TAG', path: cid, body: tag }); return true; },
    emitEvent: async (e) => { ghlCalls.push({ method: 'EVENT', path: e.event_subtype, body: e }); },
    moveOpportunity: async (action) => { ghlCalls.push({ method: 'MOVE', path: action.target_id, body: action.action_payload }); return { action: 'created', opportunity_id: 'moved-opp' }; },
    postL6: async (args) => { ghlCalls.push({ method: 'L6', path: args.contactId, body: args }); return { action: 'posted_l6' }; },
    loadP2CreateContext: async () => ({ source: 'Internet, Modernize' }),
  };
  return { deps, ghlCalls, tables };
}

test('find: one decision per contact that truly has no P2 card', async () => {
  const { deps } = world();
  const sales = await findSalesMissingP2({ ...deps, nowMs: NOW, logger: quiet });
  const by = Object.fromEntries(sales.map((s) => [s.contactId, s.plan.action]));
  assert.deepEqual(by, {
    'c-tag': 'tag_deal_won',
    'c-lost': 'create_lost',
    'c-lead': 'create_open',      // found through the lead link; deal-won already there
    'c-noprice': 'report',
  });
  assert.ok(!('c-has' in by), 'a contact the mirror shows with a P2 card is never read live');
  assert.ok(!('c-fresh' in by), 'a sale inside its grace period is left to the normal path');
});

test('find: a live P2 card the mirror has not caught up with still counts', async () => {
  const { deps } = world();
  deps.ghlFetch = async (method, path) => (path.startsWith('/opportunities/search') && path.includes('c-tag')
    ? { opportunities: [{ id: 'just-made', status: 'open' }] }
    : { opportunities: [], contact: contact() });
  const sales = await findSalesMissingP2({ ...deps, nowMs: NOW, logger: quiet });
  assert.equal(sales.find((s) => s.contactId === 'c-tag').plan.action, 'skip');
});

test('find: a placeholder copy is never the job that decides', async () => {
  const { deps } = world();
  // An old real job that kept moving, and a do-nothing copy at the same value
  // in the window: decidingJob drops the copy, so the contact is not this sweep's.
  const real = { lp_job_id: '100', lp_lead_id: 'L9', ghl_contact_id: 'c-copy', job_status: 'Paid In Full', job_value: 12000,
    contractdate: '2026-06-01T00:00:00', payments: [{ pmtamount: '12000', pmtdate: '2026-09-28' }], milestones: [] };
  const copy = { lp_job_id: '101', lp_lead_id: 'L9', ghl_contact_id: 'c-copy', job_status: 'New', job_value: 12000,
    contractdate: '2026-09-25T00:00:00', payments: [], milestones: [] };
  deps.supabase = fakeDb({ lp_jobs: [copy], lp_leads: [], system_events: [] });
  deps.jobsForContact = async () => ({ jobs: [real, copy], leads: [], error: null });
  const sales = await findSalesMissingP2({ ...deps, nowMs: NOW, logger: quiet });
  assert.deepEqual(sales, []);
});

test('run: shadow decides and writes nothing to GHL', async () => {
  const { deps, ghlCalls } = world();
  const r = await runSaleP2Backstop({ mode: 'shadow', deps, nowMs: NOW, logger: quiet });
  assert.equal(r.ok, true);
  assert.equal(r.missing, 4);
  assert.equal(r.writes, 0);
  const writes = ghlCalls.filter((c) => ['TAG', 'MOVE', 'POST', 'PUT', 'L6'].includes(c.method));
  assert.deepEqual(writes, []);
  // The no-price sale is still recorded for the morning digest.
  assert.ok(ghlCalls.some((c) => c.method === 'EVENT' && c.path === 'needs_review'));
});

test('run: live tags, creates directly, and closes a cancelled sale Lost with its reason and L.6', async () => {
  const { deps, ghlCalls } = world();
  const r = await runSaleP2Backstop({ mode: 'live', deps, nowMs: NOW, logger: quiet });
  assert.equal(r.ok, true);
  assert.equal(r.writes, 3);

  assert.ok(ghlCalls.some((c) => c.method === 'TAG' && c.path === 'c-tag' && c.body === 'deal-won'));
  assert.ok(!ghlCalls.some((c) => c.method === 'MOVE' && c.path === 'c-tag'), 'the tag path never also makes its own card');
  assert.ok(ghlCalls.some((c) => c.method === 'MOVE' && c.path === 'c-lead' && c.body.pipeline === 'P2' && c.body.stage === 'Contract Signed'));

  const post = ghlCalls.find((c) => c.method === 'POST');
  assert.equal(post.body.contactId, 'c-lost');
  assert.equal(post.body.pipelineId, P2_PIPELINE_ID);
  assert.equal(post.body.status, 'lost');
  assert.equal(post.body.monetaryValue, 23231);
  assert.equal(post.body.source, 'Internet, Modernize');
  assert.deepEqual(post.body.customFields, [{ id: 'sMZfcWAdoqh88pghLsNQ', field_value: '3' }]);
  const put = ghlCalls.find((c) => c.method === 'PUT');
  assert.equal(put.path, '/opportunities/new-opp');
  assert.deepEqual(put.body, { status: 'lost', lostReasonId: lostReasonIdForJobStatus('Cancelled') });
  const l6 = ghlCalls.find((c) => c.method === 'L6');
  assert.equal(l6.body.opportunityId, 'new-opp');

  assert.ok(!ghlCalls.some((c) => ['TAG', 'MOVE', 'POST'].includes(c.method) && c.path === 'c-noprice'), 'no price → no write');
  const subtypes = ghlCalls.filter((c) => c.method === 'EVENT').map((c) => c.path).sort();
  assert.deepEqual(subtypes, ['created_lost', 'created_open', 'needs_review', 'tagged_deal_won']);
});

test('run: the per-pass cap holds, and a failed write is a failed pass', async () => {
  const { deps, ghlCalls } = world();
  const r1 = await runSaleP2Backstop({ mode: 'live', deps, nowMs: NOW, logger: quiet, maxActions: 1 });
  assert.equal(r1.writes, 1);
  assert.equal(ghlCalls.filter((c) => ['TAG', 'MOVE', 'POST'].includes(c.method)).length, 1);

  const w = world();
  w.deps.applyGHLTag = async () => false;
  const r2 = await runSaleP2Backstop({ mode: 'live', deps: w.deps, nowMs: NOW, logger: quiet });
  assert.equal(r2.ok, false);
  assert.equal(r2.failures, 1);
});

test('run: a failed bulk read is { ok: false }, never a throw', async () => {
  const { deps } = world();
  deps.hlRunSQL = async () => { throw new Error('HL down'); };
  const r = await runSaleP2Backstop({ mode: 'live', deps, nowMs: NOW, logger: quiet });
  assert.deepEqual({ ok: r.ok, error: r.error }, { ok: false, error: 'HL down' });
});

test('run: off does nothing at all', async () => {
  const r = await runSaleP2Backstop({ mode: 'off', deps: { __noDefaults: true }, logger: quiet });
  assert.equal(r.skipped, 'SALE_P2_BACKSTOP_MODE=off');
});

test('grace constant: the normal path gets at least 30 minutes', () => {
  assert.ok(GRACE_MS >= 30 * 60_000);
});
