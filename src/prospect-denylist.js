// ─── Prospect Deny-List — src/prospect-denylist.js ─────────────────
//
// Tracks LP cstIds that consistently time out during sync. Provides
// a self-managing skip mechanism to prevent 20-50 chronically-broken
// cstIds from consuming the bulk of every sync cycle's wall-clock
// budget.
//
// API:
//   loadActiveDenylist()              → Set<string>  of cstIds currently denied
//   recordProspectFailure(cstId,reason) → { denylisted, denylisted_until?, consecutive_failures }
//   recordProspectSuccess(cstId)      → void (clears any failure history)
//   getDenylistStats()                → counts + thresholds (observability)
//
// Tuning knobs (env or defaults):
//   PROSPECT_DENYLIST_THRESHOLD=5          (consecutive failures → denylist)
//   PROSPECT_DENYLIST_DURATION_HOURS=24    (active denylist duration)
//
// State machine:
//   no row              ─[failure]─→ row, consecutive=1, denylisted_until=null
//   below threshold     ─[failure]─→ ++consecutive, denylisted_until=null
//   crosses threshold   ─[failure]─→ ++consecutive, denylisted_until=now+24h
//   denylisted          ─[skip in sweep, no API call]
//   denylist expired    ─[failure]─→ ++consecutive, denylisted_until=now+24h (extended)
//   any                 ─[success]─→ row deleted (clean slate)
//
// Why "consecutive" rather than rolling-window: simpler, and the
// observed pattern is 100%-failure cstIds, not flaky ones. A flaky
// prospect that sometimes succeeds will reset its counter and avoid
// denylist. If LP fixes a broken record, the next sync succeeds and
// clears the row. No manual intervention needed.
//
// Failure mode: all functions fail-open. If supabase is unavailable,
// loadActiveDenylist returns empty Set (= treat all as healthy), and
// the record* functions silently log + return. This keeps sync working
// even if the deny-list infrastructure is degraded.
//
// Substrate: sql/migrations/2026-05-21_prospect_denylist.sql

import supabase from './supabase.js';

const DENYLIST_THRESHOLD = Number(process.env.PROSPECT_DENYLIST_THRESHOLD || 5);
const DENYLIST_DURATION_HOURS = Number(process.env.PROSPECT_DENYLIST_DURATION_HOURS || 24);

/**
 * Load the current active denylist as a Set of cstId strings.
 * "Active" = denylisted_until > now().
 *
 * Called once at the start of each leads sweep to short-circuit
 * processProspect for known-bad cstIds. New denylist entries added
 * mid-sweep should be appended to this Set by the caller for
 * defense-in-depth (covered in sync-engine.js v6.10).
 */
export async function loadActiveDenylist() {
  try {
    const { data, error } = await supabase
      .from('lp_prospect_denylist')
      .select('cst_id')
      .gt('denylisted_until', new Date().toISOString());
    if (error) {
      console.warn(`[Denylist] load failed: ${error.message} — proceeding with empty denylist`);
      return new Set();
    }
    return new Set((data || []).map(r => String(r.cst_id)));
  } catch (err) {
    console.warn(`[Denylist] load threw: ${err.message} — proceeding with empty denylist`);
    return new Set();
  }
}

/**
 * Record a failure for a cstId. Increments consecutive_failures and,
 * if the threshold is crossed, sets denylisted_until = now + DURATION.
 *
 * Returns an object indicating the new state:
 *   { denylisted: true,  denylisted_until: '...', consecutive_failures: N }  — newly added (or extended) on denylist
 *   { denylisted: false, consecutive_failures: N }                          — incremented but not yet over threshold
 *   { denylisted: false, error: '...' }                                     — supabase or input error (fail-open)
 *
 * Caller should inspect the return to decide whether to log the
 * denylist transition. recordProspectFailure itself logs the
 * first-time transition to console.warn but not subsequent extensions.
 */
