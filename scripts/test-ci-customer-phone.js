/**
 * Tests — which number on a call belongs to the customer
 * scripts/test-ci-customer-phone.js
 *
 * THE TRAP THIS GUARDS, AND IT IS THE WHOLE FILE:
 *
 * buildCallRow() used to set customer_phone from the ANI unconditionally. That
 * is right on INBOUND — the customer dialled us — and wrong on everything else,
 * where the dialer placed the call and the ANI is a Reece local-presence caller
 * ID. Measured live 2026-08-24: 13,944 of 15,114 rows (92%) named a Reece
 * number as the customer.
 *
 * It failed in two directions at once:
 *   a) The recording join searched a Reece number. Five9 names a recording file
 *      after the number DIALLED, so it never matched. 44 calls sat at
 *      review_reason='recording_missing' with recording segments in
 *      raw_metadata — Five9 saying the audio existed.
 *   b) THE DANGEROUS ONE. customer_phone feeds the phone-tier LP/GHL match, so
 *      an outbound note either failed to match or attached to whatever record
 *      holds that Reece caller ID. Silently. ~2/3 of dialer volume is outbound.
 *
 * The rule that fixes it is asymmetric ON PURPOSE: inbound is the special case
 * and everything else — including a direction Five9 has not invented yet —
 * takes the DNIS. Treating an unknown direction as inbound is what produced
 * the bug.
 *
 * No network, no DB. Run: node --test scripts/test-ci-customer-phone.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { customerNumberFor, customerE164For, buildCallRow } from '../src/ci/discovery.js';
import { parseConfig } from '../src/ci/config.js';
import {
  isCampaignTimeMatch,
  RECORDING_MATCH_CAMPAIGN_TIME,
  RECORDING_MATCH_CAMPAIGN_TIME_LEGACY,
} from '../src/ci/recordings.js';
import { planRow, planRepair, countByDirection, parseArgs } from './repair-ci-customer-phone.js';

const CFG = parseConfig({});

// ─── the rule ───────────────────────────────────────────────────────────────

test('INBOUND uses the ANI — the customer dialled us', () => {
  assert.equal(customerNumberFor({ direction: 'Inbound', ani: '9419203087', dnis: '8555768943' }), '9419203087');
});

test('Outbound, Manual and Preview all use the DNIS', () => {
  for (const direction of ['Outbound', 'Manual', 'Preview']) {
    assert.equal(
      customerNumberFor({ direction, ani: '8555768943', dnis: '9125520152' }),
      '9125520152',
      `${direction} must resolve to the DNIS`,
    );
  }
});

/*
 * The three calls the root cause was proven on, live 2026-08-24. If this test
 * ever fails, the rule has regressed on real, verified traffic.
 */
test('the three verified live calls resolve to their documented customer numbers', () => {
  const cases = [
    { five9_call_id: '300000010259677', direction: 'Manual', ani: '8555768943', dnis: '9125520152', expect: '9125520152' },
    { five9_call_id: '300000010259676', direction: 'Preview', ani: '3213429858', dnis: '4436170733', expect: '4436170733' },
    { five9_call_id: '300000010259655', direction: 'Preview', ani: '3527223289', dnis: '3212765070', expect: '3212765070' },
  ];
  for (const c of cases) {
    assert.equal(customerNumberFor(c), c.expect, `call ${c.five9_call_id}`);
    assert.equal(customerE164For(c), `+1${c.expect}`, `call ${c.five9_call_id} e164`);
  }
});

test('an UNRECOGNISED direction takes the outbound branch, never the inbound one', () => {
  // The live values this rule was not written for, and any future one.
  assert.equal(customerNumberFor({ direction: '3rd party conference', ani: 'a1112223333', dnis: '4445556666' }), '4445556666');
  assert.equal(customerNumberFor({ direction: 'Internal', ani: '1112223333', dnis: '4445556666' }), '4445556666');
  assert.equal(customerNumberFor({ direction: 'Something Five9 Adds In 2027', ani: '1112223333', dnis: '4445556666' }), '4445556666');
  assert.equal(customerNumberFor({ direction: null, ani: '1112223333', dnis: '4445556666' }), '4445556666');
  assert.equal(customerNumberFor({ ani: '1112223333', dnis: '4445556666' }), '4445556666');
});

test("'Inbound Voicemail' contains 'inbound' and is treated as inbound", () => {
  assert.equal(customerNumberFor({ direction: 'Inbound Voicemail', ani: '9419203087', dnis: '8555768943' }), '9419203087');
});

test('the direction test is case-insensitive', () => {
  assert.equal(customerNumberFor({ direction: 'INBOUND', ani: '9419203087', dnis: '8555768943' }), '9419203087');
  assert.equal(customerNumberFor({ direction: 'inbound', ani: '9419203087', dnis: '8555768943' }), '9419203087');
});

