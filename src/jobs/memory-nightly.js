/**
 * Nightly memory job — src/jobs/memory-nightly.js  (priority #8, 2026-09-06)
 *
 * Keeps the claude_* memory tier current without a human in the loop:
 *   1. stale flags   — decision #1678: an open defect with no verification in
 *                      60+ days and no touch in 60+ days (updated_at for live
 *                      rows, reported_date for retro rows) is stale=true.
 *                      The job never clears stale — verification does.
 *   2. auto-close    — memory-autoclose.js: pending-item rules A–D + stale
 *                      flag, gated by MEMORY_AUTOCLOSE_MODE (off | shadow |
 *                      live). Runs before re-embed so closed rows change
 *                      status and re-embed picks them up.
 *   3. re-embed      — memory-embed.js planKind/executePlan for all four kinds;
 *                      content-hash incremental, so a quiet day writes 0 rows.
 *   4. validation    — memory-validate.js (sql/098): unlinked sessions > 7 d,
 *                      write_date rows, live rows in a batch pattern, active
 *                      decisions with no area, embedding coverage, orphan
 *                      embeddings, metadata drift, open conflicts, C1
 *                      provenance mismatches, flagged sessions → one row each
 *                      in claude_memory_validation_log. Repairs (live only):
 *                      embedding metadata synced from the source rows, orphan
 *                      embeddings marked stale. Runs AFTER re-embed so
 *                      tonight's new embeddings get their metadata too.
 *   5. conflict scan — memory-conflicts.js: active decisions (cosine ≥ 0.85)
 *                      and open issues (≥ 0.90) in the same area, embedded in
 *                      the last 24 h, filed in claude_memory_conflicts for a
 *                      ruling. Nothing closed here.
 *   6. drafts        — memory-validate.js runDraftCheckpoints: ledger rows
 *                      deferred with no session get a draft session
 *                      (origin 'nightly', summary + keys only).
 *   7. workflow ref  — claude_workflow_ref (sql/092) refreshed from the LP-side
 *                      workflow_canonical_map mirror (itself synced from the HL
 *                      workflow_registry every 15 min). No HL dependency here.
 *   8. snapshot      — counts from claude_memory_context(NULL) logged for the
 *                      record.
 *   9. weekly digest — rule E: on the run whose ET weekday is
 *                      MEMORY_DIGEST_WEEKDAY (Monday), one GroupMe message
 *                      listing what is waiting on Mark (the protected
 *                      item_types), what Omi heard this week and nobody has
 *                      confirmed (sql/101), what auto-close did this week, open
 *                      conflicts awaiting a ruling, sessions unlinked after
 *                      7 days, and this week's validation failures.
 *  10. recommend     — memory-recommend.js (sql/102): a verdict, reason,
 *                      evidence, confidence and risk written onto each open
 *                      Rulings-lane card, so the Command Center is a
 *                      ten-second job per item instead of a ten-minute one.
 *                      Gated by MEMORY_RECOMMEND_MODE (off | shadow | live,
 *                      default off). Last on purpose: the only step that spends
 *                      LLM tokens, and the only one whose absence costs
 *                      nothing — a card with no recommendation is still rulable.
 *
 * Every SQL step runs through withRetry (issue #1627): three attempts with
 * 250 ms / 1 s / 3 s backoff on transient errors. A step that still fails is
 * logged and alerted (GroupMe) but never aborts the remaining steps.
 *
 * What it does NOT do: read Claude chats. LP-MCP has no path to transcripts,
 * so un-checkpointed chats are still Mark's refresh pass; every other surface
 * checkpoints itself through the memory_checkpoint tool.
 *
 * SCHEDULE: daily at MEMORY_NIGHTLY_HOUR_ET (default 3) — same 5-minute
 * hour-check pattern as market-assignment-daily.js.
 * ROUTES:   POST /admin/memory/nightly { dry_run? }   GET /admin/memory/nightly/status
 *           dry_run:true plans the embed, counts the auto-close rules, runs the
 *           validation / conflict / draft SELECTs and previews the digest —
 *           writes nothing, sends nothing. (POST /admin/memory/validate
 *           {dry_run:true} is the run that DOES write validation-log rows.)
 * ENV:      MEMORY_NIGHTLY_ENABLED (default true), MEMORY_NIGHTLY_HOUR_ET (default 3),
 *           MEMORY_AUTOCLOSE_MODE (default off), MEMORY_DIGEST_ENABLED (default true),
 *           MEMORY_DIGEST_WEEKDAY (default Monday), MEMORY_CONFLICT_THRESHOLD (default 0.85),
 *           MEMORY_ISSUE_DUPLICATE_THRESHOLD (default 0.90)
 */
