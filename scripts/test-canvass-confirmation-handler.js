/**
 * test-canvass-confirmation-handler.js — POST /webhooks/canvass-confirmation.
 *
 * Exercises the structural gates, the 24h idempotency marks, the note body,
 * the emitted event contract, the mismatch card class, and the route's
 * response codes — all against injected mocks (no network, no DB).
 *
 * The load-bearing test in this file is the last one. This endpoint exists
 * because the existing-prospect branch of the Lightfire confirmation form,
 * routed through /webhooks/canvassing-lead, would call LP addLead on a
 * prospect LP already holds and create a duplicate lead. The regression guard
 * asserts against the SOURCE TEXT of the handler, not just its runtime
 * behaviour, because a runtime spy can only catch a call on a path a test
 * happens to walk — and the defect this guards against arrives as an innocent
 * import in a future edit.
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
  buildConfirmationNote,
  processCanvassConfirmation,
  findRecentConfirmationMark,
  registerCanvassConfirmationRoutes,
} = await import('../src/canvass-confirmation-handler.js');

// ─── Test fixtures ──────────────────────────────────────────────

// "Now": Tue Jul 14 2026, 10:00 ET (14:00Z). Appt: Thu Jul 16, 2:00 PM.
const NOW = new Date('2026-07-14T14:00:00Z');

function rawPayload(overrides = {}) {
  return {
    confirmation_version: 'v1',
    ghl_contact_id: 'CONTACT123',
    lp_prospect_id: '778812',
    lightfire_agent: 'Dana Reyes',
    first_name: 'Test',
    last_name: 'Homeowner',
    phone_raw: '+19545551234',
    appt_date: '2026-07-16',
    appt_slot: '2:00 PM',
    phone_match: 'Yes',
    address_match: 'Yes',
    submission_reason: 'Canvass appointment called in',
    canvassing_notes: 'homeowner asked us to arrive after 2',
    promoter: 'Jordan P',
    ...overrides,
  };
}

function validPayload(overrides = {}) {
  const { normalized } = validateConfirmationPayload(rawPayload(overrides));
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

// ─── 1–3. Structural gates → 400 ────────────────────────────────

test('route: missing confirmation_version → 400', async () => {
  const { deps } = mockDeps();
  const app = fakeApp();
  registerCanvassConfirmationRoutes(app, deps);

  const body = rawPayload();
  delete body.confirmation_version;
  const res = await app.request('/webhooks/canvass-confirmation', { body });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.accepted, false);
  assert.ok(res.body.errors.some((e) => /confirmation_version/.test(e)));
});

test('route: confirmation_version present but not "v1" → 400', async () => {
  const { deps } = mockDeps();
  const app = fakeApp();
  registerCanvassConfirmationRoutes(app, deps);

  // "v2" is the canvassing intake's version. Accepting it here would let a
  // misrouted canvassing submission record as a confirmation.
  const res = await app.request('/webhooks/canvass-confirmation', {
    body: rawPayload({ confirmation_version: 'v2' }),
  });

  assert.equal(res.statusCode, 400);
  assert.ok(res.body.errors.some((e) => /confirmation_version/.test(e)));
});

test('route: missing lp_prospect_id → 400 (the whole point of this path)', async () => {
  const { deps, calls } = mockDeps();
  const app = fakeApp();
  registerCanvassConfirmationRoutes(app, deps);

  const body = rawPayload();
  delete body.lp_prospect_id;
  const res = await app.request('/webhooks/canvass-confirmation', { body });

  assert.equal(res.statusCode, 400);
  assert.ok(res.body.errors.some((e) => /lp_prospect_id/.test(e)));
  // A rejected payload must not have recorded anything.
  assert.equal(calls.events.length, 0);
  assert.equal(calls.notes.length, 0);
});

test('validation: ghl_contact_id is structural too; a bare valid pair passes', () => {
  const noContact = validateConfirmationPayload({ confirmation_version: 'v1', lp_prospect_id: '1' });
  assert.equal(noContact.ok, false);
  assert.ok(noContact.errors.some((e) => /ghl_contact_id/.test(e)));

  assert.equal(validateConfirmationPayload(null).ok, false);
  assert.equal(validateConfirmationPayload('nope').ok, false);
  assert.equal(validateConfirmationPayload([]).ok, false);

  // Everything except the three gates is optional — a confirmation carrying
  // nothing but the ids still records.
  const minimal = validateConfirmationPayload({
    confirmation_version: 'v1', ghl_contact_id: 'X', lp_prospect_id: '9',
  });
  assert.equal(minimal.ok, true);
  assert.equal(minimal.normalized.ghl_contact_id, 'X');
  assert.equal(minimal.normalized.lp_prospect_id, '9');
  assert.equal(minimal.normalized.lightfire_agent, '');
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

// ─── 5. Happy path ──────────────────────────────────────────────

test('route: valid payload → 202 accepted', async () => {
  const { deps } = mockDeps();
  const app = fakeApp();
  registerCanvassConfirmationRoutes(app, deps);

  const res = await app.request('/webhooks/canvass-confirmation', { body: rawPayload() });
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, { accepted: true });
});

test('pipeline: happy path — one event, note written, mark recorded, system card', async () => {
  const { deps, calls } = mockDeps();
  const result = await processCanvassConfirmation(validPayload(), deps);

  assert.equal(result.outcome, 'recorded');
  assert.equal(result.note, 'written');

  // Event: emitted exactly once, full contract payload.
  assert.equal(calls.events.length, 1);
  const evt = calls.events[0];
  assert.equal(evt.event_type, 'canvass.confirmation_submitted');
  assert.equal(evt.source, 'canvass_confirmation_webhook');
  assert.equal(evt.entity_type, 'contact');
  assert.equal(evt.entity_id, 'CONTACT123');
  assert.equal(evt.idempotency_key, 'canvass_confirmation_CONTACT123_2026-07-14');
  assert.equal(evt.payload.lp_prospect_id, '778812');
  assert.equal(evt.payload.lightfire_agent, 'Dana Reyes');
  assert.equal(evt.payload.adate, '07/16/2026');
  assert.equal(evt.payload.atime, '2:00 PM');
  assert.equal(evt.payload.appt_status, 'ok');
  assert.equal(evt.payload.phone_match, 'Yes');
  assert.equal(evt.payload.submission_reason, 'Canvass appointment called in');
  assert.equal(evt.payload.pro_id_verdict, 'absent');
  // Derived server-side — never read from the client (contract rev 2026-07-15).
  assert.equal(evt.payload.appointment_set, true);
  assert.equal('appointment_set' in rawPayload(), false, 'the client must not be able to assert appointment_set');

  // Note written to the right contact, carrying the facts the team needs.
  assert.equal(calls.notes.length, 1);
  assert.equal(calls.notes[0].contactId, 'CONTACT123');
  assert.match(calls.notes[0].body, /LP Prospect ID: 778812/);
  assert.match(calls.notes[0].body, /Lightfire agent: Dana Reyes/);
  assert.match(calls.notes[0].body, /Appointment: 07\/16\/2026 at 2:00 PM/);
  assert.match(calls.notes[0].body, /Submission reason: Canvass appointment called in/);
  assert.match(calls.notes[0].body, /Canvasser notes: homeowner asked us to arrive after 2/);

  // One card, system class, canvass channel, flushNow.
  assert.equal(calls.groupme.length, 1);
  assert.match(calls.groupme[0].text, /SYSTEM EVENT — CANVASS CONFIRMATION RECORDED/);
  assert.match(calls.groupme[0].text, /Prospect: 778812/);
  assert.equal(calls.groupme[0].opts.channel, 'canvass');
  assert.equal(calls.groupme[0].opts.flushNow, true);

  // Mark finalized.
  const mark = deps.client._rows.get('CONTACT123');
  assert.equal(mark.status, 'recorded');
  assert.equal(mark.lp_prospect_id, '778812');
});

test('note: blank fields are omitted, never printed as empty labels', () => {
  const p = validPayload({
    lightfire_agent: '', submission_reason: '', canvassing_notes: '', promoter: '',
  });
  const note = buildConfirmationNote(p, { status: 'ok', adate: '07/16/2026', atime: '2:00 PM' });
  assert.match(note, /LP Prospect ID: 778812/);
  assert.equal(/Lightfire agent/.test(note), false);
  assert.equal(/Submission reason/.test(note), false);
  assert.equal(/Canvasser:/.test(note), false);
  // No empty lines left behind by the filter.
  assert.equal(/\n\s*\n/.test(note), false);
});

// ─── 6. Idempotency ─────────────────────────────────────────────

test('route: second POST within 24h → duplicate:true, no second event', async () => {
  const client = mockMarksClient();
  const { deps, calls } = mockDeps({ client });
  const app = fakeApp();
  registerCanvassConfirmationRoutes(app, deps);

  const first = await app.request('/webhooks/canvass-confirmation', { body: rawPayload() });
  assert.equal(first.statusCode, 202);
  // The route fires the pipeline without awaiting it (GHL never waits), so
  // settle it before asserting on the mark it writes.
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.events.length, 1);

  const second = await app.request('/webhooks/canvass-confirmation', { body: rawPayload() });
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.body, { accepted: false, duplicate: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.events.length, 1, 'the duplicate must not emit a second event');
  assert.equal(calls.notes.length, 1, 'the duplicate must not write a second note');
});

test('marks: a stale mark does not block a re-fire; a failed one never blocks', async () => {
  const client = mockMarksClient();
  const { deps } = mockDeps({ client });
  await processCanvassConfirmation(validPayload(), deps);

  const mark = client._rows.get('CONTACT123');
  mark.created_at = new Date().toISOString();
  assert.ok(await findRecentConfirmationMark('CONTACT123', { client }));

  mark.created_at = new Date(Date.now() - 25 * 60 * 60000).toISOString();
  assert.equal(await findRecentConfirmationMark('CONTACT123', { client }), null);

  // 'failed' means the pipeline threw before recording anything — there is no
  // event and no note for a re-fire to duplicate, so it must be able to get in.
  mark.created_at = new Date().toISOString();
  mark.status = 'failed';
  assert.equal(await findRecentConfirmationMark('CONTACT123', { client }), null);
});

test('marks: fail-open — no client → lookup returns null, processing proceeds', async () => {
  assert.equal(await findRecentConfirmationMark('CONTACT123', { client: null }), null);
  const { deps, calls } = mockDeps({ client: null });
  const result = await processCanvassConfirmation(validPayload(), deps);
  assert.equal(result.outcome, 'recorded');
  assert.equal(calls.events.length, 1);
});

// ─── 7. Note failure is non-fatal ───────────────────────────────

test('pipeline: note write fails → pipeline still completes, event still emitted', async () => {
  const { deps, calls } = mockDeps({
    noteImpl: () => { throw new Error('GHL 500'); },
  });
  const result = await processCanvassConfirmation(validPayload(), deps);

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
    const result = await processCanvassConfirmation(validPayload(), deps);
    assert.equal(result.outcome, 'recorded');
    assert.equal(result.note, expected);
    assert.equal(calls.events.length, 1);
  }
});

// ─── 8. Mismatch → priority card ────────────────────────────────

test('pipeline: phone_match "No" → priority card, correction on the event and the note', async () => {
  const { deps, calls } = mockDeps();
  const result = await processCanvassConfirmation(
    validPayload({ phone_match: 'No', phone_correction: '954-555-9999' }),
    deps
  );

  assert.equal(result.outcome, 'recorded');

  const card = calls.groupme.find((g) => g.text.includes('CANVASS CONFIRMATION MISMATCH'));
  assert.ok(card, 'a flagged mismatch is the one case a human must act on');
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
    validPayload({ address_match: 'no', address_correction: '9 Palm Ct' }),
    deps
  );
  const card = calls.groupme.find((g) => g.text.includes('CANVASS CONFIRMATION MISMATCH'));
  assert.ok(card);
  assert.match(card.text, /address/);
  assert.match(calls.notes[0].body, /Corrected address: 9 Palm Ct/);
});

test('pipeline: both matches "Yes" → system class only, no priority card', async () => {
  const { deps, calls } = mockDeps();
  await processCanvassConfirmation(validPayload(), deps);
  assert.equal(calls.groupme.filter((g) => g.text.includes('SALES PRIORITY')).length, 0);
});

// ─── 9. Appointment handling ────────────────────────────────────

test('pipeline: unparseable appointment → status on the event, nothing throws', async () => {
  const { deps, calls } = mockDeps();
  const result = await processCanvassConfirmation(
    validPayload({ appt_slot: 'whenever', appt_date: 'sometime' }),
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
    validPayload({ appt_date: '2026-07-18', appt_slot: '10:00 AM' }),
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
    validPayload({ appt_date: '', appt_slot: '' }),
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
  const result = await processCanvassConfirmation(validPayload({ pro_id: '999999' }), deps);

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
    await processCanvassConfirmation(validPayload({ pro_id: '4428' }), deps);
    assert.equal(
      calls.groupme.filter((g) => g.text.includes('CANVASSER UNRESOLVED')).length, 0,
      `${reason} must not card the channel`
    );
    // The resolved identity — not the raw form value — is what lands on the event.
    assert.equal(calls.events[0].payload.promoter, 'Joshua Clemons');
    assert.equal(calls.events[0].payload.pro_id, '4428');
  }
});

// ─── 10. Regression guard: addLead is unreachable from this path ─

test('REGRESSION GUARD: nothing on this path can reach LP addLead', async () => {
  // ── Static half. This endpoint exists because /webhooks/canvassing-lead
  // calls addLead, which on an existing prospect creates a duplicate lead.
  // The guard is on the source text because the defect arrives as an import,
  // not as a call a test would happen to walk.
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
      `src/canvass-confirmation-handler.js must not reference ${forbidden} — this path records only.`
      + ' If an LP write is genuinely needed here, that is a separate decision with a separate PR.'
    );
  }

  // ── Runtime half. Every pipeline branch, with a spy that would both record
  // and throw if anything ever called it.
  const branches = [
    validPayload(),
    validPayload({ phone_match: 'No', phone_correction: '954-555-9999' }),
    validPayload({ address_match: 'No' }),
    validPayload({ appt_slot: 'whenever' }),
    validPayload({ appt_date: '', appt_slot: '' }),
    validPayload({ appt_date: '2026-07-18', appt_slot: '10:00 AM' }),
    validPayload({ pro_id: '999999' }),
  ];
  for (const payload of branches) {
    const { deps, calls } = mockDeps({ noteImpl: () => { throw new Error('GHL 500'); } });
    await processCanvassConfirmation(payload, deps);
    assert.equal(calls.addLead.length, 0, 'addLead must never be called from the confirmation path');
    assert.equal(calls.events.length, 1);
  }
});
