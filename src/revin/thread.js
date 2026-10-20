/**
 * Revin turns in the bot's conversation history — src/revin/thread.js (2026-10-19)
 *
 * Pure. BOT_INCLUDE_REVIN_THREAD (default false) decides whether the two
 * existing history loaders (context-builder's conversation_recent for SMS, the
 * live chat's normalizeThread) see what Revin texted the lead and what the lead
 * texted back. Off, mergeRevinTurns returns the SAME array it was given, so the
 * off path is byte-for-byte today's history.
 *
 * Context only: no prompt copy changes (the chatbot restructure rule: none until
 * Phase 3). A Revin turn is labelled by its channel, which the reply writer
 * already prints as "inbound/<channel>" (response-generator.js), so the model
 * reads "outbound/Revin (automated texting)" with no new prompt line. The
 * planner's 6-hour session cut (nepq-planner.js currentSession) keeps Revin
 * turns older than the current session out of its move decisions.
 */
import { simIncludeRevinThread } from '../simulator/sim-overrides.js';

export const REVIN_THREAD_LABEL = 'Revin (automated texting)';
export const REVIN_THREAD_MAX_TURNS = 20;
export const REVIN_THREAD_MAX_DAYS = 14;
export const THREAD_CAP = 30;

/** The flag, with the simulator's per-run override first. */
export function revinThreadEnabled(env = process.env) {
  const sim = simIncludeRevinThread();
  if (sim != null) return sim;
  return String(env.BOT_INCLUDE_REVIN_THREAD || '').toLowerCase().trim() === 'true';
}

/** A contact_thread_v row → a history turn, or null for an event with no text. */
export function toRevinTurn(row) {
  if (!row || (row.direction !== 'inbound' && row.direction !== 'outbound')) return null;
  const text = String(row.body ?? '').trim();
  if (!text || !row.sent_at) return null;
  return { direction: row.direction, channel: REVIN_THREAD_LABEL, text, type: 'text', timestamp: row.sent_at, source: 'revin' };
}

function tsOf(t) {
  const v = Date.parse(t?.timestamp ?? t?.dateAdded ?? t?.at ?? '');
  return Number.isFinite(v) ? v : null;
}

/**
 * Merge Revin turns into a history list: drop a Revin text the history already
 * holds (same direction and words), order by time, keep the newest `cap`.
 * No Revin turns → the input array itself.
 */
export function mergeRevinTurns(conversation, revinTurns, { cap = THREAD_CAP } = {}) {
  if (!Array.isArray(revinTurns) || revinTurns.length === 0) return conversation;
  const base = Array.isArray(conversation) ? conversation : [];
  const seen = new Set(base.map((t) => `${t.direction}|${String(t.text ?? '').trim()}`));
  const extra = revinTurns.filter((t) => t && !seen.has(`${t.direction}|${String(t.text ?? '').trim()}`));
  if (!extra.length) return conversation;
  // A turn with no readable time keeps its place ahead of the newest; stable sort.
  const merged = [...base, ...extra]
    .map((t, i) => ({ t, i, at: tsOf(t) }))
    .sort((a, b) => (a.at ?? -Infinity) - (b.at ?? -Infinity) || a.i - b.i)
    .map((x) => x.t);
  return merged.slice(-cap);
}

/**
 * The simulator's Revin history (2026-10-19): one short exchange two days
 * before the run, so `include_revin_thread` can compare every scenario with and
 * without Revin context. Generic on purpose; no customer text.
 */
export function simRevinFixture(nowMs, firstName = null) {
  const t0 = nowMs - 2 * 86_400_000;
  const name = firstName ? ` ${firstName}` : '';
  return [
    { direction: 'outbound', body: `Hi${name}, this is Reece Windows & Doors following up on your request about impact windows. Are you still interested in a free in-home estimate?`, sent_at: new Date(t0).toISOString() },
    { direction: 'inbound', body: 'Maybe, still thinking about it', sent_at: new Date(t0 + 3 * 60_000).toISOString() },
    { direction: 'outbound', body: 'No problem. Whenever you are ready, just reply here and we can find a time that works.', sent_at: new Date(t0 + 4 * 60_000).toISOString() },
  ].map(toRevinTurn);
}
