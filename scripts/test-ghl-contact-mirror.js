// scripts/test-ghl-contact-mirror.js
//
// The HL contacts-mirror lookup, and its use as tier 0 of resolveOrCreateContact.
//
// The point of this tier is latency, but the risk it carries is identity: it
// answers "which contact owns this phone" without asking GoHighLevel. So the
// tests that matter are not the happy path — they are the four ways it must
// decline to answer, each of which falls through to the live GHL search that
// ran before this module existed:
//
//   miss · unreadable mirror · id that is not a GHL id · two contacts
//
// The rule it inherits from ghl-contact-resolve.js: creating a duplicate
// contact is a recoverable annoyance; stamping one lead's identity onto a
// different person is not.

import test from 'node:test';
import assert from 'node:assert/strict';

import { findContactIdByPhone, phone10 } from '../src/services/ghl-contact-mirror.js';
import { resolveOrCreateContact } from '../src/services/ghl-contact-resolve.js';

const quiet = { warn: () => {}, log: () => {}, error: () => {} };
const ID_A = 'TxYo2aOwRkQIBrBYl5Ld';   // 20 chars, real shape
const ID_B = 'a1aV19tXkz8zWkHmvXqc';

/** Mirror stub: resolves `rows`, or throws when handed an Error. */
function mirror(rows) {
  const calls = [];
  return {
    calls,
    async hlRunSQL(q) {
      calls.push(q);
      if (rows instanceof Error) throw rows;
      return rows;
    },
  };
}

// ─── Phone normalization ────────────────────────────────────────────────────

test('phone10 takes the last ten digits, however the number is written', () => {
  for (const input of ['+18132633466', '8132633466', '(813) 263-3466', '1-813-263-3466']) {
    assert.equal(phone10(input), '8132633466', `${input} must normalize`);
  }
});

test('phone10 refuses anything short of ten digits', () => {
  for (const input of ['', null, undefined, '555', '813263346']) {
    assert.equal(phone10(input), '', `${JSON.stringify(input)} is not a phone`);
  }
});

test('a phone too short never reaches the database', async () => {
  const deps = mirror([]);
  assert.equal(await findContactIdByPhone('555', { deps, log: quiet }), null);
  assert.equal(deps.calls.length, 0, 'not even a query');
});

// ─── The happy path ─────────────────────────────────────────────────────────

test('a single mirror row answers with its contact id', async () => {
  const deps = mirror([{ ghl_contact_id: ID_A }]);
  assert.equal(await findContactIdByPhone('+18132633466', { deps, log: quiet }), ID_A);
});

test('the query is index-shaped and scoped to live contacts', async () => {
  // idx_contacts_phone10 is a functional index on exactly this expression.
  // Writing the predicate any other way silently turns the lookup into a scan.
  const deps = mirror([{ ghl_contact_id: ID_A }]);
  await findContactIdByPhone('8132633466', { deps, log: quiet });
  const q = deps.calls[0];
  assert.match(q, /right\(regexp_replace\(coalesce\(phone,''\), '\[\^0-9\]', '', 'g'\), 10\) = '8132633466'/);
  assert.match(q, /deleted_at IS NULL/);
  assert.match(q, /LIMIT 2/);
});

// ─── The four refusals ──────────────────────────────────────────────────────

test('no row is null — never an assertion that nobody owns the number', async () => {
  const deps = mirror([]);
  assert.equal(await findContactIdByPhone('8132633466', { deps, log: quiet }), null);
});

test('an unreadable mirror falls through instead of throwing', async () => {
  // A mirror outage must not surface as "no contact exists", and must not
  // surface as an exception either — the caller has a live search to try.
  const deps = mirror(new Error('HL SQL error: connection reset'));
  assert.equal(await findContactIdByPhone('8132633466', { deps, log: quiet }), null);
});

test('an id that is not GHL-shaped is refused', async () => {
  // Guards against a mirror column holding a placeholder, a truncated value or
  // an LP id. A wrong 20-char-ish string stamped into LP is Phase A all over.
  for (const bad of ['', null, 'short', '  ', `${ID_A}EXTRA`, 'has-a-dash-in-it!!!!']) {
    const deps = mirror([{ ghl_contact_id: bad }]);
    assert.equal(await findContactIdByPhone('8132633466', { deps, log: quiet }), null,
      `${JSON.stringify(bad)} must be refused`);
  }
});

test('two contacts on one number refuses rather than picking', async () => {
  const deps = mirror([{ ghl_contact_id: ID_A }, { ghl_contact_id: ID_B }]);
  assert.equal(await findContactIdByPhone('8132633466', { deps, log: quiet }), null,
    'ambiguity is never resolved by guessing');
});

// ─── Tier 0 inside resolveOrCreateContact ───────────────────────────────────

/** GHL stub, same shape as the one in test-ap-intake.js. */
function ghl(queue) {
  const calls = [];
  return {
    calls,
    async ghlFetch(path, opts = {}) {
      calls.push({ path, method: opts.method || 'GET', body: opts.body });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next ?? { contacts: [] };
    },
  };
}

