/**
 * Memory Recommend — src/jobs/memory-recommend.js  (Command Center R1, sql/102)
 *
 * Every card in the Rulings lane arrives with a recommendation already on it:
 * a verdict, two sentences of reason, the evidence behind it, a confidence, and
 * a risk flag. Ruling ~385 items is a different job when the screen already says
 * "here is what the record supports, and here is what it is based on".
 *
 * A recommendation is NEVER a ruling. It writes only the rec_* columns; nothing
 * it produces closes a card, files a decision, or changes memory. Mark rules.
 *
 * MEMORY_RECOMMEND_MODE gates everything:
 *   off     (default) nothing runs. The nightly step is skipped entirely.
 *   shadow  the run happens and each result is written to
 *           claude_memory_validation_log as check_name 'recommend:shadow'. The
 *           rec_* columns are NOT touched, so the page shows nothing new and the
 *           output can be read before anyone trusts it.
 *   live    the rec_* columns are written, with rec_source_version =
 *           claude_card_version(...) so a card whose CONTENT changes gets a
 *           fresh recommendation, while a card that merely got a recommendation
 *           does not loop.
 *
 * THE STANDING RULING FRAMEWORK is in the prompt verbatim, because it is the
 * whole difference between a useful recommendation and a plausible one:
 *   1. Default to the shipped, working state.
 *   2. Recommend a change only with evidence the current state is failing.
 *   3. A decision Mark confirmed outranks a reconstructed one, newer or not.
 *   4. Where money, live leads or customer messaging are at stake, show the
 *      tradeoff instead of a verdict, and cap confidence at medium. With nothing
 *      verifiable, say "no evidence either way".
 *
 * Budget per item: at most 4 lookups and 1 LLM call, under
 * MEMORY_RECOMMEND_ITEM_TIMEOUT_MS. One bad item is skipped and logged; the
 * batch continues.
 *
 * ENTRY POINTS
 *   recommendOne(table, id, deps)      one card — the page's "Re-check" link
 *   recommendBatch({limit, mode, deps}) the backlog — the nightly step and
 *                                       POST /admin/memory/recommend
 *
 * v1.0 — 2026-09-11. Initial (Command Center Release 1).
 */
import supabase from '../supabase.js';
import { callLLMJson } from '../llm-client.js';
import { CATEGORIES } from '../memory/memory-rule.js';

export const RECOMMEND_MODES = new Set(['off', 'shadow', 'live']);
export const VERDICTS = Object.freeze([
  // Rulings lane (sql/102).
  'approve', 'reject', 'answer', 'keep_left', 'keep_right', 'not_a_conflict', 'new_answer', 'yes', 'no', 'not_now',
  // Stale-issue lane (sql/112).
  'still_broken', 'fixed', 'no_longer_matters',
  // To-do lane (sql/112).
  'done', 'drop', 'keep', 'assign',
]);

/** Which verdicts belong to which lane. A verdict from the wrong lane is a miss. */
export const LANE_VERDICTS = Object.freeze({
  rulings: Object.freeze(['approve', 'reject', 'answer', 'keep_left', 'keep_right', 'not_a_conflict', 'new_answer', 'yes', 'no', 'not_now']),
  stale: Object.freeze(['still_broken', 'fixed', 'no_longer_matters']),
  todos: Object.freeze(['done', 'drop', 'keep', 'assign']),
});

/**
 * A stable slug per REASON, not per verdict — it is what the Command Center
 * groups a batch pass by, and a group header has to be something a person can
 * read and agree with in one line ("12 issues whose fix PR is merged"). Two
 * cards share a key only when the same sentence explains both.
 */
export const GROUP_KEYS = Object.freeze([
  'fixed:pr-merged', 'fixed:verified-elsewhere',
  'still_broken:no-evidence-of-fix',
  'no_longer_matters:superseded', 'no_longer_matters:system-retired',
  'done:pr-merged', 'done:confirmed-elsewhere',
  'drop:duplicate-of-newer', 'drop:superseded',
  'keep:no-evidence', 'keep:still-open',
  'assign:owner-named',
]);
export const CONFIDENCES = Object.freeze(['high', 'medium', 'low', 'no_evidence']);
export const RISKS = Object.freeze(['money', 'live_leads', 'customer_messaging', 'none']);

