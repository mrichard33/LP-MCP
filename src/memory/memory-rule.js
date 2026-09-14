/**
 * Memory Rule — src/memory/memory-rule.js  (Command Center R1, sql/102)
 *
 * ONE door for every ruling. The dashboard calls it through the memory_rule MCP
 * tool; chat calls the same tool with via:'chat'. Both produce the same record:
 * a decision (or a re-confirmation), a closed card, and one row in
 * claude_rulings_log carrying the exact before/after of everything it touched.
 *
 * This module is the VALIDATION and GUARD layer. It never writes a memory table
 * itself — every write goes through claude_rule_apply(jsonb) (sql/102 F), which
 * is one plpgsql function and therefore one transaction. A ruling is never half
 * applied: no card is closed without its decision, no decision exists without
 * its audit row.
 *
 * What happens here and not in SQL:
 *
 *   validation      the Release 1 action set, which target tables each action may
 *                   address, when a reason is required (reject / no / flip, and
 *                   any ruling that DIFFERS from the recommendation), proof for
 *                   stage 'verified', a snooze date in the future.
 *
 *   decision text   an Omi card's description carries the marks of where it came
 *                   from — "[Omi 2026-09-11] ", "CONFLICTS WITH #412 — ",
 *                   "Possible issue heard in Omi — ". Those are provenance, not
 *                   the decision, so they are stripped before the text is saved.
 *
 *   the guard       the SAME check memory_checkpoint runs (memory-checkpoint.js
 *                   runGuard): a new ACTIVE decision whose nearest active
 *                   decision is at or above MEMORY_CONFLICT_THRESHOLD must say
 *                   which one it replaces (supersedes_id) or re-confirms
 *                   (same_as_id). Here it never silently writes: the ruling comes
 *                   back {ok:false, code:'guard_conflict'} with the match, and
 *                   the page asks Replace it / Same thing / Cancel.
 *                   Rejections skip it — a rejection is not a competing truth.
 *                   With no embedding available the check is skipped and the
 *                   result says so; the nightly conflict scan is the backstop.
 *
 *   the flip        a two-sided ruling flips ACROSS, not just off. approve and
 *                   yes flip to reject and no; keep_left flips to keep_right.
 *                   Node reads the original ruling, works out the opposite, and
 *                   passes it as then_action so both halves land in the one
 *                   transaction. Everything else just reopens the card.
 *
 * The daily session is identified exactly the way memory_checkpoint identifies
 * a session — checkpointKeyFor({surface, date, title}) — so the two tools can
 * never mint two sessions for the same day's rulings.
 *
 * v1.0 — 2026-09-11. Initial (Command Center Release 1).
 */
import supabase from '../supabase.js';
import { checkpointKeyFor, decisionText, getConflictThreshold } from './memory-checkpoint.js';

/** Every action Release 1 accepts. Anything else is 'not_in_release'. */
export const RULE_ACTIONS = Object.freeze([
  // Rulings lane (sql/102).
  'approve', 'edit_approve', 'reject', 'pick_option', 'own_answer', 'yes', 'no',
  'keep_left', 'keep_right', 'not_a_conflict', 'new_answer',
  'snooze', 'not_relevant', 'stage', 'flip', 'recheck',
  // Stale-issue lane (sql/112).
  'still_broken', 'fixed', 'no_longer_matters',
  // To-do lane (sql/112).
  'done', 'drop', 'keep', 'assign',
  // Batch passes (sql/112). These address a GROUP, not one card.
  'batch_apply', 'batch_undo',
]);

/**
 * The lane verdicts. They go to claude_rule_lane_apply rather than
 * claude_rule_apply, because Release 1's writer knows nothing about stale
 * issues and rejects claude_known_issues outright. Both write one
 * claude_rulings_log row in one transaction, so the audit trail is the same
 * shape whichever door a ruling came through.
 */
export const LANE_ACTIONS = Object.freeze(new Set([
  'still_broken', 'fixed', 'no_longer_matters', 'done', 'drop', 'keep', 'assign',
]));

/** Which table each lane verdict may touch. Wrong table, wrong question. */
export const LANE_ACTION_TABLE = Object.freeze({
  still_broken: 'claude_known_issues',
  fixed: 'claude_known_issues',
  no_longer_matters: 'claude_known_issues',
  done: 'claude_pending_items',
  drop: 'claude_pending_items',
  keep: 'claude_pending_items',
  assign: 'claude_pending_items',
});

export const BATCH_ACTIONS = Object.freeze(new Set(['batch_apply', 'batch_undo']));

/** A batch will not go past this, and neither will we — fail before the round trip. */
export const BATCH_MAX = 50;

