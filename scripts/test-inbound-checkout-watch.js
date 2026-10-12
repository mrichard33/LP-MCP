/**
 * Inbound checkout watch — scripts/test-inbound-checkout-watch.js
 *
 * src/inbound-checkout-watch.js (rules) and src/jobs/inbound-checkout-watch.js
 * (the pass, with fake deps). 2026-10-06: ~49% of LP inquiries wait for a
 * person to check them out (4–15h overnight) and nobody was told.
 * 2026-10-07 (Mark): card only past the normal checkout time (median 11 min,
 * p90 42) — visit today/tomorrow 30 min, everything else 60, #ops at 90.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  watchMode, watchConfig, watchRow, classifyRow, priorityOf, assessWaiting, inOfficeHours, formatWaitCard, officeMinutesBetween,
  writebackDecision, upcomingContactAppt, contactApptKey, WAIT_HEADER, GHL_FIELD_LP_LEAD_ID,
} from '../src/inbound-checkout-watch.js';
import { runInboundCheckoutWatch, WAIT_AUDIT, ESCALATE_AUDIT } from '../src/jobs/inbound-checkout-watch.js';
import { inDialWindow } from '../src/jobs/new-lead-dial-backstop.js';

const cfg = watchConfig({});
// ET wall clock → UTC ms (October 2026 is EDT, UTC-4).
const edt = (s) => Date.parse(`${s}-04:00`);

// Shelley, in1 428940, as it sat BEFORE Sarah checked it out at 15:56.
const SHELLEY_WAITING = {
  id: '428940', firstname: 'Shelley', lastname: '', phone: '(941)467-0700', brn_id: 'FTMYR',
  source: 'Website', srs_id: '830', sourcesubdescr: 'Reece ChatBot', checkoutdate: '', checkoutuser: '', checkoutusername: '',
  apptdate: '10/08/2026', appttime: '6:00 PM', datereceived: '2026-10-06T15:22:04.707', lognumber: 'u5JV2SkaPh8O4XqkCDyM',
  method: '', lds_id: '', cst_id: '', dsp_id: 'Set', killreason: '', sender: 'GHL-Chatbot',
};
const row = (over = {}) => watchRow({ ...SHELLEY_WAITING, ...over });

/* --- rules --------------------------------------------------------------- */

test('mode defaults to shadow; a typo is shadow', () => {
  assert.equal(watchMode({}), 'shadow');
  assert.equal(watchMode({ INBOUND_CHECKOUT_WATCH_MODE: 'LIVE' }), 'live');
  assert.equal(watchMode({ INBOUND_CHECKOUT_WATCH_MODE: 'liev' }), 'shadow');
  assert.equal(watchMode({ INBOUND_CHECKOUT_WATCH_MODE: 'off' }), 'off');
});

test('classification', () => {
  assert.equal(classifyRow(row()), 'waiting');
  assert.equal(classifyRow(row({ lds_id: '581671', checkoutdate: '2026-10-06T15:56:02.817' })), 'issued');
  assert.equal(classifyRow(row({ method: 'X' })), 'killed');
  assert.equal(classifyRow(row({ killreason: 'Duplicate' })), 'killed');
  assert.equal(classifyRow(row({ checkoutdate: '2026-10-06T15:56:02.817' })), 'checked_out');
});

test('priority: appointment (near) > appointment 2+ days out > GHL sender > other', () => {
  assert.equal(priorityOf(row()), 'appt'); // no clock: the stricter line
  assert.equal(priorityOf(row(), edt('2026-10-06T15:30:00')), 'appt_far', 'Shelley: visit 10/08, two days out');
  assert.equal(priorityOf(row(), edt('2026-10-07T09:00:00')), 'appt', 'visit tomorrow');
  assert.equal(priorityOf(row(), edt('2026-10-08T09:00:00')), 'appt', 'visit today');
  assert.equal(priorityOf(row(), edt('2026-10-09T09:00:00')), 'appt', 'a visit already past stays on the strict line');
  assert.equal(priorityOf(row({ appttime: '' })), 'ghl'); // a date alone is not an appointment
  assert.equal(priorityOf(row({ apptdate: '', appttime: '' })), 'ghl');
  assert.equal(priorityOf(row({ apptdate: '', appttime: '', sender: 'Simpletext' })), 'other');
});

