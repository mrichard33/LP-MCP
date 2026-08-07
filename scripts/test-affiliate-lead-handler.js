/**
 * test-affiliate-lead-handler.js — POST /webhooks/affiliate-lead pipeline.
 *
 * Exercises validation, payload-supplied attribution, the 24h idempotency
 * marks, the LP field map, state normalization, the consent key-existence
 * switch, the partial-appointment guard, the failure paths, and the derived
 * appointment_set on the emitted event — all against injected mocks (no
 * network, no DB).
 *
 * srs_id is supplied by the GHL workflow and taken at face value: the handler
 * cannot tell a correct SubSource ID from a plausible wrong one, so a typo in
 * the workflow misattributes silently (Mark's call, 2026-08-07). What IS still
 * guarded — and what the two ATTRIBUTION tests below exist to keep guarded — is
 * that the handler never INVENTS attribution: a missing srs_id is a 400, and
 * the canvassing SubSource 344 appears nowhere in the module as a fallback.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Force the module-default supabase client to null (mocks are injected
// explicitly per test; fail-open paths must not find ambient env creds).
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

// Attribution is NOT configured by env — the workflow sends srs_id. Deleted
// explicitly so a stale AFFILIATE_SRS_MAP in the ambient environment could
// never make these tests pass for the wrong reason.
delete process.env.AFFILIATE_SRS_MAP;
process.env.AFFILIATE_WINDOW_DAYS = '21';

const {
  validateAffiliatePayload,
  buildAffiliateLeadFields,
  processAffiliateLead,
  findRecentAffiliateMark,
  normalizeState,
  consentGranted,
  AFFILIATE_SENDER,
  FIELD_LP_INBOUND_LEAD_ID,
} = await import('../src/affiliate-lead-handler.js');
const { convertCanvassAppointment } = await import('../src/canvassing-time.js');

const AFFILIATE_WINDOW_DAYS = 21;

// ─── Test fixtures ──────────────────────────────────────────────

// "Now": Tue Jul 14 2026, 10:00 ET (14:00Z). Appt: Thu Jul 16, 2:00 PM.
const NOW = new Date('2026-07-14T14:00:00Z');

function validPayload(overrides = {}) {
  const { normalized } = validateAffiliatePayload({
    affiliate_version: 'v1',
    affiliate_code: 'lead-pilot',
    srs_id: '871',
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
    affiliate_notes: 'fogging since the last storm',
    spouse_name: 'Paloma',
    submitted_by: 'Jordan P',
    appt_date: '2026-07-16',
    appt_slot: '2:00 PM',
    utm_source: 'lead-pilot',
    utm_medium: 'affiliate',
    utm_campaign: 'summer26',
    utm_term: '33446',
    utm_content: 'form-a',
    consent_date: '2026-07-14T13:00:00Z',
    ...overrides,
  });
  return normalized;
}

function apptFor(p) {
  return convertCanvassAppointment(
    { appt_date: p.appt_date, appt_slot: p.appt_slot },
    NOW,
    AFFILIATE_WINDOW_DAYS
  );
}

// Stateful mock of affiliate_intake_marks keyed by dedup_key.
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

function mockDeps({ addLeadImpl, client } = {}) {
  const calls = { addLead: [], groupme: [], ghlFields: [], events: [], salesrabbit: [] };
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
    emitEvent: async (event) => {
      calls.events.push(event);
      return { id: 1 };
    },
    // Deliberately injected so a regression that reintroduces the canvassing
    // SalesRabbit step would be caught rather than silently no-op'ing.
    updateSalesRabbitLead: async (id, fields) => {
      calls.salesrabbit.push({ id, fields });
      return { ok: true, status: 200 };
    },
  };
  return { deps, calls };
}

// ─── 1. Structural gates ────────────────────────────────────────

test('validation: structural gates are ghl_contact_id + affiliate_version + affiliate_code + srs_id', () => {
  assert.equal(validateAffiliatePayload(null).ok, false);
  assert.equal(validateAffiliatePayload('nope').ok, false);

  const base = { affiliate_version: 'v1', affiliate_code: 'lead-pilot', srs_id: '871' };

  // Missing ghl_contact_id.
  const noId = validateAffiliatePayload({ ...base });
  assert.equal(noId.ok, false);
  assert.ok(noId.errors.some((e) => /ghl_contact_id/.test(e)));

  // Wrong affiliate_version — must be exactly "v1".
  const badVersion = validateAffiliatePayload({ ...base, ghl_contact_id: 'X', affiliate_version: 'v2' });
  assert.equal(badVersion.ok, false);
  assert.ok(badVersion.errors.some((e) => /affiliate_version/.test(e)));

  // Absent affiliate_version reports "(empty)" rather than swallowing it.
  const noVersion = validateAffiliatePayload({
    ghl_contact_id: 'X', affiliate_code: 'lead-pilot', srs_id: '871',
  });
  assert.equal(noVersion.ok, false);
  assert.ok(noVersion.errors.some((e) => /\(empty\)/.test(e)));

  // Missing affiliate_code — the pilot's per-affiliate audit key.
  const noCode = validateAffiliatePayload({ ghl_contact_id: 'X', affiliate_version: 'v1', srs_id: '871' });
  assert.equal(noCode.ok, false);
  assert.ok(noCode.errors.some((e) => /affiliate_code is required/.test(e)));

  // Missing contact data is NOT a structural failure — accepted, skipped async.
  const minimal = validateAffiliatePayload({ ...base, ghl_contact_id: 'X' });
  assert.equal(minimal.ok, true);
  assert.equal(minimal.normalized.ghl_contact_id, 'X');
});

test('validation: reads customData (GHL standard Webhook action nests declared keys)', () => {
  // GHL does not post declared keys flat. Reading req.body directly returned
  // undefined for every declared key and 400'd every event submission on
  // 2026-07-30 — this route must not repeat it.
  const nested = validateAffiliatePayload({
    contactId: 'ignored',
    customData: {
      ghl_contact_id: 'CD1',
      affiliate_version: 'v1',
      affiliate_code: 'lead-pilot',
      srs_id: '871',
      first_name: 'Ada',
    },
  });
  assert.equal(nested.ok, true);
  assert.equal(nested.normalized.ghl_contact_id, 'CD1');
  assert.equal(nested.normalized.first_name, 'Ada');

  // Stringified customData is the same story.
  const stringified = validateAffiliatePayload({
    customData: JSON.stringify({
      ghl_contact_id: 'CD2', affiliate_version: 'v1', affiliate_code: 'lead-pilot', srs_id: '871',
    }),
  });
  assert.equal(stringified.ok, true);
  assert.equal(stringified.normalized.ghl_contact_id, 'CD2');
});

test('validation: trims payload strings and lowercases affiliate_code', () => {
  const { normalized } = validateAffiliatePayload({
    ghl_contact_id: ' C1 ',
    affiliate_version: 'v1',
    affiliate_code: ' Lead-Pilot ',
    srs_id: ' 871 ',
    first_name: '  Ada ',
    appt_slot: ' 2:00 pm ',
  });
  assert.equal(normalized.ghl_contact_id, 'C1');
  assert.equal(normalized.affiliate_code, 'lead-pilot');
  assert.equal(normalized.first_name, 'Ada');
  assert.equal(normalized.appt_slot, '2:00 pm');
});

// ─── 2. Attribution regression guard (THE important one) ────────

test('ATTRIBUTION: a missing srs_id is REJECTED — no default, never a fallback to 344', () => {
  const bad = validateAffiliatePayload({
    ghl_contact_id: 'X',
    affiliate_version: 'v1',
    affiliate_code: 'lead-pilot',
    // srs_id deliberately absent
    first_name: 'Test', phone_raw: '9545551234', address1: '1 Main',
    city: 'Delray Beach', state: 'FL', zip: '33446',
  });

  assert.equal(bad.ok, false, 'a payload with no srs_id must fail closed');
  assert.equal(bad.normalized, null, 'no payload may survive a missing srs_id');
  assert.ok(bad.errors.some((e) => /srs_id is required/.test(e)));
  // Blank is the same as absent.
  assert.equal(
    validateAffiliatePayload({
      ghl_contact_id: 'X', affiliate_version: 'v1', affiliate_code: 'lead-pilot', srs_id: '   ',
    }).ok,
    false
  );

  // THE guard that has to survive every future refactor: there is no fallback
  // constant anywhere on this path. Canvassing does `p.srs_id || '344'`, and
  // copying that here would turn a workflow that forgot srs_id into a silent
  // stream of Canvass-attributed affiliate leads — unfixable after the fact
  // without rewriting attribution history.
  const blank = buildAffiliateLeadFields({ ...validPayload(), srs_id: '' }, null);
  assert.equal(blank.srs_id, '', 'a blank srs_id must stay blank, never become 344');
  assert.notEqual(blank.srs_id, '344');
});

test('ATTRIBUTION: module contains no hardcoded canvassing SubSource', async () => {
  // Belt-and-suspenders on the test above: catches a 344 default reintroduced
  // anywhere in the module, including on a path no test happens to exercise.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/affiliate-lead-handler.js', import.meta.url), 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // strip block comments
    .replace(/^\s*\/\/.*$/gm, '');      // strip line comments
  assert.equal(
    /344/.test(code), false,
    'the canvassing SubSource 344 must not appear in affiliate handler code'
  );
});

// ─── 3. Field map: attribution shape ────────────────────────────

test('field map: srs_id passed through from payload, sender GHL-Affiliate, NO pro_id key', () => {
  const p = validPayload();
  const fields = buildAffiliateLeadFields(p, apptFor(p));

  assert.equal(fields.srs_id, '871', 'srs_id must be the value the workflow sent');
  assert.equal(fields.sender, AFFILIATE_SENDER);
  assert.equal(fields.sender, 'GHL-Affiliate');

  // pro_id answers WHO procured the lead and belongs to an LP promoter employee
  // record that affiliates do not have. Never invent one to fill the slot —
  // src/lp-source-ids.js documents the transposition that cost 670 leads.
  assert.equal('pro_id' in fields, false, 'pro_id must not be present at all');

  // A second affiliate carries its own SubSource — one bucket per affiliate,
  // never a shared pilot bucket. Nothing server-side needs to change to onboard
  // one; the workflow supplies the ID.
  const p2 = validPayload({ affiliate_code: 'second-affiliate', srs_id: '872' });
  assert.equal(buildAffiliateLeadFields(p2, apptFor(p2)).srs_id, '872');

  // Standard LP shape carried over from the canvassing field map.
  assert.equal(fields.productID, 'Win');
  assert.equal(fields.proddescr, 'Win');
  assert.equal(fields.lognumber, 'CONTACT123');
  assert.equal(fields.User1, 'CONTACT123');
  assert.equal(fields.lognumber, fields.User1);
  assert.equal(fields.phone, '9545551234'); // E.164 → national 10-digit
  assert.equal(fields.email, 'test@example.com');
  assert.equal(fields._attempts, 3);
  assert.equal(fields.ConsentDate, '2026-07-14T13:00:00Z');
});

test('field map: blank email is omitted, not sent empty', () => {
  const p = validPayload({ email: '' });
  assert.equal('email' in buildAffiliateLeadFields(p, apptFor(p)), false);
});

// ─── 4. Notes block ─────────────────────────────────────────────

test('field map: counts lead the notes block, above the affiliate free text', () => {
  const p = validPayload();
  const fields = buildAffiliateLeadFields(p, apptFor(p));

  assert.match(fields.notes, /Window Count: 15/);
  assert.match(fields.notes, /Door Count: 1/);
  assert.match(fields.notes, /Slider Count: 2/);
  assert.match(fields.notes, /fogging since the last storm/);
  assert.match(fields.notes, /Spouse\/co-owner: Paloma/);
  assert.match(fields.notes, /Submitted by: Jordan P/);

  // Job size must never sit below free text — it is the fact the setter and the
  // dispatched rep both need first.
  assert.ok(
    fields.notes.indexOf('Window Count: 15') < fields.notes.indexOf('fogging since the last storm'),
    'project counts must precede the affiliate free-text notes'
  );
});

test('field map: blank counts are omitted, not printed empty', () => {
  const p = validPayload({ door_count: '', slider_count: '' });
  const fields = buildAffiliateLeadFields(p, apptFor(p));
  assert.match(fields.notes, /Window Count: 15/);
  assert.equal(/Door Count/.test(fields.notes), false);
  assert.equal(/Slider Count/.test(fields.notes), false);
  // No empty lines left behind by the filter.
  assert.equal(/\n\s*\n/.test(fields.notes), false);
});

// ─── 5. UTM ─────────────────────────────────────────────────────

test('validation + field map: flat utm_* keys assemble and ride real LP fields', () => {
  // GHL's Webhook action posts one FLAT key per customData entry — it cannot
  // express a nested object, and the Lead Pilot form carries all five.
  const p = validPayload();
  assert.equal(p.utm.source, 'lead-pilot');
  assert.equal(p.utm.content, 'form-a');

  const fields = buildAffiliateLeadFields(p, apptFor(p));
  assert.equal(fields.utm_source, 'lead-pilot');
  assert.equal(fields.utm_medium, 'affiliate');
  assert.equal(fields.utm_campaign, 'summer26');
  assert.equal(fields.utm_term, '33446');
  assert.equal(fields.utm_content, 'form-a');

  // UTM belongs in LP's own columns, never in note text — notes are what the
  // setter reads on the call. The canvassing path shipped a "UTM: source=..."
  // note line on 2026-08-07 and removed it the same day; it must not reappear.
  assert.equal(/UTM/i.test(fields.notes), false, 'UTM must not appear in notes');

  // Nested still wins when a caller can send it.
  const nested = validateAffiliatePayload({
    ghl_contact_id: 'C2', affiliate_version: 'v1', affiliate_code: 'lead-pilot', srs_id: '871',
    utm: { source: 'nested-wins' }, utm_source: 'ignored',
  });
  assert.equal(nested.normalized.utm.source, 'nested-wins');
});

test('field map: blank utm keys are omitted; all-blank stays null', () => {
  const partial = validPayload({
    utm_campaign: '', utm_term: '', utm_content: '',
  });
  const fields = buildAffiliateLeadFields(partial, apptFor(partial));
  assert.equal(fields.utm_source, 'lead-pilot');
  assert.equal('utm_campaign' in fields, false);
  assert.equal('utm_term' in fields, false);
  assert.equal('utm_content' in fields, false);

  // No utm at all → normalized.utm is null and no utm_* field is emitted.
  const none = validateAffiliatePayload({
    ghl_contact_id: 'C3', affiliate_version: 'v1', affiliate_code: 'lead-pilot', srs_id: '871',
  });
  assert.equal(none.normalized.utm, null);
  const bare = buildAffiliateLeadFields(none.normalized, null);
  assert.equal('utm_source' in bare, false);
  assert.equal('utm_medium' in bare, false);
});

// ─── 6 & 7. Booked / unbooked ───────────────────────────────────

test('pipeline: booked path — apptdate/appttime sent, appointment_set derived true', async () => {
  const { deps, calls } = mockDeps();
  const result = await processAffiliateLead(validPayload(), deps);

  assert.equal(result.outcome, 'ok');
  assert.equal(result.in1_id, '384191');
  assert.equal(calls.addLead.length, 1);
  assert.equal(calls.addLead[0].apptdate, '07/16/2026');
  assert.equal(calls.addLead[0].appttime, '2:00 PM');

  // GHL write-back uses the repo's { id, field_value } convention.
  assert.equal(calls.ghlFields.length, 1);
  assert.deepEqual(calls.ghlFields[0].fields, [
    { id: FIELD_LP_INBOUND_LEAD_ID, field_value: '384191' },
  ]);

  // Exactly one event, with the derived boolean and full contract payload.
  assert.equal(calls.events.length, 1);
  const evt = calls.events[0];
  assert.equal(evt.event_type, 'affiliate.lead_created');
  assert.equal(evt.payload.appointment_set, true);
  assert.equal(evt.payload.affiliate_code, 'lead-pilot');
  assert.equal(evt.payload.srs_id, '871');
  assert.equal(evt.payload.affiliate_version, 'v1');
  assert.equal(evt.payload.in1_id, '384191');
  assert.equal(evt.payload.adate, '07/16/2026');
  assert.equal(evt.payload.atime, '2:00 PM');
  assert.equal(evt.payload.submitted_by, 'Jordan P');

  // Every card flushes immediately.
  assert.ok(calls.groupme.length >= 1);
  for (const g of calls.groupme) {
    assert.equal(g.opts.flushNow, true);
    assert.equal(g.opts.channel, 'canvass'); // default until a dedicated group exists
  }

  // Mark finalized, carrying affiliate_code.
  const mark = deps.client._rows.get('CONTACT123');
  assert.equal(mark.status, 'lp_created');
  assert.equal(mark.in1_id, '384191');
  assert.equal(mark.affiliate_code, 'lead-pilot');
});

test('pipeline: unbooked path — no appointment at all is a normal, non-carded outcome', async () => {
  const { deps, calls } = mockDeps();
  const result = await processAffiliateLead(
    validPayload({ appt_date: '', appt_slot: '' }), deps
  );

  assert.equal(result.outcome, 'ok');
  assert.equal(calls.addLead.length, 1);
  assert.equal('apptdate' in calls.addLead[0], false);
  assert.equal('appttime' in calls.addLead[0], false);
  assert.equal(calls.events[0].payload.appointment_set, false);
  assert.equal(calls.events[0].payload.adate, null);

  // An affiliate who simply did not book is not an exception — no appointment
  // card of any kind should fire.
  assert.equal(calls.groupme.some((g) => /APPT/.test(g.text)), false);
});

// ─── 8. Partial appointment guard ───────────────────────────────

test('pipeline: date without slot → AFFILIATE APPT INCOMPLETE, neither key reaches LP', async () => {
  const { deps, calls } = mockDeps();
  const result = await processAffiliateLead(validPayload({ appt_slot: '' }), deps);

  assert.equal(result.outcome, 'ok');
  const card = calls.groupme.find((g) => g.text.includes('AFFILIATE APPT INCOMPLETE'));
  assert.ok(card, 'partial appointment must card with its own action verb');
  assert.match(card.text, /Appointment Time/, 'the card must name the missing half');

  assert.equal('apptdate' in calls.addLead[0], false);
  assert.equal('appttime' in calls.addLead[0], false);
  assert.equal(calls.events[0].payload.appointment_set, false);

  // The generic rejection card must NOT also fire — one problem, one card.
  assert.equal(calls.groupme.some((g) => g.text.includes('AFFILIATE APPT TIME REJECTED')), false);
});

test('pipeline: slot without date → AFFILIATE APPT INCOMPLETE naming the date', async () => {
  const { deps, calls } = mockDeps();
  await processAffiliateLead(validPayload({ appt_date: '' }), deps);

  const card = calls.groupme.find((g) => g.text.includes('AFFILIATE APPT INCOMPLETE'));
  assert.ok(card);
  assert.match(card.text, /Appointment Date/, 'the card must name the missing half');
  assert.equal('apptdate' in calls.addLead[0], false);
  assert.equal('appttime' in calls.addLead[0], false);
});

test('pipeline: both halves present but garbage slot → TIME REJECTED, not INCOMPLETE', async () => {
  const { deps, calls } = mockDeps();
  const result = await processAffiliateLead(validPayload({ appt_slot: 'whenever' }), deps);

  assert.equal(result.outcome, 'ok');
  assert.ok(calls.groupme.some((g) => g.text.includes('AFFILIATE APPT TIME REJECTED')));
  assert.equal(calls.groupme.some((g) => g.text.includes('AFFILIATE APPT INCOMPLETE')), false);
  assert.equal('apptdate' in calls.addLead[0], false);
  assert.equal(calls.events[0].payload.appointment_set, false);
});

// ─── 9. Booking window ──────────────────────────────────────────

test('pipeline: 21-day window — an affiliate booking 20 days out is NOT flagged', async () => {
  const { deps, calls } = mockDeps();
  // NOW is Tue Jul 14 2026; Aug 3 is 20 days out — inside the affiliate window
  // and far outside the 2-day canvassing one.
  const result = await processAffiliateLead(
    validPayload({ appt_date: '2026-08-03', appt_slot: '10:00 AM' }), deps
  );

  assert.equal(result.outcome, 'ok');
  assert.equal(result.appt_status, 'ok', 'inside the 21-day window this must not flag');
  assert.equal(calls.addLead[0].apptdate, '08/03/2026');
  assert.equal(calls.groupme.some((g) => g.text.includes('BEYOND WINDOW')), false);
  assert.equal(deps.client._rows.get('CONTACT123').flagged_beyond_window, false);
});

test('pipeline: well beyond 21 days → flag card, adate STILL sent, mark flagged', async () => {
  const { deps, calls } = mockDeps();
  // Sep 15 is ~63 days out.
  const result = await processAffiliateLead(
    validPayload({ appt_date: '2026-09-15', appt_slot: '10:00 AM' }), deps
  );

  assert.equal(result.outcome, 'ok');
  assert.equal(result.appt_status, 'beyond_window');
  // Notify-not-block: the lead still posts as Set.
  assert.equal(calls.addLead[0].apptdate, '09/15/2026');
  assert.ok(calls.groupme.some((g) => g.text.includes('AFFILIATE APPT BEYOND WINDOW')));
  assert.equal(calls.events[0].payload.appointment_set, true);
  assert.equal(deps.client._rows.get('CONTACT123').flagged_beyond_window, true);
});

// ─── 10. Consent ────────────────────────────────────────────────

test('consent: key ABSENT → true (canvassing parity, no card)', async () => {
  const p = validPayload();
  assert.equal(p.consent_present, false, 'the fixture must not carry a consent key');

  const fields = buildAffiliateLeadFields(p, apptFor(p));
  assert.equal(fields.HasConsent, 'true');
  assert.equal(fields.TextOptIn, 'true');
  assert.equal(fields.EmailOptIn, 'true');

  const { deps, calls } = mockDeps();
  await processAffiliateLead(p, deps);
  assert.equal(calls.groupme.some((g) => g.text.includes('NO CONSENT')), false);
});

test('consent: key PRESENT and falsy → false on all three flags, plus a priority card', async () => {
  // A GHL checkbox posts strings — "false" is JS-truthy, so a bare truthiness
  // test would silently grant consent nobody gave.
  for (const declined of ['', 'false', 'No', 'off', '0', 'unchecked']) {
    const p = validPayload({ consent: declined });
    assert.equal(p.consent_present, true, `consent key must register as present for "${declined}"`);

    const fields = buildAffiliateLeadFields(p, apptFor(p));
    assert.equal(fields.HasConsent, 'false', `"${declined}" must read as declined`);
    assert.equal(fields.TextOptIn, 'false');
    assert.equal(fields.EmailOptIn, 'false');
  }

  // Declined still posts to LP — suppressing the lead is Mark's call — but
  // never quietly.
  const { deps, calls } = mockDeps();
  const result = await processAffiliateLead(validPayload({ consent: 'false' }), deps);
  assert.equal(result.outcome, 'ok');
  assert.equal(calls.addLead.length, 1, 'a declined-consent lead still posts');
  assert.equal(calls.addLead[0].HasConsent, 'false');
  const card = calls.groupme.find((g) => g.text.includes('AFFILIATE LEAD NO CONSENT'));
  assert.ok(card, 'declined consent must card');
  assert.match(card.text, /SALES PRIORITY/);
});

test('consent: key PRESENT and granted → true, no card', async () => {
  for (const granted of ['true', 'yes', 'Y', 'on', '1', 'checked']) {
    const p = validPayload({ consent: granted });
    assert.equal(buildAffiliateLeadFields(p, apptFor(p)).HasConsent, 'true', `"${granted}" must read as granted`);
  }
  assert.equal(consentGranted('true'), true);
  assert.equal(consentGranted('false'), false);
  assert.equal(consentGranted(''), false);
  assert.equal(consentGranted(undefined), false);
});

// ─── 11. State normalization ────────────────────────────────────

test('normalizeState: codes uppercased, full names mapped, unknown returned as-is', () => {
  assert.equal(normalizeState('fl'), 'FL');
  assert.equal(normalizeState('FL'), 'FL');
  assert.equal(normalizeState('Florida'), 'FL');
  assert.equal(normalizeState('  florida  '), 'FL');
  assert.equal(normalizeState('NC'), 'NC');
  assert.equal(normalizeState('north carolina'), 'NC');
  assert.equal(normalizeState('New York'), 'NY');

  // Unknown values pass through UNCHANGED so the required-field gate still sees
  // a value and the operator card names the real problem instead of a blanked
  // field.
  assert.equal(normalizeState('Ontario'), 'Ontario');
  assert.equal(normalizeState('???'), '???');
  assert.equal(normalizeState(''), '');
  assert.equal(normalizeState(null), '');

  // And it is actually applied on the way to LP.
  const p = validPayload({ state: 'Florida' });
  assert.equal(buildAffiliateLeadFields(p, apptFor(p)).state, 'FL');
});

// ─── 12. Idempotency ────────────────────────────────────────────

test('pipeline: double POST within 24h → single addLead; stale mark does not block', async () => {
  const client = mockMarksClient();
  const { deps, calls } = mockDeps({ client });

  await processAffiliateLead(validPayload(), deps);
  const mark = client._rows.get('CONTACT123');
  mark.created_at = new Date().toISOString();

  // The route's pre-check must find the fresh mark → duplicate response, no
  // second processAffiliateLead call.
  const existing = await findRecentAffiliateMark('CONTACT123', { client });
  assert.ok(existing, 'fresh mark must be found within the window');
  assert.equal(existing.affiliate_code, 'lead-pilot');
  assert.equal(calls.addLead.length, 1, 'single addLead across the double-POST');

  // A stale mark (older than the window) does NOT block a re-fire.
  mark.created_at = new Date(Date.now() - 25 * 60 * 60000).toISOString();
  assert.equal(await findRecentAffiliateMark('CONTACT123', { client }), null);
});

test('pipeline: fail-open — no client → lookup returns null, processing proceeds', async () => {
  assert.equal(await findRecentAffiliateMark('CONTACT123', { client: null }), null);
  const { deps, calls } = mockDeps({ client: null });
  const result = await processAffiliateLead(validPayload(), deps);
  assert.equal(result.outcome, 'ok');
  assert.equal(calls.addLead.length, 1);
});

// ─── 13. Failure paths ──────────────────────────────────────────

test('pipeline: addLead hard failure → priority card, mark deleted, NO event emitted', async () => {
  const client = mockMarksClient();
  const { deps, calls } = mockDeps({
    client,
    addLeadImpl: () => {
      throw new Error('lppost addlead failed after 3 attempt(s): boom');
    },
  });
  const result = await processAffiliateLead(validPayload(), deps);

  assert.equal(result.outcome, 'lp_failed');
  const card = calls.groupme.find((g) => g.text.includes('LP SUBMIT FAILED'));
  assert.ok(card);
  assert.match(card.text, /SALES PRIORITY/);
  assert.match(card.text, /contacts\/detail\/CONTACT123/);
  // Mark removed so a manual re-fire is not swallowed by the dedup guard.
  assert.equal(client._rows.has('CONTACT123'), false);
  assert.equal(calls.events.length, 0, 'no lead_created event when the lead never reached LP');
});

test('pipeline: missing required fields → priority card, NO addLead', async () => {
  const { deps, calls } = mockDeps();
  const result = await processAffiliateLead(
    validPayload({ phone_raw: '', address1: '' }), deps
  );
  assert.equal(result.outcome, 'skipped_missing_fields');
  assert.equal(calls.addLead.length, 0);
  const card = calls.groupme.find((g) => g.text.includes('AFFILIATE LEAD BLOCKED'));
  assert.ok(card, 'priority blocked card expected');
  assert.match(card.text, /SALES PRIORITY/);
  assert.match(card.text, /contacts\/detail\/CONTACT123/);
  assert.equal(calls.events.length, 0);
});

test('pipeline: LP OK but unparseable in1_id → system card, event still emitted, no write-back', async () => {
  const { deps, calls } = mockDeps({
    addLeadImpl: () => ({ status: 'OK', message: 'welcome to the machine', _path: 'legacy' }),
  });
  const result = await processAffiliateLead(validPayload(), deps);
  assert.equal(result.outcome, 'ok');
  assert.equal(result.in1_id, null);
  assert.equal(calls.ghlFields.length, 0);
  assert.ok(calls.groupme.some((g) => g.text.includes('LP INBOUND ID UNPARSEABLE')));
  assert.equal(calls.events[0].payload.in1_id, null);
});

// ─── 14. No SalesRabbit, ever ───────────────────────────────────

test('pipeline: SalesRabbit is NEVER called — affiliates are not canvassers', async () => {
  const { deps, calls } = mockDeps();
  // Even with a salesrabbit_id smuggled onto the payload, nothing must call it.
  await processAffiliateLead({ ...validPayload(), salesrabbit_id: '4746413' }, deps);
  assert.equal(calls.salesrabbit.length, 0);

  // The validator does not even carry the field through.
  assert.equal('salesrabbit_id' in validPayload(), false);
});

test('module: does not import salesrabbit.js at all', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/affiliate-lead-handler.js', import.meta.url), 'utf8');
  assert.equal(
    /^\s*import[^\n]*salesrabbit/m.test(src), false,
    'the affiliate handler must not import the SalesRabbit client'
  );
});