const RULABLE_TABLES = new Set([
  'claude_pending_items', 'claude_memory_conflicts', 'claude_decision_log',
  // sql/112: the stale lane. Release 1's claude_rule_apply still rejects this
  // table; only the lane verdicts, which go to claude_rule_lane_apply, may use it.
  'claude_known_issues',
]);
/** claude_decision_log is a card only for these two — you do not "approve" a decision. */
const DECISION_ONLY_ACTIONS = new Set(['stage', 'flip']);
/** Actions that file a NEW active decision, so the conflict guard applies. */
const WRITES_ACTIVE_DECISION = new Set(['approve', 'edit_approve', 'yes', 'pick_option', 'own_answer', 'new_answer']);
/** Reason is never optional on these, recommendation or not. */
const ALWAYS_NEEDS_REASON = new Set(['reject', 'no', 'flip']);

/** The twelve categories claude_decision_log.category is drawn from. */
export const CATEGORIES = Object.freeze([
  'architecture', 'routing', 'messaging', 'appointments', 'sync', 'integration',
  'data', 'agentic', 'infrastructure', 'reporting', 'compliance', 'operations',
]);

/** A two-sided ruling and its opposite. Flipping one applies the other. */
const OPPOSITE = Object.freeze({
  approve: 'reject', edit_approve: 'reject', yes: 'no',
  reject: 'approve', no: 'yes',
  keep_left: 'keep_right', keep_right: 'keep_left',
});

/**
 * What the recommendation would have called this ruling, so "did Mark override
 * the recommendation?" is a string comparison. Mirrors the verdict vocabulary
 * memory-recommend.js emits.
 */
export function verdictFor(action, optionKey) {
  switch (action) {
    case 'approve': case 'edit_approve': return 'approve';
    case 'pick_option': return `pick:${optionKey ?? ''}`;
    case 'own_answer': return 'answer';
    case 'snooze': return 'not_now';
    case 'reject': case 'no': case 'yes':
    case 'keep_left': case 'keep_right': case 'not_a_conflict': case 'new_answer':
      return action;
    default: return null; // stage, flip, not_relevant, recheck have no rec equivalent
  }
}

// Provenance marks Omi puts on a description. They say where the item came from;
// they are not part of the decision, so they never reach claude_decision_log.
const OMI_PREFIXES = [
  /^\[Omi \d{4}-\d{2}-\d{2}\]\s*/,
  /^CONFLICTS WITH #\d+\s*—\s*/,
  /^Possible issue heard in Omi\s*—\s*/,
];

/** Strip the Omi provenance prefixes from a card description. */
export function stripOmiPrefix(text) {
  let out = String(text ?? '');
  let changed = true;
  // Loop: a card can carry two marks ("[Omi …] CONFLICTS WITH #12 — …").
  while (changed) {
    changed = false;
    for (const re of OMI_PREFIXES) {
      const next = out.replace(re, '');
      if (next !== out) { out = next; changed = true; }
    }
  }
  return out.trim();
}

export class RuleError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Stable codes claude_rule_apply raises, in the order Node should test them. */
const RPC_CODES = [
  'stale_card', 'already_reversed', 'changed_since', 'reason_required', 'proof_required',
  'not_in_release', 'bad_input',
  // sql/112 — the batch refusals.
  'batch_too_large', 'not_batchable', 'confidence_too_low',
];

/** Map an RPC error message back to its stable code. */
export function codeOf(message) {
  const m = String(message || '');
  for (const c of RPC_CODES) if (m.startsWith(`${c}:`) || m.includes(` ${c}:`)) return c;
  return 'error';
}

