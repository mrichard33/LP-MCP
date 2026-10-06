/**
 * Bot Review — outcomes pure core — src/bot-feedback/outcomes-core.js
 *
 * v1.0 — 2026-09-11. BOT REVIEW PHASE 0.
 *   PROBLEM: a reviewer grading a reply can see the words but not what the
 *   words DID. Reply rate, booking rate and opt-out rate are the only honest
 *   check on whether a "good" reply was actually good.
 *   FIX: bot_outcomes, computed from the HL cache by a 30-minute LP MCP job.
 *   This file is the pure half — windows, matching and finality — so every
 *   rule is unit-testable with no DB.
 *
 * CROSS-DB RULE (handoff §1.3): LP and HL are two separate Supabases and are
 * NEVER joined. outcomes.js fetches candidate rows from LP, fetches messages /
 * appointments / tags from HL, and these functions do the matching IN CODE.
 *
 * FRESHNESS RULE (handoff §5.1): HL is a cache. A quiet cache and a quiet lead
 * look identical, so an outcome computed against a stale cache is recorded with
 * source_fresh=false and is NEVER marked final.
 *
 * Pure. The one import (do-not-knock.js) is itself dependency-free.
 */

import { isKnockNotOptOut } from '../agentic/do-not-knock.js';

export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;    // 24h
export const OPTOUT_WINDOW_MS = 24 * 60 * 60 * 1000;   // 24h
export const BOOKING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7d
export const FRESHNESS_MAX_AGE_MS = 2 * 60 * 60 * 1000;   // 2h
export const SCAN_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000;  // 8d

/**
 * Opt-out keywords for the METRIC only (2026-10-06, AI OS batch 1, PR 4).
 *
 * The old single pattern counted "cancel", "end" and "quit" anywhere in a
 * message, so "can we cancel tuesday" and "end of the week works" were scored
 * as the bot driving the lead away, which inflated the opt-out rate. The rule
 * now follows the carrier keyword set:
 *   - a bare keyword is an opt-out only when it is the WHOLE message
 *     (after normalizeOptOutText), and
 *   - a phrase that cannot mean anything else counts anywhere.
 * Whole-word still matters: "stopped by the showroom" is not "stop".
 *
 * Nothing on the compliance path reads this: the STOP/DNC handling lives in
 * behavioral-emitter.js (DNC_PATTERNS), isDNCSignal and the classifier.
 */
export const OPTOUT_WHOLE_MESSAGE = new Set([
  'stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit',
  'opt out', 'optout', 'revoke',
]);

/**
 * Matched against the normalized text. "do not contact" is kept from the old
 * pattern (it had a test and is unambiguous).
 */
export const OPTOUT_PHRASE_PATTERN = /\b(?:stop|unsubscribe|stop texting|stop messaging|remove me|do not text|dont text|do not contact)\b/;

/** @deprecated kept for callers of the old export; isOptOutText is the rule. */
export const STOP_PATTERN = OPTOUT_PHRASE_PATTERN;

/** DNC-family tags (handoff §1.6). A tag in this set is an opt-out. */
export const DNC_TAGS = new Set([
  'dnc', 'dnc-sms', 'do-not-contact', 'stage:dnc', 'unsubscribed',
]);

/**
 * Lowercase, trim, strip punctuation: an apostrophe is dropped ("don't" →
 * "dont"), any other punctuation becomes a space ("opt-out" → "opt out"),
 * and runs of whitespace collapse. Pure.
 */
export function normalizeOptOutText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * An iPhone / Android reaction to one of OUR messages: `Liked “… Reply STOP to
 * opt out.”`, `Reacted 👍 to “…”`. The quote is our own text, so a STOP inside
 * it is ours, not the lead's (2026-10-06: a lead who "Liked" our intro text was
 * shown as opted out on every message in Bot Review).
 */
