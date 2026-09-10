/**
 * Memory Checkpoint — src/memory/memory-checkpoint.js
 *
 * One call writes everything the reece-session-continuity skill (v4) writes at
 * session end, in the same shape: the session row is the timeline (JSON fact
 * columns stay []), decisions / issues / pending items go to their own tables
 * with the session's transcript_search_keys copied onto each decision.
 * With `session_id` set it is a REFRESH / mid-session checkpoint: the session
 * row is UPDATEd (keys unioned, summary replaced, link never downgraded) and
 * new facts are appended — it never inserts a second session for a chat.
 *
 * `db` is injected so scripts/test-memory-checkpoint.js runs without env.
 *
 * TRANSPORT RETRY (issue #1627, v1.1): the write sequence runs under
 * withRetry — 3 attempts, 250 ms / 1 s / 3 s — for transient errors only
 * (network, ECONNRESET, 5xx, "fetch failed"). Validation errors and 4xx are
 * never retried. The sequence is idempotent on retry:
 *   - the session INSERT carries a `checkpoint_key` (column
 *     claude_session_logs.checkpoint_key UNIQUE, sql/096); a retry after the
 *     insert landed but the response was lost finds the row by key and
 *     UPDATEs it instead of inserting a second session;
 *   - every other step checks the progress object (`out`) before writing, so
 *     rows that already landed are skipped, not duplicated.
 * On final failure the error carries `partial` (everything that did land) so
 * the calling skill can fall back to SQL without re-creating it.
 *
 * DETERMINISTIC KEY (sql/099, v2.1). The in-call retry above only covered
 * retries inside ONE tool call. When the transport drops the RESPONSE, Claude
 * re-sends the whole checkpoint as a BRAND NEW call — which used to mint a new
 * random key and insert a twin session (17 duplicate pairs by 2026-09-09).
 * The key is now a sha256 of the checkpoint's identity instead:
 *
 *     surface | session_date | normalized(title)
 *
 * normalized = whitespace collapsed, trimmed, lowercased. The SUMMARY is
 * deliberately excluded — a retry may re-generate slightly different prose and
 * must still collide. checkpointKeyFor() below is the single definition;
 * sql/099's claude_checkpoint_key() mirrors it for the backfill.
 * So every new-session write now looks the row up by key FIRST: found = refresh
 * (keys union, summary replaced, chat_url never nulled, 'exact' never
 * downgraded), not found = insert. A lost race on the unique index is caught
 * (23505) and turned into the same refresh. `inserted` in the result says which
 * happened, so the reply after a dropped response tells the truth.
 * Children are deduped the same way — see loadExistingChildren().
 *
 * PROVENANCE GUARD (sql/098, v2.0). A memory row must prove where it came
 * from before it is allowed in:
 *   mode 'live'   (default) the caller is inside the chat. `date` must be the
 *                 date on the chat's first message; a date in the future or
 *                 more than MEMORY_MAX_DATE_AGE_DAYS (400) back is rejected.
 *   mode 'retro'  the caller reconstructed the chat from search. `source`
 *                 { chat_url, chat_title, chat_updated_at } is REQUIRED;
 *                 log_origin is forced to 'retro', session_date =
 *                 chat_updated_at::date (ET), link_confidence 'exact', the
 *                 ledger row (disposition 'retro_written') is written in the
 *                 same sequence, decisions default confidence 'reconstructed'
 *                 unless the payload marks a Mark quote (confirmed_by_mark).
 *   MEMORY_GUARD_MODE (off | shadow | live; code default shadow) governs the
 *   two data-dependent checks:
 *     batch pattern   3+ live checkpoints in the last 5 minutes = a sweep, not
 *                     a session. shadow: logged to claude_memory_validation_log
 *                     and written (the sql/098 trigger relabels it retro /
 *                     write_date / flagged); live: rejected — use mode retro.
 *     conflict rule   a new decision whose nearest ACTIVE decision (vector
 *                     cosine ≥ MEMORY_CONFLICT_THRESHOLD, 0.85) is not named
 *                     by supersedes_id or same_as_id. shadow: logged, written;
 *                     live: rejected with the matching decision id. The check
 *                     is skipped (never blocks) when OPENAI_API_KEY is unset or
 *                     the embed call fails.
 *   same_as_id     the decision is NOT inserted; the existing row gets
 *                  verified_at + verification_note instead (a re-confirmation).
 *
 * v1.0 — 2026-09-06. Initial (priority #8).
 * v1.1 — 2026-09-06. checkpoint_key idempotency + withRetry (#1627).
 * v1.2 — 2026-09-07. session.date_confidence ('exact' | 'write_date', sql/097).
 * v2.0 — 2026-09-08. mode retro, date sanity, MEMORY_GUARD_MODE, conflict rule (sql/098).
 * v2.1 — 2026-09-09. Deterministic checkpoint_key + idempotent children (sql/099).
 */
import { createHash } from 'node:crypto';
import supabase from '../supabase.js';
import { withRetry, CHECKPOINT_RETRY } from './with-retry.js';

