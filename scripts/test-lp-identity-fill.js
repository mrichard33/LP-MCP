/**
 * LP → GHL identity fill — scripts/test-lp-identity-fill.js
 *
 * Covers src/services/lp-identity-fill.js (the fill-empty-only rules), its
 * three writers (the backstop link path, /n8n/enrich-lead, the sweep core in
 * src/services/lp-identity-backfill.js) and the sweep's mode switch.
 *
 * The incident: GHL contact a9eG41qtxCqMEXxbbD2l reached an in-home demo with
 * no name while LP lead 581424 held "Andrew " / "Marcus".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GHL_API_KEY = 'test-key';

// ─── fetch stub for the backstop link path (installed before import) ─────
let calls = [];
let fullContact = {};
function jsonRes(body) {
  return {
    status: 200, ok: true,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  const path = String(url).replace('https://services.leadconnectorhq.com', '');
  calls.push({ method, path, body: opts.body ? JSON.parse(opts.body) : null });
  if (method === 'GET' && /^\/contacts\/\?query=/.test(path)) return jsonRes({ contacts: [{ id: 'a9eG41qtxCqMEXxbbD2l', phone: '+13213882055' }] });
  if (method === 'GET' && /^\/contacts\/[^/?]+\/appointments/.test(path)) return jsonRes({ events: [] });
  if (method === 'GET' && /^\/contacts\/[^/?]+$/.test(path)) return jsonRes({ contact: fullContact });
  if (method === 'PUT' && /^\/contacts\/[^/?]+$/.test(path)) return jsonRes({ contact: { id: path.split('/').pop() } });
  return jsonRes({});
};

const {
  buildIdentityFill, nameIsReplaceable, cleanEmail, cleanAddressPart, dropTakenEmail,
  putWithIdentityFill, IDENTITY_FILL_FIELDS,
} = await import('../src/services/lp-identity-fill.js');
const { runIdentityFill, verifiedLinkBasis, pickNamedLeadPerContact } = await import('../src/services/lp-identity-backfill.js');
const { processOneLead } = await import('../src/services/lp-contact-backstop.js');
const { __testing: enrich } = await import('../src/n8n-enrichment.js');
const { runIdentityFillSweep, identityFillMode } = await import('../src/jobs/lp-identity-fill-sweep.js');

const LP_LEAD_ID_FIELD = 'GmAVmW6V9sekD7pVONKr';
const ANDREW = { first_name: 'Andrew ', last_name: 'Marcus', phone: '3213882055' };

// ═══ 1. The rules ════════════════════════════════════════════════════════

test('empty GHL name + LP "Andrew " / "Marcus" → fills Andrew / Marcus', () => {
  const fill = buildIdentityFill({ id: 'c', firstName: '', lastName: null }, ANDREW);
  assert.deepEqual(fill, { firstName: 'Andrew', lastName: 'Marcus' });
});

test('GHL has "Andy" → NOT overwritten', () => {
  const fill = buildIdentityFill({ firstName: 'Andy', lastName: '' }, ANDREW);
  assert.equal(fill.firstName, undefined);
  // only the truly empty part may be filled
  assert.equal(fill.lastName, 'Marcus');
  assert.deepEqual(buildIdentityFill({ firstName: 'Andy', lastName: 'Smith' }, ANDREW), {});
});

test('GHL display name = the phone number, no real name → fills', () => {
  assert.equal(nameIsReplaceable({ firstName: '+13213882055', lastName: '' }), true);
  const fill = buildIdentityFill({ firstName: '+13213882055', lastName: '' }, ANDREW);
  assert.deepEqual(fill, { firstName: 'Andrew', lastName: 'Marcus' });
  // a phone-number surname is cleared, not kept beside a real name
  const fill2 = buildIdentityFill({ firstName: '', lastName: '(321) 388-2055' }, { first_name: 'Andrew' });
  assert.deepEqual(fill2, { firstName: 'Andrew', lastName: '' });
});

test('"Guest Visitor …" placeholder is replaced as a whole', () => {
  const fill = buildIdentityFill({ firstName: 'Guest', lastName: 'Visitor ab12' }, ANDREW);
  assert.deepEqual(fill, { firstName: 'Andrew', lastName: 'Marcus' });
});

test('LP name "n/a" / "test" / "unknown" → no fill', () => {
  for (const junk of ['n/a', 'test', 'unknown', 'N/A', '  ', '12345']) {
    assert.deepEqual(buildIdentityFill({ firstName: '' }, { first_name: junk, last_name: junk }), {}, junk);
  }
});

test('LP couples and caps: first person kept, notes dropped, case fixed', () => {
  const f = (first, last) => buildIdentityFill({}, { first_name: first, last_name: last });
  assert.deepEqual(f('Michelle/Jason', 'Smith'), { firstName: 'Michelle', lastName: 'Smith' });
  assert.deepEqual(f('Brian & Carol', 'Grant'), { firstName: 'Brian', lastName: 'Grant' });
  assert.deepEqual(f('Norm & Mary(Mother)', 'Lafontaine'), { firstName: 'Norm', lastName: 'Lafontaine' });
  assert.deepEqual(f('PAUL', 'SALMINEN '), { firstName: 'Paul', lastName: 'Salminen' });
  assert.deepEqual(f("JAMES & ALISON ", "O'CONNOR/ELGART "), { firstName: 'James', lastName: "O'Connor" });
  assert.deepEqual(f('DeShawn', 'McDonald'), { firstName: 'DeShawn', lastName: 'McDonald' }); // mixed case kept
});

test('email: existing kept, empty filled from LP, invalid LP email ignored', () => {
  assert.equal(buildIdentityFill({ firstName: 'A', lastName: 'B', email: 'me@x.com' }, { email: 'lp@x.com' }).email, undefined);
  assert.equal(buildIdentityFill({ firstName: 'A', lastName: 'B', email: '' }, { email: '  LP@X.com ' }).email, 'lp@x.com');
  for (const bad of ['nope', 'a@b', '@x.com', 'two words@x.com', 'n/a']) {
    assert.equal(buildIdentityFill({ firstName: 'A', lastName: 'B' }, { email: bad }).email, undefined, bad);
  }
  assert.equal(cleanEmail(' A@B.co '), 'a@b.co');
});

test('address: filled as a block when GHL has no street; trailing commas stripped', () => {
  const fill = buildIdentityFill({ firstName: 'A', lastName: 'B' },
    { address: '12 Main St, ', city: 'Ocala,', state: 'fl', zip: '34470' });
  assert.deepEqual(fill, { address1: '12 Main St', city: 'Ocala', state: 'FL', postalCode: '34470' });
  assert.equal(cleanAddressPart('  12  Main St ,, '), '12 Main St');
});

test('address: GHL has a street → city/zip only from the SAME LP street', () => {
  const ghl = { firstName: 'A', lastName: 'B', address1: '12 Main St', city: '', postalCode: '' };
  assert.deepEqual(buildIdentityFill(ghl, { address: '12 main st.', city: 'Ocala', zip: '34470' }),
    { city: 'Ocala', postalCode: '34470' });
  assert.deepEqual(buildIdentityFill(ghl, { address: '99 Other Rd', city: 'Tampa', zip: '33601' }), {});
});

test('output never contains tags (or customFields), and {} when nothing to fill', () => {
  const fill = buildIdentityFill({ tags: ['x'] }, { ...ANDREW, tags: ['lp'], customFields: [1], email: 'a@b.co' });
  assert.ok(!('tags' in fill) && !('customFields' in fill));
  for (const k of Object.keys(fill)) assert.ok(IDENTITY_FILL_FIELDS.includes(k), k);
  assert.deepEqual(buildIdentityFill({ firstName: 'A', lastName: 'B', email: 'a@b.co' }, {}), {});
});

// ═══ 2. I/O helpers ══════════════════════════════════════════════════════

/** Minimal chainable Supabase stand-in: answer(table, ops) → { data, error }. */
function fakeDb(answer) {
  const inserted = [];
  return {
    inserted,
    from(table) {
      const ops = [];
      const q = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') return (res, rej) => Promise.resolve(answer(table, ops)).then(res, rej);
          if (prop === 'insert') return (rows) => { inserted.push({ table, rows }); return Promise.resolve({ error: null }); };
          return (...args) => { ops.push([prop, ...args]); return q; };
        },
      });
      return q;
    },
  };
}

