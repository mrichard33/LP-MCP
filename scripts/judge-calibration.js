/**
 * judge-calibration.js — does the judge agree with the people?
 *
 * 2026-10-10 (audit of 2026-10-09). The judge (src/message-content-scorer.js,
 * run after the send by src/bot-feedback/judge.js) passed 18 of 287 scored
 * replies, while 18 of 22 human reviews said "good" (their average AI score:
 * 41/100), and the booking rate was flat across judge buckets (14% / 18% /
 * 15%). Nothing compared the two. This report does, so the judge is never
 * quoted as a quality number, or used to gate a send, before it tracks what
 * a person would say.
 *
 * READ-ONLY and model-free: SELECTs on bot_feedback, message_scores and
 * bot_outcomes, then pure maths (exported, tested in
 * scripts/test-judge-calibration.js). Nothing is written anywhere. NOT part of
 * `npm test` (it needs the database).
 *
 * The join: bot_feedback.message_ref = message_scores.action_id::text (both
 * hold the agent_actions id of a reply). Confirmed on live rows 2026-10-10:
 * 13 of 22 labels joined this way; the other 9 were 2 "skip" labels (never
 * scored) and 7 replies the judge had not scored. bot_message_context was not
 * needed as a bridge. Outcomes join bot_outcomes on (message_type,
 * message_ref). The latest label per message and the latest score per
 * message win.
 *
 * Customer text: the disagreements section prints reply text to the
 * operator's own terminal (the user's ruling, 2026-10-05: conversations stay
 * in the database). Never commit its output.
 *
 *   node scripts/judge-calibration.js [--days 90] [--json] [--no-text]
 */

import process from 'node:process';

const args = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes(name);

/** Judge pass thresholds compared, on min-of-dimensions AND mean-of-dimensions. */
export const THRESHOLDS = Object.freeze([0.5, 0.6, 0.7, 0.78]);
/** Outcome buckets by the stored overall_score (the min of the five dimensions). */
export const BUCKETS = Object.freeze([
  { label: '<0.4', lo: -Infinity, hi: 0.4 },
  { label: '0.4–0.6', lo: 0.4, hi: 0.6 },
  { label: '0.6+', lo: 0.6, hi: Infinity },
]);
/** The verdict line reads CALIBRATED only past both of these. */
export const MIN_LABELS = 100;
export const MIN_AGREEMENT = 0.8;

const DIMENSIONS = ['relevance', 'stage_alignment', 'trust', 'clarity', 'forward_momentum'];

const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const key = (type, ref) => `${type}::${ref}`;
const later = (a, b) => String(a || '') >= String(b || '');

/** The five dimension values that are present on a score row. Pure. */
export function dimensionValues(score) {
  return DIMENSIONS.map((d) => num(score?.[d])).filter((v) => v !== null);
}

/** min of the dimensions, falling back to the stored overall_score; null when nothing is there. Pure. */
export function minScore(score) {
  const vals = dimensionValues(score);
  if (vals.length) return Math.min(...vals);
  return num(score?.overall_score);
}

/** mean of the dimensions, falling back to the stored overall_score; null when nothing is there. Pure. */
export function meanScore(score) {
  const vals = dimensionValues(score);
  if (vals.length) return vals.reduce((s, v) => s + v, 0) / vals.length;
  return num(score?.overall_score);
}

/** A human verdict as a boolean: good → true, needs_work / unsafe → false. Pure. */
export function humanGood(verdict) {
  return String(verdict || '').toLowerCase() === 'good';
}

/**
 * Join labels to scores and outcomes. Latest label per (message_type,
 * message_ref), latest score per action_id. Pure.
 *
 * @param {object} input
 * @param {Array} input.labels   bot_feedback rows (already filtered to retracted_at IS NULL AND undone_at IS NULL)
 * @param {Array} input.scores   message_scores rows
 * @param {Array} input.outcomes bot_outcomes rows
 * @returns {{ rows: Array, labelsTotal: number, labelsDistinct: number, scoresByRef: Map, outcomesByKey: Map }}
 */
export function joinLabels({ labels = [], scores = [], outcomes = [] } = {}) {
  const latestLabel = new Map();
  for (const l of labels) {
    if (!l || l.message_ref === null || l.message_ref === undefined) continue;
    const k = key(l.message_type, l.message_ref);
    const prev = latestLabel.get(k);
    if (!prev || later(l.created_at, prev.created_at)) latestLabel.set(k, l);
  }

  const scoresByRef = new Map();
  for (const s of scores) {
    if (!s || s.action_id === null || s.action_id === undefined) continue;
    const ref = String(s.action_id);
    const prev = scoresByRef.get(ref);
    if (!prev || later(s.created_at, prev.created_at)) scoresByRef.set(ref, s);
  }

  const outcomesByKey = new Map();
  for (const o of outcomes) {
    if (!o || o.message_ref === null || o.message_ref === undefined) continue;
    outcomesByKey.set(key(o.message_type, o.message_ref), o);
  }

  const rows = [];
  for (const [k, l] of latestLabel) {
    const score = scoresByRef.get(String(l.message_ref)) || null;
    const outcome = outcomesByKey.get(k) || null;
    rows.push({
      message_type: l.message_type,
      message_ref: String(l.message_ref),
      verdict: l.verdict,
      good: humanGood(l.verdict),
      gold: l.gold === true,
      score,
      outcome,
    });
  }

  return { rows, labelsTotal: labels.length, labelsDistinct: latestLabel.size, scoresByRef, outcomesByKey };
}

