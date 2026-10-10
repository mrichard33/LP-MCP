/**
 * scripts/test-judge-calibration.js — the pure maths behind
 * scripts/judge-calibration.js, on fixtures: every label agrees with the
 * judge, every label disagrees, fewer than 100 labels, and nothing at all.
 *
 *   node --test scripts/test-judge-calibration.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  calibrationReport, joinLabels, confusion, outcomesByBucket, disagreements, renderMarkdown,
  minScore, meanScore, MIN_LABELS, THRESHOLDS,
} = await import('./judge-calibration.js');

/** A score row with the five dimensions set so that min = `min` and mean = (min + 4*high)/5. */
function score(actionId, min, { high = 0.9, passed = min >= 0.8, text = `reply ${actionId}`, createdAt = '2026-10-01T00:00:00Z' } = {}) {
  return {
    action_id: actionId, overall_score: min, passed,
    relevance: high, stage_alignment: high, trust: min, clarity: high, forward_momentum: high,
    failure_reasons: min < 0.7 ? ['LOW_TRUST'] : [], message_text: text, created_at: createdAt,
  };
}
const label = (ref, verdict, extra = {}) => ({ id: Number(ref), message_type: 'reply', message_ref: String(ref), verdict, gold: false, created_at: '2026-10-02T00:00:00Z', ...extra });
const outcome = (ref, { replied = false, booked = false, optedOut = false } = {}) => ({
  message_type: 'reply', message_ref: String(ref), sent_at: '2026-10-01T00:00:00Z',
  replied_at: replied ? '2026-10-01T01:00:00Z' : null, booked_at: booked ? '2026-10-02T00:00:00Z' : null, opted_out_at: optedOut ? '2026-10-01T02:00:00Z' : null,
});

/** n labels that all agree with the judge: good ↔ every dimension 0.9; needs_work ↔ every dimension 0.2. */
function allAgree(n) {
  const labels = [], scores = [], outcomes = [];
  for (let i = 1; i <= n; i++) {
    const good = i % 2 === 0;
    labels.push(label(i, good ? 'good' : 'needs_work'));
    scores.push(score(i, good ? 0.9 : 0.2, { high: good ? 0.9 : 0.2 }));
    outcomes.push(outcome(i, { replied: good, booked: good && i % 4 === 0 }));
  }
  return { labels, scores, outcomes };
}

test('minScore / meanScore read the five dimensions and fall back to overall_score', () => {
  const s = score(1, 0.4, { high: 0.9 });
  assert.equal(minScore(s), 0.4);
  assert.equal(Math.round(meanScore(s) * 100) / 100, 0.8);
  assert.equal(minScore({ overall_score: '0.55' }), 0.55);
  assert.equal(meanScore({ overall_score: 0.55 }), 0.55);
  assert.equal(minScore({}), null);
  assert.equal(meanScore(null), null);
});

test('empty input: NOT CALIBRATED, zero everywhere, renders without throwing', () => {
  const r = calibrationReport({});
  assert.equal(r.calibrated, false);
  assert.equal(r.verdict, 'NOT CALIBRATED (0 labels, best agreement n/a)');
  assert.deepEqual(r.labels, { total: 0, distinct: 0, joined: 0, good: 0 });
  assert.equal(r.tables.length, THRESHOLDS.length * 2);
  for (const t of r.tables) assert.equal(t.n, 0);
  for (const b of r.buckets) assert.equal(b.n, 0);
  assert.deepEqual(r.disagreements, []);
  const md = renderMarkdown(r);
  assert.match(md, /\*\*Verdict: NOT CALIBRATED \(0 labels, best agreement n\/a\)\*\*/);
  assert.match(md, /_none: no labelled message has a judge score_/);
});

test('all agree, 120 labels: CALIBRATED, 100% agreement at every threshold', () => {
  const r = calibrationReport(allAgree(120));
  assert.equal(r.labels.joined, 120);
  assert.equal(r.labels.good, 60);
  for (const t of r.tables) {
    assert.equal(t.n, 120);
    assert.equal(t.agreement, 1, `${t.metric}@${t.threshold}`);
    assert.equal(t.fp + t.fn, 0);
  }
  assert.equal(r.calibrated, true);
  assert.equal(r.verdict, 'CALIBRATED');
  // Outcomes: the 60 good replies all replied and 30 of them booked; the 60 bad none.
  const low = r.buckets.find((b) => b.label === '<0.4');
  const high = r.buckets.find((b) => b.label === '0.6+');
  assert.equal(low.n, 60); assert.equal(low.reply_rate, 0); assert.equal(low.booking_rate, 0);
  assert.equal(high.n, 60); assert.equal(high.reply_rate, 1); assert.equal(high.booking_rate, 0.5);
  // No disagreement is wider than 0.2 (judge 0.9 vs human 1, 0.2 vs 0).
  assert.ok(r.disagreements.every((d) => d.gap <= 0.2 + 1e-9));
  assert.match(renderMarkdown(r), /\| min \| 0\.7 \| 60 \| 0 \| 0 \| 60 \| 120 \| 100%/);
});