function dateET(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** The one session every ruling made today attaches to. */
export function sessionIdentity(now = new Date()) {
  const date = dateET(now);
  const title = `Command Center rulings — ${date}`;
  return { date, title, checkpoint_key: checkpointKeyFor({ surface: 'dashboard', date, title }) };
}

/** MEMORY_RECOMMEND_MODE: off (default) | shadow | live. */
export function getRecommendMode(env = process.env) {
  const m = String(env.MEMORY_RECOMMEND_MODE || 'off').toLowerCase().trim();
  return ['off', 'shadow', 'live'].includes(m) ? m : 'off';
}

async function defaultEmbed(env = process.env) {
  if (!env.OPENAI_API_KEY) return null;
  const m = await import('../knowledge/openai-embeddings.js');
  return m.embed;
}

/** Pick the option the ruler clicked. Options are a plain string array today; object shapes are tolerated. */
export function resolveOption(options, optionKey) {
  const list = Array.isArray(options) ? options : [];
  if (!list.length) return null;
  const key = String(optionKey ?? '');
  // An index — "0", "1", "2" — is what a list of plain strings gives the UI.
  if (/^\d+$/.test(key)) {
    const o = list[Number(key)];
    if (o != null) return typeof o === 'string' ? o : (o.label ?? o.text ?? o.value ?? JSON.stringify(o));
  }
  for (const o of list) {
    if (typeof o === 'string') { if (o === key) return o; continue; }
    if (o && [o.key, o.id, o.value, o.label].map(String).includes(key)) return o.label ?? o.text ?? o.value ?? key;
  }
  return null;
}

/** Load the card a ruling addresses. Returns null when the row is gone. */
async function loadCard(db, table, id) {
  const cols = {
    claude_pending_items: 'id, item_type, description, status, options, origin, area, raw, rec_verdict, rec_decision_text, rec_category, rec_build_text, rec_risk, snooze_until',
    claude_memory_conflicts: 'id, kind, row_a, row_b, status, rec_verdict, rec_decision_text, rec_risk, snooze_until',
    claude_decision_log: 'id, decision, category, status, rollout_stage, area',
    claude_known_issues: 'id, description, status, stale, verified_at, verification_note, area, origin, rec_verdict, rec_risk, rec_group_key, rec_confidence, snooze_until',
  }[table];
  const res = await db.from(table).select(cols).eq('id', id).maybeSingle();
  if (res.error) throw new RuleError('error', `load ${table} #${id}: ${res.error.message}`);
  return res.data || null;
}

/**
 * The wording that goes into claude_decision_log, in priority order:
 *   1. what the ruler typed or edited
 *   2. the card's own words, with Omi provenance stripped
 *   3. the recommendation's suggested wording
 */
export function decisionTextFor(action, card, input) {
  const typed = input.text == null || input.text === '' ? null : String(input.text).trim();
  if (typed) return typed;
  if (action === 'pick_option') {
    const picked = resolveOption(card?.options, input.option_key);
    if (picked) return picked;
  }
  const stripped = card?.description ? stripOmiPrefix(card.description) : '';
  if (stripped) return stripped;
  const rec = card?.rec_decision_text ? String(card.rec_decision_text).trim() : '';
  return rec || null;
}

function categoryFor(card, input) {
  const given = input.category ? String(input.category).toLowerCase().trim() : null;
  if (given) {
    if (!CATEGORIES.includes(given)) throw new RuleError('bad_input', `category must be one of ${CATEGORIES.join(', ')}`);
    return given;
  }
  const rec = card?.rec_category ? String(card.rec_category).toLowerCase().trim() : null;
  return rec && CATEGORIES.includes(rec) ? rec : 'operations';
}

/** Plain words for what a lane verdict is about to do. Shown by the dry run. */
export function laneSummary(action, table, id, { proof = null, assignee = null } = {}) {
  const ref = `${table === 'claude_known_issues' ? 'issue' : 'to-do'} #${id}`;
  switch (action) {
    case 'still_broken':      return `Mark ${ref} as still broken — re-verified today, nothing closed.`;
    case 'fixed':             return `Close ${ref} as resolved, with the proof: ${proof}`;
    case 'no_longer_matters': return `Close ${ref} as wont_fix — the thing it was about is gone.`;
    case 'done':              return `Close ${ref} as done.`;
    case 'drop':              return `Close ${ref} as dropped.`;
    case 'keep':              return `Keep ${ref} and ask again in 30 days. Nothing closes.`;
    case 'assign':            return `Give ${ref} to ${assignee}.`;
    default:                  return `${action} on ${ref}.`;
  }
}

/**
 * The payload for a batch pass. Validated HERE as well as in SQL so a bad batch
 * costs nothing and the message names the problem — the SQL refuses the same
 * things, but a caller should not have to send fifty ids to be told fifty-one
 * is too many.
 */
export function buildBatchPlan(input = {}, { now = new Date() } = {}) {
  const action = String(input.action || '').trim();

  if (action === 'batch_undo') {
    const batch_id = input.batch_id ? String(input.batch_id).trim() : null;
    if (!batch_id) throw new RuleError('bad_input', 'batch_undo needs batch_id');
    const reason = input.reason == null || input.reason === '' ? null : String(input.reason).trim();
    if (!reason) throw new RuleError('reason_required', 'an undo must say why');
    return {
      batch: true, action,
      summary: `Reverse every ruling in batch ${batch_id}, restoring each row exactly as it was.`,
      p: { batch_id, reason, ruled_by: input.ruled_by ? String(input.ruled_by) : 'mark (chat)' },
    };
  }

  const verdict = String(input.verdict || '').trim();
  if (!LANE_ACTIONS.has(verdict)) {
    throw new RuleError('bad_input', `batch_apply needs a lane verdict — one of ${[...LANE_ACTIONS].join(', ')}`);
  }
  const targets = Array.isArray(input.targets) ? input.targets : null;
  if (!targets || !targets.length) throw new RuleError('bad_input', 'batch_apply needs a non-empty targets array');
  if (targets.length > BATCH_MAX) {
    throw new RuleError('batch_too_large', `${targets.length} targets — ${BATCH_MAX} is the most that can be ruled at once, because ${BATCH_MAX} is about as many lines as anyone actually reads before clicking`);
  }

  const want = LANE_ACTION_TABLE[verdict];
  const proof = input.proof ? String(input.proof).trim() : null;
  const clean = targets.map((t, i) => {
    const table = t?.table ? String(t.table) : want;
    const id = t?.id == null ? null : Number(t.id);
    if (!Number.isInteger(id) || id < 1) throw new RuleError('bad_input', `targets[${i}] needs an id`);
    if (table !== want) throw new RuleError('bad_input', `targets[${i}]: ${verdict} rules ${want}, not ${table}`);
    const rowProof = t?.proof ? String(t.proof).trim() : proof;
    if (verdict === 'fixed' && !rowProof) {
      throw new RuleError('proof_required', `targets[${i}] (#${id}): closing an issue as fixed needs a link to what fixed it`);
    }
    return {
      table, id,
      card_version: t?.card_version ? String(t.card_version) : null,
      ...(rowProof ? { proof: rowProof } : {}),
    };
  });

  if (verdict === 'assign' && !input.assignee) {
    throw new RuleError('bad_input', 'assign needs an assignee');
  }

  return {
    batch: true, action, verdict, count: clean.length,
    summary: `${laneSummary(verdict, want, 0, { proof, assignee: input.assignee }).replace(/ #0/, 's')} — ${clean.length} of them, in one reversible pass.`,
    p: {
      verdict, targets: clean, proof,
      assignee: input.assignee ? String(input.assignee).trim() : null,
      reason: input.reason == null || input.reason === '' ? null : String(input.reason).trim(),
      ruled_by: input.ruled_by ? String(input.ruled_by) : 'mark (chat)',
      via: input.via === 'chat' ? 'chat' : 'dashboard',
      rec_group_key: input.rec_group_key ? String(input.rec_group_key) : null,
      session: sessionIdentity(now),
    },
  };
}

/**
 * Build the payload claude_rule_apply receives, and say what it will do.
 * Pure apart from the card read. Throws RuleError on bad input.
 */
export async function buildPlan(input = {}, { db = supabase, now = new Date(), env = process.env } = {}) {
  const action = String(input.action || '').trim();
  if (!RULE_ACTIONS.includes(action)) {
    throw new RuleError('not_in_release', `action "${action || '(none)'}" is not part of Release 1 — use one of ${RULE_ACTIONS.join(', ')}`);
  }

  let table = input.target?.table ? String(input.target.table) : null;
  let id = input.target?.id == null ? null : Number(input.target.id);
  const reverses_id = input.reverses_id == null ? null : Number(input.reverses_id);

  // A batch addresses a group, not a card, so it has no plan to build here —
  // applyRule routes it straight to claude_rule_batch / claude_rule_batch_undo.
  if (BATCH_ACTIONS.has(action)) {
    throw new RuleError('bad_input', `${action} is a batch action — it does not take a single target`);
  }

  // ── The lane verdicts (sql/112). A short path on purpose: a stale issue has
  // no decision to write, no options to resolve, no build to file and no
  // supersedes guard to run. Everything below this block is about a decision.
  if (LANE_ACTIONS.has(action)) {
    const want = LANE_ACTION_TABLE[action];
    if (!table) table = want;
    if (table !== want) {
      throw new RuleError('bad_input', `${action} rules ${want}, not ${table}`);
    }
    if (!Number.isInteger(id) || id < 1) throw new RuleError('bad_input', 'target { table, id } is required');

    const laneCard = await loadCard(db, table, id);
    if (!laneCard) throw new RuleError('bad_input', `${table} #${id} not found`);

    const laneProof = input.proof ? String(input.proof).trim() : null;
    // Closing an issue as fixed without a link is a guess wearing a fact's
    // clothes — and nobody re-opens a resolved issue to check. The SQL refuses
    // it too; this is the same refusal one round trip earlier, with a message
    // that says what to do about it.
    if (action === 'fixed' && !laneProof) {
      throw new RuleError('proof_required', 'closing an issue as fixed needs a link to what fixed it — a merged PR, a commit, a file path, or a line saying what was checked');
    }
    const assignee = input.assignee ? String(input.assignee).trim() : (input.owner ? String(input.owner).trim() : null);
    if (action === 'assign' && !assignee) {
      throw new RuleError('bad_input', 'assign needs an assignee — pass assignee');
    }

    const laneSession = sessionIdentity(now);
    return {
      lane: true,
      card: laneCard,
      overrides: Boolean(laneCard.rec_verdict && laneCard.rec_verdict !== action),
      summary: laneSummary(action, table, id, { proof: laneProof, assignee }),
      p: {
        action, target_table: table, target_id: id,
        card_version: input.card_version ? String(input.card_version) : null,
        ruled_by: input.ruled_by ? String(input.ruled_by) : 'mark (chat)',
        via: input.via === 'chat' ? 'chat' : 'dashboard',
        reason: input.reason == null || input.reason === '' ? null : String(input.reason).trim(),
        proof: laneProof,
        assignee,
        rec_group_key: laneCard.rec_group_key || null,
        session: laneSession,
      },
    };
  }

  // A flip addresses a RULING, so it can find its own card.
  let original = null;
  if (action === 'flip') {
    if (!Number.isInteger(reverses_id) || reverses_id < 1) throw new RuleError('bad_input', 'flip needs reverses_id (the id of the ruling to undo)');
    const res = await db.from('claude_rulings_log')
      .select('id, action, target_table, target_id, reason, reversed_by, decision_id')
      .eq('id', reverses_id).maybeSingle();
    if (res.error) throw new RuleError('error', `load ruling #${reverses_id}: ${res.error.message}`);
    original = res.data || null;
    if (!original) throw new RuleError('bad_input', `ruling #${reverses_id} not found`);
    if (original.reversed_by != null) throw new RuleError('already_reversed', `ruling #${reverses_id} was already reversed by #${original.reversed_by}`);
    if (original.action === 'flip') throw new RuleError('not_in_release', `ruling #${reverses_id} is itself a flip — rule the card again rather than flipping the flip`);
    table = table || original.target_table;
    id = id ?? original.target_id;
  }

  if (!table || !Number.isInteger(id) || id < 1) throw new RuleError('bad_input', 'target { table, id } is required');
  if (!RULABLE_TABLES.has(table)) throw new RuleError('bad_input', `target.table must be one of ${[...RULABLE_TABLES].join(', ')}`);
  if (table === 'claude_decision_log' && !DECISION_ONLY_ACTIONS.has(action)) {
    throw new RuleError('bad_input', 'claude_decision_log is only addressable by stage and flip');
  }

  const card = await loadCard(db, table, id);
  if (!card && action !== 'flip') throw new RuleError('bad_input', `${table} #${id} not found`);

  const reason = input.reason == null || input.reason === '' ? null : String(input.reason).trim();
  const verdict = verdictFor(action, input.option_key);
  // "Differs from the recommendation" only means something when there IS one.
  const recVerdict = card?.rec_verdict ? String(card.rec_verdict) : null;
  const overrides = Boolean(recVerdict && verdict && verdict !== recVerdict);
  const needsReason = ALWAYS_NEEDS_REASON.has(action)
    || overrides
    || Boolean(recVerdict && action === 'not_relevant');
  if (needsReason && !reason) {
    throw new RuleError('reason_required', ALWAYS_NEEDS_REASON.has(action)
      ? `${action} must say why`
      : `this differs from the recommendation (${recVerdict}) — say why`);
  }

  if (action === 'stage') {
    const stage = input.stage ? String(input.stage) : null;
    if (!['built', 'verified', 'no_build'].includes(stage || '')) throw new RuleError('bad_input', 'stage must be built, verified or no_build');
    if (stage === 'verified' && !(input.proof && String(input.proof).trim())) {
      throw new RuleError('proof_required', 'verified needs a proof line — what shows it is actually working');
    }
  }

  let snooze_until = null;
  if (action === 'snooze') {
    snooze_until = input.snooze_until ? String(input.snooze_until).trim() : null;
    if (!snooze_until || !/^\d{4}-\d{2}-\d{2}$/.test(snooze_until)) throw new RuleError('bad_input', 'snooze_until must be YYYY-MM-DD');
    if (snooze_until <= dateET(now)) throw new RuleError('bad_input', `snooze_until ${snooze_until} must be a future date`);
  }

  const session = sessionIdentity(now);
  const p = {
    action, target_table: table, target_id: id,
    card_version: input.card_version ? String(input.card_version) : null,
    ruled_by: input.ruled_by ? String(input.ruled_by) : 'mark (chat)',
    via: input.via === 'chat' ? 'chat' : 'dashboard',
    reason, session,
    stage: action === 'stage' ? String(input.stage) : null,
    proof: input.proof ? String(input.proof).trim() : null,
    snooze_until,
    reverses_id: action === 'flip' ? reverses_id : null,
    rec_verdict: recVerdict,
  };

  // The ruling's own decision text, for every action that writes one.
  const writesDecision = WRITES_ACTIVE_DECISION.has(action) || action === 'reject' || action === 'no';
  if (writesDecision) {
    const text = decisionTextFor(action, card, input);
    if (!text) throw new RuleError('bad_input', 'nothing to save as the decision — pass text');
    let rationale = input.rationale ? String(input.rationale) : null;
    // An open question is answered, not approved: the question itself becomes the
    // rationale so the decision still reads as an answer to something.
    if (card?.item_type === 'open_question') {
      const q = stripOmiPrefix(card.description || '');
      rationale = [`Answers open question #${id}: ${q}`, reason].filter(Boolean).join(' — ');
    } else if (!rationale && reason) {
      rationale = reason;
    }
    p.decision = { text, category: categoryFor(card, input), rationale };

    let supersedes_id = input.supersedes_id == null ? null : Number(input.supersedes_id);
    const same_as_id = input.same_as_id == null ? null : Number(input.same_as_id);
    if (supersedes_id && same_as_id) throw new RuleError('bad_input', 'supersedes_id and same_as_id are mutually exclusive');
    // An Omi item that was heard contradicting a specific decision already knows
    // which one it replaces — the ingest recorded it. Default to that rather
    // than making the guard re-derive it.
    const heardAgainst = Number(card?.raw?.conflicts_with_decision_id);
    if (!supersedes_id && !same_as_id && Number.isInteger(heardAgainst) && heardAgainst > 0) {
      supersedes_id = heardAgainst;
      p.supersedes_from_omi = true;
    }
    if (supersedes_id) p.decision.supersedes_id = supersedes_id;
    if (same_as_id) p.decision.same_as_id = same_as_id;
  }

  // A build is filed only when the ruler asked for one. The recommendation's
  // rec_build_text is shown on the card as a prefill; it never files itself.
  if (input.build && input.build.description) {
    p.build = { description: String(input.build.description) };
  }

  // A flip of a two-sided ruling applies the other side in the same transaction.
  if (action === 'flip' && original) {
    const then = OPPOSITE[original.action] || null;
    if (then) {
      p.then_action = then;
      // The opposite side needs its own decision text (a reject saves the
      // proposal as-is; an approve saves what the card proposed).
      if (!p.decision) {
        const text = decisionTextFor(then, card, input);
        if (text) p.decision = { text, category: categoryFor(card, input), rationale: reason };
      }
    }
  }

  return { p, card, original, overrides, needs_reason: needsReason, verdict };
}

/** What applyRule would do, without touching anything. */
export async function planRule(input = {}, deps = {}) {
  const action = String(input.action || '').trim();
  if (action === 'recheck') {
    const mode = getRecommendMode(deps.env || process.env);
    return { dry_run: true, action, recommend_mode: mode, would: mode === 'off' ? 'nothing — MEMORY_RECOMMEND_MODE is off' : `re-run the recommendation for ${input.target?.table} #${input.target?.id}`, hint: 'add "confirm": true to run' };
  }
  if (BATCH_ACTIONS.has(action)) {
    try {
      const plan = buildBatchPlan(input, { now: deps.now || new Date() });
      return {
        dry_run: true,
        action,
        batch: true,
        verdict: plan.verdict ?? null,
        count: plan.count ?? null,
        targets: plan.p.targets ? plan.p.targets.map((t) => `${t.table} #${t.id}`) : null,
        batch_id: plan.p.batch_id ?? null,
        reason: plan.p.reason ?? null,
        would: plan.summary,
        refuses: action === 'batch_apply'
          ? `anything above ${BATCH_MAX}, any Rulings card, any confidence below high, a "fixed" with no proof, or a card edited since it was loaded`
          : 'a batch already reversed, or one whose rows have changed since it ran',
        hint: 'add "confirm": true to write',
      };
    } catch (err) {
      if (err instanceof RuleError) return { ok: false, code: err.code, error: err.message };
      throw err;
    }
  }

  try {
    const plan0 = await buildPlan(input, deps);
    if (plan0.lane) {
      return {
        dry_run: true,
        action: plan0.p.action,
        lane: true,
        target: `${plan0.p.target_table} #${plan0.p.target_id}`,
        card_type: plan0.p.target_table === 'claude_known_issues' ? 'stale_issue' : 'todo',
        ruled_by: plan0.p.ruled_by, via: plan0.p.via,
        session: plan0.p.session,
        proof: plan0.p.proof, assignee: plan0.p.assignee,
        recommendation: plan0.card?.rec_verdict ?? null,
        your_verdict: plan0.p.action,
        overrides_recommendation: plan0.overrides,
        reason: plan0.p.reason,
        would: plan0.summary,
        hint: 'add "confirm": true to write',
      };
    }
    const { p, card, original, overrides, verdict } = plan0;
    return {
      dry_run: true,
      action: p.action,
      target: `${p.target_table} #${p.target_id}`,
      card_type: card?.item_type || (p.target_table === 'claude_memory_conflicts' ? 'conflict' : 'decision'),
      ruled_by: p.ruled_by, via: p.via,
      session: p.session,
      decision: p.decision ? { text: p.decision.text.slice(0, 300), category: p.decision.category, supersedes_id: p.decision.supersedes_id ?? null, same_as_id: p.decision.same_as_id ?? null } : null,
      build: p.build ? p.build.description.slice(0, 200) : null,
      stage: p.stage, snooze_until: p.snooze_until,
      reverses: original ? { id: original.id, action: original.action, then_action: p.then_action ?? null } : null,
      recommendation: p.rec_verdict, your_verdict: verdict, overrides_recommendation: overrides,
      reason: p.reason,
      guard: WRITES_ACTIVE_DECISION.has(p.action) && !p.decision?.same_as_id
        ? 'the nearest active decision will be checked before this is written'
        : 'not applicable',
      hint: 'add "confirm": true to write',
    };
  } catch (err) {
    if (err instanceof RuleError) return { ok: false, code: err.code, error: err.message };
    throw err;
  }
}

/**
 * The conflict guard — the same one memory_checkpoint runs before a new
 * decision. Returns null when the ruling may proceed, or the blocking match.
 */
async function runRuleGuard(p, { db, embed, env, out }) {
  if (!WRITES_ACTIVE_DECISION.has(p.action) || !p.decision) return null;
  if (p.decision.same_as_id) return null;               // already says which one it re-confirms
  if (!embed || typeof db.rpc !== 'function') {
    out.guard = embed ? 'skipped: db.rpc unavailable' : 'skipped: OPENAI_API_KEY unset';
    return null;
  }
  const threshold = getConflictThreshold(env);
  let hits = [];
  try {
    const q = await embed(decisionText({ category: p.decision.category, decision: p.decision.text, rationale: p.decision.rationale }));
    const res = await db.rpc('match_memory_embeddings', {
      query_embedding: q.embedding, match_threshold: threshold, match_count: 5,
      filter_area: null, filter_kind: 'decision', include_closed: false,
    });
    if (res?.error) throw new Error(res.error.message);
    hits = (res?.data || [])
      .filter((h) => String(h.status || 'active') === 'active')
      .filter((h) => typeof h.similarity === 'number' && h.similarity >= threshold)
      // The decision this ruling already says it replaces is not a surprise.
      .filter((h) => Number(h.source_id) !== Number(p.decision.supersedes_id));
  } catch (err) {
    out.guard = `skipped: ${err.message}`;
    return null;
  }
  out.guard = 'ran';
  if (!hits.length || p.decision.supersedes_id) return null;
  const top = hits[0];
  return { id: Number(top.source_id), text: String(top.text || '').slice(0, 240), similarity: Number(top.similarity.toFixed(3)) };
}

/**
 * Apply one ruling. Returns the RPC result on success, or
 * { ok:false, code, ... } for anything the caller can act on — a stale card, a
 * guard conflict, a missing reason.
 */
export async function applyRule(input = {}, { db = supabase, now = new Date(), env = process.env, embed } = {}) {
  if (!db) return { ok: false, code: 'error', error: 'Supabase client not configured' };

  if (String(input.action || '').trim() === 'recheck') {
    const mode = getRecommendMode(env);
    if (mode === 'off') return { ok: false, code: 'recommend_off', error: 'MEMORY_RECOMMEND_MODE is off — set it to shadow or live to re-check a card' };
    const table = input.target?.table; const id = Number(input.target?.id);
    if (!RULABLE_TABLES.has(String(table)) || !Number.isInteger(id)) return { ok: false, code: 'bad_input', error: 'recheck needs target { table, id }' };
    const { recommendOne } = await import('../jobs/memory-recommend.js');
    const rec = await recommendOne(table, id, { db, env, mode });
    return { ok: true, rec };
  }

  // ── Batch passes (sql/112). One transaction, one batch_id, one log row per
  // item — claude_rule_batch owns all of that, including the refusals. There is
  // no guard call here because a batch never writes a decision.
  if (BATCH_ACTIONS.has(String(input.action || '').trim())) {
    let batchPlan;
    try {
      batchPlan = buildBatchPlan(input, { now });
    } catch (err) {
      if (err instanceof RuleError) return { ok: false, code: err.code, error: err.message };
      throw err;
    }
    const fn = batchPlan.action === 'batch_undo' ? 'claude_rule_batch_undo' : 'claude_rule_batch';
    const args = batchPlan.action === 'batch_undo'
      ? { p_batch_id: batchPlan.p.batch_id, p_reason: batchPlan.p.reason, p_ruled_by: batchPlan.p.ruled_by }
      : { p: batchPlan.p };
    const res = await db.rpc(fn, args);
    if (res?.error) return { ok: false, code: codeOf(res.error.message), message: res.error.message };
    const data = (Array.isArray(res?.data) ? res.data[0] : res?.data) || {};
    return { ...data, ok: data.ok !== false, summary: batchPlan.summary };
  }

  const out = { guard: null };
  let plan;
  try {
    plan = await buildPlan(input, { db, now, env });
  } catch (err) {
    if (err instanceof RuleError) return { ok: false, code: err.code, error: err.message };
    throw err;
  }

  // ── A single lane verdict. Its own writer, because Release 1's rejects
  // claude_known_issues and every verdict outside its own list. No decision is
  // written, so the duplicate-decision guard below does not apply.
  if (plan.lane) {
    const res = await db.rpc('claude_rule_lane_apply', { p: plan.p });
    if (res?.error) return { ok: false, code: codeOf(res.error.message), message: res.error.message };
    const data = (Array.isArray(res?.data) ? res.data[0] : res?.data) || {};
    return {
      ...data, ok: data.ok !== false, summary: plan.summary,
      overrode_recommendation: plan.overrides,
    };
  }

  const { p } = plan;

  const embedFn = embed === undefined ? await defaultEmbed(env) : embed;
  const match = await runRuleGuard(p, { db, embed: embedFn, env, out });
  if (match) {
    return {
      ok: false, code: 'guard_conflict', match,
      message: `This looks like decision #${match.id} (${Math.round(match.similarity * 100)}% match). Replace it, or say it is the same thing.`,
      resend_with: { supersedes_id: match.id, same_as_id: match.id },
    };
  }

  const res = await db.rpc('claude_rule_apply', { p });
  if (res?.error) {
    const code = codeOf(res.error.message);
    return { ok: false, code, message: res.error.message, guard: out.guard };
  }
  const data = res?.data || {};
  const result = { ...data, ok: data.ok !== false, guard: out.guard, overrode_recommendation: plan.overrides };
  if (p.supersedes_from_omi) result.supersedes_from_omi = p.decision?.supersedes_id ?? null;

  // Best effort: get the new decision into the vector index now, so a
  // memory_precheck five minutes later already finds it. Never fatal — the
  // nightly re-embed is the real guarantee.
  const newIds = [data.decision_id, data.then?.decision_id].filter((n) => Number.isInteger(n));
  if (newIds.length) {
    try {
      const m = await import('./memory-embed.js');
      const plan2 = await m.planKind('decision', {});
      const todo = plan2.todo.filter((r) => newIds.includes(Number(r.source_id)));
      if (todo.length) await m.executePlan({ ...plan2, todo }, { log: () => {} });
      result.embedded = todo.length;
    } catch (err) {
      result.embedded = 0;
      result.embed_note = `deferred to the nightly: ${err.message}`;
    }
  }

  // A ruling that filed a build to-do also puts it on Mark's Omi Tasks page,
  // when write-back is on. Best effort and never awaited into the ruling's
  // success: the ruling wrote a decision and filed the work, which is the job.
  // Omi hearing about the follow-up is a convenience, and an Omi outage must
  // not turn a completed ruling into an error on Mark's screen.
  const buildId = Number.isInteger(data.build_item_id) ? data.build_item_id : null;
  if (buildId) {
    try {
      const { pushRulingBuildItem } = await import('./omi-tasks.js');
      result.omi_task = await pushRulingBuildItem(buildId, { deps: { env } });
    } catch (err) {
      result.omi_task = { skipped: err.message };
    }
  }
  return result;
}

export default {
  planRule, applyRule, RULE_ACTIONS, stripOmiPrefix, verdictFor, sessionIdentity,
  LANE_ACTIONS, BATCH_ACTIONS, BATCH_MAX, buildBatchPlan, laneSummary,
};
