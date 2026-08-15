/**
 * LP backstop phone verification — scripts/test-lp-backstop-phone-match.js
 *
 * Covers the 2026-08-15 cross-contamination fix in
 * src/services/lp-contact-backstop.js: pickPhoneMatch no longer accepts an
 * unverified top hit, and searchByPhone confirms a phone-less candidate
 * against the full GHL contact record before anything is linked.
 *
 * Neither function is exported, so the path is driven through the exported
 * processOneLead() against a recorded fetch stub — the same mechanism as
 * scripts/test-lp-contact-backstop.js.
 *
 * TWO DELIBERATE FIXTURE CHOICES keep these tests about the match decision
 * and nothing else:
 *   1. dryRun: true. A dry run that finds a match still links and reads the
 *      contact (outcome 'linked'); a dry run that finds NO match returns
 *      early with outcome 'created' + dry_run: true and never POSTs. So the
 *      outcome field alone is an exact read of "did we link this person?".
 *   2. No appointment_date on the lead. reconcileLpAppointmentToGhl only runs
 *      when the lead carries one, so there is zero reconciler I/O and no
 *      dependence on the wall clock or the business-hours guard.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GHL_API_KEY = 'test-key';
// Intentionally NOT setting SUPABASE_* — the writeback is guarded on it.

// ─── fetch stub (installed before import) ────────────────────────────
let calls = [];
let searchContacts = [];   // GET /contacts/?query=  → { contacts }
let fullById = {};         // GET /contacts/{id}     → { contact }
let throwIds = new Set();  // ids whose full GET returns 500

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
  calls.push({ method, path, body: opts.body ? JSON.parse(opts.body) : null });

  // phone search (must precede the single-contact GET)
  if (method === 'GET' && /^\/contacts\/\?query=/.test(path)) {
    return jsonRes({ contacts: searchContacts });
  }
  // full contact read — the verification GET and the caller's own read
  if (method === 'GET' && /^\/contacts\/[^/?]+$/.test(path)) {
    const id = path.split('/').pop();
    if (throwIds.has(id)) return errRes(500, 'boom');
    return jsonRes({ contact: fullById[id] || { id, tags: [], customFields: [] } });
  }
  return jsonRes({});
};

const { processOneLead } = await import('../src/services/lp-contact-backstop.js');

const LP_LEAD_ID_FIELD = 'GmAVmW6V9sekD7pVONKr';

function reset({ search = [], full = {}, throwOn = [] } = {}) {
  calls = [];
  searchContacts = search;
  fullById = full;
  throwIds = new Set(throwOn);
}

// Lisa Walsh — LP lead 567020, 352-812-1262. The lead being backstopped.
const lisa = (over = {}) => ({
  lp_lead_id: '567020', lp_prospect_id: '900002', disposition_code: 'Data',
  first_name: 'Lisa', last_name: 'Walsh', phone: '(352) 812-1262',
  lead_source: 'Canvass', created_at_lp: new Date().toISOString(),
  ...over, // no appointment_date → no reconciler I/O
});

const contactGets = () => calls.filter((c) => c.method === 'GET' && /^\/contacts\/[^/?]+$/.test(c.path));
const contactCreates = () => calls.filter((c) => c.method === 'POST' && c.path === '/contacts/');

// A dry run that did NOT link reports outcome 'created' (it would create) and
// never touches POST /contacts.
function assertNotLinked(r) {
  assert.equal(r.outcome, 'created', 'expected NO link');
  assert.equal(r.dry_run, true);
  assert.equal(r.contact_id, undefined, 'nothing may be linked');
  assert.equal(contactCreates().length, 0, 'dry run must not create');
}

// ═══ 1. Verified in the projection ════════════════════════════════════

test('(1) projection carries a matching phone → linked, no verification GET', async () => {
  reset({
    search: [{ id: 'lisa-ghl', phone: '3528121262' }],
    full: { 'lisa-ghl': { id: 'lisa-ghl', phone: '3528121262', tags: [], customFields: [] } },
  });
  const r = await processOneLead({ lead: lisa(), contactCache: new Map(), dryRun: true });
  assert.equal(r.outcome, 'linked');
  assert.equal(r.contact_id, 'lisa-ghl');
  // Exactly ONE full-contact GET: the caller's own read at the link site. The
  // verified path must not add a second, confirming round trip.
  assert.equal(contactGets().length, 1, 'verified match must not trigger a verification GET');
});

// ═══ 2. Mismatching phone in the projection ═══════════════════════════

test('(2) projection carries only a MISMATCHING phone → nothing linked', async () => {
  // Yvonne Laing (LP lead 566250, 904-487-0668) surfacing as the top hit for
  // Lisa's number. A phone that is present and different is a false positive.
  // This path was already correct before the fix; the test pins it so the
  // rewrite of pickPhoneMatch's return contract cannot regress it.
  reset({ search: [{ id: 'yvonne-ghl', phone: '9044870668' }] });
  const r = await processOneLead({ lead: lisa(), contactCache: new Map(), dryRun: true });
  assertNotLinked(r);
  assert.equal(contactGets().length, 0, 'a mismatching hit must not be read at all');
});

// ═══ 3-5. No phone in the projection — the contamination class ════════

test('(3) projection has no phone, full GET confirms the match → linked', async () => {
  reset({
    search: [{ id: 'lisa-ghl' }], // projection omitted phone, as GHL routinely does
    full: { 'lisa-ghl': { id: 'lisa-ghl', phone: '+13528121262', tags: [], customFields: [] } },
  });
  const r = await processOneLead({ lead: lisa(), contactCache: new Map(), dryRun: true });
  assert.equal(r.outcome, 'linked');
  assert.equal(r.contact_id, 'lisa-ghl');
  // The verification GET plus the caller's read.
  assert.equal(contactGets().length, 2, 'unverified candidate must be confirmed by a full GET');
});

test('(4) projection has no phone, full GET shows a DIFFERENT phone → nothing linked', async () => {
  // THE REGRESSION. This is the exact shape that stamped Yvonne Laing's LP
  // identity onto five unrelated contacts: a phone-less chat-widget "guest
  // visitor" record was the top hit, and the old fallback
  // `return list[0]?.phone ? null : list[0]` accepted it precisely BECAUSE it
  // had no phone. Under the old code this test links guest-visitor; under the
  // fix the confirming read rejects it.
  reset({
    search: [{ id: 'guest-visitor' }],
    full: { 'guest-visitor': { id: 'guest-visitor', phone: '9044870668', tags: [], customFields: [] } },
  });
  const r = await processOneLead({ lead: lisa(), contactCache: new Map(), dryRun: true });
  assertNotLinked(r);
  assert.equal(contactGets().length, 1, 'exactly one confirming read, and it rejected');
});

test('(5) projection has no phone, full GET throws → nothing linked', async () => {
  // Fail closed: an unverifiable match is not a match. A duplicate contact is
  // recoverable; a mis-linked LP identity is not.
  reset({ search: [{ id: 'guest-visitor' }], throwOn: ['guest-visitor'] });
  const r = await processOneLead({ lead: lisa(), contactCache: new Map(), dryRun: true });
  assertNotLinked(r);
});

test('(5b) full GET returns a contact with NO phone at all → nothing linked', async () => {
  // A record that genuinely has no phone can never be verified against one.
  reset({
    search: [{ id: 'guest-visitor' }],
    full: { 'guest-visitor': { id: 'guest-visitor', tags: [], customFields: [] } },
  });
  const r = await processOneLead({ lead: lisa(), contactCache: new Map(), dryRun: true });
  assertNotLinked(r);
});

// ═══ 6. Nothing to match ══════════════════════════════════════════════

test('(6) empty search result → nothing linked, no reads', async () => {
  reset({ search: [] });
  const r = await processOneLead({ lead: lisa(), contactCache: new Map(), dryRun: true });
  assertNotLinked(r);
  assert.equal(contactGets().length, 0);
});

// ═══ 7. Contract guard ════════════════════════════════════════════════

test('(7) a phone-less candidate is preferred over a mismatching one, and still verified', async () => {
  // Ordering guard: pickPhoneMatch scans for a phone-less candidate rather
  // than blindly taking list[0]. The phone-less record is the one that can
  // still be confirmed; the mismatching one is already disqualified.
  reset({
    search: [{ id: 'yvonne-ghl', phone: '9044870668' }, { id: 'lisa-ghl' }],
    full: { 'lisa-ghl': { id: 'lisa-ghl', phone: '3528121262', tags: [], customFields: [] } },
  });
  const r = await processOneLead({ lead: lisa(), contactCache: new Map(), dryRun: true });
  assert.equal(r.outcome, 'linked');
  assert.equal(r.contact_id, 'lisa-ghl', 'must confirm the verifiable candidate, never the mismatching hit');
});

// ═══ 8. Stamping is unreachable without a verified link ═══════════════

test('(8) a rejected match never stamps LP fields onto the contact', async () => {
  // The operative harm: stampFieldsFor writes lp_lead_id / lp_prospect_id onto
  // whatever contact was linked. Run WITHOUT dryRun so stamping is live, and
  // assert the rejected contact is never written to.
  reset({
    search: [{ id: 'guest-visitor' }],
    full: { 'guest-visitor': { id: 'guest-visitor', phone: '9044870668', tags: [], customFields: [] } },
  });
  await processOneLead({ lead: lisa(), contactCache: new Map() });
  const stampPuts = calls.filter((c) => c.method === 'PUT' && /^\/contacts\/guest-visitor$/.test(c.path));
  assert.equal(stampPuts.length, 0, 'the wrong contact must never receive an LP identity stamp');
  const wroteLeadId = calls.some((c) =>
    c.body?.customFields?.some((f) => f.id === LP_LEAD_ID_FIELD && f.field_value === '567020')
    && /^\/contacts\/guest-visitor$/.test(c.path));
  assert.equal(wroteLeadId, false);
});
