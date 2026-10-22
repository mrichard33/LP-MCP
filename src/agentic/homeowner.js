// ─── Does the lead own the home? — src/agentic/homeowner.js ─────────────────
//
// WHY (handoff "Lead Conversation Stage", 2026-10-12, batch 3 test 3)
//   A renter was offered two visit times, once in the same reply as "get his
//   okay first". Reece does not run single-leg visits: the owner has to be part
//   of it. Nothing in the planner read ownership; only the analyzer's
//   dq_detected and a person's LP note (lp-note-dq.js) did.
//
//   This is the one reader of the lead's own words about owning or renting,
//   shared by the stage recorder (lead-stage.js) and the qualifying guard.
//   A landlord ("we rent it out", "my tenants") OWNS the home: that is not a
//   renter (lp-note-dq.js excludes "renting it out" for the same reason).
//
// PURE. No I/O.

// A rental owner talking about their own property.
const RENTAL_OWNER_RX = /\brent(?:ing|ed)?\s+(?:it|them|this|that|the\s+\w+|my\s+\w+|our\s+\w+)\s+out\b|\brent(?:ing)?\s+out\b|\brental\s+propert(?:y|ies)\b|\b(?:my|our)\s+tenants?\b|\b(?:i'?m|i\s+am|we'?re|we\s+are)\s+the\s+landlords?\b|\bi\s+own\s+(?:a\s+|the\s+)?rental\b/i;

// The lead says they rent. "Can renters get a quote?" counts: batch 3 asked it
// exactly that way about their own home. 2026-10-20 (dq_renter_refire): "help with my
// rent my rent is $589 a month" read as nothing, so the bot kept selling; "my rent",
// "pay/help with (my) rent" and "rent is $N" are a renter's words. A property manager
// is not the owner either (the user, 2026-10-20: the owner is welcome to reach out).
const RENT_PAID_SRC = String.raw`\b(?:my|our)\s+rent\b|\b(?:pay(?:ing)?|afford|help(?:\s+\w+){0,2}\s+with)\s+(?:my\s+|our\s+|the\s+)?rent\b|\brent\s+is\s+\$?\d`;
const PROPERTY_MANAGER_SRC = String.raw`\b(?:i'?m|i\s+am|we'?re|we\s+are)\s+(?:the|a)\s+property\s+manag(?:er|ers|ement)\b|\b(?:i|we)\s+manage\s+(?:the|this|that|a|it)\b[^.!?]{0,30}\bfor\s+(?:the|an?|my|our)\s+(?:owner|client|landlord)`;
export const RENTER_RX = new RegExp(String.raw`${RENT_PAID_SRC}|${PROPERTY_MANAGER_SRC}|` + /\b(?:i'?m|i\s+am|we'?re|we\s+are)\s+(?:a\s+|just\s+a\s+)?(?:renters?|tenants?)\b|\b(?:i'?m|i\s+am|we'?re|we\s+are)\s+(?:currently\s+|just\s+)?renting\b|\b(?:i|we)\s+(?:currently\s+|just\s+)?rent\s+(?:here|this|the|my|our|a|an)\b|\b(?:i|we)\s+rent\s*[.!?]*$|\b(?:my|our|the)\s+landlord\b|\b(?:i|we)\s+(?:don'?t|do\s+not|dont)\s+own\b|\bnot\s+the\s+(?:home\s*|house\s*|property\s*)?owners?\b|\b(?:can|do)\s+renters\b|\bas\s+a\s+(?:renter|tenant)\b|\bi'?m\s+not\s+(?:the\s+)?(?:home\s*)?owner\b/.source, 'i');

// The lead says they own it.
const OWNER_RX = /\b(?:i|we)\s+(?:do\s+)?own\s+(?:the|my|our|this|it|that)\b|\b(?:i'?m|i\s+am|we'?re|we\s+are)\s+(?:the\s+)?(?:home\s*|house\s*|property\s*)?owners?\b|\bi'?m\s+a\s+homeowner\b|\bit'?s\s+(?:my|our)\s+(?:own\s+)?(?:home|house)\b|\bwe\s+bought\s+(?:the|this|our)\s+(?:home|house)\b/i;

// Our question about ownership, read by meaning (the model words it).
export const OWNER_ASK_RX = /\b(?:do\s+you\s+own|are\s+you\s+the\s+(?:home\s*)?owner|own\s+the\s+(?:home|house|property)|homeowner)\b[^?]*\?/i;

const YES_REPLY_RX = /^\s*(?:y(?:es|eah|ep|up)|sure|i\s+do|we\s+do|correct|that'?s\s+right|absolutely|of\s+course|yup)\b/i;
const NO_REPLY_RX = /^\s*(?:no(?:pe)?|nah|not\s+(?:really|exactly)|i\s+don'?t|we\s+don'?t)\b/i;

/** Does this one message say the lead rents (and is not a landlord)? Pure. */
export function saysRenter(text) {
  const t = String(text || '');
  if (RENTAL_OWNER_RX.test(t)) return false;
  return RENTER_RX.test(t);
}

/** Does this one message say the lead owns the home? Pure. */
export function saysOwner(text) {
  const t = String(text || '');
  return RENTAL_OWNER_RX.test(t) || (OWNER_RX.test(t) && !RENTER_RX.test(t));
}

/**
 * Did the lead say they own the home and rent it OUT (a landlord), and do they still read as the owner? Pure.
 * 2026-10-22 (landlord_lead, live chat): the model read "a house I rent out to tenants" as a renter three days
 * running; the planner now states it as a fact (renderPlanBlock), so the reading is code's, not the model's.
 */
export function ownsRentalFromThread(turns = []) {
  const list = Array.isArray(turns) ? turns : [];
  const said = list.some(m => String(m?.direction || '').toLowerCase() !== 'outbound' && RENTAL_OWNER_RX.test(String(m?.text ?? m?.body ?? '')));
  return said && homeownerFromThread(list) === 'yes';
}

/**
 * 'yes' | 'no' | 'unknown' from the thread (oldest first, {direction, text}).
 * The newest decisive message wins: a renter who then says "actually my wife
 * and I own it" is an owner. A bare yes/no counts only as the reply to our own
 * ownership question. Pure.
 */
export function homeownerFromThread(turns = []) {
  const list = (Array.isArray(turns) ? turns : []).map(m => ({
    direction: String(m?.direction || '').toLowerCase() === 'outbound' ? 'outbound' : 'inbound',
    text: String(m?.text ?? m?.body ?? ''),
  }));
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.direction !== 'inbound') continue;
    if (saysRenter(m.text)) return 'no';
    if (saysOwner(m.text)) return 'yes';
    const prevOut = [...list.slice(0, i)].reverse().find(x => x.direction === 'outbound')?.text || '';
    if (OWNER_ASK_RX.test(prevOut)) {
      if (YES_REPLY_RX.test(m.text)) return 'yes';
      if (NO_REPLY_RX.test(m.text)) return 'no';
    }
  }
  return 'unknown';
}