import supabase from '../supabase.js';
import { runSQL } from '../admin/supabase-admin.js';
import { SOURCES } from '../memory/memory-text.js';
import { withRetry } from '../memory/with-retry.js';
import { runAutoclose, PROTECTED_LIST_SQL, logSql } from './memory-autoclose.js';
import { runMemoryValidation, runDraftCheckpoints } from './memory-validate.js';
import { runConflictScan } from './memory-conflicts.js';
import { recommendBatch, getMode as getRecommendMode } from './memory-recommend.js';
import { runJob } from '../job-runner.js';

const TIMEZONE = 'America/New_York';
const STALE_DAYS = 60;
const SQL_RETRY = { attempts: 3, backoffMs: [250, 1000, 3000] };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const STALE_SQL = `
UPDATE claude_known_issues
SET stale = true, updated_at = now()
WHERE status IN ('open','in_progress')
  AND coalesce(issue_type,'defect') = 'defect'
  AND stale = false
  AND (verified_at IS NULL OR verified_at < now() - interval '${STALE_DAYS} days')
  AND (CASE WHEN origin = 'live' THEN updated_at ELSE reported_date::timestamptz END) < now() - interval '${STALE_DAYS} days'
RETURNING id`;

export const WORKFLOW_REF_SQL = `
INSERT INTO claude_workflow_ref (canonical_code, workflow_id, canonical_name, stage_family, synced_at)
SELECT canonical_code, workflow_id, coalesce(canonical_name, canonical_code), stage_family, now()
FROM workflow_canonical_map
WHERE workflow_id IS NOT NULL
ON CONFLICT (canonical_code) DO UPDATE SET
  workflow_id = EXCLUDED.workflow_id,
  canonical_name = EXCLUDED.canonical_name,
  stage_family = coalesce(EXCLUDED.stage_family, claude_workflow_ref.stage_family),
  synced_at = now()
RETURNING canonical_code`;

// ─── Weekly digest (rule E) SQL ────────────────────────────────────────────
// "Waiting on Mark" = open rows in the protected set (the rules never touch them).
export const DIGEST_WAITING_SQL = `
SELECT count(*)::int AS waiting,
       coalesce(max(current_date - coalesce(session_date, created_at::date)), 0)::int AS oldest_days
FROM claude_pending_items
WHERE status='open' AND item_type IN ${PROTECTED_LIST_SQL}`;

export const DIGEST_TOP_SQL = `
SELECT id, left(regexp_replace(description, '\\s+', ' ', 'g'), 80) AS description,
       coalesce(session_date, created_at::date)::text AS session_date
FROM claude_pending_items
WHERE status='open' AND item_type IN ${PROTECTED_LIST_SQL}
ORDER BY coalesce(session_date, created_at::date) ASC, id ASC
LIMIT 5`;

export const DIGEST_WEEK_SQL = `
SELECT mode, rule, sum(affected)::int AS affected
FROM claude_memory_autoclose_log
WHERE ran_at > now() - interval '7 days' AND rule <> 'DIGEST'
GROUP BY mode, rule`;

export const DIGEST_STALE_SQL = `
SELECT count(*)::int AS stale FROM claude_pending_items WHERE status='open' AND stale`;

// sql/098 sections: conflicts awaiting a ruling, sessions unlinked after 7 days,
// validation checks that flagged rows this week (latest run per check).
export const DIGEST_CONFLICTS_SQL = `
SELECT id, kind, row_a, row_b, round(similarity::numeric, 2)::float8 AS similarity, count(*) OVER ()::int AS total
FROM claude_memory_conflicts WHERE status='open'
ORDER BY similarity DESC, id LIMIT 3`;

export const DIGEST_UNLINKED_SQL = `
SELECT count(*)::int AS unlinked,
       count(*) FILTER (WHERE log_origin = 'nightly')::int AS drafts
FROM claude_session_logs
WHERE chat_url IS NULL AND coalesce(surface,'chat')='chat' AND created_at < now() - interval '7 days'`;