const dueAt = (r, minutesAfter) => assessWaiting([r], r.receivedMs + minutesAfter * 60000, cfg)[0].due;
test('threshold edges: visit today/tomorrow 30, visit 2+ days 60, GHL 60, other 60; #ops 90', () => {
  const near = row({ apptdate: '10/06/2026' });
  assert.equal(dueAt(near, 29), false);
  assert.equal(dueAt(near, 31), true);
  const far = row(); // visit 10/08, received 10/06
  assert.equal(dueAt(far, 59), false);
  assert.equal(dueAt(far, 61), true);
  const ghl = row({ apptdate: '', appttime: '' });
  assert.equal(dueAt(ghl, 59), false);
  assert.equal(dueAt(ghl, 61), true);
  const other = row({ apptdate: '', appttime: '', sender: 'Simpletext' });
  assert.equal(dueAt(other, 59), false);
  assert.equal(dueAt(other, 61), true);
  const escAt = (m) => assessWaiting([other], other.receivedMs + m * 60000, cfg)[0].escalate;
  assert.equal(escAt(89), false);
  assert.equal(escAt(91), true);
});

test('thresholds come from env', () => {
  assert.deepEqual(cfg.thresholdMin, { appt: 30, appt_far: 60, ghl: 60, other: 60 });
  assert.equal(cfg.escalateMin, 90);
  const c = watchConfig({ INBOUND_WATCH_APPT_MIN: '5', INBOUND_WATCH_APPT_FAR_MIN: '45', INBOUND_WATCH_ESCALATE_MIN: '20', INBOUND_WATCH_OFFICE_START: '09:30' });
  assert.equal(c.thresholdMin.appt, 5);
  assert.equal(c.thresholdMin.appt_far, 45);
  assert.equal(c.escalateMin, 20);
  assert.equal(c.officeStartMin, 570);
  assert.equal(watchConfig({ INBOUND_WATCH_APPT_MIN: 'abc' }).thresholdMin.appt, 30);
});

test('Shelley (visit two days out): carded at 16:23, not at 16:21; escalated at 16:53, not at 16:51', () => {
  const r = row();
  assert.equal(r.receivedMs, Date.parse('2026-10-06T19:22:04.707Z'));
  const at = (hm) => assessWaiting([r], edt(`2026-10-06T${hm}:00`), cfg)[0];
  assert.equal(at('15:33').due, false, 'the old 10-minute line paged on the normal case');
  assert.equal(at('16:21').due, false);
  assert.equal(at('16:23').due, true);
  assert.equal(at('16:23').priority, 'appt_far');
  assert.equal(at('16:51').escalate, false);
  assert.equal(at('16:53').escalate, true);
});

test('appointment rows come first, then the longest wait', () => {
  const nowMs = edt('2026-10-06T17:00:00');
  const list = assessWaiting([
    row({ id: '1', apptdate: '', appttime: '', datereceived: '2026-10-06T14:00:00' }),
    row({ id: '2', datereceived: '2026-10-06T16:40:00' }),
    row({ id: '3', apptdate: '', appttime: '', sender: 'X', datereceived: '2026-10-06T13:00:00' }),
    row({ id: '4', datereceived: '2026-10-06T16:00:00' }),
  ], nowMs, cfg);
  assert.deepEqual(list.map((a) => a.row.in1), ['4', '2', '1', '3']);
});

test('office hours equal the Five9 dial window by default', () => {
  for (const hm of ['07:59', '08:00', '12:00', '19:44', '19:45', '23:00']) {
    const ms = edt(`2026-10-06T${hm}:00`);
    assert.equal(inOfficeHours(ms, cfg), inDialWindow(ms), hm);
  }
});