export function getMode(env = process.env) {
  const m = String(env.MEMORY_RECOMMEND_MODE || 'off').toLowerCase().trim();
  return RECOMMEND_MODES.has(m) ? m : 'off';
}
export function getMaxPerRun(env = process.env) {
  const n = parseInt(env.MEMORY_RECOMMEND_MAX_PER_RUN, 10);
  return Number.isFinite(n) && n > 0 ? n : 150;
}
export function getItemTimeout(env = process.env) {
  const n = parseInt(env.MEMORY_RECOMMEND_ITEM_TIMEOUT_MS, 10);
  return Number.isFinite(n) && n > 0 ? n : 45_000;
}

export const SYSTEM_PROMPT = `You read one open item from a business's decision memory and say what the record supports. You are not the decision maker — someone else rules. Your job is to make that ruling a ten-second job instead of a ten-minute one.

THE STANDING RULING FRAMEWORK. Apply it in this order, every time:
1. Default to the shipped, working state. "Leave it as it is" is a real answer and usually the right one.
2. Recommend a change ONLY when the evidence shows the current state is failing. An idea being better in the abstract is not evidence.
3. A decision the owner CONFIRMED outranks a RECONSTRUCTED one, regardless of which is newer. Check the confidence and origin on every decision you cite.
4. When money, live leads, or customer messaging are at stake: do NOT give a single verdict as if it were obvious. Lay out the tradeoff in the reason, and set confidence no higher than "medium". If there is nothing verifiable either way, say "no evidence either way" in the reason and set confidence to "no_evidence".
   "At stake" means ACTING ON THIS CARD CHANGES ONE OF THESE THINGS. Be strict, and ask what the ruling itself does:
     money              it changes a payment, a price, a commission, a budget or an invoice.
     live_leads         it changes how a real lead is routed, dialled, assigned or suppressed.
     customer_messaging it changes something a customer receives — an SMS, an email, a call script.
   A card is NOT risky because of the area it is filed under, because a vendor is named, or because it sounds important. A reporting change that shows payroll numbers is reporting, not money. A note about a dialer setting nobody has applied is not live_leads. Most cards are "none", and a risk flag on a card that carries no risk is worse than no flag at all — it teaches the reader to ignore the ones that matter.

THE THREE LANES. Which verdicts are available depends on what kind of card this is — the card says so, and a verdict from another lane is simply wrong:
  Rulings (decision_needed, unconfirmed_decision, open_question, approval_needed, conflict):
      approve | reject | answer | keep_left | keep_right | not_a_conflict | new_answer | yes | no | not_now
  Stale issue (stale_issue) — an open issue nobody has verified in a long time. The question is always "is this still broken?":
      still_broken        nothing shows it was fixed. This is the DEFAULT and it is not a failure — it re-starts the clock, it closes nothing.
      fixed               ONLY with a concrete proof link: a merged PR, a commit, a file path, or a named check that passed. No link, no "fixed" — say still_broken and set confidence low instead. An issue closed on a guess is worse than one left open, because nobody looks at it again.
      no_longer_matters   the thing it was about is gone — the workflow was deleted, the system was retired, the vendor was dropped.
  To-do (todo):
      done      the work is finished AND the evidence is about THIS item shipping. A PR that merely mentions the subject is not the item being done — that is "keep".
      drop      it is a duplicate of a newer item, or superseded.
      keep      still real, still someone's. This is the DEFAULT when evidence is thin. It snoozes for 30 days; it does not close anything.
      assign    the record plainly names who owns it. Put the name in decision_text.

AGE IS NOT EVIDENCE. Nothing is done, fixed, or droppable because it is old. If the only thing you can say about a card is how long it has been sitting there, the answer is still_broken or keep, at low confidence.

GROUPING. Also return "group_key": a short slug naming the REASON, so cards that share one explanation can be ruled together. Use one of: ${GROUP_KEYS.join(' | ')}. If none of them describes your reason, return null — a card that does not fit a group is ruled on its own, which is fine.

Cite only evidence you were actually given below. Never invent a decision id, an issue id, a PR, a file path or a metric. If the evidence is thin, that IS the finding — say so and set confidence low or no_evidence.

Reply with JSON only, no prose and no code fence:
{
  "verdict": "approve|reject|answer|keep_left|keep_right|not_a_conflict|new_answer|yes|no|not_now|still_broken|fixed|no_longer_matters|done|drop|keep|assign",
  "reason": "at most two sentences, plain words",
  "evidence": [{"type":"decision|issue|workflow|pr|file|query","ref":"#123 or a name","note":"why it matters"}],
  "confidence": "high|medium|low|no_evidence",
  "risk": "money|live_leads|customer_messaging|none",
  "group_key": "one of the slugs above, or null",
  "decision_text": "the exact wording to save if this is approved, or for assign, the owner's name",
  "category": "architecture|routing|messaging|appointments|sync|integration|data|agentic|infrastructure|reporting|compliance|operations",
  "build_text": "what would have to be built, or null if nothing"
}`;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Canonical codes like S4.5 or L.4 that claude_workflow_ref knows about. */
export function workflowCodesIn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/\b([A-Z]\d?\.\d+(?:\.\d+)?)\b/g)) out.add(m[1]);
  return [...out].slice(0, 3);
}

