/**
 * Leads stalling after After DIAL ASAP (handoff v3.4 Fix 6, 2026-10-16).
 * Olga 8134839869 (LP 583671): DIAL ASAP Answering Machine at 12:02Z, then two
 * manual "Main Number" dials (NA, NA) by the same agent. Her last event was not
 * a DIAL ASAP call, so the retry job never saw her.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { pickCandidates, lastDialerEvent, decide, retryConfig } = await import('../src/after-asap-retry.js');
const { REASON_LABELS, reasonText } = await import('../src/lead-speed-alerts.js');

const OLGA = [
  { dnis: '8134839869', ani: '8134455292', campaign: 'DIAL ASAP', d: 'Answering Machine', lp_rec_key: 'INQ430872', t: '2026-10-15T12:02:34Z' },
  { dnis: '8134839869', ani: '8133282028', campaign: 'Main Number', d: 'NA', lp_rec_key: 'INQ430872', t: '2026-10-15T12:03:30Z' },
  { dnis: '8134839869', ani: '8133282028', campaign: 'Main Number', d: 'NA', lp_rec_key: 'INQ430872', t: '2026-10-15T12:05:22Z' },
];
const cfg = retryConfig({});

test('Olga: trailing manual no-contact dials do not hide the DIAL ASAP call', () => {
  const c = pickCandidates(OLGA, { nowMs: Date.parse('2026-10-15T13:00:00Z'), cfg });
  assert.equal(c.length, 1);
  assert.deepEqual([c[0].campaign, c[0].dispo, c[0].lpRecKey, c[0].calls24h], ['DIAL ASAP', 'Answering Machine', 'INQ430872', 3]);
});

test('a manual call that REACHED them still ends the follow-up', () => {
  const reached = [...OLGA.slice(0, 2), { ...OLGA[2], d: 'Appointment Set' }];
  assert.equal(pickCandidates(reached, { nowMs: Date.parse('2026-10-15T13:00:00Z'), cfg }).length, 0);
  const list = reached.map((e) => ({ ...e, ms: Date.parse(e.t), outbound: true }));
  assert.equal(lastDialerEvent(list).d, 'Appointment Set');
});

test('the 3-in-24 cap still counts the manual dials (Olga is at 3 → skip)', () => {
  const [cand] = pickCandidates(OLGA, { nowMs: Date.parse('2026-10-15T13:00:00Z'), cfg });
  assert.equal(decide({ cand, rec: null, lpDispo: 'Data', onDnc: false }).reason, 'at_3_in_24_cap');
});

test('never handed to a list: Verif, ND, No Demo', () => {
  const cand = { calls24h: 1, lpRecKey: 'INQ1' };
  assert.equal(decide({ cand, rec: null, lpDispo: 'Verif', onDnc: false }).reason, 'verif_hold');
  assert.equal(decide({ cand, rec: null, lpDispo: 'ND', onDnc: false }).reason, 'lp_ND');
  assert.equal(decide({ cand, rec: null, lpDispo: 'No Demo', onDnc: false }).reason, 'lp_No Demo');
});

test('lead speed: "attempts used up, not handed to next list"', () => {
  assert.equal(REASON_LABELS.attempts_exhausted_not_handed, 'Attempts used up, not handed to next list');
  const text = reasonText({ reason: 'attempts_exhausted_not_handed', calls: { count: 2, lastMs: Date.parse('2026-10-15T12:18:00Z') } }, Date.parse('2026-10-16T12:18:00Z'));
  assert.match(text, /attempts used up/);
  assert.match(text, /not handed to the next list/);
});
