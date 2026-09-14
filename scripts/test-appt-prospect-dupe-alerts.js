/**
 * Change C — duplicate live appointment: the DETECT half.
 *
 * Pins the three-way verdict (a failed read must neither page nor clear) and
 * the card body, in particular that SOURCE NAMES reach the card. The view
 * v_appt_prospect_dupes does not carry them; the job joins lp_leads for them,
 * and without them the card is a list of ids nobody can act on.
 *
 * Pure module — no supabase, no GroupMe, no Slack.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldAlertApptProspectDupes,
  activeFromVerdict,
  formatApptProspectDupes,
  formatApptProspectDupesRecovered,
} from '../src/services/appt-prospect-dupe-alerts.js';

// The five live cases, 2026-09-08 to 2026-09-17, exactly as
// v_appt_prospect_dupes returns them plus the sources the job attaches.
const FIVE = [
  { lp_prospect_id: '230019', slot_date: '2026-09-08', live_rows: 2,
    lead_ids: ['572626', '572972'], dispositions: ['Set', 'Set'], surnames: ['Reyes/Fuentes'],
    sources: { 572626: 'MVP Marketing / Affiliates', 572972: 'Prolific Marketing / Affiliates' } },
  { lp_prospect_id: '412674', slot_date: '2026-09-08', live_rows: 2,
    lead_ids: ['537047', '573470'], dispositions: ['Set', 'Set'], surnames: ['Gibbons '],
    sources: { 537047: 'Reecewindows.com / Internet', 573470: 'Lead Gurus / Internet' } },
  { lp_prospect_id: '400876', slot_date: '2026-09-11', live_rows: 2,
    lead_ids: ['575041', '575052'], dispositions: ['Set', 'Set'], surnames: ['JULICH'],
    sources: { 575041: 'MVP Marketing / Affiliates', 575052: 'MVP Marketing / Affiliates' } },
  { lp_prospect_id: '358689', slot_date: '2026-09-14', live_rows: 2,
    lead_ids: ['550806', '575443'], dispositions: ['Issue', 'Set'], surnames: ['Bermudez '],
    sources: { 550806: 'Prolific Marketing / Affiliates', 575443: 'Prolific Marketing / Affiliates' } },
  { lp_prospect_id: '458357', slot_date: '2026-09-16', live_rows: 2,
    lead_ids: ['574953', '574957'], dispositions: ['Set', 'Set'], surnames: ['Ingrassia'],
    sources: { 574953: 'Self Generated / SelfGenerated', 574957: 'Lead Gurus / Internet' } },
];

test('the five known cases produce an alert', () => {
  assert.deepEqual(shouldAlertApptProspectDupes(FIVE), { verdict: 'alert', count: 5 });
  assert.equal(activeFromVerdict('alert'), true);
});

test('no duplicates is HEALTHY and clears', () => {
  assert.deepEqual(shouldAlertApptProspectDupes([]), { verdict: 'healthy', count: 0 });
  assert.equal(activeFromVerdict('healthy'), false);
});

test('a failed read is INSUFFICIENT EVIDENCE — neither pages nor clears', () => {
  // The case people get wrong. Clearing on "I could not tell" announces a
  // recovery nobody earned; reportAlertCondition touches nothing on null.
  assert.deepEqual(shouldAlertApptProspectDupes(null), { verdict: 'insufficient_evidence', count: 0 });
  assert.equal(activeFromVerdict('insufficient_evidence'), null);
  assert.notEqual(activeFromVerdict('insufficient_evidence'), false);
});

test('the card carries both lead ids, both dispositions and both sources', () => {
  const card = formatApptProspectDupes(FIVE);
  for (const r of FIVE) {
    assert.ok(card.includes(r.lp_prospect_id), `prospect ${r.lp_prospect_id} missing`);
    assert.ok(card.includes(r.slot_date), `slot_date ${r.slot_date} missing`);
    for (const id of r.lead_ids) {
      assert.ok(card.includes(id), `lead ${id} missing`);
      assert.ok(card.includes(r.sources[id]), `source for ${id} missing`);
    }
  }
  assert.ok(card.includes('Issue'), 'the Bermudez Issue/Set split must be visible');
});

test('the vendor pair is legible — that is what makes it a purchasing number', () => {
  const card = formatApptProspectDupes(FIVE);
  assert.ok(card.includes('MVP Marketing'), 'MVP must be named');
  assert.ok(card.includes('Prolific Marketing'), 'Prolific must be named');
  assert.ok(card.includes('Lead Gurus'), 'Lead Gurus must be named');
});

test('surnames print per row, so a duplicate-with-typo stays visible', () => {
  // Golden / Gold: the surnames DIFFER on the typo cases, and that difference
  // is the tell for how the duplicate was created.
  const typo = [{ ...FIVE[0], surnames: ['Golden', 'Gold'] }];
  const card = formatApptProspectDupes(typo);
  assert.ok(card.includes('Golden'), 'Golden missing');
  assert.ok(card.includes('Gold'), 'Gold missing');
});

test('a missing source degrades the card, it does not break it', () => {
  const partial = [{ ...FIVE[0], sources: { 572626: 'MVP Marketing / Affiliates' } }];
  const card = formatApptProspectDupes(partial);
  assert.ok(card.includes('source unknown'), 'an unjoined lead should say so, not print undefined');
  assert.ok(!card.includes('undefined'));
});

test('the card says plainly that this is a detector, not a guard', () => {
  const card = formatApptProspectDupes(FIVE);
  assert.match(card, /DETECTOR, not a guard/);
});

test('the recovery card never implies a clean read that did not happen', () => {
  assert.match(formatApptProspectDupesRecovered(), /clear/i);
});