const SURFACES = new Set(['chat', 'cowork', 'code', 'n8n']);
const MODES = new Set(['live', 'retro']);
// sql/097: 'exact' = session.date is the real date of the work; 'write_date' =
// it is only the date the checkpoint was written (retro sweeps). The pack
// demotes write_date sessions so a session start opens on real work.
const DATE_CONFIDENCE = new Set(['exact', 'write_date']);
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const ISSUE_TYPES = new Set(['defect', 'initiative', 'metric']);
const PENDING_KINDS = new Set(['pending', 'next_step']);
const PENDING_TYPES = new Set(['action_needed', 'decision_needed', 'verification_needed', 'open_question', 'build_needed', 'next_step', 'unconfirmed_decision']);
const CLOSE_STATUSES = new Set(['done', 'dropped', 'superseded', 'blocked', 'deferred', 'ratified']);

export const GUARD_MODES = new Set(['off', 'shadow', 'live']);
export const RETRO_SOURCE_MESSAGE = 'retro session requires chat_url and source_chat_updated_at';
export const RETRO_PREFIX_RE = /^\s*\[RETRO/i;
const BATCH_WINDOW_MINUTES = 5;
const BATCH_LIMIT = 3;

export class CheckpointError extends Error {}

// ─── Deterministic identity (sql/099) ──────────────────────────────────────
// Whitespace (including nbsp and a stray BOM) collapsed to single spaces,
// trimmed, lowercased. The same class is used in sql/099's regexp_replace, so
// the two definitions agree byte for byte.
const WS_RE = /[\s\u00a0\ufeff]+/g;

/** Normalize free text for identity comparison. Not for display. */
export function normText(v) {
  return String(v ?? '').replace(WS_RE, ' ').trim().toLowerCase();
}

/**
 * The checkpoint's identity key: sha256 of surface|session_date|normalized
 * title. Two calls describing the same session — a transport-drop retry above
 * all — produce the same key, so the second one refreshes instead of inserting
 * a twin. MUST stay identical to claude_checkpoint_key() in sql/099.
 */
export function checkpointKeyFor({ surface, date, title } = {}) {
  const s = String(surface ?? '').trim() || 'chat';
  return createHash('sha256').update(`${s}|${date ?? ''}|${normText(title)}`).digest('hex');
}

/** MEMORY_GUARD_MODE: off | shadow (default) | live. */
export function getGuardMode(env = process.env) {
  const m = String(env.MEMORY_GUARD_MODE || 'shadow').toLowerCase().trim();
  return GUARD_MODES.has(m) ? m : 'shadow';
}
/** MEMORY_CONFLICT_THRESHOLD with a code default of 0.85 so it can be tuned without a deploy. */
export function getConflictThreshold(env = process.env) {
  const t = parseFloat(env.MEMORY_CONFLICT_THRESHOLD);
  return Number.isFinite(t) && t > 0 && t <= 1 ? t : 0.85;
}
export function getMaxDateAgeDays(env = process.env) {
  const n = parseInt(env.MEMORY_MAX_DATE_AGE_DAYS, 10);
  return Number.isFinite(n) && n > 0 ? n : 400;
}

function str(v, name, { required = false, max = 20000 } = {}) {
  if (v == null || v === '') { if (required) throw new CheckpointError(`${name} is required`); return null; }
  if (typeof v !== 'string') throw new CheckpointError(`${name} must be a string`);
  return v.slice(0, max);
}
function isoDate(v, name, fallback) {
  if (v == null || v === '') return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new CheckpointError(`${name} must be YYYY-MM-DD`);
  return String(v);
}
function dateET(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function todayET(now = new Date()) { return dateET(now); }
function daysBetween(a, b) { return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000); }

function parseTimestamp(v, name) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new CheckpointError(`${name} must be an ISO timestamp`);
  return d;
}

