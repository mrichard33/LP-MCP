/**
 * hold-target.js — recover the return target of a Dynamic Hold whose callback
 * arrived without one (2026-10-16). Pure: no I/O.
 *
 * WHY. Every Dynamic Hold callback since the hold shipped (2026-06-12) was
 * refused: GHL's "Post Hold Complete to LP MCP" step sends
 * `{{inboundWebhookRequest.return_to}}`, which comes through BLANK when the step
 * runs hours or weeks after the inbound webhook that started the workflow
 * (contact_id still arrives). /api/agentic/hold-complete answered
 * 200 {"ok":false,"error":"return_to required"}, GHL logged the step as
 * "Executed", and no agentic.hold_completed event was ever written. About 85
 * expired holds went nowhere, and the 8 rules that wait on one (331 "Follow-up
 * due — send the promised check-in" among them) never fired once.
 *
 * Our own issue_hold action already stores what GHL lost (return_to,
 * hold_reason, workflow_code, hold_hours), so a blank return_to is recovered
 * from the hold that is due right now. Matching on the due time (issued +
 * hold_hours) rather than "the newest hold" keeps a callback from an older hold
 * from being credited to a newer one that has not ended yet.
 */

// A callback lands within minutes of its due time (Amelia Gazzaroli Hasak:
// issued 2026-07-18 15:39 UTC + 2160h, callback 2026-10-16 15:40 UTC). The
// window allows for GHL running a wait step late, never for a stale hold.
export const HOLD_DUE_EARLY_MS = 2 * 3_600_000;
export const HOLD_DUE_LATE_MS = 48 * 3_600_000;

const MODES = new Set(['off', 'shadow', 'live']);

/** HOLD_RETURN_RECOVERY_MODE: off | shadow | live, default shadow. */
export function holdRecoveryMode(env = {}) {
  const raw = String(env.HOLD_RETURN_RECOVERY_MODE ?? '').trim().toLowerCase();
  return MODES.has(raw) ? raw : 'shadow';
}

function clean(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * The issued hold that is due now, or null. `holds` are agent_actions rows
 * (id, created_at, executed_at, action_payload, execution_result), any order.
 * Only a hold GHL actually received (execution_result.action === 'hold_issued')
 * counts: a serialized skip never started a clock.
 */
export function pickEndedHold(holds, nowMs) {
  const due = [];
  for (const h of Array.isArray(holds) ? holds : []) {
    const res = h?.execution_result || {};
    if (res.action !== 'hold_issued') continue;
    const payload = h.action_payload || {};
    const returnTo = clean(res.return_to) || clean(payload.return_to);
    if (!returnTo) continue;
    const hours = Number(res.hold_hours ?? payload.hold_hours);
    const issuedMs = Date.parse(h.executed_at || h.created_at);
    if (!Number.isFinite(hours) || hours <= 0 || !Number.isFinite(issuedMs)) continue;
    const dueMs = issuedMs + hours * 3_600_000;
    if (dueMs > nowMs + HOLD_DUE_EARLY_MS || dueMs < nowMs - HOLD_DUE_LATE_MS) continue;
    due.push({
      action_id: h.id ?? null,
      return_to: returnTo,
      hold_reason: res.hold_reason || payload.hold_reason || null,
      workflow_code: res.workflow_code || payload.workflow_code || null,
      hold_hours: hours,
      issued_at: new Date(issuedMs).toISOString(),
      due_at: new Date(dueMs).toISOString(),
      dueMs,
    });
  }
  if (!due.length) return null;
  // The hold whose due time is closest to now is the one that just ended.
  due.sort((a, b) => Math.abs(a.dueMs - nowMs) - Math.abs(b.dueMs - nowMs));
  const { dueMs, ...picked } = due[0];
  return picked;
}

/**
 * Where this callback's return_to comes from:
 *   'body'          a top-level return_to (a direct caller; unchanged behavior)
 *   'custom_data'   GHL's Webhook action: its Custom Data rows arrive nested
 *                   under body.customData, never at the top level
 *   'body_field'    the contact field GHL puts on every webhook body
 *                   ("Hold Return Target", or hold_return_target)
 *   'issued_hold'   our own issue_hold row that is due now
 *   null            nothing; the callback is refused as before
 */
export function recoverHoldTarget({ body = {}, holds = [], nowMs = Date.now() } = {}) {
  const direct = clean(body.return_to);
  if (direct) return { returnTo: direct, source: 'body', hold: null };
  const nested = clean(body.customData?.return_to);
  if (nested) return { returnTo: nested, source: 'custom_data', hold: null };
  const field = clean(body.hold_return_target) || clean(body['Hold Return Target']);
  if (field) return { returnTo: field, source: 'body_field', hold: null };
  const hold = pickEndedHold(holds, nowMs);
  if (hold) return { returnTo: hold.return_to, source: 'issued_hold', hold };
  return { returnTo: '', source: null, hold: null };
}

/**
 * The event a completed hold emits, or null to refuse it. A callback that
 * carried return_to is unchanged in every mode. A recovered one emits the real
 * event only in live: the rules it wakes have never run in production (rule
 * 332 cancels an appointment, rule 331 texts the lead), so shadow records
 * `agentic.hold_completed_shadow`, which no rule reads.
 */
export function completionEventType({ source, mode }) {
  if (source === 'body') return 'agentic.hold_completed';
  if (!source) return null;
  if (mode === 'live') return 'agentic.hold_completed';
  if (mode === 'shadow') return 'agentic.hold_completed_shadow';
  return null;
}
