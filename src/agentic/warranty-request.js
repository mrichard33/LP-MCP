/**
 * Sending the warranty when a lead asks for it — src/agentic/warranty-request.js
 *
 * Pure and dependency-free. Used by the NEPQ planner (the `warranty` move), the
 * SMS reply writer (src/response-generator.js), the live chat
 * (src/live-chat/fast-lane.js), the send handler (the links, or the email
 * attachments) and checkReply.
 *
 * WHY (Jeff Clark ySxZUqvXqSHInFgglEmL, 2026-10-14). "Please include a copy of
 * your warranty as well. Thanks" had nothing that could answer it: no code sent
 * a file, the analyzer could only call it `document_request` and ask a person,
 * and "warranty" near a call request turned it into a service hand-off.
 *
 * WHAT (Mark + the user, 2026-10-15)
 *   - A warranty request is fulfilled in the same reply: "Here's a copy of the
 *     warranty, Jeff. Anything in it you want me to walk through?". Never "it
 *     will come later", never a made-up reason for a delay.
 *   - The files are the two PDFs in the GHL Media Library, WARRANTY_PDF_URLS
 *     (comma-separated). Unset = this whole feature is off, and the bot does
 *     what it did before.
 *   - SMS and live chat get the LINKS on their own lines after the reply (the
 *     user: a 3 MB scanned PDF by MMS is blocked or mangled on many phones).
 *     Email gets both PDFs attached. Code adds them, never the model.
 *   - The PDFs go as they are, the 30-Day Price Guarantee page included (the
 *     user's ruling). The bot's own words still never state that guarantee
 *     (Mark, 2026-09-23, LIB-X05): `enforceWarrantyReply` drops a sentence that
 *     does. Warranty terms may be quoted from ch05.
 *   - Not a hand-off and not a callback. A call asked for in the same message
 *     is still filed as before.
 *   - "warranty claim / issue / repair", "under warranty" are a SERVICE ask,
 *     not a copy request; SERVICE_RX in the planner keeps those.
 */

const WARRANTY_WORD = String.raw`warrant(?:y|ies)`;

// A copy of the warranty, or its details, asked for.
const REQUEST_RXS = [
  new RegExp(String.raw`\bcop(?:y|ies)\s+of\s+(?:the|your|my|our|a|that)?\s*(?:\w+\s+){0,2}${WARRANTY_WORD}\b`, 'i'),
  new RegExp(String.raw`\b(?:send|sent|email|e-mail|text|forward|share|include|attach|get|see|view|need|want|give|provide|mail|read|look\s+at)\b[^.?!]{0,40}\b${WARRANTY_WORD}\b`, 'i'),
  new RegExp(String.raw`\b${WARRANTY_WORD}\s+(?:info|information|details|paperwork|papers?|documents?|docs?|certificates?|terms|pdfs?|cop(?:y|ies)|booklet|brochure|packet|sheet)\b`, 'i'),
  new RegExp(String.raw`\bwhat\s+(?:does|do|is|'s|would)\s+(?:the|your|this|that)\s+${WARRANTY_WORD}\s+(?:cover|include|look\s+like)`, 'i'),
];

// A service ask that mentions the warranty: a repair, a claim, a broken part.
const SERVICE_RX = new RegExp(String.raw`\b${WARRANTY_WORD}\s+(?:claim|issue|problem|repair|work|service|replacement)\b|\bunder\s+(?:the\s+|your\s+|my\s+)?${WARRANTY_WORD}\b|\b(?:broke|broken|crack(?:ed)?|leak(?:s|ing)?|fogg(?:y|ed)|stuck|won'?t\s+(?:open|close|lock))\b`, 'i');

/** Does this message ask for a copy of the warranty (or its terms)? Pure. */
export function isWarrantyRequest(text) {
  const t = String(text || '');
  if (!new RegExp(WARRANTY_WORD, 'i').test(t)) return false;
  if (SERVICE_RX.test(t)) return false;
  return REQUEST_RXS.some((rx) => rx.test(t));
}

/** The warranty file URLs, in order; [] when unset (the feature is off). Pure. */
export function warrantyUrls(env = process.env) {
  return String(env?.WARRANTY_PDF_URLS || '')
    .split(',')
    .map((u) => u.trim())
    .filter((u) => /^https:\/\/\S+$/i.test(u));
}

/** A warranty turn: the lead asked, and there is a file to send. Pure. */
export function warrantyTurn(text, env = process.env) {
  const urls = warrantyUrls(env);
  return urls.length && isWarrantyRequest(text) ? { urls } : null;
}