/** One 2×2 table: human good/not-good vs judge pass/fail at `threshold` on `metric` ('min' | 'mean'). Pure. */
export function confusion(joinedRows, { metric = 'min', threshold = 0.7 } = {}) {
  const pick = metric === 'mean' ? meanScore : minScore;
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const r of joinedRows) {
    if (!r.score) continue;
    const v = pick(r.score);
    if (v === null) continue;
    const pass = v >= threshold;
    if (r.good && pass) tp += 1;
    else if (!r.good && pass) fp += 1;
    else if (r.good && !pass) fn += 1;
    else tn += 1;
  }
  const n = tp + fp + fn + tn;
  return { metric, threshold, tp, fp, fn, tn, n, agreement: n ? (tp + tn) / n : null };
}

/** Reply / booking / opt-out rate per judge bucket over every scored message with an outcome row. Pure. */
export function outcomesByBucket(scoresByRef, outcomesByKey, { buckets = BUCKETS, messageType = 'reply' } = {}) {
  const out = buckets.map((b) => ({ ...b, n: 0, replied: 0, booked: 0, opted_out: 0 }));
  for (const [ref, s] of scoresByRef) {
    const o = outcomesByKey.get(key(messageType, ref));
    if (!o) continue;
    const v = num(s.overall_score);
    if (v === null) continue;
    const b = out.find((x) => v >= x.lo && v < x.hi);
    if (!b) continue;
    b.n += 1;
    if (o.replied_at) b.replied += 1;
    if (o.booked_at) b.booked += 1;
    if (o.opted_out_at) b.opted_out += 1;
  }
  return out.map((b) => ({
    label: b.label, n: b.n, replied: b.replied, booked: b.booked, opted_out: b.opted_out,
    reply_rate: b.n ? b.replied / b.n : null,
    booking_rate: b.n ? b.booked / b.n : null,
  }));
}

/** The `limit` labelled messages where the judge's mean is furthest from the human verdict (1 = good, 0 = not). Pure. */
export function disagreements(joinedRows, { limit = 10 } = {}) {
  return joinedRows
    .filter((r) => r.score && meanScore(r.score) !== null)
    .map((r) => {
      const mean = meanScore(r.score);
      return {
        message_type: r.message_type,
        message_ref: r.message_ref,
        verdict: r.verdict,
        gold: r.gold,
        judge_min: minScore(r.score),
        judge_mean: mean,
        judge_passed: r.score.passed === true,
        failure_reasons: Array.isArray(r.score.failure_reasons) ? r.score.failure_reasons : [],
        gap: Math.abs((r.good ? 1 : 0) - mean),
        text: String(r.score.message_text || ''),
      };
    })
    .sort((a, b) => b.gap - a.gap || a.message_ref.localeCompare(b.message_ref))
    .slice(0, limit);
}

/**
 * The whole report, from raw rows. Pure.
 * @returns {{ labels, tables, best, buckets, disagreements, verdict, calibrated }}
 */
export function calibrationReport({ labels = [], scores = [], outcomes = [] } = {}, {
  thresholds = THRESHOLDS, buckets = BUCKETS, minLabels = MIN_LABELS, minAgreement = MIN_AGREEMENT, disagreementLimit = 10,
} = {}) {
  const { rows, labelsTotal, labelsDistinct, scoresByRef, outcomesByKey } = joinLabels({ labels, scores, outcomes });
  const joined = rows.filter((r) => r.score && minScore(r.score) !== null);

  const tables = [];
  for (const metric of ['min', 'mean']) {
    for (const threshold of thresholds) tables.push(confusion(joined, { metric, threshold }));
  }
  const best = tables.reduce((b, t) => (t.agreement !== null && (b === null || t.agreement > b.agreement) ? t : b), null);

  const calibrated = joined.length >= minLabels && best !== null && best.agreement >= minAgreement;
  const pct = (v) => (v === null || v === undefined ? 'n/a' : `${Math.round(v * 100)}%`);
  const verdict = calibrated
    ? 'CALIBRATED'
    : `NOT CALIBRATED (${joined.length} labels, best agreement ${best ? pct(best.agreement) : 'n/a'})`;

  return {
    labels: { total: labelsTotal, distinct: labelsDistinct, joined: joined.length, good: joined.filter((r) => r.good).length },
    tables,
    best,
    buckets: outcomesByBucket(scoresByRef, outcomesByKey, { buckets }),
    disagreements: disagreements(joined, { limit: disagreementLimit }),
    verdict,
    calibrated,
    scored_total: scoresByRef.size,
  };
}

