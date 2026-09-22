/**
 * Action Executor Helpers — src/actions/helpers.js
 *
 * Shared helpers: ID type detection, GHL fetch wrapper, template interpolation.
 * Extracted from action-executor.js v4.2 refactor.
 *
 * 2026-05-11 — INTERPOLATION FILTERS.
 *   The {{key}} substitution now also accepts {{key|filter}} syntax.
 *   A filter takes the raw context value and returns a transformed
 *   string. Initial filter set:
 *     |date  → MM/DD/YYYY - H:MM AM/PM in America/New_York
 *              (via formatDateTimeUS in format-helpers.js)
 *
 *   Adding a new filter: implement the transform fn and add it to
 *   INTERPOLATE_FILTERS. Filter name must be \w+ (alphanumeric + _).
 *
 *   Backward compat: existing {{key}} templates are unchanged — the
 *   filter group is optional in the regex.
 */

import { acquireToken, report429 } from '../ghl-rate-limiter.js';
import { formatDateTimeUS } from '../format-helpers.js';

const GHL_API_KEY = process.env.GHL_API_KEY;

// ═══════════════════════════════════════════════════════════════════
// ID TYPE DETECTION
// ═══════════════════════════════════════════════════════════════════

export function isLPLeadId(id) {
  return id && /^\d+$/.test(String(id));
}

// ═══════════════════════════════════════════════════════════════════
// GHL FETCH WRAPPER — rate-limited, 429-aware, 15s timeout
// ═══════════════════════════════════════════════════════════════════

/**
 * @param {object} [rateOpts]  NOTE: named `rateOpts`, not `opts` — the fetch
 *   options object below already owns the name `opts` in this scope.
 * @param {number} [rateOpts.maxWaitMs]  per-call cap on the rate-limiter queue
 *   wait, forwarded to acquireToken. Handlers that make SEVERAL sequential
 *   GHL calls should pass a short cap so a 429-paused bucket cannot stack
 *   30s waits past the executor's 60s handler watchdog — the same reasoning
 *   as the 2026-07-03 reply-context hotfix, which added maxWaitMs but only
 *   wired it into agentic/reply-sender.js.
 *
 *   Omitted → WAIT_TIMEOUT_MS (30s), i.e. byte-identical behaviour for every
 *   existing caller. The limiter fails OPEN at the cap either way, so a
 *   shorter wait never drops the call — it just stops queueing sooner.
 */
export async function ghlFetch(method, path, body = null, rateOpts = {}) {
  if (!GHL_API_KEY) throw new Error('GHL_API_KEY not configured');
  // 2026-09-22 — `priority` MUST be forwarded, not just `maxWaitMs`.
  //
  // This line read `acquireToken({ maxWaitMs: rateOpts.maxWaitMs })` for a day
  // after the priority lane shipped (#988), so every caller asking for
  // `priority: 'high'` was silently served as a normal caller and the lane was
  // dead code on the one path built for it. `/n8n/rate-limiter/stats` read
  // `highAcquired: 0` across 42 real ActiveProspect leads — a counter that can
  // only stay 0 if no priority token was ever drawn.
  //
  // What it cost, measured on that traffic (Railway http-response-time,
  // /intake/ap-resolve, busiest hour): p50 2277ms, p90 3004ms against a 3000ms
  // ceiling — at least a tenth of real leads timing out and failing open, for
  // exactly the reason the lane was built to remove.
  //
  // The bug survived because the tests sat on either side of this seam and
  // never across it: the limiter suite calls acquireToken directly, the
  // resolver suite stubs ghlFetch. scripts/test-booking-token-wait.js now
  // asserts the forward against the limiter's own live counter.
  await acquireToken({ maxWaitMs: rateOpts.maxWaitMs, priority: rateOpts.priority });
  const url = `https://services.leadconnectorhq.com${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Version': '2021-07-28',
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (res.status === 429) {
    report429();
    const text = await res.text().catch(() => '');
    throw new Error(`GHL ${method} ${path} → 429: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GHL ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : { status: res.status, ok: true };
}

// ═══════════════════════════════════════════════════════════════════
// TEMPLATE INTERPOLATION — {{var}} or {{var|filter}} substitution
// ═══════════════════════════════════════════════════════════════════

/**
 * 2026-05-11 — registered filters for {{key|filter}} syntax.
 *   date → MM/DD/YYYY - H:MM AM/PM in America/New_York (DST-aware).
 *
 * A filter receives the raw context value and returns a string (or null
 * to fall back to the raw value).
 */
const INTERPOLATE_FILTERS = {
  date: (val) => formatDateTimeUS(val),
  // 2026-07-06 (Bot 2/3/4 consolidation) — follow-up bucket → hold hours.
  // Used by the follow_up_scheduled layer3 dispatch row:
  //   "hold_hours": "{{follow_up_bucket|follow_up_hold_hours}}"
  // Buckets come from the analyzer's validated follow_up_bucket field.
  // Unknown/absent bucket → null → falls back to the raw value, which the
  // issue_hold handler rejects as non-numeric (fail-safe: no bogus hold).
  follow_up_hold_hours: (val) => ({
    'tomorrow': '24',
    'few-days': '72',
    '1week': '168',
    '2weeks': '336',
    '1month': '720',
    '2months': '1440',
    'after-holidays': '1080',
    'seasonal': '2160',
  }[String(val)] ?? null),
};

export function interpolate(template, context) {
  if (!template || typeof template !== 'string') return template;
  // Regex captures key and optional |filter. The filter group is itself
  // optional via (?:...)?, preserving full backward compat with plain
  // {{key}} templates.
  return template.replace(/\{\{(\w+)(?:\|(\w+))?\}\}/g, (_match, key, filter) => {
    const val = context[key];
    if (val === undefined || val === null) return '';
    if (filter) {
      const fn = INTERPOLATE_FILTERS[filter];
      if (fn) {
        const out = fn(val);
        // Filter that returns null/undefined falls back to raw value
        // so a bad input doesn't blank the field entirely.
        if (out !== null && out !== undefined) return String(out);
      }
    }
    return String(val);
  });
}

export function interpolatePayload(payload, context) {
  if (!payload || typeof payload !== 'object') return payload;
  if (!context || Object.keys(context).length === 0) return payload;
  const result = {};
  for (const [key, val] of Object.entries(payload)) {
    if (typeof val === 'string') {
      result[key] = interpolate(val, context);
    } else if (Array.isArray(val)) {
      result[key] = val.map(item => typeof item === 'string' ? interpolate(item, context) : item);
    } else {
      result[key] = val;
    }
  }
  return result;
}
