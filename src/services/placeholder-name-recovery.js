/**
 * Placeholder-name recovery — src/services/placeholder-name-recovery.js
 *
 * 2026-09-28. The live-chat widget creates every visitor as "Guest Visitor
 * xxxxx", and I.CN's name normalisation often leaves just "guest" in the
 * first name with the surname blanked. isPlaceholderName() only matches the
 * full "guest visitor" form, so a bare "guest" passed every check: contact
 * 59eU0qiZ0BwhV1BZGFfm booked an estimate as "guest", and 7dhVGD3jZm5K86Q7YS8U
 * was still "guest" in GHL after LP had "Stephen Brookfield".
 *
 * create_lp_lead now calls this before it sends a lead whose first name is
 * empty or a placeholder: read the chat, pull out the name the visitor gave,
 * write it to the GHL contact, and send LP the real name. No name in the chat
 * → the caller skips and flags the contact; LP never gets "Guest Visitor".
 *
 * The pure pieces (needsNameRecovery, buildRecoveryCorpus, isTrustworthyName)
 * are exported for scripts/test-placeholder-name-recovery.js. Network and
 * database reach go through `deps` (CLAUDE.md "Writing code here").
 */

import {
  isPlaceholderName,
  extractIdentityLLM,
  buildPromotionPayload,
  NAME_PLACEHOLDER_TAG,
} from './identity-extraction.js';

// First names the widget / normaliser leave behind. A real person called
// "Guest" or "Visitor" is far rarer than this bug.
const BARE_PLACEHOLDER_FIRST_RE = /^(guest|visitor)$/i;

/** True when the first name is missing or a chat-widget placeholder. */
export function needsNameRecovery(firstName, lastName) {
  const f = String(firstName || '').trim();
  const l = String(lastName || '').trim();
  if (!f) return true;
  if (BARE_PLACEHOLDER_FIRST_RE.test(f)) return true;
  return isPlaceholderName(f) || isPlaceholderName(`${f} ${l}`);
}

/**
 * GHL conversation messages + the Chat Transcript field → extraction turns.
 * The transcript field is the visitor's side of the widget chat joined with
 * " / ", so it goes in as inbound.
 */
export function buildRecoveryCorpus(transcript, messages = []) {
  const turns = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const text = String(m?.body ?? m?.text ?? '').trim();
    if (!text) continue;
    const dir = String(m?.direction || '').toLowerCase() === 'outbound' ? 'outbound' : 'inbound';
    turns.push({ direction: dir, text });
  }
  const t = String(transcript || '').trim();
  if (t) turns.push({ direction: 'inbound', text: t });
  return turns;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Guard against the model handing back a name the customer never gave.
 *   1. The first name must appear, as a word, in the customer's own text.
 *   2. It must not be an agent introducing itself — "Hi, I'm Sarah an
 *      appointment specialist", "Audrey here regarding Reece Windows". Checked
 *      on outbound messages and on any inbound text that mentions Reece (bot
 *      lines do end up inside the transcript field — 1cMRCgPa7bU9dnhtMHeI).
 */
export function isTrustworthyName(firstName, turns = []) {
  const f = String(firstName || '').trim();
  if (!f || needsNameRecovery(f, '')) return false;
  const word = new RegExp(`\\b${escapeRe(f)}\\b`, 'i');
  const inbound = turns.filter((t) => t.direction !== 'outbound');
  if (!inbound.some((t) => word.test(t.text))) return false;

  const selfIntro = new RegExp(
    `\\b(?:i(?:'|’)?m|i am|this is|my name is)\\s+${escapeRe(f)}\\b|\\b${escapeRe(f)}\\s+here\\b`, 'i');
  const agentish = turns.filter((t) => t.direction === 'outbound' || /reece/i.test(t.text));
  return !agentish.some((t) => selfIntro.test(t.text));
}

async function defaultFetchMessages(contactId) {
  const { ghlFetch } = await import('../actions/helpers.js');
  const loc = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';
  const search = await ghlFetch('GET', `/conversations/search?locationId=${loc}&contactId=${contactId}`);
  const convs = Array.isArray(search) ? search : (search?.conversations || []);
  const out = [];
  for (const c of convs.slice(0, 3)) {
    const data = await ghlFetch('GET', `/conversations/${c.id}/messages?limit=60`);
    const msgs = data?.messages?.messages || data?.messages || [];
    if (Array.isArray(msgs)) out.push(...msgs);
  }
  return out;
}

