// scripts/test-ap-intake.js
//
// The ActiveProspect intake hop. Two things are load-bearing and both are
// pinned here: the contact resolve NEVER blocks the lead, and shadow mode is
// a transparent proxy.
//
// Context for the timeouts below. The pipe this replaces (n8n YOozjkCkeNEe4s3a)
// never errored — typical 1.1-2.1s, several 5-6s, worst 20.7s — and
// ActiveProspect gave up while it was still working. So "slow" is the failure
// mode that actually happens here, not "broken", and every test that matters
// is about what we do when GHL is slow rather than when it throws.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  contactInputFromApBody, pick, _internal,
  vendorFromApBody, looksLikeLeadConduitId, pickName, getSrsNames, resolveApContact,
} from '../src/ap-intake.js';
import {
  pickPhoneMatch, isDuplicate400, cleanName, resolveOrCreateContact,
} from '../src/services/ghl-contact-resolve.js';

const { raceWithNullTimeout, intakeMode, AP_INTAKE_TAG } = _internal;

// ─── The ceiling ────────────────────────────────────────────────────────────

test('raceWithNullTimeout resolves null at the ceiling, not an error', () => {
  // Null, not a throw: the caller forwards to LP without an id. A throw would
  // have to be caught somewhere, and a missed catch costs the lead.
  const slow = new Promise((r) => setTimeout(() => r('too late'), 200));
  return raceWithNullTimeout(slow, 20).then((v) => assert.equal(v, null));
});

test('raceWithNullTimeout returns the value when it beats the ceiling', async () => {
  assert.equal(await raceWithNullTimeout(Promise.resolve('fast'), 500), 'fast');
});

test('a fast resolve does not hold the process open for the full ceiling', async () => {
  // The timer is cleared either way. If it were not, a 1.2s ceiling would add
  // 1.2s of event-loop lifetime to every single lead.
  const started = Date.now();
  await raceWithNullTimeout(Promise.resolve('fast'), 5000);
  assert.ok(Date.now() - started < 1000, 'returned promptly');
});

// ─── Mode gate ──────────────────────────────────────────────────────────────

test('mode defaults to shadow — the safe one', () => {
  const prev = process.env.AP_INTAKE_MODE;
  delete process.env.AP_INTAKE_MODE;
  assert.equal(intakeMode(), 'shadow');
  if (prev !== undefined) process.env.AP_INTAKE_MODE = prev;
});

test('an unrecognised mode falls back to shadow, never to live', () => {
  const prev = process.env.AP_INTAKE_MODE;
  process.env.AP_INTAKE_MODE = 'LIVE!!';
  assert.equal(intakeMode(), 'shadow');
  if (prev === undefined) delete process.env.AP_INTAKE_MODE; else process.env.AP_INTAKE_MODE = prev;
});

test('mode is case-insensitive', () => {
  const prev = process.env.AP_INTAKE_MODE;
  process.env.AP_INTAKE_MODE = 'LIVE';
  assert.equal(intakeMode(), 'live');
  if (prev === undefined) delete process.env.AP_INTAKE_MODE; else process.env.AP_INTAKE_MODE = prev;
});

// ─── Field mapping ──────────────────────────────────────────────────────────

test('pick takes the first non-empty spelling', () => {
  assert.equal(pick({ a: '', b: '  ', c: 'x' }, 'a', 'b', 'c'), 'x');
  assert.equal(pick({ a: 0 }, 'a'), '0', 'zero is a value, not an absence');
  assert.equal(pick({}, 'nope'), '');
});

test('AP field spellings map to the GHL contact shape', () => {
  const got = contactInputFromApBody({
    first_name: 'Ada', last_name: 'Lovelace', phone1: '(386) 555-1234',
    email: 'ada@example.com', zip: '32065',
  }, { vendor: 'Modernize' });
  assert.equal(got.firstName, 'Ada');
  assert.equal(got.phone, '(386) 555-1234');
  assert.equal(got.postalCode, '32065');
  assert.equal(got.source, 'Modernize', 'the vendor, not the pipe that carried it');
});

test('source falls back through the body before a generic default', () => {
  assert.equal(contactInputFromApBody({ sourcesubdescr: 'Porch101' }).source, 'Porch101');
  assert.equal(contactInputFromApBody({}).source, 'activeprospect');
});

// ─── Vendor NAME, never LeadConduit's record id (2026-09-23) ─────────────────
//
// Shadow logged `vendor=659d63d0effd26f951b6da45 srs=790` on every call: the
// payload's vendor field is LeadConduit's record id. Live mode then wrote that
// id into the contact's source and a `source:internet-659d63d0…` tag.

const LC_ID = '659d63d0effd26f951b6da45';
const SRS_NAMES = new Map([['790', 'HomeBuddy'], ['717', 'MyHomePros'], ['874', 'Swish Leads']]);

