// Houston contacts read Central time; everyone else stays Eastern
// (Mark's ruling 3, 2026-10-01). Pure helpers plus the rendering sites.

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { marketTimezone, tzLabel, tzLongName, normalizeTimezone, DEFAULT_TIMEZONE } = await import('../src/config/market-timezones.js');
const { timezoneForZip, zoneForServiceArea, __resetContactTimezoneCacheForTest } = await import('../src/services/contact-timezone.js');
const { formatSlotsForPrompt } = await import('../src/knowledge/calendar-availability.js');
const { formatStartTimeForPrompt, formatAppointmentsForPrompt } = await import('../src/knowledge/contact-appointments.js');
const { isInQuietHours, nextSendWindowOpenAt } = await import('../src/services/quiet-hours.js');
const { wallClockToIso, formatTimeHuman, tzOffsetMinutes, etOffsetMinutes } = await import('../src/appointment-dates.js');
const { promptTimezoneFor } = await import('../src/response-generator.js');

test('market map: HOU is Central, everything else (and nothing) is Eastern', () => {
  assert.equal(marketTimezone('HOU'), 'America/Chicago');
  assert.equal(marketTimezone('hou'), 'America/Chicago');
  for (const code of ['ORL', 'JAX', 'WSNC', 'GENERAL', '', null, undefined]) assert.equal(marketTimezone(code), DEFAULT_TIMEZONE);
  assert.equal(tzLabel('America/Chicago'), 'CT');
  assert.equal(tzLabel('America/New_York'), 'ET');
  assert.equal(tzLabel('Europe/Paris'), 'ET', 'an unknown zone is never printed raw');
  assert.equal(tzLongName('America/Chicago'), 'Central');
  assert.equal(normalizeTimezone('Mars/Base'), DEFAULT_TIMEZONE);
});

test('timezoneForZip: lookup → zone, cached; a failed lookup is Eastern and not cached', async () => {
  __resetContactTimezoneCacheForTest();
  let calls = 0;
  const lookup = async (z) => { calls++; return z === '77002' ? { checked: true, in_service_area: true, market_code: 'HOU' } : { checked: true, in_service_area: true, market_code: 'ORL' }; };
  assert.deepEqual(await timezoneForZip('77002', { lookup }), { timezone: 'America/Chicago', label: 'CT', market_code: 'HOU' });
  await timezoneForZip('77002', { lookup });
  assert.equal(calls, 1, 'second read is cached');
  assert.equal((await timezoneForZip('32801', { lookup })).label, 'ET');
  let failing = 0;
  const broken = async () => { failing++; return { checked: false }; };
  assert.equal((await timezoneForZip('75233', { lookup: broken })).timezone, DEFAULT_TIMEZONE);
  await timezoneForZip('75233', { lookup: broken });
  assert.equal(failing, 2, '"could not tell" is asked again next time');
  assert.equal((await timezoneForZip(null, { lookup })).timezone, DEFAULT_TIMEZONE);
  assert.equal(zoneForServiceArea({ in_service_area: false }).market_code, null);
});

// 15:00 UTC on 2026-10-06 = 11:00 AM EDT = 10:00 AM CDT
const SLOT = '2026-10-06T15:00:00.000Z';
const slotsIn = (tz) => ({
  calendar_id: 'cal1', timezone: tz, slots_total_count: 1,
  slots: [{ iso: SLOT, day: new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(SLOT)), time: new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(SLOT)) }],
});

test('slot offers: a HOU contact sees Central with "CT"; an ORL contact sees Eastern with "ET"', () => {
  const hou = formatSlotsForPrompt(slotsIn('America/Chicago'));
  assert.match(hou, /Timezone: America\/Chicago \(CT\)/);
  assert.match(hou, /10:00\sAM CT/);
  const orl = formatSlotsForPrompt(slotsIn('America/New_York'));
  assert.match(orl, /Timezone: America\/New_York \(ET\)/);
  assert.match(orl, /11:00\sAM ET/);
});

test('appointment text: HOU renders CT, ORL renders ET', () => {
  assert.match(formatStartTimeForPrompt(SLOT, 'America/Chicago'), /10:00\sAM CT$/);
  assert.match(formatStartTimeForPrompt(SLOT), /11:00\sAM ET$/);
  const appts = [{ appointment_id: 'a1', calendar_name: 'MV', start_time: SLOT, start_time_human: formatStartTimeForPrompt(SLOT), status: 'new' }];
  assert.match(formatAppointmentsForPrompt(appts, { timeZone: 'America/Chicago' }), /10:00\sAM CT/);
  assert.match(formatAppointmentsForPrompt(appts), /11:00\sAM ET/, 'no zone → the ET text from fetch time, unchanged');
  assert.equal(formatTimeHuman(new Date(SLOT), 'America/Chicago'), '10:00 AM');
});

test('the prompt zone follows the contact market, else the process zone', () => {
  assert.equal(promptTimezoneFor({ market: { market_code: 'HOU', timezone: 'America/Chicago' } }), 'America/Chicago');
  assert.equal(promptTimezoneFor({ market: { market_code: 'ORL', timezone: 'America/New_York' } }), 'America/New_York');
  assert.equal(promptTimezoneFor({ market: { market_code: null, timezone: 'America/Chicago' } }), 'America/New_York');
  assert.equal(promptTimezoneFor({}), 'America/New_York');
});

test('quiet hours for a HOU contact are Chicago 9 PM–8 AM', () => {
  // 12:30 UTC on 2026-10-06 = 8:30 AM EDT = 7:30 AM CDT
  const t = new Date('2026-10-06T12:30:00Z');
  assert.equal(isInQuietHours(t), false, 'open in Eastern');
  assert.equal(isInQuietHours(t, { timeZone: 'America/Chicago' }), true, 'still quiet in Houston');
  assert.equal(nextSendWindowOpenAt(t, { timeZone: 'America/Chicago' }), '2026-10-06T13:00:00.000Z', '8:00 AM CDT');
  // 01:30 UTC on 2026-10-07 = 9:30 PM EDT = 8:30 PM CDT
  const evening = new Date('2026-10-07T01:30:00Z');
  assert.equal(isInQuietHours(evening), true);
  assert.equal(isInQuietHours(evening, { timeZone: 'America/Chicago' }), false);
});

test('wallClockToIso uses the real offset: CDT, CST, EDT, EST', () => {
  assert.equal(wallClockToIso('2026-10-06', '14:00', 'America/Chicago'), '2026-10-06T14:00:00-05:00');
  assert.equal(wallClockToIso('2026-12-03', '14:00', 'America/Chicago'), '2026-12-03T14:00:00-06:00');
  assert.equal(wallClockToIso('2026-10-06', '14:00'), '2026-10-06T14:00:00-04:00');
  assert.equal(wallClockToIso('2026-12-03', '14:00'), '2026-12-03T14:00:00-05:00', 'the old fixed -04:00 was wrong all winter');
  assert.equal(wallClockToIso('12/03/2026', '14:00'), null);
  assert.equal(tzOffsetMinutes(new Date('2026-07-01T12:00:00Z'), 'America/Chicago'), -300);
  assert.equal(etOffsetMinutes(new Date('2026-01-15T12:00:00Z')), -300);
});
