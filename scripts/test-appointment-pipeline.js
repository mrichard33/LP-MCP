/**
 * test-appointment-pipeline.js — src/health/appointment-pipeline.js (1.8).
 *
 * Seven evenings as fixtures: for each, the CNF appointments still un-issued
 * at 20:15 ET, and the expected verdict. Prints which nights would have read
 * yellow or red. Also: time gates (20:15 and 20:45 fire once each, nothing
 * else), the Gaps #14 unknown, a failed read is unknown, the capacity rule
 * never treats an unfiled market as zero reps.
 *
 * A read-only replay against the live mirror is
 *   node scripts/replay-appointment-pipeline.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runAppointmentPipelineCheck, resetAppointmentPipelineState, dueSlot, CHECKS, GAPS_14 } from '../src/health/appointment-pipeline.js';
import { resolveStatus } from '../src/health/record.js';

const SNAPSHOT = JSON.parse(readFileSync(new URL('../src/health/registry.snapshot.json', import.meta.url)));
const REGISTRY = new Map(SNAPSHOT.checks.map((r) => [r.check_id, r]));
const status = (e) => resolveStatus(e, REGISTRY.get(e.check_id));
// 20:15 EDT = 00:15Z the next calendar day.
const at2015 = (day) => Date.parse(`${day}T00:15:00Z`) + 24 * 3600e3;

const EVENINGS = [
  ['2026-10-08', 0, 'pass'], ['2026-10-09', 1, 'warn'], ['2026-10-10', 0, 'pass'], ['2026-10-11', 4, 'fail'],
  ['2026-10-12', 2, 'warn'], ['2026-10-13', 0, 'pass'], ['2026-10-14', 1, 'warn'],
];
const lead = (i) => ({ lp_lead_id: String(583000 + i), first_name: 'Pat', last_name: 'Q', phone: '3525550188', lead_source: 'Internet', lp_branch_id: 'ORL', appt_wall: '2026-10-15 10:00', rep_name: 'Snowden, Starr' });

test('seven evenings: un-issued CNF appointments at 20:15', async () => {
  const lines = [];
  for (const [day, unissued, want] of EVENINGS) {
    resetAppointmentPipelineState();
    const out = await runAppointmentPipelineCheck({
      env: {}, nowMs: at2015(day), only: ['appt.issue_by_2000'],
      deps: { registry: REGISTRY, supabase: null, runSQL: async () => Array.from({ length: unissued }, (_, i) => lead(i)) },
    });
    const e = out.health[0];
    assert.equal(e.detail.checked_at_et, '20:15');
    assert.equal(status(e), want, day);
    lines.push(`${day}: ${unissued} un-issued at 20:15 → ${status(e)}`);
  }
  console.log(lines.join('\n'));
});

test('time gates: 20:15 and 20:45 fire once each, nothing between', () => {
  resetAppointmentPipelineState();
  const spec = CHECKS['appt.issue_by_2000'];
  const base = Date.parse('2026-10-15T00:00:00Z'); // 20:00 EDT
  assert.equal(dueSlot('x', spec, base), null);
  const a = dueSlot('x', spec, base + 16 * 60e3);
  assert.equal(a.firedAt, '20:15');
  assert.equal(dueSlot('x', spec, base + 16 * 60e3).firedAt, '20:15', 'until marked run');
});

test('20:45 un-issued is fail even for one', async () => {
  resetAppointmentPipelineState();
  const out = await runAppointmentPipelineCheck({
    env: {}, nowMs: Date.parse('2026-10-15T00:46:00Z'), only: ['appt.issue_by_2000'],
    deps: { registry: REGISTRY, supabase: null, runSQL: async () => [lead(1)] },
  });
  const e = out.health.find((h) => h.detail?.checked_at_et === '20:45');
  assert.ok(e, '20:45 slot fired');
  assert.equal(status(e), 'fail');
});

test('rep acknowledgement reads unknown with the Gaps #14 reason', async () => {
  resetAppointmentPipelineState();
  const out = await runAppointmentPipelineCheck({ env: {}, nowMs: Date.parse('2026-10-15T11:31:00Z'), force: true, only: ['appt.rep_not_acknowledged'], deps: { registry: REGISTRY, supabase: null, runSQL: async () => [] } });
  assert.equal(out.health[0].status, 'unknown');
  assert.match(out.health[0].summary, new RegExp(GAPS_14));
});

test('a failed read is unknown, never pass', async () => {
  resetAppointmentPipelineState();
  const out = await runAppointmentPipelineCheck({ env: {}, nowMs: at2015('2026-10-14'), only: ['appt.issue_by_2000'], deps: { registry: REGISTRY, supabase: null, runSQL: async () => { throw new Error('statement timeout'); } } });
  assert.equal(out.health[0].status, 'unknown');
});

test('capacity: an unfiled market is never zero reps', async () => {
  resetAppointmentPipelineState();
  const runSQL = async (q) => {
    if (/lp_capacity_slots/.test(q)) return [{ market: 'ORL_MKT', slot_id: 1, reps: 2 }];
    return [{ market: 'ORL_MKT', hour: 10, n: 4 }, { market: 'JAX_MKT', hour: 10, n: 9 }];
  };
  const out = await runAppointmentPipelineCheck({ env: {}, nowMs: Date.parse('2026-10-14T23:31:00Z'), only: ['appt.capacity_over'], deps: { registry: REGISTRY, supabase: null, runSQL } });
  const e = out.health[0];
  assert.deepEqual(e.detail.markets_not_filed, ['JAX_MKT']);
  assert.equal(e.detail.over[0].over, 2);
  assert.equal(status(e), 'warn');
});

test('mode off writes nothing', async () => {
  assert.equal((await runAppointmentPipelineCheck({ env: { APPT_PIPELINE_MODE: 'off' } })).skipped, true);
});