test('dropTakenEmail: drops an email another contact holds, and fails closed', async () => {
  const taken = fakeDb(() => ({ data: [{ ghl_contact_id: 'other' }], error: null }));
  assert.deepEqual((await dropTakenEmail({ firstName: 'A', email: 'a@b.co' }, 'c1', { hl: taken })).fill, { firstName: 'A' });
  const free = fakeDb(() => ({ data: [], error: null }));
  assert.equal((await dropTakenEmail({ email: 'a@b.co' }, 'c1', { hl: free })).fill.email, 'a@b.co');
  const r = await dropTakenEmail({ email: 'a@b.co' }, 'c1', { hl: null });
  assert.equal(r.fill.email, undefined);
  assert.match(r.email_dropped, /^unverified/);
});

test('putWithIdentityFill: one PUT; a 400 retries with the stamp alone', async () => {
  const puts = [];
  const ok = async (m, p, b) => { puts.push(b); return {}; };
  const r1 = await putWithIdentityFill('c1', { customFields: [1], tags: ['x'] }, { firstName: 'A' }, ok);
  assert.deepEqual(puts, [{ customFields: [1], firstName: 'A' }]); // tags stripped
  assert.deepEqual(r1.filled, ['firstName']);

  puts.length = 0;
  let n = 0;
  const refuseFirst = async (m, p, b) => { puts.push(b); if (n++ === 0) throw new Error('GHL PUT /contacts/c1 → 400: duplicated'); return {}; };
  const r2 = await putWithIdentityFill('c1', { customFields: [1] }, { email: 'a@b.co' }, refuseFirst);
  assert.deepEqual(puts, [{ customFields: [1], email: 'a@b.co' }, { customFields: [1] }]);
  assert.equal(r2.wrote, true);
  assert.deepEqual(r2.filled, []);
  assert.match(r2.fill_error, /400/);

  const boom = async () => { throw new Error('GHL PUT /contacts/c1 → 500: down'); };
  await assert.rejects(() => putWithIdentityFill('c1', { customFields: [1] }, { firstName: 'A' }, boom), /500/);
});