export const DIGEST_VALIDATION_SQL = `
SELECT DISTINCT ON (check_name) check_name, rows_flagged, ran_at::date::text AS ran_on
FROM claude_memory_validation_log
WHERE ran_at > now() - interval '7 days' AND mode = 'nightly' AND check_name NOT LIKE 'repair:%' AND coalesce(rows_flagged, 0) > 0
ORDER BY check_name, ran_at DESC`;

// "Heard in Omi — confirm or drop" (sql/101): open Omi proposals from the last
// 7 days. Nothing Omi hears is confirmed, so this section is a queue Mark
// works, not a report. Conflicts first (they contradict a confirmed decision),
// then unconfirmed decisions, then the rest; newest first inside each band.
export const DIGEST_OMI_SQL = `
SELECT id, item_type,
       left(regexp_replace(description, '\\s+', ' ', 'g'), 80) AS description,
       (raw->>'conflicts_with_decision_id') IS NOT NULL AS conflicting,
       count(*) OVER ()::int AS total
FROM claude_pending_items
WHERE origin='omi' AND status='open' AND created_at > now() - interval '7 days'
ORDER BY ((raw->>'conflicts_with_decision_id') IS NOT NULL) DESC,
         (item_type = 'unconfirmed_decision') DESC,
         created_at DESC, id DESC
LIMIT 15`;

// "Likely done — confirm": open rows whose named PR is merged but only mentioned
// in passing (rule D2 tags D:pr_mentioned and never closes them — Mark's ruling).
export const DIGEST_MENTION_SQL = `
SELECT id, left(regexp_replace(description, '\\s+', ' ', 'g'), 80) AS description,
       coalesce(session_date, created_at::date)::text AS session_date,
       count(*) OVER ()::int AS total
FROM claude_pending_items
WHERE status='open' AND would_close='D:pr_mentioned'
ORDER BY coalesce(session_date, created_at::date) ASC, id ASC
LIMIT 5`;

function todayET(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
function hourET(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: '2-digit', hour12: false }).formatToParts(now);
  return Number(parts.find((p) => p.type === 'hour')?.value ?? -1) % 24;
}
/** ET weekday name, e.g. 'Monday'. Exported for tests. */
export function weekdayET(now = new Date()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'long' }).format(now);
}

/** Pure: should the tick fire now? Exported for tests. */
export function shouldRun({ hour, today, lastRunDate, targetHour }) {
  return hour === targetHour && lastRunDate !== today;
}

/** Pure: does the digest go out on this run? Exported for tests. */
export function shouldSendDigest({ weekday, enabled = true, targetWeekday = 'Monday' }) {
  if (enabled === false || String(enabled).toLowerCase() === 'false') return false;
  const want = String(targetWeekday || 'Monday').trim().toLowerCase();
  if (!WEEKDAYS.some((d) => d.toLowerCase() === want)) return false;
  return String(weekday || '').toLowerCase() === want;
}

function digestConfig(env = process.env) {
  return {
    enabled: String(env.MEMORY_DIGEST_ENABLED ?? 'true').toLowerCase() !== 'false',
    weekday: env.MEMORY_DIGEST_WEEKDAY || 'Monday',
  };
}

/**
 * Pure: build the digest text. No ⚠️ prefix — this is a report, not an alert.
 *   📋 memory weekly — N items waiting on Mark (oldest: X days)
 *   1. [#id] first 80 chars of description  (session_date)
 *   Also: A expired / B duplicates superseded / C done by evidence this week · S open items flagged stale
 */