/** Validate and normalise the payload. Throws CheckpointError on bad input. */
export function validateCheckpoint(input = {}, now = new Date(), env = process.env) {
  const today = todayET(now);
  const mode = input.mode == null || input.mode === '' ? 'live' : String(input.mode).toLowerCase().trim();
  if (!MODES.has(mode)) throw new CheckpointError(`mode must be one of ${[...MODES].join(', ')}`);
  const sessionId = input.session_id == null ? null : Number(input.session_id);
  if (input.session_id != null && (!Number.isInteger(sessionId) || sessionId < 1)) throw new CheckpointError('session_id must be a positive integer');
  if (mode === 'retro' && sessionId) throw new CheckpointError('retro mode creates a new session — refresh an existing one with mode live and session_id');
  const s = input.session || {};
  const keys = Array.isArray(s.search_keys) ? s.search_keys.map((k) => String(k).trim()).filter(Boolean) : [];
  if (!sessionId && keys.length < 3) throw new CheckpointError('session.search_keys needs at least 3 verbatim keys for a new session');
  if (keys.length > 12) throw new CheckpointError('session.search_keys: keep it under 12');
  const surface = s.surface ? String(s.surface).toLowerCase() : 'chat';
  if (!SURFACES.has(surface)) throw new CheckpointError(`session.surface must be one of ${[...SURFACES].join(', ')}`);
  const dateConfidenceGiven = s.date_confidence != null && s.date_confidence !== '';
  let date_confidence = dateConfidenceGiven ? String(s.date_confidence).toLowerCase() : 'exact';
  if (!DATE_CONFIDENCE.has(date_confidence)) throw new CheckpointError(`session.date_confidence must be one of ${[...DATE_CONFIDENCE].join(', ')}`);

  // Retro source — the row must say where it came from (sql/098 guard message).
  let source = null;
  if (mode === 'retro') {
    const src = input.source || {};
    const chat_url = str(src.chat_url, 'source.chat_url', { max: 500 });
    const chat_updated_at = parseTimestamp(src.chat_updated_at, 'source.chat_updated_at');
    if (!chat_url || !chat_updated_at) {
      throw new CheckpointError(`${RETRO_SOURCE_MESSAGE} — pass source.chat_url and source.chat_updated_at from the search result`);
    }
    source = { chat_url, chat_title: str(src.chat_title, 'source.chat_title', { max: 300 }), chat_updated_at: chat_updated_at.toISOString() };
    date_confidence = 'exact';
  }

  const date = mode === 'retro' ? dateET(new Date(source.chat_updated_at)) : isoDate(s.date, 'session.date', today);
  // Date sanity — a new session's date is the date the work happened.
  if (!sessionId || s.date) {
    const maxAge = getMaxDateAgeDays(env);
    if (date > today) throw new CheckpointError(`session.date ${date} is in the future (today ET is ${today}) — use the date on the chat's first message`);
    if (daysBetween(date, today) > maxAge) throw new CheckpointError(`session.date ${date} is more than ${maxAge} days back — check the chat's first message date, or pass date_confidence 'write_date' with today's date`);
  }

  const session = {
    title: str(s.title, 'session.title', { required: !sessionId, max: 300 }),
    date, date_confidence, date_confidence_given: dateConfidenceGiven || mode === 'retro',
    phase_focus: str(s.phase_focus, 'session.phase_focus', { max: 120 }),
    summary: str(s.summary, 'session.summary', { required: !sessionId }),
    search_keys: keys, surface,
    chat_url: source ? source.chat_url : str(s.chat_url, 'session.chat_url', { max: 500 }),
    chat_title: source ? (source.chat_title ?? str(s.chat_title, 'session.chat_title', { max: 300 })) : str(s.chat_title, 'session.chat_title', { max: 300 }),
    workflows_touched: Array.isArray(s.workflows_touched) ? s.workflows_touched : [],
    mcp_verified_ids: Array.isArray(s.mcp_verified_ids) ? s.mcp_verified_ids : [],
  };
  if (mode === 'retro' && session.summary && !RETRO_PREFIX_RE.test(session.summary)) {
    session.summary = `[RETRO — reconstructed from transcript on ${today}. Decisions unconfirmed by Mark are marked inferred.] ${session.summary}`;
  }

  const decisions = (input.decisions || []).map((d, i) => {
    const supersedes_id = d.supersedes_id == null ? null : Number(d.supersedes_id);
    const same_as_id = d.same_as_id == null ? null : Number(d.same_as_id);
    if (supersedes_id && same_as_id) throw new CheckpointError(`decisions[${i}]: supersedes_id and same_as_id are mutually exclusive`);
    for (const [k, v] of [['supersedes_id', supersedes_id], ['same_as_id', same_as_id]]) {
      if (v != null && (!Number.isInteger(v) || v < 1)) throw new CheckpointError(`decisions[${i}].${k} must be a positive integer`);
    }
    return {
      category: str(d.category, `decisions[${i}].category`, { required: true, max: 40 }),
      decision: str(d.decision, `decisions[${i}].decision`, { required: true }),
      rationale: str(d.rationale, `decisions[${i}].rationale`),
      options: Array.isArray(d.options) ? d.options.map(String) : [],
      workflow_code: str(d.workflow_code, `decisions[${i}].workflow_code`, { max: 20 }),
      supersedes_id, same_as_id,
      confirmed_by_mark: d.confirmed_by_mark === true,
    };
  });
  const issues = (input.issues || []).map((x, i) => {
    const severity = String(x.severity || '').toLowerCase();
    if (!SEVERITIES.has(severity)) throw new CheckpointError(`issues[${i}].severity must be critical|high|medium|low`);
    const issue_type = x.issue_type ? String(x.issue_type).toLowerCase() : 'defect';
    if (!ISSUE_TYPES.has(issue_type)) throw new CheckpointError(`issues[${i}].issue_type must be defect|initiative|metric`);
    return {
      severity, issue_type,
      category: str(x.category, `issues[${i}].category`, { required: true, max: 40 }),
      description: str(x.description, `issues[${i}].description`, { required: true }),
      impact: str(x.impact, `issues[${i}].impact`),
      fix_instructions: str(x.fix_instructions, `issues[${i}].fix_instructions`),
      workflow_code: str(x.workflow_code, `issues[${i}].workflow_code`, { max: 20 }),
      workflow_name: str(x.workflow_name, `issues[${i}].workflow_name`, { max: 200 }),
    };
  });
  const resolved_issues = (input.resolved_issues || []).map((r, i) => ({
    id: Number(r.id), note: str(r.verification_note, `resolved_issues[${i}].verification_note`, { required: true, max: 500 }),
  }));
  const verified_issues = (input.verified_issues || []).map((r, i) => ({
    id: Number(r.id), note: str(r.verification_note, `verified_issues[${i}].verification_note`, { required: true, max: 500 }),
  }));
  const pending = (input.pending || []).map((p, i) => {
    const kind = String(p.kind || 'pending').toLowerCase();
    if (!PENDING_KINDS.has(kind)) throw new CheckpointError(`pending[${i}].kind must be pending|next_step`);
    const item_type = String(p.item_type || (kind === 'next_step' ? 'next_step' : 'action_needed')).toLowerCase();
    if (!PENDING_TYPES.has(item_type)) throw new CheckpointError(`pending[${i}].item_type invalid`);
    return {
      kind, item_type,
      description: str(p.description, `pending[${i}].description`, { required: true }),
      priority: p.priority == null ? null : Number(p.priority),
      effort: str(p.effort, `pending[${i}].effort`, { max: 100 }),
      blocked_by: str(p.blocked_by, `pending[${i}].blocked_by`, { max: 300 }),
      ref: str(p.ref, `pending[${i}].ref`, { max: 200 }),
      owner: str(p.owner, `pending[${i}].owner`, { max: 100 }),
    };
  });
  const close_pending = (input.close_pending || []).map((c, i) => {
    const status = String(c.status || 'done').toLowerCase();
    if (!CLOSE_STATUSES.has(status)) throw new CheckpointError(`close_pending[${i}].status invalid`);
    return { id: Number(c.id), status };
  });
  for (const list of [resolved_issues, verified_issues, close_pending]) {
    for (const r of list) if (!Number.isInteger(r.id) || r.id < 1) throw new CheckpointError('ids must be positive integers');
  }
  return { mode, source, session_id: sessionId, session, decisions, issues, resolved_issues, verified_issues, pending, close_pending, today };
}