// ═══ 3. Backstop link path ═══════════════════════════════════════════════

test('backstop: matched nameless contact gets the name in the SAME PUT as the LP id stamp', async () => {
  calls = [];
  fullContact = { id: 'a9eG41qtxCqMEXxbbD2l', phone: '+13213882055', tags: ['lp-linked'], customFields: [] };
  const r = await processOneLead({
    lead: { lp_lead_id: '581424', lp_prospect_id: '900001', disposition_code: 'Data', ...ANDREW, phone: '(321) 388-2055' },
    contactCache: new Map(),
  });
  assert.equal(r.outcome, 'linked');
  const puts = calls.filter((c) => c.method === 'PUT' && c.path === '/contacts/a9eG41qtxCqMEXxbbD2l');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].body.firstName, 'Andrew');
  assert.equal(puts[0].body.lastName, 'Marcus');
  assert.deepEqual(puts[0].body.customFields.map((f) => f.id), [LP_LEAD_ID_FIELD, 'ZRQAVrzhtzApzLlHmT87']);
  assert.ok(!('tags' in puts[0].body));
  assert.deepEqual(r.identity_filled, ['firstName', 'lastName']);
});

test('backstop: a named contact keeps its name; dry run writes nothing and previews', async () => {
  calls = [];
  fullContact = { id: 'a9eG41qtxCqMEXxbbD2l', phone: '+13213882055', firstName: 'Andy', lastName: 'M', customFields: [] };
  await processOneLead({ lead: { lp_lead_id: '581424', disposition_code: 'Data', ...ANDREW }, contactCache: new Map() });
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put.body.firstName, undefined);
  assert.equal(put.body.lastName, undefined);

  calls = [];
  fullContact = { id: 'a9eG41qtxCqMEXxbbD2l', phone: '+13213882055', customFields: [] };
  const r = await processOneLead({ lead: { lp_lead_id: '581424', disposition_code: 'Data', ...ANDREW }, dryRun: true, contactCache: new Map() });
  assert.equal(calls.filter((c) => c.method === 'PUT' || c.method === 'POST').length, 0);
  assert.deepEqual(r.would_fill, { firstName: 'Andrew', lastName: 'Marcus' });
});

// ═══ 4. /n8n/enrich-lead ═════════════════════════════════════════════════

