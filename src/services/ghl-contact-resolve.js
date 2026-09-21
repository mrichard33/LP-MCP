/**
 * Find-or-create a GHL contact by phone — src/services/ghl-contact-resolve.js
 *
 * ONE job: given a phone number, return the GHL contact that belongs to it,
 * creating one only when none exists.
 *
 * ─── WHY THIS IS A MODULE AND NOT A THIRD COPY ──────────────────────────────
 * This logic was written once, inside src/services/lp-contact-backstop.js, and
 * it is the only find-before-create in the repo that has been hardened against
 * the ways it goes wrong. It is lifted here verbatim so the AP intake hop
 * (src/ap-intake.js) shares it rather than growing a second implementation
 * that drifts. The backstop imports it from here and behaves identically.
 *
 * ─── THE RULE THAT SHAPES EVERY BRANCH ──────────────────────────────────────
 * From lp-contact-backstop.js, and it governs the whole module:
 *
 *   creating a duplicate contact is a recoverable annoyance;
 *   stamping one lead's identity onto a different person is not.
 *
 * So every uncertain path returns null (meaning "create a fresh one" or
 * "answer nothing") rather than guessing at a match. Four layers:
 *
 *   1. Search GHL by phone before creating anything.
 *   2. Accept a hit only on a LAST-10-DIGIT exact match. GHL stores
 *      '+13524453161' and LP stores '3524453161'; comparing full strings
 *      finds nothing, and comparing loosely finds the wrong person.
 *   3. A hit whose search projection carries NO phone is not a match yet — do
 *      a full GET and confirm. A mismatch or a failed read refuses to link.
 *   4. A create that comes back 400-duplicate means GHL deduped server-side
 *      (another pipe raced us). Re-search and use what is there.
 *
 * ─── deps SEAM ──────────────────────────────────────────────────────────────
 * Everything touching the network goes through `deps` so callers can test
 * without a live GHL (CLAUDE.md). The default wires the real client.
 */

import { ghlFetch } from '../actions/helpers.js';
import { GHL_LOCATION_ID } from '../actions/constants.js';
import { normalizePhone } from '../sync-utils.js';
import { findContactIdByPhone } from './ghl-contact-mirror.js';

export const DEFAULT_DEPS = { ghlFetch, findContactIdByPhone };

/** Names GHL should never be given. Mirrors the backstop's NAME_JUNK intent. */
const NAME_JUNK = new Set(['', 'n/a', 'na', 'none', 'null', 'undefined', 'test', 'unknown']);

export function cleanName(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return NAME_JUNK.has(t.toLowerCase()) ? '' : t;
}

/**
 * Pick the match out of a GHL search projection.
 *
 * Returns:
 *   { contact, verified: true }    — last-10 digits matched in the projection
 *   { candidate, verified: false } — a hit exists but carries no phone; the
 *                                    caller MUST confirm via a full GET
 *   null                           — nothing usable
 */
export function pickPhoneMatch(contacts, normalizedPhone) {
  const list = Array.isArray(contacts) ? contacts : [];
  if (list.length === 0) return null;
  const want = String(normalizedPhone || '').slice(-10);
  if (want.length < 10) return null;
  const exact = list.find((c) => {
    const cp = normalizePhone(c?.phone);
    return cp && cp.slice(-10) === want;
  });
  if (exact) return { contact: exact, verified: true };
  const candidate = list.find((c) => c?.id && !c?.phone);
  if (candidate) return { candidate, verified: false };
  return null;
}

/** A GHL 400 that means "this phone already exists" (server-side dedup). */
export function isDuplicate400(err) {
  const m = String(err?.message || '');
  return /→\s*400/.test(m) && /duplicat/i.test(m);
}