function must(res, what) {
  if (res.error) {
    const e = res.error;
    const detail = e.details && !String(e.message || '').includes(e.details) ? ` (${e.details})` : '';
    const err = new Error(`${what}: ${e.message}${detail}`);
    if (res.status) err.status = res.status;
    if (e.code) err.code = e.code;
    if (e.details) err.details = e.details;
    throw err;
  }
  return res.data;
}

/** Text a decision is embedded as (mirrors memory-text.js memoryText('decision')). */
export function decisionText(d) {
  return [`Decision (${d.category || 'uncategorized'}): ${d.decision || ''}`, d.rationale ? `Rationale: ${d.rationale}` : '']
    .filter(Boolean).join('\n');
}

/** Best-effort row in claude_memory_validation_log (sql/098). Never throws — the table may predate the migration. */
async function logGuard(db, row) {
  try {
    const res = await db.from('claude_memory_validation_log').insert({
      check_name: row.check_name, mode: row.mode, rows_checked: row.rows_checked ?? null,
      rows_flagged: row.rows_flagged ?? null, sample: row.sample ?? null, notes: row.notes ?? null,
    });
    if (res?.error) console.warn(`[MemoryCheckpoint] guard log skipped: ${res.error.message}`);
  } catch (err) { console.warn(`[MemoryCheckpoint] guard log skipped: ${err.message}`); }
}

/**
 * Guard checks that need the database. Runs ONCE before the first write.
 * Returns { checks: [...] }; throws CheckpointError in live mode.
 */