export function formatDigest({ waiting = 0, oldest_days = 0, top = [], week = [], stale = 0, mode = 'off', mentions = [], mention_total = 0,
  conflicts = [], conflict_total = 0, unlinked_7d = 0, drafts = 0, validation = [], omi = [], omi_total = 0 }) {
  const lines = [`📋 memory weekly — ${waiting} item${waiting === 1 ? '' : 's'} waiting on Mark (oldest: ${oldest_days} days)`];
  top.slice(0, 5).forEach((r, i) => {
    lines.push(`${i + 1}. [#${r.id}] ${String(r.description || '').trim()}  (${r.session_date})`);
  });
  // sql/101 — unconfirmed, so it never mixes into the numbered list above.
  const omiCount = omi_total || omi.length;
  if (omiCount > 0) {
    lines.push(`Heard in Omi — confirm or drop: ${omiCount} this week`);
    omi.slice(0, 15).forEach((r) => {
      lines.push(`• [#${r.id}] ${r.conflicting ? '⚠ ' : ''}${String(r.description || '').trim()}`);
    });
    if (omiCount > Math.min(omi.length, 15)) lines.push(`  …and ${omiCount - Math.min(omi.length, 15)} more (claude_pending_items, origin 'omi')`);
  }
  const total = mention_total || mentions.length;
  if (total > 0) {
    lines.push(`Likely done — confirm (PR merged, mentioned in passing): ${total}`);
    mentions.slice(0, 5).forEach((r) => lines.push(`• [#${r.id}] ${String(r.description || '').trim()}  (${r.session_date})`));
  }
  // sql/098 sections — each omitted when there is nothing to say.
  const conflictCount = conflict_total || conflicts.length;
  if (conflictCount > 0) {
    lines.push(`Conflicts awaiting ruling: ${conflictCount}`);
    conflicts.slice(0, 3).forEach((c) => lines.push(`• [conflict #${c.id}] ${c.kind} #${c.row_a} vs #${c.row_b}  (cosine ${Number(c.similarity).toFixed(2)})`));
  }
  if (unlinked_7d > 0 || drafts > 0) {
    lines.push(`Unlinked after 7 days: ${unlinked_7d} session${unlinked_7d === 1 ? '' : 's'}${drafts > 0 ? ` · ${drafts} nightly draft${drafts === 1 ? '' : 's'} to confirm or drop` : ''}`);
  }
  if (validation.length) {
    lines.push(`Validation this week: ${validation.map((v) => `${v.check_name}=${v.rows_flagged}`).join(' · ')}`);
  }
  const sum = (rows, rule) => rows.filter((w) => w.rule === rule).reduce((n, w) => n + (Number(w.affected) || 0), 0);
  const live = week.filter((w) => w.mode === 'live');
  const shadow = week.filter((w) => w.mode === 'shadow');
  const rows = live.length ? live : shadow;
  const label = live.length ? 'Also:' : (shadow.length ? 'Also (shadow, would):' : 'Also:');
  const expired = sum(rows, 'A') + sum(rows, 'B');
  const dupes = sum(rows, 'C');
  const done = sum(rows, 'D');
  lines.push(`${label} ${expired} expired / ${dupes} duplicates superseded / ${done} done by evidence this week · ${stale} open items flagged stale${mode === 'off' && !rows.length ? ' (auto-close off)' : ''}`);
  return lines.join('\n');
}

async function postGroupMe(text) {
  const botId = process.env.GROUPME_BOT_ID;
  if (!botId) { console.warn('[MemoryNightly] GROUPME_BOT_ID unset — message suppressed:', text); return false; }
  try {
    await fetch('https://api.groupme.com/v3/bots/post', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_id: botId, text }), signal: AbortSignal.timeout(8000),
    });
    return true;
  } catch (err) { console.warn('[MemoryNightly] GroupMe post failed:', err.message); return false; }
}

async function alertGroupMe(text, post = postGroupMe) {
  return post(`⚠️ memory nightly — ${text}`);
}

/**
 * Rule E. Queries the waiting set + this week's auto-close log and posts one
 * GroupMe message on the configured ET weekday. dry_run builds the message
 * and reports would_send without posting or logging.
 */
