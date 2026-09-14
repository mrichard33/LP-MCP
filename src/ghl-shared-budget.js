/**
 * Shared GHL request budget — src/ghl-shared-budget.js
 *
 * Counts the GHL API requests THIS service actually makes, per minute, into a
 * table on the HL Supabase instance that HL-MCP can write to as well. The point
 * is one number nobody can currently produce: the real COMBINED request rate
 * across LP-MCP and HL-MCP at the moment GoHighLevel pushes back.
 *
 * WHY
 * ───
 * LP-MCP and HL-MCP each run their own token bucket against the SAME GHL
 * location — 65/min and 60/min as of 2026-09-14 — and neither can see the
 * other. Every tuning decision to date has therefore been a guess.
 *
 * The guessing has a cost. Measured 2026-09-14 after #927 brought 25 previously
 * ungoverned call sites into LP-MCP's bucket: ~80 `acquireToken timed out after
 * 30000ms` lines in 35 minutes at queue depths of 9-23, every one reading
 * `tokens=0, paused=false`. Raising 50 -> 65 did not clear it. And across the
 * whole window, ZERO 429s — GoHighLevel never pushed back at all.
 *
 * So the bucket is throttling below real demand while the limit it defends
 * against never fires. The obvious move is to raise it further, but
 * ghl-rate-limiter.js's own header says:
 *
 *   "Do not exceed ~60-70 without confirming GHL's per-location sustained
 *    limit, which is SHARED with the HL MCP."
 *
 * That confirmation is exactly what has never been done. This module does it.
 *
 * WHAT THIS IS NOT
 * ────────────────
 * It does not throttle anything. There is deliberately no enforce mode: you
 * cannot enforce against a number you have not measured yet, and writing a dead
 * enforcement branch now would be speculation dressed as code. Enforcement — if
 * it is ever wanted — is a later change informed by what this records.
 *
 * SAFETY
 * ──────
 * - OFF by default (GHL_SHARED_BUDGET_MODE unset or 'off').
 * - Counting is a Map increment. No I/O on the request path, ever.
 * - Flushing is periodic, off the request path, and wrapped so a failure is a
 *   warning and nothing more. A counter must never be able to fail a GHL call.
 * - Append-only rows, summed at read time. No read-modify-write, so several
 *   instances (or both services) can write the same minute without racing.
 * - If the table does not exist the flush fails, logs once, and the service
 *   carries on exactly as before.
 */

import { getHlSupabase } from './admin/hl-client.js';
import { trackBackground } from './graceful-shutdown.js';

const TABLE = 'ghl_request_budget';

/** 'off' | 'shadow'. Anything unrecognised is treated as off. */
const MODE = (process.env.GHL_SHARED_BUDGET_MODE || 'off').toLowerCase();

/** Which service this row came from. Both services write the same table. */
const SERVICE = process.env.GHL_BUDGET_SERVICE_NAME || 'lp-mcp';

/** How often the in-memory counts are flushed. */
const FLUSH_MS = Math.max(15000, parseInt(process.env.GHL_BUDGET_FLUSH_MS || '60000', 10));

export function sharedBudgetMode() {
  return MODE === 'shadow' ? 'shadow' : 'off';
}

/** minute-resolution bucket key, e.g. 2026-09-14T19:07:00.000Z */
export function minuteBucket(nowMs = Date.now()) {
  const d = new Date(nowMs);
  d.setUTCSeconds(0, 0);
  return d.toISOString();
}

// bucket ISO -> count, for buckets not yet flushed.
const pending = new Map();
let timer = null;
let warnedOnce = false;

/**
 * Record one GHL request. Called from acquireToken, which every governed path
 * goes through — withGhlToken and the manual acquireToken/report429 pairs alike.
 *
 * Counts INTENT rather than completion, deliberately: the limiter fails open, so
 * a token request that times out still results in a call to GHL. Counting here
 * therefore matches what GoHighLevel actually receives, which is the whole point.
 */
export function recordGhlRequest(nowMs = Date.now()) {
  if (sharedBudgetMode() === 'off') return;
  const key = minuteBucket(nowMs);
  pending.set(key, (pending.get(key) || 0) + 1);
}

/**
 * Write out whatever has accumulated. Never throws.
 *
 * Buckets are drained before the write so a failed flush drops that window
 * rather than double-counting it on the next pass — this is a measurement, and
 * an inflated number would be worse than a missing one.
 */
export async function flushSharedBudget({ client: clientArg } = {}) {
  if (sharedBudgetMode() === 'off' || pending.size === 0) return { written: 0 };

  const rows = [...pending.entries()].map(([minute_bucket, requests]) => ({
    minute_bucket, service: SERVICE, requests,
  }));
  pending.clear();

  try {
    const client = clientArg ?? getHlSupabase();
    const { error } = await client.from(TABLE).insert(rows);
    if (error) {
      if (!warnedOnce) {
        warnedOnce = true;
        console.warn(
          `[GhlBudget] flush failed (counting continues, nothing else affected): ${error.message}`
          + ` — has ${TABLE} been created on the HL instance? See sql/111_ghl_request_budget.sql`,
        );
      }
      return { written: 0, error: error.message };
    }
    warnedOnce = false;
    return { written: rows.length };
  } catch (err) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn(`[GhlBudget] flush threw (ignored): ${err.message}`);
    }
    return { written: 0, error: err.message };
  }
}

/**
 * Read the combined per-minute rate across every reporting service.
 *
 * This is the number the whole module exists to produce. Returns newest first.
 */
export async function readCombinedRate({ minutes = 60, client: clientArg } = {}) {
  const since = minuteBucket(Date.now() - minutes * 60000);
  const client = clientArg ?? getHlSupabase();
  const { data, error } = await client.from(TABLE)
    .select('minute_bucket, service, requests')
    .gte('minute_bucket', since);
  if (error) return { ok: false, error: error.message, buckets: [] };

  const byMinute = new Map();
  for (const r of data || []) {
    if (!byMinute.has(r.minute_bucket)) byMinute.set(r.minute_bucket, { minute_bucket: r.minute_bucket, total: 0 });
    const b = byMinute.get(r.minute_bucket);
    b[r.service] = (b[r.service] || 0) + r.requests;
    b.total += r.requests;
  }
  const buckets = [...byMinute.values()].sort((a, b) => (a.minute_bucket < b.minute_bucket ? 1 : -1));
  const peak = buckets.reduce((m, b) => Math.max(m, b.total), 0);
  return { ok: true, buckets, peak_total_per_min: peak, minutes };
}

export function startSharedBudgetReporter() {
  if (timer) return;
  if (sharedBudgetMode() === 'off') {
    console.log('[GhlBudget] disabled (GHL_SHARED_BUDGET_MODE=off) — no counting, no writes');
    return;
  }
  timer = setInterval(() => {
    trackBackground(flushSharedBudget());
  }, FLUSH_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[GhlBudget] shadow mode — counting GHL requests as '${SERVICE}', flushing every ${FLUSH_MS}ms`);
}

export function registerSharedBudgetRoutes(app, authenticate = (req, res, next) => next()) {
  app.get('/admin/ghl-budget/rate', authenticate, async (req, res) => {
    const minutes = Math.min(1440, Math.max(1, parseInt(req.query.minutes || '60', 10)));
    try {
      res.json({ mode: sharedBudgetMode(), service: SERVICE, ...(await readCombinedRate({ minutes })) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  console.log('[GhlBudget] route registered: GET /admin/ghl-budget/rate');
}

// test-only
export const __testing = { pending, TABLE, FLUSH_MS, SERVICE };
