/**
 * test-canvass-confirmation-handler.js — POST /webhooks/canvass-confirmation.
 *
 * Exercises the structural gates, lead_in_lp normalisation, the missing-
 * prospect-id gate, both branch shapes through one endpoint, the 24h
 * idempotency marks, the note body, the emitted event contract, the card
 * classes, and the route's response codes — all against injected mocks (no
 * network, no DB).
 *
 * The load-bearing test in this file is the last one. Nothing on this path may
 * reach Lead Perfection, on either branch: a submission is an unverified
 * intake record, and LP creation is a later decision made after a confirmation
 * agent reviews it. The regression guard asserts against the SOURCE TEXT of
 * the handler, not just its runtime behaviour, because a runtime spy can only
 * catch a call on a path a test happens to walk — and the defect this guards
 * against arrives as an innocent import in a future edit.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Force the module-default supabase client to null (mocks are injected
// explicitly per test; fail-open paths must not find ambient env creds).
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const HANDLER_PATH = fileURLToPath(new URL('../src/canvass-confirmation-handler.js', import.meta.url));

const {
  validateConfirmationPayload,
  normalizeLeadInLp,
  buildConfirmationNote,
  processCanvassConfirmation,
  findRecentConfirmationMark,
  registerCanvassConfirmationRoutes,
} = await import('../src/canvass-confirmation-handler.js');

// ─── Test fixtures ──────────────────────────────────────────────

// "Now": Tue Jul 14 2026, 10:00 ET (14:00Z). Appt: Thu Jul 16, 2:00 PM.
const NOW = new Date('2026-07-14T14:00:00Z');

const COMMON = {
  confirmation_version: 'v1',
  ghl_contact_id: 'CONTACT123',
  lightfire_agent: 'Dana Reyes',
  first_name: 'Test',
  last_name: 'Homeowner',
  phone_raw: '+19545551234',
  email: 'test@example.com',
  appt_date: '2026-07-16',
  appt_slot: '2:00 PM',
  notes: 'homeowner asked us to arrive after 2',
  promoter: 'Jordan P',
};

/** Existing-prospect branch: prospect id, match answers, no address/counts. */
function existingRaw(overrides = {}) {
  return {
    ...COMMON,
    lead_in_lp: 'Yes — I have a Prospect ID',
    lp_prospect_id: '778812',
    phone_match: 'Yes',
    address_match: 'Yes',
    ...overrides,
  };
}

/** New-lead branch: address + counts + spouse, no prospect id. */
function newLeadRaw(overrides = {}) {
  return {
    ...COMMON,
    lead_in_lp: 'No — new lead',
    address1: '123 Main St',
    city: 'Delray Beach',
    state: 'FL',
    zip: '33446',
    window_count: '15',
    door_count: '1',
    slider_count: '2',
    spouse_name: 'Paloma',
    ...overrides,
  };
}

function normalize(raw) {
  const { ok, normalized, errors } = validateConfirmationPayload(raw);
  assert.ok(ok, `fixture must validate: ${errors && errors.join('; ')}`);
  return normalized;
}