/** Search GHL for a contact on this phone. Null when nothing is confirmable. */
export async function searchByPhone(normalizedPhone, { deps = DEFAULT_DEPS, log = console } = {}) {
  const q = encodeURIComponent(normalizedPhone);
  const res = await deps.ghlFetch('GET', `/contacts/?query=${q}&locationId=${GHL_LOCATION_ID}`);
  const pick = pickPhoneMatch(res?.contacts, normalizedPhone);
  if (!pick) return null;
  if (pick.verified) return pick.contact;

  // Unverified candidate: the search projection carried no phone. Confirm
  // against the full contact record before linking anything. A mismatch OR a
  // read failure returns null — see the rule in this file's header.
  const want = normalizedPhone.slice(-10);
  try {
    const full = await deps.ghlFetch('GET', `/contacts/${pick.candidate.id}`);
    const contact = full?.contact || full || {};
    const cp = normalizePhone(contact?.phone);
    if (cp && cp.slice(-10) === want) return contact;
    log.warn?.(`[GhlResolve] REJECTED unverified match ${pick.candidate.id} for ${normalizedPhone} (contact phone: ${contact?.phone || 'none'}) — not linking`);
    return null;
  } catch (err) {
    log.warn?.(`[GhlResolve] verification read failed for ${pick.candidate.id}: ${err.message} — refusing to link`);
    return null;
  }
}

/**
 * Find the contact for this phone, creating one only if `create` is true.
 *
 * @returns {{contactId: string|null, outcome: 'found'|'created'|'none'|'no_phone'}}
 *   `none`     — no match and creation was not permitted (shadow mode), or a
 *                match could not be confirmed.
 *   `no_phone` — nothing to search on. Never creates a contact without a
 *                phone: a phoneless contact can never be corroborated later,
 *                which is the condition Phase A had to clean up by hand.
 */
export async function resolveOrCreateContact(input, {
  create = true, deps = DEFAULT_DEPS, log = console, mirrorFirst = false,
} = {}) {
  const phone = normalizePhone(input?.phone);
  if (!phone || phone.replace(/[^0-9]/g, '').length < 10) {
    return { contactId: null, outcome: 'no_phone' };
  }

  // TIER 0 (opt-in) — the HL contacts mirror, which costs no GHL token.
  //
  // ghlFetch shares one process-wide bucket with the action executor
  // (src/ghl-rate-limiter.js), so a search during an executor batch queues
  // behind it: that is what made /intake/ap-resolve time out at 1200ms on
  // 2026-09-21 while the search itself measured 101-270ms. On a latency-capped
  // path a full bucket cannot be assumed, so intake asks the mirror first.
  //
  // Opt-in rather than default: lp-contact-backstop.js shares this function and
  // runs off the request path, where token contention costs it nothing.
  //
  // A mirror hit is a last-10-digit exact match on a shape-valid id, already
  // enforced in findContactIdByPhone — ambiguity and unreadability both return
  // null, which falls through to exactly the behaviour below. The mirror can
  // save a round trip; it can never be the reason a contact is missed.
  if (mirrorFirst) {
    // Through deps so a test can stub it; `?.` so a deps stub that predates
    // this tier simply skips it rather than throwing.
    const mirrored = await deps.findContactIdByPhone?.(phone, { log });
    if (mirrored) return { contactId: mirrored, outcome: 'found' };
  }

  const match = await searchByPhone(phone, { deps, log });
  if (match?.id) return { contactId: match.id, outcome: 'found' };

  if (!create) return { contactId: null, outcome: 'none' };

  const body = {
    locationId: GHL_LOCATION_ID,
    firstName: cleanName(input.firstName),
    lastName: cleanName(input.lastName),
    phone,
    ...(input.email ? { email: String(input.email).trim() } : {}),
    ...(input.address ? { address1: input.address } : {}),
    ...(input.city ? { city: input.city } : {}),
    ...(input.state ? { state: input.state } : {}),
    ...(input.postalCode ? { postalCode: input.postalCode } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(Array.isArray(input.tags) && input.tags.length ? { tags: input.tags } : {}),
    ...(Array.isArray(input.customFields) && input.customFields.length
      ? { customFields: input.customFields } : {}),
  };

  try {
    const cr = await deps.ghlFetch('POST', '/contacts/', body);
    const contactId = cr?.contact?.id || cr?.id || null;
    return { contactId, outcome: contactId ? 'created' : 'none' };
  } catch (err) {
    if (!isDuplicate400(err)) throw err;
    // GHL deduped server-side — another pipe created it between our search and
    // our create. Re-search and use theirs; ours was never written.
    const raced = await searchByPhone(phone, { deps, log });
    if (raced?.id) return { contactId: raced.id, outcome: 'found' };
    throw err;
  }
}