export async function recordProspectFailure(cstId, reason = 'prospect timeout') {
  if (!cstId) return { denylisted: false, error: 'no_cstId' };
  const id = String(cstId);
  const now = new Date();
  const nowIso = now.toISOString();
  const denylistUntilIso = new Date(now.getTime() + DENYLIST_DURATION_HOURS * 3600 * 1000).toISOString();

  try {
    // Read existing state (cheap PK lookup).
    const { data: existing } = await supabase
      .from('lp_prospect_denylist')
      .select('consecutive_failures, denylisted_until, first_failed_at')
      .eq('cst_id', id)
      .maybeSingle();

    const prevCount = existing?.consecutive_failures || 0;
    const newCount = prevCount + 1;
    const willDenylist = newCount >= DENYLIST_THRESHOLD;
    const wasAlreadyDenylisted = existing?.denylisted_until && new Date(existing.denylisted_until) > now;

    const row = {
      cst_id: id,
      consecutive_failures: newCount,
      last_failed_at: nowIso,
      first_failed_at: existing?.first_failed_at || nowIso,
      reason,
      updated_at: nowIso,
    };
    if (willDenylist) {
      // Always (re)set the active window on a fresh failure once over
      // threshold. If the previous denylist window expired and the
      // cstId failed again, we extend; if this is the first time
      // crossing, we set it.
      row.denylisted_at = existing?.denylisted_at || nowIso;
      row.denylisted_until = denylistUntilIso;
    }

    const { error: upsertErr } = await supabase
      .from('lp_prospect_denylist')
      .upsert(row, { onConflict: 'cst_id' });

    if (upsertErr) {
      console.warn(`[Denylist] upsert failed for cstId=${id}: ${upsertErr.message}`);
      return { denylisted: false, error: upsertErr.message };
    }

    if (willDenylist && !wasAlreadyDenylisted) {
      // First-time transition into active denylist — log loudly so
      // operators can see the deny-list grow in real time.
      console.warn(
        `[Denylist] cstId=${id} added — ${newCount} consecutive failures, ` +
        `denylisted until ${denylistUntilIso} (${DENYLIST_DURATION_HOURS}h). Reason: ${reason}`
      );
    }

    return willDenylist
      ? { denylisted: true, denylisted_until: denylistUntilIso, consecutive_failures: newCount }
      : { denylisted: false, consecutive_failures: newCount };
  } catch (err) {
    console.warn(`[Denylist] recordProspectFailure(${id}) threw: ${err.message}`);
    return { denylisted: false, error: err.message };
  }
}

/**
 * Clear the failure history for a cstId. Called after a successful
 * processProspect call. Deletes the row entirely — clean slate.
 *
 * If failures resume in the future, a new row is inserted by
 * recordProspectFailure with consecutive_failures=1 (not the old count),
 * giving the cstId a fresh threshold budget. This is intentional: a
 * cstId that succeeded once is "healthy enough" to start the counter
 * over.
 *
 * No-op if no row exists. Best-effort — never throws.
 */
export async function recordProspectSuccess(cstId) {
  if (!cstId) return;
  const id = String(cstId);
  try {
    await supabase.from('lp_prospect_denylist').delete().eq('cst_id', id);
  } catch (err) {
    // Best effort — don't break sync over deny-list housekeeping
    console.warn(`[Denylist] recordProspectSuccess(${id}) failed: ${err.message}`);
  }
}

/**
 * Observability — current deny-list stats.
 *
 * Returns:
 *   {
 *     active_denylist_count: N,    — currently denylisted (denylisted_until > now)
 *     total_tracked_count: M,      — total rows in table (active + below-threshold)
 *     threshold: T,                — consecutive failures needed to trigger denylist
 *     duration_hours: H            — denylist window duration
 *   }
 *
 * Useful from a debug route, GroupMe heartbeat, or a periodic admin
 * notification.
 */
export async function getDenylistStats() {
  try {
    const nowIso = new Date().toISOString();
    const { count: activeCount } = await supabase
      .from('lp_prospect_denylist')
      .select('*', { count: 'exact', head: true })
      .gt('denylisted_until', nowIso);
    const { count: totalCount } = await supabase
      .from('lp_prospect_denylist')
      .select('*', { count: 'exact', head: true });
    return {
      active_denylist_count: activeCount || 0,
      total_tracked_count: totalCount || 0,
      threshold: DENYLIST_THRESHOLD,
      duration_hours: DENYLIST_DURATION_HOURS,
    };
  } catch (err) {
    return { error: err.message };
  }
}