export async function runWeeklyDigest({ dry_run = false, mode = 'off', now = new Date(), deps = {} } = {}) {
  const env = deps.env || process.env;
  const cfg = digestConfig(env);
  const weekday = weekdayET(now);
  const due = shouldSendDigest({ weekday, enabled: cfg.enabled, targetWeekday: cfg.weekday });
  const out = { enabled: cfg.enabled, weekday, target_weekday: cfg.weekday, due, sent: false, message: null };
  if (!cfg.enabled || (!due && !dry_run)) return out;
  const sql = deps.runSQL;
  const rows = (r) => (Array.isArray(r) ? r : []);
  const [waitingRows, top, week, staleRows, mentionRows, conflictRows, unlinkedRows, validationRows, omiRows] = await Promise.all([
    sql(DIGEST_WAITING_SQL), sql(DIGEST_TOP_SQL), sql(DIGEST_WEEK_SQL), sql(DIGEST_STALE_SQL), sql(DIGEST_MENTION_SQL),
    sql(DIGEST_CONFLICTS_SQL).catch((err) => { out.section_errors = [...(out.section_errors || []), `conflicts: ${err.message}`]; return []; }),
    sql(DIGEST_UNLINKED_SQL).catch((err) => { out.section_errors = [...(out.section_errors || []), `unlinked: ${err.message}`]; return []; }),
    sql(DIGEST_VALIDATION_SQL).catch((err) => { out.section_errors = [...(out.section_errors || []), `validation: ${err.message}`]; return []; }),
    // sql/101 may not be applied yet — a missing column must not kill the digest.
    sql(DIGEST_OMI_SQL).catch((err) => { out.section_errors = [...(out.section_errors || []), `omi: ${err.message}`]; return []; }),
  ]);
  const waiting = rows(waitingRows)[0] || {};
  const mentions = rows(mentionRows);
  const conflicts = rows(conflictRows);
  const unlinked = rows(unlinkedRows)[0] || {};
  const omi = rows(omiRows);
  out.waiting = Number(waiting.waiting) || 0;
  out.likely_done = Number(mentions[0]?.total) || mentions.length;
  out.open_conflicts = Number(conflicts[0]?.total) || conflicts.length;
  out.unlinked_7d = Number(unlinked.unlinked) || 0;
  out.omi_open_7d = Number(omi[0]?.total) || omi.length;
  out.message = formatDigest({
    waiting: out.waiting, oldest_days: Number(waiting.oldest_days) || 0,
    top: rows(top), week: rows(week), stale: Number(rows(staleRows)[0]?.stale) || 0, mode,
    mentions, mention_total: out.likely_done,
    conflicts, conflict_total: out.open_conflicts,
    unlinked_7d: out.unlinked_7d, drafts: Number(unlinked.drafts) || 0,
    validation: rows(validationRows),
    omi, omi_total: out.omi_open_7d,
  });
  if (dry_run || !due) { out.would_send = due; return out; }
  out.sent = await (deps.postGroupMe || postGroupMe)(out.message);
  await sql(logSql({ mode, rule: 'DIGEST', affected: out.waiting, notes: out.sent ? 'sent' : 'send failed' }));
  return out;
}

let lastRun = null;

/**
 * Run the job. dry_run computes the embed plan, the auto-close counts and the
 * digest preview but writes nothing (stale UPDATE and workflow-ref upsert are
 * skipped, not simulated).
 */