export const REACTION_PATTERN =
  /^\s*(?:liked|loved|disliked|laughed at|emphasi[sz]ed|questioned|reacted\s+\S{1,12}\s+to|removed an?\s+\S+\s+from)\s+[“”"'‘]/iu;

export function isReactionText(text) {
  return REACTION_PATTERN.test(String(text ?? ''));
}

/** Does this inbound body read as an opt-out? */
export function isOptOutText(text) {
  if (!text) return false;
  if (isReactionText(text)) return false;
  const t = normalizeOptOutText(text);
  if (!t) return false;
  if (OPTOUT_WHOLE_MESSAGE.has(t)) return true;
  // "Please stop knocking on my door" is a door complaint, not a text
  // opt-out (Mark, 2026-10-03). The same predicate the reply path uses.
  if (isKnockNotOptOut(text)) return false;
  return OPTOUT_PHRASE_PATTERN.test(t);
}

/** Does this tag list carry a DNC-family tag? */
export function hasDncTag(tags) {
  if (!Array.isArray(tags)) return false;
  return tags.some((t) => DNC_TAGS.has(String(t).toLowerCase().trim()));
}

function ms(value) {
  if (value == null) return NaN;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(t) ? t : NaN;
}

function iso(value) {
  const t = ms(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * First inbound from the contact strictly AFTER sent_at and within 24h.
 *
 * "Strictly after" is deliberate: an inbound stamped at the same millisecond
 * as our send is the message we were replying TO, not a reply to us.
 *
 * @param {Array} messages HL messages rows ({direction, sent_at|created_at, body})
 * @returns {string|null} ISO timestamp
 */
export function findFirstReply(messages, sentAt, windowMs = REPLY_WINDOW_MS) {
  const base = ms(sentAt);
  if (!Number.isFinite(base)) return null;
  let best = null;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.direction !== 'inbound') continue;
    const t = ms(m.sent_at ?? m.created_at);
    if (!Number.isFinite(t)) continue;
    if (t <= base || t > base + windowMs) continue;
    if (best === null || t < best) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
}

/**
 * First appointment CREATED after sent_at and within 7 days.
 *
 * Keyed on creation, not on start_time: an appointment booked today for next
 * month is a booking this reply earned. HL stores GHL's creation stamp in
 * raw_json->>'dateAdded' (present on all 12,658 cached rows); created_at is the
 * cache row's own birthday and is only a fallback.
 */
export function findFirstBooking(appointments, sentAt, windowMs = BOOKING_WINDOW_MS) {
  const base = ms(sentAt);
  if (!Number.isFinite(base)) return null;
  let best = null;
  for (const a of Array.isArray(appointments) ? appointments : []) {
    if (a?.deleted_at) continue;
    const t = ms(a?.raw_json?.dateAdded ?? a?.date_added ?? a?.created_at);
    if (!Number.isFinite(t)) continue;
    if (t <= base || t > base + windowMs) continue;
    if (best === null || t < best) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
}

/**
 * Opt-out within 24h: a STOP-family inbound, or a DNC-family tag on the
 * contact.
 *
 * The tag branch is coarser than the message branch on purpose — the HL
 * contacts cache stores the tag list but not when each tag was applied, so the
 * best available stamp is the contact's last cache update. It only counts when
 * that update itself falls inside the window, which keeps a DNC tag applied
 * months ago from being attributed to today's reply.
 */
export function findOptOut(messages, contact, sentAt, windowMs = OPTOUT_WINDOW_MS) {
  const base = ms(sentAt);
  if (!Number.isFinite(base)) return null;

  let best = null;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.direction !== 'inbound') continue;
    const t = ms(m.sent_at ?? m.created_at);
    if (!Number.isFinite(t)) continue;
    if (t <= base || t > base + windowMs) continue;
    if (!isOptOutText(m.body)) continue;
    if (best === null || t < best) best = t;
  }

  if (best === null && contact && hasDncTag(contact.tags)) {
    const t = ms(contact.date_updated ?? contact.updated_at ?? contact.synced_at);
    if (Number.isFinite(t) && t > base && t <= base + windowMs) best = t;
  }

  return best === null ? null : new Date(best).toISOString();
}

/**
 * Is the HL cache fresh enough to trust? Every entity passed must have synced
 * within maxAgeMs. An absent or unparseable stamp is NOT fresh — unknown is
 * never treated as good news.
 */
export function isSourceFresh(lastSyncedAtByEntity, now = Date.now(), maxAgeMs = FRESHNESS_MAX_AGE_MS) {
  const values = Object.values(lastSyncedAtByEntity ?? {});
  if (values.length === 0) return false;
  return values.every((v) => {
    const t = ms(v);
    return Number.isFinite(t) && now - t <= maxAgeMs;
  });
}

/** Has the 7-day booking window closed for this send? */
export function isWindowClosed(sentAt, now = Date.now(), windowMs = BOOKING_WINDOW_MS) {
  const base = ms(sentAt);
  if (!Number.isFinite(base)) return false;
  return now > base + windowMs;
}

/**
 * Compute one bot_outcomes row.
 *
 * `final` is true only when the 7-day window has closed AND the cache was
 * fresh when we looked (handoff §5.1). A row that goes final stops being
 * rescanned, so finalizing against a stale cache would freeze a wrong answer
 * forever — hence both conditions, never one.
 */
export function computeOutcome({
  context,
  messages = [],
  appointments = [],
  contact = null,
  sourceFresh = false,
  now = Date.now(),
}) {
  const sentAt = iso(context?.sent_at);
  if (!sentAt) return null;

  const replied_at = findFirstReply(messages, sentAt);
  const booked_at = findFirstBooking(appointments, sentAt);
  const opted_out_at = findOptOut(messages, contact, sentAt);

  return {
    message_type: context.message_type,
    message_ref: String(context.message_ref),
    ghl_contact_id: context.ghl_contact_id ?? null,
    sent_at: sentAt,
    replied_at,
    booked_at,
    opted_out_at,
    source_fresh: !!sourceFresh,
    checked_at: new Date(now).toISOString(),
    final: !!sourceFresh && isWindowClosed(sentAt, now),
  };
}

export default {
  REPLY_WINDOW_MS,
  OPTOUT_WINDOW_MS,
  BOOKING_WINDOW_MS,
  FRESHNESS_MAX_AGE_MS,
  SCAN_LOOKBACK_MS,
  STOP_PATTERN,
  OPTOUT_WHOLE_MESSAGE,
  OPTOUT_PHRASE_PATTERN,
  DNC_TAGS,
  normalizeOptOutText,
  REACTION_PATTERN,
  isReactionText,
  isOptOutText,
  hasDncTag,
  findFirstReply,
  findFirstBooking,
  findOptOut,
  isSourceFresh,
  isWindowClosed,
  computeOutcome,
};
