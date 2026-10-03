/**
 * guide-name — src/agentic/guide-name.js
 *
 * 2026-10-03 (Mark: "I noticed the hurricane guide sent blank. We need to save
 * the users name to the contact in GHL first."). The guide email is GHL's
 * U.GUIDE workflow, fired by the send-<type>-guide tag, and it greets with
 * {{contact.first_name}}. On contact s2Omf2RcK5YBISwgHHOe the bot added the tag
 * the moment the lead typed an email; nobody had saved a first name, and the
 * email opened "Hi ,". So a guide tag now waits for a saved first name:
 *
 *   - a real first name on the contact            → send now
 *   - a name in the thread (a bare reply to our name ask, "my name is X")
 *     → AWAIT the fill-if-empty GHL write, then send
 *   - neither → hold: the tag becomes guide-pending-name:<type>, and the reply
 *     asks once, "What's your first name, so I can put it on the guide?"
 *   - the next reply: a name → write, then send; still none after our ask
 *     → send anyway (a promised guide is never withheld) and log it.
 *
 * Pure decisions here; I/O through deps so it tests without GHL.
 */

import { nameFromThread } from './sms-booking-turn.js';
import { nameFromReply } from './booking-collect.js';
import { isGuideDeliveryTag } from './guide-delivery.js';

export const GUIDE_NAME_ASK = "What's your first name, so I can put it on the guide?";
export const GUIDE_PENDING_PREFIX = 'guide-pending-name:';
// Our own ask, however the model words it (it must name the name and the guide).
export const GUIDE_NAME_ASK_RX = /\bfirst\s+name\b[^?]{0,80}\bguide\b|\bguide\b[^?]{0,80}\bfirst\s+name\b/i;
const PLACEHOLDER_RX = /^(?:guest|visitor|guest\s+visitor|unknown|n\/?a|none|test|customer|lead|chat\s+visitor|website\s+visitor)$/i;

/** A first name a person would recognise as theirs, or null. Pure. */
export function realFirstName(name) {
  const n = String(name || '').trim().split(/\s+/)[0] || '';
  if (!n || PLACEHOLDER_RX.test(n) || !/^[A-Za-z][A-Za-z'’-]{0,29}$/.test(n)) return null;
  return n[0].toUpperCase() + n.slice(1);
}

/** The holding tag for a delivery tag: send-hurricane-guide → guide-pending-name:hurricane. Pure. */
export function pendingTagFor(deliveryTag) {
  const m = String(deliveryTag || '').trim().toLowerCase().match(/^send-([a-z0-9]+(?:-[a-z0-9]+)*)-guide$/);
  return m ? `${GUIDE_PENDING_PREFIX}${m[1]}` : null;
}

/** The delivery tag a holding tag waits on: guide-pending-name:hurricane → send-hurricane-guide. Pure. */
export function deliveryTagForPending(pendingTag) {
  const t = String(pendingTag || '').trim().toLowerCase();
  if (!t.startsWith(GUIDE_PENDING_PREFIX)) return null;
  const tag = `send-${t.slice(GUIDE_PENDING_PREFIX.length)}-guide`;
  return isGuideDeliveryTag(tag) ? tag : null;
}

/** The name the lead gave in this thread: a reply to our ask, or "my name is X". Pure. */
export function guideNameFromThread(thread = [], trigger = '') {
  const turns = (Array.isArray(thread) ? thread : []).map(m => ({ direction: String(m?.direction || '').toLowerCase(), text: String(m?.text ?? m?.body ?? '') }));
  if (trigger && !(turns.length && turns[turns.length - 1].direction === 'inbound' && turns[turns.length - 1].text === trigger)) {
    turns.push({ direction: 'inbound', text: String(trigger) });
  }
  const viaAsk = nameFromThread(turns);
  if (viaAsk) return realFirstName(viaAsk);
  // A bare reply right after our GUIDE name ask ("Mark").
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].direction !== 'inbound') continue;
    const prev = turns.slice(0, i).reverse().find(x => x.direction === 'outbound');
    const got = nameFromReply(turns[i].text, { asked: !!prev && GUIDE_NAME_ASK_RX.test(prev.text) });
    if (got) return realFirstName(got);
  }
  return null;
}

/**
 * Decide what to do with a guide delivery. Pure.
 * @returns {{ action: 'send'|'write_then_send'|'ask'|'send_without_name', name?: string }}
 */
export function decideGuideName({ contactFirstName = null, thread = [], trigger = '' } = {}) {
  if (realFirstName(contactFirstName)) return { action: 'send', name: realFirstName(contactFirstName) };
  const name = guideNameFromThread(thread, trigger);
  if (name) return { action: 'write_then_send', name };
  const turns = Array.isArray(thread) ? thread : [];
  const asked = turns.some(m => String(m?.direction || '').toLowerCase() === 'outbound' && GUIDE_NAME_ASK_RX.test(String(m?.text ?? m?.body ?? '')));
  return asked ? { action: 'send_without_name' } : { action: 'ask' };
}

/**
 * The I/O wrapper. Writes the name (fill-if-empty) before the caller adds the
 * delivery tag. A write that fails is treated as "no saved name": the caller
 * holds the tag rather than send "Hi ,".
 * deps: { getContact(id) → { firstName }, writeFirstName(id, name) → boolean, readThread(id) → [{direction,text}] }
 */
export async function ensureGuideName({ contactId, trigger = '', thread = null, contactFirstName } = {}, deps = {}) {
  let first = contactFirstName;
  let unreadable = false;
  if (first === undefined && deps.getContact) {
    let c = null;
    try { c = await deps.getContact(contactId); } catch { c = null; }
    unreadable = !c;
    first = c?.firstName ?? null;
  }
  let turns = thread;
  if (!Array.isArray(turns) && deps.readThread) {
    try { turns = await deps.readThread(contactId); } catch { turns = []; }
  }
  const decision = decideGuideName({ contactFirstName: first, thread: turns || [], trigger });
  // The contact could not be read: we cannot tell whether a name is on file,
  // so we do not ask for one (it may well be there). Send.
  if (unreadable && decision.action !== 'write_then_send') return { action: 'send', unreadable: true };
  if (decision.action !== 'write_then_send') return decision;
  // One retry: GHL write failures are mostly passing (429, timeout). Still
  // failing, the guide goes anyway rather than never: the name is in the chat
  // and a person can fix the record; a withheld guide cannot be fixed.
  for (let i = 0; i < 2; i++) {
    let ok = false;
    try { ok = deps.writeFirstName ? (await deps.writeFirstName(contactId, decision.name)) === true : false; } catch { ok = false; }
    if (ok) return decision;
  }
  return { action: 'send_without_name', write_failed: true, name: decision.name };
}