/**
 * Everything the model is allowed to reason from. At most four lookups:
 * precheck, search, workflow ref, and (for a conflict) the two sides.
 */
export async function gatherEvidence(card, { db, precheck, search, env } = {}) {
  const text = String(card.description || card.rec_decision_text || '').slice(0, 1200);
  const area = card.area || null;
  const ev = { precheck: null, search: [], workflows: [], sides: null, errors: [] };

  try {
    const p = precheck || (await import('../memory/memory-precheck.js')).memoryPrecheck;
    const r = await p(text, { area, limit: 5, db, env });
    ev.precheck = { verdict: r.verdict, active: r.active, closed_matches: r.closed_matches, open_conflicts: r.open_conflicts };
  } catch (err) { ev.errors.push(`precheck: ${err.message}`); }

  try {
    const s = search || (await import('../memory/memory-search.js')).hybridMemorySearch;
    const r = await s(text, { limit: 5 });
    ev.search = (r.results || []).map((h) => ({ kind: h.kind, id: h.id, status: h.status, origin: h.origin, date: h.row_date, text: String(h.text || '').slice(0, 200) }));
  } catch (err) { ev.errors.push(`search: ${err.message}`); }

  const codes = workflowCodesIn(text);
  if (codes.length && db) {
    try {
      const r = await db.from('claude_workflow_ref').select('code, name, status').in('code', codes);
      if (r.error) throw new Error(r.error.message);
      ev.workflows = r.data || [];
    } catch (err) { ev.errors.push(`workflow_ref: ${err.message}`); }
  }

  if (card.card_type === 'conflict') {
    ev.sides = {
      left: { id: card.left_id, text: card.left_text, origin: card.left_origin, confidence: card.left_confidence, date: card.left_date, status: card.left_status },
      right: { id: card.right_id, text: card.right_text, origin: card.right_origin, confidence: card.right_confidence, date: card.right_date, status: card.right_status },
    };
  }
  return ev;
}

/** The user turn: the card, then the evidence, nothing else. */
export function buildUserPrompt(card, ev) {
  const lines = [
    `CARD: ${card.card_type} (${card.source_table} #${card.source_id})`,
    `Area: ${card.area || 'unknown'}    Age: ${card.age_days ?? '?'} days    Origin: ${card.origin || 'unknown'}`,
    '',
    `What is being asked:`,
    String(card.description || '').slice(0, 1500),
  ];
  if (Array.isArray(card.options) && card.options.length) {
    lines.push('', 'Options on the card:');
    card.options.forEach((o, i) => lines.push(`  [${i}] ${typeof o === 'string' ? o : JSON.stringify(o)}`));
    lines.push('(To pick one, answer verdict "answer" and put that option\'s exact wording in decision_text.)');
  }
  if (ev.sides) {
    lines.push('', 'The two sides of the conflict:');
    lines.push(`  LEFT  #${ev.sides.left.id} [${ev.sides.left.origin || '?'} / ${ev.sides.left.confidence || '?'} / ${ev.sides.left.date || '?'}] ${String(ev.sides.left.text || '').slice(0, 400)}`);
    lines.push(`  RIGHT #${ev.sides.right.id} [${ev.sides.right.origin || '?'} / ${ev.sides.right.confidence || '?'} / ${ev.sides.right.date || '?'}] ${String(ev.sides.right.text || '').slice(0, 400)}`);
  }
  if (ev.precheck) {
    lines.push('', `Precheck verdict: ${ev.precheck.verdict}`);
    for (const a of ev.precheck.active || []) lines.push(`  ACTIVE decision #${a.id} (${a.similarity ?? '?'} match, ${a.origin || '?'}): ${a.text}`);
    for (const c of ev.precheck.closed_matches || []) lines.push(`  CLOSED/REJECTED decision #${c.id} (${c.status}): ${c.text}`);
    for (const c of ev.precheck.open_conflicts || []) lines.push(`  OPEN CONFLICT #${c.id} between #${c.row_a} and #${c.row_b}`);
  }
  if (ev.search.length) {
    lines.push('', 'Nearby memory:');
    for (const h of ev.search) lines.push(`  ${h.kind} #${h.id} [${h.status || '?'} / ${h.origin || '?'} / ${h.date || '?'}]: ${h.text}`);
  }
  if (ev.workflows.length) {
    lines.push('', 'Referenced workflows:');
    for (const w of ev.workflows) lines.push(`  ${w.code} ${w.name} (${w.status})`);
  }
  if (!ev.precheck && !ev.search.length) lines.push('', 'NOTE: no supporting memory could be retrieved for this item.');
  return lines.join('\n');
}

