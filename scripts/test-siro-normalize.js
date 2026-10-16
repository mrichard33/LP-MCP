/**
 * Siro recording → siro_recordings row — scripts/test-siro-normalize.js (2026-10-16)
 * Run: node --test scripts/test-siro-normalize.js
 *
 * The fixture is shaped like a real Siro record (four summary sections, the
 * follow-up block with prices, GPS, an email and Siro's drafted texts), so
 * these tests prove what is kept and what never reaches the database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecording, buildMoments, objectionTypeOf, cleanSiroText, bulletsOf } from '../src/siro/normalize.js';
import { RAW_RECORDING, FIXTURE_RECORDED_AT } from './fixtures/siro-recording.js';

test('a processed, linked recording becomes one row', () => {
  const row = normalizeRecording(RAW_RECORDING, { source: 'webhook' });
  assert.equal(row.recording_id, 'rec_abc123');
  assert.equal(row.rep_name, 'Brian Kowalski'); // from the follow-up block
  assert.equal(row.rep_email, null);
  assert.equal(row.result, 'open');
  assert.equal(row.duration_sec, 5400); // durationInMilliseconds
  assert.equal(row.processed, true);
  assert.equal(row.linked, true);
  assert.equal(row.source, 'webhook');
  assert.equal(row.engagement_external_id, 'LDS583321');
  assert.equal(row.account_external_id, '470111');
  assert.equal(row.opportunity_external_id, '583321');
  assert.equal(row.followup_score, 4);
  assert.equal(row.followup_status, 'TO_DO');
  assert.equal(row.customer_phone, '3525550188'); // the account's phone list
  assert.equal(row.recorded_at, FIXTURE_RECORDED_AT);
  assert.match(row.followup_action, /^Call at the end of next week/);
});

test('the rep name falls back to the Siro user list', () => {
  const noFu = { ...RAW_RECORDING, followups: [] };
  const names = new Map([['usr_1', { name: 'Brian Kowalski', email: 'brian.rep@reecewindows.com' }]]);
  const row = normalizeRecording(noFu, { source: 'poll', userNames: names });
  assert.equal(row.rep_name, 'Brian Kowalski');
  assert.equal(row.rep_email, 'brian.rep@reecewindows.com');
  assert.equal(normalizeRecording(noFu, { source: 'poll' }).rep_name, null);
});

test('raw keeps a small whitelist: no GPS, emails, phones, prices, drafts or thinking', () => {
  const row = normalizeRecording({ ...RAW_RECORDING, utterances: [{ text: 'secret' }] }, { source: 'poll' });
  assert.deepEqual(Object.keys(row.raw).sort(),
    ['conversationType', 'createdAt', 'durationInMilliseconds', 'followup', 'id', 'link', 'result', 'title', 'updatedAt', 'userId']);
  assert.deepEqual(row.raw.followup, { followupType: 'REHASH', score: 4, status: 'TO_DO', repName: 'Brian Kowalski', teamName: 'St.Pete' });
  const raw = JSON.stringify(row.raw);
  for (const bad of ['latitude', '28.18', 'dana@example.com', '555-0188', '$', '18,400', 'Dear Dana', 'Hi Dana', 'HIGH FOLLOW-UP', 'secret', 'thinking']) {
    assert.ok(!raw.includes(bad), `raw must not hold ${bad}`);
  }
  assert.equal(normalizeRecording(RAW_RECORDING, { storeRaw: false }).raw, null);
});

test('summary text is cleaned: no citation marks, no markdown, PII scrubbed', () => {
  const row = normalizeRecording(RAW_RECORDING, { source: 'poll' });
  assert.deepEqual(row.summary.map(s => s.name),
    ['Customer Need & Motivation', 'Customer Sentiment', 'Customer Objections', 'Key Outcomes & Next Steps']);
  const all = row.summary.map(s => s.content).join(' ');
  assert.doesNotMatch(all, /\[\d+\]|\*\*/);
  assert.match(row.summary[0].content, /\[phone\]/);
  assert.doesNotMatch(all, /555-0188/);
});

