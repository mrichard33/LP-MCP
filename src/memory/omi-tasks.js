/**
 * Omi task write-back — src/memory/omi-tasks.js
 *
 * Puts Reece to-dos onto Mark's Omi Tasks page.
 *
 * WHY THIS EXISTS. Checked live on 2026-09-14: GET /user/action-items returns
 * [] while 61 action items sit inside 100 conversations. Omi extracts items as
 * candidates that never reach the task store and expire after about two days —
 * so Mark's Tasks page shows nothing, while the things he actually said he
 * would do are stranded inside conversation records. POST /user/action-items
 * works. So we write them back, and the Tasks page becomes true.
 *
 * THE LOOP GUARD RUNS BOTH WAYS, and it is the whole safety story here:
 *
 *   • never push a row that already has omi_action_item_id — it IS already a
 *     task in Omi, and pushing again makes a second one;
 *   • never ingest an Omi task that carries an id we created — that is our own
 *     row coming home, and ingesting it makes a second to-do.
 *
 * Break either half and the two systems feed each other forever, quietly, at
 * fifteen-minute intervals. The column exists for exactly this (sql/112 A).
 *
 * A failed push is logged and skipped, never fatal: the Reece row is the record
 * of the work, the Omi task is a convenience, and a to-do must not be lost
 * because a third-party API had a bad minute. The row keeps
 * omi_action_item_id NULL and the next run retries it.
 *
 * v1.0 — 2026-09-14 (sql/112).
 */

import { createOmiClient } from './omi-client.js';
import { guardedDb } from './omi-db.js';
import supabase from '../supabase.js';

export const PUSH_SCOPES = new Set(['all', 'approved']);

/** Our own display tag. Omi's Tasks page should show the task, not our prefix. */
const OMI_PREFIX_RE = /^\s*\[Omi(?: memory| \d{4}-\d{2}-\d{2})\]\s*/i;
const CONFLICT_PREFIX_RE = /^CONFLICTS WITH #\d+\s*—\s*/;
const ISSUE_PREFIX_RE = /^Possible issue heard in Omi\s*—\s*/;

export function getTaskConfig(env = process.env) {
  const scope = String(env.OMI_TASK_PUSH_SCOPE || 'all').toLowerCase().trim();
  const max = Number(env.OMI_TASK_PUSH_MAX_PER_RUN);
  return {
    enabled: String(env.OMI_TASK_WRITEBACK || 'false').toLowerCase() === 'true',
    scope: PUSH_SCOPES.has(scope) ? scope : 'all',
    maxPerRun: Number.isFinite(max) ? Math.min(200, Math.max(1, max)) : 25,
  };
}

/** Strip our display prefixes so the Omi task reads like a task. */
export function taskTextOf(description) {
  return String(description || '')
    .replace(OMI_PREFIX_RE, '')
    .replace(CONFLICT_PREFIX_RE, '')
    .replace(ISSUE_PREFIX_RE, '')
    .trim();
}

/**
 * Scope 'all'      — everything Omi gave us that is still open work.
 * Scope 'approved' — only build to-dos a Command Center ruling created, i.e.
 *                    things Mark has actually said yes to. Narrower on purpose:
 *                    it is the setting for someone who wants their Tasks page to
 *                    be commitments rather than candidates.
 */
async function loadPushable(db, { scope, limit }) {
  const q = db.from('claude_pending_items')
    .select('id, description, item_type, origin, source_field, raw, status, omi_action_item_id')
    .eq('status', 'open')
    .is('omi_action_item_id', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  const res = scope === 'approved'
    ? await q.eq('item_type', 'build_needed').eq('source_field', 'rule')
    : await q.eq('origin', 'omi').eq('item_type', 'action_needed');

  if (res?.error) throw new Error(`omi writeback scan: ${res.error.message}`);
  return res.data || [];
}

/**
 * @param {object} opts
 *   limit    override OMI_TASK_PUSH_MAX_PER_RUN
 *   dry_run  select and report, push nothing
 *   deps     { db, client, env, fetch }
 */
export async function pushTasksToOmi({ limit = null, dry_run = false, deps = {} } = {}) {
  const env = deps.env || process.env;
  const cfg = getTaskConfig(env);
  if (!cfg.enabled) return { skipped: 'OMI_TASK_WRITEBACK=false', seen: 0, ingested: 0 };

  const db = deps.db || guardedDb(supabase);
  const client = deps.client || createOmiClient({ fetch: deps.fetch, env, sleep: deps.sleep });
  const max = limit || cfg.maxPerRun;

  const rows = await loadPushable(db, { scope: cfg.scope, limit: max });
  const result = {
    scope: cfg.scope, seen: rows.length, ingested: 0, pushed: 0, failed: 0,
    dry_run, ids: [], errors: [],
  };
  if (!rows.length) return result;

  for (const row of rows) {
    // Belt to the query's braces. The scan already filters on NULL, but this is
    // the guard that must never be wrong, so it is checked at the point of use
    // as well as in the WHERE clause.
    if (row.omi_action_item_id) continue;

    const description = taskTextOf(row.description);
    if (!description) continue;

    if (dry_run) { result.ids.push(row.id); continue; }

    try {
      const created = await client.createActionItem({
        description,
        due_at: row.raw?.due_at || null,
      });
      const omiId = String(created?.id ?? created?.action_item_id ?? '').trim();
      if (!omiId) throw new Error('Omi accepted the task but returned no id');

      // Stamp the id BEFORE counting it as pushed. If this update fails the row
      // stays NULL and the next run pushes again — a duplicate task is annoying;
      // losing the link means we can never tell the two apart.
      const upd = await db.from('claude_pending_items')
        .update({ omi_action_item_id: omiId, updated_at: new Date().toISOString() })
        .eq('id', row.id);
      if (upd?.error) throw new Error(`could not record the Omi id: ${upd.error.message}`);

      result.pushed += 1;
      result.ingested += 1;
      result.ids.push(row.id);
    } catch (err) {
      // Never fatal. The Reece row is the record; the Omi task is a convenience.
      result.failed += 1;
      result.errors.push(`#${row.id}: ${err.message}`);
      console.warn(`[OmiTasks] push failed for pending #${row.id}: ${err.message}`);
    }
  }

  return result;
}

/**
 * Called from memory-rule.js when a ruling files a build to-do. Best-effort and
 * never awaited into the ruling's own success: a ruling that wrote a decision
 * has done its job whether or not Omi heard about the follow-up.
 */
export async function pushRulingBuildItem(pendingId, { deps = {} } = {}) {
  const env = deps.env || process.env;
  const cfg = getTaskConfig(env);
  if (!cfg.enabled || !pendingId) return { skipped: true };
  try {
    return await pushTasksToOmi({ limit: 1, deps });
  } catch (err) {
    console.warn(`[OmiTasks] ruling push skipped for #${pendingId}: ${err.message}`);
    return { skipped: err.message };
  }
}

export default { pushTasksToOmi, pushRulingBuildItem, getTaskConfig, taskTextOf };
