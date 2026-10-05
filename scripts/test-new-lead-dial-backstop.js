/**
 * New-lead dial backstop (2026-10-05). Every imported, never-called LP lead
 * reaches a Five9 list: Conf - Next Day / Conf - 2nd Day / Callback Request.
 * Motivating rows: in1 428370, 428371, 428372 (Daniel, Set 10/5 2 PM),
 * 428375 — imported ~10 AM Monday, on no Five9 list, never called.
 *
 * Run: node --test scripts/test-new-lead-dial-backstop.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  backstopMode, backstopConfig, normalizeInboundRow, currentState, routeList,
  prefilter, finalDecision, buildBackstopRecord, formatPushedCard, markKey, phoneDayKey,
  etDateKey, lpDateToKey, lpTimeToHHMM,
} from '../src/new-lead-dial-backstop.js';
import { runNewLeadDialBackstop, wasCalled, inDialWindow } from '../src/jobs/new-lead-dial-backstop.js';
import { executeAddRecordsToList } from '../src/five9/admin-writes.js';

const cfg = backstopConfig({});
const MON_1015 = Date.parse('2026-10-05T14:15:00Z'); // 10:15 AM EDT
const at = (iso) => Date.parse(iso);

// The four rows exactly as GetInboundLeadInfo returned them after import.
const RAW = {
  kathy:  { id: '428370', firstname: 'Kathy', lastname: 'Johnson', address1: '2743 Arugula Dr, North Port, FL, US', phone: '(951)515-5283', brn_id: 'SAR', cst_id: '462954', lds_id: '581093', dsp_id: 'Data', apptdate: '', appttime: '', datereceived: '2026-10-04T19:18:07.697', lognumber: '', killreason: '' },
  robert: { id: '428371', firstname: 'Robert', lastname: 'Parsons', address1: '19 Emerald Ln', phone: '(386)457-4523', brn_id: 'JAX', cst_id: '416072', lds_id: '581094', dsp_id: 'Data', apptdate: '', appttime: '', datereceived: '2026-10-04T19:29:33.627', lognumber: '', killreason: '' },
  daniel: { id: '428372', firstname: 'Daniel', lastname: '', address1: '3418 Westclox St', phone: '(239)250-0011', brn_id: 'FTMYR', cst_id: '462947', lds_id: '581084', dsp_id: 'Set', apptdate: '10/05/2026', appttime: '2:00 PM', datereceived: '2026-10-04T19:36:29.977', lognumber: 'LgCeHyniTQPfrnT4Ga7j', killreason: '' },
  jimmie: { id: '428375', firstname: 'Jimmie ', lastname: 'Williams ', address1: '', phone: '(352)274-2458', brn_id: 'ORL', cst_id: '462957', lds_id: '581097', dsp_id: 'Data', apptdate: '', appttime: '', datereceived: '2026-10-04T19:45:29.713', lognumber: '', killreason: '' },
};
const row = (k, over = {}) => normalizeInboundRow({ ...RAW[k], ...over });

/* --- config & parsing ------------------------------------------------------ */

test('mode defaults to shadow; typos are shadow, never live', () => {
  assert.equal(backstopMode({}), 'shadow');
  assert.equal(backstopMode({ NEW_LEAD_DIAL_BACKSTOP_MODE: 'LIVE' }), 'live');
  assert.equal(backstopMode({ NEW_LEAD_DIAL_BACKSTOP_MODE: 'lvie' }), 'shadow');
  assert.equal(backstopMode({ NEW_LEAD_DIAL_BACKSTOP_MODE: 'off' }), 'off');
});

test('the three lists are the user ruling; LP_ASAP is refused', () => {
  assert.deepEqual(cfg.lists, { nextDay: 'Conf - Next Day', secondDay: 'Conf - 2nd Day', noAppt: 'Callback Request' });
  assert.throws(() => backstopConfig({ NEW_LEAD_BACKSTOP_LIST_NO_APPT: 'lp_asap' }), /LP_ASAP/);
});

test('the executor itself refuses LP_ASAP', () => {
  assert.throws(() => executeAddRecordsToList({ action_payload: { list_name: 'LP_ASAP', field_names: ['number1'], records: [['2392500011']] } }), /LP_ASAP/);
});

