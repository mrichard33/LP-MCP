/**
 * test-classified-card-detail.js — the v1.2 detail lines on classified cards,
 * and the ONE shared LP Appointment Set card builder (2026-08-27).
 *
 * Two things are locked here:
 *
 * 1. The new buildClassifiedNotification args (address, email, jobSize,
 *    canvasser, lpRef) render when present and are ABSENT when not — and every
 *    existing caller, which passes none of them, produces BYTE-IDENTICAL output
 *    to before. That is the whole safety argument for adding lines to a card
 *    format ~40 call sites share.
 *
 * 2. services/appointment-card.js is the single builder for the "LP Appointment
 *    Set" card. The two producers hand-rolled it separately and had drifted
 *    twice (see that module's header); these assertions are what stops a third
 *    drift from being invisible.
 *
 * Run with:  node --test scripts/test-classified-card-detail.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// No ambient DB — resolveMarket must degrade to the classifier's "Unknown"
// rather than taking the card down with it.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { buildClassifiedNotification } = await import('../src/actions/notification-classifier.js');
const {
  buildLpAppointmentCard,
  buildAppointmentDisplay,
  formatAddressLine,
  hasMeaningfulCalendar,
} = await import('../src/services/appointment-card.js');

const BASE = {
  notification_class: 'system',
  action_verb: 'LP APPOINTMENT SET',
  name: 'Myron Thorner',
  phone: '+17275551234',
  contactId: 'q5GehRye7DNkN6jlmjl3',
  tier: 'Hot',
  status: 'Appointment Set',
  narrative: 'Appointment written to Lead Perfection.',
};

// ─── Backward compatibility ─────────────────────────────────────

test('an existing caller passing none of the new args is byte-identical to the old format', () => {
  const card = buildClassifiedNotification(BASE);
  assert.equal(card, [
    '🤖 SYSTEM EVENT — LP APPOINTMENT SET',
    '',
    '👤 Myron Thorner | (727) 555-1234',
    'Contact ID: q5GehRye7DNkN6jlmjl3',
    'Prospect: NONE',
    '🌍 Market: Unknown',
    '📋 Src: Unknown',
    '',
    '📊 Tier: Hot',
    '📌 Status: Appointment Set',
    '',
    '📝 Appointment written to Lead Perfection.',
  ].join('\n'));
});

test('Market and Src stay ALWAYS-ON with the Unknown fallback — absence is signal', () => {
  const card = buildClassifiedNotification(BASE);
  assert.match(card, /🌍 Market: Unknown/);
  assert.match(card, /📋 Src: Unknown/);
});

// ─── Each new line renders when present ─────────────────────────

test('each new arg renders its own line, in order, after Src and before Tier', () => {
  const card = buildClassifiedNotification({
    ...BASE,
    market: 'Tampa',
    lpSource: 'Canvassing',
    lpSourceDetail: 'Jordan Pérez',
    address: '123 Main St, Trinity FL 34655',
    email: 'myron@example.com',
    jobSize: '8 windows · 2 doors',
    canvasser: 'Jordan Pérez',
    lpRef: 'Lead 570351 | Prospect 454810',
  });

  const lines = card.split('\n');
  const idx = (re) => lines.findIndex((l) => re.test(l));

  assert.ok(idx(/📍 123 Main St, Trinity FL 34655/) > idx(/📋 Src:/));
  assert.ok(idx(/✉️ myron@example\.com/) > idx(/📍/));
  assert.ok(idx(/📐 Job size: 8 windows · 2 doors/) > idx(/✉️/));
  assert.ok(idx(/🚪 Canvasser: Jordan Pérez/) > idx(/📐 Job size/));
  assert.ok(idx(/📋 LP: Lead 570351 \| Prospect 454810/) > idx(/🚪/));
  assert.ok(idx(/📊 Tier:/) > idx(/📋 LP:/));
});

// ─── Each new line is ABSENT when blank ─────────────────────────

for (const [arg, marker] of [
  ['address', '📍'],
  ['email', '✉️'],
  ['jobSize', '📐 Job size'],
  ['canvasser', '🚪'],
  ['lpRef', '📋 LP:'],
]) {
  test(`${arg}: blank, empty and undefined all render NO line`, () => {
    for (const value of [undefined, null, '']) {
      const card = buildClassifiedNotification({ ...BASE, [arg]: value });
      assert.ok(!card.includes(marker), `${arg}=${JSON.stringify(value)} leaked a ${marker} line`);
    }
  });
}

// ─── Address formatting ─────────────────────────────────────────

test('formatAddressLine: a street anchors the line; no street means no line at all', () => {
  assert.equal(
    formatAddressLine({ address1: '123 Main St', city: 'Trinity', state: 'FL', zip: '34655' }),
    '123 Main St, Trinity FL 34655',
  );
  assert.equal(formatAddressLine({ address1: '123 Main St' }), '123 Main St');
  assert.equal(formatAddressLine({ address1: '123 Main St', city: 'Trinity' }), '123 Main St, Trinity');
  // City/state/zip with no street is not an address anyone can drive to, and
  // "📍 , FL 34655" is worse than nothing.
  assert.equal(formatAddressLine({ city: 'Trinity', state: 'FL', zip: '34655' }), undefined);
  assert.equal(formatAddressLine({}), undefined);
  assert.equal(formatAddressLine(), undefined);
});

// ─── Appointment display: the drift that shipped twice ──────────

test('hasMeaningfulCalendar treats the literal "N/A" as absent', () => {
  assert.equal(hasMeaningfulCalendar('Window Estimate'), true);
  assert.equal(hasMeaningfulCalendar('N/A'), false);
  assert.equal(hasMeaningfulCalendar('n/a'), false);
  assert.equal(hasMeaningfulCalendar('   '), false);
  assert.equal(hasMeaningfulCalendar(''), false);
  assert.equal(hasMeaningfulCalendar(null), false);
});

test('buildAppointmentDisplay renders date, 12h time, calendar and GHL status', () => {
  assert.equal(
    buildAppointmentDisplay({ apptDate: '08/28/2026', apptTime: '18:00', calendarName: 'Window Estimate', ghlStatus: 'new' }),
    '08/28/2026 6:00 PM EST | Window Estimate | ⏳ DM confirm pending',
  );
  assert.equal(
    buildAppointmentDisplay({ apptDate: '08/28/2026', apptTime: '18:00', calendarName: 'Window Estimate', ghlStatus: 'confirmed' }),
    '08/28/2026 6:00 PM EST | Window Estimate | ✅ confirmed',
  );
  // An unknown status contributes no segment rather than an empty one.
  assert.equal(
    buildAppointmentDisplay({ apptDate: '08/28/2026', apptTime: '18:00', calendarName: 'N/A', ghlStatus: 'showed' }),
    '08/28/2026 6:00 PM EST',
  );
});

// ─── The shared card ────────────────────────────────────────────

test('buildLpAppointmentCard renders one card carrying LP ref, address, email and appointment', async () => {
  const card = await buildLpAppointmentCard({
    contactId: 'q5GehRye7DNkN6jlmjl3',
    name: 'Myron Thorner',
    phone: '+17275551234',
    email: 'myron@example.com',
    lpLeadId: '570351',
    prospectId: '454810',
    lpSource: 'Canvassing',
    lpSourceDetail: 'Jordan Pérez',
    address1: '123 Main St',
    city: 'Trinity',
    state: 'FL',
    zip: '34655',
    apptDate: '08/28/2026',
    apptTime: '18:00',
    calendarName: 'Window Estimate',
    ghlStatus: 'new',
  });

  assert.match(card, /🤖 SYSTEM EVENT — LP APPOINTMENT SET/);
  assert.match(card, /👤 Myron Thorner \| \(727\) 555-1234/);
  assert.match(card, /Prospect: 454810/);
  assert.match(card, /📍 123 Main St, Trinity FL 34655/);
  assert.match(card, /✉️ myron@example\.com/);
  assert.match(card, /📋 LP: Lead 570351 \| Prospect 454810/);
  assert.match(card, /📅 08\/28\/2026 6:00 PM EST \| Window Estimate \| ⏳ DM confirm pending/);
  assert.match(card, /📊 Tier: Hot/);
  assert.match(card, /📌 Status: Appointment Set/);
});

test('a missing prospect reads NONE on BOTH the Prospect line and the LP ref', async () => {
  // The two hand-rolled copies disagreed here: one printed NONE, the other N/A.
  const card = await buildLpAppointmentCard({
    contactId: 'C1', lpLeadId: '570351', apptDate: '08/28/2026', apptTime: '18:00',
  });
  assert.match(card, /Prospect: NONE/);
  assert.match(card, /📋 LP: Lead 570351 \| Prospect NONE/);
  assert.doesNotMatch(card, /N\/A/);
});

test('market resolution failing (no DB) degrades to Unknown rather than losing the card', async () => {
  const card = await buildLpAppointmentCard({
    contactId: 'C1', lpLeadId: '570351', apptDate: '08/28/2026', apptTime: '18:00', zip: '34655',
  });
  assert.match(card, /🌍 Market: Unknown/);
});

test('a card with nothing optional to show renders no empty detail lines', async () => {
  const card = await buildLpAppointmentCard({
    contactId: 'C1', lpLeadId: '570351', apptDate: '08/28/2026',
  });
  assert.ok(!card.includes('📍'));
  assert.ok(!card.includes('✉️'));
  assert.ok(!card.includes('🚪'));
  assert.ok(!card.includes('Job size'));
});
