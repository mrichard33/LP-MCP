/**
 * Workflow Canonical Map Refresh — src/jobs/workflow-canonical-map-refresh.js
 *
 * Keeps the LP-side `workflow_canonical_map` mirror current with the canonical
 * `workflow_registry` that lives in the HL Supabase.
 *
 *   HL workflow_registry  ──(this job)──▶  LP workflow_canonical_map
 *   (canonical_code, workflow_id, …)        (canonical_code → workflow_id)
 *
 * The mirror is read by resolveWorkflowTarget() in
 * src/actions/handlers/workflows.js: when an agent_rule action omits a literal
 * workflow_id and supplies a canonical_code, the resolver looks up the current
 * published UUID here. That retires the RC3 stale-UUID bug class — a workflow
 * version bump updates one mirror row instead of every rule that hardcoded the
 * old UUID. But a mirror that is populated once and then drifts is just another
 * stale pointer; THIS job is what makes the mirror trustworthy.
 *
 * DIRECT HL SUPABASE PATH (deliberate)
 * ────────────────────────────────────
 *   Reads HL via a dedicated PostgREST client built from HL_SUPABASE_URL +
 *   HL_SUPABASE_SERVICE_ROLE_KEY — NOT through the HL MCP HTTP API. The HL MCP
 *   transport dropped twice in one session (2026-06-10 stability finding); the
 *   refresh must not depend on the link that has already failed. Same reason
 *   it self-drives on an in-process interval rather than an n8n cron — n8n's
 *   Decision Engine Heartbeat went silently dormant twice (see
 *   decision-engine-heartbeat history). HL_MCP_URL + HL_INTERNAL_TOKEN remain a
 *   documented fallback only.
 *
 * SAFETY
 * ──────
 *   - Fail-soft: a failed registry read or upsert leaves the last-good mirror
 *     in place (never empties or partially clears it) and fires a GroupMe alert.
 *   - updated_at bumps only when a row's workflow_id actually CHANGED (a version
 *     bump); refreshed_at bumps every run so staleness is monitorable even when
 *     nothing changed.
 *   - Codes present in the mirror but ABSENT from the registry are reported as
 *     orphans but NOT auto-deleted (deletion is a human decision).
 *
 * ENDPOINTS / SCHEDULE
 * ────────────────────
 *   POST /n8n/workflow-map/refresh   { dry_run? }   — manual/secondary trigger
 *   GET  /n8n/workflow-map/status                    — row count + staleness
 *   startWorkflowCanonicalMapRefreshLoop()           — in-process 15-min loop
 *     env: WORKFLOW_MAP_REFRESH_ENABLED       (default 'true')
 *          WORKFLOW_MAP_REFRESH_INTERVAL_MS   (default 900000 = 15 min)
 *          WORKFLOW_MAP_STALE_ALERT_MS        (default 2700000 = 45 min)
 */

import { createClient } from '@supabase/supabase-js';
import supabase from '../supabase.js';

const HL_SUPABASE_URL = process.env.HL_SUPABASE_URL;
const HL_SUPABASE_SERVICE_ROLE_KEY = process.env.HL_SUPABASE_SERVICE_ROLE_KEY;

const REFRESH_INTERVAL_MS = Number(process.env.WORKFLOW_MAP_REFRESH_INTERVAL_MS) || 900000;   // 15 min
const STALE_ALERT_MS = Number(process.env.WORKFLOW_MAP_STALE_ALERT_MS) || 2700000;            // 45 min (~3 missed cycles)

// Dedicated HL Supabase client (direct path — bypasses the HL MCP layer).
const hlSupabase = HL_SUPABASE_URL && HL_SUPABASE_SERVICE_ROLE_KEY
  ? createClient(HL_SUPABASE_URL, HL_SUPABASE_SERVICE_ROLE_KEY)
  : null;

let lastRunSummary = null;   // in-memory snapshot of the most recent loop tick

/**
 * Best-effort GroupMe alert. Inline minimal bot post (no import coupling) so a
 * refresh failure surfaces to the team. Never throws.
 */
