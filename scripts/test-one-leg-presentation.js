/**
 * 1 Leg phone presentation (handoff v3, Mark 2026-10-20) and the S5.2 one_leg
 * regression. Tests 10–12 of the handoff:
 *  10. a 1 Leg contact is offered the Phone Presentation (two real times,
 *      both decision makers, nothing booked until both are confirmed);
 *  11. a contact NOT in one_leg who says "my wife isn't home" keeps the
 *      normal offer;
 *  12. the S5.2 one_leg entry (rule LP_DISP_1LEG_TO_ONELEG → the S5.2 webhook)
 *      is unchanged: still gated, still the S5.2 workflow, and the policy read
 *      that feeds the webhook never reads recovery_cadence.
 *
 * Run: node --test scripts/test-one-leg-presentation.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const pp = await import('../src/agentic/one-leg-presentation.js');
const { planNepqTurn } = await import('../src/agentic/nepq-planner.js');
const { bookingBackedByCode } = await import('../src/agentic/sms-booking-turn.js');
const { isGhlOnlyCalendarId } = await import('../src/knowledge/booking-calendar-router.js');
const gate = await import('../src/s52-entry-gate.js');
const { promisedCallback } = await import('../src/agentic/team-hours.js');
const { readCallPromise } = await import('../src/agentic/promised-callbacks.js');

const NOW = Date.parse('2026-10-21T15:00:00Z'); // Wed 11:00 ET
const CAL = 'ppCalendar00000000001';
const ENV = { PHONE_PRESENTATION_CALENDAR_ID: CAL };
const S = (iso, day, time, rel) => ({ iso, day, time, dayOfWeek: day.slice(0, 3), ...(rel ? { rel } : {}), tz: 'ET' });
const ALL = [
  S('2026-10-21T22:00:00Z', 'Wed, Oct 21', '6:00 PM', 'today'),
  S('2026-10-22T23:00:00Z', 'Thu, Oct 22', '7:00 PM', 'tomorrow'),
  S('2026-10-24T14:00:00Z', 'Sat, Oct 24', '10:00 AM'),
];
const PP = { calendarId: CAL, offer: ALL.slice(0, 2), all: ALL, tz: 'ET' };
const VISIT = [S('2026-10-22T14:00:00Z', 'Thu, Oct 22', '10:00 AM', 'tomorrow'), S('2026-10-22T18:00:00Z', 'Thu, Oct 22', '2:00 PM', 'tomorrow')];
const ONE_LEG = { state_code: 'APPOINTMENT_DISRUPTION.one_leg', attempt_number: 1 };

const out = (text) => ({ direction: 'outbound', text });
const inb = (text) => ({ direction: 'inbound', text });
const plan = (trigger, conversation = [], phonePresentation = PP) => planNepqTurn({
  channel: 'sms', trigger, conversation, slots: VISIT, allSlots: VISIT, tzLabel: 'ET', firstName: 'Pat',
  discipline: { booking: { allowed: true, reason: 'x' } }, nowMs: NOW, knownOpenings: true, phonePresentation,
});

test('only an open one_leg state, a configured calendar and SMS turn the branch on', () => {
  assert.equal(pp.phonePresentationActive({ objectionState: ONE_LEG, env: ENV }), true);
  assert.equal(pp.phonePresentationActive({ objectionState: ONE_LEG, env: {} }), false, 'no calendar → inert');
  assert.equal(pp.phonePresentationActive({ objectionState: ONE_LEG, env: { ...ENV, ONE_LEG_PRESENTATION_MODE: 'off' } }), false);
  assert.equal(pp.phonePresentationActive({ objectionState: { state_code: 'APPOINTMENT_DISRUPTION.no_show' }, env: ENV }), false);
  assert.equal(pp.phonePresentationActive({ objectionState: null, env: ENV }), false);
  assert.equal(pp.phonePresentationActive({ objectionState: ONE_LEG, rehash: true, env: ENV }), false);
  assert.equal(pp.phonePresentationActive({ objectionState: ONE_LEG, postDemo: true, env: ENV }), false);
  assert.equal(pp.phonePresentationActive({ objectionState: ONE_LEG, channel: 'livechat', env: ENV }), false);
});

test('the Phone Presentation calendar is GHL-only (never an LP appointment)', () => {
  const prev = process.env.PHONE_PRESENTATION_CALENDAR_ID;
  process.env.PHONE_PRESENTATION_CALENDAR_ID = CAL;
  try {
    assert.equal(isGhlOnlyCalendarId(CAL), true);
    assert.equal(isGhlOnlyCalendarId('someVisitCalendar'), false);
  } finally {
    if (prev === undefined) delete process.env.PHONE_PRESENTATION_CALENDAR_ID; else process.env.PHONE_PRESENTATION_CALENDAR_ID = prev;
  }
});

test('10a. a 1 Leg contact asking to reschedule gets two real Phone Presentation times, both decision makers named', () => {
  const p = plan('Can we reschedule? My husband had to work.');
  assert.equal(p.step, 'pp_offer');
  assert.equal(p.phone_presentation, true);
  assert.deepEqual(p.slots_to_offer.map((s) => s.iso), PP.offer.map((s) => s.iso));
  assert.match(p.fixed_line, /phone presentation with both of you/);
  assert.match(p.fixed_line, /I have .+ or .+\?/);
  assert.doesNotMatch(p.fixed_line, /\$\s*\d|\d+\s*%/, 'no numbers in a text');
});

test('10b. a pick is HELD until both decision makers are confirmed; then booked on the Phone Presentation calendar', () => {
  const offer = out(pp.PP_LINES.offer(PP.offer));
  const held = plan('Tomorrow at 7 works', [offer]);
  assert.equal(held.step, 'pp_hold_dm');
  assert.equal(held.booking.allowed, false, 'no booking before both are confirmed');
  assert.equal(held.pp_pick, undefined);
  assert.equal(bookingBackedByCode({ plan: held, trigger: 'Tomorrow at 7 works' }), false);
  assert.match(held.fixed_line, /I'm holding .+ for you\. Will both of you be able to be on the call/);

  const conv = [offer, inb('Tomorrow at 7 works'), out(held.fixed_line)];
  const ok = plan('Yes we both can', conv);
  assert.equal(ok.step, 'pp_confirm');
  assert.equal(ok.pp_pick.iso, ALL[1].iso);
  assert.equal(bookingBackedByCode({ plan: ok, trigger: 'Yes we both can' }), true);
  const b = pp.phonePresentationBooking({ slot: ok.pp_pick, calendarId: CAL, env: ENV });
  assert.equal(b.action_payload.calendar_id, CAL);
  assert.equal(b.action_payload.phone_presentation, true);
  assert.equal(b.action_payload.qualifying_data.decision_makers_present, true);
  // The booked call is never a Five9 Callback Request or a promised call.
  for (const line of [ok.reference_line, held.fixed_line, pp.PP_LINES.offer(PP.offer)]) {
    assert.equal(promisedCallback(line), false, line);
    assert.equal(readCallPromise(line).promised, false, line);
  }
});

test('10c. "only me" to the both-of-you ask books nothing and asks for a time that works for both', () => {
  const offer = out(pp.PP_LINES.offer(PP.offer));
  const conv = [offer, inb('Tomorrow at 7'), out(pp.PP_LINES.hold_dm(ALL[1]))];
  const no = plan("No, it'd just be me", conv);
  assert.equal(no.step, 'pp_dm_no');
  assert.equal(no.booking.allowed, false);
  assert.match(no.fixed_line, /both of you/);
});

test('10d. a visit-time plan for a 1 Leg contact becomes the Phone Presentation offer, never home-visit times', () => {
  // "Yes" to the bridge would normally offer visit times.
  const bridge = out('Based on what you told me, the easiest next step is a short phone presentation with both of you on the call. Would that help?');
  const p = plan('Yes', [inb('Hi'), bridge]);
  assert.equal(p.phone_presentation, true);
  assert.ok(!p.slots_to_offer.some((s) => VISIT.some((v) => v.iso === s.iso)), 'no visit time offered');
});

test('10e. a 1 Leg contact with no open Phone Presentation times is never offered visit times either', () => {
  const p = plan('Can we set something up?', [], { calendarId: CAL, offer: [], all: [], tz: 'ET' });
  assert.ok(!(p.slots_to_offer || []).some((s) => VISIT.some((v) => v.iso === s.iso)));
});

test('11. a contact NOT in one_leg saying "my wife isn\'t home" keeps the normal offer (no phone presentation)', () => {
  assert.equal(pp.phonePresentationActive({ objectionState: null, env: ENV }), false);
  const p = plan("My wife isn't home right now, can we set up a time?", [], null);
  assert.notEqual(p.phone_presentation, true);
  assert.ok(!String(p.step).startsWith('pp_'));
  assert.doesNotMatch(String(p.fixed_line || ''), /phone presentation/i);
});

test('12. S5.2 one_leg regression: still gated into the S5.2 workflow; the webhook policy read never reads recovery_cadence', () => {
  assert.equal(gate.isGatedState('APPOINTMENT_DISRUPTION.one_leg'), true);
  assert.equal(gate.isS52Target({ workflow_id: '0a6a1349-0b44-429b-91e1-4c5be264cd9f' }), true);
  const src = fs.readFileSync(new URL('../src/actions/handlers/objection-state.js', import.meta.url), 'utf8');
  const select = src.match(/from\('objection_state_policies'\)\s*\.select\('([^']+)'\)/)?.[1] || '';
  assert.ok(select.includes('recovery_workflow_id') && select.includes('recovery_webhook_url'));
  assert.ok(!select.includes('recovery_cadence'), 'recovery_cadence stays informational');
  // Nothing under src/ reads recovery_cadence, so the cadence update cannot change a send.
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []));
  const readers = walk(new URL('../src', import.meta.url).pathname).filter((f) => /recovery_cadence|recoveryCadence/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(readers, []);
  // The phone presentation module never sends or enrolls: no sender, no workflow.
  const mod = fs.readFileSync(new URL('../src/agentic/one-leg-presentation.js', import.meta.url), 'utf8');
  assert.doesNotMatch(mod, /add_to_workflow|send_message|sendSms|postToSlack|assignedTo/);
});
