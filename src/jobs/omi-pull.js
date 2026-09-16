/**
 * Omi pull — src/jobs/omi-pull.js
 *
 * Reads Mark's Omi conversations and memories on a schedule and files them as
 * UNCONFIRMED pending items. Nothing here writes claude_decision_log or
 * claude_known_issues; Omi proposes, the Command Center decides.
 *
 * WHY A PULL AT ALL. Omi's Conversation Events webhook exists, but it only
 * covers conversations recorded after it is switched on, and only while it is
 * switched on. A pull works regardless of capture device, survives a webhook
 * outage, and back-fills. Both paths converge on the SAME idempotency key —
 * omiCheckpointKey(id) = sha256('omi|' + id) — so one conversation is one
 * record no matter how many times it arrives or by which route.
 *
 * WHY NO MODEL CALL. Checked live on 2026-09-14: the Developer API returns
 * `transcript_segments: null` everywhere, so there is no transcript for a model
 * to read; and it returns Omi's own `structured.title` / `overview` /
 * `action_items`, so there is nothing for a model to produce. Extraction here
 * would be paying to re-derive fields we are already handed. The mapping lives
 * in omi-ingest.js (mapStructuredExtraction) and the webhook path uses it too,
 * so there is exactly one definition of what an Omi conversation becomes.
 *
 * WHAT IT REUSES rather than reimplements: ingestOmiConversation() does the
 * idempotency check, the PII scrub, the exact-text and vector dedupe (0.90),
 * the conflict check against active decisions (0.85), the ledger row and the
 * atomic write. This file pages the API and keeps the bookkeeping; it does not
 * own a second copy of any of that.
 *
 * v1.0 — 2026-09-14 (sql/112).
 */

import { createOmiClient, OmiAuthError } from '../memory/omi-client.js';
import {
  ingestOmiConversation,
  getOmiMode,
  omiCheckpointKey,
} from '../memory/omi-ingest.js';
import { guardedDb } from '../memory/omi-db.js';
import { stripPii } from '../memory/memory-text.js';
import { pushTasksToOmi } from '../memory/omi-tasks.js';
import supabase from '../supabase.js';
import { createHash } from 'node:crypto';
import { runJob } from '../job-runner.js';

export const PULL_MODES = new Set(['off', 'shadow', 'live']);
export const PULL_KINDS = Object.freeze(['conversations', 'memories', 'action_items', 'writeback']);

const TIMEZONE = 'America/New_York';
/** Three in a row, not three ever — a single 500 at 3am is not an incident. */
const ALERT_AFTER_FAILURES = 3;

