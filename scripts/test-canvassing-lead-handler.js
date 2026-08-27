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
  claimCanvassMark,
  buildJobSize,
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
//
// insert() models the real PRIMARY KEY on dedup_key: a second insert for the
// same key returns 23505 rather than overwriting. That collision is the entire
// mechanism behind claimCanvassMark — an upsert cannot lose that race because
// it never fails. `insertError` forces a non-23505 DB failure to exercise the
// fail-open branch.
function mockMarksClient(rows = new Map(), { insertError = null } = {}) {
  return {
    _rows: rows,
    from() {
      return {
        insert(row) {
          if (insertError) return Promise.resolve({ error: insertError });
          if (rows.has(row.dedup_key)) {
            return Promise.resolve({ error: { code: '23505', message: 'duplicate key value violates unique constraint "canvassing_intake_marks_pkey"' } });
          }
          rows.set(row.dedup_key, { ...row });
          return Promise.resolve({ error: null });
        },
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

function mockDeps({ addLeadImpl, salesRabbitImpl, client, resolveCanvasserProId } = {}) {
  const calls = { addLead: [], groupme: [], ghlFields: [], salesrabbit: [], events: [] };
  const deps = {
    client: client ?? mockMarksClient(),
    now: () => NOW,
    ...(resolveCanvasserProId ? { resolveCanvasserProId } : {}),
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
  // promoter is a name, not numeric → no pro_id; lands in notes instead
  assert.equal(fields.pro_id, undefined);
  assert.match(fields.notes, /fogging since the last storm/);
  // Regression guard, 2026-08-07: counts were captured on the form and sent in
  // the webhook body but never reached LP notes. On the event path (workflow
  // 7e01702d, no salesrabbit_id) they reached nothing at all. If these come
  // back, the setter is calling blind on job size — do not delete them.
  assert.match(fields.notes, /Window Count: 15/);
  assert.match(fields.notes, /Door Count: 1/);
  assert.match(fields.notes, /Slider Count: 2/);
  // spouse_name was already wired into noteLines but nothing asserted it landed
  // in `notes` — the only spouse assertion in this suite is on the SalesRabbit
  // call, which never fires on the event path. Guard it here.
  assert.match(fields.notes, /Spouse\/co-owner: Paloma/);
  // Counts lead the block — job size must not sit below free text.
  assert.ok(
    fields.notes.indexOf('Window Count: 15') < fields.notes.indexOf('fogging since the last storm'),
    'project counts must precede the canvasser free-text notes'
  );
  assert.match(fields.notes, /Reason for interest: fogged glass/);
  assert.match(fields.notes, /Promoter: Jordan P/);

  // UTM rides real LP columns, never note text. It briefly shipped as a
  // "UTM: source=..." note line; that line is gone and must not come back —
  // notes are what the setter reads on the call.
  assert.equal(fields.utm_source, 'canvassing');
  assert.equal(fields.utm_medium, 'field');
  assert.equal(fields.utm_campaign, 'Jordan P');
  assert.equal(fields.utm_term, '33446');
  assert.equal(/UTM:/.test(fields.notes), false, 'UTM must not appear in notes');
});

test('field map: blank utm keys are omitted, not sent empty', () => {
  // Event-workflow shape: only source and medium are ever populated there.
  const p = validPayload({ utm: { source: 'event', medium: 'staffer' } });
  const appt = convertCanvassAppointment({ appt_date: p.appt_date, appt_slot: p.appt_slot }, NOW);
  const fields = buildLpLeadFields(p, appt);
  assert.equal(fields.utm_source, 'event');
  assert.equal(fields.utm_medium, 'staffer');
  assert.equal('utm_campaign' in fields, false);
  assert.equal('utm_term' in fields, false);

  // No utm at all → no utm_* fields, and still no note line.
  const bare = buildLpLeadFields(validPayload({ utm: null }), appt);
  assert.equal('utm_source' in bare, false);
  assert.equal('utm_medium' in bare, false);
  assert.equal(/UTM/.test(bare.notes), false);
});

test('field map: lognumber and User1 both carry the GHL contact id', () => {
  // Both are how LP links its lead back to the GHL contact ({{contact.id}} in
  // the workflow). ghl_contact_id is a structural requirement — validation 400s
  // without it — so neither can ever go out blank.
  const fields = buildLpLeadFields(validPayload(), null);
  assert.equal(fields.lognumber, 'CONTACT123');
  assert.equal(fields.User1, 'CONTACT123');
  assert.equal(fields.lognumber, fields.User1);
});

test('field map: blank counts are omitted, not printed empty', () => {
  const p = validPayload({ door_count: '', slider_count: '' });
  const appt = convertCanvassAppointment({ appt_date: p.appt_date, appt_slot: p.appt_slot }, NOW);
  const fields = buildLpLeadFields(p, appt);
  assert.match(fields.notes, /Window Count: 15/);
  assert.equal(/Door Count/.test(fields.notes), false);
  assert.equal(/Slider Count/.test(fields.notes), false);
  // No empty lines left behind by the filter.
  assert.equal(/\n\s*\n/.test(fields.notes), false);
});

test('validation: flat utm_* keys assemble into the utm object (event workflow shape)', () => {
  // Exactly what GHL workflow 7e01702d posts: flat keys, no nested utm object.
  const { normalized } = validateCanvassingPayload({
    ghl_contact_id: 'CONTACT123',
    canvass_version: 'v2',
    utm_source: 'event',
    utm_medium: 'staffer',
  });
  assert.equal(normalized.utm.source, 'event');
  assert.equal(normalized.utm.medium, 'staffer');

  // Nested still wins when a caller can send it.
  const nested = validateCanvassingPayload({
    ghl_contact_id: 'C2', canvass_version: 'v2',
    utm: { source: 'canvassing', medium: 'field' }, utm_source: 'ignored',
  });
  assert.equal(nested.normalized.utm.source, 'canvassing');

  // All-blank stays null so buildLpLeadFields emits no utm_* fields at all.
  const none = validateCanvassingPayload({ ghl_contact_id: 'C3', canvass_version: 'v2' });
  assert.equal(none.normalized.utm, null);
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

// ─── Concurrent-duplicate claim (2026-08-27) ────────────────────
//
// Verified defect: contact hclMXNalJA8H2bGVW0kS produced LP inbound leads
// 418571 AND 418575, both at 2026-08-26T23:33Z, while canvassing_intake_marks
// held exactly ONE row. Both POSTs passed the route's findRecentCanvassMark
// pre-check, both called addLead, and the upsert overwrote instead of
// colliding. The claim is an INSERT precisely so one of them loses.

test('claim: two concurrent runs for one contact → addLead called EXACTLY once', async () => {
  const rows = new Map();
  const client = mockMarksClient(rows);
  const a = mockDeps({ client });
  const b = mockDeps({ client });

  const [ra, rb] = await Promise.all([
    processCanvassingLead(validPayload(), a.deps),
    processCanvassingLead(validPayload(), b.deps),
  ]);

  const outcomes = [ra.outcome, rb.outcome].sort();
  assert.deepEqual(outcomes, ['duplicate_suppressed', 'ok']);

  // Exactly one LP write across BOTH runs — the whole point.
  assert.equal(a.calls.addLead.length + b.calls.addLead.length, 1);

  // The loser is silent: a suppressed duplicate is not news.
  const loser = ra.outcome === 'duplicate_suppressed' ? a.calls : b.calls;
  assert.equal(loser.groupme.length, 0);
  assert.equal(loser.events.length, 0);
  assert.equal(loser.ghlFields.length, 0);
  assert.equal(loser.salesrabbit.length, 0);
});

test('claim: the loser returns BEFORE addLead, not after', async () => {
  const rows = new Map();
  const client = mockMarksClient(rows);
  // Winner goes first and completes, so the second run collides on a row that
  // already exists — the sequential form of the same race.
  const first = mockDeps({ client });
  await processCanvassingLead(validPayload(), first.deps);

  const second = mockDeps({ client });
  const result = await processCanvassingLead(validPayload(), second.deps);
  assert.equal(result.outcome, 'duplicate_suppressed');
  assert.equal(second.calls.addLead.length, 0);
  assert.equal(second.calls.groupme.length, 0);
});

test('claim: a non-23505 DB error fails OPEN — the lead still processes', async () => {
  const client = mockMarksClient(new Map(), {
    insertError: { code: '42P01', message: 'relation "canvassing_intake_marks" does not exist' },
  });
  const { deps, calls } = mockDeps({ client });
  const result = await processCanvassingLead(validPayload(), deps);
  // Double-processing during an infra failure beats dropping a lead.
  assert.equal(result.outcome, 'ok');
  assert.equal(calls.addLead.length, 1);
  assert.ok(calls.groupme.some((g) => g.text.includes('CANVASSING LEAD CREATED')));
});

test('claim: no client at all (fail-open) still processes', async () => {
  const { deps, calls } = mockDeps({ client: null });
  const result = await processCanvassingLead(validPayload(), deps);
  assert.equal(result.outcome, 'ok');
  assert.equal(calls.addLead.length, 1);
});

test('claim: later status updates still overwrite the row the claim created', async () => {
  const rows = new Map();
  const { deps } = mockDeps({ client: mockMarksClient(rows) });
  await processCanvassingLead(validPayload(), deps);
  // writeCanvassMark (upsert) must still work on top of the claimed row.
  assert.equal(rows.get('CONTACT123').status, 'lp_created');
  assert.equal(rows.get('CONTACT123').in1_id, '384191');
});

// ─── Card detail (2026-08-27) ───────────────────────────────────

test('card: the canvasser NAME renders, and a numeric Pro ID never reaches the card', async () => {
  const { deps, calls } = mockDeps({
    resolveCanvasserProId: async () => ({ proId: '4471', name: 'Jordan Pérez', reason: 'ok', withheld: false }),
  });
  // promoter is the numeric Pro ID GHL actually sends — it must not be printed.
  await processCanvassingLead(validPayload({ promoter: '4471', pro_id: '4471' }), deps);
  const card = calls.groupme.find((g) => g.text.includes('CANVASSING LEAD CREATED')).text;
  assert.match(card, /🚪 Canvasser: Jordan Pérez/);
  assert.match(card, /📋 Src: .*Jordan Pérez/);
  assert.doesNotMatch(card, /4471/);
});

test('card: an unresolved canvasser omits the line entirely rather than printing an id', async () => {
  const { deps, calls } = mockDeps({
    resolveCanvasserProId: async () => ({ proId: '', name: null, reason: 'absent', withheld: false }),
  });
  const card = await processCanvassingLead(validPayload({ promoter: '9999', pro_id: '9999' }), deps)
    .then(() => calls.groupme.find((g) => g.text.includes('CANVASSING LEAD CREATED')).text);
  assert.doesNotMatch(card, /🚪 Canvasser:/);
  assert.doesNotMatch(card, /9999/);
});

test('card: address, email, job size and LP ref all render', async () => {
  const { deps, calls } = mockDeps();
  await processCanvassingLead(validPayload(), deps);
  const card = calls.groupme.find((g) => g.text.includes('CANVASSING LEAD CREATED')).text;
  assert.match(card, /📍 123 Main St, Delray Beach FL 33446/);
  assert.match(card, /✉️ test@example\.com/);
  assert.match(card, /📐 Job size: 15 windows · 1 door · 2 sliders/);
  assert.match(card, /📋 LP: inbound #384191/);
});

test('card: blank and zero counts are omitted; all-absent renders no job size', async () => {
  const { deps, calls } = mockDeps();
  await processCanvassingLead(validPayload({ window_count: '8', door_count: '0', slider_count: '' }), deps);
  const card = calls.groupme.find((g) => g.text.includes('CANVASSING LEAD CREATED')).text;
  assert.match(card, /📐 Job size: 8 windows$/m);

  const bare = mockDeps();
  await processCanvassingLead(
    validPayload({ window_count: '', door_count: '', slider_count: '' }),
    bare.deps,
  );
  const bareCard = bare.calls.groupme.find((g) => g.text.includes('CANVASSING LEAD CREATED')).text;
  assert.doesNotMatch(bareCard, /Job size/);
});

test('card: a blank address omits the line rather than rendering ", FL 33446"', async () => {
  const { deps, calls } = mockDeps();
  await processCanvassingLead(validPayload({ address1: '' }), deps);
  // No address1 → the lead is blocked before LP, and that card must still be clean.
  const card = calls.groupme.find((g) => g.text.includes('CANVASSING LEAD BLOCKED')).text;
  assert.doesNotMatch(card, /📍/);
});

test('card: an event booth reads as Events, not Canvassing', async () => {
  const { deps, calls } = mockDeps();
  await processCanvassingLead(validPayload({ srs_id: '869' }), deps);
  const card = calls.groupme.find((g) => g.text.includes('CANVASSING LEAD CREATED')).text;
  assert.match(card, /📋 Src: Events/);
});

test('buildJobSize: singular/plural, zeros, blanks, all-absent', () => {
  assert.equal(buildJobSize({ window_count: '1', door_count: '1', slider_count: '1' }), '1 window · 1 door · 1 slider');
  assert.equal(buildJobSize({ window_count: '2', door_count: '0', slider_count: '' }), '2 windows');
  assert.equal(buildJobSize({ window_count: 'abc' }), undefined);
  assert.equal(buildJobSize({}), undefined);
  assert.equal(buildJobSize(), undefined);
});

// ─── State normalization (2026-08-27) ───────────────────────────
//
// LP's state column TRUNCATES TO TWO CHARACTERS silently. Verified against
// lp_prospects: no stored value exceeds 2 chars, and the residue is exactly
// what truncation produces — 39 rows read "Fl" (from GHL's spelled-out
// "Florida"), 18 read "fl", 829 read "nu" (from the literal string "null"),
// with Canvass among the sources on all three. So an un-normalized state is
// not cosmetic: it lands in LP as a wrong value that still looks like a state
// code, and nothing ever errors.

test('state: GHL\'s spelled-out "Florida" reaches LP as FL, not "Fl"', () => {
  const p = validPayload({ state: 'Florida' });
  assert.equal(p.state, 'FL');
  const appt = convertCanvassAppointment({ appt_date: p.appt_date, appt_slot: p.appt_slot }, NOW);
  assert.equal(buildLpLeadFields(p, appt).state, 'FL');
});

test('state: the SAME normalized value reaches the card, so LP and GroupMe agree', async () => {
  const { deps, calls } = mockDeps();
  await processCanvassingLead(validPayload({ state: 'Florida' }), deps);
  const card = calls.groupme.find((g) => g.text.includes('CANVASSING LEAD CREATED')).text;
  assert.match(card, /📍 123 Main St, Delray Beach FL 33446/);
  assert.doesNotMatch(card, /Florida/);
});

test('state: the "null" literal is BLANKED, not forwarded as "nu"', () => {
  // 829 prospects carry "nu" because the string "null" was sent and truncated.
  // Blanking trips the required-field gate instead, which cards the operator.
  for (const junk of ['null', 'NULL', 'undefined', 'NaN', 'none', 'N/A']) {
    assert.equal(validPayload({ state: junk }).state, '', `"${junk}" leaked through`);
  }
});

test('state: a blanked junk state is caught by the required-field gate', async () => {
  const { deps, calls } = mockDeps();
  const result = await processCanvassingLead(validPayload({ state: 'null' }), deps);
  assert.equal(result.outcome, 'skipped_missing_fields');
  assert.equal(calls.addLead.length, 0);
  const card = calls.groupme.find((g) => g.text.includes('CANVASSING LEAD BLOCKED')).text;
  assert.match(card, /missing state/);
});

test('state: already-good values pass through untouched', () => {
  assert.equal(validPayload({ state: 'FL' }).state, 'FL');
  assert.equal(validPayload({ state: 'fl' }).state, 'FL');
  assert.equal(validPayload({ state: 'ga' }).state, 'GA');
  // An unrecognized value is preserved so the operator card names the real
  // problem rather than a silently blanked field.
  assert.equal(validPayload({ state: 'Ontario' }).state, 'Ontario');
});