test('DST (2026-11-01, clocks fall back at 2 AM): office hours and waits follow EST', () => {
  // 8:00 AM EST on 11/01 = 13:00Z.
  assert.equal(inOfficeHours(Date.parse('2026-11-01T12:59:00Z'), cfg), false);
  assert.equal(inOfficeHours(Date.parse('2026-11-01T13:00:00Z'), cfg), true);
  const r = row({ datereceived: '2026-11-01T07:50:00', apptdate: '11/01/2026' });
  assert.equal(r.receivedMs, Date.parse('2026-11-01T12:50:00Z'));
  assert.equal(assessWaiting([r], Date.parse('2026-11-01T13:19:00Z'), cfg)[0].due, false);
  assert.equal(assessWaiting([r], Date.parse('2026-11-01T13:21:00Z'), cfg)[0].due, true);
});

test('the card line names everything a person needs and no full phone', () => {
  const card = formatWaitCard(assessWaiting([row()], edt('2026-10-06T15:40:00'), cfg));
  assert.ok(card.startsWith(WAIT_HEADER));
  assert.match(card, /Shelley · …0700 · inquiry 428940 · GHL-Chatbot \/ Reece ChatBot · appt 2026-10-08 6:00 PM · waiting 17 min · FTMYR/);
  assert.doesNotMatch(card, /9414670700/);
});

test('contact appointment parsing and "upcoming"', () => {
  assert.equal(contactApptKey('2026-10-08'), '2026-10-08');
  assert.equal(contactApptKey('2026-10-08T22:00:00Z'), '2026-10-08');
  assert.equal(contactApptKey('10/08/2026'), '2026-10-08');
  assert.equal(contactApptKey('null'), null);
  const now = edt('2026-10-06T16:00:00');
  assert.deepEqual(upcomingContactAppt({ last_appointment_start_date: '2026-10-08', last_appointment_start_time: '18:00' }, now),
    { dateKey: '2026-10-08', apptDate: '10/08/2026', apptTime: '18:00' });
  assert.equal(upcomingContactAppt({ last_appointment_start_date: '2026-10-05', last_appointment_start_time: '14:00' }, now), null);
  assert.equal(upcomingContactAppt({ last_appointment_start_date: '2026-10-08' }, now), null);
});

test('write-back decision', () => {
  const issued = row({ lds_id: '581671', apptdate: '', appttime: '' });
  const now = edt('2026-10-06T16:00:00');
  const empty = { customFields: [] };
  const withAppt = { customFields: [], last_appointment_start_date: '2026-10-08', last_appointment_start_time: '18:00' };
  const hasLds = { customFields: [{ id: GHL_FIELD_LP_LEAD_ID, value: '581671' }] };
  assert.equal(writebackDecision(issued, null, now).reason, 'contact_unreadable');
  assert.equal(writebackDecision(issued, empty, now).reason, 'write_lds');
  assert.equal(writebackDecision(issued, withAppt, now).reason, 'write_lds_and_set_appt');
  assert.equal(writebackDecision(issued, hasLds, now).reason, 'nothing_to_do');
  // The inquiry already carries an appointment → never set it again.
  assert.equal(writebackDecision(row({ lds_id: '581671' }), { ...withAppt, ...hasLds }, now).reason, 'nothing_to_do');
});

/* --- the pass -------------------------------------------------------------- */

function fakeDb() {
  const tables = { lp_appointment_sync_marks: new Map(), lp_inbound_queue: new Map() };
  const writes = [];
  const db = {
    tables, writes,
    from(name) {
      const t = tables[name] || (tables[name] = new Map());
      return {
        select() { return { in: async (_col, keys) => ({ data: keys.filter((k) => t.has(k)).map((k) => ({ dedup_key: k })), error: null }) }; },
        upsert(rowOrRows, opts) {
          const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
          writes.push({ table: name, rows });
          const inserted = [];
          for (const r of rows) {
            const key = r.dedup_key ?? r.in1_id;
            if (opts?.ignoreDuplicates && t.has(key)) continue;
            t.set(key, r);
            inserted.push(r);
          }
          const res = { data: inserted.map((r) => ({ dedup_key: r.dedup_key })), error: null };
          return Object.assign(Promise.resolve(res), { select: async () => res });
        },
        delete() { return { in: async (_c, keys) => { for (const k of keys) t.delete(k); return { error: null }; } }; },
      };
    },
  };
  return db;
}

