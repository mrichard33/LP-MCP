/**
 * Capacity gate cards — src/notifications/capacity-cards.js
 *
 * Mark, 2026-10-15 (market capacity gate, handoff v3). Three #contact-center
 * cards, each something a person must act on (CLAUDE.md: #contact-center gets
 * only that), each posted once:
 *
 *   - TIME CHANGE REQUEST (R5): a lead asked for 6:30 / 7:00 and was booked at
 *     6:00 PM. One card per request row.
 *   - NO TIMES OPEN (R6): the lead's market has no in-home time for 14 days,
 *     so the bot told them the team will reach out. Once per contact per day.
 *   - LP NOTE NOT WRITTEN (R8): the appointment never reached LP in time for
 *     the confirming agent's note. Once per request (alerted_at).
 *
 * Slack is the destination of record (postToSlack). The channel is
 * TIME_CHANGE_SLACK_CHANNEL (default C0C6BNY30TB, #contact-center). The card
 * builders are pure; a customer phone never appears on them. No pronoun for
 * the contact: the card uses their name.
 */

import { ghlContactUrl } from '../agentic/rehash.js';
import { filterNew, recordPosted } from '../alert-posted.js';

export const NO_CAPACITY_AUDIT = 'capacity_gate_no_times';

export function timeChangeChannel(env = process.env) {
  return String(env.TIME_CHANGE_SLACK_CHANNEL || 'C0C6BNY30TB').trim();
}
function link(contactId, env = process.env) {
  const loc = env.GHL_LOCATION_ID;
  return loc && contactId ? ghlContactUrl(loc, contactId) : null;
}
function marketName(code) {
  return String(code || '').replace(/_MKT$/, '') || 'unknown';
}

/** R5 card. Pure. */
export function buildTimeChangeCard({ contactId, name, market, dateLabel, requestedTime }, env = process.env) {
  const url = link(contactId, env);
  return [
    '🕕 *TIME CHANGE REQUEST*',
    `${name || 'A lead'} asked for ${requestedTime}. The bot booked 6:00 PM on ${dateLabel}.`,
    `Market: ${marketName(market)}`,
    'Please confirm with the customer and move the appointment.',
    url ? `GHL: ${url}` : null,
  ].filter(Boolean).join('\n');
}

/** R6 card. Pure. */
export function buildNoCapacityCard({ contactId, name, market, channel }, env = process.env) {
  const url = link(contactId, env);
  return [
    '📅 *NO VISIT TIMES OPEN*',
    `${name || 'A lead'} wants a visit, and ${marketName(market)} has no in-home time open for the next 14 days (full, or not filed).`,
    `The bot (${channel === 'livechat' ? 'website chat' : 'text'}) said our team will reach out. Please call to find a time.`,
    url ? `GHL: ${url}` : null,
  ].filter(Boolean).join('\n');
}

/** R8 card. Pure. */
export function buildLpNoteMissingCard({ contactId, name, requestedLabel }, env = process.env) {
  const url = link(contactId, env);
  return [
    '⚠️ *LP NOTE NOT WRITTEN*',
    `${name || 'A lead'} asked for ${requestedLabel}, and the bot booked 6:00 PM.`,
    'The appointment has not reached Lead Perfection yet, so the note for the confirming agent is not there. Please add it in LP and move the appointment.',
    url ? `GHL: ${url}` : null,
  ].filter(Boolean).join('\n');
}

async function defaultPost(text, channel) {
  const { postToSlack } = await import('../slack.js');
  return postToSlack(text, channel);
}

/** Post the R5 card. Never throws. @returns {Promise<boolean>} */
export async function postTimeChangeCard(a, deps = {}) {
  try {
    const r = await (deps.post || defaultPost)(buildTimeChangeCard(a), timeChangeChannel());
    if (!r?.ok) console.warn(`[TimeChange] card for ${a.contactId} not posted: ${r?.error || 'unknown'}`);
    return !!r?.ok;
  } catch (err) {
    console.warn(`[TimeChange] card for ${a.contactId} threw: ${err.message}`);
    return false;
  }
}

/** Post the R6 card once per contact per day. Never throws. */
export async function postNoCapacityCard(a, deps = {}) {
  try {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(deps.nowMs ?? Date.now()));
    const items = [{ key: a.contactId, reason: `day:${day}` }];
    const { fresh } = await (deps.filterNew || filterNew)({ audit: NO_CAPACITY_AUDIT, items, ttlDays: 3 });
    if (!fresh.length) return false;
    const r = await (deps.post || defaultPost)(buildNoCapacityCard(a), timeChangeChannel());
    if (!r?.ok) { console.warn(`[CapacityGate] no-times card for ${a.contactId} not posted: ${r?.error || 'unknown'}`); return false; }
    await (deps.recordPosted || recordPosted)({ audit: NO_CAPACITY_AUDIT, items });
    return true;
  } catch (err) {
    console.warn(`[CapacityGate] no-times card for ${a.contactId} threw: ${err.message}`);
    return false;
  }
}

/** Post the R8 card. Never throws. @returns {Promise<boolean>} */
export async function postLpNoteMissingCard(a, deps = {}) {
  try {
    const r = await (deps.post || defaultPost)(buildLpNoteMissingCard(a), timeChangeChannel());
    return !!r?.ok;
  } catch (err) {
    console.warn(`[TimeChangeNote] missing-note card for ${a.contactId} threw: ${err.message}`);
    return false;
  }
}
