/**
 * LP contact auto-create backstop — scripts/test-lp-contact-backstop.js
 *
 * Covers src/services/lp-contact-backstop.js:
 *   1. selectBackstopTargets — pure today-or-future / phone / dedupe / cap
 *      logic (no DB, no fetch).
 *   2. processOneLead — the effectful find-before-create → link/create →
 *      reconcile path, against a recorded fetch stub. supabase is left
 *      unconfigured (null): the writeback is guarded on it, and the reconciler
 *      runs from the injected lead row — same mechanism as
 *      test-lp-ghl-appointment-sync.js. All GHL I/O bottoms out at global
 *      fetch (ghlFetch + fetchUpcomingAppointments), so one stub covers the
 *      whole path including the reconciler tail.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GHL_API_KEY = 'test-key';
// Intentionally NOT setting SUPABASE_* — the service must run without it
// (writeback is guarded; the reconciler takes the injected lead row).

// ─── fetch stub (installed before import) ────────────────────────────
let calls = [];
let searchContacts = [];        // GET /contacts/?query=  → { contacts }
let searchByCall = null;        // if set: per-call search results (array of arrays)
let searchCallCount = 0;
let fullContact = { id: 'ext-1', tags: [], customFields: [] }; // GET /contacts/{id}
let upcomingAppointments = [];  // GET /contacts/{id}/appointments
let createdContactId = 'new-contact-1';
let createShouldThrow400 = false;

function jsonRes(body) {
  return {
    status: 200, ok: true,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
function errRes(status, text) {
  return {
    status, ok: false,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => text,
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  const path = String(url).replace('https://services.leadconnectorhq.com', '');
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ method, path, body });

  // contact phone search (must precede the single-contact GET)
  if (method === 'GET' && /^\/contacts\/\?query=/.test(path)) {
    searchCallCount++;
    const contacts = searchByCall ? (searchByCall[searchCallCount - 1] || []) : searchContacts;
    return jsonRes({ contacts });
  }
  // reconciler upcoming appointments (must precede the single-contact GET)
  if (method === 'GET' && /^\/contacts\/[^/?]+\/appointments/.test(path)) {
    return jsonRes({ events: upcomingAppointments });
  }
  // full contact read (link path + reconciler DNC read)
  if (method === 'GET' && /^\/contacts\/[^/?]+$/.test(path)) {
    return jsonRes({ contact: fullContact });
  }
  // contact create
  if (method === 'POST' && path === '/contacts/') {
    if (createShouldThrow400) return errRes(400, JSON.stringify({ message: 'This location does not allow duplicated contacts.' }));
    return jsonRes({ contact: { id: createdContactId } });
  }
  // contact field-stamp PUT
  if (method === 'PUT' && /^\/contacts\/[^/?]+$/.test(path)) {
    return jsonRes({ contact: { id: path.split('/').pop() } });
  }
  // reconciler appointment create / reschedule
  if (method === 'POST' && path === '/calendars/events/appointments') return jsonRes({ id: 'new-appt-1' });
  if (method === 'PUT' && path.startsWith('/calendars/events/appointments/')) return jsonRes({ id: path.split('/').pop() });
  return jsonRes({});
};

const {
  selectBackstopTargets, processOneLead, backstopTagsFor, cleanName,
  LP_BACKSTOP_ALWAYS_TAGS,
} = await import('../src/services/lp-contact-backstop.js');

const GHL_LOCATION_ID = 'SsBG7j5KQAIP1SFP2Sca';
const LP_LEAD_ID_FIELD = 'GmAVmW6V9sekD7pVONKr';
const LP_PROSPECT_ID_FIELD = 'ZRQAVrzhtzApzLlHmT87';
// FUTURE = an upcoming appointment INSIDE the backstop selection window
// (today .. +MAX_HORIZON_DAYS). Computed relative to now so it stays in-window
// whenever the suite runs. ~14 days out. (The old fixed 2027 literal now falls
// outside the hardened absolute ceiling — that's the guard working.)
// ⚠️ The TIME OF DAY must be pinned too, not just the date. This used to be a
// bare `Date.now() + 14d`, which inherits the wall-clock hour of whenever the
// suite runs — so the reconciler's business-hours guard
// (BUSINESS_HOUR_START_ET 8 .. BUSINESS_HOUR_END_ET 20, exclusive) rejected it
// with 'impossible_hour' on any run after ~8pm ET or before 8am ET. That made
// four tests pass or fail by clock. 16:00 UTC is noon ET in summer and 11:00 ET
// in winter — mid-window under either offset.
const FUTURE = (() => {
  const d = new Date(Date.now() + 14 * 24 * 3600 * 1000);
  d.setUTCHours(16, 0, 0, 0);
  return d.toISOString();
})();
// Beyond the absolute ceiling — the garbage-date class (Sept-far-out, year-3026
// junk) the guard must reject regardless of any horizon param.
const ABSURD_FUTURE = '3026-06-16T18:00:00+00:00';
const NINETY_DAYS_OUT = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();

function reset({ search = [], searchQueue = null, full = null, upcoming = [], create400 = false } = {}) {
  calls = [];
  searchContacts = search;
  searchByCall = searchQueue;
  searchCallCount = 0;
  fullContact = full || { id: 'ext-1', tags: [], customFields: [] };
  upcomingAppointments = upcoming;
  createShouldThrow400 = create400;
  createdContactId = 'new-contact-1';
}
const posts = (p) => calls.filter((c) => c.method === 'POST' && c.path === p);
const contactCreates = () => calls.filter((c) => c.method === 'POST' && c.path === '/contacts/');
const mutations = () => calls.filter((c) => c.method === 'POST' || c.method === 'PUT');
// `created_at_lp` defaults to JUST NOW. Without it the field is undefined, the
// lead reads as indefinitely old, and every creation picks up
// `suppress-outbound` (DEFAULT_INTAKE_FRESH_HOURS = 24) — which silently
// changed what the tag-mapping test below was asserting. A fresh lead is the
// normal case; the stale case is covered explicitly at the end of this file.
const lead = (over = {}) => ({
  lp_lead_id: '555360', lp_prospect_id: '900001', disposition_code: 'Set',
  appointment_date: FUTURE, first_name: 'Jane', last_name: 'Blust',
  phone: '(239) 555-1234', lead_source: 'Canvass',
  created_at_lp: new Date().toISOString(), ...over,
});

// ═══ 1. Pure selection ════════════════════════════════════════════════

test('selectBackstopTargets: cap 50 of 60 eligible → 10 deferred', () => {
  const rows = Array.from({ length: 60 }, (_, i) => lead({
    lp_lead_id: String(600000 + i),
    phone: `239555${String(1000 + i).padStart(4, '0')}`, // unique phones
  }));
  const sel = selectBackstopTargets(rows, { maxPerRun: 50 });
  assert.equal(sel.eligible, 60);
  assert.equal(sel.targets.length, 50);
  assert.equal(sel.deferredCapped, 10);
});

test('selectBackstopTargets: dedupe by phone (newest wins), no-phone reported', () => {
  const rows = [
    lead({ lp_lead_id: 'new', phone: '2395550000', created_at_lp: '2026-07-09T00:00:00Z' }),
    lead({ lp_lead_id: 'old', phone: '(239) 555-0000', created_at_lp: '2026-07-01T00:00:00Z' }), // same phone
    lead({ lp_lead_id: 'nophone', phone: '123' }), // too short
  ];
  const sel = selectBackstopTargets(rows, { maxPerRun: 50 });
  assert.equal(sel.targets.length, 1);
  assert.equal(sel.targets[0].lead.lp_lead_id, 'new'); // first-seen (newest) wins
  assert.equal(sel.targets[0].superseded, 1);
  assert.equal(sel.noPhone.length, 1);
  assert.equal(sel.noPhone[0].lp_lead_id, 'nophone');
});

test('selectBackstopTargets: past appointment excluded', () => {
  const rows = [lead({ appointment_date: '2020-01-01T10:00:00+00:00' })];
  const sel = selectBackstopTargets(rows, { maxPerRun: 50 });
  assert.equal(sel.targets.length, 0);
  assert.equal(sel.noPhone.length, 0);
});

test('date guard: absurd-future (year 3026) excluded — never mints a garbage contact', () => {
  const rows = [lead({ appointment_date: ABSURD_FUTURE })];
  const sel = selectBackstopTargets(rows, { maxPerRun: 50 });
  assert.equal(sel.targets.length, 0);
  assert.equal(sel.eligible, 0);
});

test('date guard: beyond the absolute ceiling (~90d out) excluded even though it is "future"', () => {
  const rows = [lead({ appointment_date: NINETY_DAYS_OUT })];
  const sel = selectBackstopTargets(rows, { maxPerRun: 50 });
  assert.equal(sel.targets.length, 0); // > MAX_HORIZON_DAYS (60)
});

test('date guard: in-window upcoming appointment still selected', () => {
  const rows = [lead({ appointment_date: FUTURE })]; // ~14d out
  const sel = selectBackstopTargets(rows, { maxPerRun: 50 });
  assert.equal(sel.targets.length, 1);
});

// ═══ 2. Tag map + name hygiene ════════════════════════════════════════

test('backstopTagsFor: one active-entry, one stage, source per lead_source', () => {
  assert.deepEqual(backstopTagsFor('Canvass'),
    ['entry:canvassing', 'active-entry:canvassing', 'source:canvass', ...LP_BACKSTOP_ALWAYS_TAGS]);
  assert.deepEqual(backstopTagsFor('Internet'),
    ['entry:other', 'active-entry:other', 'source:internet', ...LP_BACKSTOP_ALWAYS_TAGS]);
  assert.deepEqual(backstopTagsFor('Affiliates'),
    ['entry:other', 'active-entry:other', 'source:affiliate', ...LP_BACKSTOP_ALWAYS_TAGS]);
  assert.deepEqual(backstopTagsFor('anything-else'),
    ['entry:other', 'active-entry:other', 'source:unknown', ...LP_BACKSTOP_ALWAYS_TAGS]);
  for (const src of ['Canvass', 'Internet', 'Affiliates', 'weird']) {
    const t = backstopTagsFor(src);
    assert.equal(t.filter((x) => x.startsWith('active-entry:')).length, 1);
    assert.equal(t.filter((x) => x.startsWith('stage:')).length, 1);
  }
});

test('cleanName: junk → empty, real names preserved', () => {
  assert.equal(cleanName('N/A'), '');
  assert.equal(cleanName('..'), '');
  assert.equal(cleanName('  ?  '), '');
  assert.equal(cleanName('  Jane   Doe '), 'Jane Doe');
});

// ═══ 3. processOneLead — effectful ════════════════════════════════════

test('(1) phone match → link + stamp, zero POST /contacts, reconcile once', async () => {
  reset({ search: [{ id: 'ext-1', phone: '2395551234' }], full: { id: 'ext-1', tags: [], customFields: [] } });
  const r = await processOneLead({ lead: lead(), contactCache: new Map() });
  assert.equal(r.outcome, 'linked');
  assert.equal(r.contact_id, 'ext-1');
  assert.equal(contactCreates().length, 0);                       // never created
  assert.equal(r.appointment_result, 'created');                  // reconciler booked it
  // exactly one appointment POST (the reconcile), and one field-stamp PUT
  assert.equal(posts('/calendars/events/appointments').length, 1);
  const stampPuts = calls.filter((c) => c.method === 'PUT' && /^\/contacts\/ext-1$/.test(c.path));
  assert.equal(stampPuts.length, 1);
  assert.deepEqual(stampPuts[0].body.customFields, [
    { id: LP_LEAD_ID_FIELD, field_value: '555360' },
    { id: LP_PROSPECT_ID_FIELD, field_value: '900001' },
  ]);
});

test('(1b) link stamps only empty fields — non-empty LP Lead ID preserved', async () => {
  reset({
    search: [{ id: 'ext-1', phone: '2395551234' }],
    full: { id: 'ext-1', tags: [], customFields: [{ id: LP_LEAD_ID_FIELD, field_value: '999' }] },
  });
  await processOneLead({ lead: lead(), contactCache: new Map() });
  const stampPuts = calls.filter((c) => c.method === 'PUT' && /^\/contacts\/ext-1$/.test(c.path));
  assert.equal(stampPuts.length, 1);
  // LP Lead ID already set → only the prospect field is stamped
  assert.deepEqual(stampPuts[0].body.customFields, [{ id: LP_PROSPECT_ID_FIELD, field_value: '900001' }]);
});

test('(2) no match → one POST /contacts with correct tags/source/customFields, reconcile', async () => {
  for (const [src, expectTags] of [
    ['Canvass', ['entry:canvassing', 'active-entry:canvassing', 'source:canvass', ...LP_BACKSTOP_ALWAYS_TAGS]],
    ['Internet', ['entry:other', 'active-entry:other', 'source:internet', ...LP_BACKSTOP_ALWAYS_TAGS]],
    ['Affiliates', ['entry:other', 'active-entry:other', 'source:affiliate', ...LP_BACKSTOP_ALWAYS_TAGS]],
    ['Mystery', ['entry:other', 'active-entry:other', 'source:unknown', ...LP_BACKSTOP_ALWAYS_TAGS]],
  ]) {
    reset({ search: [] });
    const r = await processOneLead({ lead: lead({ lead_source: src }), contactCache: new Map() });
    assert.equal(r.outcome, 'created', `src ${src}`);
    assert.equal(contactCreates().length, 1, `src ${src}`);
    const b = contactCreates()[0].body;
    assert.equal(b.locationId, GHL_LOCATION_ID);
    assert.equal(b.source, src, `src ${src}`); // the LP lead source, not the mechanism
    assert.deepEqual(b.tags, expectTags, `src ${src}`);
    assert.deepEqual(b.customFields, [
      { id: LP_LEAD_ID_FIELD, field_value: '555360' },
      { id: LP_PROSPECT_ID_FIELD, field_value: '900001' },
    ]);
    assert.equal(posts('/calendars/events/appointments').length, 1, `reconcile for ${src}`);
  }
});

// ─── source attribution on the create body ───────────────────────────
// Same stub, same path as (2) above — just narrowed to the create body so the
// source-field cases read as one thing each.
async function captureCreateBody(over) {
  reset({ search: [] }); // no phone match → the create branch
  await processOneLead({ lead: lead(over), contactCache: new Map() });
  assert.equal(contactCreates().length, 1);
  return contactCreates()[0].body;
}

test('a created contact carries the LP lead source, not the mechanism', async () => {
  // The whole point: 'lp-backstop' is how the lead arrived, not where from.
  const body = await captureCreateBody({ lead_source: 'Canvass' });
  assert.equal(body.source, 'Canvass');
});

test('the vendor detail stays on its tag and out of the source field', async () => {
  const body = await captureCreateBody({
    lead_source: 'Internet', lead_source_detail: 'Modernize',
  });
  assert.equal(body.source, 'Internet');
  assert.ok(body.tags.includes('source:internet-modernize'));
});

test('a lead with no LP source still falls back to the mechanism', async () => {
  for (const missing of [null, undefined, '']) {
    const body = await captureCreateBody({ lead_source: missing });
    assert.equal(body.source, 'lp-backstop');
  }
});

test('provenance survives the change', async () => {
  const body = await captureCreateBody({ lead_source: 'Canvass' });
  assert.ok(body.tags.includes('lp-backstop-created'));
});

test('(3) junk name → created with empty firstName/lastName, not "N/A"', async () => {
  reset({ search: [] });
  await processOneLead({ lead: lead({ first_name: 'N/A', last_name: '..' }), contactCache: new Map() });
  const b = contactCreates()[0].body;
  assert.equal(b.firstName, '');
  assert.equal(b.lastName, '');
});

test('(4) no phone → no search, no create, skipped_no_phone', async () => {
  reset({ search: [{ id: 'should-not-be-hit' }] });
  const r = await processOneLead({ lead: lead({ phone: '12' }), contactCache: new Map() });
  assert.equal(r.outcome, 'skipped_no_phone');
  assert.equal(calls.length, 0); // never even searched
});

test('(5) existing DNC contact → link-only, no appointment create', async () => {
  reset({
    search: [{ id: 'ext-dnc', phone: '2395551234' }],
    full: { id: 'ext-dnc', tags: ['dnc'], customFields: [] },
  });
  const r = await processOneLead({ lead: lead(), contactCache: new Map() });
  assert.equal(r.outcome, 'skipped_dnc');
  assert.equal(r.contact_id, 'ext-dnc');
  assert.equal(contactCreates().length, 0);
  assert.equal(posts('/calendars/events/appointments').length, 0); // reconciler DNC guard blocks it
});

test('(7) duplicate-400 on create → re-search → linked', async () => {
  reset({
    searchQueue: [[], [{ id: 'ext-dup', phone: '2395551234' }]], // 1st search empty, retry finds it
    full: { id: 'ext-dup', tags: [], customFields: [] },
    create400: true,
  });
  const r = await processOneLead({ lead: lead(), contactCache: new Map() });
  assert.equal(r.outcome, 'linked');
  assert.equal(r.contact_id, 'ext-dup');
  assert.equal(contactCreates().length, 1);   // create attempted once (threw 400)
  assert.equal(searchCallCount, 2);            // original + retry
  assert.equal(posts('/calendars/events/appointments').length, 1); // still reconciled
});

test('(8) dry-run → search GETs allowed, zero POST/PUT anywhere', async () => {
  // match path
  reset({ search: [{ id: 'ext-1', phone: '2395551234' }], full: { id: 'ext-1', tags: [], customFields: [] } });
  await processOneLead({ lead: lead(), dryRun: true, contactCache: new Map() });
  assert.equal(mutations().length, 0, 'match dry-run must not mutate');
  assert.ok(calls.some((c) => c.method === 'GET'), 'dry-run still reads');

  // no-match path
  reset({ search: [] });
  const r = await processOneLead({ lead: lead(), dryRun: true, contactCache: new Map() });
  assert.equal(mutations().length, 0, 'no-match dry-run must not mutate');
  assert.equal(contactCreates().length, 0);
  assert.equal(r.outcome, 'created'); // planned create, no contact yet
});

// ═══ Speed-to-lead suppression (the behaviour that surfaced the stale fixture)
test('a lead older than the freshness window is created with suppress-outbound', async () => {
  // "A lead that filled out a form days ago must not receive a speed-to-lead
  // text as if it just arrived." Asserted here rather than left to leak into an
  // unrelated tag-mapping test.
  reset({ search: [] });
  const stale = lead({
    created_at_lp: new Date(Date.now() - 72 * 3600 * 1000).toISOString(),
  });
  const r = await processOneLead({ lead: stale, contactCache: new Map() });
  assert.equal(r.outcome, 'created');
  assert.ok(contactCreates()[0].body.tags.includes('suppress-outbound'));
});

test('a fresh lead is NOT suppressed — the guard is age-based, not always-on', async () => {
  reset({ search: [] });
  const r = await processOneLead({ lead: lead(), contactCache: new Map() });
  assert.equal(r.outcome, 'created');
  assert.ok(!contactCreates()[0].body.tags.includes('suppress-outbound'));
});