test('a mirror hit skips GoHighLevel entirely', async () => {
  // This is the whole point: no GHL request means no token drawn from the
  // bucket the action executor is competing for.
  const deps = {
    ...ghl([]),
    findContactIdByPhone: async () => ID_A,
  };
  const r = await resolveOrCreateContact({ phone: '8132633466' },
    { create: true, mirrorFirst: true, deps, log: quiet });
  assert.equal(r.outcome, 'found');
  assert.equal(r.contactId, ID_A);
  assert.equal(deps.calls.length, 0, 'not one GHL call');
});

test('a mirror miss falls through to the live search', async () => {
  const deps = {
    ...ghl([{ contacts: [{ id: ID_B, phone: '+18132633466' }] }]),
    findContactIdByPhone: async () => null,
  };
  const r = await resolveOrCreateContact({ phone: '8132633466' },
    { create: false, mirrorFirst: true, deps, log: quiet });
  assert.equal(r.outcome, 'found');
  assert.equal(r.contactId, ID_B, 'GHL had the answer the mirror lacked');
  assert.equal(deps.calls.length, 1);
});

test('without mirrorFirst the mirror is never consulted', async () => {
  // lp-contact-backstop.js shares this function and did not opt in. Its
  // behaviour must be byte-identical to before this tier existed.
  let asked = false;
  const deps = {
    ...ghl([{ contacts: [] }]),
    findContactIdByPhone: async () => { asked = true; return ID_A; },
  };
  const r = await resolveOrCreateContact({ phone: '8132633466' },
    { create: false, deps, log: quiet });
  assert.equal(asked, false, 'opt-in means opt-in');
  assert.equal(r.outcome, 'none');
});

test('a deps stub with no mirror function skips the tier instead of throwing', async () => {
  // Every pre-existing test passes a deps object that predates this tier.
  const deps = ghl([{ contacts: [] }]);
  const r = await resolveOrCreateContact({ phone: '8132633466' },
    { create: false, mirrorFirst: true, deps, log: quiet });
  assert.equal(r.outcome, 'none');
});

test('a phoneless lead is rejected before the mirror is asked', async () => {
  let asked = false;
  const deps = { ...ghl([]), findContactIdByPhone: async () => { asked = true; return ID_A; } };
  const r = await resolveOrCreateContact({ phone: '', firstName: 'Ada' },
    { create: true, mirrorFirst: true, deps, log: quiet });
  assert.equal(r.outcome, 'no_phone');
  assert.equal(asked, false);
});

test('the duplicate-400 re-search asks GHL, not the mirror', async () => {
  // A contact GHL created moments ago is exactly the one the mirror is least
  // likely to hold yet, so the race path must stay on the live API.
  const dup = new Error('GHL POST /contacts/ → 400: Can not create duplicate contact');
  const deps = {
    ...ghl([{ contacts: [] }, dup, { contacts: [{ id: ID_B, phone: '+18132633466' }] }]),
    findContactIdByPhone: async () => null,
  };
  const r = await resolveOrCreateContact({ phone: '8132633466' },
    { create: true, mirrorFirst: true, deps, log: quiet });
  assert.equal(r.outcome, 'found');
  assert.equal(r.contactId, ID_B, 'their contact stands; ours was never written');
});

// ─── Telling a slow mirror from a busy event loop ───────────────────────────

test('the mirror call is timed separately from the whole resolve', async () => {
  // Under executor load the endpoint measured 26/37/54ms on three probes and
  // 781/948/1093ms on three others — same phone, same path, every one a mirror
  // HIT. A hit spends no GHL token, so that swing is NOT the rate limiter: it
  // is either the HL Supabase query or event-loop delay from the executor in
  // this same process. Those have opposite fixes and one combined number cannot
  // tell them apart, so the mirror carries its own clock.
  const deps = {
    ...ghl([]),
    findContactIdByPhone: async () => {
      await new Promise((r) => setTimeout(r, 60));
      return ID_A;
    },
  };
  const r = await resolveOrCreateContact({ phone: '8132633466' },
    { create: true, mirrorFirst: true, deps, log: quiet });
  assert.equal(r.contactId, ID_A);
  assert.ok(r.mirrorMs >= 50, `mirror time was measured, saw ${r.mirrorMs}`);
});

test('a mirror MISS still reports its own cost', async () => {
  // The slow case worth catching is a slow miss: it pays the mirror AND then
  // the live search, so attributing the total matters most exactly here.
  const deps = {
    ...ghl([{ contacts: [] }]),
    findContactIdByPhone: async () => {
      await new Promise((r) => setTimeout(r, 40));
      return null;
    },
  };
  const r = await resolveOrCreateContact({ phone: '8132633466' },
    { create: false, mirrorFirst: true, deps, log: quiet });
  assert.equal(r.outcome, 'none');
  assert.ok(r.mirrorMs >= 30, `a miss reports its cost too, saw ${r.mirrorMs}`);
});

test('without the mirror tier there is no mirror time to report', async () => {
  const deps = ghl([{ contacts: [] }]);
  const r = await resolveOrCreateContact({ phone: '8132633466' },
    { create: false, deps, log: quiet });
  assert.equal(r.mirrorMs, undefined, 'undefined, not a misleading 0');
});