// Stateful mock of canvass_confirmation_marks keyed by dedup_key.
function mockMarksClient(rows = new Map()) {
  return {
    _rows: rows,
    from() {
      return {
        upsert(row) {
          rows.set(row.dedup_key, { ...(rows.get(row.dedup_key) || {}), ...row });
          return Promise.resolve({ error: null });
        },
        select() {
          return {
            eq(_k, v) {
              return {
                maybeSingle() {
                  return Promise.resolve({ data: rows.get(v) || null, error: null });
                },
              };
            },
          };
        },
        delete() {
          return {
            eq(_k, v) {
              rows.delete(v);
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
}

function mockDeps({ noteImpl, client, canvasser } = {}) {
  const calls = { notes: [], groupme: [], events: [], canvasser: [], addLead: [] };
  const deps = {
    client: client ?? mockMarksClient(),
    now: () => NOW,
    addGHLNote: async (contactId, body) => {
      calls.notes.push({ contactId, body });
      if (noteImpl) return noteImpl(contactId, body);
      return { id: 'note_1' };
    },
    sendGroupMeMessage: async (text, opts) => {
      calls.groupme.push({ text, opts });
      return { sent: true };
    },
    emitEvent: async (event) => {
      calls.events.push(event);
      return { id: 1 };
    },
    resolveCanvasserProId: async (value) => {
      calls.canvasser.push(value);
      return canvasser || { send: false, proId: null, name: null, market: null, reason: 'absent' };
    },
    // Not a dependency the handler has — deliberately. If a future edit gives
    // it one, this spy makes the call visible instead of silent. See the
    // regression guard at the bottom of the file.
    addLead: async (fields) => {
      calls.addLead.push(fields);
      throw new Error('addLead must never be reachable from the confirmation path');
    },
  };
  return { deps, calls };
}

// Minimal express stand-in: captures the registered handler and lets a test
// drive it with a request shape and read back the status + JSON body.
function fakeApp() {
  const routes = new Map();
  return {
    post(path, handler) { routes.set(path, handler); },
    async request(path, { body, headers = {}, query = {} } = {}) {
      const handler = routes.get(path);
      assert.ok(handler, `no handler registered for ${path}`);
      let statusCode = 200;
      let jsonBody;
      const res = {
        status(code) { statusCode = code; return res; },
        json(payload) { jsonBody = payload; return res; },
      };
      await handler({ body, headers, query }, res);
      return { statusCode, body: jsonBody };
    },
  };
}

/** Settle the fire-and-forget pipeline the route kicks off after its 202. */
const settle = () => new Promise((r) => setImmediate(r));

// ─── 1–3. Structural gates → 400 ────────────────────────────────

test('route: missing confirmation_version → 400', async () => {
  const { deps, calls } = mockDeps();
  const app = fakeApp();
  registerCanvassConfirmationRoutes(app, deps);

  const body = existingRaw();
  delete body.confirmation_version;
  const res = await app.request('/webhooks/canvass-confirmation', { body });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.accepted, false);
  assert.ok(res.body.errors.some((e) => /confirmation_version/.test(e)));
  assert.equal(calls.events.length, 0);
});

test('route: confirmation_version present but not "v1" → 400', async () => {
  const { deps } = mockDeps();
  const app = fakeApp();
  registerCanvassConfirmationRoutes(app, deps);

  // "v2" is the canvassing intake's version. Accepting it here would let a
  // misrouted canvassing submission record as a confirmation.
  const res = await app.request('/webhooks/canvass-confirmation', {
    body: existingRaw({ confirmation_version: 'v2' }),
  });

  assert.equal(res.statusCode, 400);
  assert.ok(res.body.errors.some((e) => /confirmation_version/.test(e)));
});

test('route: missing ghl_contact_id → 400', async () => {
  const { deps, calls } = mockDeps();
  const app = fakeApp();
  registerCanvassConfirmationRoutes(app, deps);

  const body = existingRaw();
  delete body.ghl_contact_id;
  const res = await app.request('/webhooks/canvass-confirmation', { body });

  assert.equal(res.statusCode, 400);
  assert.ok(res.body.errors.some((e) => /ghl_contact_id/.test(e)));
  // A rejected payload must not have recorded anything.
  assert.equal(calls.events.length, 0);
  assert.equal(calls.notes.length, 0);
});

test('validation: only the two gates are structural — everything else is optional', () => {
  assert.equal(validateConfirmationPayload(null).ok, false);
  assert.equal(validateConfirmationPayload('nope').ok, false);
  assert.equal(validateConfirmationPayload([]).ok, false);

  // A submission carrying nothing but the two gates still validates. Which
  // fields arrive is what distinguishes the branches, so a blank is
  // information, never a failure — including a missing lead_in_lp, which
  // normalizeLeadInLp handles rather than rejecting.
  const minimal = validateConfirmationPayload({
    confirmation_version: 'v1', ghl_contact_id: 'X',
  });
  assert.equal(minimal.ok, true);
  assert.equal(minimal.normalized.ghl_contact_id, 'X');
  assert.equal(minimal.normalized.lp_prospect_id, '');
  assert.equal(minimal.normalized.lead_in_lp_raw, '');
});

// ─── 4. customData nesting ──────────────────────────────────────

test('validation: keys nested under customData are flattened and accepted', () => {
  // Exactly what GHL's standard Webhook action posts: the step's declared keys
  // live under customData, not at the top level. Reading req.body flat 400'd
  // every event-form submission on the canvassing route (2026-07-30).
  const nested = validateConfirmationPayload({
    contactId: 'ghl-native-key',
    customData: {
      confirmation_version: 'v1',
      ghl_contact_id: 'CONTACT123',
      lead_in_lp: 'Yes — I have a Prospect ID',
      lp_prospect_id: '778812',
      lightfire_agent: 'Dana Reyes',
      phone_match: 'No',
      phone_correction: '954-555-9999',
    },
  });
  assert.equal(nested.ok, true);
  assert.equal(nested.normalized.lp_prospect_id, '778812');
  assert.equal(nested.normalized.lightfire_agent, 'Dana Reyes');
  assert.equal(nested.normalized.phone_correction, '954-555-9999');

  // Stringified and array shapes are handled by the same shared flattener.
  const stringified = validateConfirmationPayload({
    customData: JSON.stringify({
      confirmation_version: 'v1', ghl_contact_id: 'C2', lp_prospect_id: '5',
    }),
  });
  assert.equal(stringified.ok, true);
  assert.equal(stringified.normalized.lp_prospect_id, '5');

  // Values are trimmed on the way through.
  const padded = validateConfirmationPayload({
    customData: { confirmation_version: ' v1 ', ghl_contact_id: ' C3 ', lp_prospect_id: ' 77 ' },
  });
  assert.equal(padded.ok, true);
  assert.equal(padded.normalized.ghl_contact_id, 'C3');
  assert.equal(padded.normalized.lp_prospect_id, '77');
});

// ─── 5. lead_in_lp normalisation ────────────────────────────────

test('normalizeLeadInLp: leading yes/no wins, however the label is worded', () => {
  // The live option text today.
  assert.deepEqual(normalizeLeadInLp('Yes — I have a Prospect ID', ''), { value: true, source: 'stated' });
  assert.deepEqual(normalizeLeadInLp('No — new lead', '778812'), { value: false, source: 'stated' });
  // Bare, cased, padded.
  assert.deepEqual(normalizeLeadInLp('yes', ''), { value: true, source: 'stated' });
  assert.deepEqual(normalizeLeadInLp('no', ''), { value: false, source: 'stated' });
  assert.deepEqual(normalizeLeadInLp('  YES, already in LP  ', ''), { value: true, source: 'stated' });

  // A stated answer is taken at face value even when it disagrees with the
  // Prospect ID — the disagreement is then visible on the event rather than
  // quietly overridden here.
  assert.equal(normalizeLeadInLp('No — new lead', '778812').value, false);
});

test('normalizeLeadInLp: an unrecognised answer infers from the Prospect ID', () => {
  // A reworded dropdown option, an unresolved merge tag, a blank — all
  // ambiguous rather than wrong, so infer and mark it inferred.
  assert.deepEqual(normalizeLeadInLp('Already a customer', '778812'), { value: true, source: 'inferred' });
  assert.deepEqual(normalizeLeadInLp('Already a customer', ''), { value: false, source: 'inferred' });
  assert.deepEqual(normalizeLeadInLp('', '778812'), { value: true, source: 'inferred' });
  assert.deepEqual(normalizeLeadInLp(undefined, ''), { value: false, source: 'inferred' });
  assert.deepEqual(normalizeLeadInLp(null, '  '), { value: false, source: 'inferred' });
});

test('pipeline: an inferred branch answer is carried on the event and raises a card', async () => {
  const { deps, calls } = mockDeps();
  const result = await processCanvassConfirmation(
    normalize(existingRaw({ lead_in_lp: 'Already a customer' })),
    deps
  );

  assert.equal(result.outcome, 'recorded');
  assert.equal(result.lead_in_lp, true);
  assert.equal(calls.events[0].payload.lead_in_lp, true);
  assert.equal(calls.events[0].payload.lead_in_lp_source, 'inferred');

  const card = calls.groupme.find((g) => g.text.includes('CONFIRMATION PATH UNCLEAR'));
  assert.ok(card, 'a guessed branch is a case a human should look at');
  assert.match(card.text, /SALES PRIORITY/);
  // And the note says so too, so it is visible on the contact itself.
  assert.match(calls.notes[0].body, /In Lead Perfection: Yes \(inferred/);
});

test('pipeline: a stated answer raises no path card', async () => {
  const { deps, calls } = mockDeps();
  await processCanvassConfirmation(normalize(existingRaw()), deps);
  assert.equal(calls.groupme.filter((g) => g.text.includes('PATH UNCLEAR')).length, 0);
  assert.equal(calls.events[0].payload.lead_in_lp_source, 'stated');
  assert.match(calls.notes[0].body, /In Lead Perfection: Yes/);
  assert.equal(/inferred/.test(calls.notes[0].body), false);
});

// ─── 6. lead_in_lp true + blank prospect id → blocked ───────────

test('route+pipeline: lead_in_lp true with no prospect id → 202, priority card, mark blocked', async () => {
  const client = mockMarksClient();
  const { deps, calls } = mockDeps({ client });
  const app = fakeApp();
  registerCanvassConfirmationRoutes(app, deps);

  const res = await app.request('/webhooks/canvass-confirmation', {
    body: existingRaw({ lp_prospect_id: '' }),
  });
  // Accepted at the door — GHL is not the one who can fix this.
  assert.equal(res.statusCode, 202);
  await settle();

  const card = calls.groupme.find((g) => g.text.includes('CONFIRMATION MISSING PROSPECT ID'));
  assert.ok(card, 'priority card expected');
  assert.match(card.text, /SALES PRIORITY/);
  assert.match(card.text, /contacts\/detail\/CONTACT123/);
  assert.match(card.text, /Act within/);

  assert.equal(client._rows.get('CONTACT123').status, 'blocked');
  // Skipped async: nothing recorded, because there is nothing to tie it to.
  assert.equal(calls.events.length, 0);
  assert.equal(calls.notes.length, 0);
});

test('marks: a blocked mark never blocks the re-fire the operator is told to make', async () => {
  const client = mockMarksClient();
  const { deps, calls } = mockDeps({ client });
  const app = fakeApp();
  registerCanvassConfirmationRoutes(app, deps);

  await app.request('/webhooks/canvass-confirmation', { body: existingRaw({ lp_prospect_id: '' }) });
  await settle();
  assert.equal(client._rows.get('CONTACT123').status, 'blocked');
  client._rows.get('CONTACT123').created_at = new Date().toISOString();

  // The operator adds the Prospect ID in GHL and re-fires, seconds later. If
  // the blocked mark counted as a duplicate the fix would appear to do nothing.
  const retry = await app.request('/webhooks/canvass-confirmation', { body: existingRaw() });
  assert.equal(retry.statusCode, 202);
  await settle();
  assert.equal(calls.events.length, 1);
  assert.equal(client._rows.get('CONTACT123').status, 'recorded');
});

// ─── 7–8. Both branches through one endpoint ────────────────────

test('pipeline: new-lead payload → event carries address + counts, note renders the count block', async () => {
  const { deps, calls } = mockDeps();
  const result = await processCanvassConfirmation(normalize(newLeadRaw()), deps);

  assert.equal(result.outcome, 'recorded');
  assert.equal(result.lead_in_lp, false);

  const evt = calls.events[0];
  assert.equal(evt.payload.lead_in_lp, false);
  assert.equal(evt.payload.lead_in_lp_source, 'stated');
  assert.equal(evt.payload.lp_prospect_id, null);
  assert.equal(evt.payload.address1, '123 Main St');
  assert.equal(evt.payload.city, 'Delray Beach');
  assert.equal(evt.payload.state, 'FL');
  assert.equal(evt.payload.zip, '33446');
  assert.equal(evt.payload.window_count, '15');
  assert.equal(evt.payload.door_count, '1');
  assert.equal(evt.payload.slider_count, '2');
  assert.equal(evt.payload.spouse_name, 'Paloma');
  // No prospect to bind at the top level of the event on this branch.
  assert.equal('lp_prospect_id' in evt, false);

  const note = calls.notes[0].body;
  assert.match(note, /Window Count: 15/);
  assert.match(note, /Door Count: 1/);
  assert.match(note, /Slider Count: 2/);
  assert.match(note, /Address: 123 Main St, Delray Beach, FL 33446/);
  assert.match(note, /Spouse\/co-owner: Paloma/);
  assert.match(note, /In Lead Perfection: No/);
  assert.equal(/LP Prospect ID/.test(note), false);
  // Counts lead the block — job size must not sit below free text.
  assert.ok(
    note.indexOf('Window Count: 15') < note.indexOf('homeowner asked us to arrive after 2'),
    'project counts must precede the free-text notes'
  );
});

test('pipeline: existing-prospect payload → note omits the count block and the address', async () => {
  const { deps, calls } = mockDeps();
  const result = await processCanvassConfirmation(normalize(existingRaw()), deps);

  assert.equal(result.outcome, 'recorded');
  assert.equal(result.lead_in_lp, true);

  const note = calls.notes[0].body;
  assert.match(note, /LP Prospect ID: 778812/);
  assert.match(note, /Lightfire agent: Dana Reyes/);
  assert.match(note, /Appointment: 07\/16\/2026 at 2:00 PM/);
  assert.match(note, /Notes: homeowner asked us to arrive after 2/);
  // Nothing from the new-lead branch renders — one call, no path branching,
  // because buildLeadNoteLines omits blanks.
  assert.equal(/Window Count/.test(note), false);
  assert.equal(/Door Count/.test(note), false);
  assert.equal(/Slider Count/.test(note), false);
  assert.equal(/Address:/.test(note), false);
  assert.equal(/Spouse/.test(note), false);
  // No empty lines left behind by the filter.
  assert.equal(/\n\s*\n/.test(note), false);

  const evt = calls.events[0];
  assert.equal(evt.payload.lp_prospect_id, '778812');
  assert.equal(evt.lp_prospect_id, '778812');
  assert.equal(evt.payload.address1, null);
  assert.equal(evt.payload.window_count, null);
});

test('route: valid payload → 202 accepted, one event, note, mark recorded, system card', async () => {
  const { deps, calls } = mockDeps();
  const app = fakeApp();
  registerCanvassConfirmationRoutes(app, deps);

  const res = await app.request('/webhooks/canvass-confirmation', { body: existingRaw() });
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, { accepted: true });
  await settle();

  assert.equal(calls.events.length, 1);
  const evt = calls.events[0];
  assert.equal(evt.event_type, 'canvass.confirmation_submitted');
  assert.equal(evt.source, 'canvass_confirmation_webhook');
  assert.equal(evt.entity_type, 'contact');
  assert.equal(evt.entity_id, 'CONTACT123');
  assert.equal(evt.idempotency_key, 'canvass_confirmation_CONTACT123_2026-07-14');
  assert.equal(evt.payload.lightfire_agent, 'Dana Reyes');
  assert.equal(evt.payload.adate, '07/16/2026');
  assert.equal(evt.payload.atime, '2:00 PM');
  assert.equal(evt.payload.appt_status, 'ok');
  assert.equal(evt.payload.notes, 'homeowner asked us to arrive after 2');
  assert.equal(evt.payload.pro_id_verdict, 'absent');
  // Derived server-side — never read from the client.
  assert.equal(evt.payload.appointment_set, true);
  assert.equal('appointment_set' in existingRaw(), false, 'the client must not be able to assert appointment_set');

  assert.equal(calls.notes.length, 1);
  assert.equal(calls.notes[0].contactId, 'CONTACT123');

  assert.equal(calls.groupme.length, 1);
  assert.match(calls.groupme[0].text, /SYSTEM EVENT — CANVASS CONFIRMATION RECORDED/);
  assert.match(calls.groupme[0].text, /Prospect: 778812/);
  assert.equal(calls.groupme[0].opts.channel, 'canvass');
  assert.equal(calls.groupme[0].opts.flushNow, true);

  const mark = deps.client._rows.get('CONTACT123');
  assert.equal(mark.status, 'recorded');
  assert.equal(mark.lp_prospect_id, '778812');
  assert.equal(mark.lead_in_lp, true);
});

// ─── 9. Idempotency ─────────────────────────────────────────────

test('route: second POST within 24h → duplicate:true, no second event', async () => {
  const client = mockMarksClient();
  const { deps, calls } = mockDeps({ client });
  const app = fakeApp();
  registerCanvassConfirmationRoutes(app, deps);

  const first = await app.request('/webhooks/canvass-confirmation', { body: existingRaw() });
  assert.equal(first.statusCode, 202);
  // The route fires the pipeline without awaiting it (GHL never waits), so
  // settle it before asserting on the mark it writes.
  await settle();
  assert.equal(calls.events.length, 1);

  const second = await app.request('/webhooks/canvass-confirmation', { body: existingRaw() });
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.body, { accepted: false, duplicate: true });
  await settle();
  assert.equal(calls.events.length, 1, 'the duplicate must not emit a second event');
  assert.equal(calls.notes.length, 1, 'the duplicate must not write a second note');
});

test('marks: a stale mark does not block a re-fire', async () => {
  const client = mockMarksClient();
  const { deps } = mockDeps({ client });
  await processCanvassConfirmation(normalize(existingRaw()), deps);

  const mark = client._rows.get('CONTACT123');
  mark.created_at = new Date().toISOString();
  assert.ok(await findRecentConfirmationMark('CONTACT123', { client }));

  mark.created_at = new Date(Date.now() - 25 * 60 * 60000).toISOString();
  assert.equal(await findRecentConfirmationMark('CONTACT123', { client }), null);
});

test('marks: fail-open — no client → lookup returns null, processing proceeds', async () => {
  assert.equal(await findRecentConfirmationMark('CONTACT123', { client: null }), null);
  const { deps, calls } = mockDeps({ client: null });
  const result = await processCanvassConfirmation(normalize(existingRaw()), deps);
  assert.equal(result.outcome, 'recorded');
  assert.equal(calls.events.length, 1);
});

// ─── 10. Note failure is non-fatal ──────────────────────────────

test('pipeline: note write fails → pipeline completes, event still emitted', async () => {
  const { deps, calls } = mockDeps({
    noteImpl: () => { throw new Error('GHL 500'); },
  });
  const result = await processCanvassConfirmation(normalize(existingRaw()), deps);

  assert.equal(result.outcome, 'recorded');
  assert.equal(result.note, 'failed');
  assert.equal(calls.events.length, 1, 'the event is the durable record — it must survive a note failure');
  assert.equal(deps.client._rows.get('CONTACT123').status, 'recorded');
});

test('pipeline: note returns not_found / null / duplicate → recorded, reason carried out', async () => {
  for (const [impl, expected] of [
    [() => 'not_found', 'contact_not_found'],
    [() => null, 'failed'],
    [() => ({ skipped: true, reason: 'duplicate_note' }), 'duplicate'],
  ]) {
    const { deps, calls } = mockDeps({ noteImpl: impl });
    const result = await processCanvassConfirmation(normalize(existingRaw()), deps);
    assert.equal(result.outcome, 'recorded');
    assert.equal(result.note, expected);
    assert.equal(calls.events.length, 1);
  }
});

// ─── 11. Mismatch → priority card ───────────────────────────────

test('pipeline: phone_match "No" → priority card, correction on the event and the note', async () => {
  const { deps, calls } = mockDeps();
  const result = await processCanvassConfirmation(
    normalize(existingRaw({ phone_match: 'No', phone_correction: '954-555-9999' })),
    deps
  );

  assert.equal(result.outcome, 'recorded');

  const card = calls.groupme.find((g) => g.text.includes('CANVASS CONFIRMATION MISMATCH'));
  assert.ok(card, 'a flagged mismatch is a case a human must act on');
  assert.match(card.text, /SALES PRIORITY/);
  assert.match(card.text, /954-555-9999/);
  assert.match(card.text, /contacts\/detail\/CONTACT123/);
  assert.match(card.text, /Act within/);
  // The normal system card must NOT also fire — one submission, one card.
  assert.equal(calls.groupme.filter((g) => g.text.includes('CANVASS CONFIRMATION RECORDED')).length, 0);

  const evt = calls.events[0];
  assert.equal(evt.payload.phone_match, 'No');
  assert.equal(evt.payload.phone_correction, '954-555-9999');
  assert.match(calls.notes[0].body, /Phone on file did NOT match/);
  assert.match(calls.notes[0].body, /Corrected phone: 954-555-9999/);
});

test('pipeline: address_match "no" (any casing) also raises priority', async () => {
  const { deps, calls } = mockDeps();
  await processCanvassConfirmation(
    normalize(existingRaw({ address_match: 'no', address_correction: '9 Palm Ct' })),
    deps
  );
  const card = calls.groupme.find((g) => g.text.includes('CANVASS CONFIRMATION MISMATCH'));
  assert.ok(card);
  assert.match(card.text, /address/);
  assert.match(calls.notes[0].body, /Corrected address: 9 Palm Ct/);
});

test('pipeline: both matches "Yes" → system class only, no priority card', async () => {
  const { deps, calls } = mockDeps();
  await processCanvassConfirmation(normalize(existingRaw()), deps);
  assert.equal(calls.groupme.filter((g) => g.text.includes('SALES PRIORITY')).length, 0);
});

// ─── 12. Appointment handling ───────────────────────────────────

test('pipeline: unparseable appointment → status on the event, nothing throws', async () => {
  const { deps, calls } = mockDeps();
  const result = await processCanvassConfirmation(
    normalize(existingRaw({ appt_slot: 'whenever', appt_date: 'sometime' })),
    deps
  );

  assert.equal(result.outcome, 'recorded');
  assert.equal(result.appt_status, 'unparseable');
  const evt = calls.events[0];
  assert.equal(evt.payload.appt_status, 'unparseable');
  assert.equal(evt.payload.adate, null);
  assert.equal(evt.payload.atime, null);
  assert.equal(evt.payload.appointment_set, false);
  // The raw values still reach the human, marked as unrecognised.
  assert.match(calls.notes[0].body, /Appointment as submitted: sometime whenever/);
});

test('pipeline: beyond-window appointment records rather than rejects', async () => {
  // Tue submit for the following Saturday — beyond the 2-day canvassing
  // window. This endpoint records; it does not gate.
  const { deps, calls } = mockDeps();
  const result = await processCanvassConfirmation(
    normalize(existingRaw({ appt_date: '2026-07-18', appt_slot: '10:00 AM' })),
    deps
  );
  assert.equal(result.outcome, 'recorded');
  assert.equal(calls.events[0].payload.appt_status, 'beyond_window');
  assert.equal(calls.events[0].payload.adate, '07/18/2026');
  assert.equal(calls.events[0].payload.appointment_set, true);
  assert.equal(deps.client._rows.get('CONTACT123').status, 'recorded');
});

test('pipeline: no appointment at all → recorded with appointment_set false', async () => {
  const { deps, calls } = mockDeps();
  const result = await processCanvassConfirmation(
    normalize(existingRaw({ appt_date: '', appt_slot: '' })),
    deps
  );
  assert.equal(result.outcome, 'recorded');
  assert.equal(calls.events[0].payload.appointment_set, false);
  assert.equal(/Appointment/.test(calls.notes[0].body), false);
});

// ─── Canvasser attribution (recorded, never enforced) ───────────

test('pipeline: unknown pro_id → verdict on the event, system card, still recorded', async () => {
  const { deps, calls } = mockDeps({
    canvasser: { send: true, proId: '999999', name: null, market: null, reason: 'unknown_pro_id' },
  });
  const result = await processCanvassConfirmation(normalize(existingRaw({ pro_id: '999999' })), deps);

  assert.equal(result.outcome, 'recorded');
  assert.equal(calls.events[0].payload.pro_id_verdict, 'unknown_pro_id');
  assert.equal(calls.events[0].payload.pro_id, '999999');
  const card = calls.groupme.find((g) => g.text.includes('CONFIRMATION CANVASSER UNRESOLVED'));
  assert.ok(card, 'a suspect id is worth naming');
  // Attribution only — nothing is credited from this path, so it is never a
  // priority card here (unlike the canvassing intake, where LP pays on it).
  assert.match(card.text, /SYSTEM EVENT/);
});

test('pipeline: ok / inactive / absent verdicts raise no card', async () => {
  for (const reason of ['ok', 'inactive_canvasser', 'absent']) {
    const { deps, calls } = mockDeps({
      canvasser: { send: true, proId: '4428', name: 'Joshua Clemons', market: 'FTMYR', reason },
    });
    await processCanvassConfirmation(normalize(existingRaw({ pro_id: '4428' })), deps);
    assert.equal(
      calls.groupme.filter((g) => g.text.includes('CANVASSER UNRESOLVED')).length, 0,
      `${reason} must not card the channel`
    );
    // The resolved identity — not the raw form value — is what lands on the event.
    assert.equal(calls.events[0].payload.promoter, 'Joshua Clemons');
    assert.equal(calls.events[0].payload.pro_id, '4428');
    assert.match(calls.notes[0].body, /Canvasser: Joshua Clemons \(Pro ID 4428\)/);
  }
});

// ─── Note builder, directly ─────────────────────────────────────

test('note: blank fields are omitted, never printed as empty labels', () => {
  const p = normalize(existingRaw({
    lightfire_agent: '', notes: '', promoter: '', appt_date: '', appt_slot: '',
  }));
  const note = buildConfirmationNote(p, { status: 'unparseable', adate: null, atime: null });
  assert.match(note, /LP Prospect ID: 778812/);
  assert.equal(/Lightfire agent/.test(note), false);
  assert.equal(/Notes:/.test(note), false);
  assert.equal(/Canvasser:/.test(note), false);
  assert.equal(/Appointment/.test(note), false);
  assert.equal(/\n\s*\n/.test(note), false);
});

// ─── 13. Regression guard: no LP write on any path ──────────────

test('REGRESSION GUARD: nothing on this path can reach LP addLead', async () => {
  // ── Static half. A submission is an unverified intake record; LP creation
  // is a later decision made after a confirmation agent reviews it in P4. The
  // guard is on the source text because the defect arrives as an import, not
  // as a call a test would happen to walk.
  const source = readFileSync(HANDLER_PATH, 'utf8');
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')  // block comments (which DO say "addLead")
    .replace(/^\s*\/\/.*$/gm, '');     // whole-line comments

  for (const forbidden of [
    /\baddLead\b/,            // the call itself
    /\blp-client\b/,          // its module, in any import form
    /\bbuildLpLeadFields\b/,  // the field map that only feeds addLead
    /\blppost\b/,             // the legacy LP endpoint
    /\bforceLpLeadCreation\b/,
  ]) {
    assert.equal(
      forbidden.test(code), false,
      `src/canvass-confirmation-handler.js must not reference ${forbidden} — this path records only,`
      + ' on BOTH branches. If an LP write is genuinely needed here, that is a separate decision'
      + ' with a separate PR.'
    );
  }

  // ── Runtime half. Every pipeline branch, with a spy that would both record
  // and throw if anything ever called it.
  const branches = [
    existingRaw(),
    existingRaw({ phone_match: 'No', phone_correction: '954-555-9999' }),
    existingRaw({ address_match: 'No' }),
    existingRaw({ lead_in_lp: 'Already a customer' }),
    existingRaw({ lp_prospect_id: '' }),          // the blocked gate
    existingRaw({ appt_slot: 'whenever' }),
    existingRaw({ appt_date: '', appt_slot: '' }),
    existingRaw({ appt_date: '2026-07-18', appt_slot: '10:00 AM' }),
    existingRaw({ pro_id: '999999' }),
    newLeadRaw(),
    newLeadRaw({ appt_date: '', appt_slot: '' }),
    newLeadRaw({ lead_in_lp: 'unrecognised' }),
  ];
  for (const raw of branches) {
    const { deps, calls } = mockDeps({ noteImpl: () => { throw new Error('GHL 500'); } });
    await processCanvassConfirmation(normalize(raw), deps);
    assert.equal(calls.addLead.length, 0, 'addLead must never be called from the confirmation path');
  }
});