function deps({ rows = [SHELLEY_WAITING], readThrows = false, contact = null } = {}) {
  const calls = { posts: [], ops: [], ghl: [], fields: [], tags: [], appts: [], posted: [] };
  const posted = new Set();
  const db = fakeDb();
  return {
    calls, db,
    d: {
      supabase: db,
      listInboundLeads: async ({ page }) => { if (readThrows) throw new Error('LP 500'); return page === 1 ? rows : []; },
      postToSlack: async (text, channel) => { calls.posts.push({ text, channel }); return { ok: true }; },
      sendAlertMessage: async (text, opts) => { calls.ops.push({ text, opts }); return { sent: true }; },
      reportAlertCondition: async (a) => { calls.alarm = a; },
      filterNew: async ({ audit, items }) => ({ fresh: items.filter((i) => !posted.has(`${audit}|${i.key}|${i.reason}`)) }),
      recordPosted: async ({ audit, items }) => { for (const i of items) posted.add(`${audit}|${i.key}|${i.reason}`); calls.posted.push({ audit, n: items.length }); },
      getGHLContact: async (id) => { calls.ghl.push(id); return contact; },
      updateGHLContactFields: async (id, f) => calls.fields.push([id, f]),
      applyGHLTag: async (id, tag) => calls.tags.push([id, tag]),
      executeSetLPAppointment: async (a) => { calls.appts.push(a); return { action: 'lp_appointment_set' }; },
    },
  };
}
const LIVE = { INBOUND_CHECKOUT_WATCH_MODE: 'live', SLACK_CHANNEL_SERVICE: 'C_SERVICE' };

test('read failure → no posts, no writes, an error and the alarm (live)', async () => {
  const h = deps({ readThrows: true });
  const res = await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-06T15:33:00'), deps: h.d });
  assert.equal(res.ok, false);
  assert.equal(res.insufficient_evidence, true);
  assert.equal(h.calls.posts.length, 0);
  assert.equal(h.calls.ops.length, 0);
  assert.equal(h.db.writes.length, 0);
  assert.equal(h.calls.alarm.active, true);
  assert.equal(h.calls.alarm.channel, 'ops');
});

test('live, in hours: Shelley carded once at 16:23 (after the morning card), never twice', async () => {
  const h = deps();
  // Morning already handled: mark the overnight key so only the regular card is in play.
  h.db.tables.lp_appointment_sync_marks.set('inbound-watch-overnight:2026-10-06', {});
  await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-06T15:33:00'), deps: h.d });
  assert.equal(h.calls.posts.length, 0, 'visit two days out: 11 minutes is normal');
  const r1 = await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-06T16:23:00'), deps: h.d });
  assert.equal(r1.ok, true, r1.errors.join());
  assert.equal(h.calls.posts.length, 1);
  assert.equal(h.calls.posts[0].channel, 'C_SERVICE');
  assert.match(h.calls.posts[0].text, /inquiry 428940/);
  assert.ok(h.db.tables.lp_inbound_queue.has('428940'), 'mirrored');
  await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-06T16:28:00'), deps: h.d });
  assert.equal(h.calls.posts.length, 1, 'no repeat card');
  await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-06T16:48:00'), deps: h.d });
  assert.equal(h.calls.ops.length, 0, 'not yet 90 min');
  await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-06T16:53:00'), deps: h.d });
  assert.equal(h.calls.ops.length, 1, 'escalated at 16:53');
  assert.equal(h.calls.ops[0].opts.channel, 'ops');
  assert.ok(h.calls.posted.some((p) => p.audit === ESCALATE_AUDIT));
  assert.equal(h.calls.alarm.active, false, 'clean pass clears the alarm');
});

