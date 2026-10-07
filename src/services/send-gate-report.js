/**
 * One send gate — disagreement reporting (src/services/send-gate-report.js)
 *
 * 2026-10-07 — the I/O half of src/services/may-message.js. When a route's
 * old answer and mayMessage disagree, say so ONCE, in a log line and in a
 * system event, so a wrong class shows up in the logs and not in a
 * customer's phone. The 48-hour shadow read before SEND_GATE_MODE=live is:
 *
 *   SELECT payload->>'purpose', payload->>'blockedBy', count(*)
 *   FROM system_events WHERE event_type = 'send_gate.would_block'
 *   GROUP BY 1, 2;
 *
 * Volume is capped three times: a per-process Set logs each (kind, route,
 * contact, tag) once, the event's idempotency key carries the day (one event
 * per contact, route and tag per day), and each route reports at most
 * SEND_GATE_REPORT_CAP (300) a day.
 *
 * Fire-and-forget and fail-silent: a reporting failure must never change a
 * send decision. `deps.emitEvent` is the seam for tests.
 */

import { mayMessage, resolveGate, sendGateMode } from './may-message.js';

const seen = new Set();
const SEEN_CAP = 20000;
const perRouteDay = new Map();

let _emitEvent = null;
async function defaultEmit(evt) {
  if (!_emitEvent) ({ emitEvent: _emitEvent } = await import('../event-emitter.js'));
  return _emitEvent(evt);
}

/**
 * @param {object} p
 * @param {string} p.route      where the gate ran ('send_flow', 'send_flow_live',
 *                              'send_handler', 'live_chat', 'info_email', 'nurture',
 *                              'lead_selection', 'add_to_workflow')
 * @param {string} p.purpose    'reply' | 'outreach' | 'mutation'
 * @param {string|null} p.channel
 * @param {string|null} p.contactId
 * @param {object} p.decision   mayMessage() result
 * @param {object} p.legacy     { blocked, tag }
 * @param {object} p.resolved   resolveGate() result
 * @param {string} p.mode       'shadow' | 'live'
 * @param {object} [deps]       { emitEvent, log, now }
 * @returns {boolean} true when this call reported (first sighting)
 */
export function reportGateDisagreement(p, deps = {}) {
  const { resolved } = p || {};
  if (!resolved?.disagree) return false;
  const kind = resolved.disagree; // 'would_block' | 'would_allow'
  const tag = kind === 'would_block' ? p.decision?.blockedBy : p.legacy?.tag;
  const contact = p.contactId || 'unknown';
  const key = `${kind}|${p.route}|${contact}|${tag}`;
  if (seen.has(key)) return false;
  if (seen.size >= SEEN_CAP) { seen.clear(); perRouteDay.clear(); }
  seen.add(key);

  // A batch route (lead selection walks thousands of candidates) could
  // otherwise write thousands of rows in one pass; past the cap the rest of
  // the day is one log line. SEND_GATE_REPORT_CAP, default 300 per route per day.
  const day = new Date(deps.now ? deps.now() : Date.now()).toISOString().slice(0, 10);
  const capKey = `${p.route}|${day}`;
  const n = (perRouteDay.get(capKey) || 0) + 1;
  perRouteDay.set(capKey, n);
  const cap = Math.max(1, parseInt((deps.env || process.env).SEND_GATE_REPORT_CAP || '300', 10) || 300);
  if (n > cap) {
    if (n === cap + 1) (deps.log || console.log)(`[SendGate] ${p.route}: ${cap} disagreements reported today — the rest of today's are not recorded`);
    return false;
  }

  const log = deps.log || console.log;
  const verb = p.mode === 'live'
    ? (kind === 'would_block' ? 'BLOCKED (old check allowed)' : 'ALLOWED (old check blocked)')
    : (kind === 'would_block' ? 'would block (old check allows; old answer kept)' : 'would allow (old check blocks; old answer kept)');
  log(`[SendGate] ${p.route} ${verb}: contact=${contact} purpose=${p.purpose} channel=${p.channel || 'any'} tag=${tag} class=${p.decision?.tagClass || 'none'} mode=${p.mode}`);

  const emit = deps.emitEvent || defaultEmit;
  Promise.resolve()
    .then(() => emit({
      event_type: `send_gate.${kind}`,
      source: 'send_gate',
      entity_type: 'contact',
      entity_id: String(contact),
      ghl_contact_id: p.contactId || null,
      priority: 'low',
      bypass_filter: true,
      payload: {
        route: p.route,
        purpose: p.purpose,
        channel: p.channel || null,
        blockedBy: kind === 'would_block' ? (p.decision?.blockedBy || null) : null,
        tagClass: p.decision?.tagClass || null,
        legacy_tag: p.legacy?.tag || null,
        mode: p.mode,
        decided_by: resolved.source,
      },
      idempotency_key: `send_gate_${kind}_${p.route}_${contact}_${tag}_${day}`,
    }))
    .catch((err) => (deps.warn || console.warn)(`[SendGate] ${kind} event failed: ${err?.message || err}`));
  return true;
}

/**
 * The one call a route makes: decide with mayMessage, combine with the
 * route's old answer under SEND_GATE_MODE, report a disagreement, return the
 * combined answer. Every sender goes through this so the shadow log is
 * complete.
 *
 * @param {object} p  { tags, channel, purpose, legacy: {blocked, tag}, route, contactId }
 * @param {object} [deps]  { env, emitEvent, log, warn, now }
 * @returns {{ blocked, tag, source, disagree, decision, mode, purpose }}
 */
export function applySendGate(p, deps = {}) {
  const mode = sendGateMode(deps.env || process.env);
  const decision = mayMessage({ tags: p.tags, channel: p.channel, purpose: p.purpose });
  const legacy = p.legacy || { blocked: false, tag: null };
  const resolved = resolveGate({ legacy, decision, mode });
  if (resolved.disagree) {
    try {
      reportGateDisagreement({ ...p, legacy, decision, resolved, mode }, deps);
    } catch { /* reporting never changes the answer */ }
  }
  return { ...resolved, decision, mode, purpose: p.purpose };
}

export const __testing = { reset: () => { seen.clear(); perRouteDay.clear(); } };