/** Clamp the model's output to the vocabularies the columns accept. */
/** The safe answer for each lane: the one that changes nothing but the clock. */
const LANE_DEFAULT_VERDICT = Object.freeze({ rulings: 'not_now', stale: 'still_broken', todos: 'keep' });

/** A card's lane, from the view's own column, falling back to its card_type. */
export function laneOf(card) {
  const lane = String(card?.lane || '').trim();
  if (LANE_VERDICTS[lane]) return lane;
  const type = String(card?.card_type || '').trim();
  if (type === 'stale_issue') return 'stale';
  if (type === 'todo') return 'todos';
  return 'rulings';
}

export function normalizeOutput(raw, card) {
  const pick = (v, list, fallback) => (list.includes(String(v || '').trim()) ? String(v).trim() : fallback);
  const lane = laneOf(card);
  const out = {
    // Scoped to the card's own lane. A model that answers "approve" on a stale
    // issue has not given a weak answer, it has answered a different question —
    // and letting it through would put an approve button's verdict behind a
    // "Fixed" button. Falling back to the lane's safe default is the only
    // reading that changes nothing.
    verdict: pick(raw?.verdict, LANE_VERDICTS[lane], LANE_DEFAULT_VERDICT[lane]),
    reason: String(raw?.reason || '').slice(0, 1000) || 'No reason given.',
    evidence: Array.isArray(raw?.evidence)
      ? raw.evidence.slice(0, 8).map((e) => ({ type: String(e?.type || 'query'), ref: String(e?.ref || ''), note: String(e?.note || '').slice(0, 300) }))
      : [],
    confidence: pick(raw?.confidence, CONFIDENCES, 'low'),
    risk: pick(raw?.risk, RISKS, 'none'),
    decision_text: raw?.decision_text ? String(raw.decision_text).slice(0, 4000) : null,
    category: pick(raw?.category, CATEGORIES, 'operations'),
    build_text: raw?.build_text ? String(raw.build_text).slice(0, 2000) : null,
    group_key: GROUP_KEYS.includes(String(raw?.group_key || '').trim()) ? String(raw.group_key).trim() : null,
    lane,
  };
  // THE BLANKET AREA BACKSTOP IS GONE (issue #2135, 2026-09-14).
  //
  // It used to read: if the model said "none" and the card's area was
  // payroll-callcenter or partners-vendors, force "money". The intent was
  // decent — those areas can least afford a confident wrong answer — but area
  // is where a card is FILED, not what ruling on it DOES. A reporting tweak
  // that happens to show payroll numbers was coming out as a money risk.
  //
  // Measured on 2026-09-14: 292 of 393 recommended cards carried a risk flag.
  // 74%. At that rate the flag is decoration — a reader who sees it on three
  // cards in four stops reading it, which costs exactly the cards it was
  // supposed to protect. The target is 15-25%, and the definition now lives in
  // rule 4 of the prompt: risk is what ACTING on the card changes, not what
  // folder it sits in.
  //
  // What remains is rule 4's cap, enforced rather than trusted: a real risk and
  // a confident verdict is the one combination that must never reach a batch
  // pass, because high confidence is exactly what a batch selects on.
  if (out.risk !== 'none' && out.confidence === 'high') out.confidence = 'medium';

  // A group key that contradicts its own verdict would put a card under a
  // heading that does not describe it — and the heading is the only thing
  // somebody reads before approving fifty at once.
  if (out.group_key && !out.group_key.startsWith(`${out.verdict}:`)) out.group_key = null;

  return out;
}

async function loadQueueRow(db, table, id) {
  const res = await db.from('v_command_center_queue').select('*').eq('source_table', table).eq('source_id', id).maybeSingle();
  if (res.error) throw new Error(`v_command_center_queue: ${res.error.message}`);
  return res.data || null;
}