/** The reference line the model writes its own version of. Pure. */
export function warrantyReference(firstName = null) {
  const name = String(firstName || '').trim().split(/\s+/)[0] || '';
  return `Here's a copy of the warranty${name ? `, ${name}` : ''}. Anything in it you want me to walk through?`;
}

/** The read-back the reference check holds the model's version to. */
export const WARRANTY_MARKERS = Object.freeze([
  { rx: new RegExp(String.raw`\bhere(?:'|’)?s\b[^.?!]*\b${WARRANTY_WORD}\b|\b${WARRANTY_WORD}\b[^.?!]*\b(?:below|attached|here)\b|\battached\b[^.?!]*\b${WARRANTY_WORD}\b`, 'i'), say: 'say here is a copy of the warranty (it is sent with this message)' },
]);

const WARRANTY_IN_RX = new RegExp(String.raw`\b${WARRANTY_WORD}\b`, 'i');
const CLAIM_RX = WARRANTY_MARKERS[0].rx;
// "I'll send it over", "our team will email the warranty", "you'll get it
// tomorrow": a later delivery, which is false on a turn that sends it now.
const LATER_RX = /\b(?:i|we|they|our\s+team|the\s+team|someone|a\s+team\s+member|(?:the\s+)?(?:office|rep))(?:'ll|’ll|\s+will|\s+(?:am|are|is)\s+going\s+to|\s+can)\s+(?:\w+\s+){0,3}(?:send|email|e-mail|forward|get|share|pass|mail|follow\s+up|reach\s+out)\b|\byou(?:'ll|’ll|\s+will)\s+(?:get|receive|have)\b|\b(?:on\s+(?:its|the)\s+way|shortly|later\s+today|by\s+tomorrow)\b/i;
const PRICE_GUARANTEE_RX = /\bprice\s+(?:guarantee|match(?:ing)?|protection)\b|\b30[-\s]?day\s+(?:price|guarantee)\b|\brefund\s+the\s+difference\b/i;

const splitSentences = (t) => String(t || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

/**
 * The last pass on a warranty turn's reply. Pure.
 *   - a sentence promising the warranty LATER goes (it is sent with this reply);
 *   - a sentence stating the 30-Day Price Guarantee goes;
 *   - a reply that never says the warranty is here gets the reference's first
 *     sentence in front.
 * @returns {{ text: string, changed: boolean, changes: string[] }}
 */
export function enforceWarrantyReply(text, { firstName = null } = {}) {
  const changes = [];
  // Sentences are cut out of the original text in place, so an email's
  // paragraphs and an SMS's line breaks survive.
  let out = String(text || '');
  for (const s of splitSentences(out.replace(/<[^>]+>/g, ' '))) {
    let drop = null;
    if (PRICE_GUARANTEE_RX.test(s)) drop = 'price_guarantee_dropped';
    else if (LATER_RX.test(s) && (WARRANTY_IN_RX.test(s) || /\b(?:it|that|a\s+copy|the\s+copy|them|those)\b/i.test(s)) && !s.endsWith('?')) drop = 'later_delivery_dropped';
    if (drop && out.includes(s)) { out = out.replace(s, ''); changes.push(drop); }
  }
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
  if (!splitSentences(out.replace(/<[^>]+>/g, ' ')).some((s) => CLAIM_RX.test(s))) {
    const lead = splitSentences(warrantyReference(firstName))[0];
    if (/^\s*</.test(out)) {
      // An email: after its greeting paragraph ("Hi Jeff,"), if it opens with one.
      const greet = out.match(/^\s*<p[^>]*>\s*(?:hi|hello|hey|dear|good\s+(?:morning|afternoon|evening))\b[^<]{0,40}<\/p>/i);
      out = greet ? `${greet[0]}<p>${lead}</p>${out.slice(greet[0].length)}` : `<p>${lead}</p>${out}`;
    } else {
      out = `${lead} ${out}`.trim();
    }
    changes.push('warranty_line_added');
  }
  return { text: out, changed: changes.length > 0, changes };
}

/** SMS / live chat: the links, each on its own line, after the reply. Pure. */
export function appendWarrantyLinks(text, urls = []) {
  const body = String(text || '').trim();
  const links = (Array.isArray(urls) ? urls : []).filter((u) => u && !body.includes(u));
  return links.length ? `${body}\n${links.join('\n')}` : body;
}

/** Does a reply say the warranty is attached / here? (checkReply). Pure. */
export function claimsWarrantySent(text) {
  return splitSentences(text).some((s) => CLAIM_RX.test(s) && !s.endsWith('?'));
}