async function runGuard(c, { db, now, env, guard, embed, threshold, out }) {
  const checks = [];
  if (guard === 'off') return checks;

  // 1. Batch pattern — a live session dated today, arriving in a burst.
  if (c.mode === 'live' && !c.session_id && c.session.date === c.today) {
    let recent = 0;
    try {
      const since = new Date(now.getTime() - BATCH_WINDOW_MINUTES * 60_000).toISOString();
      const res = await db.from('claude_session_logs').select('id', { count: 'exact', head: true }).eq('log_origin', 'live').gte('created_at', since);
      recent = Number(res?.count ?? (Array.isArray(res?.data) ? res.data.length : 0)) || 0;
    } catch (err) { checks.push({ check: 'batch_pattern', skipped: err.message }); }
    if (recent >= BATCH_LIMIT) {
      const entry = { check: 'batch_pattern', live_rows_last_5_min: recent, would: 'reject' };
      checks.push(entry);
      await logGuard(db, { check_name: 'guard:batch_pattern', mode: guard, rows_checked: recent, rows_flagged: 1, sample: { title: c.session.title, surface: c.session.surface }, notes: guard === 'live' ? 'rejected' : 'written; trigger relabels retro/write_date' });
      if (guard === 'live') throw new CheckpointError(`${recent} live checkpoints already written in the last ${BATCH_WINDOW_MINUTES} minutes — this looks like a batch pass, not a session. Use mode "retro" with source.chat_url and source.chat_updated_at.`);
    }
  }

  // 2. Conflict rule — nearest ACTIVE decision on the same subject must be named.
  const candidates = c.decisions.map((d, i) => ({ d, i })).filter(({ d }) => !d.supersedes_id && !d.same_as_id);
  if (candidates.length) {
    const canEmbed = typeof embed === 'function' && typeof db.rpc === 'function';
    if (!canEmbed) {
      out.conflict_check = embed ? 'skipped: db.rpc unavailable' : 'skipped: OPENAI_API_KEY unset';
    } else {
      for (const { d, i } of candidates) {
        let hits = [];
        try {
          const q = await embed(decisionText(d));
          const res = await db.rpc('match_memory_embeddings', {
            query_embedding: q.embedding, match_threshold: threshold, match_count: 5,
            filter_area: null, filter_kind: 'decision', include_closed: false,
          });
          if (res?.error) throw new Error(res.error.message);
          hits = (res?.data || []).filter((h) => String(h.status || 'active') === 'active' && typeof h.similarity === 'number' && h.similarity >= threshold);
        } catch (err) {
          out.conflict_check = `skipped: ${err.message}`;
          checks.push({ check: 'conflict', decision_index: i, skipped: err.message });
          continue;
        }
        if (!hits.length) continue;
        const top = hits[0];
        const entry = { check: 'conflict', decision_index: i, matches: hits.slice(0, 3).map((h) => ({ id: h.source_id, similarity: Number(h.similarity.toFixed(3)), area: h.area, text: String(h.text || '').slice(0, 120) })), would: 'reject' };
        checks.push(entry);
        await logGuard(db, { check_name: 'guard:conflict', mode: guard, rows_checked: hits.length, rows_flagged: 1, sample: { decision: d.decision.slice(0, 200), nearest: entry.matches }, notes: guard === 'live' ? 'rejected' : 'written without supersedes_id/same_as_id' });
        if (guard === 'live') {
          throw new CheckpointError(`decisions[${i}] matches active decision #${top.source_id} (cosine ${top.similarity.toFixed(2)}): pass supersedes_id: ${top.source_id} to replace it or same_as_id: ${top.source_id} to re-confirm it`);
        }
      }
      if (!out.conflict_check) out.conflict_check = 'ran';
    }
  }
  return checks;
}

async function defaultEmbed(env = process.env) {
  if (!env.OPENAI_API_KEY) return null;
  const m = await import('../knowledge/openai-embeddings.js');
  return m.embed;
}

/**
 * Write the checkpoint. Returns ids — including `inserted`: true when a new
 * session row was created, false when an existing one was refreshed (a retry
 * after a dropped response, or an explicit session_id). `db` defaults to the LP
 * Supabase client.
 *   checkpoint_key  override the identity key. Normally omitted: it is derived
 *                   from surface|session_date|title (sql/099) so a re-send of
 *                   the same checkpoint finds its own row instead of inserting
 *                   a second session.
 *   retry           { attempts, backoffMs, sleep } or false to disable.
 *   env             for MEMORY_GUARD_MODE / MEMORY_CONFLICT_THRESHOLD (tests).
 *   embed           (text) => { embedding } — injected in tests; defaults to
 *                   the OpenAI client when OPENAI_API_KEY is set, else the
 *                   conflict check is skipped.
 * Throws with `err.partial` = progress so far when the write fails.
 */
export async function applyCheckpoint(input, { db = supabase, now = new Date(), checkpoint_key = null, retry = CHECKPOINT_RETRY, env = process.env, embed, guardMode } = {}) {
  if (!db) throw new Error('Supabase client not configured');
  const c = validateCheckpoint(input, now, env); // validation errors surface before any retry
  // sql/099: identity, not randomness. An explicit key still wins so an older
  // caller holding a partial.checkpoint_key can resume that exact row.
  const key = checkpoint_key ? String(checkpoint_key) : checkpointKeyFor({ surface: c.session.surface, date: c.session.date, title: c.session.title });
  const guard = guardMode || getGuardMode(env);
  const out = {
    session_id: null, checkpoint_key: key, mode: c.mode, inserted: false, updated: false, recovered: false, raced: false, attempts: 0,
    guard: { mode: guard, checks: [] }, conflict_check: null,
    decision_ids: [], issue_ids: [], pending_ids: [], resolved: [], verified: [], closed: [], superseded: [], confirmed: [], ledger: null,
    deduped: { decisions: 0, issues: 0, pending: 0 },
  };
  const embedFn = embed === undefined ? await defaultEmbed(env) : embed;
  out.guard.checks = await runGuard(c, { db, now, env, guard, embed: embedFn, threshold: getConflictThreshold(env), out });
  const step = (attempt) => { out.attempts = attempt; return writeCheckpoint(c, { db, now, key, out, resume: attempt > 1 }); };
  try {
    if (retry === false) await step(1);
    else await withRetry(step, { ...retry, onRetry: (err, attempt, delay) => console.warn(`[MemoryCheckpoint] attempt ${attempt} failed (${err.message}) — retry in ${delay}ms; session_id=${out.session_id ?? 'none yet'}`) });
  } catch (err) {
    err.partial = partialOf(out);
    throw err;
  }
  return out;
}