async function defaultUpdateFields(contactId, payload) {
  const { updateGHLContactStandardFields } = await import('../ghl.js');
  return updateGHLContactStandardFields(contactId, payload);
}

async function defaultRemoveTags(contactId, tags) {
  const { removeGHLTags } = await import('../ghl.js');
  return removeGHLTags(contactId, tags);
}

/**
 * Recover the visitor's real name from the chat and write it to GHL.
 *
 * @param {string} contactId
 * @param {object} contact   live GHL contact (firstName, lastName, customFields, ...)
 * @param {object} opts
 * @param {string} opts.transcript  Chat Transcript custom-field value
 * @returns {Promise<{ found: boolean, firstName?: string, lastName?: string,
 *   payload?: object, ghlWrite?: true|false|string, reason?: string }>}
 *   `payload` is every standard field the chat filled (name, and address /
 *   email where the contact had none) — the caller sends these to LP.
 */
export async function recoverPlaceholderName(contactId, contact, { transcript = '' } = {}, deps = {}) {
  const fetchMessages = deps.fetchMessages || defaultFetchMessages;
  const extract = deps.extract || extractIdentityLLM;
  const updateFields = deps.updateFields || defaultUpdateFields;
  const removeTags = deps.removeTags || defaultRemoveTags;

  let messages = [];
  try {
    messages = await fetchMessages(contactId);
  } catch (err) {
    // The transcript alone may still carry the name — keep going.
    console.warn(`[NameRecovery] conversation read failed for ${contactId}: ${err.message}`);
  }
  const turns = buildRecoveryCorpus(transcript, messages);
  if (!turns.length) return { found: false, reason: 'no chat text to read' };

  const identity = await extract(turns, { contactId });
  if (!identity?.first_name || !isTrustworthyName(identity.first_name, turns)) {
    return { found: false, reason: identity?.first_name ? `rejected "${identity.first_name}" (not in the customer's own words)` : 'no name in the chat' };
  }

  // The contact's current name is a placeholder by definition here. Blank it
  // for the payload builder: it only overwrites a name it recognises as a
  // placeholder, and it does not recognise a bare "guest".
  const src = identity._source || {};
  const { payload } = buildPromotionPayload(
    { ...contact, firstName: null, lastName: null },
    { ...identity, _source: { ...src, first_name: 'extracted', last_name: identity.last_name ? 'extracted' : src.last_name } },
  );
  if (!payload.firstName) return { found: false, reason: 'no promotable name' };

  let ghlWrite = false;
  try {
    ghlWrite = await updateFields(contactId, payload);
    if (ghlWrite === true) await removeTags(contactId, [NAME_PLACEHOLDER_TAG]).catch(() => {});
  } catch (err) {
    ghlWrite = `error: ${err.message}`;
  }

  return { found: true, firstName: payload.firstName, lastName: payload.lastName || '', payload, ghlWrite };
}

// ─── LP side (used by the guest-visitor remediation sweep) ────────

const cleanNamePart = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * From this contact's lp_leads rows, the newest name that is NOT a
 * placeholder, or null. LP often learns the name from a phone call or a
 * vendor feed while GHL still says "guest" (7dhVGD3jZm5K86Q7YS8U → Stephen
 * Brookfield, 2026-09-28).
 */
export function pickLpRealName(rows = []) {
  const sorted = [...(Array.isArray(rows) ? rows : [])]
    .sort((a, b) => String(b?.created_at_lp || '').localeCompare(String(a?.created_at_lp || '')));
  for (const r of sorted) {
    const first = cleanNamePart(r?.first_name);
    const last = cleanNamePart(r?.last_name);
    if (first && !needsNameRecovery(first, last)) return { firstName: first, lastName: last };
  }
  return null;
}

/** Distinct LP prospect ids whose cached name is still a placeholder. */
export function lpProspectsNeedingName(rows = []) {
  const out = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r?.lp_prospect_id && needsNameRecovery(r.first_name, r.last_name)) out.add(String(r.lp_prospect_id));
  }
  return [...out];
}
