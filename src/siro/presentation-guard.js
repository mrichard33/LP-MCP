/**
 * The visit is context, never a quote — src/siro/presentation-guard.js (2026-10-16)
 *
 * Pure. When the reply writer saw the PRESENTATION block (a Siro summary of
 * the in-home visit), two things may not reach the lead:
 *   - a dollar figure (the summary may carry the price the rep quoted; a
 *     price in a text is a quote nobody approved), and
 *   - the rep quoted back ("your rep said…", "Brian mentioned…": the lead
 *     never agreed to have the visit replayed to them).
 * Each offending sentence is dropped (the rewrite), and checkReply holds the
 * finished reply to the same rule (presentation_quoted_price,
 * presentation_rep_quoted). Nothing changes when no block rendered.
 */
const MONEY_RX = /\$\s?\d|\b\d[\d,]*(?:\.\d+)?\s*(?:dollars|bucks)\b/i;
const REP_QUOTE_RX = /\b(?:your|the|our)\s+(?:sales\s+)?(?:rep|representative|consultant|designer|advisor)\s+(?:said|mentioned|told\s+you|noted|quoted|explained|promised)\b/i;

function sentences(text) {
  return String(text || '').match(/[^.!?]+[.!?]*\s*/g) || [];
}
function escapeRx(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function repQuoteRx(repFirstName) {
  if (!repFirstName) return REP_QUOTE_RX;
  return new RegExp(`${REP_QUOTE_RX.source}|\\b${escapeRx(repFirstName)}\\s+(?:said|mentioned|told\\s+you|noted|quoted|explained|promised)\\b`, 'i');
}

/** Which rule a reply breaks, given the block rendered. Pure. */
export function presentationViolations(text, presentation) {
  if (!presentation) return [];
  const out = [];
  if (MONEY_RX.test(String(text || ''))) out.push('presentation_quoted_price');
  if (repQuoteRx(presentation.rep_first_name).test(String(text || ''))) out.push('presentation_rep_quoted');
  return out;
}

/**
 * @param {string} text
 * @param {{presentation?: object|null}} o   buildPresentationFacts() output, when the block rendered
 * @returns {{text: string, changed: boolean, changes: string[]}}
 */
export function enforcePresentationGuard(text, { presentation = null } = {}) {
  const body = String(text || '');
  if (!presentation) return { text: body, changed: false, changes: [] };
  const quote = repQuoteRx(presentation.rep_first_name);
  const changes = [];
  const kept = sentences(body).filter((s) => {
    if (MONEY_RX.test(s)) { changes.push('presentation_quoted_price'); return false; }
    if (quote.test(s)) { changes.push('presentation_rep_quoted'); return false; }
    return true;
  });
  if (!changes.length) return { text: body, changed: false, changes };
  const out = kept.join('').trim();
  // Never ship an empty reply: an empty body keeps the original for the
  // retry loop, and the check still fails it.
  return out ? { text: out, changed: true, changes } : { text: body, changed: false, changes };
}

// ── Siro's suggested text is a reference, never the reply (Mark, 2026-10-19, ruling 2)
// The bot may read Siro's drafted follow-up for topic and tone; a reply that
// is mostly that draft is Siro's text sent as written. 60% or more of the
// reply's content words found in the draft fails siro_draft_copied.
export const SIRO_DRAFT_COPY_SHARE = 0.6;
const COPY_STOP = new Set(('the and for you your with that this have from are was were will would could just about what when they them their there here been also into than then some more very our out not but can all any its it\'s i\'m you\'re we\'re').split(' '));
function contentWords(s) {
  return (String(s || '').toLowerCase().match(/[a-z][a-z']{2,}/g) || []).filter(w => !COPY_STOP.has(w));
}

/** Share (0..1) of the reply's content words that appear in Siro's draft. Pure. */
export function siroDraftOverlap(text, followupText) {
  const words = contentWords(text);
  if (!words.length || !followupText) return 0;
  const draft = new Set(contentWords(followupText));
  if (!draft.size) return 0;
  return words.filter(w => draft.has(w)).length / words.length;
}

/** True when the reply copies Siro's suggested text. Pure. */
export function copiesSiroDraft(text, followupText) {
  return contentWords(text).length >= 5 && siroDraftOverlap(text, followupText) >= SIRO_DRAFT_COPY_SHARE;
}
