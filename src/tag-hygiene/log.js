/**
 * tag_hygiene_log writer and reader — src/tag-hygiene/log.js
 *
 * 2026-09-22 — one table records every decision made by the daily tag sweep
 * (src/jobs/tag-hygiene-sweep.js), the L.6 auto-call after a P2 loss
 * (src/loss-routing/l6.js) and the one-time loss-routing backfills
 * (scripts/backfill-loss-routing.js). DDL: sql/migrations/2026-09-22_tag_hygiene_log.sql,
 * applied by hand in the LP Supabase dashboard.
 *
 * FAIL SAFE WHEN THE TABLE IS MISSING. Code ships before the migration is run,
 * so a missing table must never break the sweep or the executor: the writer
 * logs one warning and carries on. The READER is different — the L.6 post uses
 * it as its idempotency record, so "could not read" returns null and the caller
 * refuses to post. Posting twice to L.6 re-routes a contact twice; not posting
 * leaves it for the next pass. See reportAlertCondition's three-way `active`
 * in src/alert-state.js for the same true / false / null discipline.
 */

export const TABLE = 'tag_hygiene_log';

const MISSING_TABLE_RE = /does not exist|could not find the table|schema cache|42P01|PGRST205/i;

export function isMissingTable(err) {
  return Boolean(err) && (err.code === '42P01' || err.code === 'PGRST205' || MISSING_TABLE_RE.test(err.message || ''));
}

let warnedMissing = false;

async function resolveSupabase(deps) {
  if (deps && 'supabase' in deps) return deps.supabase;
  const { default: supabase } = await import('../supabase.js');
  return supabase;
}

function normalizeRow(row) {
  return {
    run_id: String(row.run_id),
    run_type: row.run_type,
    mode: row.mode,
    contact_id: row.contact_id ?? null,
    opportunity_id: row.opportunity_id ?? null,
    rule: row.rule,
    action: row.action,
    tags: Array.isArray(row.tags) && row.tags.length ? row.tags : null,
    detail: row.detail ?? null,
  };
}

/**
 * Insert one or more decision rows. Never throws.
 * @returns {Promise<{ logged: boolean, count?: number, missingTable?: boolean, error?: string }>}
 */
export async function logHygiene(rows, deps = {}) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean).map(normalizeRow);
  if (list.length === 0) return { logged: true, count: 0 };
  try {
    const supabase = await resolveSupabase(deps);
    if (!supabase) return { logged: false, error: 'supabase_unconfigured' };
    const { error } = await supabase.from(TABLE).insert(list);
    if (error) {
      if (isMissingTable(error)) {
        if (!warnedMissing) {
          warnedMissing = true;
          console.warn(`[TagHygiene] ${TABLE} missing — apply sql/migrations/2026-09-22_tag_hygiene_log.sql; decisions are not being recorded`);
        }
        return { logged: false, missingTable: true };
      }
      console.error(`[TagHygiene] log insert failed: ${error.message}`);
      return { logged: false, error: error.message };
    }
    return { logged: true, count: list.length };
  } catch (err) {
    console.error(`[TagHygiene] log insert threw: ${err.message}`);
    return { logged: false, error: err.message };
  }
}

/**
 * Has L.6 already been posted for this opportunity?
 *
 * Only `mode='apply'` rows count. A dry run logs the SAME action it would have
 * taken (posted_l6) under mode='report' so its report reads like the real run;
 * those rows must never make a later real run skip the contact.
 * @returns {Promise<true|false|null>} null = could not tell (read failed or table missing).
 */
export async function hasPostedL6(opportunityId, deps = {}) {
  if (!opportunityId) return null;
  try {
    const supabase = await resolveSupabase(deps);
    if (!supabase) return null;
    const { data, error } = await supabase.from(TABLE)
      .select('id')
      .eq('opportunity_id', String(opportunityId))
      .eq('action', 'posted_l6')
      .eq('mode', 'apply')
      .limit(1);
    if (error) return null;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return null;
  }
}

/**
 * Is the table there? Used by the backfill to refuse --apply without its
 * idempotency record. true / false / null (could not tell).
 */
export async function tableExists(deps = {}) {
  try {
    const supabase = await resolveSupabase(deps);
    if (!supabase) return null;
    const { error } = await supabase.from(TABLE).select('id').limit(1);
    if (!error) return true;
    return isMissingTable(error) ? false : null;
  } catch {
    return null;
  }
}

export function __resetLogWarningForTests() { warnedMissing = false; }
