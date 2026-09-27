/**
 * Tests for src/lp-lead-presence.js and the capacity sweep's per-lead
 * near-window refresh (refreshNearWindowLead in src/jobs/capacity-sweep.js).
 *
 * 2026-09-27: LP deleted two duplicate leads (578101, 577827). Asking LP for
 * them by lead id timed out on every pass (99 × in 13h) and the board counted
 * both Monday appointments twice. The decisions pinned here are the ones that
 * could silently erase a REAL appointment if they were wrong, so every
 * "not sure" path must change nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { leadPresenceInProspect } from '../src/lp-lead-presence.js';
import { refreshNearWindowLead } from '../src/jobs/capacity-sweep.js';

// The live shape on 2026-09-27 for customer 345639: the deleted 578101 is gone,
// the real Monday appointment is on 578404.
const BERRY = [{
  cst_id: '345639',
  lastname: 'Berry',
  leads: [{ id: '427721' }, { id: '577885' }, { id: '578404', apptdate: '2026-09-28T11:00:00' }],
}];

const LP_TIMEOUT = new Error('LP API 500: {"Message":"...Execution Timeout Expired..."}');

// ─── the pure decision ──────────────────────────────────────────────────────

test('absent: the right customer came back with leads, and the lead is not among them', () => {
  const r = leadPresenceInProspect(BERRY, { cstId: '345639', ldsId: '578101' });
  assert.equal(r.verdict, 'absent');
  assert.deepEqual(r.leadIds, ['427721', '577885', '578404']);
});

test('present: the lead is on the customer', () => {
  const r = leadPresenceInProspect(BERRY, { cstId: '345639', ldsId: '578404' });
  assert.equal(r.verdict, 'present');
  assert.equal(r.prospect.cst_id, '345639');
});

test('unknown, never absent: a DIFFERENT customer came back (seen live with a narrowed date range)', () => {
  const wrong = [{ cst_id: '548', lastname: 'Baker', leads: [] }];
  assert.equal(leadPresenceInProspect(wrong, { cstId: '345639', ldsId: '578101' }).verdict, 'unknown');
});

test('unknown, never absent: the customer came back with no lead list, or an empty one', () => {
  assert.equal(leadPresenceInProspect([{ cst_id: '345639' }], { cstId: '345639', ldsId: '578101' }).verdict, 'unknown');
  assert.equal(leadPresenceInProspect([{ cst_id: '345639', leads: [] }], { cstId: '345639', ldsId: '578101' }).verdict, 'unknown');
});

test('unknown: nothing came back, or ids are missing', () => {
  assert.equal(leadPresenceInProspect(null, { cstId: '345639', ldsId: '578101' }).verdict, 'unknown');
  assert.equal(leadPresenceInProspect([], { cstId: '345639', ldsId: '578101' }).verdict, 'unknown');
  assert.equal(leadPresenceInProspect(BERRY, { cstId: '', ldsId: '578101' }).verdict, 'unknown');
  assert.equal(leadPresenceInProspect(BERRY, { cstId: '345639', ldsId: null }).verdict, 'unknown');
});

test('ids compare as strings (LP sends numbers or strings)', () => {
  const numeric = [{ cst_id: 345639, leads: [{ id: 578404 }] }];
  assert.equal(leadPresenceInProspect(numeric, { cstId: '345639', ldsId: '578404' }).verdict, 'present');
});

// ─── the per-lead refresh ───────────────────────────────────────────────────

function fakes(over = {}) {
  const calls = { byLead: 0, byCustomer: 0, processed: [], marked: [], warned: [] };
  const deps = {
    getLeadByLdsId: async () => { calls.byLead++; return BERRY; },
    getProspectByCstId: async () => { calls.byCustomer++; return BERRY; },
    processProspect: async (p) => { calls.processed.push(p.cst_id); },
    timeout: (p) => p,
    markDeleted: async (id) => { calls.marked.push(id); },
    log: { warn: (m) => calls.warned.push(m) },
    ...over,
  };
  return { deps, calls };
}

test('the normal case is unchanged: a lead-id fetch that works never touches the customer lookup', async () => {
  const { deps, calls } = fakes();
  assert.equal(await refreshNearWindowLead({ ldsId: '578404', cstId: '345639' }, deps), 'refreshed');
  assert.equal(calls.byCustomer, 0);
  assert.deepEqual(calls.marked, []);
});

test('the 2026-09-27 ghost: lead-id times out, customer is intact without it → marked, not retried forever', async () => {
  const { deps, calls } = fakes({ getLeadByLdsId: async () => { throw LP_TIMEOUT; } });
  assert.equal(await refreshNearWindowLead({ ldsId: '578101', cstId: '345639' }, deps), 'deleted_in_lp');
  assert.deepEqual(calls.marked, ['578101']);
  assert.deepEqual(calls.processed, [], 'a deleted lead is not re-written');
  assert.match(calls.warned[0], /578101 is no longer in LP.*578404/);
});

test('lead-id times out but the lead IS on the customer → refreshed through the same writer', async () => {
  const { deps, calls } = fakes({ getLeadByLdsId: async () => { throw LP_TIMEOUT; } });
  assert.equal(await refreshNearWindowLead({ ldsId: '578404', cstId: '345639' }, deps), 'recovered_by_customer');
  assert.deepEqual(calls.processed, ['345639']);
  assert.deepEqual(calls.marked, []);
});

test('customer lookup fails too → the ORIGINAL error is thrown and nothing is marked', async () => {
  const { deps, calls } = fakes({
    getLeadByLdsId: async () => { throw LP_TIMEOUT; },
    getProspectByCstId: async () => { throw new Error('customer lookup down'); },
  });
  await assert.rejects(refreshNearWindowLead({ ldsId: '578101', cstId: '345639' }, deps), (e) => e === LP_TIMEOUT);
  assert.deepEqual(calls.marked, []);
});

test('customer lookup returns something ambiguous → original error, nothing marked', async () => {
  const { deps, calls } = fakes({
    getLeadByLdsId: async () => { throw LP_TIMEOUT; },
    getProspectByCstId: async () => [{ cst_id: '548', leads: [] }],
  });
  await assert.rejects(refreshNearWindowLead({ ldsId: '578101', cstId: '345639' }, deps), (e) => e === LP_TIMEOUT);
  assert.deepEqual(calls.marked, []);
});

test('no customer id on file → behaves exactly as before (throws the lead-id error)', async () => {
  const { deps, calls } = fakes({ getLeadByLdsId: async () => { throw LP_TIMEOUT; } });
  await assert.rejects(refreshNearWindowLead({ ldsId: '578101', cstId: null }, deps), (e) => e === LP_TIMEOUT);
  assert.equal(calls.byCustomer, 0);
});

test('an empty lead-id answer is still "gone", as before, without a customer lookup', async () => {
  const { deps, calls } = fakes({ getLeadByLdsId: async () => [] });
  assert.equal(await refreshNearWindowLead({ ldsId: '1', cstId: '2' }, deps), 'gone');
  assert.equal(calls.byCustomer, 0);
});

// ─── the board ignores marked leads ─────────────────────────────────────────

test('every board count and the near-window selection exclude lp_deleted_at rows', () => {
  const src = readFileSync(new URL('../src/jobs/capacity-sweep.js', import.meta.url), 'utf8');
  // Each place that reads lp_leads by appointment_date must filter the mark.
  const blocks = src.split(/FROM lp_leads\b/).slice(1).map((b) => b.slice(0, 400));
  const byAppt = blocks.filter((b) => /appointment_date IS NOT NULL/.test(b));
  assert.ok(byAppt.length >= 5, `expected the numerator, hourly, snapshot, refresh and coverage reads, found ${byAppt.length}`);
  for (const b of byAppt) assert.match(b, /lp_deleted_at IS NULL/, `an lp_leads read by appointment_date ignores sql/133:\n${b.slice(0, 200)}`);
});
