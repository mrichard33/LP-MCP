// ─── One owner per inbound — src/agentic/turn-lock.js ───────────────────────
//
// WHY (Phase 1, architecture review 2026-10-17, cause 4)
//   Four Decision Engine rules can answer one SMS: AGENTIC_RESPOND_POST_CHATBOT
//   (106), LAYER3_DISPATCH (161), AGENTIC_ACTIVE_REPLY_BACKSTOP (228) and
//   AGENTIC_REPLY_SLA_RECOVER (373). 228 and 373 skip 60-90% of the time only
//   because another rule got there first, and when the timing slipped a lead got
//   two replies (Shawn 2026-10-15, Paul 2026-10-17). A rule-written send re-fired
//   with no new inbound and answered Teresa twice (DQ_RENTER_DETECTED,
//   2026-10-18 06:44, the second with a discovery question after the DQ).
//
//   Every reply path now CLAIMS the inbound (bot_turn_locks, keyed by
//   turn-key.js) before it builds context or calls a model. The first claim
//   owns the turn; every other path writes a skip row and calls no model.
//
// THE RULES (decideClaim)
//   - no row → claim it.
//   - a row this same action owns → still ours (a deferred retry re-enters).
//   - a row released after a reply went out (sent / watchdog_recovered) →
//     `already_answered`.
//   - a row released WITHOUT a reply (the owner skipped or failed) → free: a
//     stand-down is only safe if something else answers (CLAUDE.md, the
//     Decision Engine), so the next path may take it.
//   - a row older than 10 minutes and never released → stale: taken over and
//     logged (a crashed owner must not silence the lead).
//   - otherwise → `turn_owned_by:<rule>`.
//
// WATCHDOGS (Phase 1 item 2): 228 and 373 claim like everyone else, and in
// live they can only win once the inbound is 180 s old and no reply went out
// after it (watchdogMayAnswer). A win is recorded as `watchdog_recovered`.
//
// TURN_LOCK_MODE shadow (default) | live. shadow claims and records, and the
// path proceeds as before; the reply row carries turn_lock_shadow_would_skip.
// Retired in Phase 5.
//
// PURE. No I/O; turn-lock-io.js reads and writes the table.

export const TURN_LOCK_MODES = Object.freeze(['shadow', 'live']);

/** TURN_LOCK_MODE shadow | live; anything else is shadow. Pure. */
export function turnLockMode(env = process.env) {
  const raw = String(env.TURN_LOCK_MODE ?? '').trim().toLowerCase();
  return TURN_LOCK_MODES.includes(raw) ? raw : 'shadow';
}

/** An unreleased claim older than this is a crashed owner's, and is taken over. */
export const STALE_LOCK_MS = 10 * 60 * 1000;

/** The two watchdog rules (Phase 1 item 2). */
export const WATCHDOG_RULES = Object.freeze(new Set(['AGENTIC_ACTIVE_REPLY_BACKSTOP', 'AGENTIC_REPLY_SLA_RECOVER']));
export const WATCHDOG_MIN_AGE_MS = 180 * 1000;

/** Outcomes that mean a reply reached the lead for that turn. 2026-10-19 (Mark,
 * ruling 5): a person who texted the lead by hand (human_replied) answered the
 * turn too, so no other path and no watchdog (228 / 373) answers it again. */
export const ANSWERED_OUTCOMES = Object.freeze(new Set(['sent', 'watchdog_recovered', 'human_replied']));

export const isWatchdogRule = (rule) => WATCHDOG_RULES.has(String(rule || ''));

const ms = (v) => {
  const n = Date.parse(v ?? '');
  return Number.isFinite(n) ? n : null;
};

/**
 * What a claim does against the row already there (or none). Pure.
 * @param {object|null} existing  bot_turn_locks row
 * @param {{ ownerActionId?: string|number|null, nowMs?: number }} who
 * @returns {{ action: 'insert'|'own'|'takeover'|'refuse', reason?: string, skip_reason?: string, owner_rule?: string|null, claimed_at?: string|null }}
 */
export function decideClaim(existing, { ownerActionId = null, nowMs = Date.now() } = {}) {
  if (!existing) return { action: 'insert' };
  const owner = existing.owner_rule || null;
  const at = existing.claimed_at || null;
  if (ownerActionId != null && existing.owner_action_id != null && String(existing.owner_action_id) === String(ownerActionId) && !existing.released_at) {
    return { action: 'own', reason: 'same_action' };
  }
  if (existing.released_at) {
    if (ANSWERED_OUTCOMES.has(String(existing.outcome || ''))) return { action: 'refuse', skip_reason: 'already_answered', owner_rule: owner, claimed_at: at };
    return { action: 'takeover', reason: 'released_unanswered', owner_rule: owner, claimed_at: at };
  }
  const claimedMs = ms(at);
  if (claimedMs != null && nowMs - claimedMs >= STALE_LOCK_MS) return { action: 'takeover', reason: 'stale', owner_rule: owner, claimed_at: at };
  return { action: 'refuse', skip_reason: `turn_owned_by:${owner || 'unknown'}`, owner_rule: owner, claimed_at: at };
}

