/**
 * test-scope-dq.js — a commercial property or a renter: a note on the LP prospect and
 * ONE #contact-center card asking a person to set ND (the user, 2026-10-13; LP's API
 * cannot change a disposition). 2026-10-20: an owner who rents the home out is a lead,
 * so a rental is no longer a kind; a tenant is.
 *
 * Run: node --test scripts/test-scope-dq.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { scopeDqKind, runScopeDq, lpNoteText, cardExtra, scopeDqMode, SCOPE_DQ_REASON } from '../src/agentic/scope-dq.js';
import { formatNepqHandoff } from '../src/agentic/nepq-handoff.js';
import { NO_DIAL_REASONS } from '../src/agentic/bot-callback.js';

test('the kind comes from the lead\'s own words', () => {
  assert.equal(scopeDqKind('Do you do commercial buildings? Our office building needs windows'), 'commercial');
  assert.equal(scopeDqKind("I'm renting, my landlord would have to okay it"), 'renter');
  assert.equal(scopeDqKind('Seeing how can I get help with my rent my rent is $589 a month'), 'renter');
  for (const t of ['we rent it out, can you do the windows?', 'It is an Airbnb we own', "It's an investment property", "I'm the property manager for this house",
    "It's my parents' house, I don't own it", 'my windows leak', 'we used to rent it out but we live there now', 'I have a mobile home', 'I need windows for my home office', '']) {
    assert.equal(scopeDqKind(t), null, t);
  }
});

test('the note and the card say what to do, digits-only phone', () => {
  assert.match(lpNoteText('renter'), /they rent the home.*only work with homeowners.*Set this lead to ND\./);
  assert.match(lpNoteText('commercial'), /a commercial property.*Set this lead to ND\./);
  const extra = cardExtra({ kind: 'commercial', prospectId: '463200', leadId: '581413', note: 'added', phone: '+1 (352) 555-0188' });
  assert.match(extra, /Why: a commercial property\./);
  assert.match(extra, /^Phone: 3525550188$/m);
  assert.match(extra, /LP: Prospect 463200/);
  assert.doesNotMatch(extra, /581413/, 'the card names the prospect, never the LP lead id');
  assert.match(extra, /LP note: added\./);
  assert.match(cardExtra({ kind: 'renter' }), /Why: a renter, not the homeowner\./);
  assert.match(cardExtra({ kind: 'renter' }), /no LP lead is linked/);
  const { card } = formatNepqHandoff({ reason: SCOPE_DQ_REASON, channel: 'sms', inbound: "I'm renting", contactId: 'C1', firstName: 'Dana', extra });
  assert.match(card, /^⛔ SET THIS LEAD TO ND IN LP$/m);
  assert.match(card, /set it to ND\. No sales call\./);
  assert.ok(NO_DIAL_REASONS.has(SCOPE_DQ_REASON), 'never a Five9 call, never callback:requested');
});

test('scopeDqMode defaults to live', () => {
  assert.equal(scopeDqMode({}), 'live');
  assert.equal(scopeDqMode({ SCOPE_DQ_MODE: 'shadow' }), 'shadow');
  assert.equal(scopeDqMode({ SCOPE_DQ_MODE: 'off' }), 'off');
});

function harness({ mode = 'live', seen = false, prospect = { prospectId: '463200', leadId: '581413' }, noteFails = false } = {}) {
  const calls = { notes: [], cards: [], recorded: [] };
  const deps = {
    mode,
    log: () => {},
    resolveLp: async () => prospect,
    addLpNote: async (id, text) => { if (noteFails) throw new Error('LP down'); calls.notes.push({ id, text }); },
    filterNew: async ({ items }) => ({ fresh: seen ? [] : items }),
    recordPosted: async (a) => { calls.recorded.push(a); },
    routeHandoff: async (a) => { calls.cards.push(a); return { routed: true }; },
  };
  return { deps, calls };
}

test('live: the LP note on the prospect, one card, recorded for good', async () => {
  const { deps, calls } = harness();
  const r = await runScopeDq({ contactId: 'C1', kind: 'renter', inbound: "I'm renting", phone: '3525550188' }, deps);
  assert.equal(r.done, true);
  assert.deepEqual(calls.notes.map(n => n.id), ['463200']);
  assert.equal(calls.cards.length, 1);
  assert.equal(calls.cards[0].reason, 'scope_dq');
  assert.match(calls.cards[0].extra, /LP note: added\./);
  assert.equal(calls.recorded[0].permanent, true);
});

test('once per contact per kind', async () => {
  const { deps, calls } = harness({ seen: true });
  const r = await runScopeDq({ contactId: 'C1', kind: 'renter', inbound: "I'm renting" }, deps);
  assert.equal(r.reason, 'already_done');
  assert.equal(calls.notes.length + calls.cards.length, 0);
});

test('no LP prospect: no note, the card still asks', async () => {
  const { deps, calls } = harness({ prospect: { prospectId: null, leadId: null } });
  await runScopeDq({ contactId: 'C1', kind: 'commercial', inbound: 'our office building' }, deps);
  assert.equal(calls.notes.length, 0);
  assert.match(calls.cards[0].extra, /LP note: not added/);
});

test('a failed LP note still posts the card, and says so', async () => {
  const { deps, calls } = harness({ noteFails: true });
  const r = await runScopeDq({ contactId: 'C1', kind: 'commercial', inbound: 'our office building' }, deps);
  assert.equal(r.note, 'failed');
  assert.match(calls.cards[0].extra, /could NOT be added/);
});

test('shadow and off write nothing', async () => {
  for (const mode of ['shadow', 'off']) {
    const { deps, calls } = harness({ mode });
    await runScopeDq({ contactId: 'C1', kind: 'renter', inbound: "I'm renting" }, deps);
    assert.equal(calls.notes.length + calls.cards.length + calls.recorded.length, 0, mode);
  }
});
