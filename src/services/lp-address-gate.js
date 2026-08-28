/**
 * LP Addlead Address Gate — src/services/lp-address-gate.js
 *
 * Section D of the 2026-08-18 handoff. The LP push IS the dial trigger, and
 * LP dedupes a later LeadAdd onto the existing prospect WITHOUT updating the
 * prospect-level address (proven live on prospect 452653: the 08-16 push
 * carried zip only and permanently poisoned the prospect; the 08-17
 * estimator push carried "4360 Washington Place" and LP kept the blank).
 * So the FIRST push must be complete — this gate enforces address
 * completeness (address1, city, state, zip) at the one point every
 * GHL-originated addlead already transits: the addlead proxy.
 *
 * HOLD-AND-ENRICH, NEVER DROP. There is no reject path:
 *   complete                      → forward unchanged
 *   incomplete, lognumber present → fill missing fields from the GHL
 *                                   contact (lognumber = contact id),
 *                                   re-evaluate
 *   still incomplete              → park in lp_addlead_address_hold; the
 *                                   sweeper retries with enrichment
 *   retries exhausted             → forward anyway, notes stamped
 *                                   "INCOMPLETE ADDRESS ON FILE", ONE
 *                                   GroupMe alert
 *
 * MODES (env LP_ADDRESS_GATE_MODE, default 'shadow' — mirrors
 * LP_ADDLEAD_PROXY_MODE's shadow-first pattern):
 *   'off'     — gate skipped entirely.
 *   'shadow'  — evaluate + log what WOULD hold; always forward. Ship state.
 *   'enforce' — hold incomplete leads for enrichment.
 *
 * D4 — chatbot premature-send policy (env LP_CHATBOT_ADDRESS_POLICY,
 * default 'hold_then_forward'): a chatbot-originated addlead with an
 * incomplete address is the exact 08-16 failure mode. hold_then_forward
 * parks it like any other incomplete lead; forward_then_backfill sends it
 * immediately and leaves the prospect repair to the D3 address backfill
 * (safe now that UpdateProspectInfo is wired). Both implemented.
 *
 * KNOWN LIMIT (stated in the PR body): lead 567596 itself arrived via a
 * DIRECT website-form → LP feed (empty sender, lognumber is a site session
 * UUID, not a GHL contact id) that never transits GHL or this proxy. That
 * class is unreachable by this gate; the D3 backfill sweep is its repair.
 *
 * 2026-08-18 — isChatbotOriginated() now recognises srs_id 830, the real
 * "Reece ChatBot" SubSource, and keeps 5574 as a legacy alias. See the
 * function body and src/lp-source-ids.js v2.0.
 */

import supabase from '../supabase.js';
import { getGHLContact } from '../ghl.js';
import { LP_SRS } from '../lp-source-ids.js';
import { normalizeState, isNullishText } from '../sync-utils.js';

export const ADDRESS_FIELDS = ['address1', 'city', 'state', 'zip'];
export const INCOMPLETE_NOTES_STAMP = 'INCOMPLETE ADDRESS ON FILE';

export function gateMode() {
  const m = String(process.env.LP_ADDRESS_GATE_MODE || 'shadow').toLowerCase();
  return m === 'off' || m === 'enforce' ? m : 'shadow';
}

export function chatbotPolicy() {
  const m = String(process.env.LP_CHATBOT_ADDRESS_POLICY || 'hold_then_forward').toLowerCase();
  return m === 'forward_then_backfill' ? m : 'hold_then_forward';
}

export function holdMinutes() {
  return Math.max(1, Number(process.env.LP_ADDRESS_HOLD_MINUTES) || 15);
}

export function holdMaxRetries() {
  return Math.max(1, Number(process.env.LP_ADDRESS_HOLD_MAX_RETRIES) || 5);
}

// A field is blank if it is empty OR if it carries a string that only MEANS
// empty — "null", "undefined" and friends.
//
// The literal-string case is why 604 LP prospects read state "nu" (2026-08-27:
// 572 of them arrived with no GHL contact at all, so most are vendor and
// web-form posts we do not originate — but the ones that ARE ours came through
// here). `String(v).trim() !== ''` counted "null" as a real value, so
// missingAddressFields never flagged it, the gate neither enriched nor held,
// and it forwarded to LP, which truncates the column to two characters. A
// wrong-but-plausible value beat a blank one purely because it was four
// characters long.
function isBlank(v) {
  return v == null || String(v).trim() === '' || isNullishText(v);
}

