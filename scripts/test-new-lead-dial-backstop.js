/**
 * New-lead dial backstop. Every imported, never-called LP lead reaches a Five9
 * list. 2026-10-05: Conf - Next Day / Conf - 2nd Day / Callback Request.
 * 2026-10-06 (the user's ruling): with no appointment and no callback request,
 * a DIAL ASAP list ("Reece Chatbot" / "Direct Lead Entry") while the Five9
 * record is ≤ 14h old, else "Callback Request"; every 5 min, 24/7.
 *
 * Fixtures: the 10/5 evening rows (in1 428370/428371/428372/428375) and the
 * four the job never saw on 10/5–10/6 because LP's page 3 came back with 199
 * rows (in1 428729 Donna, 428728 Joey — Reece ChatBot; 428731 Anthony,
 * 428733 Lori — Google PPC).
 *
 * Run: node --test scripts/test-new-lead-dial-backstop.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  backstopMode, backstopConfig, normalizeInboundRow, rowFromLead, currentState, routeList, routeNoAppt,
  prefilter, finalDecision, buildBackstopRecord, pushedLine, markKey, phoneDayKey,
  etDateKey, lpDateToKey, lpTimeToHHMM, unhandledLeads, formatUnhandledCard, isChatbotLead,
} from '../src/new-lead-dial-backstop.js';
import {
  runNewLeadDialBackstop, wasCalled, inDialWindow, readInboundRows,
} from '../src/jobs/new-lead-dial-backstop.js';
import { executeAddRecordsToList } from '../src/five9/admin-writes.js';
import { summarizeContactRecord, five9UtcMs } from '../src/lead-leak-classify.js';

const cfg = backstopConfig({});
const MON_1015 = Date.parse('2026-10-05T14:15:00Z'); // 10:15 AM EDT
const at = (iso) => Date.parse(iso);

// 10/4 evening rows exactly as GetInboundLeadInfo returned them after import.
const RAW = {
  kathy:  { id: '428370', firstname: 'Kathy', lastname: 'Johnson', address1: '2743 Arugula Dr, North Port, FL, US', phone: '(951)515-5283', brn_id: 'SAR', cst_id: '462954', lds_id: '581093', dsp_id: 'Data', apptdate: '', appttime: '', datereceived: '2026-10-04T19:18:07.697', lognumber: '', killreason: '', source: 'Internet', sourcesubdescr: 'Modernize' },
  robert: { id: '428371', firstname: 'Robert', lastname: 'Parsons', address1: '19 Emerald Ln', phone: '(386)457-4523', brn_id: 'JAX', cst_id: '416072', lds_id: '581094', dsp_id: 'Data', apptdate: '', appttime: '', datereceived: '2026-10-04T19:29:33.627', lognumber: '', killreason: '', source: 'Internet', sourcesubdescr: 'Lead Gurus' },
  daniel: { id: '428372', firstname: 'Daniel', lastname: '', address1: '3418 Westclox St', phone: '(239)250-0011', brn_id: 'FTMYR', cst_id: '462947', lds_id: '581084', dsp_id: 'Set', apptdate: '10/05/2026', appttime: '2:00 PM', datereceived: '2026-10-04T19:36:29.977', lognumber: 'LgCeHyniTQPfrnT4Ga7j', killreason: '', source: 'Website', sourcesubdescr: 'Reece ChatBot' },
  jimmie: { id: '428375', firstname: 'Jimmie ', lastname: 'Williams ', address1: '', phone: '(352)274-2458', brn_id: 'ORL', cst_id: '462957', lds_id: '581097', dsp_id: 'Data', apptdate: '', appttime: '', datereceived: '2026-10-04T19:45:29.713', lognumber: '', killreason: '', source: 'Simpletext', sourcesubdescr: 'WIRK-now' },
};
// The four the 199-row page hid (10/5–10/6), as LP returns them.
const MISSED = {
  donna:   { id: '428729', firstname: 'Donna', lastname: '', address1: '', phone: '(662)312-5252', brn_id: 'SAR', source: 'Website', sourcesubdescr: 'Reece ChatBot', cst_id: '463200', lds_id: '581413', dsp_id: 'Data', apptdate: '', appttime: '', datereceived: '2026-10-05T23:18:28.043', lognumber: '6Y6iK8eJU4RZYQShYpSb', method: 'A', killreason: '' },
  joey:    { id: '428728', firstname: 'Joey', lastname: 'Brown', address1: '', phone: '(904)679-8884', brn_id: 'JAX', source: 'Website', sourcesubdescr: 'Reece ChatBot', cst_id: '463201', lds_id: '581414', dsp_id: 'Data', apptdate: '', appttime: '', datereceived: '2026-10-05T23:18:29.100', lognumber: 'qavkyMokaedoSaLUl1yy', method: 'A', killreason: '' },
  anthony: { id: '428731', firstname: 'Anthony', lastname: 'Roldan', address1: '', phone: '(772)237-4989', brn_id: 'STUART', source: 'Internet', sourcesubdescr: 'Google PPC Windows', cst_id: '463202', lds_id: '581415', dsp_id: 'Data', apptdate: '', appttime: '', datereceived: '2026-10-06T00:04:14.360', lognumber: 'tam9lfiXwMOUfT6eGM3e', method: 'A', killreason: '' },
  lori:    { id: '428733', firstname: 'Lori', lastname: 'Brannon', address1: '', phone: '(863)944-6117', brn_id: 'ORL', source: 'Internet', sourcesubdescr: 'Google PPC Windows', cst_id: '463203', lds_id: '581416', dsp_id: 'Data', apptdate: '', appttime: '', datereceived: '2026-10-06T02:04:05.873', lognumber: 'jmTZjkqNjfkXmUACpEqY', method: 'A', killreason: '' },
};
const row = (k, over = {}) => normalizeInboundRow({ ...(RAW[k] || MISSED[k]), ...over });

/* --- config & parsing ------------------------------------------------------ */