/**
 * Recommend on ONE card. Returns the normalized recommendation; writes
 * according to `mode`. Throws only on a hard failure (card missing, LLM
 * unusable) — recommendBatch catches and moves on.
 */
export async function recommendOne(table, id, deps = {}) {
  const db = deps.db || supabase;
  const env = deps.env || process.env;
  const mode = deps.mode || getMode(env);
  if (!db) throw new Error('Supabase client not configured');

  const card = deps.card || await loadQueueRow(db, table, id);
  if (!card) throw new Error(`${table} #${id} is not in the Rulings lane`);

  const ev = await gatherEvidence(card, { db, precheck: deps.precheck, search: deps.search, env });
  const llm = deps.callLLMJson || callLLMJson;
  // The model comes from llm-client's own env contract. envPrefix('memory_recommend')
  // is MEMORY_RECOMMEND, so MEMORY_RECOMMEND_MODEL / _MODEL_ANTHROPIC / _MODEL_OPENAI
  // and _PROVIDER already select this call site without any lookup here.
  // 2026-09-15 — THINKING-BUDGET INCIDENT. The first live backfill batch after the
  // temperature fix lost 36 of 150 cards (24%) to one root cause: 900 output tokens.
  // The models this call site now runs on emit a thinking block before any text, and
  // that block is charged against max_tokens. Half the failures came back with
  // stop_reason=max_tokens and blocks=[thinking] (no text at all); the other half were
  // JSON cut off mid-string. Neither is a prompt problem and neither is salvageable
  // after the fact — the answer was never finished. The verdict JSON itself is ~250
  // tokens, so the budget has to carry the reasoning too. llm-client's own error text
  // has said "raise maxTokens" all along.
  const res = await withTimeout(
    llm({
      fn: 'memory_recommend', system: SYSTEM_PROMPT, user: buildUserPrompt(card, ev),
      maxTokens: 3000, temperature: 0, json: true,
    }),
    getItemTimeout(env), `recommend ${table}#${id}`,
  );
  const rec = normalizeOutput(res.data, card);
  rec.source_table = table; rec.source_id = id; rec.mode = mode;
  if (ev.errors.length) rec.evidence_errors = ev.errors;

  if (mode === 'shadow') {
    const r = await db.from('claude_memory_validation_log').insert({
      check_name: 'recommend:shadow', mode: 'shadow', rows_checked: 1, rows_flagged: 1,
      sample: { table, id, card_type: card.card_type, area: card.area, ...rec },
      notes: 'shadow: rec_* columns not written',
    });
    if (r?.error) throw new Error(`validation log: ${r.error.message}`);
    return rec;
  }

  if (mode === 'live') {
    const patch = {
      rec_verdict: rec.verdict, rec_reason: rec.reason, rec_evidence: rec.evidence,
      rec_confidence: rec.confidence, rec_risk: rec.risk, rec_at: new Date().toISOString(),
      rec_source_version: card.card_version,
      // The column has existed since sql/102 and been written by nothing until
      // now. It is what the Command Center groups a batch pass by.
      rec_group_key: rec.group_key,
    };
    // Only the tables that have them — a conflict has no category or build.
    if (table === 'claude_pending_items') {
      patch.rec_decision_text = rec.decision_text;
      patch.rec_category = rec.category;
      patch.rec_build_text = rec.build_text;
    } else if (table === 'claude_memory_conflicts') {
      patch.rec_decision_text = rec.decision_text;
    }
    const r = await db.from(table).update(patch).eq('id', id);
    if (r?.error) throw new Error(`${table} #${id}: ${r.error.message}`);
    rec.written = true;
  }
  return rec;
}

/** Every table a card can come from, across all three lanes (sql/112). */
const SOURCE_TABLES = Object.freeze([
  'claude_pending_items', 'claude_memory_conflicts', 'claude_known_issues',
]);

/**
 * The rec_source_version of each already-recommended card, read from the SOURCE
 * TABLES rather than the queue.
 *
 * v_command_center_queue exposes card_version but NOT rec_source_version — it
 * selects the other nine rec_* columns and stops. Reading it off a queue row
 * therefore yields undefined, which never equals card_version, so every card
 * looks stale and the entire backlog is re-recommended on every single run.
 * One round-trip per table, not per card.
 */
