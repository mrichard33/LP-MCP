/**
 * Market time zone — scripts/test-bot-market-timezone.js
 *
 * 2026-10-12 (handoff "Lead Conversation Stage", PR 4; batch 2 #2): a Katy,
 * TX lead (zip 77494, market HOU, Central) was offered "10:00 AM ET / Wed
 * 6:00 PM ET". The zone came only from the contact record's zip; a zip typed
 * in the conversation never reached the slot read. Every slot is now shown
 * and labelled in the market's zone from the zip the lead typed (the record's
 * otherwise), on both bots. No per-zip hardcoding: the zone comes from
 * service_area_zips.market_code → src/config/market-timezones.js.
 * Time math is checked across both DST changes (house rule).
 *
 * Run: node --test scripts/test-bot-market-timezone.js
 */
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const TZ = await import('../src/services/contact-timezone.js');
const { parseSlots } = await import('../src/knowledge/calendar-availability.js');
const { LINES } = await import('../src/agentic/nepq-planner.js');
const { tzLabel, marketTimezone } = await import('../src/config/market-timezones.js');

const ZIPS = {
  77494: { checked: true, zip: '77494', in_service_area: true, market_code: 'HOU' },
  33908: { checked: true, zip: '33908', in_service_area: true, market_code: 'FTMYR' },
  10001: { checked: true, zip: '10001', in_service_area: false },
};
const lookup = async (zip) => ZIPS[zip] || { checked: true, zip, in_service_area: false };
const thread = (...xs) => xs.map(([d, t]) => ({ direction: d === 'o' ? 'outbound' : 'inbound', text: t }));

test('the zip the lead typed, newest first, in every form', () => {
  assert.equal(TZ.typedZipFromThread(thread(['i', 'do you serve 77494?']), ''), null, 'a zip inside a question is the coverage turn\'s');
  assert.equal(TZ.typedZipFromThread(thread(['o', "What's your zip code?"], ['i', '77494'])), '77494');
  assert.equal(TZ.typedZipFromThread([], 'my zip is 77494'), '77494');
  assert.equal(TZ.typedZipFromThread([], '123 Main St, Katy TX 77494'), '77494');
  assert.equal(TZ.typedZipFromThread(thread(['i', '33908'], ['i', 'sorry, 77494'])), '77494', 'a correction counts');
  assert.equal(TZ.typedZipFromThread(thread(['i', '33908'], ['i', '77494'])), '77494', 'the newest wins');
  assert.equal(TZ.typedZipFromThread(thread(['i', 'I have 12 windows'])), null);
});

test('the typed zip wins over the record; Houston is Central; unknown is Eastern', async () => {
  TZ.__resetContactTimezoneCacheForTest();
  const hou = await TZ.zoneForContact({ typedZip: '77494', recordZip: '33908' }, { lookup });
  assert.deepEqual({ tz: hou.timezone, label: hou.label, market: hou.market_code, zip: hou.zip }, { tz: 'America/Chicago', label: 'CT', market: 'HOU', zip: '77494' });
  const rec = await TZ.zoneForContact({ typedZip: null, recordZip: '33908' }, { lookup });
  assert.equal(rec.label, 'ET');
  const out = await TZ.zoneForContact({ typedZip: '10001' }, { lookup });
  assert.equal(out.label, 'ET', 'out of area is never a market zone');
  assert.equal(out.market_code, null);
  const down = await TZ.zoneForContact({ typedZip: '77001' }, { lookup: async () => { throw new Error('db down'); } });
  assert.equal(down.label, 'ET', 'a failed read falls back to Eastern');
  assert.equal(marketTimezone('hou'), 'America/Chicago');
  assert.equal(tzLabel('America/Chicago'), 'CT');
});

// One raw GHL opening, read in a zone. A call calendar id: no visit-hour filter.
const read = (iso, timezone) => parseSlots({ d: { slots: [iso] } }, 'call-cal', timezone, 10, 0, null, Date.parse('2026-01-01T00:00:00Z')).slots[0];

test('the same opening reads an hour earlier in Central, before and after DST ends (2026-11-01)', () => {
  // Friday Oct 30, 15:00Z: CDT (UTC-5) 10 AM, EDT (UTC-4) 11 AM.
  assert.equal(read('2026-10-30T15:00:00Z', 'America/Chicago').time, '10:00 AM');
  assert.equal(read('2026-10-30T15:00:00Z', 'America/New_York').time, '11:00 AM');
  // Monday Nov 2, 16:00Z: CST (UTC-6) 10 AM, EST (UTC-5) 11 AM.
  assert.equal(read('2026-11-02T16:00:00Z', 'America/Chicago').time, '10:00 AM');
  assert.equal(read('2026-11-02T16:00:00Z', 'America/New_York').time, '11:00 AM');
  assert.equal(read('2026-11-02T16:00:00Z', 'America/Chicago').day, 'Mon, Nov 2');
});

test('…and across the spring change (2027-03-14), and across midnight', () => {
  // Tuesday Mar 16, 2027, 15:00Z: CDT 10 AM, EDT 11 AM.
  assert.equal(read('2027-03-16T15:00:00Z', 'America/Chicago').time, '10:00 AM');
  assert.equal(read('2027-03-16T15:00:00Z', 'America/New_York').time, '11:00 AM');
  // 04:30Z on Nov 3: still Nov 2 in Central (10:30 PM), Nov 2 in Eastern (11:30 PM).
  assert.equal(read('2026-11-03T04:30:00Z', 'America/Chicago').day, 'Mon, Nov 2');
  // 05:30Z on Nov 3: Nov 2 11:30 PM Central, Nov 3 12:30 AM Eastern.
  assert.equal(read('2026-11-03T05:30:00Z', 'America/Chicago').day, 'Mon, Nov 2');
  assert.equal(read('2026-11-03T05:30:00Z', 'America/New_York').day, 'Tue, Nov 3');
});

test('the offer line carries the market label', () => {
  const s = [read('2026-11-02T16:00:00Z', 'America/Chicago'), read('2026-11-03T20:00:00Z', 'America/Chicago')].map(x => ({ ...x, tz: 'CT' }));
  const line = LINES.offer_slots(s, 0);
  assert.match(line, /10:00 AM CT/);
  assert.doesNotMatch(line, /\bET\b/);
});
