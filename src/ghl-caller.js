/**
 * Who made each GHL request — src/ghl-caller.js
 *
 * WHY (2026-10-12). LP-MCP made ~127,000 GoHighLevel requests in 24 hours
 * (~100/min around the clock, peaks of 268/min at 5 AM: 63% of GHL's 200k/day
 * cap from this one service), and the rehash sweep failed 1 pass in 4 on 429s.
 * Nothing could say WHICH code made those calls: acquireToken() counts, and
 * ghl_request_budget counts per minute, but neither knows the caller. Every
 * ranking of the consumers was therefore a code-reading estimate (AI OS
 * CANON.STD.025: measure the cost, do not guess it).
 *
 * The caller is carried in AsyncLocalStorage, set at the few places work
 * starts — a scheduled job (runJob), an executor action, an inbound HTTP
 * request — so the ~100 GHL call sites need no change at all. An inner label
 * wins over an outer one (an action run inside a job is credited to the
 * action). acquireToken() records one count per request against the current
 * label; report429() records the 429 against it too.
 *
 * Measures only. It never throttles, never fails a request, and does no I/O
 * on the request path (a Map increment). The 15-minute summary is a log line
 * plus one low-priority system event, both off the request path.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage();

export const UNLABELED = 'unlabeled';
const MAX_LABELS = 300;          // a runaway label (an id in a path) cannot grow the Map forever
const REPORT_INTERVAL_MS = 15 * 60 * 1000;

let windowCounts = new Map();    // label -> { requests, r429 } since the last report
const totalCounts = new Map();   // label -> { requests, r429 } since boot
let windowStartedAt = Date.now();
let timer = null;

/** Run fn with `label` as the current GHL caller. Returns fn's result. */
export function withGhlCaller(label, fn) {
  if (!label) return fn();
  return store.run({ label: String(label) }, fn);
}

/** The current caller's label, or null outside any labelled context. */
export function currentGhlCaller() {
  return store.getStore()?.label || null;
}

/**
 * Express middleware: credit GHL calls made while serving a request to its
 * route. Ids are folded out of the path so /contacts/abc and /contacts/xyz
 * are one caller.
 */
export function ghlCallerMiddleware(req, _res, next) {
  withGhlCaller(`http:${req.method} ${normalizePath(req.path || req.url || '')}`, next);
}

/** /webhook/ghl/abc123XYZ/9 → /webhook/ghl/:id/:id. Pure. */
export function normalizePath(p) {
  return String(p).split('?')[0]
    .split('/')
    .map((seg) => (/\d/.test(seg) && seg.length >= 6) || /^\d+$/.test(seg) ? ':id' : seg)
    .join('/')
    .slice(0, 80);
}

function bump(map, label, field) {
  let row = map.get(label);
  if (!row) {
    if (map.size >= MAX_LABELS) { label = 'other'; row = map.get(label); }
    if (!row) { row = { requests: 0, r429: 0 }; map.set(label, row); }
  }
  row[field]++;
}

// The plumbing every GHL call passes through. A stack frame in one of these
// says nothing about who asked, so the fallback label skips them.
const PLUMBING_RX = /(ghl-caller|ghl-rate-limiter|ghl-shared-budget|actions\/helpers|\/ghl|n8n-helpers|contact-cache)\.js|node:|node_modules/;

/**
 * Fallback label when no context label is set: the first source file on the
 * stack that is not GHL plumbing (`src:jobs/rehash-tag-sweep.js`). Async
 * stack frames carry the awaiting callers, so this finds the job or handler
 * that made the call. File only, no line, to keep the label count small.
 */
export function stackLabel(stack = new Error().stack) {
  for (const line of String(stack || '').split('\n').slice(1)) {
    const m = line.match(/\/src\/([^:)\s]+\.js)/);
    if (!m) continue;
    if (PLUMBING_RX.test(`/${m[1]}`) || PLUMBING_RX.test(line)) continue;
    return `src:${m[1]}`;
  }
  return UNLABELED;
}

/** One GHL request by the current caller (or `label`). Called from acquireToken. */
export function recordGhlCallerRequest(label = currentGhlCaller()) {
  const l = label || stackLabel();
  bump(windowCounts, l, 'requests');
  bump(totalCounts, l, 'requests');
}

/** One 429 seen by the current caller. Called from report429. */
export function recordGhlCaller429(label = currentGhlCaller()) {
  const l = label || stackLabel();
  bump(windowCounts, l, 'r429');
  bump(totalCounts, l, 'r429');
}

const sorted = (map) => [...map.entries()]
  .map(([label, v]) => ({ label, requests: v.requests, r429: v.r429 }))
  .sort((a, b) => b.requests - a.requests);

/** Counts since boot and in the current window, busiest first. */
export function ghlCallerStats() {
  return {
    window_started_at: new Date(windowStartedAt).toISOString(),
    window: sorted(windowCounts),
    since_boot: sorted(totalCounts),
  };
}

/** Close the current window and return its counts. */
export function takeGhlCallerWindow(nowMs = Date.now()) {
  const out = { from: new Date(windowStartedAt).toISOString(), to: new Date(nowMs).toISOString(), callers: sorted(windowCounts) };
  windowCounts = new Map();
  windowStartedAt = nowMs;
  return out;
}

/** One log line for a window. Pure. */
export function formatGhlCallerWindow(win, top = 12) {
  const total = win.callers.reduce((s, c) => s + c.requests, 0);
  const parts = win.callers.slice(0, top).map((c) => `${c.label}=${c.requests}${c.r429 ? ` (429×${c.r429})` : ''}`);
  return `[GhlCallers] ${total} GHL requests ${win.from.slice(11, 16)}–${win.to.slice(11, 16)}Z: ${parts.join(', ') || 'none'}`;
}

/**
 * Every 15 minutes: log the window and record it as one low-priority
 * `ghl.request_budget_by_caller` event, so a day of attribution can be read
 * back from system_events. Never throws.
 */
export function startGhlCallerReporter({ emitEvent = null, log = console.log } = {}) {
  if (timer) return timer;
  timer = setInterval(async () => {
    try {
      const win = takeGhlCallerWindow();
      if (!win.callers.length) return;
      log(formatGhlCallerWindow(win));
      const emit = emitEvent || (await import('./event-emitter.js')).emitEvent;
      await Promise.resolve(emit({
        event_type: 'ghl.request_budget_by_caller', source: 'ghl-caller', entity_type: 'system', entity_id: 'lp-mcp',
        priority: 'low', bypass_filter: true,
        payload: { from: win.from, to: win.to, callers: win.callers.slice(0, 60) },
      })).catch(() => {});
    } catch (err) {
      console.warn(`[GhlCallers] report failed (counting continues): ${err.message}`);
    }
  }, REPORT_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

/** Tests only. */
export function _resetGhlCallers() {
  windowCounts = new Map();
  totalCounts.clear();
  windowStartedAt = Date.now();
}
