/**
 * AI generation fallback copy — src/ai-fallback.js
 *
 * Issue #99: when response-generator throws on every attempt (malformed/
 * truncated JSON, prose-only output, or an upstream API error), the send
 * handler must still deliver SOMETHING so the lead never gets silently dropped.
 *
 * This module owns the safe, neutral fallback copy. It is intentionally
 * dependency-free and pure so it can be unit-tested in isolation and reused by
 * any caller that needs the same templated reply.
 *
 * Copy contract:
 *   - email: REP voice (the chat/email reply bot is the rep / company voice —
 *     "we / our team", never Randy's first person; signs with the
 *     {{custom_values.rep_name}} merge tag, GHL resolves it on delivery).
 *     Promises a team follow-up and invites a reply. Subject defaults to
 *     "Following up" when none was already resolved.
 *   - sms:   conversational, uses the {{contact.first_name}} merge tag (GHL
 *     resolves it on delivery), promises a call / invites a reply.
 *   - Neither variant trips a compliance gate or makes a specific commitment.
 */

/**
 * Build the channel-appropriate safe fallback message.
 *
 * @param {string} channel       'email' | 'sms'
 * @param {string} [subject]     existing/resolved subject (email only); kept if set
 * @returns {{ message: string, subject: (string|null) }}
 */
export function buildAiFallback(channel, subject = null) {
  if (channel === 'email') {
    return {
      message:
        `Thanks for reaching out — we want to make sure we get back to you properly. ` +
        `Expect a follow-up from our team shortly, or reply here anytime.\n\n` +
        `{{custom_values.rep_name}}\nReece Windows & Doors`,
      subject: subject || 'Following up',
    };
  }
  return {
    message:
      `Hey {{contact.first_name}} — thanks for reaching out. We want to make sure we get back ` +
      `to you properly. Expect a call from our team shortly, or reply here anytime.`,
    subject: subject || null,
  };
}

export default { buildAiFallback };