function partialOf(out) {
  const p = { checkpoint_key: out.checkpoint_key, attempts: out.attempts, mode: out.mode };
  if (out.session_id) { p.session_id = out.session_id; p.updated = out.updated; p.inserted = out.inserted; }
  for (const k of ['decision_ids', 'issue_ids', 'pending_ids', 'resolved', 'verified', 'closed', 'superseded', 'confirmed']) if (out[k].length) p[k] = [...out[k]];
  if (out.ledger) p.ledger = out.ledger;
  return p;
}

const EMPTY_CHILDREN = Object.freeze({ decisions: new Map(), issues: new Map(), pending: new Map() });

/** normalized text -> existing row id, for the children still live on a session. */
function indexByText(rows, textCol, isLive) {
  const m = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!isLive(r)) continue;
    const k = normText(r[textCol]);
    if (k && !m.has(k)) m.set(k, r.id);
  }
  return m;
}

/**
 * What is already on this session, so a re-sent checkpoint appends nothing
 * twice. Scoped to live rows only (mirrors the sql/099 partial indexes): an
 * item that was closed and is later legitimately re-raised is not blocked.
 */
async function loadExistingChildren(db, sid) {
  const dec = must(await db.from('claude_decision_log').select('id, decision, status').eq('session_id', sid), 'existing decisions');
  const iss = must(await db.from('claude_known_issues').select('id, description, status').eq('reported_session_id', sid), 'existing issues');
  const pen = must(await db.from('claude_pending_items').select('id, description, status').eq('source_session_id', sid), 'existing pending');
  return {
    decisions: indexByText(dec, 'decision', (r) => (r.status ?? 'active') === 'active'),
    issues: indexByText(iss, 'description', (r) => ['open', 'in_progress'].includes(r.status ?? 'open')),
    pending: indexByText(pen, 'description', (r) => (r.status ?? 'open') === 'open'),
  };
}