export async function runMemoryNightly({ dry_run = false, deps = {} } = {}) {
  const startedAt = Date.now();
  const now = deps.now || new Date();
  const env = deps.env || process.env;
  const mode = env.MEMORY_AUTOCLOSE_MODE || 'off';
  const result = { started_at: now.toISOString(), dry_run, autoclose_mode: mode, stale_flagged: null, autoclose: null, embed: {}, validation: null, conflicts: null, drafts: null, workflow_ref: null, counts: null, digest: null, recommend: null, errors: [] };
  const rawSql = deps.runSQL || runSQL;
  const sql = (text) => withRetry(() => rawSql(text), {
    ...SQL_RETRY, sleep: deps.sleep,
    onRetry: (err, attempt, delay) => console.warn(`[MemoryNightly] SQL attempt ${attempt} failed (${err.message}) — retry in ${delay}ms`),
  });
  const db = deps.supabase || supabase;
  const post = deps.postGroupMe || postGroupMe;

  if (!dry_run) {
    try { const rows = await sql(STALE_SQL); result.stale_flagged = Array.isArray(rows) ? rows.length : 0; }
    catch (err) { result.errors.push(`stale: ${err.message}`); }
  }

  // Auto-close before re-embed: closed rows change status → re-embed picks them up.
  try {
    const ac = await runAutoclose({ mode, dry_run, deps: { runSQL: sql, fetchPR: deps.fetchPR, env } });
    result.autoclose = ac;
    for (const e of ac.errors) result.errors.push(`autoclose ${e}`);
  } catch (err) { result.errors.push(`autoclose: ${err.message}`); }

  try {
    const m = deps.embed || await import('../memory/memory-embed.js');
    for (const kind of Object.keys(SOURCES)) {
      const plan = await m.planKind(kind, {});
      const entry = { total: plan.total, to_embed: plan.todo.length, est_tokens: plan.est_tokens, written: 0, cost_usd: 0 };
      if (!dry_run && plan.todo.length) {
        const r = await m.executePlan(plan, { log: () => {} });
        entry.written = r.written; entry.cost_usd = Number(r.cost_usd.toFixed(4));
      }
      result.embed[kind] = entry;
    }
  } catch (err) { result.errors.push(`embed: ${err.message}`); }

  // sql/098 — validation (log + repairs), conflict scan, draft checkpoints.
  // A dry run issues only the candidate SELECTs: no log rows, no repairs, no inserts.
  try {
    const v = await (deps.validate || runMemoryValidation)({ dry_run, mode: 'nightly', deps: { runSQL: sql, log: !dry_run } });
    result.validation = { flagged_total: v.flagged_total, checks: Object.fromEntries(Object.entries(v.checks).map(([k, e]) => [k, e.error ? { error: e.error } : { checked: e.rows_checked, flagged: e.rows_flagged }])), repairs: v.repairs };
    for (const e of v.errors) result.errors.push(`validation ${e}`);
  } catch (err) { result.errors.push(`validation: ${err.message}`); }
  try {
    const s = await (deps.conflicts || runConflictScan)({ dry_run, full: false, deps: { runSQL: sql, env } });
    result.conflicts = { filed: s.filed, kinds: Object.fromEntries(Object.entries(s.kinds).map(([k, e]) => [k, { threshold: e.threshold, candidates: e.candidates, filed: e.filed, error: e.error }])) };
    for (const e of s.errors) result.errors.push(`conflicts ${e}`);
  } catch (err) { result.errors.push(`conflicts: ${err.message}`); }
  try {
    const d = await (deps.drafts || runDraftCheckpoints)({ dry_run, now, deps: { runSQL: sql, db } });
    result.drafts = { candidates: d.candidates, drafted: d.drafted.length, ids: d.drafted.slice(0, 20) };
    for (const e of d.errors) result.errors.push(`drafts ${e}`);
  } catch (err) { result.errors.push(`drafts: ${err.message}`); }

  if (!dry_run) {
    try { const rows = await sql(WORKFLOW_REF_SQL); result.workflow_ref = Array.isArray(rows) ? rows.length : 0; }
    catch (err) { result.errors.push(`workflow_ref: ${err.message}`); }
  }

  try {
    const { data, error } = await db.rpc('claude_memory_context', { p_topic: null });
    if (error) throw new Error(error.message);
    result.counts = data?.counts ?? null;
  } catch (err) { result.errors.push(`counts: ${err.message}`); }

  try {
    result.digest = await runWeeklyDigest({ dry_run, mode, now, deps: { runSQL: sql, postGroupMe: post, env } });
  } catch (err) { result.errors.push(`digest: ${err.message}`); }

  // 9.5 Omi catch-up (sql/112). A DEEP pass — it walks the whole window instead
  //     of stopping at the first conversation it already has, so anything the
  //     scheduler missed is picked up overnight rather than waiting for someone
  //     to notice a gap. The 15-minute tick keeps its early stop for latency.
  //
  //     deep:true is what makes this a catch-up at all. Without it the run stops
  //     at the first known conversation, which on a live day was position ONE —
  //     and a conversation that saved late sits below that for ever, because it
  //     keeps its original created_at and the list is ordered by created_at.
  //     Measured 2026-09-15: 12+ conversations were unreachable this way.
  //
  //     BEFORE the recommend step, deliberately: rows pulled here are candidates
  //     for tonight's recommendations, and a catch-up that ran after would leave
  //     every new Omi card unrecommended until tomorrow.
  try {
    const { runOmiPull, getPullMode } = await import('./omi-pull.js');
    if (getPullMode(env) === 'off') {
      result.omi_pull = { mode: 'off', skipped: true };
    } else {
      const r = await (deps.omiPull || runOmiPull)({ dry_run, deep: true, deps: { env } });
      result.omi_pull = { mode: r.mode, deep: r.deep, steps: r.steps, ok: r.ok };
      for (const e of r.errors || []) result.errors.push(`omi_pull ${e}`);
    }
  } catch (err) { result.errors.push(`omi_pull: ${err.message}`); }

  // 10. Command Center recommendations (sql/102). Last on purpose: it is the
  //     only step that costs LLM tokens, and it is the one step whose absence
  //     costs nothing — a card with no recommendation is still rulable. Off
  //     unless MEMORY_RECOMMEND_MODE says otherwise, and isolated like every
  //     other step so it can never fail the nightly.
  try {
    const recMode = deps.recommendMode || getRecommendMode(env);
    if (recMode === 'off') {
      result.recommend = { mode: 'off', skipped: true };
    } else {
      const r = await (deps.recommend || recommendBatch)({ mode: recMode, dry_run, deps: { db, env } });
      result.recommend = { mode: r.mode, candidates: r.candidates, attempted: r.attempted, written: r.written, skipped: r.skipped };
      for (const e of r.errors) result.errors.push(`recommend ${e}`);
    }
  } catch (err) { result.errors.push(`recommend: ${err.message}`); }

  result.elapsed_ms = Date.now() - startedAt;
  result.ok = result.errors.length === 0;
  lastRun = result;
  const acSummary = result.autoclose && result.autoclose.mode !== 'off'
    ? `${result.autoclose.mode}:${Object.entries(result.autoclose.rules).map(([t, r]) => `${t.split(':')[0]}=${r.affected}`).join(',')}`
    : 'off';
  console.log(`[MemoryNightly] ${dry_run ? 'DRY-RUN ' : ''}done stale=${result.stale_flagged} autoclose=${acSummary} embed=${JSON.stringify(Object.fromEntries(Object.entries(result.embed).map(([k, v]) => [k, v.written])))} validation_flagged=${result.validation?.flagged_total ?? 'n/a'} conflicts_filed=${result.conflicts?.filed ?? 'n/a'} drafts=${result.drafts?.drafted ?? 'n/a'} ref=${result.workflow_ref} digest=${result.digest?.sent ? 'sent' : (result.digest?.due ? 'due' : 'no')} recommend=${result.recommend?.skipped ? 'off' : `${result.recommend?.mode}:${result.recommend?.attempted ?? 0}`} errors=${result.errors.length} elapsed=${result.elapsed_ms}ms`);
  if (!result.ok && !dry_run) await alertGroupMe(result.errors.join(' | '), post);
  return result;
}