test('LP dates and times parse; garbage and Delphi zero do not', () => {
  assert.equal(lpDateToKey('10/05/2026'), '2026-10-05');
  assert.equal(lpDateToKey('12/30/1899'), null);
  assert.equal(lpDateToKey(''), null);
  assert.equal(lpTimeToHHMM('2:00 PM'), '14:00');
  assert.equal(lpTimeToHHMM('12:00 PM'), '12:00');
  assert.equal(lpTimeToHHMM('10:00 AM'), '10:00');
});

test('datereceived is Eastern wall clock, not UTC', () => {
  assert.equal(new Date(row('daniel').receivedMs).toISOString(), '2026-10-04T23:36:29.977Z');
});

/* --- routing ----------------------------------------------------------------- */

const R = (date, time, nowMs = MON_1015) => {
  const startMs = time ? Date.parse(`${date}T${time}:00-04:00`) : null;
  return routeList({ hasAppt: true, apptDateEt: date, apptStartMs: startMs, nowMs, cfg });
};

test('routing: today/tomorrow → Next Day, 2+ days → 2nd Day, none → Callback Request', () => {
  assert.equal(R('2026-10-05', '14:00').list, 'Conf - Next Day');
  assert.equal(R('2026-10-06', '10:00').list, 'Conf - Next Day');
  assert.equal(R('2026-10-07', '10:00').list, 'Conf - 2nd Day');
  assert.equal(R('2026-10-15', '18:00').list, 'Conf - 2nd Day');
  assert.equal(routeList({ hasAppt: false, nowMs: MON_1015, cfg }).list, 'Callback Request');
});

test('routing: a past visit is skipped, including earlier today', () => {
  assert.equal(R('2026-10-04', '14:00').skip, 'past_appointment');
  assert.equal(R('2026-10-05', '10:00').skip, 'past_appointment');
  assert.equal(R('2026-10-05', null).list, 'Conf - Next Day', 'unknown time today still confirms');
});

test('routing uses the Eastern date: 11 PM ET is still "today"', () => {
  const elevenPm = at('2026-10-06T03:00:00Z'); // Mon 11 PM EDT = Tue 03:00Z
  assert.equal(etDateKey(elevenPm), '2026-10-05');
  assert.equal(R('2026-10-07', '10:00', elevenPm).list, 'Conf - 2nd Day');
});

/* --- current state ------------------------------------------------------------ */

test('lp_leads overrides the frozen inbound row', () => {
  const r = row('daniel');
  assert.equal(currentState(r, { disposition_code: 'CXL', appointment_date: null }).dsp, 'CXL');
  const moved = currentState(r, { disposition_code: 'Set', appointment_date: '2026-10-08 18:00:00+00' });
  assert.equal(moved.apptDateEt, '2026-10-08');
  assert.equal(new Date(moved.apptStartMs).toISOString(), '2026-10-08T22:00:00.000Z');
});

test('Data with a leftover date is not booked', () => {
  const s = currentState(row('kathy', { apptdate: '10/09/2026', appttime: '2:00 PM' }), null);
  assert.equal(s.hasAppt, false);
});

/* --- prefilter ------------------------------------------------------------------ */

const P = (r, o = {}) => prefilter({ row: r, lead: null, called: false, marks: new Set(), nowMs: MON_1015, cfg, ...o });

test('the four missed rows are candidates on the ruled lists', () => {
  assert.deepEqual([P(row('kathy')).list, P(row('robert')).list, P(row('daniel')).list, P(row('jimmie')).list],
    ['Callback Request', 'Callback Request', 'Conf - Next Day', 'Callback Request']);
});