test('overnight: nothing posts; the first in-hours pass posts ONE card of what is past its threshold', async () => {
  const night = [
    { ...SHELLEY_WAITING, id: '500001', datereceived: '2026-10-06T21:10:00' },
    { ...SHELLEY_WAITING, id: '500002', apptdate: '', appttime: '', sender: 'Simpletext', datereceived: '2026-10-07T02:00:00' },
    // 13 minutes old at 8:00, visit tomorrow: normal, not on the card (2026-10-07).
    { ...SHELLEY_WAITING, id: '500003', datereceived: '2026-10-07T07:47:00' },
  ];
  const h = deps({ rows: night });
  await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-07T03:00:00'), deps: h.d });
  await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-07T07:55:00'), deps: h.d });
  assert.equal(h.calls.posts.length, 0);
  assert.equal(h.calls.ops.length, 0);
  await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-07T08:00:00'), deps: h.d });
  // One overnight card on #contact-center (both rows), and the #ops escalation.
  const cc = h.calls.posts.filter((p) => p.channel === 'C_SERVICE');
  assert.equal(cc.length, 1);
  assert.match(cc[0].text, /came in overnight/);
  assert.match(cc[0].text, /500001/);
  assert.match(cc[0].text, /500002/);
  assert.doesNotMatch(cc[0].text, /500003/, 'a 13-minute-old inquiry is not on the overnight card');
  assert.ok(h.db.tables.lp_appointment_sync_marks.has('inbound-watch-overnight:2026-10-07'));
  await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-07T08:05:00'), deps: h.d });
  assert.equal(h.calls.posts.filter((p) => p.channel === 'C_SERVICE').length, 1, 'the overnight rows are not carded again');
  assert.ok(h.calls.posted.some((p) => p.audit === WAIT_AUDIT));
  // 500003 reaches its 30 minutes at 8:17: the regular card names it, alone.
  await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-07T08:20:00'), deps: h.d });
  const cc2 = h.calls.posts.filter((p) => p.channel === 'C_SERVICE');
  assert.equal(cc2.length, 2);
  assert.doesNotMatch(cc2[1].text, /came in overnight/);
  assert.match(cc2[1].text, /500003/);
  assert.doesNotMatch(cc2[1].text, /500001|500002/);
});

test('overnight: nothing due at 8:00 → no card, and the day\'s key is still claimed', async () => {
  const h = deps({ rows: [{ ...SHELLEY_WAITING, id: '510001', datereceived: '2026-10-07T07:47:00' }] });
  const res = await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-07T08:00:00'), deps: h.d });
  assert.equal(res.ok, true, res.errors.join());
  assert.equal(h.calls.posts.length, 0);
  assert.ok(h.db.tables.lp_appointment_sync_marks.has('inbound-watch-overnight:2026-10-07'));
});

test('a visit five days out does not card until 60 minutes', async () => {
  const h = deps({ rows: [{ ...SHELLEY_WAITING, id: '520001', apptdate: '10/12/2026', datereceived: '2026-10-07T10:00:00' }] });
  h.db.tables.lp_appointment_sync_marks.set('inbound-watch-overnight:2026-10-07', {});
  for (const hm of ['10:30', '10:45', '10:59']) {
    await runInboundCheckoutWatch({ env: LIVE, nowMs: edt(`2026-10-07T${hm}:00`), deps: h.d });
  }
  assert.equal(h.calls.posts.length, 0);
  await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-07T11:01:00'), deps: h.d });
  assert.equal(h.calls.posts.length, 1);
  assert.match(h.calls.posts[0].text, /520001/);
});

test('a visit today cards at 30 minutes', async () => {
  const h = deps({ rows: [{ ...SHELLEY_WAITING, id: '530001', apptdate: '10/07/2026', datereceived: '2026-10-07T10:00:00' }] });
  h.db.tables.lp_appointment_sync_marks.set('inbound-watch-overnight:2026-10-07', {});
  await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-07T10:29:00'), deps: h.d });
  assert.equal(h.calls.posts.length, 0);
  await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-07T10:31:00'), deps: h.d });
  assert.equal(h.calls.posts.length, 1);
  assert.match(h.calls.posts[0].text, /530001/);
});

