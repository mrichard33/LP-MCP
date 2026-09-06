/**
 * Nightly memory job — src/jobs/memory-nightly.js  (priority #8, 2026-09-06)
 *
 * Keeps the claude_* memory tier current without a human in the loop:
 *   1. stale flags   — decision #1678: an open defect with no verification in
 *                      60+ days and no touch in 60+ days (updated_at for live
 *                      rows, reported_date for retro rows) is stale=true.
 *                      The job never clears stale — verification does.
 *   2. re-embed      — memory-embed.js planKind/executePlan for all four kinds;
 *                      content-hash incremental, so a quiet day writes 0 rows.
 *   3. workflow ref  — claude_workflow_ref (sql/092) refreshed from the LP-side
 *                      workflow_canonical_map mirror (itself synced from the HL
 *                      workflow_registry every 15 min). No HL dependency here.
 *   4. snapshot      — counts from claude_memory_context(NULL) logged for the
 *                      record.
 *
 * What it does NOT do: read Claude chats. LP-MCP has no path to transcripts,
 * so un-checkpointed chats are still Mark's refresh pass; every other surface
 * checkpoints itself through the memory_checkpoint tool.
 *
 * SCHEDULE: daily at MEMORY_NIGHTLY_HOUR_ET (default 3) — same 5-minute
 * hour-check pattern as market-assignment-daily.js.
 * ROUTES:   POST /admin/memory/nightly { dry_run? }   GET /admin/memory/nightly/status
 * ENV:      MEMORY_NIGHTLY_ENABLED (default true), MEMORY_NIGHTLY_HOUR_ET (default 3)
 */
import supabase from '../supabase.js';
import { runSQL } from '../admin/supabase-admin.js';
import { SOURCES } from '../memory/memory-text.js';

const TIMEZONE = 'America/New_York';
const STALE_DAYS = 60;

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

function todayET(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
function hourET(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: '2-digit', hour12: false }).formatToParts(now);
  return Number(parts.find((p) => p.type === 'hour')?.value ?? -1) % 24;
}

/** Pure: should the tick fire now? Exported for tests. */
export function shouldRun({ hour, today, lastRunDate, targetHour }) {
  return hour === targetHour && lastRunDate !== today;
}

async function alertGroupMe(text) {
  const botId = process.env.GROUPME_BOT_ID;
  if (!botId) { console.warn('[MemoryNightly] GROUPME_BOT_ID unset — alert suppressed:', text); return; }
  try {
    await fetch('https://api.groupme.com/v3/bots/post', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_id: botId, text: `⚠️ memory nightly — ${text}` }), signal: AbortSignal.timeout(8000),
    });
  } catch (err) { console.warn('[MemoryNightly] GroupMe alert failed:', err.message); }
}

let lastRun = null;

/**
 * Run the job. dry_run computes the embed plan and counts but writes nothing
 * (stale UPDATE and workflow-ref upsert are skipped, not simulated).
 */
export async function runMemoryNightly({ dry_run = false, deps = {} } = {}) {
  const startedAt = Date.now();
  const result = { started_at: new Date().toISOString(), dry_run, stale_flagged: null, embed: {}, workflow_ref: null, counts: null, errors: [] };
  const sql = deps.runSQL || runSQL;
  const db = deps.supabase || supabase;

  if (!dry_run) {
    try { const rows = await sql(STALE_SQL); result.stale_flagged = Array.isArray(rows) ? rows.length : 0; }
    catch (err) { result.errors.push(`stale: ${err.message}`); }
  }

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

  if (!dry_run) {
    try { const rows = await sql(WORKFLOW_REF_SQL); result.workflow_ref = Array.isArray(rows) ? rows.length : 0; }
    catch (err) { result.errors.push(`workflow_ref: ${err.message}`); }
  }

  try {
    const { data, error } = await db.rpc('claude_memory_context', { p_topic: null });
    if (error) throw new Error(error.message);
    result.counts = data?.counts ?? null;
  } catch (err) { result.errors.push(`counts: ${err.message}`); }

  result.elapsed_ms = Date.now() - startedAt;
  result.ok = result.errors.length === 0;
  lastRun = result;
  console.log(`[MemoryNightly] ${dry_run ? 'DRY-RUN ' : ''}done stale=${result.stale_flagged} embed=${JSON.stringify(Object.fromEntries(Object.entries(result.embed).map(([k, v]) => [k, v.written])))} ref=${result.workflow_ref} errors=${result.errors.length} elapsed=${result.elapsed_ms}ms`);
  if (!result.ok && !dry_run) await alertGroupMe(result.errors.join(' | '));
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
    try { await runMemoryNightly(); }
    catch (err) { console.error('[MemoryNightly] run threw:', err.message); await alertGroupMe(`run threw: ${err.message}`); }
  };
  timer = setInterval(tick, 5 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[MemoryNightly] scheduler started — daily at ${String(targetHour).padStart(2, '0')}:00 ET`);
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
    res.json({ last_run: lastRun, last_run_date: lastRunDate, enabled: String(process.env.MEMORY_NIGHTLY_ENABLED || 'true').toLowerCase() !== 'false', hour_et: Number(process.env.MEMORY_NIGHTLY_HOUR_ET || 3) });
  });
  console.log(`[MemoryNightly] Routes: POST /admin/memory/nightly (dry_run:true = plan only) | GET /admin/memory/nightly/status${guards.length ? ' (authenticated)' : ' (UNAUTHENTICATED)'}`);
}