test('every prefilter skip reason', () => {
  assert.equal(P(row('kathy', { phone: '555' })).reason, 'no_phone');
  assert.equal(P(row('kathy', { killreason: 'Duplicate' })).reason, 'killed');
  assert.equal(P(row('kathy', { datereceived: '' })).reason, 'unknown_age');
  assert.equal(P(row('kathy', { datereceived: '2026-09-30T10:00:00' })).reason, 'out_of_window');
  assert.equal(P(row('kathy', { datereceived: '2026-10-05T10:10:00' })).reason, 'too_new');
  assert.equal(P(row('kathy'), { called: true }).reason, 'called');
  assert.equal(P(row('kathy', { lds_id: '' })).reason, 'awaiting_import');
  assert.equal(P(row('kathy', { cst_id: '' })).reason, 'no_custid');
  assert.equal(P(row('kathy', { cst_id: '' }), { lead: { lp_prospect_id: '1' } }).action, 'candidate', 'CustID from lp_leads');
  assert.equal(P(row('daniel'), { lead: { disposition_code: 'CXL' } }).reason, 'dead_disposition');
  assert.equal(P(row('daniel'), { lead: { disposition_code: 'Cnf', appointment_date: '2026-10-05 14:00:00+00' } }).reason, 'progressed');
  assert.equal(P(row('daniel'), { nowMs: at('2026-10-05T18:30:00Z') }).reason, 'past_appointment');
  assert.equal(P(row('kathy'), { marks: new Set([markKey('428370', 'Callback Request')]) }).reason, 'already_pushed');
  assert.equal(P(row('kathy'), { marks: new Set([phoneDayKey('9515155283', '2026-10-05')]) }).reason, 'already_pushed');
});

test('precedence: killed beats called; called beats awaiting import', () => {
  assert.equal(P(row('kathy', { killreason: 'x' }), { called: true }).reason, 'killed');
  assert.equal(P(row('kathy', { lds_id: '' }), { called: true }).reason, 'called');
});

/* --- final decision ----------------------------------------------------------------- */

const F = (o) => {
  const r = o.row || row('kathy');
  const pre = P(r);
  return finalDecision({ pre, row: r, onDnc: false, contact: null, nowMs: MON_1015, cfg, ...o });
};

test('final: DNC unreadable waits, DNC skips, failed lookup pushes, no list pushes', () => {
  assert.deepEqual(F({ onDnc: null }), { action: 'wait', reason: 'dnc_unreadable' });
  assert.deepEqual(F({ onDnc: true }), { action: 'skip', reason: 'dnc' });
  assert.deepEqual(F({ contact: 'error' }), { action: 'push', reason: 'crosslist_failed_open' });
  assert.deepEqual(F({ contact: null }), { action: 'push', reason: 'not_on_dial_list' });
  assert.deepEqual(F({ contact: { list: null } }), { action: 'push', reason: 'not_on_dial_list' });
});

test('final: already on our list skips; on LP_ASAP waits 30 dial minutes, then pushes', () => {
  assert.equal(F({ contact: { list: 'Callback Request' } }).reason, 'already_on_target_list');
  // An overnight row on LP_ASAP: dialable from 8:00 ET.
  const r = row('kathy', { datereceived: '2026-10-05T01:00:00' });
  const pre = prefilter({ row: r, called: false, marks: new Set(), nowMs: at('2026-10-05T12:20:00Z'), cfg });
  const at820 = finalDecision({ pre, row: r, onDnc: false, contact: { list: 'LP_ASAP' }, nowMs: at('2026-10-05T12:20:00Z'), cfg });
  const at835 = finalDecision({ pre, row: r, onDnc: false, contact: { list: 'LP_ASAP' }, nowMs: at('2026-10-05T12:35:00Z'), cfg });
  assert.equal(at820.reason, 'queued_elsewhere');
  assert.deepEqual(at835, { action: 'push', reason: 'queued_not_dialed' });
  const off = backstopConfig({ NEW_LEAD_BACKSTOP_PUSH_STALE_QUEUED: 'false' });
  assert.equal(finalDecision({ pre, row: r, onDnc: false, contact: { list: 'LP_ASAP' }, nowMs: at('2026-10-05T12:35:00Z'), cfg: off }).action, 'skip');
});

/* --- calls ------------------------------------------------------------------------------ */

test('wasCalled: an outbound call counts; a missed inbound does not; a call before arrival does not', () => {
  const r = row('kathy');
  const after = '2026-10-05T12:10:00Z';
  assert.equal(wasCalled([{ dnis: r.phone, ani: '5615591936', disposition_name: 'Answering Machine', received_at: after }], r.phone, r.receivedMs), true);
  assert.equal(wasCalled([{ dnis: '8005551212', ani: r.phone, disposition_name: 'Abandon', received_at: after }], r.phone, r.receivedMs), false);
  assert.equal(wasCalled([{ dnis: '8005551212', ani: r.phone, disposition_name: 'Not Interested', received_at: after }], r.phone, r.receivedMs), true);
  assert.equal(wasCalled([{ dnis: r.phone, ani: 'x', disposition_name: 'NA', received_at: '2026-10-03T12:00:00Z' }], r.phone, r.receivedMs), false);
});