test('looksLikeLeadConduitId: 24-hex only', () => {
  assert.equal(looksLikeLeadConduitId(LC_ID), true);
  assert.equal(looksLikeLeadConduitId('HomeBuddy'), false);
  assert.equal(looksLikeLeadConduitId('659d63d0effd26f951b6da4'), false, '23 chars');
  assert.equal(looksLikeLeadConduitId(''), false);
});

test('pickName skips LeadConduit ids and keeps looking', () => {
  assert.equal(pickName({ vendor: LC_ID, source: 'HomeBuddy' }, 'vendor', 'source'), 'HomeBuddy');
  assert.equal(pickName({ vendor: LC_ID }, 'vendor'), '');
});

test('vendor comes from the LP catalog name for srs_id, not the payload id', () => {
  assert.equal(vendorFromApBody({ vendor: LC_ID, srs_id: '790' }, { srsNames: SRS_NAMES }), 'HomeBuddy');
  assert.equal(vendorFromApBody({ source: LC_ID, srs_id: '717' }, { srsNames: SRS_NAMES }), 'MyHomePros');
});

test('vendor falls back to a real payload name, and never to an id', () => {
  assert.equal(vendorFromApBody({ vendor: LC_ID, sourcesubdescr: 'Porch101' }, { srsNames: SRS_NAMES }), 'Porch101');
  assert.equal(vendorFromApBody({ vendor: LC_ID, srs_id: '999' }, { srsNames: SRS_NAMES }), '', 'unknown srs, id-only payload');
  assert.equal(vendorFromApBody({ vendor: LC_ID, srs_id: '790' }), '', 'no catalog available');
});

test('contact source never falls back to a LeadConduit id', () => {
  assert.equal(contactInputFromApBody({ source: LC_ID }).source, 'activeprospect');
});

test('resolveApContact tags and sources the contact by vendor name', async () => {
  const calls = [];
  const deps = {
    ghlFetch: async (method, path, body) => {
      calls.push({ method, path, body });
      return method === 'POST' ? { contact: { id: 'new1' } } : { contacts: [] };
    },
    // HL mirror miss, so the resolve goes on to GHL search + create.
    findContactIdByPhone: async () => null,
  };
  const r = await resolveApContact(
    { vendor: LC_ID, srs_id: '790', phone: '3865551234', first_name: 'Ada' },
    { mode: 'live', deps, srsNames: SRS_NAMES, log: { warn: () => {} } },
  );
  assert.equal(r.vendor, 'HomeBuddy');
  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, 'live created a contact');
  assert.equal(post.body.source, 'HomeBuddy');
  assert.ok(post.body.tags.includes('source:internet-homebuddy'));
  assert.ok(!post.body.tags.some((t) => t.includes(LC_ID)), 'no tag carries the LeadConduit id');
});

test('getSrsNames caches a good load and never caches a failure', async () => {
  _internal.__resetSrsCacheForTest();
  let loads = 0;
  const failing = async () => { loads++; throw new Error('db down'); };
  const prevWarn = console.warn; console.warn = () => {};
  try {
    assert.equal((await getSrsNames({ load: failing })).size, 0, 'failure → empty map, no throw');
    assert.equal((await getSrsNames({ load: failing })).size, 0);
    assert.equal(loads, 2, 'a failure is retried on the next call');

    const good = async () => { loads++; return new Map(SRS_NAMES); };
    assert.equal((await getSrsNames({ load: good })).get('790'), 'HomeBuddy');
    assert.equal((await getSrsNames({ load: failing })).get('790'), 'HomeBuddy', 'cached — no reload inside the TTL');
    assert.equal(loads, 3);

    const later = () => Date.now() + 2 * 60 * 60 * 1000;
    assert.equal((await getSrsNames({ load: failing, now: later })).get('790'), 'HomeBuddy', 'stale map served when a refresh fails');
  } finally {
    console.warn = prevWarn;
    _internal.__resetSrsCacheForTest();
  }
});

test('getSrsNames gives up at its ceiling instead of holding the lead', async () => {
  _internal.__resetSrsCacheForTest();
  const prevWarn = console.warn; console.warn = () => {};
  try {
    const started = Date.now();
    const slow = () => new Promise((r) => setTimeout(() => r(new Map(SRS_NAMES)), 2000));
    const names = await getSrsNames({ load: slow });
    assert.equal(names.size, 0);
    assert.ok(Date.now() - started < 1000, 'returned at the ceiling');
  } finally {
    console.warn = prevWarn;
    _internal.__resetSrsCacheForTest();
  }
});

test('the intake tag agent rule 355 routes on is applied', () => {
  assert.equal(AP_INTAKE_TAG, 'ap-intake-created');
});

