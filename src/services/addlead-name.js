/**
 * The name on an LP addlead — src/services/addlead-name.js
 *
 * 2026-10-16 (Melissa, GHL 6U6uceZGMQRz8XEQc9Lk): the chat widget creates a
 * visitor as "Guest Visitor xxxxx". When the bot saved only the first name, the
 * widget's surname "Visitor Anlxy" stayed beside it, and every downstream copy
 * of the contact name carried it. The user's rule: no LP lead is created while
 * the name is still a placeholder, and when the chat has the real name but the
 * record is stale, the chat name is used.
 *
 * Applied in the addlead proxy (every live I.LP-OUT / 8e30ff37 send goes through
 * it) before the body reaches LP:
 *   - a "Visitor xxxx" surname is dropped, always;
 *   - a placeholder first name ("Guest", "Guest Visitor …", "Visitor") is
 *     replaced by the contact's current GHL first name when that one is real
 *     (the bot may have saved it after the workflow read the contact);
 *   - still a placeholder → { action: 'hold' }: the proxy sends nothing to LP,
 *     tags `name-placeholder`, and the lead is re-sent when a real name lands
 *     (placeholder-name-followups.js).
 * A BLANK first name is not this rule's business (LP refuses it on its own).
 * Fails open: an unreadable contact keeps today's body (minus the surname).
 */

import { isPlaceholderName, isPlaceholderSurname } from './identity-extraction.js';

const looksLikeGhlContactId = (v) => /^[A-Za-z0-9]{18,24}$/.test(String(v || ''));

export async function cleanAddleadName(body, deps = {}) {
  const b = { ...(body || {}) };
  const notes = [];
  if (isPlaceholderSurname(b.lastname)) { b.lastname = ''; notes.push('placeholder_surname_dropped'); }
  const first = String(b.firstname || '').trim();
  if (!first || !isPlaceholderName(first) && !isPlaceholderName(`${first} ${b.lastname || ''}`.trim())) {
    return { action: 'forward', body: b, notes };
  }
  // A placeholder first name: the contact may hold the real one by now.
  if (looksLikeGhlContactId(b.lognumber) && deps.getContact) {
    let contact = null;
    try { contact = await deps.getContact(String(b.lognumber)); } catch { contact = undefined; }
    if (contact === undefined) return { action: 'forward', body: b, notes: [...notes, 'contact_unreadable'] };
    const realFirst = String(contact?.firstName || '').trim();
    if (realFirst && !isPlaceholderName(realFirst)) {
      b.firstname = realFirst;
      const realLast = String(contact?.lastName || '').trim();
      b.lastname = realLast && !isPlaceholderSurname(realLast) ? realLast : '';
      return { action: 'forward', body: b, notes: [...notes, 'chat_name_used'] };
    }
  }
  return { action: 'hold', body: b, notes: [...notes, 'placeholder_first_name'] };
}