test('dial window: 8:00–19:45 ET', () => {
  assert.equal(inDialWindow(at('2026-10-05T11:59:00Z')), false); // 7:59 AM
  assert.equal(inDialWindow(at('2026-10-05T12:00:00Z')), true);
  assert.equal(inDialWindow(at('2026-10-05T23:44:00Z')), true);  // 7:44 PM
  assert.equal(inDialWindow(at('2026-10-05T23:46:00Z')), false);
});

/* --- record & card ------------------------------------------------------------------------ */

test('record: CustID, lead_id, LPRecKey INQ<in1>, GHL id as call_ID, no garbage state', () => {
  const rec = buildBackstopRecord(row('daniel'), { city: 'Immokalee', state: 'nu', zip: '34142  ' });
  const m = Object.fromEntries(rec.fieldNames.map((f, i) => [f, rec.values[i]]));
  assert.equal(m.number1, '2392500011');
  assert.equal(m.CustID, '462947');
  assert.equal(m.lead_id, '581084');
  assert.equal(m.LPRecKey, 'INQ428372');
  assert.equal(m.call_ID, 'LgCeHyniTQPfrnT4Ga7j');
  assert.equal(m.city, 'Immokalee');
  assert.equal(m.zip, '34142');
  assert.equal(m.state, undefined, '"nu" is not a state');
});

test('card names the lead, the visit and the list — no rule codes', () => {
  const r = row('daniel');
  const text = formatPushedCard([{ row: r, list: 'Conf - Next Day', state: currentState(r, null) }]);
  assert.match(text, /Daniel · \(239\) 250-0011 · visit Mon, 10\/5, 2:00 PM → Conf - Next Day \(LP lead 581084\)/);
  assert.doesNotMatch(text, /not_on_dial_list|NEW_LEAD/);
});

/* --- the pass ------------------------------------------------------------------------------- */

function five9Contact(list) {
  return { records: [{ fields: ['number1', 'f9_last_list', 'lead_id', 'Contact create time and date'], records: [{ values: { data: ['x', list, '', '2026-10-04 23:18:08.000'] } }] }] };
}

function harness({ mode = 'shadow', calls = [], leads = [], marks = [], onDnc = [], lists = {}, insertError = null, slackOk = true } = {}) {
  const state = { marks: new Set(marks), actions: [], posts: [], alerts: [], deleted: [] };
  const supabase = {
    from(table) {
      const api = {
        _table: table,
        select() { return api; },
        in(col, keys) {
          if (api._delete) { keys.forEach((k) => { state.marks.delete(k); state.deleted.push(k); }); return Promise.resolve({ error: null }); }
          return Promise.resolve({ data: keys.filter((k) => state.marks.has(k)).map((k) => ({ dedup_key: k })), error: null });
        },
        upsert(row) {
          const won = !state.marks.has(row.dedup_key);
          if (won) state.marks.add(row.dedup_key);
          return { select: () => Promise.resolve({ data: won ? [{ dedup_key: row.dedup_key }] : [], error: null }) };
        },
        insert(row) {
          return { select: () => ({ single: () => {
            if (insertError) return Promise.resolve({ data: null, error: { message: insertError } });
            state.actions.push(row);
            return Promise.resolve({ data: { id: 900 + state.actions.length }, error: null });
          } }) };
        },
        delete() { api._delete = true; return api; },
      };
      return api;
    },
  };
  const deps = {
    listInboundLeads: async () => Object.values(RAW),
    runSQL: async (sql) => (sql.includes('five9_events_raw') ? calls : leads),
    supabase,
    checkDnc: async (nums) => ({ on_dnc: nums.filter((n) => onDnc.includes(n)) }),
    getContactRecords: async ({ criteria }) => five9Contact(lists[criteria[0].value] ?? ''),
    postToSlack: async (text, ch) => { state.posts.push({ text, ch }); return slackOk ? { ok: true } : { ok: false, error: 'channel_not_found' }; },
    reportAlertCondition: async (a) => { state.alerts.push(a); return {}; },
  };
  const env = { NEW_LEAD_DIAL_BACKSTOP_MODE: mode, SLACK_CHANNEL_SERVICE: 'CCENTER' };
  return { state, run: (nowMs = MON_1015) => runNewLeadDialBackstop({ env, nowMs, deps }) };
}

