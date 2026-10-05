/**
 * Regression lock for the unissued-inbound defer gate.
 * Motivating incident: contact 3IfrsqGrV3qJtId9RGXk — inbound rows 423064
 * (no appt) and 423079 (appt), same lognumber, both unissued.
 *
 * Run: node scripts/test-lp-inbound-defer.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { findUnissuedInboundRow, inboundDeferMode, inboundDeferMaxAgeMin,
         inboundDeferDecision, heldInboundEscalation, apptStartMsET,
         formatHeldInboundCard, escalateHeldInbound, firstHoldForRow }
  from '../src/lp-appointment-sync.js';
import { isTeamOpen } from '../src/agentic/team-hours.js';
import { lpStoredAgeMinutes, utcToLpStoredIso } from '../src/lp-dates.js';

const stub = (rows) => ({ getInboundLeadInfo: async () => rows });
// LP `datereceived` is ET wall-clock with no offset. utcToLpStoredIso() is the
// repo's own inverse of lpStoredAgeMinutes, so this builds a row N minutes old
// regardless of the host's clock — a dev box in ET must not change the result.
const etStamp = (minsAgo) =>
  utcToLpStoredIso(Date.now() - minsAgo * 60000).replace('+00:00', '');
const HOST_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

test('empty queue → null (enroll proceeds unchanged)', async () => {
  assert.equal(await findUnissuedInboundRow('C1', stub([])), null);
});

test('every row already issued → null (resolver owns it)', async () => {
  const rows = [{ id: '423064', lds_id: '573111', datereceived: etStamp(5) }];
  assert.equal(await findUnissuedInboundRow('C1', stub(rows)), null);
});

test('fresh unissued row → returned with age and in1_id', async () => {
  const rows = [{ id: '423064', lds_id: '', apptdate: '', datereceived: etStamp(20) }];
  const hit = await findUnissuedInboundRow('C1', stub(rows));
  assert.equal(hit.inboundId, '423064');
  assert.equal(hit.hasAppt, false);
  assert.ok(hit.ageMin >= 19 && hit.ageMin <= 21, `ageMin was ${hit.ageMin}`);
});

test('age uses the ET frame, not bare Date.parse', () => {
  // The bug this guards: bare Date.parse on an offset-less ET string reads
  // ~240 min older than reality and would trip the stale branch immediately.
  const stamp = etStamp(20);
  assert.ok(Math.abs(lpStoredAgeMinutes(stamp) - 20) <= 2);
  if (HOST_TZ !== 'America/New_York') {
    assert.ok(Math.abs((Date.now() - Date.parse(stamp)) / 60000 - 20) > 100);
  }
});

test('youngest unissued row wins when several are pending', async () => {
  const rows = [
    { id: '423064', lds_id: '', datereceived: etStamp(150) },
    { id: '423079', lds_id: '', datereceived: etStamp(10) },
  ];
  assert.equal((await findUnissuedInboundRow('C1', stub(rows))).inboundId, '423079');
});

test('LP read throws → null (FAILS OPEN, never blocks creation)', async () => {
  const boom = { getInboundLeadInfo: async () => { throw new Error('LP 503'); } };
  assert.equal(await findUnissuedInboundRow('C1', boom), null);
});

test('envelope shapes: bare array, {data}, {leads}', async () => {
  const row = [{ id: '1', lds_id: '', datereceived: etStamp(5) }];
  for (const env of [row, { data: row }, { leads: row }]) {
    assert.equal((await findUnissuedInboundRow('C1', stub(env))).inboundId, '1');
  }
});

test('mode defaults to shadow; unknown values fall back to shadow', () => {
  delete process.env.LP_INBOUND_DEFER_MODE;
  assert.equal(inboundDeferMode(), 'shadow');
  process.env.LP_INBOUND_DEFER_MODE = 'banana';
  assert.equal(inboundDeferMode(), 'shadow');
  for (const m of ['off', 'shadow', 'on']) {
    process.env.LP_INBOUND_DEFER_MODE = m;
    assert.equal(inboundDeferMode(), m);
  }
  delete process.env.LP_INBOUND_DEFER_MODE;
});

test('max age defaults to 360 and floors at 30', () => {
  delete process.env.LP_INBOUND_DEFER_MAX_AGE_MIN;
  assert.equal(inboundDeferMaxAgeMin(), 360);
  process.env.LP_INBOUND_DEFER_MAX_AGE_MIN = '5';
  assert.equal(inboundDeferMaxAgeMin(), 30);
  delete process.env.LP_INBOUND_DEFER_MAX_AGE_MIN;
});

// ─── Stale decision (2026-09-15) ────────────────────────────────
// Found by the shadow window: contact pbTY7u8gVQcXv9fMm58g, in1_id 423860 sat
// unissued 9+ hours WITH apptdate 09/15/2026 2:00 PM already on it. The old
// rule fell through at 360 min and would have minted a fourth inbound row for
// a person who already had three.

const D = (ageMin, hasAppt, maxAgeMin = 360) =>
  inboundDeferDecision({ ageMin, hasAppt, maxAgeMin });

test('fresh row defers whether or not it carries an appointment', () => {
  assert.equal(D(30, false), 'defer');
  assert.equal(D(30, true), 'defer');
  assert.equal(D(360, true), 'defer');   // boundary: equal is NOT stale
  assert.equal(D(360, false), 'defer');
});

test('stale row WITH the appointment holds — never mints a duplicate', () => {
  assert.equal(D(361, true), 'hold_stale_holds_appt');
  assert.equal(D(549, true), 'hold_stale_holds_appt');  // the live 423860 age
});

test('stale row WITHOUT an appointment still falls through', () => {
  // The one case where the duplicate is earned: nothing in LP holds the appt,
  // so waiting really can lose it.
  assert.equal(D(361, false), 'fall_through_stale');
  assert.equal(D(5000, false), 'fall_through_stale');
});

test('unknown age is never stale (fail-open, not "stuck")', () => {
  assert.equal(D(null, true), 'defer');
  assert.equal(D(null, false), 'defer');
  assert.equal(D(undefined, false), 'defer');
});

test('a lowered max age moves the boundary but not the hasAppt rule', () => {
  assert.equal(D(45, true, 30), 'hold_stale_holds_appt');
  assert.equal(D(45, false, 30), 'fall_through_stale');
  assert.equal(D(20, false, 30), 'defer');
});

// ─── Held-row escalation (2026-10-05, contact LgCeHyniTQPfrnT4Ga7j, row 428372) ──
// The chatbot booked Mon 10/5 2:00 PM on Sun 10/4 7:36 PM ET. The row reached LP
// with the appointment, LP did not import it, and the only card would have fired
// at ~1:36 AM. These lock "tell a person in team hours, once, when a visit within
// a day is waiting".

const APPT_MON_2PM = apptStartMsET('2026-10-05', '14:00');
const MON_9AM_ET = Date.parse('2026-10-05T13:00:00Z');   // 9:00 AM EDT
const SUN_11PM_ET = Date.parse('2026-10-05T03:00:00Z');  // Sun 11:00 PM EDT
const E = (o) => heldInboundEscalation({ maxAgeMin: 360, teamOpen: isTeamOpen(o.nowMs), ...o });

test('ET appointment converts to the real instant (2:00 PM EDT = 18:00Z)', () => {
  assert.equal(new Date(APPT_MON_2PM).toISOString(), '2026-10-05T18:00:00.000Z');
  assert.equal(apptStartMsET(null, '14:00'), null);
});

test('visit tomorrow + row 40 min old + 9 AM ET → escalate', () => {
  assert.equal(isTeamOpen(MON_9AM_ET), true);
  assert.equal(E({ ageMin: 40, apptStartMs: APPT_MON_2PM, nowMs: MON_9AM_ET }), 'escalate');
});

test('same row at 11 PM ET → waits for team hours (the 428372 night)', () => {
  assert.equal(isTeamOpen(SUN_11PM_ET), false);
  assert.equal(E({ ageMin: 87, apptStartMs: APPT_MON_2PM, nowMs: SUN_11PM_ET }), 'wait_for_team');
});

test('visit next week + row 40 min old → nothing yet', () => {
  const nextWeek = apptStartMsET('2026-10-12', '14:00');
  assert.equal(E({ ageMin: 40, apptStartMs: nextWeek, nowMs: MON_9AM_ET }), 'none');
});

test('row younger than 30 min → nothing yet, even for a visit today', () => {
  assert.equal(E({ ageMin: 10, apptStartMs: APPT_MON_2PM, nowMs: MON_9AM_ET }), 'none');
});

test('stale row still escalates whatever the visit date; unknown age never does', () => {
  const nextWeek = apptStartMsET('2026-10-12', '14:00');
  assert.equal(E({ ageMin: 400, apptStartMs: nextWeek, nowMs: MON_9AM_ET }), 'escalate');
  assert.equal(E({ ageMin: 400, apptStartMs: null, nowMs: MON_9AM_ET }), 'escalate');
  assert.equal(E({ ageMin: null, apptStartMs: APPT_MON_2PM, nowMs: MON_9AM_ET }), 'none');
});

test('card names the row, the visit, and what is blank — plain English', () => {
  const card = formatHeldInboundCard({
    pending: { inboundId: '428372', ageMin: 840, hasAppt: true, firstName: 'Daniel', lastName: '',
               phone: '(239)250-0011', address1: '3418 Westclox St', email: '', branch: 'FTMYR' },
    address: '3418 Westclox St, Immokalee, FL 34142',
    apptStartMs: APPT_MON_2PM, calendarName: 'Window Estimate', contactId: 'LgCeHyniTQPfrnT4Ga7j',
  });
  assert.match(card, /inbound row 428372/);
  assert.match(card, /Daniel · \(239\)250-0011/);
  assert.match(card, /3418 Westclox St, Immokalee, FL 34142/);
  assert.match(card, /Window Estimate: Mon, 10\/5, 2:00 PM ET/);
  assert.match(card, /Blank on the row: last name, email/);
  assert.match(card, /already on the row/);
});

// In-memory audit_posted_items stand-in with the real filterNew/recordPosted contract.
function postedStore() {
  const seen = new Set();
  return {
    filterNew: async ({ items }) => ({ fresh: items.filter((i) => !seen.has(`${i.key}|${i.reason}`)), dedupe: 'ok' }),
    recordPosted: async ({ items }) => { items.forEach((i) => seen.add(`${i.key}|${i.reason}`)); return { ok: true }; },
  };
}

test('card posts to #contact-center ONCE per row across re-drives', async () => {
  const posts = [];
  const deps = { ...postedStore(), env: { SLACK_CHANNEL_SERVICE: 'CCENTER' },
    postToSlack: async (text, ch) => { posts.push(ch); return { ok: true, ts: '1' }; },
    sendAlertMessage: async () => { throw new Error('should not page ops'); } };
  assert.equal((await escalateHeldInbound('card', '428372', deps)).posted, true);
  assert.equal((await escalateHeldInbound('card', '428372', deps)).reason, 'already_posted');
  assert.deepEqual(posts, ['CCENTER']);
});

test('failed or unconfigured post → one ops line, not recorded, retried next re-drive', async () => {
  const ops = [];
  let ok = false;
  const deps = { ...postedStore(), env: { SLACK_CHANNEL_SERVICE: 'CCENTER' },
    postToSlack: async () => (ok ? { ok: true } : { ok: false, error: 'channel_not_found' }),
    sendAlertMessage: async (text, opts) => { ops.push(opts.channel); return { sent: true }; } };
  assert.equal((await escalateHeldInbound('card', '428372', deps)).reason, 'post_failed');
  ok = true;
  assert.equal((await escalateHeldInbound('card', '428372', deps)).posted, true);
  assert.deepEqual(ops, ['ops']);

  const unset = { ...postedStore(), env: {}, postToSlack: async () => { throw new Error('no'); },
    sendAlertMessage: async (t, o) => { ops.push(o.channel); return { sent: true }; } };
  assert.equal((await escalateHeldInbound('card', '1', unset)).error, 'SLACK_CHANNEL_SERVICE unset');
});

test('GHL hold note is written once per row, not every 30 minutes', async () => {
  const deps = postedStore();
  assert.equal(await firstHoldForRow('428372', deps), true);
  assert.equal(await firstHoldForRow('428372', deps), false);
  assert.equal(await firstHoldForRow('999999', deps), true);
});
