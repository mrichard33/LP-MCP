/**
 * record.js — write one health_results row per check evaluation.
 *
 * WHY (2026-10-15, System Health Phase 0). The watchdogs each decided "bad /
 * good / could not tell" and kept the answer in alert_conditions (only while
 * firing) or job_runs.detail (free-form). Nothing recorded the GREEN answers,
 * so nobody could say "this check ran 5 minutes ago and passed". This module is
 * the one write path for that record; the dashboard, the incident notifier and
 * the morning digest read it.
 *
 * Rules (Mark's ground rules for the platform):
 *   - could-not-tell is never a pass: a failed read is status 'unknown'.
 *   - thresholds live in health_checks.config, not in code: evaluate() reads
 *     the warn_* / fail_* keys from the row.
 *   - a fingerprint names the CONDITION, never a live value: "31 min" in a
 *     fingerprint would open a new incident every time the number moved.
 *   - never throws to the caller: a health write must not take a job down.
 */

import supabase from '../supabase.js';
import { loadHealthChecks } from './registry.js';

export const STATUSES = Object.freeze(['pass', 'warn', 'fail', 'unknown', 'skipped']);
export const SUMMARY_MAX = 300;
export const DETAIL_MAX_BYTES = 8 * 1024;

/** A fingerprint carrying a measured value or a timestamp opens a new incident per tick. */
const LIVE_VALUE_RX = /\d+ ?(min|minutes|h|leads|%)/i;
const ISO_TS_RX = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export function fingerprintProblem(fingerprint) {
  if (fingerprint === null || fingerprint === undefined || fingerprint === '') return null;
  const f = String(fingerprint);
  if (LIVE_VALUE_RX.test(f)) return 'fingerprint carries a live value';
  if (ISO_TS_RX.test(f)) return 'fingerprint carries a timestamp';
  return null;
}