/** Pure: which of the four address fields are missing on an addlead body (legacy field names). */
export function missingAddressFields(body) {
  const b = body || {};
  return ADDRESS_FIELDS.filter((k) => isBlank(b[k]));
}

/**
 * SubSource IDs that mark a body as chatbot-originated.
 *
 * 830 is the live "Reece ChatBot" SubSource (source "Website"). It became
 * the value chatbot pushes actually carry when src/lp-source-ids.js was
 * corrected on 2026-08-18 — before that the registry emitted 5574, which
 * resolves to nothing in LP.
 *
 * 5574 is retained as a LEGACY ALIAS, not out of caution but because real
 * rows carry it: two leads were pushed with srs_id 5574 while the wrong
 * value was live, and any addlead replayed from a held or re-queued
 * payload captured in that window still carries it. Dropping the alias
 * would make this gate stop recognising them as chatbot leads mid-flight.
 * It can be removed once no held/re-queue payload predates 2026-08-18.
 *
 * 749 ("Chat (REECE WEBSITE)") is the legacy chatbot SubSource row and is
 * the same surface for the purposes of this gate.
 */
export const CHATBOT_SRS_IDS = new Set([
  LP_SRS.CHATBOT,  // '830' — current
  '5574',          // legacy alias, see above
  '749',           // legacy "Chat (REECE WEBSITE)"
]);

/**
 * Pure: chatbot-originated heuristic. The chatbot paths stamp either a
 * chatbot-flavored sender or a Reece ChatBot sub-source.
 */
export function isChatbotOriginated(body) {
  const b = body || {};
  if (/chatbot/i.test(String(b.sender || ''))) return true;
  if (CHATBOT_SRS_IDS.has(String(b.srs_id || ''))) return true;
  return false;
}

/** lognumber only resolves to a GHL contact when it LOOKS like one (the
 *  website-form feed uses a session UUID with underscores — not fetchable). */
export function looksLikeGhlContactId(lognumber) {
  return /^[A-Za-z0-9]{18,24}$/.test(String(lognumber || ''));
}

/**
 * Fill missing address fields from the GHL contact. Returns a NEW body plus
 * the list of fields actually filled. Fail-open: any fetch error returns
 * the body unchanged.
 */
export async function enrichBodyFromGhl(body, deps = {}) {
  const missing = missingAddressFields(body);
  if (missing.length === 0) return { body, filled: [] };
  const lognumber = body?.lognumber;
  if (!looksLikeGhlContactId(lognumber)) return { body, filled: [] };

  let contact = null;
  try {
    const fetchContact = deps.getGHLContact || getGHLContact;
    contact = await fetchContact(String(lognumber));
  } catch (err) {
    console.warn(`[AddressGate] GHL enrichment fetch failed for ${lognumber}: ${err.message}`);
    return { body, filled: [] };
  }
  if (!contact) return { body, filled: [] };

  const sourceByField = {
    address1: contact.address1,
    city: contact.city,
    // GHL stores the state spelled out ("Florida") and LP TRUNCATES the column
    // to two characters, so backfilling it raw writes "Fl" — wrong, still
    // shaped like a state code, and never an error (39 such prospects, plus
    // 829 reading "nu" from the literal string "null"; see normalizeState).
    // Normalizing is within this function's existing remit: its whole job is
    // deciding what GHL value to write into the body. A nullish literal
    // normalizes to blank, which isBlank() below then rejects — so the field
    // stays missing and the gate holds the lead, which is the right outcome.
    state: normalizeState(contact.state),
    zip: contact.postalCode,
  };
  const out = { ...body };
  const filled = [];
  for (const k of missing) {
    const v = sourceByField[k];
    if (!isBlank(v)) {
      out[k] = String(v).trim();
      filled.push(k);
    }
  }
  return { body: out, filled };
}

/**
 * Park an incomplete lead in the hold table. One live hold per contact —
 * a second incomplete addlead updates the parked payload rather than
 * stacking a duplicate (unique partial index on ghl_contact_id).
 */