// ─── the fallbacks, which are deliberately one-way ──────────────────────────

test('a non-inbound call with a null or blank DNIS falls back to the ANI', () => {
  assert.equal(customerNumberFor({ direction: 'Outbound', ani: '9419203087', dnis: null }), '9419203087');
  assert.equal(customerNumberFor({ direction: 'Outbound', ani: '9419203087', dnis: '' }), '9419203087');
  assert.equal(customerNumberFor({ direction: 'Outbound', ani: '9419203087', dnis: '   ' }), '9419203087');
});

/*
 * The asymmetry that matters. A withheld caller ID leaves an inbound ANI empty,
 * and the DNIS on an inbound call is REECE'S OWN inbound number. Falling back
 * there would write a company line into customer_phone and hand the matcher a
 * Reece number to resolve — the same failure this whole change exists to end.
 */
test('INBOUND does NOT fall back to the DNIS — null is the honest answer', () => {
  assert.equal(customerNumberFor({ direction: 'Inbound', ani: null, dnis: '8555768943' }), null);
  assert.equal(customerNumberFor({ direction: 'Inbound', ani: '', dnis: '8555768943' }), null);
});

test('a call with neither number resolves to null, not a crash', () => {
  assert.equal(customerNumberFor({ direction: 'Outbound', ani: null, dnis: null }), null);
  assert.equal(customerE164For({ direction: 'Outbound', ani: null, dnis: null }), null);
  assert.equal(customerNumberFor(null), null);
  assert.equal(customerNumberFor(undefined), null);
});

// ─── e164 derives from the SAME field ───────────────────────────────────────

test('customer_phone_e164 always derives from whatever customerNumberFor chose', () => {
  const outbound = { direction: 'Outbound', ani: '8555768943', dnis: '9125520152' };
  assert.equal(customerE164For(outbound), '+19125520152');
  assert.equal(customerE164For(outbound), `+1${customerNumberFor(outbound)}`);

  const inbound = { direction: 'Inbound', ani: '9419203087', dnis: '8555768943' };
  assert.equal(customerE164For(inbound), '+19419203087');
  assert.equal(customerE164For(inbound), `+1${customerNumberFor(inbound)}`);
});

test('e164 normalizes formatting and 11-digit forms through last10', () => {
  assert.equal(customerE164For({ direction: 'Outbound', dnis: '+1 (912) 552-0152' }), '+19125520152');
  assert.equal(customerE164For({ direction: 'Outbound', dnis: '19125520152' }), '+19125520152');
});

// ─── buildCallRow wires both columns to the helper ──────────────────────────

/** One report leg, as zipRow() produces it. */
function leg(over = {}) {
  return {
    callId: '300000010259677',
    sessionId: 's1',
    timestamp: '08/24/2026 09:15:00 AM',
    duration: '00:02:15',
    direction: 'Manual',
    ani: '8555768943',
    dnis: '9125520152',
    campaign: 'Main Number',
    skill: null,
    disposition: 'Sale',
    agentUsername: 'cdeer',
    agentName: 'Chris Deer',
    agentId: null,
    recordings: '09:15:00 (2:15)',
    ...over,
  };
}

test('buildCallRow writes the DNIS to BOTH derived columns on an outbound call', () => {
  const { row } = buildCallRow([leg()], null, CFG);
  assert.equal(row.customer_phone, '9125520152');
  assert.equal(row.customer_phone_e164, '+19125520152');
});

test('buildCallRow writes the ANI to both derived columns on an inbound call', () => {
  const { row } = buildCallRow([leg({ direction: 'Inbound', ani: '9419203087', dnis: '8555768943' })], null, CFG);
  assert.equal(row.customer_phone, '9419203087');
  assert.equal(row.customer_phone_e164, '+19419203087');
});

/*
 * ani and dnis are the audit trail the repair script reads back. If discovery
 * ever starts normalizing them, a repair recomputed from them is recomputed
 * from something already massaged, and the raw record of what Five9 reported
 * is gone.
 */
test('ani and dnis are stored RAW and are never rewritten', () => {
  const { row } = buildCallRow([leg({ ani: '8555768943', dnis: '9125520152' })], null, CFG);
  assert.equal(row.ani, '8555768943');
  assert.equal(row.dnis, '9125520152');
});

// ─── the recording match_method rename ──────────────────────────────────────

test('the join now reports campaign_customer_time', () => {
  assert.equal(RECORDING_MATCH_CAMPAIGN_TIME, 'campaign_customer_time');
});

/*
 * ci_recordings rows written before this change carry the legacy string and the
 * column has no CHECK constraint. Nothing may ever treat those rows as
 * unmatched — hence a predicate, not an equality test against one name.
 */
