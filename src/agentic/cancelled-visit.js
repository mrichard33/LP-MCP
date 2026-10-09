/**
 * cancelled-visit — src/agentic/cancelled-visit.js
 *
 * 2026-10-07 (Nicholas Ferraioli, GHL I5x7zltORikAxdEJ6nyD). His 3 PM visit
 * was cancelled on our end at 9:29 AM. At 3:43 PM, while he waited at home,
 * the bot wrote "Before your visit, is there anything you're wondering
 * about?" The prompt had the cancel; the model ignored it. A prompt line is
 * not a guard (AI OS CANON.IMP.006), so this one is code.
 *
 * When the lead's appointment is cancelled and nothing was booked this turn,
 * a sentence that treats the visit as still happening is replaced, ONCE per
 * thread, by the plain truth; after that it is dropped. Pure.
 */

// "on our end" only when we cancelled it (LP CXL); a CCC is the lead's own.
// No "today": the cancelled visit is not always today's.
export function cancelledVisitLine(facts) {
  const ours = String(facts?.appointment?.lp_disposition || '').toUpperCase() !== 'CCC';
  return `Your visit was cancelled${ours ? ' on our end' : ''}. A team member will call you to explain next steps.`;
}
export const CANCELLED_VISIT_LINE = cancelledVisitLine({ appointment: { lp_disposition: 'CXL' } });
const SAID_RX = /\bvisit\s+was\s+cancel+ed\b/i;

// A sentence that speaks of the visit as still ahead.
const UPCOMING_VISIT_RX = new RegExp([
  String.raw`\b(?:before|ahead\s+of|prior\s+to|during|for|at)\s+(?:your|the)\s+(?:visit|appointment|estimate|consultation|measurement)\b`,
  String.raw`\b(?:your|the)\s+(?:visit|appointment)\s+(?:today|tomorrow|tonight|this\s+(?:afternoon|evening|morning)|is\s+(?:still\s+)?(?:on|set|coming\s+up|confirmed)|at\s+\d)`,
  String.raw`\b(?:team|rep|specialist|consultant|someone|they)\s+(?:is|are|will\s+be|'s|'re)\s+(?:still\s+)?(?:on\s+(?:the|their)\s+way|coming|heading\s+(?:over|out)|running\s+late)`,
  String.raw`\bsee\s+you\s+(?:today|tomorrow|tonight|then|soon|this)\b`,
].join('|'), 'i');

function sentences(text) {
  return String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

/**
 * @param {string} text
 * @param {{facts?: object|null, booked?: boolean, outboundTexts?: string[]}} opts
 *   facts          context.lead_facts (lead-facts.js)
 *   booked         this turn booked a new visit (then the visit is real)
 *   outboundTexts  what we already sent in the thread
 * @returns {{text: string, changed: boolean, sentence: string|null}}
 */
export function enforceCancelledVisit(text, { facts = null, booked = false, outboundTexts = [] } = {}) {
  const original = String(text || '');
  if (booked || facts?.appointment?.status !== 'cancelled') return { text: original, changed: false, sentence: null };
  const parts = sentences(original);
  const hit = parts.find(s => UPCOMING_VISIT_RX.test(s) && !/\bcancel/i.test(s));
  if (!hit) return { text: original, changed: false, sentence: null };
  const alreadySaid = (outboundTexts || []).some(t => SAID_RX.test(String(t || '')));
  const out = [];
  let replaced = false;
  for (const s of parts) {
    if (!(UPCOMING_VISIT_RX.test(s) && !/\bcancel/i.test(s))) { out.push(s); continue; }
    if (!replaced && !alreadySaid) out.push(cancelledVisitLine(facts));
    replaced = true;
  }
  const next = out.join(' ').trim();
  return { text: next || (alreadySaid ? 'A team member will call you to explain next steps.' : cancelledVisitLine(facts)), changed: true, sentence: hit };
}