test('moments are read by section: objections, what they want; next steps are not interests', () => {
  const row = normalizeRecording(RAW_RECORDING, { source: 'poll' });
  const objections = row.moments.filter(m => m.kind === 'objection');
  assert.equal(objections.length, 2);
  assert.equal(objections[0].objection_type, 'price'); // return on investment / resale
  assert.equal(objections[1].objection_type, 'spouse');
  const wants = row.moments.filter(m => m.kind === 'buying_signal').map(m => m.customer_said);
  assert.equal(wants.length, 2);
  assert.ok(wants.some(w => /lanai slider sticks/.test(w)));
  assert.ok(!wants.some(w => /No purchase was made|Brian will call/.test(w)));
  assert.ok(!row.moments.some(m => /screen design/.test(m.customer_said))); // sentiment stays in summary
  for (const m of row.moments) {
    assert.deepEqual(Object.keys(m).sort(), ['agent_said', 'confidence', 'customer_said', 'kind', 'objection_type', 'resolved']);
  }
});

test('insights carry Siro\'s follow-up fields as written (prices are kept)', () => {
  const { insights } = normalizeRecording(RAW_RECORDING, { source: 'poll' });
  assert.equal(insights.main_objection, 'Pricing');
  assert.equal(insights.secondary_objection, 'Spouse');
  assert.equal(insights.follow_up_time, 'In 1 Week');
  assert.equal(insights.team, 'St.Pete');
  assert.equal(insights.followup_type, 'REHASH');
  assert.match(insights.objection_summary, /total felt high at \$18,400 and her husband/);
  assert.equal(insights.next_steps.length, 2);
  assert.doesNotMatch(JSON.stringify(insights), /FollowupEmail|Dear Dana|HIGH FOLLOW-UP/);
  for (const k of ['first_price_quote', 'final_price_quote', 'financing', 'overall_cost']) assert.equal(insights[k], undefined);
});

test('pricing keeps the quotes as Siro wrote them', () => {
  const { pricing } = normalizeRecording(RAW_RECORDING, { source: 'poll' });
  assert.deepEqual(pricing, {
    first_price_quote: '$24,500', final_price_quote: '$18,400', overall_cost: '18400',
    financing: '$500 down, about $190 per month.',
  });
  assert.equal(normalizeRecording({ id: 'r9' }).pricing, null);
});

test('"none" values make no moment; duplicates collapse', () => {
  const m = buildMoments({ extractions: [{ name: 'Objections', value: 'None' }, { name: 'Concerns', value: ['Cost', 'Cost'] }] });
  assert.equal(m.length, 1);
  assert.equal(m[0].objection_type, 'price');
});

test('deleted, unlinked and unprocessed are honoured', () => {
  const row = normalizeRecording({ id: 'r2', deleted: true, deletedAt: '2026-10-15T00:00:00Z', crm: null }, { source: 'poll' });
  assert.equal(row.deleted, true);
  assert.equal(row.linked, false);
  assert.equal(row.processed, false);
  assert.equal(row.customer_phone, null);
  assert.equal(normalizeRecording(null), null);
});

test('webhook flags win over a missing status', () => {
  const row = normalizeRecording({ id: 'r3' }, { source: 'webhook', flags: { processed: true, linked: true } });
  assert.equal(row.processed, true);
  assert.equal(row.linked, true);
});

test('objection types', () => {
  assert.equal(objectionTypeOf('too expensive'), 'price');
  assert.equal(objectionTypeOf('uncertain return on investment'), 'price');
  assert.equal(objectionTypeOf('Pricing'), 'price');
  assert.equal(objectionTypeOf('need to talk to my wife'), 'spouse');
  assert.equal(objectionTypeOf('getting other quotes'), 'competitor');
  assert.equal(objectionTypeOf('not ready to decide yet'), 'timing');
  assert.equal(objectionTypeOf('something else'), 'other');
});

test('text helpers', () => {
  assert.equal(cleanSiroText('**Strong** point.[1][2] '), 'Strong point.');
  assert.deepEqual(bulletsOf('- A one.[1] - B two.[2]'), ['A one.', 'B two.']);
});