async function loadRecVersions(db, rows) {
  const out = new Map();
  for (const table of SOURCE_TABLES) {
    const ids = rows
      .filter((r) => r.source_table === table && r.rec_at != null)
      .map((r) => r.source_id);
    if (ids.length === 0) continue;
    const res = await db.from(table).select('id, rec_source_version').in('id', ids);
    if (res.error) throw new Error(`${table}.rec_source_version: ${res.error.message}`);
    for (const row of res.data || []) out.set(`${table}:${row.id}`, row.rec_source_version ?? null);
  }
  return out;
}

/**
 * Candidates: Rulings-lane cards with no recommendation, or whose CONTENT has
 * changed since the last one (rec_source_version no longer matches
 * claude_card_version). Ordered by the queue's own risk-first sort, so a capped
 * run does the items that matter most.
 */
export async function loadCandidates(db, limit) {
  const res = await db.from('v_command_center_queue').select('*')
    .order('sort_conflict', { ascending: true })
    .order('sort_risk', { ascending: true })
    .order('sort_blocks', { ascending: true })
    .order('area_rank', { ascending: true })
    .order('area', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(Math.max(limit * 4, limit));
  if (res.error) throw new Error(`v_command_center_queue: ${res.error.message}`);
  const rows = res.data || [];
  const recVersions = await loadRecVersions(db, rows);

  const stale = [];
  for (const r of rows) {
    // rec_at null = never recommended. Otherwise the recommendation is stale
    // only when the card's CONTENT hash moved — rec_* writes never trigger it.
    // A card whose version could not be read falls through as stale: doing the
    // work twice is cheap, silently never refreshing a moved card is not.
    const seen = recVersions.has(`${r.source_table}:${r.source_id}`)
      ? recVersions.get(`${r.source_table}:${r.source_id}`)
      : undefined;
    const needs = r.rec_at == null || seen !== (r.card_version ?? null);
    if (needs) stale.push(r);
    if (stale.length >= limit) break;
  }
  return stale;
}

/**
 * Run the backlog. Never throws for one bad item: it is counted, logged, and the
 * run moves on. Returns counts plus the first three results as samples.
 */
export async function recommendBatch({ limit, mode, dry_run = false, deps = {} } = {}) {
  const db = deps.db || supabase;
  const env = deps.env || process.env;
  const runMode = mode || getMode(env);
  const cap = Math.min(limit || getMaxPerRun(env), getMaxPerRun(env));
  const out = { mode: runMode, dry_run, candidates: 0, attempted: 0, written: 0, skipped: 0, samples: [], errors: [], started_at: new Date().toISOString() };
  if (runMode === 'off') { out.note = 'MEMORY_RECOMMEND_MODE is off'; return out; }
  if (!db) { out.errors.push('Supabase client not configured'); return out; }

  let candidates = [];
  try { candidates = await loadCandidates(db, cap); }
  catch (err) { out.errors.push(`candidates: ${err.message}`); return out; }
  out.candidates = candidates.length;
  if (dry_run) {
    out.samples = candidates.slice(0, 3).map((c) => ({
      table: c.source_table, id: c.source_id, card_type: c.card_type, area: c.area,
      age_days: c.age_days, description: String(c.description || '').slice(0, 200),
    }));
    return out;
  }

  for (const card of candidates) {
    out.attempted += 1;
    try {
      const rec = await recommendOne(card.source_table, card.source_id, { ...deps, db, env, mode: runMode, card });
      if (runMode === 'live') out.written += 1;
      if (out.samples.length < 3) out.samples.push({ table: card.source_table, id: card.source_id, verdict: rec.verdict, confidence: rec.confidence, risk: rec.risk, reason: rec.reason });
    } catch (err) {
      // A malformed JSON reply, a timeout, a row that moved — one item, not the run.
      out.skipped += 1;
      out.errors.push(`${card.source_table}#${card.source_id}: ${err.message}`);
      try {
        await db.from('claude_memory_validation_log').insert({
          check_name: 'recommend:error', mode: runMode, rows_checked: 1, rows_flagged: 1,
          sample: { table: card.source_table, id: card.source_id, error: String(err.message).slice(0, 500) },
          notes: 'item skipped; batch continued',
        });
      } catch { /* the log is best effort — never the reason a run stops */ }
    }
  }
  out.finished_at = new Date().toISOString();
  console.log(`[MemoryRecommend] ${runMode} done candidates=${out.candidates} attempted=${out.attempted} written=${out.written} skipped=${out.skipped}`);
  return out;
}

export default { recommendOne, recommendBatch, getMode, RECOMMEND_MODES };