test('mode defaults to shadow; typos are shadow, never live', () => {
  assert.equal(backstopMode({}), 'shadow');
  assert.equal(backstopMode({ NEW_LEAD_DIAL_BACKSTOP_MODE: 'LIVE' }), 'live');
  assert.equal(backstopMode({ NEW_LEAD_DIAL_BACKSTOP_MODE: 'lvie' }), 'shadow');
  assert.equal(backstopMode({ NEW_LEAD_DIAL_BACKSTOP_MODE: 'off' }), 'off');
});

test('the lists are the user ruling; every one of them refuses LP_ASAP', () => {
  assert.deepEqual(cfg.lists, {
    nextDay: 'Conf - Next Day', secondDay: 'Conf - 2nd Day', noAppt: 'Callback Request',
    chatbot: 'Reece Chatbot', direct: 'Direct Lead Entry',
  });
  assert.equal(cfg.dialAsapMaxAgeH, 14);
  for (const k of ['NO_APPT', 'CHATBOT', 'DIRECT', 'NEXT_DAY']) {
    assert.throws(() => backstopConfig({ [`NEW_LEAD_BACKSTOP_LIST_${k}`]: 'lp_asap' }), /LP_ASAP/, k);
  }
  const custom = backstopConfig({ NEW_LEAD_BACKSTOP_LIST_CHATBOT: 'Bot', NEW_LEAD_BACKSTOP_DIAL_ASAP_MAX_AGE_H: '16' });
  assert.equal(custom.lists.chatbot, 'Bot');
  assert.equal(custom.dialAsapMaxAgeH, 16);
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
  assert.equal(new Date(row('donna').receivedMs).toISOString(), '2026-10-06T03:18:28.043Z');
});

test('Five9 times are UTC: Donna arrived 23:18 EDT, her record says 03:18:29', () => {
  assert.equal(five9UtcMs('2026-10-06 03:18:29.000'), at('2026-10-06T03:18:29Z'));
  assert.equal(five9UtcMs(''), null);
  const s = summarizeContactRecord({ records: [{
    fields: ['number1', 'Contact create time and date', 'lead_id', 'Number of attempts', 'f9_last_list', 'f9_last_dispo_date_time'],
    records: { values: { data: ['6623125252', '2026-10-06 03:18:29.000', '581413', '00000', 'LP_ASAP', ''] } },
  }] }, '581413');
  assert.equal(s.createdMs, at('2026-10-06T03:18:29Z'));
  assert.equal(s.lastDispoMs, null);
  assert.equal(s.attempts, 0);
  assert.equal(s.list, 'LP_ASAP');
});

test('the chatbot source is read from LP (sourcesubdescr) or lp_leads, any case', () => {
  assert.equal(isChatbotLead(row('donna')), true);
  assert.equal(isChatbotLead(row('anthony')), false);
  assert.equal(isChatbotLead(row('kathy', { sourcesubdescr: '' }), { lead_source_detail: 'reece chatbot' }), true);
});

/* --- routing ----------------------------------------------------------------- */