/**
 * May a watchdog (228 / 373) answer this inbound now? Pure.
 *   too early (inbound under 180 s old) → defer until 180 s;
 *   a reply already went out after the inbound → already_answered.
 * @param {{ inboundAtMs: number|null, answeredAtMs?: Array<number>, nowMs?: number }} a
 * @returns {{ ok: true } | { ok: false, defer_until_ms?: number, skip_reason?: string }}
 */
export function watchdogMayAnswer({ inboundAtMs = null, answeredAtMs = [], nowMs = Date.now() } = {}) {
  if (Number.isFinite(inboundAtMs) && nowMs - inboundAtMs < WATCHDOG_MIN_AGE_MS) {
    return { ok: false, defer_until_ms: inboundAtMs + WATCHDOG_MIN_AGE_MS };
  }
  // A reply claimed after the inbound arrived answered it (one reply per burst
  // answers everything since our last reply). A small skew allowance: the lock
  // row may be claimed a moment before the inbound row's created_at is stamped.
  if (Number.isFinite(inboundAtMs) && (answeredAtMs || []).some(a => Number.isFinite(a) && a >= inboundAtMs - 5000)) {
    return { ok: false, skip_reason: 'already_answered' };
  }
  return { ok: true };
}

// Reply paths named in Phase 1 that may not arrive on a reply-class event.
const REPLY_RULE_PREFIXES = Object.freeze(['DQ_']);
const REPLY_RULES = Object.freeze(new Set(['AGENTIC_REPLY_SLA_RECOVER', 'SERVICE_AREA_EXIT']));
// Its own message on the turn after the booking confirmation (Engelke, Defect 4):
// it must never claim the inbound the confirmation answered (2026-08-31: the
// outbound lock killed it every time that way), so it claims a turn of its own.
const OWN_TURN_RULES = Object.freeze(new Set(['POST_BOOKING_EMAIL_ASK']));

/**
 * Does this send claim a turn, and which? Pure.
 *   a reply (its source event is an inbound or its analysis), a DQ_* /
 *   SERVICE_AREA_EXIT / 373 send → the inbound's turn;
 *   POST_BOOKING_EMAIL_ASK, or any send with an explicit payload trigger_id →
 *   its own trigger id (a re-fire of IT is the duplicate);
 *   any other bot-initiated send (a hold return, a nurture step) → none: it
 *   answers no inbound, and claiming the last one would silence it.
 * @returns {{ claims: boolean, ownKey: string|null }}
 */
export function turnClaimScope({ ruleApplied = null, sourceEventType = null, triggerId = null } = {}) {
  const rule = String(ruleApplied || '');
  if (OWN_TURN_RULES.has(rule)) return { claims: true, ownKey: `own:${triggerId || rule}` };
  // An explicit payload trigger_id is the outbound lock's "deliberate second
  // message for the same inbound" (the deferred confirmation, a carrier
  // resend, 2026-08-31): it owns a turn of its own, never the inbound's.
  if (triggerId) return { claims: true, ownKey: `own:${triggerId}` };
  const replyClass = sourceEventType === 'ai.analysis_completed' || sourceEventType === 'ghl.reply_received';
  if (replyClass || REPLY_RULES.has(rule) || isWatchdogRule(rule) || REPLY_RULE_PREFIXES.some(p => rule.startsWith(p))) return { claims: true, ownKey: null };
  return { claims: false, ownKey: null };
}

/** The outcome a released claim records for what the path returned. Pure. */
export function releaseOutcomeFor(result, { ownerRule = null } = {}) {
  if (!result) return 'error';
  if (result.sent_body) {   // the tell a reply reached the lead (classifySkipOutcome)
    return isWatchdogRule(ownerRule) ? 'watchdog_recovered' : 'sent';
  }
  if (result.deferred) return null;   // still ours: the retry re-enters as the same action
  return String(result.reason || result.action || 'not_sent').slice(0, 120);
}

export default { turnLockMode, decideClaim, watchdogMayAnswer, releaseOutcomeFor, isWatchdogRule, turnClaimScope, STALE_LOCK_MS, WATCHDOG_MIN_AGE_MS };