/** One attempt. Every step is guarded by `out`, so a re-run only does what has not landed yet. */
async function writeCheckpoint(c, { db, now, key, out, resume }) {
  const nowIso = now.toISOString();
  const retro = c.mode === 'retro';

  // 1. Session row — UPDATE the named one, else the one that already owns this
  //    identity key, else INSERT. The key is deterministic (sql/099), so a
  //    re-sent checkpoint after a dropped response resolves to its own row here
  //    and refreshes it instead of inserting a twin session (#1627).
  const SESSION_COLS = 'id, transcript_search_keys, link_confidence, chat_url, log_origin';
  let keys = c.session.search_keys;
  let sessionId = c.session_id;
  let cur = null;

  /** Refresh an existing session: keys union, link never downgraded, url never nulled. */
  const refresh = async (id, row) => {
    keys = [...new Set([...(Array.isArray(row?.transcript_search_keys) ? row.transcript_search_keys : []), ...keys])].slice(0, 12);
    const patch = { transcript_search_keys: keys, updated_at: nowIso };
    if (c.session.summary) patch.raw_summary = c.session.summary;
    if (c.session.title) patch.session_title = c.session.title;
    if (c.session.phase_focus) patch.phase_focus = c.session.phase_focus;
    // Only an explicit value changes an existing row — a refresh that omits it
    // must not reset a 'write_date' session back to the default.
    if (c.session.date_confidence_given) patch.date_confidence = c.session.date_confidence;
    // A nightly draft that Mark refreshes from inside the chat becomes a real session.
    if (row?.log_origin === 'nightly') { patch.log_origin = retro ? 'retro' : 'live'; patch.validation_status = 'passed'; }
    if (c.session.chat_url && row?.link_confidence !== 'exact') {
      patch.chat_url = c.session.chat_url; patch.chat_title = c.session.chat_title; patch.link_confidence = 'exact';
    }
    must(await db.from('claude_session_logs').update(patch).eq('id', id), 'update session');
    out.session_id = id; out.updated = true; out.inserted = false; out.keys = keys;
  };

  if (out.session_id) {
    keys = out.keys || keys;
  } else {
    if (!sessionId) {
      cur = must(await db.from('claude_session_logs').select(SESSION_COLS).eq('checkpoint_key', key).maybeSingle(), 'find session by key');
      // `resume` distinguishes the two ways this hits: an earlier ATTEMPT of
      // this same call landed the insert and lost the response (recovered), or
      // an earlier CALL wrote the session and this is a plain refresh.
      if (cur?.id) { sessionId = cur.id; if (resume) out.recovered = true; } else cur = null;
    }
    if (sessionId) {
      if (!cur) cur = must(await db.from('claude_session_logs').select(SESSION_COLS).eq('id', sessionId).maybeSingle(), 'load session');
      if (!cur) throw new CheckpointError(`session ${sessionId} not found`);
      await refresh(sessionId, cur);
    } else {
      const row = {
        session_date: c.session.date, session_title: c.session.title, phase_focus: c.session.phase_focus,
        workflows_touched: c.session.workflows_touched, phase_status: {}, decisions_made: [], issues_found: [],
        issues_resolved: [], pending_items: [], board_versions: [], mcp_verified_ids: c.session.mcp_verified_ids,
        next_steps: [], raw_summary: c.session.summary, chat_url: c.session.chat_url, chat_title: c.session.chat_title,
        transcript_search_keys: keys, surface: c.session.surface, log_origin: retro ? 'retro' : 'live',
        link_confidence: c.session.chat_url ? 'exact' : 'unlinked', checkpoint_key: key,
        date_confidence: c.session.date_confidence,
      };
      if (retro) row.source_chat_updated_at = c.source.chat_updated_at; // sql/098 column; only sent for retro rows
      try {
        const ins = must(await db.from('claude_session_logs').insert(row).select('id').single(), 'insert session');
        out.session_id = ins.id; out.inserted = true; out.keys = keys;
      } catch (err) {
        // Lost the race on the unique key: a concurrent call inserted this same
        // identity between our lookup and our insert. That IS the fix working —
        // adopt their row and refresh it rather than failing the checkpoint.
        if (String(err.code) !== '23505') throw err;
        const won = must(await db.from('claude_session_logs').select(SESSION_COLS).eq('checkpoint_key', key).maybeSingle(), 'find session after key conflict');
        if (!won?.id) throw err;
        out.raced = true;
        await refresh(won.id, won);
      }
    }
  }
  const sid = out.session_id;

  // Children are only idempotent if we check: when this call did NOT create the
  // session row, an earlier call may already have written these very decisions,
  // issues and pending items under it. Skipping by normalized text mirrors the
  // partial unique indexes in sql/099 section E (which are the backstop under a
  // race); the lookup is one query per table, not one per item.
  const existing = out.inserted ? EMPTY_CHILDREN : await loadExistingChildren(db, sid);

  // 2. Decisions (+ supersede / re-confirm).
  for (let i = 0; i < c.decisions.length; i++) {
    const d = c.decisions[i];
    if (d.same_as_id) {
      // Not a second active decision on the same subject: re-confirm the existing one.
      if (!out.confirmed.includes(d.same_as_id)) {
        must(await db.from('claude_decision_log').update({
          verified_at: nowIso, verification_note: `re-confirmed in session #${sid} (${c.today})${retro ? ' [retro]' : ''}`,
        }).eq('id', d.same_as_id), 'confirm decision');
        out.confirmed.push(d.same_as_id);
      }
      out.decision_ids[i] = d.same_as_id;
      continue;
    }
    if (out.decision_ids[i] == null) {
      const already = existing.decisions.get(normText(d.decision));
      if (already != null) {
        // Same decision text already active on this session — a re-send.
        out.decision_ids[i] = already; out.deduped.decisions++;
      } else {
        const row = {
          session_id: sid, decision_date: c.session.date, category: d.category, decision: d.decision,
          options_considered: d.options, rationale: d.rationale, workflow_code: d.workflow_code,
          reversible: true, transcript_search_keys: keys,
        };
        if (retro) { row.origin = 'retro'; row.confidence = d.confirmed_by_mark ? 'confirmed' : 'reconstructed'; }
        const ins = must(await db.from('claude_decision_log').insert(row).select('id').single(), 'insert decision');
        out.decision_ids[i] = ins.id;
      }
    }
    if (d.supersedes_id && !out.superseded.includes(d.supersedes_id)) {
      must(await db.from('claude_decision_log').update({ status: 'superseded', superseded_by: out.decision_ids[i] }).eq('id', d.supersedes_id), 'supersede decision');
      out.superseded.push(d.supersedes_id);
      // Keep the vector index honest right away (the nightly sync would catch it anyway).
      try {
        const res = await db.from('claude_memory_embeddings').update({ status: 'superseded' }).eq('source_table', 'claude_decision_log').eq('source_id', d.supersedes_id);
        if (res?.error) console.warn(`[MemoryCheckpoint] embedding status sync skipped: ${res.error.message}`);
      } catch (err) { console.warn(`[MemoryCheckpoint] embedding status sync skipped: ${err.message}`); }
    }
  }

  // 3. Issues.
  for (let i = 0; i < c.issues.length; i++) {
    if (out.issue_ids[i] != null) continue;
    const x = c.issues[i];
    const already = existing.issues.get(normText(x.description));
    if (already != null) { out.issue_ids[i] = already; out.deduped.issues++; continue; }
    const row = {
      reported_date: c.session.date, reported_session_id: sid, severity: x.severity, category: x.category,
      description: x.description, impact: x.impact, fix_instructions: x.fix_instructions,
      workflow_code: x.workflow_code, workflow_name: x.workflow_name, issue_type: x.issue_type, status: 'open',
    };
    if (retro) { row.origin = 'retro'; row.confidence = 'reconstructed'; }
    const ins = must(await db.from('claude_known_issues').insert(row).select('id').single(), 'insert issue');
    out.issue_ids[i] = ins.id;
  }
  for (const r of c.resolved_issues) {
    if (out.resolved.includes(r.id)) continue;
    must(await db.from('claude_known_issues').update({
      status: 'resolved', resolved_date: c.session.date, resolved_session_id: sid,
      verified_at: nowIso, verification_note: r.note, stale: false, updated_at: nowIso,
    }).eq('id', r.id), 'resolve issue');
    out.resolved.push(r.id);
  }
  for (const r of c.verified_issues) {
    if (out.verified.includes(r.id)) continue;
    must(await db.from('claude_known_issues').update({ verified_at: nowIso, verification_note: r.note, stale: false, updated_at: nowIso }).eq('id', r.id), 'verify issue');
    out.verified.push(r.id);
  }

  // 4. Pending items (source_index continues from the session's highest 'live' index —
  //    re-queried on a retry, so rows inserted by an earlier attempt are counted).
  for (let i = 0; i < c.pending.length; i++) {
    if (out.pending_ids[i] != null) continue;
    const already = existing.pending.get(normText(c.pending[i].description));
    if (already != null) { out.pending_ids[i] = already; out.deduped.pending++; }
  }
  if (c.pending.some((_, i) => out.pending_ids[i] == null)) {
    const last = must(await db.from('claude_pending_items').select('source_index').eq('source_session_id', sid).eq('source_field', 'live').order('source_index', { ascending: false }).limit(1), 'pending index');
    let idx = (last && last[0] && Number.isInteger(last[0].source_index)) ? last[0].source_index + 1 : 0;
    for (let i = 0; i < c.pending.length; i++) {
      if (out.pending_ids[i] != null) continue;
      const p = c.pending[i];
      const ins = must(await db.from('claude_pending_items').insert({
        source_session_id: sid, source_field: 'live', source_index: idx++, kind: p.kind, item_type: p.item_type,
        description: p.description, status: 'open', priority: p.priority, effort: p.effort, blocked_by: p.blocked_by,
        ref: p.ref, owner: p.owner, origin: retro ? 'retro' : 'live', session_date: c.session.date, created_at: nowIso,
      }).select('id').single(), 'insert pending');
      out.pending_ids[i] = ins.id;
    }
  }
  for (const cl of c.close_pending) {
    if (out.closed.includes(cl.id)) continue;
    // verified_at clears the sql/096 stale flag — closing is a human/skill verification, not activity.
    must(await db.from('claude_pending_items').update({
      status: cl.status, resolved_session_id: sid, closed_by: 'checkpoint', closed_reason: `checkpoint:${cl.status}`,
      closed_at: nowIso, verified_at: nowIso, stale: false, updated_at: nowIso,
    }).eq('id', cl.id), 'close pending');
    out.closed.push(cl.id);
  }

  // 5. Ledger row when a URL is on file — for a retro row this is part of the
  //    same sequence, never optional (disposition 'retro_written').
  if (c.session.chat_url && !out.ledger) {
    const disposition = retro ? 'retro_written' : 'linked';
    must(await db.from('claude_transcript_ledger').upsert({
      chat_url: c.session.chat_url, chat_title: c.session.chat_title,
      chat_updated_at: retro ? c.source.chat_updated_at : nowIso,
      session_id: sid, disposition, reviewed_at: nowIso,
      notes: `memory_checkpoint ${retro ? 'retro ' : ''}${c.today}${out.updated ? ' (refresh)' : ''}`,
    }, { onConflict: 'chat_url' }), 'ledger upsert');
    out.ledger = disposition;
  }
  delete out.keys;
  return out;
}