test('enrichment: computeIdentityFill fills only empty fields from the LP record', async () => {
  const enriched = { firstName: 'Andrew ', lastName: 'Marcus', email: 'am@x.com', address1: '1 A St', city: 'Ocala', state: 'FL', zip: '34470' };
  const ghlGet = async () => ({ contact: { id: 'c1', firstName: '', lastName: '', email: 'keep@x.com' } });
  const { fill } = await enrich.computeIdentityFill('c1', enriched, null, { ghlGet, hl: null });
  assert.deepEqual(fill, { firstName: 'Andrew', lastName: 'Marcus', address1: '1 A St', city: 'Ocala', state: 'FL', postalCode: '34470' });

  const failing = async () => { throw new Error('timeout'); };
  assert.deepEqual((await enrich.computeIdentityFill('c1', enriched, null, { ghlGet: failing, hl: null })).fill, {});
  assert.deepEqual((await enrich.computeIdentityFill('c1', enriched, null, { ghlGet: async () => ({}), hl: null })).fill, {});
});

// ═══ 5. The sweep / backfill core ════════════════════════════════════════

test('verifiedLinkBasis: LP id on the contact, else the phone; otherwise null', () => {
  const lead = { lp_lead_id: 581424, lp_prospect_id: 900001, phone: '3213882055' };
  assert.equal(verifiedLinkBasis({ customFields: [{ id: LP_LEAD_ID_FIELD, value: '581424' }] }, lead), 'lp_lead_id');
  assert.equal(verifiedLinkBasis({ phone: '+13213882055' }, lead), 'phone');
  assert.equal(verifiedLinkBasis({ phone: '+19999999999', customFields: [{ id: LP_LEAD_ID_FIELD, value: '1' }] }, lead), null);
});

test('pickNamedLeadPerContact: newest NAMED lead wins; deleted leads ignored', () => {
  const m = pickNamedLeadPerContact([
    { ghl_contact_id: 'c', lp_lead_id: 1, first_name: 'Old', created_at_lp: '2026-01-01' },
    { ghl_contact_id: 'c', lp_lead_id: 2, first_name: '', created_at_lp: '2026-09-01' },
    { ghl_contact_id: 'c', lp_lead_id: 3, first_name: 'Gone', created_at_lp: '2026-10-01', lp_deleted_at: '2026-10-02' },
    { ghl_contact_id: 'c', lp_lead_id: 4, first_name: 'New', created_at_lp: '2026-06-01' },
  ]);
  assert.equal(m.get('c').lp_lead_id, 4);
});

function coreFixture(contacts) {
  const hl = fakeDb((table, ops) => {
    if (ops.some(([op]) => op === 'ilike')) return { data: [], error: null }; // email not taken
    return {
      data: [
        { ghl_contact_id: 'c-ok', first_name: null, last_name: null, tags: ['lp-linked'] },
        { ghl_contact_id: 'c-demo', first_name: '', last_name: '', tags: ['lp-demo-completed'] },
        { ghl_contact_id: 'c-unverified', first_name: null, last_name: null, tags: [] },
        { ghl_contact_id: 'c-noname', first_name: null, last_name: null, tags: [] },
        { ghl_contact_id: 'c-named-now', first_name: null, last_name: null, tags: [] },
      ],
      error: null,
    };
  });
  const lp = fakeDb(() => ({
    data: [
      { ghl_contact_id: 'c-ok', lp_lead_id: 11, first_name: 'Andrew ', last_name: 'Marcus', email: 'am@x.com', phone: '3213882055', created_at_lp: '2026-10-01' },
      { ghl_contact_id: 'c-demo', lp_lead_id: 12, first_name: 'PAUL', last_name: 'SALMINEN', phone: '2395550000', created_at_lp: '2026-09-01' },
      { ghl_contact_id: 'c-unverified', lp_lead_id: 13, first_name: 'Wrong', last_name: 'Person', phone: '1112223333', created_at_lp: '2026-09-01' },
      { ghl_contact_id: 'c-noname', lp_lead_id: 14, first_name: '', last_name: null, phone: '4445556666', created_at_lp: '2026-09-01' },
      { ghl_contact_id: 'c-named-now', lp_lead_id: 15, first_name: 'Late', last_name: 'Name', phone: '7778889999', created_at_lp: '2026-09-01' },
    ],
    error: null,
  }));
  const puts = [];
  const order = [];
  const ghlFetch = async (method, path, body) => {
    const id = path.split('/').pop();
    if (method === 'GET') { order.push(id); return { contact: contacts[id] }; }
    puts.push({ id, body });
    return {};
  };
  return { hl, lp, ghlFetch, puts, order };
}

