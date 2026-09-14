/**
 * test-fail-closed-conditions.js — Phase 5 of the 2026-07-03 rebuild
 * (pipeline-integrity breach: rules fired as wildcards when the data their
 * conditions referenced was absent or unreadable).
 *
 * Exercises the no-I/O paths of evaluateContextConditions via the _internal
 * test surface: absent numeric intelligence, unknown condition operators,
 * and absent payload fields must all evaluate FALSE (suppress the rule),
 * never pass. DB/GHL-backed conditions (lp_disposition_in, tag reads) are
 * covered by code paths that fail closed on lookup errors — verified in
 * review; they need live fixtures to unit-test and are exercised post-deploy
 * via rule.condition_failed_closed events.
 *
 * Also locks in inferChannelFromEvent's livechat mapping (channel flip fix).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const { _internal } = await import('../src/decision-engine.js');
const { evaluateContextConditions, inferChannelFromEvent, dedupPolicy, isAppointmentSyncRule } = _internal;

const bareEvent = (payload = {}) => ({ id: 1, ghl_contact_id: 'c-test', payload });

// ── fail-closed on absent data ──────────────────────────────────────

test('buyer_stage_gte with NO buyer_stage anywhere → false (was: 0-coerced wildcard on lte)', async () => {
  assert.equal(await evaluateContextConditions({ buyer_stage_gte: 3 }, {}, bareEvent()), false);
});

test('buyer_stage_lte with NO buyer_stage → false (the old 0 ≤ N wildcard pass)', async () => {
  assert.equal(await evaluateContextConditions({ buyer_stage_lte: 3 }, {}, bareEvent()), false);
});

test('lead_score_lte with NO lead_score → false', async () => {
  assert.equal(await evaluateContextConditions({ lead_score_lte: 50 }, {}, bareEvent()), false);
});

test('days_in_stage_gte with NO days_in_current_stage → false', async () => {
  assert.equal(await evaluateContextConditions({ days_in_stage_gte: 2 }, {}, bareEvent()), false);
});

test('unknown condition operator → false (was: warn + wildcard pass)', async () => {
  assert.equal(await evaluateContextConditions({ lp_dispositon_in_typo: ['Set'] }, {}, bareEvent()), false);
});

// 2026-07-11 — event_subtype_in allowlist (DNC-lift trigger gate). For
// lp.disposition_changed the event_subtype IS the disposition code; for
// five9.disposition_set it is the disposition_name. Fail-closed on
// absent/unlisted subtype.
test('event_subtype_in: matches a listed subtype (LP booking codes)', async () => {
  const ev = { id: 1, ghl_contact_id: 'c1', event_subtype: 'Cnf', payload: {} };
  assert.equal(await evaluateContextConditions({ event_subtype_in: ['Set', 'Cnf', 'Verif'] }, {}, ev), true);
});

test('event_subtype_in: blocks an unlisted subtype (e.g. DNC)', async () => {
  const ev = { id: 1, ghl_contact_id: 'c1', event_subtype: 'DNC', payload: {} };
  assert.equal(await evaluateContextConditions({ event_subtype_in: ['Set', 'Cnf', 'Verif'] }, {}, ev), false);
});

test('event_subtype_in: absent subtype fails closed', async () => {
  const ev = { id: 1, ghl_contact_id: 'c1', payload: {} }; // no event_subtype
  assert.equal(await evaluateContextConditions({ event_subtype_in: ['Set'] }, {}, ev), false);
});

test('event_subtype_in: Five9 disposition_name allowlist', async () => {
  const ev = { id: 1, ghl_contact_id: 'c1', event_subtype: 'Appointment Set', payload: {} };
  assert.equal(await evaluateContextConditions({ event_subtype_in: ['Appointment Set', 'Confirmed'] }, {}, ev), true);
  const na = { id: 1, ghl_contact_id: 'c1', event_subtype: 'NA', payload: {} };
  assert.equal(await evaluateContextConditions({ event_subtype_in: ['Appointment Set', 'Confirmed'] }, {}, na), false);
});

// 2026-07-11 — appointment-sync dedup policy (double-create guard). The
// LP_APPT_GHL_SYNC_* rules must dedup so two near-simultaneous Cnf events can't
// each create an appointment (canary: Sue Shanks — two confirmed 2:00 PM appts).
// They dedup on IN-FLIGHT statuses only, so a legitimate later re-sync still fires.
test('isAppointmentSyncRule matches the LP_APPT_GHL_SYNC_ family only', () => {
  assert.equal(isAppointmentSyncRule('LP_APPT_GHL_SYNC_CNF'), true);
  assert.equal(isAppointmentSyncRule('LP_APPT_GHL_SYNC_CXL'), true);
  assert.equal(isAppointmentSyncRule('LP_DISP_CNF'), false);
  assert.equal(isAppointmentSyncRule('BEHAVIORAL_GHOST_AFTER_BOOKING'), false);
  assert.equal(isAppointmentSyncRule(null), false);
});

test('dedupPolicy: appointment-sync rules dedup on IN-FLIGHT statuses only (not completed)', () => {
  const p = dedupPolicy('LP_APPT_GHL_SYNC_CNF');
  assert.ok(p, 'appt-sync must be deduped');
  assert.equal(p.group, null);                              // exact rule_applied match
  assert.ok(!p.statuses.includes('completed'), 'a completed sync must NOT block a legitimate later re-sync');
  assert.deepEqual(p.statuses, ['pending', 'pending_approval', 'approved', 'executing']);
});

test('dedupPolicy: LP_DISP rules group across the family and block on completed', () => {
  const p = dedupPolicy('LP_DISP_CNF');
  assert.equal(p.group, 'LP_DISP_%');
  assert.ok(p.statuses.includes('completed'));
});

test('dedupPolicy: behavioral rules match exactly and block on completed', () => {
  const p = dedupPolicy('BEHAVIORAL_GHOST_AFTER_BOOKING');
  assert.equal(p.group, null);
  assert.ok(p.statuses.includes('completed'));
});

test('dedupPolicy: un-deduped rules return null (e.g. entry hygiene, attribution)', () => {
  assert.equal(dedupPolicy('ENTRY_HYGIENE_AT_CREATION_CANVASSING'), null);
  assert.equal(dedupPolicy('GHL_ATTR_DIGITAL_ENTRY'), null);
  assert.equal(dedupPolicy(null), null);
});

// 2026-07-04 — annotation keys are documentation, not operators. A rule with
// a "description" field inside its conditions JSON must still fire
// (BEHAVIORAL_DISENGAGEMENT_SEVERE was fully disabled by the fail-closed
// default treating "description" as an unknown operator).
test('annotation keys (description/notes/_comment) are skipped, not fail-closed', async () => {
  assert.equal(await evaluateContextConditions(
    { description: 'severe disengagement gate', buyer_stage_gte: 3 },
    { buyer_stage: 4 }, bareEvent()), true);
  assert.equal(await evaluateContextConditions(
    { notes: 'doc', _comment: 'doc' }, {}, bareEvent()), true);
  // real conditions still evaluated alongside annotations
  assert.equal(await evaluateContextConditions(
    { description: 'doc', buyer_stage_gte: 3 },
    { buyer_stage: 2 }, bareEvent()), false);
});

test('payload_message_not_matches with NO message_text → false (text blocklist cannot pass unseen)', async () => {
  assert.equal(await evaluateContextConditions({ payload_message_not_matches: 'stop' }, {}, bareEvent()), false);
});

// ── data present still evaluates normally ───────────────────────────

test('buyer_stage present and satisfying → true', async () => {
  assert.equal(await evaluateContextConditions({ buyer_stage_gte: 3 }, { buyer_stage: 4 }, bareEvent()), true);
});

test('buyer_stage present and failing → false', async () => {
  assert.equal(await evaluateContextConditions({ buyer_stage_gte: 3 }, { buyer_stage: 2 }, bareEvent()), false);
});

test('payload field conditions still work when data is present', async () => {
  assert.equal(await evaluateContextConditions({ payload_field_not_null: 'message_id' }, {}, bareEvent({ message_id: 'abc' })), true);
  assert.equal(await evaluateContextConditions({ payload_field_not_null: 'message_id' }, {}, bareEvent({ message_id: null })), false);
  assert.equal(await evaluateContextConditions({ payload_message_not_matches: 'stop' }, {}, bareEvent({ message_text: 'hello there' })), true);
  assert.equal(await evaluateContextConditions({ payload_message_not_matches: 'stop' }, {}, bareEvent({ message_text: 'please stop' })), false);
});

test('empty/absent conditions object → true (unconditional rule unchanged)', async () => {
  assert.equal(await evaluateContextConditions(null, {}, bareEvent()), true);
  assert.equal(await evaluateContextConditions({}, {}, bareEvent()), true);
});

// ── 2026-09-12: evaluation order + not-applicable vs unreadable ──────
//
// The 433,748 fail-closed events since 2026-07-03 were 99% non-events:
// contact-scoped conditions evaluated against dialer traffic that carries no
// GHL contact at all, reported as "contact tags unreadable". Two changes, both
// asserted here: cheap conditions run first, and a missing contact suppresses
// the rule WITHOUT claiming a read failed. Suppression itself never changes.

// A spy pair: collects emitted fail-closed events, and a fetch that proves
// whether the contact-snapshot branch was reached at all.
const spyDeps = () => {
  const emitted = [];
  let fetchCalls = 0;
  return {
    emitted,
    get fetchCalls() { return fetchCalls; },
    deps: {
      emitEvent: async (e) => { emitted.push(e); },
      fetch: async () => { fetchCalls++; return { ok: false, status: 404 }; },
      supabase: null,
      sleep: async () => {},
    },
  };
};

const five9Event = (subtype) => ({
  id: 42, ghl_contact_id: null, event_subtype: subtype, payload: {},
});

// DNC_LIFT_ON_REENGAGEMENT_FIVE9's real conditions, in their authored order:
// has_any_tag FIRST, event_subtype_in second. That order is what ran the tag
// branch on all 460,739 five9.disposition_set events.
const DNC_LIFT_FIVE9_CONDITIONS = {
  has_any_tag: ['stage:dnc', 'lp-dnc', 'dnc', 'dnc-sms', 'loss-reason:dnc'],
  event_subtype_in: ['Appointment Set', 'Confirmed'],
};

test('cheap condition short-circuits before the contact read (DNC-lift on dialer noise)', async () => {
  const spy = spyDeps();
  const ev = five9Event('Dial Error'); // not in the allowlist
  assert.equal(
    await evaluateContextConditions(DNC_LIFT_FIVE9_CONDITIONS, {}, ev, {
      ruleKey: 'DNC_LIFT_ON_REENGAGEMENT_FIVE9', deps: spy.deps,
    }),
    false,
  );
  assert.equal(spy.fetchCalls, 0, 'event_subtype_in must reject before any contact fetch');
  assert.deepEqual(spy.emitted, [], 'a cheap non-match is not a fail-closed event');
});

test('ordering does not change the verdict when the cheap gate passes', async () => {
  const spy = spyDeps();
  const ev = five9Event('Appointment Set'); // allowed subtype → tag branch still runs
  assert.equal(
    await evaluateContextConditions(DNC_LIFT_FIVE9_CONDITIONS, {}, ev, {
      ruleKey: 'DNC_LIFT_ON_REENGAGEMENT_FIVE9', deps: spy.deps,
    }),
    false,
    'no contact → the DNC lift is still suppressed',
  );
});

test('no ghl_contact_id → suppressed SILENTLY (nothing was read, so nothing failed)', async () => {
  const spy = spyDeps();
  const ev = { id: 7, ghl_contact_id: null, payload: {} };
  assert.equal(
    await evaluateContextConditions({ has_any_tag: ['dnc'] }, {}, ev, {
      ruleKey: 'SOME_RULE', deps: spy.deps,
    }),
    false,
    'suppression is unchanged — this is the load-bearing half',
  );
  assert.deepEqual(spy.emitted, [], 'no contact on the event is not an unreadable read');
  assert.ok(ev._failClosedRules?.has('SOME_RULE'), 'still recorded for responder-silence diagnostics');
});

test('contact present but tags unreadable → still emits (the signal that was buried)', async () => {
  const spy = spyDeps();
  const ev = { id: 8, ghl_contact_id: 'c-real', payload: {} };
  assert.equal(
    await evaluateContextConditions({ has_any_tag: ['dnc'] }, {}, ev, {
      ruleKey: 'SOME_RULE', deps: spy.deps,
    }),
    false,
  );
  assert.equal(spy.emitted.length, 1, 'a real failed read must stay observable');
  assert.equal(spy.emitted[0].event_type, 'rule.condition_failed_closed');
  assert.equal(spy.emitted[0].payload.detail, 'contact tags unreadable');
  assert.equal(spy.emitted[0].payload.rule_key, 'SOME_RULE');
  assert.equal(spy.emitted[0].ghl_contact_id, 'c-real');
});

test('lp_disposition_in with no contact → silent; unknown operator still emits', async () => {
  const noContact = spyDeps();
  const ev1 = { id: 9, ghl_contact_id: null, payload: {} };
  assert.equal(
    await evaluateContextConditions({ lp_disposition_in: ['CXL'] }, {}, ev1, {
      ruleKey: 'R1', deps: noContact.deps,
    }),
    false,
  );
  assert.deepEqual(noContact.emitted, []);

  // An unknown operator is a rule-authoring defect, not dialer noise — it names
  // a rule that is silently dead, so it keeps emitting regardless of contact.
  const unknown = spyDeps();
  const ev2 = { id: 10, ghl_contact_id: null, payload: {} };
  assert.equal(
    await evaluateContextConditions({ lp_dispositon_in_typo: ['CXL'] }, {}, ev2, {
      ruleKey: 'R2', deps: unknown.deps,
    }),
    false,
  );
  assert.equal(unknown.emitted.length, 1);
  assert.equal(unknown.emitted[0].payload.detail, 'unknown condition operator');
});

// ── livechat channel inference (channel-flip fix) ───────────────────

test('inferChannelFromEvent: TYPE_LIVE_CHAT → livechat (was: null → sms at send time)', () => {
  assert.equal(inferChannelFromEvent({ payload: { message_type: 'TYPE_LIVE_CHAT' } }), 'livechat');
  assert.equal(inferChannelFromEvent({ payload: { message_type: 'TYPE_WEBCHAT' } }), 'livechat');
  assert.equal(inferChannelFromEvent({ payload: { channel: 'livechat' } }), 'livechat');
});

test('inferChannelFromEvent: sms/email unchanged', () => {
  assert.equal(inferChannelFromEvent({ payload: { message_type: 'TYPE_SMS' } }), 'sms');
  assert.equal(inferChannelFromEvent({ payload: { message_type: 'TYPE_EMAIL' } }), 'email');
  assert.equal(inferChannelFromEvent({ payload: { channel: 'sms' } }), 'sms');
  assert.equal(inferChannelFromEvent({ payload: {} }), null);
});