test('an inquiry the held-row "import this lead" card already named is not carded again', async () => {
  const h = deps({ rows: [{ ...SHELLEY_WAITING, id: '540001', apptdate: '10/07/2026', datereceived: '2026-10-07T10:00:00' }] });
  h.db.tables.lp_appointment_sync_marks.set('inbound-watch-overnight:2026-10-07', {});
  await h.d.recordPosted({ audit: 'lp_inbound_held', items: [{ key: '540001', reason: 'card' }] });
  const res = await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-07T10:31:00'), deps: h.d });
  assert.equal(res.ok, true, res.errors.join());
  assert.equal(h.calls.posts.length, 0);
});

// 2026-10-08: the 12 overnight rows on the 8:05 #contact-center card went to
// #ops in the same minute. The escalation clock now starts at office open.
test('overnight rows: carded at 8:00, but #ops only once they are still waiting 90 min into the day', async () => {
  const night = [
    { ...SHELLEY_WAITING, id: '550001', apptdate: '', appttime: '', sender: 'Simpletext', datereceived: '2026-10-07T23:10:00' },
    { ...SHELLEY_WAITING, id: '550002', apptdate: '10/08/2026', datereceived: '2026-10-08T03:00:00' },
  ];
  const h = deps({ rows: night });
  await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-08T08:05:00'), deps: h.d });
  assert.equal(h.calls.posts.length, 1, 'the overnight card');
  assert.match(h.calls.posts[0].text, /came in overnight/);
  assert.equal(h.calls.ops.length, 0, 'not the same minute in #ops');
  await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-08T09:25:00'), deps: h.d });
  assert.equal(h.calls.ops.length, 0, '85 minutes into the day');
  const res = await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-08T09:31:00'), deps: h.d });
  assert.equal(h.calls.ops.length, 1, '91 minutes into the day: still waiting → #ops, once');
  assert.match(h.calls.ops[0].text, /90\+ minutes into office hours/);
  assert.match(h.calls.ops[0].text, /550001/);
  assert.match(h.calls.ops[0].text, /550002/);
  assert.ok(res.waiting.every((w) => w.open_wait_min === 91));
  await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-08T09:36:00'), deps: h.d });
  assert.equal(h.calls.ops.length, 1);
});

// 2026-10-12: rows that arrived Sunday 18:45–19:38 ET, just before close, still
// hit #ops at 8:04 Monday: the clock started at arrival and ran all night.
test('officeMinutesBetween counts only open minutes (closes 19:45, opens 08:00 ET)', () => {
  assert.equal(officeMinutesBetween(edt('2026-10-12T10:00:00'), edt('2026-10-12T11:30:00'), cfg), 90);
  assert.equal(officeMinutesBetween(edt('2026-10-11T19:00:00'), edt('2026-10-12T08:04:00'), cfg), 49, '45 + 4');
  assert.equal(officeMinutesBetween(edt('2026-10-12T02:00:00'), edt('2026-10-12T09:31:00'), cfg), 91);
  assert.equal(officeMinutesBetween(edt('2026-10-11T21:00:00'), edt('2026-10-12T07:59:00'), cfg), 0, 'all closed');
  assert.equal(officeMinutesBetween(edt('2026-10-10T19:00:00'), edt('2026-10-12T08:00:00'), cfg), 45 + 705, 'a whole open day in between');
  assert.equal(officeMinutesBetween(edt('2026-10-12T11:00:00'), edt('2026-10-12T10:00:00'), cfg), 0);
});

