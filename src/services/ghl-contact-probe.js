// ─── GHL contact probe — src/services/ghl-contact-probe.js ──────────────────
//
// A THREE-WAY reachability check for a GHL contact id: 'found' | 'orphan' |
// 'unknown'. Everything that persists or clears a link should go through this
// rather than getGHLContact().
//
// Why not getGHLContact (src/ghl.js):
//   1. It collapses not-found, transient failure, AND the ghlDisabled kill
//      switch into a single `null`. A caller cannot tell "this id is bad" from
//      "we couldn't ask".
//   2. ghlDisabled never self-resets — it latches until process restart or
//      resetGHLState(). So a caller that fails closed on null stops working
//      permanently the moment the kill switch trips, with nothing surfacing it.
//      That switch is precisely what the 2026-07-28 orphan incident tripped.
//
// ghlFetch is used deliberately: it still awaits the token bucket
// (acquireToken), so the rate limiter is respected, but it does NOT consult
// ghlDisabled — a reachability probe must not read every id as unknown because
// an unrelated incident latched the switch earlier in the process.
//
// Only 'orphan' is an affirmative "this id is not reachable by us". Timeouts,
// 429s, 5xx and BARE 403s are 'unknown' and must never drive a write in either
// direction.

import { ghlFetch } from '../actions/helpers.js';
import { classifyGHLError } from './ghl-error-classify.js';
import { sendGroupMeMessage } from '../groupme.js';

/**
 * @param {string} ghlContactId
 * @returns {Promise<'found'|'orphan'|'unknown'>}
 */
export async function probeGHLContact(ghlContactId) {
  if (!ghlContactId) return 'unknown';
  try {
    await ghlFetch('GET', `/contacts/${ghlContactId}`);
    return 'found';
  } catch (err) {
    return classifyGHLError(err).notFound ? 'orphan' : 'unknown';
  }
}

// ─── Consecutive-unknown breaker ─────────────────────────────────
//
// A GHL outage makes every probe return 'unknown', so every link backfill
// silently defers. Silence is the failure mode we are trying to remove, so the
// run of unknowns is surfaced — but ONCE per incident, not once per lead.
//
// The counter is GLOBAL (not per-lead) precisely so an outage across N leads
// produces one card rather than N. It resets on the first 'found', which also
// re-arms the alert for the next genuine incident.
const UNKNOWN_ALERT_THRESHOLD = parseInt(process.env.GHL_PROBE_UNKNOWN_ALERT_THRESHOLD || '10', 10);
let _consecutiveUnknown = 0;
let _unknownAlerted = false;

/** Test seam — reset module state between cases. */
export function resetProbeBreaker() {
  _consecutiveUnknown = 0;
  _unknownAlerted = false;
}

/** Current breaker state, for logging/tests. */
export function probeBreakerState() {
  return { consecutiveUnknown: _consecutiveUnknown, alerted: _unknownAlerted };
}

/**
 * probeGHLContact + consecutive-unknown tracking. Use this on paths that run
 * repeatedly (webhook backfill, sweeps) so a sustained outage surfaces exactly
 * once instead of deferring in silence.
 *
 * @param {string} ghlContactId
 * @param {string} [context] short label for the alert (e.g. 'LP Inbound Refresh')
 * @returns {Promise<'found'|'orphan'|'unknown'>}
 */
export async function probeGHLContactTracked(ghlContactId, context = 'link backfill') {
  const verdict = await probeGHLContact(ghlContactId);

  if (verdict === 'found') {
    // First success ends the incident and re-arms the alert.
    if (_unknownAlerted) {
      console.log(`[GHLProbe] recovered after ${_consecutiveUnknown} consecutive unknown probes`);
    }
    resetProbeBreaker();
    return verdict;
  }

  // 'orphan' is a definitive answer about ONE id, not evidence GHL is
  // unreachable — it must not advance the outage counter.
  if (verdict === 'orphan') return verdict;

  _consecutiveUnknown++;
  if (_consecutiveUnknown >= UNKNOWN_ALERT_THRESHOLD && !_unknownAlerted) {
    _unknownAlerted = true;
    console.error(`[GHLProbe] ${_consecutiveUnknown} consecutive unknown probes — GHL likely unreachable; ${context} is deferring all links`);
    sendGroupMeMessage(
      `⚠️ LP MCP: ${_consecutiveUnknown} consecutive GHL contact probes returned unknown (timeout / 429 / 5xx). `
      + `${context} is deferring every link until GHL recovers. No links are being cleared.`
    ).catch(() => {});
  }
  return verdict;
}