function clipSummary(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX - 1)}…` : s;
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * detail → JSON-safe and ≤ 8 KB. Arrays are halved (largest first) until the
 * whole fits, each cut array gaining a sibling `<key>_truncated: true` plus
 * `<key>_total`, and the object gains `truncated: true`. Anything still too big
 * becomes `{ truncated: true, note }`. Pure.
 */
export function capDetail(detail, maxBytes = DETAIL_MAX_BYTES) {
  if (detail === null || detail === undefined) return {};
  let value;
  try {
    value = JSON.parse(JSON.stringify(detail));
  } catch {
    return { unserializable: true };
  }
  if (typeof value !== 'object' || Array.isArray(value)) value = { value };
  if (byteLength(value) <= maxBytes) return value;

  value.truncated = true;
  for (let guard = 0; guard < 64 && byteLength(value) > maxBytes; guard += 1) {
    const arrays = Object.entries(value)
      .filter(([, v]) => Array.isArray(v) && v.length > 0)
      .sort((a, b) => byteLength(b[1]) - byteLength(a[1]));
    if (!arrays.length) break;
    const [key, arr] = arrays[0];
    if (value[`${key}_total`] === undefined) value[`${key}_total`] = arr.length;
    value[`${key}_truncated`] = true;
    value[key] = arr.slice(0, Math.floor(arr.length / 2));
  }
  if (byteLength(value) > maxBytes) {
    return { truncated: true, note: `detail over ${maxBytes} bytes after trimming arrays` };
  }
  return value;
}

/**
 * pass / warn / fail from a value and the check's config.
 *
 *   evaluate(42, { warn_min: 30, fail_min: 60 }, { suffix: 'min' })   → 'warn'
 *   evaluate(96, { warn_pct: 98, fail_pct: 95 }, { suffix: 'pct', lowerIsWorse: true }) → 'warn'
 *   evaluate(3,  { warn: 1, fail: 3 })                                  → 'fail'
 *
 * Thresholds are inclusive (`>=`, or `<=` when lower is worse) unless
 * `strict: true`. A missing threshold never trips. A non-numeric value is
 * 'unknown': could-not-tell is never a pass. Pure.
 */
export function evaluate(value, config = {}, { suffix = '', lowerIsWorse = false, strict = false } = {}) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return 'unknown';
  const key = (k) => (suffix ? `${k}_${suffix}` : k);
  const warn = config?.[key('warn')];
  const fail = config?.[key('fail')];
  const trips = (t) => {
    if (t === null || t === undefined || !Number.isFinite(Number(t))) return false;
    const th = Number(t);
    if (lowerIsWorse) return strict ? n < th : n <= th;
    return strict ? n > th : n >= th;
  };
  if (trips(fail)) return 'fail';
  if (trips(warn)) return 'warn';
  return 'pass';
}

/**
 * A watchdog's tri-state `active` → a status (CLAUDE.md, Alerting):
 *   null/undefined → 'unknown' (could not tell; never a pass)
 *   true           → 'fail'    (the watchdog says bad)
 *   false          → evaluate(value, config) when a value and options are
 *                    given (a "good" verdict can still be inside the warn band),
 *                    else 'pass'.
 */
export function activeToStatus(active, value, config, evalOpts) {
  if (active === null || active === undefined) return 'unknown';
  if (active === true) return 'fail';
  if (evalOpts && value !== null && value !== undefined) {
    const s = evaluate(value, config, evalOpts);
    return s === 'unknown' ? 'pass' : s;
  }
  return 'pass';
}

/**
 * The status for one entry, resolved against its registry row. A job can
 * either state `status`, or hand over its tri-state `active` (plus `value` and
 * `eval` options) and let the CHECK'S CONFIG decide the warn band, so a
 * threshold change is a row update, never a deploy. `rule(value, config)` is
 * the escape hatch for a check whose bands do not fit evaluate(). Pure.
 */
export function resolveStatus(entry, checkRow) {
  if (entry.status) return entry.status;
  const config = checkRow?.config || {};
  if (typeof entry.rule === 'function') {
    try {
      const s = entry.rule(entry.value, config);
      return STATUSES.includes(s) ? s : 'unknown';
    } catch {
      return 'unknown';
    }
  }
  if ('active' in entry) return activeToStatus(entry.active, entry.value, config, entry.eval);
  return 'unknown';
}

/**
 * Write one result. Returns { ok, id?, error? }. Never throws.
 *
 * `client` defaults to the LP service client; `client: null` (tests, no
 * database) returns { ok:false } quietly.
 */
export async function recordHealthResult(entry = {}) {
  const c0 = entry.client !== undefined ? entry.client : supabase;
  let map = entry.registry || null;
  if (!entry.status && c0) {
    map = map || (await loadHealthChecks({ client: c0, nowMs: entry.nowMs ?? Date.now() }));
    entry = { ...entry, status: resolveStatus(entry, map.get(entry.check_id)), registry: map };
  } else if (!entry.status) {
    entry = { ...entry, status: resolveStatus(entry, null) };
  }
  return writeResult(entry);
}

async function writeResult({
  check_id: checkId,
  status,
  value = null,
  summary = null,
  detail = null,
  fingerprint = null,
  job_run_id: jobRunId = null,
  elapsed_ms: elapsedMs = null,
  client,
  nowMs,
  registry,
} = {}) {
  const c = client !== undefined ? client : supabase;
  if (!STATUSES.includes(status)) {
    console.error(`[Health] ${checkId}: refused status "${status}"`);
    return { ok: false, error: 'bad_status' };
  }
  if (!checkId) return { ok: false, error: 'no_check_id' };
  const fpProblem = fingerprintProblem(fingerprint);
  if (fpProblem) {
    console.error(`[Health] ${checkId}: refused fingerprint "${fingerprint}": ${fpProblem}`);
    return { ok: false, error: 'bad_fingerprint' };
  }
  if (!c) return { ok: false, error: 'no_client' };

  // The FK on check_id would refuse an unknown id anyway; checking first gives
  // a log line that names the check rather than a constraint.
  const map = registry || (await loadHealthChecks({ client: c, nowMs: nowMs ?? Date.now() }));
  if (map.size > 0 && !map.has(checkId)) {
    console.error(`[Health] ${checkId}: not in health_checks; result dropped`);
    return { ok: false, error: 'unknown_check' };
  }

  const numeric = value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
  const row = {
    check_id: checkId,
    status,
    value: numeric,
    summary: summary === null || summary === undefined ? null : clipSummary(summary),
    detail: capDetail(detail),
    fingerprint: fingerprint || null,
    job_run_id: jobRunId ?? null,
    elapsed_ms: elapsedMs === null || elapsedMs === undefined ? null : Math.max(0, Math.round(elapsedMs)),
  };
  if (nowMs !== undefined) row.observed_at = new Date(nowMs).toISOString();

  try {
    const { data, error } = await c.from('health_results').insert(row).select('id').single();
    if (error) throw error;
    return { ok: true, id: data?.id ?? null };
  } catch (err) {
    console.error(`[Health] ${checkId}: write failed: ${err.message || err}`);
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Write a job's `health: [...]` list. Each entry is a recordHealthResult
 * argument without the shared fields. Returns the count written. Never throws.
 */
export async function recordHealthResults(results, { job_run_id: jobRunId = null, client, nowMs } = {}) {
  if (!Array.isArray(results) || results.length === 0) return { written: 0, failed: 0 };
  let written = 0;
  let failed = 0;
  for (const r of results) {
    if (!r || typeof r !== 'object') continue;
    const out = await recordHealthResult({ ...r, job_run_id: r.job_run_id ?? jobRunId, client, nowMs });
    if (out.ok) written += 1;
    else failed += 1;
  }
  return { written, failed };
}
