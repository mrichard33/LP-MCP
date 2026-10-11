// ─── Who owns a lead after the demo — src/agentic/post-demo-owner.js ─────────
//
// WHY (the user, 2026-10-11): "after the appointment demos the sales rep does
// not own the lead anymore if they did not sell it. It goes to the Rehash team
// so we should not continue to say the sales rep will follow up."
//
// The reply writer still told post-demo leads that "their rep" was sending the
// proposal (POST_APPOINTMENT_CLOSE), labelled the field rep "the FIELD rep who
// owns this deal" in the CRM block, and named that rep as the owner on an
// escalation acknowledgment ("Beverly has your file"). After an unsold demo
// the rehash team follows up, so the customer-facing owner is our follow-up
// team (or the rehash rep the line speaks as), never the sales rep.
//
// A SOLD lead is a customer: the sales rep still owns the deal there, and
// nothing here changes for it.
//
// PURE. No I/O.

/** How the customer hears about the rehash team ("rehash" is internal). */
export const FOLLOW_UP_TEAM = 'our follow-up team';

/**
 * A lead that had its demo and did not buy: the rehash team owns it. Pure.
 * @param {object} a
 * @param {boolean} a.postAppointment  derivePostAppointment(...).post
 * @param {boolean} [a.rehash]         the rehash line / tags / OPPFDN lead
 * @param {boolean} [a.sold]           LP closed-won, a Sale disposition, or a P2 customer
 */
export function isUnsoldPostDemo({ postAppointment = false, rehash = false, sold = false } = {}) {
  if (sold) return false;
  return !!(postAppointment || rehash);
}

/** A Sale on the LP record (closed-won or the Sale disposition). Pure. */
export function lpSold(lp) {
  if (!lp) return false;
  if (lp.closed_won === true) return true;
  const code = String(lp.disposition_code ?? lp.disposition ?? '').trim();
  return /^sale$/i.test(code);
}

/**
 * The owner a customer-facing line may name after an unsold demo: the rehash
 * rep this line speaks as, else our follow-up team. Never the sales rep. Pure.
 */
export function postDemoOwnerName(rehashRepName = null) {
  const n = String(rehashRepName || '').trim();
  return n || FOLLOW_UP_TEAM;
}

const FOLLOW_UP_VERB = String.raw`(?:call|ring|phone|follow(?:\s|-)?up|reach\s+out|be\s+in\s+touch|get\s+(?:back|in\s+touch)|send|contact|text|email)`;
const FUTURE = String.raw`(?:will|'ll|’ll|is\s+going\s+to|is\s+gonna|can|should)`;
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The model wrote that the sales rep will follow up after an unsold demo.
 * The subject becomes our follow-up team; nothing else in the reply changes.
 * Pure.
 *   "Your rep will be in touch with the numbers." → "Our follow-up team will be in touch with the numbers."
 *   "I'll have Beverly call you." → "I'll have our follow-up team call you."
 * @param {string} text
 * @param {{ salesRep?: string|null, keepName?: string|null }} [o]
 *   salesRep  the visit rep's first name; keepName  the rehash rep this line
 *   speaks as (never rewritten, even when the two share a first name)
 * @returns {{ text: string, changed: boolean }}
 */
export function replaceSalesRepFollowUp(text, { salesRep = null, keepName = null } = {}) {
  const original = String(text || '');
  const who = [String.raw`(?:your|the)\s+(?:sales\s+)?(?:rep|representative|specialist|consultant|salesman|salesperson)`];
  const rep = String(salesRep || '').trim();
  if (rep && rep.toLowerCase() !== String(keepName || '').trim().toLowerCase()) who.push(escapeRx(rep));
  let out = original;
  for (const w of who) {
    // "<who> will call / follow up / be in touch …"
    out = out.replace(new RegExp(String.raw`\b${w}\b(?=\s+${FUTURE}\b[^.?!]{0,40}\b${FOLLOW_UP_VERB}\b)`, 'gi'), (m, off) => {
      const atStart = off === 0 || /[.?!]\s*$/.test(out.slice(0, off));
      return atStart ? 'Our follow-up team' : 'our follow-up team';
    });
    // "have <who> call you"
    out = out.replace(new RegExp(String.raw`\b(have|let|get)\s+${w}\b(?=\s+${FOLLOW_UP_VERB}\b)`, 'gi'), (m, v) => `${v} our follow-up team`);
  }
  return { text: out, changed: out !== original };
}