test('replay 10/5 10:15 ET: shadow would push all four, writes nothing, posts nothing', async () => {
  const h = harness();
  const res = await h.run();
  assert.equal(res.ok, true);
  assert.equal(res.counts.would_push, 4);
  assert.deepEqual(res.decisions.filter((x) => x.result.startsWith('would_push')).map((x) => [x.in1, x.list]).sort(),
    [['428370', 'Callback Request'], ['428371', 'Callback Request'], ['428372', 'Conf - Next Day'], ['428375', 'Callback Request']]);
  assert.equal(h.state.actions.length, 0);
  assert.equal(h.state.posts.length, 0);
  assert.equal(h.state.alerts.length, 0);
});

test('live: pushes once, one card, and the next pass pushes nothing', async () => {
  const h = harness({ mode: 'live' });
  const first = await h.run();
  assert.equal(first.pushed, 4);
  assert.equal(h.state.actions.length, 4);
  const daniel = h.state.actions.find((a) => a.target_id === 'Conf - Next Day');
  assert.equal(daniel.action_type, 'five9_add_records_to_list');
  assert.equal(daniel.requires_approval, false);
  assert.equal(h.state.posts.length, 1);
  assert.equal(h.state.posts[0].ch, 'CCENTER');
  assert.equal(h.state.alerts.at(-1).active, false);
  const second = await h.run(MON_1015 + 5 * 60000);
  assert.equal(second.pushed, 0);
  assert.equal(h.state.actions.length, 4);
  assert.equal(h.state.posts.length, 1, 'no card when nothing was pushed');
});

test('live: called, DNC and already-listed rows are left alone', async () => {
  const h = harness({
    mode: 'live',
    calls: [{ dnis: '9515155283', ani: '5615591936', disposition_name: 'Answering Machine', received_at: '2026-10-05T12:05:00Z' }],
    onDnc: ['3864574523'],
    lists: { 3522742458: 'Callback Request' },
  });
  const res = await h.run();
  assert.equal(res.pushed, 1);
  assert.equal(h.state.actions[0].target_id, 'Conf - Next Day');
  assert.equal(res.counts.called, 1);
  assert.equal(res.counts.dnc, 1);
  assert.equal(res.counts.already_on_target_list, 1);
});

test('a failed insert releases the claim so the next pass retries', async () => {
  const h = harness({ mode: 'live', insertError: 'db down' });
  const res = await h.run();
  assert.equal(res.ok, false);
  assert.equal(h.state.marks.size, 0, 'no claim left behind');
  assert.equal(h.state.alerts.at(-1).active, true);
});

test('an unreadable call history pushes nothing (fail closed)', async () => {
  const h = harness({ mode: 'live' });
  const res = await runNewLeadDialBackstop({
    env: { NEW_LEAD_DIAL_BACKSTOP_MODE: 'live' }, nowMs: MON_1015,
    deps: { ...h, listInboundLeads: async () => Object.values(RAW), runSQL: async () => { throw new Error('timeout'); }, supabase: {}, postToSlack: async () => ({ ok: true }), reportAlertCondition: async () => ({}) },
  });
  assert.equal(res.ok, false);
  assert.equal(res.insufficient_evidence, true);
  assert.equal(res.pushed, 0);
});

test('outside the dial window the pass does nothing', async () => {
  const h = harness({ mode: 'live' });
  const res = await h.run(at('2026-10-05T03:00:00Z'));
  assert.equal(res.skipped, true);
  assert.equal(h.state.actions.length, 0);
});

test('a failed #contact-center post raises the ops alarm', async () => {
  const h = harness({ mode: 'live', slackOk: false });
  const res = await h.run();
  assert.equal(res.ok, false);
  assert.equal(h.state.alerts.at(-1).active, true);
});
