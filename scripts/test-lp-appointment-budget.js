/**
 * set-lp-appointment response budget + deferred bookkeeping
 * scripts/test-lp-appointment-budget.js
 *
 * WHY THIS EXISTS
 * ───────────────
 * POST /webhook/ghl/set-lp-appointment was exceeding GoHighLevel's 60s client
 * timeout. GHL hung up, Railway logged a 499, and because a 499 is not a 5xx it
 * appeared in no error metric — the intake journal is what surfaced it.
 * Measured over 72h to 2026-09-13: 161 requests, 41 client timeouts (25%),
 * p90 46.5s, max 58.4s. Nothing was lost: all 26 stuck journal rows had
 * appointment_set=true in lp_leads. The work completed; only the ack was lost.
 *
 * The cause was NOT LP latency. Across 30h of logs there is not one
 * SetAppointment call — every request takes the already-in-LP early exit. It is
 * the shared GHL limiter: a 429 pauses ALL GHL traffic for 300s and every
 * waiter then burns its full 30s fail-open. This route made 6-10 sequential GHL
 * calls, so two such waits is 60s.
 *
 * Two defences, both pinned here:
 *   1. the hot path no longer makes bookkeeping GHL calls inside the request
 *   2. a hard response budget converts the slow tail to a 202 instead of a 499
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { apptSyncBudgetMs, raceBudget } = await import('../src/lp-appointment-sync.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════════════
// 1. The budget itself
// ════════════════════════════════════════════════════════════════════

test('budget defaults to 8000ms and is env-overridable, ignoring junk', () => {
  delete process.env.APPT_SYNC_BUDGET_MS;
  assert.equal(apptSyncBudgetMs(), 8000);

  for (const bad of ['', '0', '-1', 'abc', 'NaN']) {
    process.env.APPT_SYNC_BUDGET_MS = bad;
    assert.equal(apptSyncBudgetMs(), 8000, `"${bad}" must fall back to the default`);
  }

  process.env.APPT_SYNC_BUDGET_MS = '2500';
  assert.equal(apptSyncBudgetMs(), 2500);
  delete process.env.APPT_SYNC_BUDGET_MS;

  // Must stay well under GHL's 60s client timeout, which is the whole point.
  assert.ok(apptSyncBudgetMs() < 60000);
});

// ════════════════════════════════════════════════════════════════════
// 2. raceBudget — the fast path must be untouched
// ════════════════════════════════════════════════════════════════════

test('work that finishes under budget returns its result verbatim', async () => {
  // The real success body, field for field — the response contract must not
  // change for the ~p50 case, because we cannot verify that the I.LP-A
  // workflow does not read it.
  const body = {
    success: true,
    action: 'lp_appointment_set',
    lp_lead_id: '575580',
    lp_prospect_id: '92642',
    appt_date: '09/15/2026',
    appt_time: '10:00',
    calendar_name: 'Window Estimate',
    resolution_source: 'supabase_link',
    resolution_step: 2,
    lp_source: 'GHL',
    lp_source_detail: null,
    lp_response: { Result: 1, Message: 'OK' },
  };

  const out = await raceBudget(Promise.resolve(body), 1000);
  assert.deepEqual(out, body, 'fast path must be byte-for-byte unchanged');
  assert.ok(!out.__deferred);
});

test('work that exceeds budget yields the deferred sentinel, promptly', async () => {
  const slow = sleep(5000).then(() => ({ success: true, action: 'lp_appointment_set' }));

  const t0 = Date.now();
  const out = await raceBudget(slow, 300);
  const waited = Date.now() - t0;

  assert.equal(out.__deferred, true);
  assert.ok(waited < 1200, `must return on the budget, waited ${waited}ms`);
  assert.ok(waited >= 250, `must actually wait the budget, waited ${waited}ms`);

  // THE LOAD-BEARING PROPERTY: the work is not aborted, only un-awaited.
  // Abandoning it would turn a latency bug into the data-loss bug we do not have.
  const eventual = await slow;
  assert.equal(eventual.action, 'lp_appointment_set', 'the work must still complete');
});

test('a rejecting promise still rejects through the race, and does not leak', async () => {
  await assert.rejects(() => raceBudget(Promise.reject(new Error('lp down')), 1000), /lp down/);
});

test('the budget timer never keeps the event loop alive', async () => {
  // If clearTimeout were missing, a short-lived script would hang for the full
  // budget after the work resolved.
  const t0 = Date.now();
  await raceBudget(Promise.resolve({ ok: true }), 30000);
  assert.ok(Date.now() - t0 < 500, 'must not wait out an unused 30s timer');
});

// ════════════════════════════════════════════════════════════════════
// 3. Source-level pins
// ════════════════════════════════════════════════════════════════════
//
// syncAppointmentToLP orchestrates ~15 collaborators across LP, GHL, Supabase
// and GroupMe; standing all of that up would test the mocks, not the change.
// These pin the two structural properties that actually fix the defect, in the
// same spirit as the SIGTERM pin in test-sync-status-classification.js.

const SRC = readFileSync(join(ROOT, 'src/lp-appointment-sync.js'), 'utf8');

test('the handler bounds its wait and acks 202 rather than letting GHL time out [source-level]', () => {
  const handler = SRC.slice(SRC.indexOf("app.post('/webhook/ghl/set-lp-appointment'"));
  const body = handler.slice(0, handler.indexOf("app.post('/webhook/ghl/lp-probe'"));

  assert.match(body, /raceBudget\(\s*work\s*,\s*budgetMs\s*\)/, 'must race the work against the budget');
  assert.match(body, /res\.status\(202\)/, 'over-budget must ack 202, not hang');
  assert.match(body, /action: 'lp_appointment_sync_deferred'/);

  // The over-budget branch must hand the promise to the drain, or a deploy
  // mid-flight silently discards it — the exact failure PR #904 exists to stop.
  assert.match(body, /trackBackground\(\s*work\./, 'deferred work must be tracked for the drain');

  // And it must NOT abort the work.
  assert.doesNotMatch(body, /work\.cancel|abortWork|controller\.abort\(\)/);
});

test('the already-in-LP hot path makes no bookkeeping GHL calls inside the request [source-level]', () => {
  const start = SRC.indexOf('if (await _lpAlreadyHasAppointment(');
  const branch = SRC.slice(start, SRC.indexOf("action: 'already_in_lp_skipped_pre_resolve'", start));

  // This branch is what ~all production traffic takes. Each of these is a GHL
  // call that can block 30s during a limiter pause.
  //
  // Position, not presence: the calls must still happen, but every one of them
  // must sit INSIDE the trackBackground(...) block rather than before it. An
  // await inside the deferred block is correct; an await ahead of it is the
  // defect.
  const deferPoint = branch.indexOf('trackBackground(');
  assert.ok(deferPoint > 0, 'the bookkeeping must be drain-tracked');

  const beforeDefer = branch.slice(0, deferPoint);
  for (const call of ['applyGHLTag', 'clearSyncFailedTag', 'addGHLNote']) {
    assert.ok(branch.includes(call), `${call} should still happen`);
    assert.ok(
      !beforeDefer.includes(`${call}(`),
      `${call} must not run before trackBackground — that is the request path`,
    );
  }
});

test('the dedup mark and the I.LP-A signal tag stay synchronous [source-level]', () => {
  // Deferring these two would widen the duplicate window and delay the exact
  // signal I.LP-A gates its native fallback on. They must stay awaited.
  const tail = SRC.slice(SRC.indexOf('const result = await _lpSetAppointment('));
  const upto = tail.slice(0, tail.indexOf("action: 'lp_appointment_set'"));

  assert.match(upto, /await writeApptSyncMark\(/, 'the duplicate guard must not lag the response');
  assert.match(upto, /await applyApptSyncedTag\(/, "I.LP-A's success signal must not lag the response");
});

// ════════════════════════════════════════════════════════════════════
// GHL-only calendars and terminal dispositions never reach SetAppointment
// ════════════════════════════════════════════════════════════════════
//
// 2026-10-08 (contact 5YGVd3kh5IcY6pUJVcs4, LP lead 581695, prospect 463408):
// a Confirmation Call (calendar gFWoSQrlKIdfRbAPV842) was auto-healed into LP by
// the parity watchdog. Step 0a matched the lead by lognumber in ANY disposition,
// so LP's post-demo OPPFDN lead flipped to Set. These run the REAL
// syncAppointmentToLP through its deps seam and count SetAppointment calls.

const { syncAppointmentToLP, terminalDispositionDecision, isGhlOnlyAppointment } =
  await import('../src/lp-appointment-sync.js');

const CONFIRMATION_CALL = 'gFWoSQrlKIdfRbAPV842';

function syncDeps({ disp = 'Data' } = {}) {
  const seen = { precheck: 0, resolve: 0, setAppointment: 0 };
  return {
    seen,
    deps: {
      lpAlreadyHasAppointment: async () => { seen.precheck++; return false; },
      resolveLPLeadId: async () => {
        seen.resolve++;
        return { ldsId: '581695', prospectId: '463408', source: 'supabase_hlcid_validated', step: 0, disp };
      },
      lpSetAppointment: async () => { seen.setAppointment++; return { Result: 0 }; },
    },
  };
}

test('syncAppointmentToLP refuses a GHL-only calendarId before any LP read', async () => {
  const { seen, deps } = syncDeps();
  const res = await syncAppointmentToLP({
    contactId: '5YGVd3kh5IcY6pUJVcs4',
    appointmentDate: '2026-10-09', appointmentTime: '06:00 PM',
    calendarId: CONFIRMATION_CALL,
  }, deps);

  assert.equal(res.action, 'skipped_ghl_only_calendar');
  assert.deepEqual(seen, { precheck: 0, resolve: 0, setAppointment: 0 },
    'a Confirmation Call must not even be looked up in LP');
});

test('a Confirmation Call named but not id-tagged is refused too', async () => {
  const { seen, deps } = syncDeps();
  const res = await syncAppointmentToLP({
    contactId: '5YGVd3kh5IcY6pUJVcs4',
    appointmentDate: '2026-10-09', appointmentTime: '06:00 PM',
    calendarName: 'Confirmation Call',
  }, deps);
  assert.equal(res.action, 'skipped_ghl_only_calendar');
  assert.equal(seen.setAppointment, 0);
});

test('syncAppointmentToLP refuses an OPPFDN lead: no SetAppointment', async () => {
  const { seen, deps } = syncDeps({ disp: 'OPPFDN' });
  const res = await syncAppointmentToLP({
    contactId: '5YGVd3kh5IcY6pUJVcs4',
    appointmentDate: '2026-10-09', appointmentTime: '06:00 PM',
  }, deps);

  assert.equal(res.action, 'skipped_terminal_disposition');
  assert.equal(res.disposition, 'OPPFDN');
  assert.equal(res.lp_lead_id, '581695');
  assert.equal(seen.resolve, 1);
  assert.equal(seen.setAppointment, 0, 'the incident wrote Set over OPPFDN — never again');
});

test('terminalDispositionDecision: bookable passes, post-demo stops for everyone, blank is unknown (passes)', () => {
  for (const d of ['Data', 'SET', 'Cnf', 'ccc', ' Verif ', 'NIS']) {
    assert.equal(terminalDispositionDecision(d).allow, true, `${d} is bookable`);
    assert.equal(terminalDispositionDecision(d, { requireBookable: true }).allow, true, `${d} is bookable for the watchdog too`);
  }
  // Post-demo / sold: refused whoever asks (the 2026-10-08 incident).
  for (const d of ['OPPFDN', 'Sale', 'NoRehash']) {
    for (const opts of [{}, { requireBookable: true }]) {
      const r = terminalDispositionDecision(d, opts);
      assert.equal(r.allow, false, `${d} must be refused (${JSON.stringify(opts)})`);
      assert.equal(r.reason, 'terminal_disposition');
    }
  }
  // A lead minted minutes ago may not carry a disposition yet; refusing it
  // would strand a real booking.
  for (const d of [null, undefined, '', '  ']) {
    assert.deepEqual(terminalDispositionDecision(d), { allow: true, reason: 'disposition_unknown' });
  }
});

test('terminalDispositionDecision: a cancelled / no-show lead may be rebooked by a person, never by the auto-repair', () => {
  // The user, 2026-10-09 ("allow rebooks again"): a GHL or person booking on a
  // CXL lead is a normal reschedule; only the watchdog needs an open lead.
  for (const d of ['CXL', 'NOC', 'DNC', 'No Demo']) {
    assert.deepEqual(terminalDispositionDecision(d), { allow: true, reason: 'rebook_closed_lead' }, `${d} rebook allowed`);
    const auto = terminalDispositionDecision(d, { requireBookable: true });
    assert.equal(auto.allow, false, `${d} refused for the auto-repair`);
    assert.equal(auto.reason, 'terminal_disposition');
  }
});

test('syncAppointmentToLP with requireBookable refuses a CXL lead: no SetAppointment', async () => {
  const { seen, deps } = syncDeps({ disp: 'CXL' });
  const res = await syncAppointmentToLP({
    contactId: '5YGVd3kh5IcY6pUJVcs4',
    appointmentDate: '2026-10-09', appointmentTime: '06:00 PM',
    requireBookable: true,
  }, deps);
  assert.equal(res.action, 'skipped_terminal_disposition');
  assert.equal(res.disposition, 'CXL');
  assert.equal(seen.setAppointment, 0);
});

test('isGhlOnlyAppointment: only the Confirmation Call calendar', () => {
  assert.equal(isGhlOnlyAppointment({ calendarId: CONFIRMATION_CALL }), true);
  assert.equal(isGhlOnlyAppointment({ calendarName: ' confirmation CALL ' }), true);
  assert.equal(isGhlOnlyAppointment({ calendarId: 'aJj14ONxh1oFyDcQ706O', calendarName: 'Window Estimate' }), false);
  assert.equal(isGhlOnlyAppointment({}), false);
  assert.equal(isGhlOnlyAppointment(), false);
});