test('all agree but fewer than 100 labels: NOT CALIBRATED even at 100% agreement', () => {
  const r = calibrationReport(allAgree(22));
  assert.equal(r.labels.joined, 22);
  assert.equal(r.best.agreement, 1);
  assert.equal(r.calibrated, false);
  assert.equal(r.verdict, 'NOT CALIBRATED (22 labels, best agreement 100%)');
  assert.ok(MIN_LABELS > 22);
});

test('all disagree, 120 labels: 0% agreement, NOT CALIBRATED, the disagreements are the widest gaps first', () => {
  const data = allAgree(120);
  // Flip every human verdict so each one now contradicts the judge.
  data.labels = data.labels.map((l) => ({ ...l, verdict: l.verdict === 'good' ? 'needs_work' : 'good' }));
  const r = calibrationReport(data);
  for (const t of r.tables) {
    assert.equal(t.n, 120);
    assert.equal(t.agreement, 0, `${t.metric}@${t.threshold}`);
    assert.equal(t.tp + t.tn, 0);
  }
  assert.equal(r.calibrated, false);
  assert.equal(r.verdict, 'NOT CALIBRATED (120 labels, best agreement 0%)');
  assert.equal(r.disagreements.length, 10);
  assert.ok(r.disagreements.every((d) => d.gap >= 0.8 - 1e-9));
  const md = renderMarkdown(r, { withText: false });
  assert.ok(!md.includes('reply 1"'), 'with --no-text the reply text stays out of the output');
  assert.match(renderMarkdown(r), /— "reply \d+"/);
});

test('joinLabels: latest label per message wins, latest score per action wins, skips and unscored replies stay unjoined', () => {
  const labels = [
    label(447899, 'needs_work', { id: 6, created_at: '2026-10-01T00:00:00Z' }),
    label(447899, 'good', { id: 7, created_at: '2026-10-03T00:00:00Z' }),
    label(474161, 'good', { id: 15, message_type: 'skip' }),
    label(551383, 'good', { id: 19 }),
  ];
  const scores = [
    score(447899, 0.4, { createdAt: '2026-09-30T00:00:00Z' }),
    score(447899, 0.6, { createdAt: '2026-10-02T00:00:00Z' }),
  ];
  const j = joinLabels({ labels, scores, outcomes: [outcome(447899, { replied: true })] });
  assert.equal(j.labelsTotal, 4);
  assert.equal(j.labelsDistinct, 3);
  const row = j.rows.find((r) => r.message_ref === '447899');
  assert.equal(row.verdict, 'good');
  assert.equal(row.score.overall_score, 0.6, 'the newer score');
  assert.equal(row.outcome.replied_at !== null, true);
  assert.equal(j.rows.find((r) => r.message_type === 'skip').score, null);
  assert.equal(j.rows.find((r) => r.message_ref === '551383').score, null);
  const r = calibrationReport({ labels, scores, outcomes: [] });
  assert.equal(r.labels.joined, 1);
  assert.equal(r.labels.distinct, 3);
});

test('confusion: a reply the judge fails at 0.7 on min can pass at 0.7 on mean (the live pattern: one low axis)', () => {
  // min 0.4, the other four 0.9 → mean 0.8.
  const rows = joinLabels({ labels: [label(1, 'good')], scores: [score(1, 0.4, { high: 0.9 })] }).rows;
  const byMin = confusion(rows, { metric: 'min', threshold: 0.7 });
  const byMean = confusion(rows, { metric: 'mean', threshold: 0.7 });
  assert.deepEqual([byMin.tp, byMin.fn], [0, 1]);
  assert.deepEqual([byMean.tp, byMean.fn], [1, 0]);
  assert.equal(byMin.agreement, 0);
  assert.equal(byMean.agreement, 1);
});

test('outcomesByBucket counts only scored replies that have an outcome row, by the stored overall_score', () => {
  const j = joinLabels({
    labels: [],
    scores: [score(1, 0.2), score(2, 0.5), score(3, 0.75), score(4, 0.6), score(5, 0.9)],
    outcomes: [outcome(1, { replied: true }), outcome(2, { booked: true }), outcome(3), outcome(4, { optedOut: true })],
  });
  const b = outcomesByBucket(j.scoresByRef, j.outcomesByKey);
  assert.deepEqual(b.map((x) => [x.label, x.n]), [['<0.4', 1], ['0.4–0.6', 1], ['0.6+', 2]]);
  assert.equal(b[0].reply_rate, 1);
  assert.equal(b[1].booking_rate, 1);
  assert.equal(b[2].opted_out, 1);
});

test('disagreements: widest gap first, capped at the limit', () => {
  const rows = joinLabels({
    labels: [label(1, 'good'), label(2, 'good'), label(3, 'needs_work')],
    scores: [score(1, 0.2, { high: 0.2 }), score(2, 0.9, { high: 0.9 }), score(3, 0.9, { high: 0.9 })],
  }).rows;
  const d = disagreements(rows, { limit: 2 });
  assert.equal(d.length, 2);
  assert.deepEqual(d.map((x) => x.message_ref), ['3', '1']);
  assert.ok(d[0].gap >= d[1].gap);
});