const R = (date, time, nowMs = MON_1015) => {
  const startMs = time ? Date.parse(`${date}T${time}:00-04:00`) : null;
  return routeList({ hasAppt: true, apptDateEt: date, apptStartMs: startMs, nowMs, cfg });
};

test('routing: today/tomorrow → Next Day, 2+ days → 2nd Day, none → decided by the Five9 record', () => {
  assert.equal(R('2026-10-05', '14:00').list, 'Conf - Next Day');
  assert.equal(R('2026-10-06', '10:00').list, 'Conf - Next Day');
  assert.equal(R('2026-10-07', '10:00').list, 'Conf - 2nd Day');
  assert.equal(R('2026-10-15', '18:00').list, 'Conf - 2nd Day');
  assert.equal(routeList({ hasAppt: false, nowMs: MON_1015, cfg }).dialAsap, true);
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

test('no appointment: DIAL ASAP list by source while the record is ≤ 14h old, else Callback Request', () => {
  const n = (k, contact, nowMs) => routeNoAppt({ row: row(k), contact, nowMs, cfg }).list;
  const night = at('2026-10-06T06:30:00Z'); // 2:30 AM EDT
  assert.equal(n('donna', null, night), 'Reece Chatbot', 'no record yet = age 0');
  assert.equal(n('anthony', null, night), 'Direct Lead Entry');
  const rec = { createdMs: at('2026-10-06T03:18:29Z') };
  assert.equal(n('donna', rec, at('2026-10-06T12:30:00Z')), 'Reece Chatbot', '8:30 AM: 9.2h old');
  assert.equal(n('donna', rec, at('2026-10-06T17:30:00Z')), 'Callback Request', '1:30 PM: 14.2h old');
  // A record whose create time cannot be read is aged from the arrival.
  assert.equal(n('donna', { createdMs: null }, at('2026-10-06T17:30:00Z')), 'Callback Request');
  assert.equal(routeNoAppt({ row: row('donna'), contact: rec, nowMs: at('2026-10-06T17:30:00Z'), cfg: backstopConfig({ NEW_LEAD_BACKSTOP_DIAL_ASAP_MAX_AGE_H: '16' }) }).list, 'Reece Chatbot');
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

test('an lp_leads row the queue read missed reads like an inbound row', () => {
  const r = rowFromLead({
    lp_lead_id: '581413', lp_prospect_id: '463200', in1_id: '428729', phone: '6623125252', first_name: 'Donna',
    disposition_code: 'Data', created_at_lp: '2026-10-05 23:18:28.793+00', datereceived: null,
    lead_source: 'Website', lead_source_detail: 'Reece ChatBot', ghl_contact_id: '6Y6iK8eJU4RZYQShYpSb',
  });
  assert.equal(r.in1, '428729');
  assert.equal(r.ldsId, '581413');
  assert.equal(r.cstId, '463200');
  assert.equal(new Date(r.receivedMs).toISOString(), '2026-10-06T03:18:28.000Z');
  assert.equal(r.lognumber, '6Y6iK8eJU4RZYQShYpSb');
  assert.equal(isChatbotLead(r), true);
});

/* --- prefilter ------------------------------------------------------------------ */

const P = (r, o = {}) => prefilter({ row: r, lead: null, called: false, marks: new Set(), nowMs: MON_1015, cfg, ...o });

test('the 10/4 evening rows are candidates; no-appointment ones wait for the Five9 record', () => {
  assert.deepEqual([P(row('kathy')).dialAsap, P(row('robert')).dialAsap, P(row('daniel')).list, P(row('jimmie')).dialAsap],
    [true, true, 'Conf - Next Day', true]);
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
  assert.equal(P(row('kathy'), { sold: true }).reason, 'sold');
  assert.equal(P(row('daniel'), { lead: { disposition_code: 'CXL' } }).reason, 'dead_disposition');
  assert.equal(P(row('daniel'), { lead: { disposition_code: 'Cnf', appointment_date: '2026-10-05 14:00:00+00' } }).reason, 'progressed');
  assert.equal(P(row('daniel'), { nowMs: at('2026-10-05T18:30:00Z') }).reason, 'past_appointment');
  assert.equal(P(row('kathy'), { callbackRequested: true }).reason, 'callback_requested');
  assert.equal(P(row('kathy'), { marks: new Set([markKey('428370', 'Callback Request')]) }).reason, 'already_pushed');
  assert.equal(P(row('kathy'), { marks: new Set([markKey('428370', 'Direct Lead Entry')]) }).reason, 'already_pushed');
  assert.equal(P(row('kathy'), { marks: new Set([phoneDayKey('9515155283', '2026-10-05')]) }).reason, 'already_pushed');
});

test('an appointment beats a callback request (rule 1 before rule 2)', () => {
  assert.equal(P(row('daniel'), { callbackRequested: true }).list, 'Conf - Next Day');
});

test('precedence: killed beats called; called beats awaiting import; sold beats a booked visit', () => {
  assert.equal(P(row('kathy', { killreason: 'x' }), { called: true }).reason, 'killed');
  assert.equal(P(row('kathy', { lds_id: '' }), { called: true }).reason, 'called');
  assert.equal(P(row('daniel'), { sold: true }).reason, 'sold');
});

/* --- final decision ----------------------------------------------------------------- */

const F = (o) => {
  const r = o.row || row('kathy');
  const pre = P(r);
  return finalDecision({ pre, row: r, onDnc: false, contact: null, nowMs: MON_1015, cfg, ...o });
};

test('final: DNC unreadable waits, DNC skips, a failed lookup waits (fail closed), no list pushes', () => {
  assert.equal(F({ onDnc: null }).reason, 'dnc_unreadable');
  assert.equal(F({ onDnc: true }).reason, 'dnc');
  assert.deepEqual([F({ contact: 'error' }).action, F({ contact: 'error' }).reason], ['wait', 'five9_record_unreadable']);
  assert.deepEqual([F({ contact: null }).action, F({ contact: null }).list], ['push', 'Direct Lead Entry']);
  assert.equal(F({ contact: { list: null, attempts: 0 } }).reason, 'not_on_dial_list');
});

test('final: Five9 attempts on this lead skip; attempts from an older lead on the number do not', () => {
  assert.equal(F({ contact: { list: null, attempts: 1, lastDispoMs: MON_1015 - 60_000 } }).reason, 'five9_attempted');
  assert.equal(F({ contact: { list: null, attempts: 1, lastDispoMs: null } }).reason, 'five9_attempted');
  const old = F({ contact: { list: null, attempts: 4, lastDispoMs: at('2026-08-01T15:00:00Z'), createdMs: at('2026-08-01T14:00:00Z') } });
  assert.deepEqual([old.action, old.list], ['push', 'Callback Request'], 'old record: too old for DIAL ASAP');
});

test('final: already on our list skips; the two DIAL ASAP lists are one campaign', () => {
  const fresh = MON_1015 - 3600_000;
  assert.equal(F({ contact: { list: 'Direct Lead Entry', attempts: 0, createdMs: fresh } }).reason, 'already_on_target_list');
  assert.equal(F({ contact: { list: 'Reece Chatbot', attempts: 0, createdMs: fresh } }).reason, 'already_on_target_list');
  // The same record 15h old: DIAL ASAP would screen it out, so it moves to Callback Request after the grace.
  assert.equal(F({ contact: { list: 'Direct Lead Entry', attempts: 0 } }).list, 'Callback Request');
});

test('final: on LP_ASAP with 0 attempts waits 30 dial minutes, then pushes to the routed list', () => {
  // An overnight row on LP_ASAP: dialable from 8:00 ET.
  const r = row('kathy', { datereceived: '2026-10-05T01:00:00' });
  const pre = prefilter({ row: r, called: false, marks: new Set(), nowMs: at('2026-10-05T12:20:00Z'), cfg });
  const lpAsap = { list: 'LP_ASAP', attempts: 0, createdMs: at('2026-10-05T05:00:05Z') };
  const at820 = finalDecision({ pre, row: r, onDnc: false, contact: lpAsap, nowMs: at('2026-10-05T12:20:00Z'), cfg });
  const at835 = finalDecision({ pre, row: r, onDnc: false, contact: lpAsap, nowMs: at('2026-10-05T12:35:00Z'), cfg });
  assert.equal(at820.reason, 'queued_elsewhere');
  assert.equal(at820.action, 'wait');
  assert.deepEqual([at835.action, at835.reason, at835.list], ['push', 'queued_not_dialed', 'Direct Lead Entry']);
  const off = backstopConfig({ NEW_LEAD_BACKSTOP_PUSH_STALE_QUEUED: 'false' });
  assert.equal(finalDecision({ pre, row: r, onDnc: false, contact: lpAsap, nowMs: at('2026-10-05T12:35:00Z'), cfg: off }).action, 'skip');
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

/* --- the LP read: the root cause of 10/6 ------------------------------------------------- */

const fakeLp = (sizes) => {
  const calls = [];
  const fn = async ({ page }) => { calls.push(page); return Array.from({ length: sizes[page - 1] ?? 0 }, (_, i) => ({ id: `${page}-${i}` })); };
  return { fn, calls };
};

test('a short page in the middle is NOT the end: LP pages by id blocks (page 3 had 199 rows)', async () => {
  const lp = fakeLp([200, 200, 199, 200, 102]);
  const rows = await readInboundRows(lp.fn, MON_1015, 72);
  assert.equal(rows.length, 901);
  assert.deepEqual(lp.calls, [1, 2, 3, 4, 5, 6], 'reads until an empty page');
});

test('a read that never ends is refused, never accepted partially', async () => {
  await assert.rejects(readInboundRows(async () => [{ id: 'x' }], MON_1015, 72), /refusing a partial read/);
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

test('the stored push line names the lead, the visit and the list — no rule codes', () => {
  const r = row('daniel');
  const text = pushedLine({ row: r, list: 'Conf - Next Day', state: currentState(r, null) });
  assert.match(text, /Daniel · \(239\) 250-0011 · visit Mon, 10\/5, 2:00 PM → Conf - Next Day \(LP lead 581084\)/);
  assert.doesNotMatch(text, /not_on_dial_list|NEW_LEAD/);
});

/* --- the pass ------------------------------------------------------------------------------- */

function five9Contact(c) {
  if (!c) return { records: [] };
  return { records: [{
    fields: ['number1', 'f9_last_list', 'lead_id', 'Contact create time and date', 'Number of attempts', 'f9_last_dispo_date_time'],
    records: [{ values: { data: ['x', c.list ?? '', '', c.created ?? '', c.attempts ?? '0', c.lastDispo ?? ''] } }],
  }] };
}

function harness({
  mode = 'shadow', inbound = Object.values(RAW), windowLeads = [], calls = [], soldPhones = [], callbackRows = [],
  marks = [], onDnc = [], contacts = {}, insertError = null, slackOk = true, dncThrows = false, contactThrows = false,
} = {}) {
  const state = { marks: new Set(marks), actions: [], posts: [], alerts: [], ops: [], posted: new Set(), deleted: [] };
  const supabase = {
    from(table) {
      const api = {
        _table: table,
        select() { return api; },
        in(col, keys) {
          if (api._delete) { keys.forEach((k) => { state.marks.delete(k); state.deleted.push(k); }); return Promise.resolve({ error: null }); }
          return Promise.resolve({ data: keys.filter((k) => state.marks.has(k)).map((k) => ({ dedup_key: k })), error: null });
        },
        upsert(r) {
          const won = !state.marks.has(r.dedup_key);
          if (won) state.marks.add(r.dedup_key);
          return { select: () => Promise.resolve({ data: won ? [{ dedup_key: r.dedup_key }] : [], error: null }) };
        },
        insert(r) {
          return { select: () => ({ single: () => {
            if (insertError) return Promise.resolve({ data: null, error: { message: insertError } });
            state.actions.push(r);
            return Promise.resolve({ data: { id: 900 + state.actions.length }, error: null });
          } }) };
        },
        delete() { api._delete = true; return api; },
      };
      return api;
    },
  };
  const runSQL = async (sql) => {
    if (sql.includes('five9_events_raw')) return calls;
    if (sql.includes('closed_won = true')) return soldPhones.map((p) => ({ phone10: p }));
    if (sql.includes('lp_callback_requeue')) return callbackRows;
    if (sql.includes('created_at_lp >=')) return windowLeads;
    if (sql.includes('lp_lead_id IN')) return [];
    throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
  };
  const deps = {
    listInboundLeads: async ({ page }) => (page === 1 ? inbound : []),
    runSQL,
    supabase,
    checkDnc: async (nums) => { if (dncThrows) throw new Error('soap fault'); return { on_dnc: nums.filter((n) => onDnc.includes(n)) }; },
    getContactRecords: async ({ criteria }) => { if (contactThrows) throw new Error('timeout'); return five9Contact(contacts[criteria[0].value]); },
    postToSlack: async (text, ch) => { state.posts.push({ text, ch }); return slackOk ? { ok: true } : { ok: false, error: 'channel_not_found' }; },
    reportAlertCondition: async (a) => { state.alerts.push(a); return {}; },
    sendAlertMessage: async (text, opts) => { state.ops.push({ text, opts }); return { sent: true }; },
    filterNew: async ({ items }) => ({ fresh: items.filter((i) => !state.posted.has(`${i.key}|${i.reason}`)), dedupe: 'ok' }),
    recordPosted: async ({ items }) => { items.forEach((i) => state.posted.add(`${i.key}|${i.reason}`)); return { ok: true }; },
  };
  const env = { NEW_LEAD_DIAL_BACKSTOP_MODE: mode, SLACK_CHANNEL_SERVICE: 'CCENTER' };
  return { state, deps, run: (nowMs = MON_1015) => runNewLeadDialBackstop({ env, nowMs, deps }) };
}

test('replay 10/5 10:15 ET: shadow would push all four, writes nothing, posts nothing', async () => {
  const h = harness();
  const res = await h.run();
  assert.equal(res.ok, true);
  assert.equal(res.counts.would_push, 4);
  assert.deepEqual(res.decisions.filter((x) => x.result === 'would_push').map((x) => [x.in1, x.list]).sort(),
    [['428370', 'Direct Lead Entry'], ['428371', 'Direct Lead Entry'], ['428372', 'Conf - Next Day'], ['428375', 'Direct Lead Entry']]);
  assert.equal(h.state.actions.length, 0);
  assert.equal(h.state.posts.length, 0);
  assert.equal(h.state.alerts.length, 0);
});

test('live: pushes once, posts nothing to #contact-center, and the next pass pushes nothing', async () => {
  const h = harness({ mode: 'live' });
  const first = await h.run();
  assert.equal(first.pushed, 4);
  assert.equal(h.state.actions.length, 4);
  const daniel = h.state.actions.find((a) => a.target_id === 'Conf - Next Day');
  assert.equal(daniel.action_type, 'five9_add_records_to_list');
  assert.equal(daniel.requires_approval, false);
  assert.equal(daniel.action_payload.card_held, false);
  assert.match(daniel.action_payload.card_line, /Daniel .* → Conf - Next Day \(LP lead 581084\)/, 'the push stays readable on its row');
  assert.equal(h.state.posts.length, 0, 'Mark 2026-10-07: the system fixed it, nobody has to act');
  assert.equal(h.state.alerts.at(-1).active, false);
  const second = await h.run(MON_1015 + 5 * 60000);
  assert.equal(second.pushed, 0);
  assert.equal(h.state.actions.length, 4);
  assert.equal(h.state.posts.length, 0);
});

test('every decision is logged by reason, including called / killed / no_phone', async () => {
  const h = harness({
    inbound: [RAW.kathy, { ...RAW.robert, killreason: 'Duplicate' }, { ...RAW.jimmie, phone: '' }, RAW.daniel],
    calls: [{ dnis: '9515155283', ani: '5615591936', disposition_name: 'NA', received_at: '2026-10-05T12:05:00Z' }],
  });
  const res = await h.run();
  assert.deepEqual(res.by_reason.called, ['581093']);
  assert.deepEqual(res.by_reason.killed, ['581094']);
  assert.deepEqual(res.by_reason.no_phone, ['581097']);
  assert.deepEqual(res.by_reason.would_push, ['581084']);
});

/* The four the 199-row page hid. Five9 state as found: no list, 0 attempts. */
const missedHarness = (o = {}) => harness({ inbound: Object.values(MISSED), ...o });

test('the 4 missed leads, pushed the same night: chatbot → Reece Chatbot, Google PPC → Direct Lead Entry', async () => {
  const h = missedHarness({ mode: 'live' });
  const res = await h.run(at('2026-10-06T06:30:00Z')); // 2:30 AM EDT; Lori is 26 min old
  assert.equal(res.ok, true);
  assert.equal(res.dial_window_open, false);
  assert.deepEqual(h.state.actions.map((a) => [a.action_payload.records[0][0], a.target_id]).sort(), [
    ['6623125252', 'Reece Chatbot'], ['7722374989', 'Direct Lead Entry'], ['8639446117', 'Direct Lead Entry'], ['9046798884', 'Reece Chatbot'],
  ]);
  assert.ok(h.state.actions.every((a) => a.action_payload.card_held === true));
  assert.equal(h.state.posts.length, 0);

  // 8:00 ET: no overnight card any more (Mark, 2026-10-07).
  await h.run(at('2026-10-06T12:00:00Z'));
  await h.run(at('2026-10-06T12:05:00Z'));
  assert.equal(h.state.posts.length, 0, 'no 8 AM "put on a list" card');
  assert.ok(![...h.state.marks].some((k) => k.startsWith('dial-backstop-overnight-card:')));
});

test('evening chatbot leads not pushed overnight: > 14h old record at the morning pass → Callback Request', async () => {
  // Arrived 5:40 PM EDT; LP made the Five9 record then and left it on no list.
  const evening = (k, t) => ({ ...MISSED[k], datereceived: `2026-10-05T${t}` });
  const contacts = {
    6623125252: { created: '2026-10-05 21:40:00.000' },
    9046798884: { created: '2026-10-05 21:41:00.000' },
  };
  const h = harness({ mode: 'live', inbound: [evening('donna', '17:40:00'), evening('joey', '17:41:00')], contacts });
  await h.run(at('2026-10-06T12:00:00Z')); // 8:00 AM: 14.3h after the record
  assert.deepEqual(h.state.actions.map((a) => a.target_id), ['Callback Request', 'Callback Request']);
});

test('the real Donna at the 8:30 AM pass, still on LP_ASAP with 0 attempts → Reece Chatbot', async () => {
  const h = missedHarness({
    mode: 'live', inbound: [MISSED.donna],
    contacts: { 6623125252: { list: 'LP_ASAP', created: '2026-10-06 03:18:29.000', attempts: '00000' } },
  });
  const at820 = await h.run(at('2026-10-06T12:20:00Z'));
  assert.equal(at820.counts.queued_elsewhere, 1, 'LP_ASAP gets its 30 dial minutes first');
  await h.run(at('2026-10-06T12:30:00Z'));
  assert.deepEqual(h.state.actions.map((a) => a.target_id), ['Reece Chatbot']);
});

test('a lead the LP queue read missed is decided from lp_leads (second source)', async () => {
  const h = harness({
    mode: 'shadow', inbound: [],
    windowLeads: [{
      lp_lead_id: '581415', lp_prospect_id: '463202', in1_id: '428731', phone: '7722374989', first_name: 'Anthony', last_name: 'Roldan',
      disposition_code: 'Data', appointment_date: null, created_at_lp: '2026-10-06 00:04:14.36+00', datereceived: '2026-10-06T00:04:14.360',
      lognumber: '', ghl_contact_id: 'tam9lfiXwMOUfT6eGM3e', lead_source: 'Internet', lead_source_detail: 'Google PPC Windows',
    }],
  });
  h.deps.runSQL = ((orig) => async (sql) => (sql.includes('created_at_lp >=')
    ? [...(await orig(sql)), { lp_lead_id: '581511', in1_id: '', phone: '5615555984', lp_prospect_id: '1', disposition_code: 'Set', created_at_lp: '2026-10-06 07:29:25+00' }]
    : orig(sql)))(h.deps.runSQL);
  const res = await h.run(at('2026-10-06T12:30:00Z'));
  assert.equal(res.counts.from_lp_leads, 1, 'a lead typed into LP by hand (no in1) is not this job\'s');
  assert.deepEqual(res.decisions.map((x) => [x.lds, x.result, x.list, x.source]), [['581415', 'would_push', 'Direct Lead Entry', 'lp_leads']]);
});

test('a lead that asked for a callback is left to the callback path', async () => {
  const h = missedHarness({
    mode: 'live',
    callbackRows: [
      { action_type: 'lp_callback_requeue', target_id: '6Y6iK8eJU4RZYQShYpSb', payload: '{}' },
      { action_type: 'five9_add_records_to_list', target_id: 'Callback Request', payload: '{"records":[["7722374989","Anthony"]]}' },
    ],
  });
  const res = await h.run(at('2026-10-06T12:30:00Z'));
  assert.deepEqual(res.by_reason.callback_requested.sort(), ['581413', '581415']);
  assert.ok(!h.state.actions.some((a) => ['6623125252', '7722374989'].includes(a.action_payload.records[0][0])));
});

test('a sold customer and a DNC number are never pushed', async () => {
  const h = missedHarness({ mode: 'live', soldPhones: ['9046798884'], onDnc: ['8639446117'] });
  const res = await h.run(at('2026-10-06T12:30:00Z'));
  assert.deepEqual(res.by_reason.sold, ['581414']);
  assert.deepEqual(res.by_reason.dnc, ['581416']);
  assert.equal(h.state.actions.length, 2);
});

test('live: called, DNC and already-listed rows are left alone', async () => {
  const h = harness({
    mode: 'live',
    calls: [{ dnis: '9515155283', ani: '5615591936', disposition_name: 'Answering Machine', received_at: '2026-10-05T12:05:00Z' }],
    onDnc: ['3864574523'],
    contacts: { 3522742458: { list: 'Direct Lead Entry', created: '2026-10-05 13:00:00.000' } },
  });
  const res = await h.run();
  assert.equal(res.pushed, 1);
  assert.equal(h.state.actions[0].target_id, 'Conf - Next Day');
  assert.equal(res.counts.called, 1);
  assert.equal(res.counts.dnc, 1);
  assert.equal(res.counts.already_on_target_list, 1);
});

test('watchdog: a lead stuck 30+ min with no call, no push and no reason → ONE #ops card, once', async () => {
  const h = missedHarness({ mode: 'live', dncThrows: true });
  const res = await h.run(at('2026-10-06T12:31:00Z')); // 8:31 AM: overnight leads are 31 dial minutes old
  assert.equal(res.unhandled, 4);
  assert.equal(h.state.ops.length, 1);
  assert.equal(h.state.ops[0].opts.channel, 'ops');
  assert.match(h.state.ops[0].text, /Donna · …5252 · Reece ChatBot · LP lead 581413 · \d+h \d+m old · Five9 DNC check failed/);
  assert.match(h.state.ops[0].text, /Lori Brannon · …6117 · Google PPC Windows · LP lead 581416/);
  await h.run(at('2026-10-06T12:36:00Z'));
  assert.equal(h.state.ops.length, 1, 'each lead is named once');
});

test('watchdog: quiet before 8:30 for overnight leads, and for a failed contact lookup it waits, then names it', async () => {
  const early = missedHarness({ mode: 'live', dncThrows: true });
  assert.equal((await early.run(at('2026-10-06T12:25:00Z'))).unhandled, 0, '8:25: inside the 30 dial minutes');
  const h = missedHarness({ mode: 'live', contactThrows: true });
  const res = await h.run(at('2026-10-06T12:31:00Z'));
  assert.equal(res.counts.five9_record_unreadable, 4);
  assert.equal(h.state.actions.length, 0, 'fail closed: nothing pushed blind');
  assert.match(h.state.ops[0].text, /Five9 contact lookup failed/);
});

test('unhandledLeads: skips and pushes are handled; waits, deferrals and failed pushes are not', () => {
  const r = row('donna');
  const now = at('2026-10-06T13:00:00Z');
  const out = unhandledLeads([
    { row: r, action: 'skip', result: 'called' },
    { row: r, action: 'push', result: 'pushed' },
    { row: r, action: 'wait', result: 'dnc_unreadable' },
    { row: r, action: 'deferred', result: 'deferred' },
    { row: r, action: 'failed', result: 'push_failed' },
  ], { nowMs: now, cfg });
  assert.deepEqual(out.map((o) => o.result), ['dnc_unreadable', 'deferred', 'push_failed']);
  assert.doesNotMatch(formatUnhandledCard(out, now), /dnc_unreadable|push_failed/);
});

test('a failed insert releases the claim so the next pass retries', async () => {
  const h = harness({ mode: 'live', insertError: 'db down' });
  const res = await h.run();
  assert.equal(res.ok, false);
  assert.deepEqual([...h.state.marks], [], 'no claim left behind');
  assert.equal(h.state.alerts.at(-1).active, true);
});

test('an unreadable call history pushes nothing (fail closed) and raises the alarm', async () => {
  const h = harness({ mode: 'live' });
  const res = await runNewLeadDialBackstop({
    env: { NEW_LEAD_DIAL_BACKSTOP_MODE: 'live' }, nowMs: MON_1015,
    deps: { ...h.deps, runSQL: async () => { throw new Error('timeout'); } },
  });
  assert.equal(res.ok, false);
  assert.equal(res.insufficient_evidence, true);
  assert.equal(res.pushed, 0);
  assert.equal(h.state.alerts.at(-1).active, true);
});

test('the pass runs at night too (24/7); the dialer holds the record until 8 AM', async () => {
  const h = harness({ mode: 'live' });
  const res = await h.run(at('2026-10-06T03:00:00Z')); // 11 PM EDT
  assert.equal(res.skipped, undefined);
  assert.ok(res.pushed > 0);
  assert.equal(h.state.posts.length, 0);
});

test('a failed #ops watchdog post raises the ops alarm', async () => {
  const h = missedHarness({ mode: 'live', dncThrows: true });
  h.deps.sendAlertMessage = async () => ({ sent: false, reason: 'channel_not_found' });
  const res = await h.run(at('2026-10-06T12:31:00Z'));
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /unhandled-leads card/.test(e)));
  assert.equal(h.state.alerts.at(-1).active, true);
});