export async function holdLead({ body, missing }, deps = {}) {
  const db = deps.supabase || supabase;
  const nextAt = new Date(Date.now() + holdMinutes() * 60 * 1000).toISOString();
  const row = {
    ghl_contact_id: String(body.lognumber || 'unknown'),
    payload: body,
    missing_fields: missing,
    next_attempt_at: nextAt,
  };
  const { data, error } = await db
    .from('lp_addlead_address_hold')
    .insert(row)
    .select('id')
    .maybeSingle();
  if (!error) return { held: true, hold_id: data?.id ?? null };
  if (error.code === '23505') {
    // Active hold already exists for this contact — refresh its payload.
    const { error: updErr } = await db
      .from('lp_addlead_address_hold')
      .update({ payload: body, missing_fields: missing })
      .eq('ghl_contact_id', row.ghl_contact_id)
      .is('released_at', null);
    if (updErr) throw new Error(`hold refresh failed: ${updErr.message}`);
    return { held: true, hold_id: null, refreshed: true };
  }
  throw new Error(`hold insert failed: ${error.message}`);
}

/**
 * The gate. Returns a decision the proxy acts on:
 *   { action: 'forward'|'hold', body, missing, filled, would_hold, mode,
 *     policy, chatbot }
 * 'hold' only ever comes back in enforce mode; shadow logs the would-hold.
 * Every internal failure resolves to forward (fail-open — the gate must
 * never be the reason a lead misses LP).
 */
export async function applyAddressGate(body, deps = {}) {
  const mode = (deps.mode) || gateMode();
  const base = { mode, policy: chatbotPolicy(), chatbot: isChatbotOriginated(body) };
  if (mode === 'off') {
    return { ...base, action: 'forward', body, missing: [], filled: [], would_hold: false, reason: 'gate_off' };
  }

  try {
    let missing = missingAddressFields(body);
    if (missing.length === 0) {
      return { ...base, action: 'forward', body, missing: [], filled: [], would_hold: false, reason: 'complete' };
    }

    const { body: enriched, filled } = await enrichBodyFromGhl(body, deps);
    missing = missingAddressFields(enriched);
    if (missing.length === 0) {
      return { ...base, action: 'forward', body: enriched, missing: [], filled, would_hold: false, reason: 'enriched_complete' };
    }

    // Still incomplete. D4: chatbot forward_then_backfill sends now and
    // leaves prospect repair to the D3 backfill; everything else holds.
    const policyForwards = base.chatbot && base.policy === 'forward_then_backfill';
    const wouldHold = !policyForwards;

    if (mode === 'shadow' || !wouldHold) {
      if (wouldHold) {
        console.log(`[AddressGate] 🕶️ SHADOW would HOLD log=${body?.lognumber || '?'} sender="${body?.sender || ''}" missing=[${missing.join(',')}] filled=[${filled.join(',')}]`);
      } else {
        console.log(`[AddressGate] forward_then_backfill: chatbot lead log=${body?.lognumber || '?'} forwarded incomplete (missing [${missing.join(',')}]) — D3 backfill owns the repair`);
      }
      return { ...base, action: 'forward', body: enriched, missing, filled, would_hold: wouldHold, reason: policyForwards ? 'chatbot_forward_then_backfill' : 'shadow_would_hold' };
    }

    const holdRes = await holdLead({ body: enriched, missing }, deps);
    console.log(`[AddressGate] ⏸️ HELD log=${body?.lognumber || '?'} sender="${body?.sender || ''}" missing=[${missing.join(',')}] hold_id=${holdRes.hold_id ?? 'refreshed'}`);
    return { ...base, action: 'hold', body: enriched, missing, filled, would_hold: true, hold: holdRes, reason: 'held_incomplete_address' };
  } catch (err) {
    // FAIL-OPEN: the gate must never block the artery.
    console.error(`[AddressGate] gate threw — forwarding untouched: ${err.message}`);
    return { ...base, action: 'forward', body, missing: [], filled: [], would_hold: false, reason: `gate_error:${err.message}` };
  }
}

/** Stamp the exhausted-hold notes marker (pure; unit-tested). */
export function stampIncompleteNotes(body) {
  const stamped = { ...body };
  const existing = isBlank(stamped.notes) ? '' : String(stamped.notes);
  stamped.notes = existing.includes(INCOMPLETE_NOTES_STAMP)
    ? existing
    : `${INCOMPLETE_NOTES_STAMP}${existing ? ' | ' + existing : ''}`;
  return stamped;
}

export default {
  applyAddressGate,
  missingAddressFields,
  isChatbotOriginated,
  CHATBOT_SRS_IDS,
  looksLikeGhlContactId,
  enrichBodyFromGhl,
  holdLead,
  stampIncompleteNotes,
  gateMode,
  chatbotPolicy,
  holdMinutes,
  holdMaxRetries,
};