// ─── Find-before-create: the rule that stops a wrong-person link ────────────

const ghl = (responses) => {
  const calls = [];
  return {
    calls,
    ghlFetch: async (method, path, body) => {
      calls.push({ method, path, body });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
};

test('a last-10-digit match is accepted even though GHL stores +1', () => {
  const pickd = pickPhoneMatch([{ id: 'c1', phone: '+13865551234' }], '3865551234');
  assert.equal(pickd.verified, true);
  assert.equal(pickd.contact.id, 'c1');
});

test('a different number is not a match', () => {
  assert.equal(pickPhoneMatch([{ id: 'c1', phone: '+13865559999' }], '3865551234'), null);
});

test('a hit with NO phone is a candidate, never a match', () => {
  const pickd = pickPhoneMatch([{ id: 'c1' }], '3865551234');
  assert.equal(pickd.verified, false, 'must be confirmed by a full read first');
});

test('a phone too short to compare never matches', () => {
  assert.equal(pickPhoneMatch([{ id: 'c1', phone: '5551234' }], '5551234'), null);
});

test('an unconfirmable candidate refuses to link rather than guessing', async () => {
  // Search returns a phoneless hit; the full read shows a DIFFERENT person.
  const deps = ghl([
    { contacts: [{ id: 'c1' }] },
    { contact: { id: 'c1', phone: '+19999999999' } },
  ]);
  const r = await resolveOrCreateContact({ phone: '3865551234' },
    { create: false, deps, log: { warn: () => {} } });
  assert.equal(r.contactId, null);
  assert.equal(r.outcome, 'none', 'refused — stamping the wrong person is unrecoverable');
});

test('a failed verification read refuses to link', async () => {
  const deps = ghl([
    { contacts: [{ id: 'c1' }] },
    new Error('GHL GET /contacts/c1 → 500'),
  ]);
  const r = await resolveOrCreateContact({ phone: '3865551234' },
    { create: false, deps, log: { warn: () => {} } });
  assert.equal(r.contactId, null, 'could not tell is not a match');
});

test('shadow searches but never creates', async () => {
  const deps = ghl([{ contacts: [] }]);
  const r = await resolveOrCreateContact({ phone: '3865551234', firstName: 'Ada' },
    { create: false, deps });
  assert.equal(r.outcome, 'none');
  assert.equal(deps.calls.filter((c) => c.method === 'POST').length, 0,
    'shadow must write nothing at all');
});

test('live creates when nothing matches, and carries its tags', async () => {
  const deps = ghl([{ contacts: [] }, { contact: { id: 'new1' } }]);
  const r = await resolveOrCreateContact(
    { phone: '3865551234', firstName: 'Ada', tags: ['ap-intake-created'] },
    { create: true, deps });
  assert.equal(r.outcome, 'created');
  assert.equal(r.contactId, 'new1');
  const post = deps.calls.find((c) => c.method === 'POST');
  assert.ok(post.body.tags.includes('ap-intake-created'));
});

test('a duplicate-400 re-searches and uses the contact that won the race', async () => {
  const dup = new Error('GHL POST /contacts/ → 400: Can not create duplicate opportunity');
  const deps = ghl([
    { contacts: [] },                                   // first search: nothing
    dup,                                                // create races and loses
    { contacts: [{ id: 'theirs', phone: '+13865551234' }] }, // re-search
  ]);
  const r = await resolveOrCreateContact({ phone: '3865551234' }, { create: true, deps });
  assert.equal(r.outcome, 'found');
  assert.equal(r.contactId, 'theirs', 'their contact stands; ours was never written');
});

test('isDuplicate400 recognises the shape and nothing else', () => {
  assert.ok(isDuplicate400(new Error('GHL POST /contacts/ → 400: duplicate contact')));
  assert.ok(!isDuplicate400(new Error('GHL POST /contacts/ → 500: duplicate')));
  assert.ok(!isDuplicate400(new Error('GHL POST /contacts/ → 400: bad request')));
});

test('a lead with no usable phone never creates a phoneless contact', async () => {
  // A phoneless contact can never be corroborated later — that is exactly the
  // condition Phase A had to clean up by hand.
  const deps = ghl([]);
  for (const phone of ['', null, '555']) {
    const r = await resolveOrCreateContact({ phone, firstName: 'Ada' }, { create: true, deps });
    assert.equal(r.outcome, 'no_phone');
    assert.equal(r.contactId, null);
  }
  assert.equal(deps.calls.length, 0, 'not even a search');
});

test('junk names are dropped rather than written to GHL', () => {
  for (const junk of ['', 'N/A', 'none', 'TEST', 'undefined']) assert.equal(cleanName(junk), '');
  assert.equal(cleanName('  Ada   Lovelace '), 'Ada Lovelace');
});
