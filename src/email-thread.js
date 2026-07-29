/**
 * Email Thread Normalization — src/email-thread.js
 *
 * Pure text helpers for reducing an inbound email to WHAT THE CUSTOMER
 * ACTUALLY WROTE, with the quoted thread, HTML markup, and broadcast footer
 * removed. No I/O, no deps — unit-tested directly.
 *
 * Why this module exists (2026-07-29, Kelly Callahan incident)
 * ───────────────────────────────────────────────────────────
 * stripQuotedEmail() lived in behavioral-emitter.js and ran on the inbound
 * WEBHOOK BODY only. Two consumers downstream never saw the stripped text:
 *
 *   1. context-builder.fetchConversation() — reads message bodies back out of
 *      the GHL conversations API, raw. Those turns feed both the generation
 *      prompt and buildIdentityState().
 *   2. identity-extraction.heuristicExtract() — runs PHONE_RE over those raw
 *      turns.
 *
 * Kelly replied 17 words to an F.0 email. The quoted thread underneath carried
 * the GHL unsubscribe link `...&time_stamp=1785346485266`. PHONE_RE
 * (`(\d{3})(\d{3})(\d{4})\b`) has no left anchor, so it matched the last ten
 * digits of that timestamp and the pipeline recorded an identity.field_conflict
 * for a "phone" of +15346485266 — a number that exists nowhere but in a URL.
 * The same quoted block carried the "Mark / Reece Windows & Doors" sign-off
 * that seeds the handoff-bridge template.
 *
 * COMPLIANCE NOTE — why the footer cut is URL-anchored, not word-anchored
 * ──────────────────────────────────────────────────────────────────────
 * behavioral-emitter.handleReply() runs isDNCSignal() on the STRIPPED text, and
 * that matcher looks for the word "unsubscribe". Cutting the body at the first
 * literal "unsubscribe" would silently delete a customer who typed "please
 * unsubscribe me" — an opt-out we are legally required to honor. So the footer
 * cut fires only on an unsubscribe/preferences URL, which a customer never
 * types. A bare word survives and still reaches the DNC matcher.
 */

// A broadcast footer link: the marker is the URL, never the bare word. Matches
// both a raw href and a plain-text link.
const UNSUBSCRIBE_LINK_RX =
  /https?:\/\/[^\s"'<>]*\b(?:unsubscribe|opt[-_]?out|manage[-_]?preferences|email[-_]?preferences)\b[^\s"'<>]*/i;

// Quoted-thread openers. Unchanged from the behavioral-emitter original — these
// are production-proven; the HTML normalization below is what lets them fire on
// bodies that arrive as markup rather than plain text.
const QUOTED_THREAD_MARKERS = [
  /\n\s*On .{0,120}\bwrote:\s*\n/i,          // Gmail / Apple Mail
  /\n\s*-{2,}\s*Original Message\s*-{2,}/i,
  /\n\s*_{5,}\s*\n/,                          // Outlook divider
  /\n\s*From:\s.+\n\s*Sent:\s/i,
];

/**
 * Collapse an HTML email body to plain text, preserving line structure so the
 * quoted-thread markers (which are newline-anchored) can still match.
 * Returns the input unchanged when it carries no markup.
 */
export function htmlEmailToText(text) {
  const t = String(text || '');
  if (!/<[a-z!/][^>]*>/i.test(t)) return t;
  return t
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Reduce an inbound email to the customer's own words: cut at the first quoted-
 * thread marker or broadcast-footer link, drop `>` quote prefixes, trim.
 *
 * Behavior on plain-text bodies is identical to the original
 * behavioral-emitter implementation, plus the URL-anchored footer cut.
 */
export function stripQuotedEmail(text) {
  const t = htmlEmailToText(text);
  let cut = t.length;
  for (const re of [...QUOTED_THREAD_MARKERS, UNSUBSCRIBE_LINK_RX]) {
    const m = t.match(re);
    if (m && m.index !== undefined && m.index < cut) cut = m.index;
  }
  return t.slice(0, cut).replace(/^>.*$/gm, '').trim();
}

/**
 * Blank out every URL in a message before deterministic identity extraction.
 *
 * A URL is never a customer-supplied phone number, ZIP, or street address, but
 * it routinely contains long digit runs (tracking ids, epoch-millisecond
 * timestamps) that unanchored numeric patterns will happily match. Replaces
 * each URL with a single space so surrounding word boundaries are preserved.
 *
 * Applied on every channel, not just email — a tracked link in an SMS poisons
 * the same matchers.
 */
export function scrubUrlsForExtraction(text) {
  return String(text || '').replace(/https?:\/\/[^\s<>"')\]]+/gi, ' ');
}
