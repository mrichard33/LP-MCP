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
 * Dependency-free + pure.
 */

export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;    // 24h
export const OPTOUT_WINDOW_MS = 24 * 60 * 60 * 1000;   // 24h
export const BOOKING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7d
export const FRESHNESS_MAX_AGE_MS = 2 * 60 * 60 * 1000;   // 2h
export const SCAN_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000;  // 8d

/**
 * STOP family, whole-word, case-insensitive (handoff §5.1).
 * Whole-word matters: "stopped by the showroom" and "remove me from the list"
 * are opposite intents, and only the second is an opt-out. \b on both ends
 * keeps "stop" out of "stopped" and "nonstop".
 */
export const STOP_PATTERN = /\b(stop|stopall|unsubscribe|cancel|quit|end|optout|opt[\s-]?out|remove\s+me|do\s+not\s+contact)\b/i;

/** DNC-family tags (handoff §1.6). A tag in this set is an opt-out. */
export const DNC_TAGS = new Set([
  'dnc', 'dnc-sms', 'do-not-contact', 'stage:dnc', 'unsubscribed',
]);

/** Does this inbound body read as an opt-out? */
export function isOptOutText(text) {
  if (!text) return false;
  return STOP_PATTERN.test(String(text));
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
  DNC_TAGS,
  isOptOutText,
  hasDncTag,
  findFirstReply,
  findFirstBooking,
  findOptOut,
  isSourceFresh,
  isWindowClosed,
  computeOutcome,
};