export function getMemoryNightlyStatus() { return lastRun; }

// ─── Scheduler ────────────────────────────────────────────────────────────
let timer = null;
let lastRunDate = null;

export function startMemoryNightlyScheduler() {
  if (timer) return timer;
  if (String(process.env.MEMORY_NIGHTLY_ENABLED || 'true').toLowerCase() === 'false') {
    console.log('[MemoryNightly] scheduler disabled via MEMORY_NIGHTLY_ENABLED=false');
    return null;
  }
  const targetHour = Number(process.env.MEMORY_NIGHTLY_HOUR_ET || 3);
  const tick = async () => {
    const now = new Date();
    const today = todayET(now);
    if (!shouldRun({ hour: hourET(now), today, lastRunDate, targetHour })) return;
    lastRunDate = today; // claim before awaiting
    try { await runJob('memory-nightly', () => runMemoryNightly()); }
    catch (err) { console.error('[MemoryNightly] run threw:', err.message); await alertGroupMe(`run threw: ${err.message}`); }
  };
  timer = setInterval(tick, 5 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[MemoryNightly] scheduler started — daily at ${String(targetHour).padStart(2, '0')}:00 ET (autoclose=${process.env.MEMORY_AUTOCLOSE_MODE || 'off'}, digest=${digestConfig().enabled ? digestConfig().weekday : 'off'})`);
  return timer;
}

export function stopMemoryNightlyScheduler() { if (timer) { clearInterval(timer); timer = null; } }

export function registerMemoryNightlyRoutes(app, authenticate) {
  const guards = typeof authenticate === 'function' ? [authenticate] : [];
  app.post('/admin/memory/nightly', ...guards, async (req, res) => {
    try { res.json(await runMemoryNightly({ dry_run: req.body?.dry_run === true })); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });
  app.get('/admin/memory/nightly/status', ...guards, (_req, res) => {
    const d = digestConfig();
    res.json({
      last_run: lastRun, last_run_date: lastRunDate,
      enabled: String(process.env.MEMORY_NIGHTLY_ENABLED || 'true').toLowerCase() !== 'false',
      hour_et: Number(process.env.MEMORY_NIGHTLY_HOUR_ET || 3),
      autoclose_mode: process.env.MEMORY_AUTOCLOSE_MODE || 'off',
      digest_enabled: d.enabled, digest_weekday: d.weekday,
    });
  });
  console.log(`[MemoryNightly] Routes: POST /admin/memory/nightly (dry_run:true = plan + autoclose counts + digest preview) | GET /admin/memory/nightly/status${guards.length ? ' (authenticated)' : ' (UNAUTHENTICATED)'}`);
}