const CONTACTS = {
  'c-ok': { id: 'c-ok', phone: '+13213882055', tags: ['lp-linked'], customFields: [] },
  'c-demo': { id: 'c-demo', phone: '+12395550000', customFields: [] },
  'c-unverified': { id: 'c-unverified', phone: '+15550001111', customFields: [] },
  'c-named-now': { id: 'c-named-now', phone: '+17778889999', firstName: 'Someone', customFields: [] },
};

test('core LIVE: fills verified nameless contacts, demo first, one tagless PUT each', async () => {
  const f = coreFixture(CONTACTS);
  const res = await runIdentityFill({ dryRun: false }, { ...f, log: () => {} });
  assert.equal(f.order[0], 'c-demo'); // demo contacts go first
  assert.equal(res.counts.filled, 2);
  assert.equal(res.counts.skipped_unverified_link, 1);
  assert.equal(res.counts.skipped_no_lp_name, 1);
  assert.equal(res.counts.skipped_has_name, 1);
  assert.deepEqual(f.puts.map((p) => p.id).sort(), ['c-demo', 'c-ok']);
  assert.deepEqual(f.puts.find((p) => p.id === 'c-ok').body, { firstName: 'Andrew', lastName: 'Marcus', email: 'am@x.com' });
  assert.deepEqual(f.puts.find((p) => p.id === 'c-demo').body, { firstName: 'Paul', lastName: 'Salminen' });
  for (const p of f.puts) assert.ok(!('tags' in p.body));
  assert.ok(res.changes.some((c) => c.contact_id === 'c-ok' && c.field === 'firstName' && c.old === '' && c.new === 'Andrew'));
});

test('core DRY RUN writes nothing; --demo-only and --limit narrow the run', async () => {
  const f = coreFixture(CONTACTS);
  const res = await runIdentityFill({ dryRun: true, limit: 1 }, { ...f, log: () => {} });
  assert.equal(f.puts.length, 0);
  assert.equal(res.counts.checked, 1);
  assert.equal(res.counts.would_fill, 1);
  assert.equal(res.counts.deferred_limit, 3);

  const g = coreFixture(CONTACTS);
  await runIdentityFill({ dryRun: true, demoOnly: true }, { ...g, log: () => {} });
  // the HL read asked for the demo tag
  assert.equal(g.puts.length, 0);
});

test('core: an error is counted and saved to lp_sync_errors (identity_backfill), never on a dry run', async () => {
  const f = coreFixture(CONTACTS);
  const failing = async (method, path, body) => {
    if (method === 'PUT') throw new Error('GHL PUT → 500: down');
    return f.ghlFetch(method, path, body);
  };
  const res = await runIdentityFill({ dryRun: false }, { ...f, ghlFetch: failing, log: () => {} });
  assert.equal(res.counts.errors, 2);
  assert.equal(f.lp.inserted.length, 1);
  assert.equal(f.lp.inserted[0].table, 'lp_sync_errors');
  assert.equal(f.lp.inserted[0].rows[0].sync_type, 'identity_backfill');
});

// ═══ 6. The sweep switch ═════════════════════════════════════════════════

test('sweep: off does nothing; shadow writes nothing; live writes', async () => {
  assert.equal(identityFillMode({}), 'live');
  assert.equal(identityFillMode({ LP_IDENTITY_FILL_MODE: 'OFF' }), 'off');
  const off = await runIdentityFillSweep({ env: { LP_IDENTITY_FILL_MODE: 'off' } });
  assert.equal(off.skipped, 'mode_off');

  const s = coreFixture(CONTACTS);
  const shadow = await runIdentityFillSweep({ env: { LP_IDENTITY_FILL_MODE: 'shadow' }, ...s, log: () => {} });
  assert.equal(s.puts.length, 0);
  assert.equal(shadow.counts.would_fill, 2);

  const l = coreFixture(CONTACTS);
  const live = await runIdentityFillSweep({ env: {}, ...l, log: () => {} });
  assert.equal(live.counts.filled, 2);
  assert.equal(live.counts.errors, 0);
});
