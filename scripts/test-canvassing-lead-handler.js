/**
 * test-canvassing-lead-handler.js — POST /webhooks/canvassing-lead pipeline.
 *
 * Exercises validation, the 24h idempotency marks, the LP field map, the
 * failure/notification paths, GHL write-back shape, SalesRabbit
 * non-fatality, and the derived appointment_set on the emitted event —
 * all against injected mocks (no network, no DB).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Force the module-default supabase client to null (mocks are injected
// explicitly per test; fail-open paths must not find ambient env creds).
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const {
  validateCanvassingPayload,
  buildLpLeadFields,
  processCanvassingLead,
  findRecentCanvassMark,
  FIELD_LP_INBOUND_LEAD_ID,
} = await import('../src/canvassing-lead-handler.js');
const { convertCanvassAppointment } = await import('../src/canvassing-time.js');

// ─── Test fixtures ──────────────────────────────────────────────

// "Now": Tue Jul 14 2026, 10:00 ET (14:00Z). Appt: Thu Jul 16, 2:00 PM.
const NOW = new Date('2026-07-14T14:00:00Z');

function validPayload(overrides = {}) {
  const { normalized } = validateCanvassingPayload({
    canvass_version: 'v2',
    ghl_contact_id: 'CONTACT123',
    first_name: 'Test',
    last_name: 'Homeowner',
    phone_raw: '+19545551234',
    email: 'test@example.com',
    address1: '123 Main St',
    city: 'Delray Beach',
    state: 'FL',
    zip: '33446',
    window_count: '15',
    door_count: '1',
    slider_count: '2',
    canvassing_notes: 'fogging since the last storm',
    promoter: 'Jordan P',
    salesrabbit_id: '4746413',
    second_decision_maker: 'Yes',
    spouse_name: 'Paloma',
    dm_confirmed_at_door: 'Yes',
    reason_for_interest: 'fogged glass',
    appt_date: '2026-07-16',
    appt_slot: '2:00 PM',
    utm: { source: 'canvassing', medium: 'field', campaign: 'Jordan P', term: '33446' },
    consent_date: '2026-07-14T13:00:00Z',
    ...overrides,
  });
  return normalized;
}

// Stateful mock of canvassing_intake_marks keyed by dedup_key.
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

function mockDeps({ addLeadImpl, salesRabbitImpl, client } = {}) {
  const calls = { addLead: [], groupme: [], ghlFields: [], salesrabbit: [], events: [] };
  const deps = {
    client: client ?? mockMarksClient(),
    now: () => NOW,
    addLead: async (fields) => {
      calls.addLead.push(fields);
      if (addLeadImpl) return addLeadImpl(fields);
      return { status: 'OK', message: 'lead added: 384191', _path: 'legacy' };
    },
    sendGroupMeMessage: async (text, opts) => {
      calls.groupme.push({ text, opts });
      return { sent: true };
    },
    updateGHLContactFields: async (contactId, fields) => {
      calls.ghlFields.push({ contactId, fields });
      return true;
    },
    updateSalesRabbitLead: async (id, fields) => {
      calls.salesrabbit.push({ id, fields });
      if (salesRabbitImpl) return salesRabbitImpl(id, fields);
      return { ok: true, status: 200 };
    },
    emitEvent: async (event) => {
      calls.events.push(event);
      return { id: 1 };
    },
  };
  return { deps, calls };
}

// ─── Validation ─────────────────────────────────────────────────

test('validation: structural gates are ghl_contact_id + canvass_version only', () => {
  assert.equal(validateCanvassingPayload(null).ok, false);
  assert.equal(validateCanvassingPayload('nope').ok, false);
  assert.equal(validateCanvassingPayload({ canvass_version: 'v2' }).ok, false);
  assert.equal(validateCanvassingPayload({ ghl_contact_id: 'X' }).ok, false);
  assert.equal(validateCanvassingPayload({ ghl_contact_id: 'X', canvass_version: 'v1' }).ok, false);
  // Missing contact data is NOT a structural failure — accepted, skipped async.
  const minimal = validateCanvassingPayload({ ghl_contact_id: 'X', canvass_version: 'v2' });
  assert.equal(minimal.ok, true);
  assert.equal(minimal.normalized.ghl_contact_id, 'X');
});

test('validation: normalizes and trims payload strings', () => {
  const { normalized } = validateCanvassingPayload({
    ghl_contact_id: ' C1 ',
    canvass_version: 'v2',
    first_name: '  Ada ',
    appt_slot: ' 2:00 pm ',
  });
  assert.equal(normalized.ghl_contact_id, 'C1');
  assert.equal(normalized.first_name, 'Ada');
  assert.equal(normalized.appt_slot, '2:00 pm');
});

// ─── LP field map ───────────────────────────────────────────────

test('field map: attribution, consent, appointment, phone, _attempts', () => {
  const p = validPayload();
  const appt = convertCanvassAppointment({ appt_date: p.appt_date, appt_slot: p.appt_slot }, NOW);
  const fields = buildLpLeadFields(p, appt);

  assert.equal(fields.sender, 'GHL-Canvassing');
  assert.equal(fields.srs_id, '344');
  assert.equal(fields.productID, 'Win');
  assert.equal(fields.proddescr, 'Win');
  assert.equal(fields.lognumber, 'CONTACT123');
  assert.equal(fields.User1, 'CONTACT123');
  assert.equal(fields.HasConsent, 'true');
  assert.equal(fields.TextOptIn, 'true');
  assert.equal(fields.EmailOptIn, 'true');
  assert.equal(fields.ConsentDate, '2026-07-14T13:00:00Z');
  assert.equal(fields.phone, '9545551234'); // E.164 → national 10-digit
  assert.equal(fields.apptdate, '07/16/2026');
  assert.equal(fields.appttime, '2:00 PM');
  assert.equal(fields.email, 'test@example.com');
  assert.equal(fields._attempts, 3);
  // promoter is a name, not numeric → no pro_id; lands in notes + UTM
  assert.equal(fields.pro_id, undefined);
  assert.match(fields.notes, /fogging since the last storm/);
  assert.match(fields.notes, /Reason for interest: fogged glass/);
  assert.match(fields.notes, /Promoter: Jordan P/);
  assert.match(fields.notes, /UTM: source=canvassing medium=field campaign=Jordan P term=33446/);
});

test('field map: blank email omitted; numeric promoter becomes pro_id', () => {
  const p = validPayload({ email: '', promoter: '5152' });
  const appt = convertCanvassAppointment({ appt_date: p.appt_date, appt_slot: p.appt_slot }, NOW);
  const fields = buildLpLeadFields(p, appt);
  assert.equal('email' in fields, false);
  assert.equal(fields.pro_id, '5152');
});

test('field map: unparseable appointment omits apptdate/appttime (never invent a time)', () => {
  const p = validPayload({ appt_slot: '3:00 PM' });
  const appt = convertCanvassAppointment({ appt_date: p.appt_date, appt_slot: p.appt_slot }, NOW);
  const fields = buildLpLeadFields(p, appt);
  assert.equal('apptdate' in fields, false);
  assert.equal('appttime' in fields, false);
});

// ─── Pipeline: happy path ───────────────────────────────────────

test('pipeline: happy path — addLead, write-back, SalesRabbit, event, success card', async () => {
  const { deps, calls } = mockDeps();
  const result = await processCanvassingLead(validPayload(), deps);

  assert.equal(result.outcome, 'ok');
  assert.equal(result.in1_id, '384191');
  assert.equal(calls.addLead.length, 1);

  // GHL write-back uses the repo's { id, field_value } convention.
  assert.equal(calls.ghlFields.length, 1);
  assert.deepEqual(calls.ghlFields[0].fields, [
    { id: FIELD_LP_INBOUND_LEAD_ID, field_value: '384191' },
  ]);

  // SalesRabbit called with door-captured fields.
  assert.equal(calls.salesrabbit.length, 1);
  assert.equal(calls.salesrabbit[0].id, '4746413');
  assert.equal(calls.salesrabbit[0].fields.windowCount, '15');
  assert.equal(calls.salesrabbit[0].fields.spouseName, 'Paloma');

  // Event: derived appointment_set, full contract payload.
  assert.equal(calls.events.length, 1);
  const evt = calls.events[0];
  assert.equal(evt.event_type, 'canvassing.lead_created');
  assert.equal(evt.payload.appointment_set, true);
  assert.equal(evt.payload.in1_id, '384191');
  assert.equal(evt.payload.adate, '07/16/2026');
  assert.equal(evt.payload.atime, '2:00 PM');
  assert.equal(evt.payload.canvass_version, 'v2');

  // Every card goes to the canvass channel with flushNow.
  assert.ok(calls.groupme.length >= 1);
  for (const g of calls.groupme) {
    assert.equal(g.opts.channel, 'canvass');
    assert.equal(g.opts.flushNow, true);
  }

  // Mark finalized.
  const mark = deps.client._rows.get('CONTACT123');
  assert.equal(mark.status, 'lp_created');
  assert.equal(mark.in1_id, '384191');
});

// ─── Pipeline: idempotency ──────────────────────────────────────

test('pipeline: double-POST within 24h → second run is caught by the mark pre-check', async () => {
  const client = mockMarksClient();
  const { deps, calls } = mockDeps({ client });

  // Give the mock rows a created_at the pre-check can evaluate.
  await processCanvassingLead(validPayload(), deps);
  const mark = client._rows.get('CONTACT123');
  mark.created_at = new Date().toISOString();

  // The route's pre-check (findRecentCanvassMark) must find the fresh mark →
  // duplicate response, no second processCanvassingLead call.
  const existing = await findRecentCanvassMark('CONTACT123', { client });
  assert.ok(existing, 'fresh mark must be found within the window');
  assert.equal(calls.addLead.length, 1); // single addLead across the double-POST

  // A stale mark (older than the window) does NOT block a re-fire.
  mark.created_at = new Date(Date.now() - 25 * 60 * 60000).toISOString();
  const stale = await findRecentCanvassMark('CONTACT123', { client });
  assert.equal(stale, null);
});

test('pipeline: fail-open — no client → mark lookup returns null, processing proceeds', async () => {
  const found = await findRecentCanvassMark('CONTACT123', { client: null });
  assert.equal(found, null);
  const { deps, calls } = mockDeps({ client: null });
  const result = await processCanvassingLead(validPayload(), deps);
  assert.equal(result.outcome, 'ok');
  assert.equal(calls.addLead.length, 1);
});

// ─── Pipeline: guards and failures ──────────────────────────────

test('pipeline: missing required fields → priority card, NO addLead', async () => {
  const { deps, calls } = mockDeps();
  const result = await processCanvassingLead(validPayload({ phone_raw: '', address1: '' }), deps);
  assert.equal(result.outcome, 'skipped_missing_fields');
  assert.equal(calls.addLead.length, 0);
  const card = calls.groupme.find((g) => g.text.includes('CANVASSING LEAD BLOCKED'));
  assert.ok(card, 'priority blocked card expected');
  assert.match(card.text, /SALES PRIORITY/);
  assert.match(card.text, /contacts\/detail\/CONTACT123/);
});

test('pipeline: garbage appt slot → system card, lead still posts WITHOUT adate', async () => {
  const { deps, calls } = mockDeps();
  const result = await processCanvassingLead(validPayload({ appt_slot: 'whenever' }), deps);
  assert.equal(result.outcome, 'ok');
  assert.equal(calls.addLead.length, 1);
  assert.equal('apptdate' in calls.addLead[0], false);
  assert.ok(calls.groupme.some((g) => g.text.includes('CANVASS APPT TIME REJECTED')));
  // Derived appointment_set is false — no appointment posted.
  assert.equal(calls.events[0].payload.appointment_set, false);
  assert.equal(calls.events[0].payload.adate, null);
});

test('pipeline: beyond-window appt → flag card, adate STILL sent, mark flagged', async () => {
  const { deps, calls } = mockDeps();
  // Tue submit for Saturday.
  const result = await processCanvassingLead(
    validPayload({ appt_date: '2026-07-18', appt_slot: '10:00 AM' }),
    deps
  );
  assert.equal(result.outcome, 'ok');
  assert.equal(calls.addLead[0].apptdate, '07/18/2026');
  assert.ok(calls.groupme.some((g) => g.text.includes('CANVASS APPT BEYOND 48H')));
  assert.equal(calls.events[0].payload.appointment_set, true);
  assert.equal(deps.client._rows.get('CONTACT123').flagged_beyond_window, true);
});

test('pipeline: addLead hard failure → priority card with contact link, mark deleted', async () => {
  const client = mockMarksClient();
  const { deps, calls } = mockDeps({
    client,
    addLeadImpl: () => {
      throw new Error('lppost addlead failed after 3 attempt(s): boom');
    },
  });
  const result = await processCanvassingLead(validPayload(), deps);
  assert.equal(result.outcome, 'lp_failed');
  const card = calls.groupme.find((g) => g.text.includes('LP SUBMIT FAILED'));
  assert.ok(card);
  assert.match(card.text, /SALES PRIORITY/);
  assert.match(card.text, /contacts\/detail\/CONTACT123/);
  // Mark removed so a manual re-fire is not swallowed by the dedup guard.
  assert.equal(client._rows.has('CONTACT123'), false);
  assert.equal(calls.events.length, 0);
});

test('pipeline: LP OK but unparseable in1_id → system card, event still emitted, no write-back', async () => {
  const { deps, calls } = mockDeps({
    addLeadImpl: () => ({ status: 'OK', message: 'welcome to the machine', _path: 'legacy' }),
  });
  const result = await processCanvassingLead(validPayload(), deps);
  assert.equal(result.outcome, 'ok');
  assert.equal(result.in1_id, null);
  assert.equal(calls.ghlFields.length, 0);
  assert.ok(calls.groupme.some((g) => g.text.includes('LP INBOUND ID UNPARSEABLE')));
  assert.equal(calls.events[0].payload.in1_id, null);
});

test('pipeline: SalesRabbit failure is non-fatal (system card, outcome still ok)', async () => {
  const { deps, calls } = mockDeps({
    salesRabbitImpl: () => ({ ok: false, status: 500, reason: 'http_500' }),
  });
  const result = await processCanvassingLead(validPayload(), deps);
  assert.equal(result.outcome, 'ok');
  assert.ok(calls.groupme.some((g) => g.text.includes('SALESRABBIT SYNC FAILED')));
  assert.equal(calls.events.length, 1);
});

test('pipeline: no salesrabbit_id → SalesRabbit never called', async () => {
  const { deps, calls } = mockDeps();
  await processCanvassingLead(validPayload({ salesrabbit_id: '' }), deps);
  assert.equal(calls.salesrabbit.length, 0);
});