test('a row that arrives at 19:00 is not sent to #ops at 8:04; it goes at 8:46 if still waiting', async () => {
  const late = { ...SHELLEY_WAITING, id: '560001', apptdate: '', appttime: '', sender: 'Simpletext', datereceived: '2026-10-11T19:00:00' };
  const r = watchRow(late);
  assert.equal(assessWaiting([r], edt('2026-10-12T08:04:00'), cfg)[0].escalate, false);
  assert.equal(assessWaiting([r], edt('2026-10-12T08:04:00'), cfg)[0].openWaitMin, 49);
  const h = deps({ rows: [late] });
  await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-12T08:04:00'), deps: h.d });
  assert.equal(h.calls.posts.length, 1, 'the overnight card still lists it (waiting 13h)');
  assert.equal(h.calls.ops.length, 0, 'not #ops at 8:04');
  await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-12T08:44:00'), deps: h.d });
  assert.equal(h.calls.ops.length, 0, '89 open minutes');
  await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-12T08:46:00'), deps: h.d });
  assert.equal(h.calls.ops.length, 1, '91 open minutes: still waiting → #ops, once');
});

test('a row that arrives in office hours still escalates 90 minutes after it arrived', () => {
  const r = row({ apptdate: '', appttime: '', sender: 'Simpletext', datereceived: '2026-10-08T10:00:00' });
  assert.equal(assessWaiting([r], edt('2026-10-08T11:29:00'), cfg)[0].escalate, false);
  assert.equal(assessWaiting([r], edt('2026-10-08T11:31:00'), cfg)[0].escalate, true);
});

test('shadow posts nothing and writes no marks or GHL fields', async () => {
  const issued = { ...SHELLEY_WAITING, id: '600001', lds_id: '581999', checkoutdate: '2026-10-06T15:40:00', apptdate: '', appttime: '' };
  const h = deps({ rows: [SHELLEY_WAITING, issued], contact: { customFields: [], last_appointment_start_date: '2026-10-08', last_appointment_start_time: '18:00' } });
  const res = await runInboundCheckoutWatch({ env: {}, nowMs: edt('2026-10-06T16:30:00'), deps: h.d });
  assert.equal(res.mode, 'shadow');
  assert.equal(h.calls.posts.length + h.calls.ops.length, 0);
  assert.equal(h.calls.fields.length + h.calls.appts.length, 0);
  assert.equal(h.db.tables.lp_appointment_sync_marks.size, 0);
  assert.deepEqual(res.would.wait, ['428940']);
  assert.equal(res.writes[0].result, 'would');
});

test('live write-back: lds written + tagged, appointment set once on the lds', async () => {
  const issued = { ...SHELLEY_WAITING, id: '428940', lds_id: '581671', checkoutdate: '2026-10-06T15:56:02.817', apptdate: '', appttime: '' };
  const contact = { customFields: [], last_appointment_start_date: '2026-10-08', last_appointment_start_time: '18:00' };
  const h = deps({ rows: [issued], contact });
  const res = await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-06T16:00:00'), deps: h.d });
  assert.equal(res.ok, true, res.errors.join());
  assert.deepEqual(h.calls.fields, [['u5JV2SkaPh8O4XqkCDyM', [{ id: GHL_FIELD_LP_LEAD_ID, field_value: '581671' }]]]);
  assert.deepEqual(h.calls.tags, [['u5JV2SkaPh8O4XqkCDyM', 'lp-issued-via-watch']]);
  assert.equal(h.calls.appts.length, 1);
  assert.equal(h.calls.appts[0].target_id, '581671');
  assert.equal(h.calls.appts[0].action_payload.appt_date, '10/08/2026');
  await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-06T16:05:00'), deps: h.d });
  assert.equal(h.calls.appts.length, 1, 'once');
  assert.equal(h.calls.ghl.length, 1, 'a checked row is not re-read');
});

test('write-backs are capped per pass', async () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    ...SHELLEY_WAITING, id: String(700000 + i), lognumber: `ABCDEFGHIJKLMNOPQR${String(i).padStart(2, '0')}`,
    lds_id: String(590000 + i), checkoutdate: '2026-10-06T15:50:00', apptdate: '', appttime: '',
  }));
  const h = deps({ rows: many, contact: { customFields: [] } });
  await runInboundCheckoutWatch({ env: { ...LIVE, INBOUND_WATCH_MAX_WRITES: '3' }, nowMs: edt('2026-10-06T16:00:00'), deps: h.d });
  assert.equal(h.calls.fields.length, 3);
});
