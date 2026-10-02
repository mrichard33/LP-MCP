/**
 * Live chat → GHL contact fields — src/live-chat/identity-capture.js
 *
 * 2026-10-02 review: the lane's old capture was one PUT of whatever the model
 * reported, and it went wrong four ways:
 *   - it OVERWROTE what was on file (the SMS path fills empty fields only),
 *   - a name typed on its own was never saved (the PUT fired only with a
 *     phone or email), so the bot asked for it again,
 *   - a zip or street address typed in chat was never saved at all,
 *   - one malformed email made GHL reject the whole PUT, losing the phone and
 *     name with it.
 * And when a visitor types a phone that already belongs to a contact, GHL
 * MERGES the guest away; a PUT on the guest id then fails or, worse, the
 * sweep's re-drive overwrote the surviving customer's real name and email.
 *
 * Now the chat uses the SMS path's own rules: heuristicExtract over the
 * visitor's words, the model's report filling only what the patterns missed,
 * then promoteIdentityToGHL — fill-if-empty, placeholder names replaced,
 * conflicts logged as events, never written. The contact is read fresh first;
 * if it no longer exists (merged), nothing is written.
 *
 * No I/O unless the visitor's words or the model's report carry something.
 */

import { heuristicExtract, promoteIdentityToGHL, normalizePhoneE164, isPlaceholderName } from '../services/identity-extraction.js';

const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;
const NAME_WORD = /^[A-Za-z][A-Za-z'’-]{1,20}$/;

function titleCase(w) {
  const s = String(w || '').trim();
  return /^[a-z'’-]+$/.test(s) || /^[A-Z'’-]+$/.test(s) ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
}

/**
 * The identity to promote: the visitor's own words first, the model's report
 * for what the patterns missed. Every value it returns is marked
 * 'extracted', so buildPromotionPayload will write it only into an empty
 * (or placeholder) field. Pure.
 */
export function chatIdentity({ visitorTexts = [], capture = {} } = {}) {
  const id = heuristicExtract(visitorTexts.filter(Boolean).map(text => ({ direction: 'inbound', text })));
  const src = id._source || (id._source = {});

  if (!id.phone && capture.phone) {
    const e164 = normalizePhoneE164(capture.phone);
    if (e164) { id.phone = e164; src.phone = 'extracted'; }
  }
  const email = String(capture.email || '').trim().toLowerCase();
  if (!id.email && email && !capture.email_malformed && EMAIL_OK.test(email)) {
    id.email = email; src.email = 'extracted';
  }
  if (!id.first_name && capture.name && !isPlaceholderName(capture.name)) {
    const words = String(capture.name).trim().split(/\s+/).filter(w => NAME_WORD.test(w));
    if (words.length) {
      id.first_name = titleCase(words[0]); src.first_name = 'extracted';
      if (words.length > 1) { id.last_name = words.slice(1).map(titleCase).join(' '); src.last_name = 'extracted'; }
    }
  }
  return id;
}

/** True when the identity carries anything worth a GHL write. Pure. */
export function hasIdentity(id) {
  const src = id?._source || {};
  return Object.values(src).some(v => v === 'extracted' || v === 'geocoded');
}

/** The GHL record shape buildPromotionPayload compares against. Pure. */
export function currentFromContact(c = {}) {
  return {
    firstName: c.firstName ?? c.first_name ?? null,
    lastName: c.lastName ?? c.last_name ?? null,
    email: c.email ?? null,
    phone: c.phone ?? null,
    address1: c.address1 ?? null,
    city: c.city ?? null,
    state: c.state ?? null,
    postalCode: c.postalCode ?? c.postal_code ?? null,
  };
}

/**
 * @param {string} contactId
 * @param {{visitorTexts?: string[], capture?: object}} input
 * @param {{fetchContact: Function, promote?: Function}} deps
 * @returns {Promise<{written:number, reason:string}>}
 */
export async function captureChatIdentity(contactId, input, deps) {
  const id = chatIdentity(input);
  if (!hasIdentity(id)) return { written: 0, reason: 'nothing_to_capture' };
  let contact = null;
  try {
    contact = await deps.fetchContact(contactId);
  } catch (err) {
    return { written: 0, reason: `contact_unreadable: ${err.message}` };
  }
  // Merged away (or deleted): the surviving contact is someone's real record,
  // and nothing here may write to it.
  if (!contact || (contact.id && contact.id !== contactId)) return { written: 0, reason: 'contact_gone_or_merged' };
  const promote = deps.promote || promoteIdentityToGHL;
  const res = await promote(contactId, { identity: id }, { current: currentFromContact(contact), trigger: 'live_chat' });
  return { written: res?.written || 0, conflicts: res?.conflicts || 0, reason: res?.failed ? 'ghl_write_failed' : 'ok' };
}