/** Markdown for the terminal. `withText: false` keeps customer text out of the output. Pure. */
export function renderMarkdown(report, { days = null, withText = true } = {}) {
  const pct = (v) => (v === null || v === undefined ? 'n/a' : `${Math.round(v * 100)}%`);
  const f2 = (v) => (v === null || v === undefined ? 'n/a' : v.toFixed(2));
  const L = [];
  L.push(`# Judge calibration${days ? ` (last ${days} days)` : ''}`);
  L.push('');
  L.push(`**Verdict: ${report.verdict}**`);
  L.push('');
  L.push('## 1. Labels joined');
  L.push('');
  L.push(`- Human labels: ${report.labels.total} rows, ${report.labels.distinct} distinct messages (latest label per message)`);
  L.push(`- Joined to a judge score: ${report.labels.joined} of ${report.labels.distinct} (${report.labels.good} of those labelled good)`);
  L.push(`- Judge scores in the window: ${report.scored_total}`);
  L.push(`- CALIBRATED needs ${MIN_LABELS}+ joined labels and ${pct(MIN_AGREEMENT)}+ agreement`);
  L.push('');
  L.push('## 2. Human verdict vs judge pass');
  L.push('');
  L.push('| metric | threshold | good & pass | good & fail | not good & pass | not good & fail | n | agreement |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const t of report.tables) {
    const mark = report.best && t === report.best ? ' (best)' : '';
    L.push(`| ${t.metric} | ${t.threshold} | ${t.tp} | ${t.fn} | ${t.fp} | ${t.tn} | ${t.n} | ${pct(t.agreement)}${mark} |`);
  }
  L.push('');
  L.push('## 3. Outcomes by judge bucket (overall_score = min of dimensions, all scored replies with an outcome)');
  L.push('');
  L.push('| bucket | n | replied | booked | opted out | reply rate | booking rate |');
  L.push('|---|---|---|---|---|---|---|');
  for (const b of report.buckets) {
    L.push(`| ${b.label} | ${b.n} | ${b.replied} | ${b.booked} | ${b.opted_out} | ${pct(b.reply_rate)} | ${pct(b.booking_rate)} |`);
  }
  L.push('');
  L.push(`## 4. Biggest disagreements (${report.disagreements.length})`);
  L.push('');
  if (!report.disagreements.length) L.push('_none: no labelled message has a judge score_');
  for (const d of report.disagreements) {
    const text = withText ? ` — "${d.text.replace(/\s+/g, ' ').slice(0, 200)}"` : '';
    L.push(`- ${d.message_type} ${d.message_ref}: human **${d.verdict}**${d.gold ? ' (gold)' : ''}, judge min ${f2(d.judge_min)} / mean ${f2(d.judge_mean)}${d.failure_reasons.length ? ` [${d.failure_reasons.join(', ')}]` : ''}${text}`);
  }
  L.push('');
  L.push(`## 5. ${report.verdict}`);
  return L.join('\n');
}

// ─── database (read-only) ────────────────────────────────────────────

async function readAll(table, build) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

async function loadRows(days) {
  const { default: supabase } = await import('../src/supabase.js');
  if (!supabase) throw new Error('Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const [labels, scores, outcomes] = await Promise.all([
    readAll('bot_feedback', () => supabase.from('bot_feedback')
      .select('id, message_type, message_ref, verdict, gold, created_at')
      .is('retracted_at', null).is('undone_at', null)
      .gte('created_at', since).order('created_at', { ascending: true })),
    readAll('message_scores', () => supabase.from('message_scores')
      .select('id, action_id, overall_score, passed, relevance, stage_alignment, trust, clarity, forward_momentum, failure_reasons, scorer_model, message_text, created_at')
      .gte('created_at', since).order('created_at', { ascending: true })),
    readAll('bot_outcomes', () => supabase.from('bot_outcomes')
      .select('message_type, message_ref, sent_at, replied_at, booked_at, opted_out_at')
      .gte('sent_at', since).order('sent_at', { ascending: true })),
  ]);
  return { labels, scores, outcomes };
}

async function main() {
  const days = Number(opt('--days', 90));
  const data = await loadRows(days);
  const report = calibrationReport(data);
  if (flag('--json')) {
    const { disagreements: d, ...rest } = report;
    console.log(JSON.stringify({ ...rest, disagreements: d.map(({ text, ...x }) => x) }, null, 2));
    return;
  }
  console.log(renderMarkdown(report, { days, withText: !flag('--no-text') }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(`[judge-calibration] ${err.message}`); process.exit(1); });
}
