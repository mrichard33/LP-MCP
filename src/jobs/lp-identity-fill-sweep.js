// ─── LP identity fill sweep — src/jobs/lp-identity-fill-sweep.js ────────────
//
// 2026-10-11. The ongoing safety net behind the backstop-link and enrichment
// fills: every 30 minutes, a GHL contact with no real name that is linked to
// an LP lead which HAS a name gets that name (and any empty email / address),
// fill-empty-only. It catches names typed into LP after the contact was
// linked — canvass and text leads named at the demo — which neither the
// backstop (links once) nor the field sync (custom fields only) would ever
// write. The work is runIdentityFill in src/services/lp-identity-backfill.js.
//
// LP_IDENTITY_FILL_MODE: off stops the job; shadow decides and logs what it
// would write; live (default) writes. Live by default because the fill can
// only add a value where GHL has none — it never replaces one.
// LP_IDENTITY_FILL_MAX_PER_RUN (default 50) caps GHL reads per pass.
//
// A contact the pass could do nothing more for (unverified link, real name
// by now, contact gone) is remembered for a day so it does not cost a GHL GET
// every 30 minutes.

import { runJob } from '../job-runner.js';
import { runIdentityFill } from '../services/lp-identity-backfill.js';

export const JOB_ID = 'lp-identity-fill-sweep';
const INTERVAL_MS = 30 * 60 * 1000;
const REMEMBER_MS = 24 * 60 * 60 * 1000;

export function identityFillMode(env = process.env) {
  const m = String(env.LP_IDENTITY_FILL_MODE || 'live').toLowerCase().trim();
  return ['off', 'shadow', 'live'].includes(m) ? m : 'live';
}

function maxPerRun(env = process.env) {
  const n = parseInt(env.LP_IDENTITY_FILL_MAX_PER_RUN || '50', 10);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

const remembered = new Map(); // contactId → expiresAt

function rememberedIds(now) {
  for (const [id, exp] of remembered) if (exp <= now) remembered.delete(id);
  return new Set(remembered.keys());
}

/** One pass. deps: { hl, lp, ghlFetch, env, now, log } (all optional). */
export async function runIdentityFillSweep(deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const log = deps.log || console.log;
  const mode = identityFillMode(env);
  if (mode === 'off') return { ok: true, mode, skipped: 'mode_off' };

  const hl = deps.hl !== undefined ? deps.hl : (await import('../admin/hl-client.js')).getHlSupabase();
  const lp = deps.lp !== undefined ? deps.lp : (await import('../supabase.js')).default;
  const ghlFetch = deps.ghlFetch || (await import('../actions/helpers.js')).ghlFetch;

  const res = await runIdentityFill({
    dryRun: mode !== 'live',
    limit: maxPerRun(env),
    syncType: 'identity_fill_sweep',
    skipIds: rememberedIds(now),
  }, { hl, lp, ghlFetch, log });

  // A shadow pass writes nothing, so nothing it saw is settled.
  if (mode === 'live') for (const id of res.settled) remembered.set(id, now + REMEMBER_MS);

  const c = res.counts;
  if (c.filled || c.would_fill || c.errors) {
    log(`[IdentityFillSweep] ${mode}: ${mode === 'live' ? c.filled : c.would_fill} contact(s) ${mode === 'live' ? 'filled' : 'would fill'}, ` +
      `${c.checked} checked, ${c.errors} error(s), ${c.skipped_no_lp_name} with no LP name`);
  }
  return { ok: res.ok, mode, counts: c, errors: res.errors.slice(0, 20) };
}

let timer = null;
let running = false;

export async function runIdentityFillTick() {
  const { value: res } = await runJob(JOB_ID, () => runIdentityFillSweep());
  if (res && res.ok === false) console.warn(`[IdentityFillSweep] pass finished with errors: ${(res.errors || []).slice(0, 5).map((e) => e.error).join('; ')}`);
}

export function startIdentityFillScheduler(env = process.env) {
  if (timer) return timer;
  if (identityFillMode(env) === 'off') {
    console.log('[IdentityFillSweep] scheduler not started (LP_IDENTITY_FILL_MODE=off)');
    return null;
  }
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runIdentityFillTick();
    } catch (err) {
      console.error(`[IdentityFillSweep] pass threw: ${err.message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[IdentityFillSweep] scheduler started — ${identityFillMode(env)}, every 30m, max ${maxPerRun(env)}/pass`);
  return timer;
}

export function stopIdentityFillScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