function num(env, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(env?.[name]);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * off | shadow | live.
 *
 * A pull cannot be live while the ingest is not: OMI_INGEST_MODE is what
 * decides whether claude_omi_ingest actually writes, so a live pull against a
 * shadow ingest would page the API, do the work and silently discard it. Rather
 * than fail in a way that looks like success, force shadow and say so.
 */
export function getPullMode(env = process.env) {
  const raw = String(env.OMI_PULL_MODE || 'off').toLowerCase().trim();
  const mode = PULL_MODES.has(raw) ? raw : 'off';
  if (mode === 'live' && getOmiMode(env) !== 'live') return 'shadow';
  return mode;
}

export function getPullConfig(env = process.env) {
  return {
    mode: getPullMode(env),
    intervalMin: num(env, 'OMI_PULL_INTERVAL_MIN', 15, { min: 1, max: 24 * 60 }),
    maxPages: num(env, 'OMI_PULL_MAX_PAGES', 5, { min: 1, max: 100 }),
    pageSize: num(env, 'OMI_PULL_PAGE_SIZE', 100, { min: 1, max: 100 }),
    writeback: String(env.OMI_TASK_WRITEBACK || 'false').toLowerCase() === 'true',
  };
}

function dateET(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/** The per-day session key for memories. Mirrors omiCheckpointKey's shape. */
export function omiMemoryCheckpointKey(dateStr) {
  return createHash('sha256').update(`omi-memories|${dateStr}`).digest('hex');
}

// ─── Bookkeeping ───────────────────────────────────────────────────────────
async function readSync(db, kind) {
  const res = await db.from('claude_omi_sync').select('*').eq('kind', kind).maybeSingle();
  if (res?.error) throw new Error(`claude_omi_sync read (${kind}): ${res.error.message}`);
  return res?.data ?? null;
}

/**
 * One row per kind, upserted after EVERY run. `ok:false` bumps
 * consecutive_failures; `ok:true` clears it and stamps last_ok_at, which is
 * what the heartbeat reads to decide the pull is alive.
 */
async function writeSync(db, kind, { ok, cursor, seen, ingested, error, prev }) {
  const failures = ok ? 0 : Number(prev?.consecutive_failures || 0) + 1;
  const nowIso = new Date().toISOString();
  const row = {
    kind,
    last_run_at: nowIso,
    items_seen: seen ?? 0,
    items_ingested: ingested ?? 0,
    consecutive_failures: failures,
    last_error: ok ? null : String(error || '').slice(0, 500),
  };
  if (ok) row.last_ok_at = nowIso;
  // Keep the old cursor on a failure: moving it forward on a run that did not
  // finish would skip everything the run never reached.
  if (cursor) row.last_cursor = cursor;
  const res = await db.from('claude_omi_sync').upsert(row, { onConflict: 'kind' });
  if (res?.error) throw new Error(`claude_omi_sync write (${kind}): ${res.error.message}`);
  return failures;
}

async function logPull(db, row) {
  try {
    const res = await db.from('claude_memory_validation_log').insert({
      check_name: row.check_name,
      mode: row.mode ?? null,
      rows_checked: row.rows_checked ?? null,
      rows_flagged: row.rows_flagged ?? null,
      sample: row.sample ?? null,
      notes: row.notes ?? null,
    });
    if (res?.error) console.warn(`[OmiPull] validation log skipped: ${res.error.message}`);
  } catch (err) { console.warn(`[OmiPull] validation log skipped: ${err.message}`); }
}

/**
 * Operational alarm. CLAUDE.md: alarms go to the ops channel through
 * sendGroupMeMessage, which mirrors to Slack — never a GroupMe-only path.
 */
async function alertOps(text, deps = {}) {
  try {
    const post = deps.postGroupMe
      || (await import('../groupme.js')).sendGroupMeMessage;
    await post(text, { channel: 'ops' });
  } catch (err) { console.warn(`[OmiPull] ops alert failed: ${err.message}`); }
}

// ─── 1. Conversations ──────────────────────────────────────────────────────
/**
 * Newest-first paging. Stops at the first conversation we already have, because
 * everything past it is older and therefore already ingested. `last_cursor` is
 * the belt to that braces: if a conversation is edited and reappears, the
 * checkpoint key still makes the re-ingest a no-op.
 */
async function pullConversations(client, db, { cfg, env, now, deps, sync, deep = false }) {
  const cursor = sync?.last_cursor || null;
  let seen = 0;
  let ingested = 0;
  let duplicates = 0;
  let noContent = 0;
  let llmCalls = 0;
  let newestFinished = cursor;
  const planned = [];
  let stopped = 'pages_exhausted';

  for (let page = 0; page < cfg.maxPages; page++) {
    const batch = await client.listConversations({ limit: cfg.pageSize, offset: page * cfg.pageSize });
    if (!batch.length) { stopped = 'end_of_list'; break; }

    let hitKnown = false;
    for (const conv of batch) {
      const id = String(conv?.id ?? conv?.conversation_id ?? '').trim();
      if (!id) continue;
      seen += 1;

      // The list is newest-first, so once we reach something older than the
      // high-water mark there is nothing new behind it.
      //
      // THAT IS ONLY TRUE FOR CONVERSATIONS THAT SAVED PROMPTLY. A conversation
      // that was still in_progress when an earlier run passed its position
      // surfaces later at its ORIGINAL created_at — the list is ordered by
      // created_at descending (verified over 25 consecutive rows, 2026-09-15),
      // so it lands BELOW everything already ingested, and its finished_at is
      // older than the cursor. Stop-at-known can never reach it: measured on the
      // first live shadow day, runs 2 and 3 looked at exactly ONE conversation
      // each before breaking, leaving at least 12 late-surfacing conversations
      // permanently invisible with no error anywhere.
      //
      // A deep sweep therefore walks the whole window and lets idempotency do
      // the work: the checkpoint key is sha256('omi|' + id) and claude_omi_ingest
      // is ON CONFLICT DO NOTHING, so re-reading writes nothing. It also makes
      // the cursor/ordering mismatch moot — the cursor is a finished_at while the
      // list is ordered by created_at, which is not guaranteed to agree.
      const finished = conv?.finished_at || conv?.created_at || null;
      if (!deep && cursor && finished && finished <= cursor) { hitKnown = true; break; }
      if (finished && (!newestFinished || finished > newestFinished)) newestFinished = finished;

      const res = await ingestOmiConversation(conv, { db, env, now: now(), embed: deps.embed, llm: deps.llm });
      llmCalls += Number(res.llm_calls || 0);

      // Same reasoning as the cursor break above: a duplicate means "already
      // ingested", which in a deep sweep is the expected case for most of the
      // window, not a signal to stop.
      if (res.status === 'duplicate_event') {
        duplicates += 1;
        if (!deep) { hitKnown = true; break; }
        continue;
      }
      if (res.status === 'no_content') { noContent += 1; continue; }
      if (res.status === 'shadow') {
        planned.push({ conversation_id: id, title: conv?.structured?.title || null, planned: res.planned });
        ingested += res.planned || 0;
        continue;
      }
      if (res.status === 'written') ingested += (res.pending_ids || []).length;
    }
    if (hitKnown) { stopped = 'reached_known'; break; }
    if (batch.length < cfg.pageSize) { stopped = 'end_of_list'; break; }
  }

  return {
    seen, ingested, duplicates, no_content: noContent, llm_calls: llmCalls,
    cursor: newestFinished, stopped, planned, deep,
    // seen and no_content are CONVERSATIONS; ingested is the pending ITEMS those
    // conversations yield, and one conversation can yield several. Naming both
    // units here stops the shadow log reading as "136 checked, 87 ingested" —
    // two different things counted in one line (2026-09-15).
    conversations_with_content: planned.length,
  };
}

// ─── 2. Memories ───────────────────────────────────────────────────────────
async function pullMemories(client, db, { cfg, now, mode }) {
  const date = dateET(now());
  const memories = [];
  let seen = 0;
  let stopped = 'pages_exhausted';

  // Omi clamps `limit` to 100 SERVER-SIDE — ask for 250 and you get 100 back,
  // with has_more:true and no error. This loop used to be a single call with
  // offset hardcoded to 0, so it read the newest 100 and nothing else: measured
  // 2026-09-15, 152 durable memories existed and 52 of them were unreachable on
  // every run, for ever, because the offset never moved. An exactly-round count
  // out of a paged API is a cap, not a total.
  //
  // Memories carry no cursor, so every run re-reads every page. That is safe
  // rather than wasteful: claude_omi_memory_upsert is idempotent on
  // raw->>'omi_memory_id', so a re-read writes nothing. 152 memories is 2 pages
  // against a 40-request budget.
  for (let page = 0; page < cfg.maxPages; page++) {
    const batch = await client.listMemories({ limit: cfg.pageSize, offset: page * cfg.pageSize });
    if (!batch.length) { stopped = 'end_of_list'; break; }
    seen += batch.length;
    collectMemories(batch, memories);
    if (batch.length < cfg.pageSize) { stopped = 'end_of_list'; break; }
  }

  if (!memories.length) return { seen, ingested: 0, skipped: 0, stopped };
  if (mode === 'shadow') {
    // `ingested` carries the WOULD-INGEST count in shadow, matching what
    // pullConversations reports. It used to be hard 0 here with the real number
    // hidden in `planned`, so the shadow log read "would ingest 0 row(s) from
    // memories" on a run that had planned 100 of them (first live shadow run,
    // 2026-09-15). A zero that means "nothing to do" and a zero that means "100
    // rows, not shown" must not look the same — that log line is the only thing
    // anyone reads before deciding to go live.
    return { seen, ingested: memories.length, skipped: 0, planned: memories.length, shadow: true, stopped };
  }

  const res = await db.rpc('claude_omi_memory_upsert', {
    p: { checkpoint_key: omiMemoryCheckpointKey(date), session_date: date, memories },
  });
  if (res?.error) throw new Error(`claude_omi_memory_upsert: ${res.error.message}`);
  const out = (Array.isArray(res?.data) ? res.data[0] : res?.data) || {};
  return {
    seen,
    ingested: Number(out.inserted || 0),
    skipped: Number(out.skipped_existing || 0) + Number(out.skipped_duplicate || 0),
    stopped,
  };
}

/** Maps one page of Omi memories onto the upsert payload shape. */
function collectMemories(batch, memories) {
  for (const m of batch) {
    const id = String(m?.id ?? '').trim();
    const content = String(m?.content ?? '').trim();
    if (!id || !content) continue;
    memories.push({
      omi_memory_id: id,
      // Scrubbed BEFORE it reaches the database, like every other Omi path.
      description: `[Omi memory] ${stripPii(content)}`,
      raw: {
        source: 'omi',
        source_type: 'memory',
        omi_memory_id: id,
        omi_category: m?.category ?? null,
        omi_tags: Array.isArray(m?.tags) ? m.tags : [],
        omi_visibility: m?.visibility ?? null,
        manually_added: m?.manually_added === true,
        confidence_label: 'unconfirmed',
        evidence: 'omi /user/memories',
        extraction_via: 'structured',
        memory_created_at: m?.created_at ?? null,
      },
    });
  }
}

// ─── 3. Action items ───────────────────────────────────────────────────────
/**
 * EXPECT AN EMPTY ARRAY. Verified 2026-09-14: Omi writes extracted action items
 * as candidates that never reach the task store and expire in about two days,
 * so this endpoint returns [] while 61 real items sit inside the conversations.
 * The items we want arrive through pullConversations; this pass exists only to
 * catch anything Omi DOES put in the task store — including tasks we ourselves
 * created, which is why the loop guard is here.
 *
 * [] IS THE HEALTHY ANSWER. It must never count as a failure, never bump
 * consecutive_failures and never fire the alarm. CLAUDE.md: classify before you
 * threshold — an alarm that cries wolf on the normal case gets muted, and a
 * muted alarm is how an outage goes unnoticed for 47 hours.
 */
async function pullActionItems(client, db, { mode }) {
  const open = await client.listActionItems({ completed: false });
  if (!open.length) {
    return { seen: 0, ingested: 0, empty_endpoint: true, note: 'expected — Omi task store is empty by design' };
  }

  // Loop guard: anything already linked to a Reece row is ours.
  const ids = open.map((i) => String(i?.id ?? '')).filter(Boolean);
  const known = new Set();
  if (ids.length) {
    const res = await db.from('claude_pending_items')
      .select('id, omi_action_item_id, status')
      .in('omi_action_item_id', ids);
    if (res?.error) throw new Error(`omi action-item loop guard: ${res.error.message}`);
    for (const row of res.data || []) known.add(String(row.omi_action_item_id));
  }

  const fresh = open.filter((i) => !known.has(String(i?.id ?? '')));
  return {
    seen: open.length,
    ingested: 0,
    skipped_ours: open.length - fresh.length,
    unlinked: fresh.length,
    mode,
    // Deliberately not ingested here: a task with no conversation behind it has
    // no evidence, and every path into claude_pending_items in this system
    // carries where it came from. If Omi ever starts populating this endpoint,
    // this is the hook — and the count above says when that day arrives.
    note: fresh.length ? 'unlinked Omi tasks seen — Omi has started populating the task store' : null,
  };
}

/**
 * The one line anyone reads before deciding to go live, so it names its units.
 * `seen` counts CONVERSATIONS while `ingested` counts the pending ITEMS they
 * yield — reporting both as bare numbers read as a discrepancy (136 seen vs 87
 * ingested vs 59 skipped, which does not add up until you know 77 conversations
 * produced those 87 items). 2026-09-15.
 */
function shadowNote(kind, step, deep) {
  const prefix = deep ? 'deep sweep: ' : '';
  if (kind !== 'conversations') {
    return `${prefix}would ingest ${step.ingested ?? 0} row(s) from ${kind}`;
  }
  return `${prefix}would ingest ${step.ingested ?? 0} item(s) from `
    + `${step.conversations_with_content ?? 0} of ${step.seen ?? 0} conversation(s) `
    + `(${step.no_content ?? 0} had no content, ${step.duplicates ?? 0} already ingested)`;
}

// ─── The run ───────────────────────────────────────────────────────────────
/**
 * @param {object} opts
 *   dry_run  plan only, write nothing (forces shadow behaviour for this call)
 *   kinds    subset of PULL_KINDS; defaults to all
 *   deps     { db, client, fetch, env, now, embed, llm, postGroupMe }
 */
export async function runOmiPull({ dry_run = false, deep = false, kinds = null, deps = {} } = {}) {
  const env = deps.env || process.env;
  const now = deps.now || (() => new Date());
  const cfg = getPullConfig(env);
  const mode = dry_run ? 'shadow' : cfg.mode;
  const want = new Set(Array.isArray(kinds) && kinds.length ? kinds : PULL_KINDS);

  const started = Date.now();
  const result = { ok: true, mode, dry_run, deep, kinds: [...want], steps: {}, errors: [] };

  if (mode === 'off') {
    result.skipped = 'OMI_PULL_MODE=off';
    return result;
  }

  const db = deps.db || guardedDb(supabase);
  const client = deps.client || createOmiClient({ fetch: deps.fetch, env, sleep: deps.sleep });

  for (const kind of PULL_KINDS) {
    if (!want.has(kind)) continue;
    if (kind === 'writeback' && !cfg.writeback) {
      result.steps.writeback = { skipped: 'OMI_TASK_WRITEBACK=false' };
      continue;
    }

    let prev = null;
    try {
      prev = await readSync(db, kind);
      let step;
      if (kind === 'conversations') {
        step = await pullConversations(client, db, { cfg, env, now, deps, sync: prev, deep });
      } else if (kind === 'memories') {
        step = await pullMemories(client, db, { cfg, now, mode });
      } else if (kind === 'action_items') {
        step = await pullActionItems(client, db, { mode });
      } else {
        step = await pushTasksToOmi({ deps: { ...deps, db, client, env }, dry_run: mode !== 'live' });
      }

      result.steps[kind] = step;
      await writeSync(db, kind, {
        ok: true, cursor: step.cursor, seen: step.seen, ingested: step.ingested, prev,
      });

      if (mode === 'shadow') {
        await logPull(db, {
          check_name: 'omi:pull_shadow',
          mode: 'shadow',
          rows_checked: step.seen ?? 0,
          rows_flagged: step.ingested ?? 0,
          sample: { kind, ...step },
          notes: shadowNote(kind, step, deep),
        });
      }
    } catch (err) {
      // A spent request budget is a stopping point, not a failure: the cursor is
      // untouched and the next tick resumes. Recording it as a failure would
      // walk a healthy pull towards the alarm three ticks later.
      if (err?.budgetExhausted) {
        result.steps[kind] = { stopped: 'request_budget', note: err.message };
        await writeSync(db, kind, { ok: true, seen: 0, ingested: 0, prev });
        break;
      }

      result.ok = false;
      result.errors.push(`${kind}: ${err.message}`);
      const failures = await writeSync(db, kind, { ok: false, error: err.message, prev })
        .catch(() => Number(prev?.consecutive_failures || 0) + 1);

      if (err instanceof OmiAuthError) {
        // The message IS the fix. Say it once, plainly, and stop the run — every
        // further call would fail the same way and burn the rate limit doing it.
        result.steps[kind] = { failed: 'auth', message: err.message };
        await alertOps(`Omi pull stopped: ${err.message}`, deps);
        break;
      }

      result.steps[kind] = { failed: err.message, consecutive_failures: failures };
      if (failures === ALERT_AFTER_FAILURES) {
        await alertOps(
          `Omi pull (${kind}) has failed ${failures} times in a row. Latest: ${err.message}`,
          deps,
        );
      }
    }
  }

  result.elapsed_ms = Date.now() - started;
  result.api_requests = client.stats ? client.stats().requests : null;
  return result;
}

// ─── Scheduler ─────────────────────────────────────────────────────────────
// Same five-minute tick as memory-nightly.js: the timer is cheap, the decision
// to run is a pure function, and unref() keeps it from holding the process open.
let timer = null;
let lastRunAt = 0;

/** Pure, so the interval logic is testable without waiting for one. */
export function shouldRun({ nowMs, lastRunAt: last, intervalMin }) {
  if (!last) return true;
  return nowMs - last >= intervalMin * 60 * 1000;
}

export function startOmiPullScheduler(env = process.env) {
  if (timer) return timer;
  const cfg = getPullConfig(env);
  if (cfg.mode === 'off') {
    console.log('[OmiPull] scheduler not started (OMI_PULL_MODE=off)');
    return null;
  }
  const tick = async () => {
    if (!shouldRun({ nowMs: Date.now(), lastRunAt, intervalMin: cfg.intervalMin })) return;
    lastRunAt = Date.now(); // claim before awaiting, so a slow run cannot overlap itself
    try {
      const { value: res } = await runJob('omi-pull', () => runOmiPull());
      if (res && !res.ok) console.warn(`[OmiPull] run finished with errors: ${res.errors.join('; ')}`);
    } catch (err) {
      console.error(`[OmiPull] run threw: ${err.message}`);
    }
  };
  timer = setInterval(tick, 5 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[OmiPull] scheduler started — mode ${cfg.mode}, every ${cfg.intervalMin}m`);
  return timer;
}

export function stopOmiPullScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

export async function getOmiPullStatus({ db: injected } = {}) {
  const db = injected || guardedDb(supabase);
  const res = await db.from('claude_omi_sync').select('*');
  if (res?.error) throw new Error(`claude_omi_sync status: ${res.error.message}`);
  const cfg = getPullConfig();
  return {
    mode: cfg.mode,
    interval_min: cfg.intervalMin,
    writeback: cfg.writeback,
    scheduler_running: Boolean(timer),
    last_tick_at: lastRunAt ? new Date(lastRunAt).toISOString() : null,
    kinds: res?.data || [],
  };
}

export default { runOmiPull, startOmiPullScheduler, stopOmiPullScheduler, getOmiPullStatus, getPullMode };