async function alertGroupMe(text) {
  const botId = process.env.GROUPME_BOT_ID;
  if (!botId) {
    console.warn('[WorkflowMapRefresh] GROUPME_BOT_ID unset — alert suppressed:', text);
    return;
  }
  try {
    await fetch('https://api.groupme.com/v3/bots/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_id: botId, text: `⚠️ workflow_canonical_map refresh — ${text}` }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    console.warn('[WorkflowMapRefresh] GroupMe alert failed:', err.message);
  }
}

/**
 * Refresh the LP workflow_canonical_map mirror from the HL workflow_registry.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.dry_run=false] When true, computes the diff against the
 *        current mirror but writes nothing.
 * @returns {Promise<object>} structured result (never throws on expected failure)
 */
export async function refreshWorkflowCanonicalMap(opts = {}) {
  const dryRun = opts.dry_run === true;
  const startedAt = Date.now();

  if (!hlSupabase) {
    const result = {
      success: false,
      error: 'HL Supabase client unavailable',
      remedy: 'Set HL_SUPABASE_URL + HL_SUPABASE_SERVICE_ROLE_KEY in the LP Railway service',
      elapsed_ms: Date.now() - startedAt,
    };
    await alertGroupMe('HL Supabase client unavailable (missing HL_SUPABASE_URL / HL_SUPABASE_SERVICE_ROLE_KEY)');
    return result;
  }
  if (!supabase) {
    return { success: false, error: 'LP Supabase client unavailable', elapsed_ms: Date.now() - startedAt };
  }

  // ── 1. Read canonical source of truth from HL ──────────────────
  const { data: registryRows, error: hlError } = await hlSupabase
    .from('workflow_registry')
    .select('canonical_code, workflow_id, canonical_name, stage_family')
    .not('workflow_id', 'is', null);

  if (hlError) {
    console.error('[WorkflowMapRefresh] HL registry read failed:', hlError.message);
    await alertGroupMe(`HL registry read failed: ${hlError.message} — last-good mirror left in place`);
    return { success: false, error: `HL registry read failed: ${hlError.message}`, elapsed_ms: Date.now() - startedAt };
  }
  if (!Array.isArray(registryRows) || registryRows.length === 0) {
    // Defensive: never let an empty/garbled read wipe the mirror.
    console.error('[WorkflowMapRefresh] HL registry returned 0 rows — refusing to touch mirror');
    await alertGroupMe('HL registry returned 0 rows — refresh aborted, last-good mirror left in place');
    return { success: false, error: 'HL registry returned 0 rows — aborted (mirror untouched)', elapsed_ms: Date.now() - startedAt };
  }

  // ── 2. Load current mirror to compute the diff ─────────────────
  const { data: currentRows, error: lpReadError } = await supabase
    .from('workflow_canonical_map')
    .select('canonical_code, workflow_id, updated_at');
  if (lpReadError) {
    console.error('[WorkflowMapRefresh] mirror read failed:', lpReadError.message);
    return { success: false, error: `mirror read failed: ${lpReadError.message}`, elapsed_ms: Date.now() - startedAt };
  }

  const currentById = new Map((currentRows || []).map(r => [r.canonical_code, r]));
  const registryCodes = new Set(registryRows.map(r => r.canonical_code));
  const nowIso = new Date().toISOString();

  let inserted = 0, changed = 0, unchanged = 0;
  const upsertRows = registryRows.map(r => {
    const existing = currentById.get(r.canonical_code);
    let updatedAt;
    if (!existing) { inserted++; updatedAt = nowIso; }
    else if (existing.workflow_id !== r.workflow_id) { changed++; updatedAt = nowIso; }
    else { unchanged++; updatedAt = existing.updated_at; }   // preserve original change timestamp
    return {
      canonical_code: r.canonical_code,
      workflow_id: r.workflow_id,
      canonical_name: r.canonical_name ?? null,
      stage_family: r.stage_family ?? null,
      updated_at: updatedAt,
      refreshed_at: nowIso,
    };
  });

  // Orphans: in the mirror but no longer in the registry. Report, do not delete.
  const orphans = (currentRows || [])
    .map(r => r.canonical_code)
    .filter(code => !registryCodes.has(code));

  if (dryRun) {
    return {
      success: true, dry_run: true,
      registry_rows: registryRows.length,
      would_insert: inserted, would_change: changed, would_keep: unchanged,
      orphan_codes: orphans,
      elapsed_ms: Date.now() - startedAt,
    };
  }

  // ── 3. Upsert the mirror ───────────────────────────────────────
  const { error: upsertError } = await supabase
    .from('workflow_canonical_map')
    .upsert(upsertRows, { onConflict: 'canonical_code' });
  if (upsertError) {
    console.error('[WorkflowMapRefresh] mirror upsert failed:', upsertError.message);
    await alertGroupMe(`mirror upsert failed: ${upsertError.message} — last-good mirror left in place`);
    return { success: false, error: `mirror upsert failed: ${upsertError.message}`, elapsed_ms: Date.now() - startedAt };
  }

  const summary = {
    success: true,
    registry_rows: registryRows.length,
    inserted, changed, unchanged,
    orphan_codes: orphans,
    refreshed_at: nowIso,
    elapsed_ms: Date.now() - startedAt,
  };
  console.log(
    `[WorkflowMapRefresh] done rows=${registryRows.length} inserted=${inserted} ` +
    `changed=${changed} unchanged=${unchanged} orphans=${orphans.length} elapsed=${summary.elapsed_ms}ms`
  );
  if (changed > 0) {
    console.log(`[WorkflowMapRefresh] ${changed} workflow_id(s) changed this run (version bump) — resolver now points at the new UUID`);
  }
  if (orphans.length > 0) {
    console.warn(`[WorkflowMapRefresh] ${orphans.length} orphan code(s) in mirror not in registry (not deleted): ${orphans.join(', ')}`);
  }
  return summary;
}

/**
 * In-process scheduled refresh. Self-driving so the mirror does not depend on
 * n8n (which has a silent-dormant history) or the HL MCP (which has dropped).
 * Runs once shortly after boot, then every WORKFLOW_MAP_REFRESH_INTERVAL_MS.
 * Fires a GroupMe alert if a tick fails or the mirror goes stale.
 */
export function startWorkflowCanonicalMapRefreshLoop() {
  if (String(process.env.WORKFLOW_MAP_REFRESH_ENABLED || 'true').toLowerCase() === 'false') {
    console.log('[WorkflowMapRefresh] loop disabled via WORKFLOW_MAP_REFRESH_ENABLED=false');
    return null;
  }

  const tick = async () => {
    try {
      const result = await refreshWorkflowCanonicalMap();
      lastRunSummary = { ...result, ranAt: new Date().toISOString() };
      if (!result.success) {
        await alertGroupMe(`refresh tick failed: ${result.error}`);
      }
    } catch (err) {
      lastRunSummary = { success: false, error: err.message, ranAt: new Date().toISOString() };
      console.error('[WorkflowMapRefresh] tick threw:', err.message);
      await alertGroupMe(`refresh tick threw: ${err.message}`);
    }
  };

  // First run 30s after boot (let the process settle), then on the interval.
  setTimeout(tick, 30000);
  const handle = setInterval(tick, REFRESH_INTERVAL_MS);
  if (typeof handle.unref === 'function') handle.unref();
  console.log(`[WorkflowMapRefresh] loop started — every ${Math.round(REFRESH_INTERVAL_MS / 60000)}min (first run in 30s)`);
  return handle;
}

/**
 * Register HTTP endpoints (manual/secondary trigger + status).
 */
export function registerWorkflowCanonicalMapRoutes(app) {
  app.post('/n8n/workflow-map/refresh', async (req, res) => {
    try {
      const result = await refreshWorkflowCanonicalMap({ dry_run: req.body?.dry_run === true });
      res.json(result);
    } catch (err) {
      console.error('[WorkflowMapRefresh] /refresh error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/n8n/workflow-map/status', async (req, res) => {
    try {
      const { count: totalRows } = await supabase
        .from('workflow_canonical_map')
        .select('canonical_code', { count: 'exact', head: true });

      const { data: freshest } = await supabase
        .from('workflow_canonical_map')
        .select('refreshed_at')
        .order('refreshed_at', { ascending: false })
        .limit(1);

      const newestRefresh = freshest?.[0]?.refreshed_at || null;
      const staleMs = newestRefresh ? (Date.now() - Date.parse(newestRefresh)) : null;
      const isStale = staleMs != null && staleMs > STALE_ALERT_MS;

      res.json({
        success: true,
        total_rows: totalRows || 0,
        newest_refresh: newestRefresh,
        stale_ms: staleMs,
        is_stale: isStale,
        stale_threshold_ms: STALE_ALERT_MS,
        last_loop_run: lastRunSummary,
        config: {
          refresh_interval_ms: REFRESH_INTERVAL_MS,
          loop_enabled: String(process.env.WORKFLOW_MAP_REFRESH_ENABLED || 'true').toLowerCase() !== 'false',
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('[WorkflowMapRefresh] Routes registered: POST /n8n/workflow-map/refresh | GET /n8n/workflow-map/status');
}
