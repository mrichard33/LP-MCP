/**
 * Backfill same-day skip (Change D1) — scripts/test-ghl-appointment-backfill-same-day.js
 *
 * The acceptance is exact: a dry run on a day with same-day candidates reports
 * them under `skipped_same_day` and NOT under `create`; `skip_same_day: false`
 * restores them. Driven through the backfill's deps seam, so nothing reaches
 * Supabase or GHL.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runGhlAppointmentBackfill } from '../src/admin/ghl-appointment-backfill.js';

// Noon ET on 2026-09-14. LP stores ET wall-clock digits tagged +00:00.
const NOW = Date.parse('2026-09-14T16:00:00Z');

const TODAY_LATER = { lp_lead_id: '1', ghl_contact_id: 'today', disposition_code: 'Set', appointment_date: '2026-09-14T18:00:00+00:00', first_name: 'Same', last_name: 'Day' };
const TOMORROW = { lp_lead_id: '2', ghl_contact_id: 'tomorrow', disposition_code: 'Set', appointment_date: '2026-09-15T10:00:00+00:00', first_name: 'Next', last_name: 'Day' };
const TODAY_CXL = { lp_lead_id: '3', ghl_contact_id: 'today-cxl', disposition_code: 'CXL', appointment_date: '2026-09-14T18:00:00+00:00', first_name: 'Cancelled', last_name: 'Today' };

function run(over = {}) {
  const seen = [];
  const targets = (over.targets || [TODAY_LATER, TOMORROW]).map((lead) => ({ lead, superseded: 0 }));
  return runGhlAppointmentBackfill({
    dryRun: true,
    horizonDays: 14,
    stragglerCancel: false,
    ...over.opts,
    deps: {
      nowMs: NOW,
      scanBackfillCandidates: async () => ({ targets, unlinked: [], total_rows: targets.length, linked_contacts: targets.length }),
      reconcileLpAppointmentToGhl: async ({ lead }) => {
        seen.push(lead.ghl_contact_id);
        return { outcome: 'noop', skipped: true, reason: 'dry_run', planned_op: 'create', appointment_id: null };
      },
    },
  }).then((summary) => ({ summary, seen }));
}

test('DEFAULT: same-day candidates are skipped, not created', async () => {
  const { summary, seen } = await run();

  assert.equal(summary.skip_same_day, true, 'skip_same_day defaults to true');
  assert.equal(summary.counts.skipped_same_day, 1);
  assert.equal(summary.counts.create, 1, 'only the non-same-day lead is planned as a create');
  assert.deepEqual(seen, ['tomorrow'], 'the reconciler is never called for a same-day lead');
});

test('a skipped row carries its lead and contact ids (silent exclusion is worse than none)', async () => {
  const { summary } = await run();
  assert.equal(summary.skipped_same_day.length, 1);
  const line = summary.skipped_same_day[0];
  assert.match(line, /^today /, 'contact id');
  assert.match(line, /lead=1/, 'lp lead id');
  assert.match(line, /skipped_same_day/);
  assert.ok(summary.lines.includes(line), 'also present in the per-contact plan');
});

test('skip_same_day:false restores them', async () => {
  const { summary, seen } = await run({ opts: { skipSameDay: false } });
  assert.equal(summary.skip_same_day, false);
  assert.equal(summary.counts.skipped_same_day, undefined);
  assert.equal(summary.counts.create, 2);
  assert.deepEqual(seen.sort(), ['today', 'tomorrow']);
});

test('a same-day CXL still cancels — converging a dead appointment to zero removes a reminder', async () => {
  const { summary, seen } = await run({ targets: [TODAY_CXL] });
  assert.equal(summary.counts.skipped_same_day, undefined);
  assert.deepEqual(seen, ['today-cxl']);
});

test('a skipped same-day contact is kept out of the straggler scope', async () => {
  // We did not place today's appointment, so cancelling their stale one would
  // leave the contact with nothing on either side.
  let scope = null;
  await runGhlAppointmentBackfill({
    dryRun: true,
    deps: {
      nowMs: NOW,
      scanBackfillCandidates: async () => ({
        targets: [TODAY_LATER, TOMORROW].map((lead) => ({ lead, superseded: 0 })),
        unlinked: [], total_rows: 2, linked_contacts: 2,
      }),
      reconcileLpAppointmentToGhl: async () => ({ outcome: 'noop', skipped: true, reason: 'dry_run', planned_op: 'create' }),
      runStragglerCancelPass: async (args) => { scope = args.scope; return { ran: true, reason: null, planned: [], cancelled: 0, skipped: [], errors: [] }; },
    },
  });
  assert.deepEqual(Array.from(scope.keys()), ['tomorrow']);
});

test('the straggler pass runs AFTER the reconciler, and is handed what the reconciler touched', async () => {
  const order = [];
  let touched = null;
  await runGhlAppointmentBackfill({
    dryRun: true,
    deps: {
      nowMs: NOW,
      scanBackfillCandidates: async () => ({ targets: [{ lead: TOMORROW, superseded: 0 }], unlinked: [], total_rows: 1, linked_contacts: 1 }),
      reconcileLpAppointmentToGhl: async () => {
        order.push('reconcile');
        return { outcome: 'noop', skipped: true, reason: 'dry_run', planned_op: 'reschedule', appointment_id: 'APPT-1' };
      },
      runStragglerCancelPass: async (args) => {
        order.push('straggler');
        touched = args.touchedAppointmentIds;
        return { ran: true, reason: null, planned: [], cancelled: 0, skipped: [], errors: [] };
      },
    },
  });
  assert.deepEqual(order, ['reconcile', 'straggler']);
  assert.ok(touched.has('APPT-1'), 'an appointment just rescheduled must not read as a straggler');
});

test('straggler_cancel:false leaves the pass unrun and reported as disabled', async () => {
  const { summary } = await run();
  assert.equal(summary.straggler_cancel.ran, false);
  assert.equal(summary.straggler_cancel.reason, 'disabled');
});
