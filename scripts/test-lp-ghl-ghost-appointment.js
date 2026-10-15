/**
 * LP→GHL ghost appointments — scripts/test-lp-ghl-ghost-appointment.js
 *
 * 2026-10-15. Five GHL Window Estimates were booked from lp_leads rows LP no
 * longer stood behind:
 *   - a STALE row (synced 2026-03-25, real UTC): lead 475840, LP live
 *     2026-11-30 10:00 AM, row 15:00Z → booked at 3:00 PM ET;
 *   - YEAR TYPOS: 2025 leads last touched by LP about a year before the visit.
 * The reconciler now books Set/Cnf from LP live (passed in as `live`), trusts a
 * row alone only when it was synced on/after 2026-07-08, and refuses a visit
 * more than LP_GHL_SYNC_MAX_FORWARD_DAYS past the lead's last LP activity.
 * Cancel is never gated by either.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.LP_GHL_SYNC_MAX_FORWARD_DAYS;
process.env.GHL_API_KEY = 'test-key';

// ─── GHL fetch stub (same mechanism as test-lp-ghl-appointment-sync.js) ──
let calls = [];
let upcomingAppointments = [];

function jsonRes(body) {
  return {
    status: 200, ok: true,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  const path = String(url).replace('https://services.leadconnectorhq.com', '');
  calls.push({ method, path, body: opts.body ? JSON.parse(opts.body) : null });
  if (method === 'GET' && /^\/contacts\/[^/]+\/appointments/.test(path)) return jsonRes({ events: upcomingAppointments });
  if (method === 'GET' && /^\/contacts\/[^/]+$/.test(path)) return jsonRes({ contact: { id: 'c1', tags: [] } });
  if (method === 'POST' && path === '/calendars/events/appointments') return jsonRes({ id: 'new-appt-1' });
  if (method === 'PUT' && path.startsWith('/calendars/events/appointments/')) return jsonRes({ id: path.split('/').pop() });
  return jsonRes({});
};

const {
  reconcileLpAppointmentToGhl, resolveSyncStartTime, isImplausibleFutureAppointment,
  lastLpActivityDay, isWallClockMirrorRow, maxForwardDays, WINDOW_ESTIMATE_CALENDAR_ID,
} = await import('../src/services/lp-ghl-appointment-reconciler.js');
const {
  readLiveLpAppointment, readLiveForSync, liveMirrorUpdate, mirrorAppointmentDate,
} = await import('../src/services/lp-live-appointment.js');
const { parseLpApptWallClock } = await import('../src/actions/date-parsers.js');
const { parseLpApptWallClock: reExported } = await import('../src/actions/handlers/lp-appointment.js');
const {
  notifyImplausibleAppointment, formatImplausibleAppointmentAlert,
} = await import('../src/actions/handlers/lp-ghl-appointment-sync.js');

const WE = WINDOW_ESTIMATE_CALENDAR_ID;
const mutations = () => calls.filter((c) => c.method === 'POST' || c.method === 'PUT');
function reset(upcoming = []) { calls = []; upcomingAppointments = upcoming; }

const live = (date, time, over = {}) => ({
  ok: true, date, time, timeStatus: time ? 'known' : 'absent',
  disposition: 'Set', setDate: null, lastChangedOn: null,
  mirrorAppointmentDate: mirrorAppointmentDate(date ? { date, time } : null),
  ...over,
});
const LIVE_FAILED = { ok: false, error: 'LP circuit open' };

// YYYY-MM-DD n days from today (UTC), for leads that must stay "recent".
const dayFromNow = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

// ═══ 1. The parser is shared, not duplicated ═══════════════════════════

test('parseLpApptWallClock lives in date-parsers and is re-exported by lp-appointment', () => {
  assert.equal(reExported, parseLpApptWallClock);
  assert.deepEqual(parseLpApptWallClock('2026-11-30T10:00:00'), { date: '2026-11-30', time: '10:00', timeStatus: 'known' });
  assert.deepEqual(parseLpApptWallClock('11/30/2026 10:00:00 AM'), { date: '2026-11-30', time: '10:00', timeStatus: 'known' });
});

// ═══ 2. Start time: live wins, stale rows never book alone ═════════════

test('DST: live 10:00 on 2026-11-30 → -05:00; on 2026-10-20 → -04:00', () => {
  assert.equal(resolveSyncStartTime({}, live('2026-11-30', '10:00')).startTime, '2026-11-30T10:00:00-05:00');
  assert.equal(resolveSyncStartTime({}, live('2026-10-20', '10:00')).startTime, '2026-10-20T10:00:00-04:00');
});

test('stale row (synced 2026-03-25, 15:00Z) + live 10:00 → 10:00 ET from LP live, not the row', () => {
  const lead = { appointment_date: '2026-11-30T15:00:00+00:00', synced_at: '2026-03-25T22:44:00.6+00:00' };
  const r = resolveSyncStartTime(lead, live('2026-11-30', '10:00'));
  assert.equal(r.startTime, '2026-11-30T10:00:00-05:00');
  assert.equal(r.source, 'lp_live');
});

test('live read failed: a wall-clock-era row is trusted, a pre-2026-07-08 or undated row is not', () => {
  const fresh = { appointment_date: '2026-11-30T10:00:00+00:00', synced_at: '2026-07-08T00:00:00Z' };
  assert.equal(resolveSyncStartTime(fresh, LIVE_FAILED).startTime, '2026-11-30T10:00:00-05:00');
  assert.equal(resolveSyncStartTime(fresh, null).source, 'mirror');
  assert.equal(resolveSyncStartTime({ ...fresh, synced_at: '2026-07-07T23:59:59Z' }, LIVE_FAILED).stale, true);
  assert.equal(resolveSyncStartTime({ ...fresh, synced_at: null }, LIVE_FAILED).stale, true);
  assert.equal(isWallClockMirrorRow({ synced_at: 'garbage' }), false);
});

test('live ok with no time → no start time (never falls back to the row LP contradicts)', () => {
  const lead = { appointment_date: '2026-11-30T15:00:00+00:00', synced_at: '2026-10-01T00:00:00Z' };
  assert.equal(resolveSyncStartTime(lead, live(null, null)).startTime, null);
  assert.equal(resolveSyncStartTime(lead, live('2026-11-30', null)).startTime, null);
});

// ═══ 3. Plausibility guard ═════════════════════════════════════════════

test('Gilles/Edouard: last LP activity 2025-11-26, visit 2026-11-30 → implausible', () => {
  const lead = {
    created_at_lp: '2025-11-26T16:39:09.847+00:00', updated_at_lp: '2025-11-26T16:39:09.847+00:00',
    set_date: null, last_contact_date: null,
  };
  const r = isImplausibleFutureAppointment({ startTime: '2026-11-30T10:00:00-05:00', lead, live: null });
  assert.equal(r.implausible, true);
  assert.equal(r.lastActivityDay, '2025-11-26');
  assert.equal(r.daysAfter, 369);
  assert.equal(r.maxDays, 120);
});

test('the newest activity date counts, live setdate / lastchangedon included', () => {
  const lead = { created_at_lp: '2025-11-26T00:00:00Z', updated_at_lp: '2025-11-26T00:00:00Z' };
  assert.equal(lastLpActivityDay(lead, live('2026-11-30', '10:00', { lastChangedOn: '2026-10-14' })), '2026-10-14');
  assert.equal(lastLpActivityDay({ ...lead, set_date: '2026-09-01T12:00:00Z' }, null), '2026-09-01');
  assert.equal(lastLpActivityDay({ ...lead, last_contact_date: '2026-09-02T12:00:00Z' }, LIVE_FAILED), '2026-09-02');
  const ok = isImplausibleFutureAppointment({
    startTime: '2026-11-30T10:00:00-05:00', lead, live: live('2026-11-30', '10:00', { setDate: '2026-10-14' }),
  });
  assert.equal(ok.implausible, false);
});

test('exactly at the limit is allowed; one day past is not; no activity date → stands down', () => {
  const lead = { updated_at_lp: '2026-01-01T00:00:00Z' };
  assert.equal(isImplausibleFutureAppointment({ startTime: '2026-05-01T10:00:00-04:00', lead, live: null }).implausible, false); // 120 days
  assert.equal(isImplausibleFutureAppointment({ startTime: '2026-05-02T10:00:00-04:00', lead, live: null }).implausible, true);  // 121 days
  assert.equal(isImplausibleFutureAppointment({ startTime: '2026-05-02T10:00:00-04:00', lead: {}, live: null }).implausible, false);
});

test('LP_GHL_SYNC_MAX_FORWARD_DAYS overrides the 120-day default; junk falls back', () => {
  assert.equal(maxForwardDays({}), 120);
  assert.equal(maxForwardDays({ LP_GHL_SYNC_MAX_FORWARD_DAYS: '400' }), 400);
  assert.equal(maxForwardDays({ LP_GHL_SYNC_MAX_FORWARD_DAYS: 'abc' }), 120);
  assert.equal(maxForwardDays({ LP_GHL_SYNC_MAX_FORWARD_DAYS: '0' }), 120);
  process.env.LP_GHL_SYNC_MAX_FORWARD_DAYS = '400';
  try {
    const r = isImplausibleFutureAppointment({
      startTime: '2026-11-30T10:00:00-05:00', lead: { updated_at_lp: '2025-11-26T00:00:00Z' }, live: null,
    });
    assert.equal(r.implausible, false);
  } finally {
    delete process.env.LP_GHL_SYNC_MAX_FORWARD_DAYS;
  }
});

// ═══ 4. The reconciler, end to end against the GHL stub ════════════════

test('stale row + live LP 10:00 → creates at 10:00 ET (not 3 PM)', async () => {
  reset();
  const lead = {
    lp_lead_id: '475840', disposition_code: 'Set',
    appointment_date: '2027-11-30T15:00:00+00:00', synced_at: '2026-03-25T22:44:00.6+00:00',
    created_at_lp: '2025-11-26T16:39:09.847+00:00', updated_at_lp: '2025-11-26T16:39:09.847+00:00',
  };
  const r = await reconcileLpAppointmentToGhl({
    contactId: 'c-ghost', lead, live: live('2027-11-30', '10:00', { lastChangedOn: '2027-11-01' }),
  });
  assert.equal(r.outcome, 'created');
  assert.equal(r.appointment_source, 'lp_live');
  const posts = mutations().filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.startTime, '2027-11-30T10:00:00-05:00');
  assert.equal(posts[0].body.calendarId, WE);
});

test('stale row + live read failed → noop stale_mirror_unverified, no GHL call at all', async () => {
  reset();
  const lead = {
    lp_lead_id: '475840', disposition_code: 'Set',
    appointment_date: '2027-11-30T15:00:00+00:00', synced_at: '2026-03-25T22:44:00.6+00:00',
    updated_at_lp: new Date().toISOString(),
  };
  const r = await reconcileLpAppointmentToGhl({ contactId: 'c-ghost', lead, live: LIVE_FAILED });
  assert.equal(r.outcome, 'noop');
  assert.equal(r.reason, 'stale_mirror_unverified');
  assert.equal(r.live_error, 'LP circuit open');
  assert.equal(calls.length, 0);
});

test('lead last updated 2025-11-26, visit 2026-11-30 → noop implausible_future_appointment, no GHL call', async () => {
  reset();
  const lead = {
    lp_lead_id: '475840', disposition_code: 'Set',
    appointment_date: '2026-11-30T10:00:00+00:00', synced_at: '2026-10-15T12:00:00Z',
    created_at_lp: '2025-11-26T16:39:09.847+00:00', updated_at_lp: '2025-11-26T16:39:09.847+00:00',
  };
  for (const l of [live('2026-11-30', '10:00'), LIVE_FAILED]) {
    const r = await reconcileLpAppointmentToGhl({ contactId: 'BQ7uPNReghzTTLVjKFJS', lead, live: l });
    assert.equal(r.reason, 'implausible_future_appointment');
    assert.equal(r.last_activity_at, '2025-11-26');
    assert.equal(r.max_forward_days, 120);
  }
  // The guard also holds for a Cnf and in a dry run.
  const cnf = await reconcileLpAppointmentToGhl({ contactId: 'c', lead: { ...lead, disposition_code: 'Cnf' }, live: null, dryRun: true });
  assert.equal(cnf.reason, 'implausible_future_appointment');
  assert.equal(calls.length, 0);
});

test('normal lead (updated today, visit in 3 days, live agrees) → creates as before', async () => {
  reset();
  const day = dayFromNow(3);
  const lead = {
    lp_lead_id: '590001', disposition_code: 'Set',
    appointment_date: `${day}T14:00:00+00:00`, synced_at: new Date().toISOString(),
    created_at_lp: new Date().toISOString(), updated_at_lp: new Date().toISOString(),
  };
  const r = await reconcileLpAppointmentToGhl({ contactId: 'c-normal', lead, live: live(day, '14:00') });
  assert.equal(r.outcome, 'created');
  assert.equal(mutations().filter((c) => c.method === 'POST').length, 1);
  // ...and with LP unreadable, the fresh row books the same visit.
  reset();
  const r2 = await reconcileLpAppointmentToGhl({ contactId: 'c-normal', lead, live: LIVE_FAILED });
  assert.equal(r2.outcome, 'created');
  assert.equal(r2.appointment_source, 'mirror');
});

test('cancel is unaffected by both guards: stale row, failed live read, year-old activity → still cancels', async () => {
  reset([{ id: 'appt-9', calendarId: WE, startTime: '2027-11-30T15:00:00-05:00', appointmentStatus: 'new' }]);
  const lead = {
    lp_lead_id: '475840', disposition_code: 'CXL',
    appointment_date: '2027-11-30T15:00:00+00:00', synced_at: '2026-03-25T22:44:00.6+00:00',
    updated_at_lp: '2025-11-26T16:39:09.847+00:00',
  };
  const r = await reconcileLpAppointmentToGhl({ contactId: 'c-cxl', lead, live: LIVE_FAILED });
  assert.equal(r.outcome, 'cancelled');
  const puts = mutations().filter((c) => c.method === 'PUT');
  assert.ok(puts.some((c) => c.path.endsWith('/appt-9') && c.body.appointmentStatus === 'cancelled'));
});

// ═══ 5. The live read and the mirror write-back ═════════════════════════

const getLeadResponse = (apptdate, extra = {}) => ({
  data: [{ cst_id: 900001, leads: [{ id: 475840, apptdate, disposition: 'Set', setdate: '2025-11-26T16:39:09.847', lastchangedon: '2025-11-26T16:39:09.847', ...extra }] }],
});

test('readLiveLpAppointment: unwraps GetLead, parses apptdate, setdate and lastchangedon', async () => {
  let asked = null;
  const r = await readLiveLpAppointment('475840', {
    getLeadByLdsId: async (id, opts) => { asked = { id, opts }; return getLeadResponse('2026-11-30T10:00:00'); },
  });
  assert.deepEqual(asked, { id: '475840', opts: { fast: true } });
  assert.equal(r.ok, true);
  assert.equal(r.date, '2026-11-30');
  assert.equal(r.time, '10:00');
  assert.equal(r.setDate, '2025-11-26');
  assert.equal(r.lastChangedOn, '2025-11-26');
  assert.equal(r.mirrorAppointmentDate, '2026-11-30T10:00:00+00:00');
});

test('readLiveLpAppointment never throws: LP error or lead missing → ok:false', async () => {
  const thrown = await readLiveLpAppointment('475840', { getLeadByLdsId: async () => { throw new Error('timeout'); } });
  assert.deepEqual(thrown, { ok: false, error: 'timeout' });
  const missing = await readLiveLpAppointment('475840', { getLeadByLdsId: async () => ({ data: [] }) });
  assert.equal(missing.ok, false);
});

test('liveMirrorUpdate: a stale row gets LP wall clock + synced_at; an agreeing row gets nothing', () => {
  const now = '2026-10-15T18:00:00.000Z';
  const patch = liveMirrorUpdate({ appointment_date: '2026-11-30T15:00:00+00:00' }, live('2026-11-30', '10:00'), now);
  assert.deepEqual(patch, { appointment_date: '2026-11-30T10:00:00+00:00', synced_at: now });
  assert.equal(liveMirrorUpdate({ appointment_date: '2026-11-30T10:00:00+00:00' }, live('2026-11-30', '10:00'), now), null);
  assert.equal(liveMirrorUpdate({ appointment_date: '2026-11-30T15:00:00+00:00' }, LIVE_FAILED, now), null);
});

test('readLiveForSync: Set reads and writes the mirror; dry run never writes; CXL never reads', async () => {
  const writes = [];
  const deps = {
    readLiveLpAppointment: async () => live('2026-11-30', '10:00'),
    writeMirrorUpdate: async (id, patch) => { writes.push({ id, patch }); return true; },
  };
  const stale = { lp_lead_id: '475840', disposition_code: 'Set', appointment_date: '2026-11-30T15:00:00+00:00' };
  const r = await readLiveForSync(stale, { deps });
  assert.equal(r.time, '10:00');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].patch.appointment_date, '2026-11-30T10:00:00+00:00');

  await readLiveForSync(stale, { dryRun: true, deps });
  assert.equal(writes.length, 1);

  let read = false;
  const none = await readLiveForSync({ ...stale, disposition_code: 'CXL' }, {
    deps: { ...deps, readLiveLpAppointment: async () => { read = true; return live('2026-11-30', '10:00'); } },
  });
  assert.equal(none, null);
  assert.equal(read, false);
});

// ═══ 6. The Slack alert ═══════════════════════════════════════════════════

const ghostLead = {
  lp_lead_id: '475840', first_name: 'Gilles', last_name: 'Edouard', disposition_code: 'Set',
  appointment_date: '2026-11-30T10:00:00+00:00',
};
const ghostResult = {
  reason: 'implausible_future_appointment', start_time: '2026-11-30T10:00:00-05:00',
  last_activity_at: '2025-11-26', days_after_last_activity: 369, max_forward_days: 120,
};

test('alert text names the lead, the date, the last activity and the fix', () => {
  const text = formatImplausibleAppointmentAlert({ contactId: 'BQ7uPNReghzTTLVjKFJS', lead: ghostLead, result: ghostResult });
  for (const part of ['Gilles Edouard', '475840', 'BQ7uPNReghzTTLVjKFJS', '2026-11-30 10:00', '2025-11-26', 'Likely year typo — fix the date in LP.']) {
    assert.ok(text.includes(part), `missing "${part}"`);
  }
});

test('alert goes to Slack #ops-alerts once per lead + date (claim before send)', async () => {
  const keys = new Set();
  const sent = [];
  const deps = {
    claimSyncNotice: async ({ noticeKey }) => (keys.has(noticeKey) ? false : (keys.add(noticeKey), true)),
    sendAlertMessage: async (text, opts) => { sent.push({ text, opts }); return { sent: true }; },
  };
  await notifyImplausibleAppointment({ contactId: 'BQ7uPNReghzTTLVjKFJS', lead: ghostLead, result: ghostResult, deps });
  const again = await notifyImplausibleAppointment({ contactId: 'BQ7uPNReghzTTLVjKFJS', lead: ghostLead, result: ghostResult, deps });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].opts, { channel: 'ops' });
  assert.deepEqual([...keys], ['implausible-appt:475840:2026-11-30']);
  assert.equal(again.reason, 'already_claimed');
});

// ═══ 7. One-time mirror refresh (never GHL) ═══════════════════════════════

const { planRowRefresh, runStaleAppointmentRefresh, formatRefreshTable } =
  await import('../src/admin/stale-lp-appointment-refresh.js');

test('planRowRefresh: rewrites the stale UTC row to LP wall clock, keeps an agreeing row, reports a failed read', () => {
  const now = '2026-10-15T18:00:00.000Z';
  const row = { lp_lead_id: '475840', disposition_code: 'Set', appointment_date: '2026-11-30T15:00:00+00:00' };
  const upd = planRowRefresh(row, live('2026-11-30', '10:00'), now);
  assert.equal(upd.action, 'update');
  assert.deepEqual(upd.patch, { appointment_date: '2026-11-30T10:00:00+00:00', disposition_code: 'Set', synced_at: now });
  const same = planRowRefresh({ ...row, appointment_date: '2026-11-30T10:00:00+00:00' }, live('2026-11-30', '10:00'), now);
  assert.equal(same.action, 'unchanged');
  const cxl = planRowRefresh(row, live(null, null, { disposition: 'CXL', mirrorAppointmentDate: null }), now);
  assert.equal(cxl.action, 'update');
  assert.equal(cxl.patch.disposition_code, 'CXL');
  assert.equal(planRowRefresh(row, LIVE_FAILED, now).action, 'error');
});

test('runStaleAppointmentRefresh: dry run writes nothing; apply writes lp_leads only', async () => {
  const updates = [];
  const db = { from: (t) => ({ update: (patch) => ({ eq: async (k, v) => { updates.push({ t, patch, k, v }); return { error: null }; } }) }) };
  const deps = {
    supabase: db,
    sleep: async () => {},
    scanStaleAppointmentRows: async () => [
      { lp_lead_id: '475840', disposition_code: 'Set', appointment_date: '2026-11-30T15:00:00+00:00', synced_at: '2026-03-25T22:44:00Z' },
      { lp_lead_id: '462092', disposition_code: 'Set', appointment_date: '2026-11-11T18:00:00+00:00', synced_at: '2026-03-26T00:20:04Z' },
    ],
    readLiveLpAppointment: async (id) => (id === '475840' ? live('2026-11-30', '10:00') : LIVE_FAILED),
  };
  const dry = await runStaleAppointmentRefresh({ dryRun: true, deps });
  assert.equal(updates.length, 0);
  assert.deepEqual([dry.counts.update, dry.counts.error], [1, 1]);
  assert.ok(formatRefreshTable(dry).includes('2026-11-30T15:00:00+00:00 → 2026-11-30T10:00:00+00:00'));

  const applied = await runStaleAppointmentRefresh({ dryRun: false, deps });
  assert.equal(applied.counts.written, 1);
  assert.deepEqual(updates.map((u) => [u.t, u.v]), [['lp_leads', '475840']]);
});