test('the legacy campaign_ani_time string still reads as a campaign+time match', () => {
  assert.equal(RECORDING_MATCH_CAMPAIGN_TIME_LEGACY, 'campaign_ani_time');
  assert.ok(isCampaignTimeMatch('campaign_ani_time'), 'existing rows must still parse');
  assert.ok(isCampaignTimeMatch('campaign_customer_time'));
  assert.ok(!isCampaignTimeMatch('manual'));
  assert.ok(!isCampaignTimeMatch(null));
});

// ─── the repair script's pure planners ──────────────────────────────────────

/** A stored ci_calls row, as the repair script reads it. */
function stored(over = {}) {
  return {
    id: 'uuid-1',
    five9_call_id: '300000010259677',
    direction: 'Manual',
    ani: '8555768943',
    dnis: '9125520152',
    // The wrong value the old code wrote.
    customer_phone: '8555768943',
    customer_phone_e164: '+18555768943',
    ...over,
  };
}

test('the repair recomputes both columns from the stored ani/dnis/direction', () => {
  const p = planRow(stored());
  assert.equal(p.changed, true);
  assert.equal(p.fromPhone, '8555768943');
  assert.equal(p.toPhone, '9125520152');
  assert.equal(p.fromE164, '+18555768943');
  assert.equal(p.toE164, '+19125520152');
});

test('the repair is IDEMPOTENT — an already-correct row is not a change', () => {
  const alreadyFixed = stored({ customer_phone: '9125520152', customer_phone_e164: '+19125520152' });
  assert.equal(planRow(alreadyFixed).changed, false);
  assert.equal(planRepair([alreadyFixed]).length, 0);

  // And the output of a repair is a fixed point: feed it back in, nothing moves.
  const p = planRow(stored());
  const after = stored({ customer_phone: p.toPhone, customer_phone_e164: p.toE164 });
  assert.equal(planRow(after).changed, false);
});

test('the repair leaves correct inbound rows alone', () => {
  const inbound = stored({ direction: 'Inbound', ani: '9419203087', dnis: '8555768943', customer_phone: '9419203087', customer_phone_e164: '+19419203087' });
  assert.equal(planRow(inbound).changed, false);
});

/*
 * The handoff is explicit: touch customer_phone and customer_phone_e164, and
 * nothing else. status, attempts and the lock columns belong to the pipeline's
 * state machine, and a repair that moved them would drag in-flight calls
 * backwards or strand them.
 */
test('a planned repair names ONLY the two derived columns as targets', () => {
  const p = planRow(stored());
  const written = new Set(['toPhone', 'toE164']);
  for (const forbidden of ['status', 'attempts', 'locked_until', 'locked_by', 'next_retry_at', 'review_reason', 'ani', 'dnis']) {
    assert.ok(!(forbidden in p), `the plan must not carry ${forbidden}`);
  }
  assert.ok([...written].every((k) => k in p));
});

test('planRepair reports only the rows that actually differ', () => {
  const rows = [
    stored({ id: 'a' }),                                                     // wrong -> changes
    stored({ id: 'b', customer_phone: '9125520152', customer_phone_e164: '+19125520152' }), // right -> no change
    stored({ id: 'c', direction: 'Preview', ani: '3213429858', dnis: '4436170733' }),       // wrong -> changes
  ];
  const planned = planRepair(rows);
  assert.deepEqual(planned.map((p) => p.id), ['a', 'c']);
});

test('the repair reports its changes broken down by direction', () => {
  const planned = planRepair([
    stored({ id: 'a', direction: 'Outbound' }),
    stored({ id: 'b', direction: 'Outbound' }),
    stored({ id: 'c', direction: 'Manual' }),
    stored({ id: 'd', direction: null, customer_phone: 'x', customer_phone_e164: 'y' }),
  ]);
  assert.deepEqual(countByDirection(planned), { Outbound: 2, Manual: 1, '(null)': 1 });
});

test('the repair is dry-run unless --execute is passed', () => {
  assert.equal(parseArgs([]).execute, false);
  assert.equal(parseArgs(['--limit=50']).execute, false);
  assert.equal(parseArgs(['--execute']).execute, true);
  assert.equal(parseArgs(['--limit=50']).limit, 50);
  assert.equal(parseArgs(['--limit=nonsense']).limit, null);
});

/*
 * The repair and discovery must never hold two different opinions about which
 * number is the customer. This asserts they are literally the same function,
 * not two that agree today.
 */
test('the repair derives its answer from the same helper discovery uses', () => {
  const row = stored({ direction: 'Preview', ani: '3527223289', dnis: '3212765070' });
  assert.equal(planRow(row).toPhone, customerNumberFor(row));
  assert.equal(planRow(row).toE164, customerE164For(row));
});
