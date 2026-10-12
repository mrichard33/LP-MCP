/**
 * mode-registry-sync.js — write every `*_MODE` flag's CURRENT value to
 * `feature_modes` at boot (Fix 2, 2026-10-12).
 *
 * The dashboard cannot read Railway variables, so without a stored answer a
 * feature deliberately left in shadow looks exactly like one nobody has
 * reviewed. This mirrors registerJobs (src/job-runner.js): resolve each flag
 * against this service's env, upsert, never throw. A missing table is a
 * logged condition, not a boot failure.
 *
 * When and how a value changes is recorded by the database itself: the
 * feature_modes trigger stamps state_changed_at and writes a
 * feature_mode_changes row (supabase/migrations/*_feature_modes.sql). Nothing
 * here decides or changes a flag.
 */

import supabase from './supabase.js';
import { MODES, resolveMode, stateOf } from './mode-registry.js';

export function modeRows(modes = MODES, { env = process.env, now = Date.now() } = {}) {
  const at = new Date(now).toISOString();
  return modes.map((e) => {
    const value = resolveMode(e, env);
    return {
      name: e.name,
      mode_group: e.group,
      kind: e.kind,
      current_value: value,
      current_state: stateOf(e, value),
      is_set: env[e.name] != null && String(env[e.name]).trim() !== '',
      default_value: e.default,
      allowed_values: [...e.values],
      live_values: [...e.live],
      shadow_values: [...e.shadow],
      since: e.since,
      decider: e.decider,
      evidence: e.evidence,
      go_live: e.goLive,
      note: e.note,
      registered_at: at,
    };
  });
}

export async function registerModes(modes = MODES, deps = {}) {
  const client = deps.supabase !== undefined ? deps.supabase : supabase;
  if (!client) return { registered: 0, skipped: 'no supabase' };
  const rows = modeRows(modes, { env: deps.env || process.env, now: (deps.now || Date.now)() });
  try {
    const { error } = await client.from('feature_modes').upsert(rows, { onConflict: 'name' });
    if (error) throw error;
    const counts = rows.reduce((acc, r) => ({ ...acc, [r.current_state]: (acc[r.current_state] || 0) + 1 }), {});
    const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
    console.log(`[ModeRegistry] registered ${rows.length} flags (${summary})`);
    return { registered: rows.length, counts };
  } catch (err) {
    console.error(`[ModeRegistry] could not register flags (is the feature_modes migration applied?): ${err.message}`);
    return { registered: 0, error: err.message };
  }
}
