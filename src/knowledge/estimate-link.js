/**
 * Estimate PDF link — src/knowledge/estimate-link.js  (pure, no I/O)
 *
 * 2026-09-10. Contact ECFITedNfAG0NVljENBx replied "Did not get estimate".
 * The bot answered "Here is a direct link to your estimate PDF so you have
 * it on hand:" and sent NO link (agent_actions 441204). The KB pack carried
 * booking links only, so the bot had no estimate link to give.
 *
 * GHL trigger link uyGlZ6ydYUmAqeWysREJ ("View Calculator Estimate") redirects
 * to {{contact.estimate_pdf_url}}: one link, correct PDF per contact, click
 * tracked. It is surfaced in the prompt for every estimate-completed lead,
 * and ensureEstimateLink() is a send-time backstop. The guard only ever ADDS
 * the merge tag; it never removes text.
 */

export const ESTIMATE_PDF_TRIGGER_ID =
  process.env.REECE_TRIGGER_ESTIMATE_PDF || 'uyGlZ6ydYUmAqeWysREJ';

export function getEstimatePdfMergeTag() {
  return `{{trigger_link.${ESTIMATE_PDF_TRIGGER_ID}}}`;
}

// A lead is eligible only once the calculator produced a PDF.
// active-entry:estimate-calculator alone is NOT enough (PDF may not exist yet).
const ESTIMATE_COMPLETED_TAGS = new Set(['estimator-completed', 'completed:wec']);

export function hasCompletedEstimate(contactTags = []) {
  return Array.isArray(contactTags) && contactTags.some(
    (t) => typeof t === 'string' && ESTIMATE_COMPLETED_TAGS.has(t.trim().toLowerCase()),
  );
}

const REQUEST_PATTERNS = [
  /\b(?:did\s*n[o']?t|didnt|never|haven'?t|havent|not)\s+(?:get|got|gotten|receive|received|see|seen)\b.*\b(?:estimate|quote|pdf)\b/i,
  // "the pdf wont open", "my quote never came" — negation AFTER the noun.
  // won't / can't / doesn't are as common here as didn't, and carry no
  // preceding "did".
  /\b(?:estimate|quote|pdf)\b.*\b(?:did\s*n[o']?t|didnt|never|not|won'?t|can'?t|cant|doesn'?t|isn'?t)\s+(?:come|arrive|show|load|open|work)/i,
  /\b(?:resend|re-send|send (?:it|that|me|the)|send again)\b.*\b(?:estimate|quote|pdf|link)\b/i,
  /\b(?:where'?s|where is|can'?t find|cannot find|lost|can'?t open|cannot open|won'?t open)\b.*\b(?:estimate|quote|pdf)\b/i,
  /\b(?:estimate|quote|pdf)\s+link\b/i,
  /\b(?:see|view|look at|get|need|want)\s+(?:my|the)\s+(?:estimate|quote|pdf)\b/i,
];

export function detectEstimateLinkRequest(messageText) {
  if (!messageText || typeof messageText !== 'string') return false;
  const t = messageText.replace(/\s+/g, ' ').trim();
  return REQUEST_PATTERNS.some((re) => re.test(t));
}

// Reply text that promises an estimate link / PDF.
const PROMISES_LINK =
  /\b(?:link|pdf)\b[^.\n]{0,80}\b(?:estimate|quote)\b|\b(?:estimate|quote)\b[^.\n]{0,40}\b(?:link|pdf)\b/i;

export function ensureEstimateLink(text, { eligible = false, requested = false } = {}) {
  const none = { text, changed: false, reason: null };
  if (String(process.env.ESTIMATE_LINK_GUARD || 'on').toLowerCase() === 'off') return none;
  if (typeof text !== 'string' || !text.trim() || !eligible) return none;

  const tag = getEstimatePdfMergeTag();
  if (text.includes(tag)) return none;

  const promises = PROMISES_LINK.test(text);
  if (!promises && !requested) return none;

  // 1. Lead-in line ending with ":" (the 441204 shape).
  const lines = text.split('\n');
  const idx = lines.findIndex((ln) => /:\s*$/.test(ln) && PROMISES_LINK.test(ln));
  if (idx !== -1) {
    lines.splice(idx + 1, 0, tag);
    return { text: lines.join('\n'), changed: true, reason: 'inserted_after_leadin' };
  }

  // 2. Lead-in colon mid-line ("Here is your estimate link: The figure...").
  const m = text.match(/\b(?:link|pdf)\b[^:\n]{0,80}:[ \t]+(?=\S)/i);
  if (m && PROMISES_LINK.test(text.slice(Math.max(0, m.index - 60), m.index + m[0].length))) {
    const cut = m.index + m[0].length;
    const head = text.slice(0, cut).replace(/[ \t]+$/, '');
    return { text: `${head}\n${tag}\n\n${text.slice(cut)}`, changed: true, reason: 'inserted_inline' };
  }

  // 3. Otherwise append on its own line.
  return {
    text: `${text.replace(/\s+$/, '')}\n\nYour estimate: ${tag}`,
    changed: true,
    reason: 'appended',
  };
}
