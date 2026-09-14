/**
 * test-appointment-parity-alerts.js — ops alerting for the parity watchdog.
 *
 * WHY THIS EXISTS. The watchdog found 27 real divergences every 30 minutes and
 * told nobody. Its only output was an event nothing consumed, and event intake
 * was dropping even that. The ops card is now the route to a human — so it has
 * to survive the two ways an alert dies:
 *
 *   MUTED — 27 standing gaps firing a card every half hour gets switched off
 *   inside a day. CLAUDE.md is blunt about this: a muted alarm is how a
 *   47-hour outage and a 71-day blind spot both went unnoticed. So the alert
 *   is edge-triggered per contact: a standing gap speaks once.
 *
 *   SWALLOWED — a claim marks a key announced, then the send fails. Without a
 *   release the key never retries and the page is silently lost. Same defect
 *   PR #920 fixed in the intake journal.
 *
 * shouldAlertParityGaps is pure, so the decision half needs no stubs. The
 * delivery half is exercised through maybeAlertParityGaps with injected
 * claim/confirm/send so no Supabase, GroupMe or Slack is touched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldAlertParityGaps,
  parityAlertKey,
  formatParityGapCard,
} from '../src/jobs/appointment-parity-alerts.js';

const { __testing } = await import('../src/jobs/appointment-parity-watchdog.js');
const { maybeAlertParityGaps, ALERT_PREFIX } = __testing;

const gap = (id, cls = 'ghl_missing_appointment') => ({
  class: cls, contact_id: id, name: `Lead ${id}`, lp_appointment_date: '2026-09-20T14:00:00+00:00',
});

// ═══════════════════════════════════════════════════════════════════
// Decision — three-way verdict, not a boolean
// ═══════════════════════════════════════════════════════════════════

test('escalation-class findings produce an alert verdict', () => {
  const v = shouldAlertParityGaps({ findings: [gap('a'), gap('b', 'cancellation_drift')] });
  assert.equal(v.verdict, 'alert');
  assert.equal(v.gaps.length, 2);
});

test('an LP-cancelled / GHL-active gap is an escalation, not a heal', () => {
  // Class E (v1.2). It must reach a human: auto-healing it would write the
  // appointment back into LP and silently un-cancel something a human cancelled.
  const v = shouldAlertParityGaps({ findings: [gap('c1', 'lp_cancelled_ghl_active')] });
  assert.equal(v.verdict, 'alert');
  assert.equal(v.gaps.length, 1);

  const text = formatParityGapCard(v.gaps, { totalGaps: 1 });
  assert.match(text, /Cancelled in LP, still ACTIVE in GHL/,
    'the card must say which direction the cancellation went');
});

test('heal-class findings alone are healthy, not an alert', () => {
  // A sweep that only found things it repairs itself must not page. Firing on
  // the healthy case is precisely the habit that gets an alarm muted.
  const v = shouldAlertParityGaps({
    findings: [
      { class: 'lp_missing_appointment', contact_id: 'a' },
      { class: 'confirmation_drift', contact_id: 'b' },
    ],
  });
  assert.equal(v.verdict, 'healthy');
  assert.deepEqual(v.gaps, []);
});

test('an unreadable sweep is insufficient_evidence — neither page nor clear', () => {
  // The case CLAUDE.md says people get wrong. A failed read must not announce a
  // recovery nobody earned, and must not page either.
  assert.equal(shouldAlertParityGaps({ findings: null }).verdict, 'insufficient_evidence');
  assert.equal(shouldAlertParityGaps({}).verdict, 'insufficient_evidence');
  assert.equal(
    shouldAlertParityGaps({ findings: [gap('a')], readOk: false }).verdict,
    'insufficient_evidence',
    'readOk:false must win even when findings are present',
  );
});

test('no findings at all is healthy', () => {
  assert.equal(shouldAlertParityGaps({ findings: [] }).verdict, 'healthy');
});

test('alert keys separate class as well as contact', () => {
  // A contact whose gap changes class is a different condition and should speak
  // again rather than hide behind the first claim.
  const a = parityAlertKey(ALERT_PREFIX, gap('c1', 'ghl_missing_appointment'));
  const b = parityAlertKey(ALERT_PREFIX, gap('c1', 'cancellation_drift'));
  assert.notEqual(a, b);
  assert.ok(a.startsWith(ALERT_PREFIX));
});

// ═══════════════════════════════════════════════════════════════════
// Card body
// ═══════════════════════════════════════════════════════════════════

test('the card names what is new and the backlog separately', () => {
  const text = formatParityGapCard([gap('c1'), gap('c2')], { totalGaps: 27, autoheal: false });
  assert.match(text, /2 new divergence/);
  assert.match(text, /Standing gaps: 27/, 'backlog scale must be visible but not implied to be new');
  assert.match(text, /PARITY_AUTOHEAL is off/, 'a dry sweep must say it repaired nothing');
});

test('the card surfaces the real heal split, not a bare "healed" number', () => {
  const text = formatParityGapCard([gap('c1')], {
    totalGaps: 5, autoheal: true, healed: 0, alreadyPresent: 4, dedupSuppressed: 0,
  });
  assert.match(text, /0 written/);
  assert.match(text, /4 already in LP/,
    'the split is what makes a no-op sweep visible instead of reading as success');
});

test('a long gap list is truncated rather than dumped', () => {
  const many = Array.from({ length: 30 }, (_, i) => gap(`c${i}`));
  const text = formatParityGapCard(many, { totalGaps: 30 });
  assert.match(text, /and 20 more/);
  assert.ok(text.split('\n').length < 25, 'card must stay readable in a chat client');
});

// ═══════════════════════════════════════════════════════════════════
// Delivery — edge-triggering and the swallowed-page guard
// ═══════════════════════════════════════════════════════════════════

function harness({ newlyFiring, claimOk = true, sendResult = { sent: true }, sendThrows = false }) {
  const calls = { sends: [], confirmed: [], deleted: [] };
  const deps = {
    claimAlertConditionSet: async ({ activeKeys }) => ({
      ok: claimOk,
      reason: claimOk ? undefined : 'read_failed',
      newlyFiring: newlyFiring ?? activeKeys,
      cleared: [],
    }),
    confirmAlertSend: async (keys) => { calls.confirmed.push(...keys); return { ok: true }; },
    send: async (text) => {
      calls.sends.push(text);
      if (sendThrows) throw new Error('slack down');
      return sendResult;
    },
    client: {
      from: () => ({ delete: () => ({ in: (_c, keys) => { calls.deleted.push(...keys); return Promise.resolve({}); } }) }),
    },
  };
  return { calls, deps };
}

const sweepWith = (gaps) => ({
  success: true,
  as_of: '2026-09-14T17:00:00.000Z',
  errors: 0,
  findings: gaps,
  outcomes: { healed: 0, already_present: 0, dedup_suppressed: 0 },
});

test('a standing gap alerts once, then stays silent', async () => {
  const gaps = [gap('c1'), gap('c2')];

  // First sweep: the claim reports both keys as new.
  const first = harness({ newlyFiring: null });
  const r1 = await maybeAlertParityGaps(sweepWith(gaps), { dryRun: true, deps: first.deps });
  assert.equal(r1.action, 'alerted');
  assert.equal(first.calls.sends.length, 1);

  // Second sweep, same gaps: the claim reports nothing new. No card.
  const second = harness({ newlyFiring: [] });
  const r2 = await maybeAlertParityGaps(sweepWith(gaps), { dryRun: true, deps: second.deps });
  assert.equal(r2.action, 'silent');
  assert.equal(second.calls.sends.length, 0,
    '27 standing gaps announcing every 30 minutes is how this alarm gets muted');
});

test('only the new gap is named when one appears alongside standing ones', async () => {
  const gaps = [gap('c1'), gap('c2'), gap('c3')];
  const newKey = parityAlertKey(ALERT_PREFIX, gap('c3'));
  const h = harness({ newlyFiring: [newKey] });

  const r = await maybeAlertParityGaps(sweepWith(gaps), { dryRun: true, deps: h.deps });
  assert.equal(r.newly, 1);
  assert.match(h.calls.sends[0], /1 new divergence/);
  assert.match(h.calls.sends[0], /Lead c3/);
  assert.doesNotMatch(h.calls.sends[0], /Lead c1/, 'already-announced gaps must not be re-listed');
  assert.match(h.calls.sends[0], /Standing gaps: 3/);
});

test('a failed send releases the claim so the next sweep retries', async () => {
  // Without this the key stays marked announced and the page is silently lost.
  const gaps = [gap('c1')];
  const h = harness({ newlyFiring: null, sendResult: { sent: false } });

  const r = await maybeAlertParityGaps(sweepWith(gaps), { dryRun: true, deps: h.deps });
  assert.equal(r.action, 'send_failed');
  assert.equal(h.calls.confirmed.length, 0, 'a failed send must not stamp notify_count');
  assert.equal(h.calls.deleted.length, 1, 'the claim must be released for retry');
});

test('a throwing send is treated the same as a failed one', async () => {
  const h = harness({ newlyFiring: null, sendThrows: true });
  const r = await maybeAlertParityGaps(sweepWith([gap('c1')]), { dryRun: true, deps: h.deps });
  assert.equal(r.action, 'send_failed');
  assert.equal(h.calls.deleted.length, 1);
});

test('a degraded claim layer announces nothing', async () => {
  // ok:false is "I could not tell". Sending anyway risks a duplicate card.
  const h = harness({ newlyFiring: null, claimOk: false });
  const r = await maybeAlertParityGaps(sweepWith([gap('c1')]), { dryRun: true, deps: h.deps });
  assert.equal(r.action, 'claim_failed');
  assert.equal(h.calls.sends.length, 0);
});

test('a dry-run sweep still alerts', async () => {
  // PARITY_AUTOHEAL governs WRITES. Reporting is not gated on it — the watchdog
  // ran dry for weeks reporting to nobody, which is the failure this prevents.
  const h = harness({ newlyFiring: null });
  const r = await maybeAlertParityGaps(sweepWith([gap('c1')]), { dryRun: true, deps: h.deps });
  assert.equal(r.action, 'alerted');
});

test('an unreadable sweep sends nothing and clears nothing', async () => {
  const h = harness({ newlyFiring: null });
  const r = await maybeAlertParityGaps(
    { ...sweepWith([gap('c1')]), findings: null }, { dryRun: true, deps: h.deps });
  assert.equal(r.action, 'insufficient_evidence');
  assert.equal(h.calls.sends.length, 0);
  assert.equal(h.calls.deleted.length, 0);
});