/** What applyCheckpoint would do, without touching the database. */
export function planCheckpoint(input, now = new Date(), env = process.env) {
  const c = validateCheckpoint(input, now, env);
  return {
    dry_run: true,
    mode: c.mode,
    guard_mode: getGuardMode(env),
    session: c.session_id ? `UPDATE claude_session_logs #${c.session_id}` : `INSERT claude_session_logs (${c.session.surface}, ${c.session.date}, ${c.mode}) — or UPDATE if this identity already exists`,
    // The identity a re-send would collide on (sql/099). Same key = same session.
    checkpoint_key: c.session_id ? null : checkpointKeyFor({ surface: c.session.surface, date: c.session.date, title: c.session.title }),
    identity: c.session_id ? null : `${c.session.surface}|${c.session.date}|${normText(c.session.title)}`,
    date_confidence: c.session.date_confidence,
    source: c.source,
    search_keys: c.session.search_keys,
    decisions: c.decisions.length, superseding: c.decisions.filter((d) => d.supersedes_id).length,
    reconfirming: c.decisions.filter((d) => d.same_as_id).length,
    issues: c.issues.length, resolved_issues: c.resolved_issues.length, verified_issues: c.verified_issues.length,
    pending: c.pending.length, close_pending: c.close_pending.length,
    ledger: c.session.chat_url ? (c.mode === 'retro' ? 'retro_written (exact)' : 'linked (exact)') : 'none (unlinked)',
    hint: 'add "confirm": true to write',
  };
}
