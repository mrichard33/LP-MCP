/**
 * scripts/test-canvass-backstop.js
 *
 * Offline coverage for the canvass lead backstop (src/canvass-lead-backstop.js,
 * src/jobs/canvass-lead-backstop.js) and the capped pre-check on
 * POST /webhooks/canvassing-lead.
 *
 * What these guard, in order of cost if broken:
 *   - a lead whose webhook DID arrive (any canvassing_intake_marks row) is never re-sent,
 *   - a contact is attempted at most once, and a failed read sends nobody,
 *   - the rebuilt payload passes the webhook's own validator with the canvass fields,
 *   - shadow sends nothing,
 *   - a hung mark pre-check cannot hold GHL past its 60s timeout.
 *
 * Run: node --test scripts/test-canvass-backstop.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  selectCanvassLeads, buildCanvassCandidatesSql, buildPayloadFromContact, liveHasLpId,
  backstopMode, etMiddleEndian, markKey, CF, MAX_PER_PASS,
} from '../src/canvass-lead-backstop.js';
import { runCanvassLeadBackstop } from '../src/jobs/canvass-lead-backstop.js';
import { validateCanvassingPayload, withTimeout } from '../src/canvassing-lead-handler.js';

const NOW = Date.parse('2026-09-28T16:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();

const row = (id, over = {}) => ({
  ghl_contact_id: id, first_name: 'Pat', last_name: 'Lee',
  phone: `912555${String(1000 + Number(String(id).replace(/\D/g, '') || 0)).slice(-4)}`,
  tags: ['entry:canvassing', 'canvass-v2'], date_added: hoursAgo(3), ...over,
});

const liveContact = (id, over = {}) => ({
  id, firstName: 'Curtis', lastName: 'White', phone: '+19126708267', email: '',
  address1: '12 Oak St', city: 'Waycross', state: 'Georgia', postalCode: '31501',
  dateAdded: '2026-09-24T20:32:53.537Z',
  customFields: [
    { id: CF.PRO_ID, value: 6095 },
    { id: CF.SRS_ID, value: '344' },
    { id: CF.PROMOTER, value: 'Joseph Philson' },
    { id: CF.WINDOWS, value: 12 },
    { id: CF.APPT_DATE, value: '2026-09-30' },
    { id: CF.APPT_TIME, value: '10:00 AM' },
    { id: CF.UTM_SOURCE, value: 'canvassing' },
    { id: CF.UTM_MEDIUM, value: 'field' },
  ],
  ...over,
});

test('selection: window, webhook-arrived, already tried, in LP, exclusions', () => {
  const rows = [
    row('c1'),
    row('c2', { date_added: new Date(NOW - 10 * 60_000).toISOString() }), // 10 min: may still be in flight
    row('c3', { date_added: hoursAgo(24 * 8) }),                          // past the week
    row('c4'),                                                             // webhook arrived
    row('c5'),                                                             // already tried
    row('c6'),                                                             // phone in LP
    row('c7', { tags: ['canvass-v2', 'contact:delete'] }),
    row('c8', { tags: ['entry:canvassing'] }),                             // not a canvass-v2 contact
    row('c9', { phone: '12' }),
  ];
  const { send, skipped } = selectCanvassLeads(rows, {
    lpPhones: new Set(['9125551006']), arrived: new Set(['c4']), tried: new Set(['c5']), nowMs: NOW,
  });
  assert.deepEqual(send.map((r) => r.ghl_contact_id), ['c1']);
  assert.equal(skipped.too_new, 1);
  assert.equal(skipped.too_old, 1);
  assert.equal(skipped.webhook_arrived, 1);
  assert.equal(skipped.already_tried, 1);
  assert.equal(skipped.in_lp, 1);
  assert.equal(skipped.excluded, 1);
  assert.equal(skipped.not_canvass, 1);
  assert.equal(skipped.no_phone, 1);
});

test('selection: capped per pass', () => {
  const rows = Array.from({ length: MAX_PER_PASS + 3 }, (_, i) => row(`c${i}`, { phone: `91255${String(10000 + i)}` }));
  const { send, skipped } = selectCanvassLeads(rows, { lpPhones: new Set(), arrived: new Set(), tried: new Set(), nowMs: NOW });
  assert.equal(send.length, MAX_PER_PASS);
  assert.equal(skipped.over_cap, 3);
});

test('SQL reads canvass-v2 contacts with no LP id and no exclusion tag', () => {
  const sql = buildCanvassCandidatesSql({ sinceIso: hoursAgo(168), untilIso: hoursAgo(0.5) });
  assert.match(sql, /'canvass-v2' = ANY/);
  assert.match(sql, /'GmAVmW6V9sekD7pVONKr'/);
  assert.match(sql, /'suppress-outbound'/);
});

test('rebuilt payload passes the webhook validator with the canvass fields', () => {
  const body = buildPayloadFromContact(liveContact('KnK1IRjLAewdmraA4T1k'));
  const v = validateCanvassingPayload(body);
  assert.equal(v.ok, true, v.errors.join('; '));
  const p = v.normalized;
  assert.equal(p.canvass_version, 'v2');
  assert.equal(p.ghl_contact_id, 'KnK1IRjLAewdmraA4T1k');
  assert.equal(p.pro_id, '6095');
  assert.equal(p.srs_id, '344');
  assert.equal(p.appt_date, '2026-09-30');
  assert.equal(p.appt_slot, '10:00 AM');
  assert.equal(p.window_count, '12');
  assert.equal(p.state, 'GA');
  assert.equal(p.zip, '31501');
  assert.equal(p.utm.source, 'canvassing');
  assert.equal(p.utm.campaign, 'Joseph Philson');
  // Consent is the day the form was submitted (ET), not the day of the re-send.
  assert.equal(p.consent_date, '9/24/2026');
  assert.equal(p.slider_count, '', 'slider count is deliberately not guessed');
});

test('a lead with no appointment still builds a valid payload', () => {
  const c = liveContact('x', { customFields: [{ id: CF.PRO_ID, value: 6095 }] });
  const v = validateCanvassingPayload(buildPayloadFromContact(c));
  assert.equal(v.ok, true);
  assert.equal(v.normalized.appt_date, '');
  assert.equal(v.normalized.srs_id, '344', 'door-knock default when the field is blank');
  assert.equal(v.normalized.utm.source, 'canvassing');
});

test('liveHasLpId reads the live LP id fields', () => {
  assert.equal(liveHasLpId(liveContact('x')), false);
  assert.equal(liveHasLpId(liveContact('x', { customFields: [{ id: '3YMxheIlPyhACB8zyc3W', value: '426918' }] })), true);
  assert.equal(liveHasLpId(liveContact('x', { customFields: [{ id: 'GmAVmW6V9sekD7pVONKr', value: '' }] })), false);
});

test('mode defaults to shadow; ET date helper', () => {
  assert.equal(backstopMode({}), 'shadow');
  assert.equal(backstopMode({ CANVASS_BACKSTOP_MODE: 'LIVE' }), 'live');
  assert.equal(backstopMode({ CANVASS_BACKSTOP_MODE: 'junk' }), 'shadow');
  assert.equal(etMiddleEndian(Date.parse('2026-09-25T02:00:00Z')), '9/24/2026'); // 22:00 ET the day before
});

// --- the pass --------------------------------------------------------------

function stubDeps({ candidates = [row('c1'), row('c2')], arrived = [], tried = [], hlFails = false, marksFail = false, live = {}, outcome = 'ok' } = {}) {
  const calls = { process: [], marks: [], sends: [], reads: [] };
  const supabase = {
    from(table) {
      return {
        select: () => ({
          in: async (_col, keys) => {
            if (marksFail) return { data: null, error: { message: 'boom' } };
            const have = table === 'canvassing_intake_marks' ? arrived : tried.map(markKey);
            return { data: keys.filter((k) => have.includes(k)).map((k) => ({ dedup_key: k })), error: null };
          },
        }),
        upsert: async (r) => { assert.equal(table, 'lp_appointment_sync_marks'); calls.marks.push(r.dedup_key); return { error: null }; },
      };
    },
  };
  return {
    calls,
    deps: {
      hlRunSQL: async () => { if (hlFails) throw new Error('hl down'); return candidates; },
      runSQL: async () => [],
      supabase,
      getContact: async (id) => { calls.reads.push(id); return id in live ? live[id] : liveContact(id); },
      validate: validateCanvassingPayload,
      process: async (p) => { calls.process.push(p.ghl_contact_id); return { outcome, in1_id: '999' }; },
      send: async (text, opts) => { calls.sends.push({ text, opts }); },
    },
  };
}

test('live: re-sends through the webhook pipeline, marks each attempt, one ops card', async () => {
  const { deps, calls } = stubDeps();
  const r = await runCanvassLeadBackstop({ env: { CANVASS_BACKSTOP_MODE: 'live' }, nowMs: NOW, deps });
  assert.equal(r.ok, true);
  assert.equal(r.sent, 2);
  assert.deepEqual(calls.process, ['c1', 'c2']);
  assert.deepEqual(calls.marks, ['canvass-backstop:c1', 'canvass-backstop:c2']);
  assert.equal(calls.sends.length, 1);
  assert.equal(calls.sends[0].opts.channel, 'ops');
  assert.match(calls.sends[0].text, /re-sent to LP: 2/);
});

test('live: a webhook that arrived, or an earlier attempt, is never re-sent', async () => {
  const { deps, calls } = stubDeps({ arrived: ['c1'], tried: ['c2'] });
  const r = await runCanvassLeadBackstop({ env: { CANVASS_BACKSTOP_MODE: 'live' }, nowMs: NOW, deps });
  assert.equal(calls.process.length, 0);
  assert.equal(r.skipped.webhook_arrived, 1);
  assert.equal(r.skipped.already_tried, 1);
  assert.equal(calls.sends.length, 0);
});

test('live: a contact that got an LP id since the mirror read is skipped', async () => {
  const { deps, calls } = stubDeps({ live: { c1: liveContact('c1', { customFields: [{ id: '3YMxheIlPyhACB8zyc3W', value: '1' }] }) } });
  const r = await runCanvassLeadBackstop({ env: { CANVASS_BACKSTOP_MODE: 'live' }, nowMs: NOW, deps });
  assert.deepEqual(calls.process, ['c2']);
  assert.equal(r.live_has_lp, 1);
  assert.deepEqual(calls.marks, ['canvass-backstop:c2']);
});

test('live: an unreadable live contact is not posted and not marked', async () => {
  const { deps, calls } = stubDeps({ live: { c1: null } });
  const r = await runCanvassLeadBackstop({ env: { CANVASS_BACKSTOP_MODE: 'live' }, nowMs: NOW, deps });
  assert.deepEqual(calls.process, ['c2']);
  assert.equal(r.failed, 1);
  assert.deepEqual(calls.marks, ['canvass-backstop:c2']);
  assert.match(calls.sends[0].text, /Not sent: 1/);
});

test('live: an LP failure is marked (one attempt) and reported', async () => {
  const { deps, calls } = stubDeps({ candidates: [row('c1')], outcome: 'lp_failed' });
  const r = await runCanvassLeadBackstop({ env: { CANVASS_BACKSTOP_MODE: 'live' }, nowMs: NOW, deps });
  assert.equal(r.ok, false);
  assert.equal(r.failed, 1);
  assert.deepEqual(calls.marks, ['canvass-backstop:c1']);
});

test('a failed read sends nobody', async () => {
  for (const over of [{ hlFails: true }, { marksFail: true }]) {
    const { deps, calls } = stubDeps(over);
    const r = await runCanvassLeadBackstop({ env: { CANVASS_BACKSTOP_MODE: 'live' }, nowMs: NOW, deps });
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /^read: /);
    assert.equal(calls.process.length + calls.sends.length + calls.reads.length, 0);
  }
});

test('shadow: decides, touches nothing', async () => {
  const { deps, calls } = stubDeps();
  const r = await runCanvassLeadBackstop({ env: {}, nowMs: NOW, deps });
  assert.equal(r.mode, 'shadow');
  assert.equal(r.would_send, 2);
  assert.equal(calls.process.length + calls.marks.length + calls.sends.length + calls.reads.length, 0);
});

test('route pre-check: a hung read resolves to "no mark" within the cap', async () => {
  const started = Date.now();
  const res = await withTimeout(new Promise(() => {}), 50, null);
  assert.equal(res, null);
  assert.ok(Date.now() - started < 1000);
  assert.equal(await withTimeout(Promise.resolve({ status: 'lp_created' }), 50, null).then((x) => x.status), 'lp_created');
});
