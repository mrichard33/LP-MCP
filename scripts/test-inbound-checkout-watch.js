/**
 * Inbound checkout watch — scripts/test-inbound-checkout-watch.js
 *
 * src/inbound-checkout-watch.js (rules) and src/jobs/inbound-checkout-watch.js
 * (the pass, with fake deps). 2026-10-06: ~49% of LP inquiries wait for a
 * person to check them out (4–15h overnight) and nobody was told.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  watchMode, watchConfig, watchRow, classifyRow, priorityOf, assessWaiting, inOfficeHours, formatWaitCard,
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

test('priority: appointment > GHL sender > other', () => {
  assert.equal(priorityOf(row()), 'appt');
  assert.equal(priorityOf(row({ appttime: '' })), 'ghl'); // a date alone is not an appointment
  assert.equal(priorityOf(row({ apptdate: '', appttime: '' })), 'ghl');
  assert.equal(priorityOf(row({ apptdate: '', appttime: '', sender: 'Simpletext' })), 'other');
});

const dueAt = (r, minutesAfter) => assessWaiting([r], r.receivedMs + minutesAfter * 60000, cfg)[0].due;
test('threshold edges: appointment 10 (9/11), GHL 15 (14/16), other 30 (29/31)', () => {
  const appt = row();
  assert.equal(dueAt(appt, 9), false);
  assert.equal(dueAt(appt, 11), true);
  const ghl = row({ apptdate: '', appttime: '' });
  assert.equal(dueAt(ghl, 14), false);
  assert.equal(dueAt(ghl, 16), true);
  const other = row({ apptdate: '', appttime: '', sender: 'Simpletext' });
  assert.equal(dueAt(other, 29), false);
  assert.equal(dueAt(other, 31), true);
});

test('thresholds come from env', () => {
  const c = watchConfig({ INBOUND_WATCH_APPT_MIN: '5', INBOUND_WATCH_ESCALATE_MIN: '20', INBOUND_WATCH_OFFICE_START: '09:30' });
  assert.equal(c.thresholdMin.appt, 5);
  assert.equal(c.escalateMin, 20);
  assert.equal(c.officeStartMin, 570);
  assert.equal(watchConfig({ INBOUND_WATCH_APPT_MIN: 'abc' }).thresholdMin.appt, 10);
});

test('Shelley: carded at 15:33, not at 15:31; escalated at 16:08, not at 16:06', () => {
  const r = row();
  assert.equal(r.receivedMs, Date.parse('2026-10-06T19:22:04.707Z'));
  const at = (hm) => assessWaiting([r], edt(`2026-10-06T${hm}:00`), cfg)[0];
  assert.equal(at('15:31').due, false);
  assert.equal(at('15:33').due, true);
  assert.equal(at('15:33').priority, 'appt');
  assert.equal(at('16:06').escalate, false);
  assert.equal(at('16:08').escalate, true);
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
  const r = row({ datereceived: '2026-11-01T07:50:00', apptdate: '11/03/2026' });
  assert.equal(r.receivedMs, Date.parse('2026-11-01T12:50:00Z'));
  assert.equal(assessWaiting([r], Date.parse('2026-11-01T12:59:00Z'), cfg)[0].due, false);
  assert.equal(assessWaiting([r], Date.parse('2026-11-01T13:01:00Z'), cfg)[0].due, true);
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

test('live, in hours: Shelley carded once at 15:33 (after the morning card), never twice', async () => {
  const h = deps();
  // Morning already handled: mark the overnight key so only the regular card is in play.
  h.db.tables.lp_appointment_sync_marks.set('inbound-watch-overnight:2026-10-06', {});
  const r1 = await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-06T15:33:00'), deps: h.d });
  assert.equal(r1.ok, true, r1.errors.join());
  assert.equal(h.calls.posts.length, 1);
  assert.equal(h.calls.posts[0].channel, 'C_SERVICE');
  assert.match(h.calls.posts[0].text, /inquiry 428940/);
  assert.ok(h.db.tables.lp_inbound_queue.has('428940'), 'mirrored');
  await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-06T15:38:00'), deps: h.d });
  assert.equal(h.calls.posts.length, 1, 'no repeat card');
  assert.equal(h.calls.ops.length, 0, 'not yet 45 min');
  await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-06T16:08:00'), deps: h.d });
  assert.equal(h.calls.ops.length, 1, 'escalated at 16:08');
  assert.equal(h.calls.ops[0].opts.channel, 'ops');
  assert.ok(h.calls.posted.some((p) => p.audit === ESCALATE_AUDIT));
  assert.equal(h.calls.alarm.active, false, 'clean pass clears the alarm');
});

test('overnight: nothing posts; the first in-hours pass posts ONE card of everything waiting', async () => {
  const night = [
    { ...SHELLEY_WAITING, id: '500001', datereceived: '2026-10-06T21:10:00' },
    { ...SHELLEY_WAITING, id: '500002', apptdate: '', appttime: '', sender: 'Simpletext', datereceived: '2026-10-07T02:00:00' },
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
  assert.ok(h.db.tables.lp_appointment_sync_marks.has('inbound-watch-overnight:2026-10-07'));
  await runInboundCheckoutWatch({ env: LIVE, nowMs: edt('2026-10-07T08:05:00'), deps: h.d });
  assert.equal(h.calls.posts.filter((p) => p.channel === 'C_SERVICE').length, 1, 'the overnight rows are not carded again');
  assert.ok(h.calls.posted.some((p) => p.audit === WAIT_AUDIT));
});

test('shadow posts nothing and writes no marks or GHL fields', async () => {
  const issued = { ...SHELLEY_WAITING, id: '600001', lds_id: '581999', checkoutdate: '2026-10-06T15:40:00', apptdate: '', appttime: '' };
  const h = deps({ rows: [SHELLEY_WAITING, issued], contact: { customFields: [], last_appointment_start_date: '2026-10-08', last_appointment_start_time: '18:00' } });
  const res = await runInboundCheckoutWatch({ env: {}, nowMs: edt('2026-10-06T16:10:00'), deps: h.d });
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
