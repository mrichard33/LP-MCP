/**
 * A rehash rep's manual message pauses the bot 15 minutes — src/agentic/rehash-pause.js
 * (Mark, 2026-10-21, with John Manieri and Brandon)
 *
 * Pure. Jim Anderson (5Cp5CiWtQ2zSRlxb2XPL): John texted Jim by hand at 8:40
 * and 8:42, Jim answered at 8:42, and the bot answered too (8:49, a booking for
 * the wrong day). Then John texted three more times and the bot answered again
 * at 8:53 and 8:55. On a rehash contact, a manual text or email from someone on
 * REHASH_TEAM_USER_IDS does not hand the lead over (that is rehash-owned.js);
 * it PAUSES the bot:
 *   - the lead's next inbound gets no reply now; a 15-minute timer starts from
 *     the later of the rep's last manual message and the inbound;
 *   - a newer rehash-team manual message before it fires restarts the timer;
 *   - a call booked / an LP appointment set ends it (ownership wins);
 *   - when it fires with no newer team message, the thread is read once:
 *     complete → silent close, open → the normal reply;
 *   - nothing proactive goes out while paused.
 * Pre-demo contacts keep the 2026-10-19 option B (human-takeover.js) unchanged.
 *
 * A manual message counts when it came after our last bot send, or in the
 * REHASH_PAUSE_MINUTES before now: the reader passes every manual outbound
 * after min(last bot send, now − minutes), and this module keeps the team's.
 */
import { simModeOverrides } from '../simulator/sim-overrides.js';

export const REHASH_PAUSE_MODES = Object.freeze(['off', 'shadow', 'live']);
export const REHASH_PAUSE_REASON = 'rehash_paused';
export const REHASH_HANDED_OFF_REASON = 'rehash_handed_off';
export const CONVERSATION_COMPLETE_REASON = 'conversation_complete';
export const REHASH_PAUSE_MINUTES_DEFAULT = 15;
export const REHASH_PAUSE_MAX_RESTARTS_DEFAULT = 12;
/** How far back "after our last bot send" reaches when the bot never sent. */
export const NO_BOT_SEND_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

const MIN_MS = 60 * 1000;

/** REHASH_PAUSE_MODE (default shadow; a bot-gate run may force it). */
export function rehashPauseMode(env = process.env) {
  const v = String(simModeOverrides().rehashPauseMode ?? env?.REHASH_PAUSE_MODE ?? '').trim().toLowerCase();
  return REHASH_PAUSE_MODES.includes(v) ? v : 'shadow';
}

const posInt = (raw, def) => {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};
export function rehashPauseMinutes(env = process.env) { return posInt(env?.REHASH_PAUSE_MINUTES, REHASH_PAUSE_MINUTES_DEFAULT); }
export function rehashPauseMaxRestarts(env = process.env) { return posInt(env?.REHASH_PAUSE_MAX_RESTARTS, REHASH_PAUSE_MAX_RESTARTS_DEFAULT); }

/** Where the manual-message read starts: after our last bot send, or `minutes` before now, whichever is earlier. */
export function manualReadSinceMs({ lastBotSendMs = null, nowMs = Date.now(), minutes = REHASH_PAUSE_MINUTES_DEFAULT } = {}) {
  const windowStart = nowMs - minutes * MIN_MS;
  const afterBot = Number.isFinite(lastBotSendMs) ? lastBotSendMs : nowMs - NO_BOT_SEND_LOOKBACK_MS;
  return Math.min(afterBot, windowStart);
}

/** The manual messages a rehash-team user sent ({ at, user_id }), newest last. */
export function teamManuals(manuals, teamUserIds = []) {
  const team = new Set((teamUserIds || []).map(String));
  return (Array.isArray(manuals) ? manuals : [])
    .filter((m) => m && team.has(String(m.user_id || '')) && Number.isFinite(Date.parse(m.at || '')))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * The pause decision for one send to a rehash contact. Pure.
 * @param {{ manuals: object[], teamUserIds: string[], inboundMs?: number|null, nowMs?: number,
 *           minutes?: number, maxRestarts?: number, prior?: {anchor_ms:number, restarts:number}|null }} a
 *   manuals: every manual outbound after manualReadSinceMs (team or not)
 *   prior: the pause this same send row is already in (action_payload.rehash_pause)
 * @returns {{ action: 'none' } | { action: 'hold', anchorMs, retryAtMs, restarts, restarted, manualAt }
 *         | { action: 'handed_off', anchorMs, restarts } | { action: 'fire', anchorMs, restarts }}
 */
export function pauseDecision({
  manuals = [], teamUserIds = [], inboundMs = null, nowMs = Date.now(),
  minutes = REHASH_PAUSE_MINUTES_DEFAULT, maxRestarts = REHASH_PAUSE_MAX_RESTARTS_DEFAULT, prior = null,
} = {}) {
  const team = teamManuals(manuals, teamUserIds);
  const priorAnchor = Number.isFinite(prior?.anchor_ms) ? prior.anchor_ms : null;
  if (!team.length && priorAnchor == null) return { action: 'none' };
  const lastManualMs = team.length ? Date.parse(team[team.length - 1].at) : null;
  const anchorMs = Math.max(...[lastManualMs, Number.isFinite(inboundMs) ? inboundMs : null, priorAnchor].filter(Number.isFinite));
  const priorRestarts = Number.isFinite(prior?.restarts) ? prior.restarts : 0;
  if (nowMs < anchorMs + minutes * MIN_MS) {
    // A restart is a team message newer than the anchor this row was held on.
    const restarted = priorAnchor != null && lastManualMs != null && lastManualMs > priorAnchor;
    const restarts = priorRestarts + (restarted ? 1 : 0);
    if (restarts > maxRestarts) return { action: 'handed_off', anchorMs, restarts };
    return {
      action: 'hold', anchorMs, retryAtMs: anchorMs + minutes * MIN_MS, restarts, restarted,
      manualAt: lastManualMs != null ? new Date(lastManualMs).toISOString() : null,
    };
  }
  return { action: 'fire', anchorMs, restarts: priorRestarts };
}

/** What a decision means for this send in a mode. Pure. */
export function pauseOutcome({ mode = 'shadow', decision, proactive = false } = {}) {
  if (!REHASH_PAUSE_MODES.includes(mode) || mode === 'off' || !decision || decision.action === 'none') return 'send';
  if (mode === 'shadow') return decision.action === 'fire' ? 'send' : 'would_' + (decision.action === 'hold' ? 'hold' : 'skip');
  if (decision.action === 'handed_off') return 'skip';
  // Nothing proactive goes out while paused: a bot-initiated send has no
  // inbound to answer later, so it is dropped rather than held.
  if (decision.action === 'hold') return proactive ? 'skip' : 'hold';
  return 'fire';
}
