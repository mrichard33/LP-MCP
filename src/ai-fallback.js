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
 *     resolves it on delivery), points at a call / invites a reply.
 *   - Neither variant trips a compliance gate or makes a specific commitment.
 *
 * 2026-09-11 — HOURS-AWARE. Both variants used to say the follow-up was coming
 * "shortly" no matter what time it was. That is the same promise the reply path
 * is now barred from making outside staffed hours (Mark's ruling, see
 * src/dial-window.js), and the fallback is exactly the path a reply takes when
 * the guard rejects the model's draft — so shipping "shortly" here would hand
 * back the promise the guard just removed. Inside staffed hours the copy is
 * unchanged; outside, it names the next opening instead.
 */
import { isWithinStaffedHours, nextStaffedOpening } from './staffed-hours.js';

/**
 * Build the channel-appropriate safe fallback message.
 *
 * @param {string} channel       'email' | 'sms'
 * @param {string} [subject]     existing/resolved subject (email only); kept if set
 * @param {{atMs?: number, randyThread?: boolean, bridgeName?: string}} [opts]
 *        atMs        clock injection point for tests
 *        randyThread the lead is replying to a broadcast signed by bridgeName
 *        bridgeName  who signed it (default 'Randy')
 * @returns {{ message: string, subject: (string|null) }}
 */
export function buildAiFallback(channel, subject = null, opts = {}) {
  const atMs = Number.isFinite(opts.atMs) ? opts.atMs : Date.now();
  const open = isWithinStaffedHours(atMs);
  const opening = open ? null : nextStaffedOpening(atMs);
  // 2026-09-18 — RANDY THREAD (Catherine Crosier). She replied to a broadcast
  // signed by Randy and got this copy back, opening cold as though the thread
  // had started with us. On a Randy thread the bridge is not decoration: it is
  // the only thing that explains why a stranger is answering.
  //
  // This path has NO model, so it cannot paraphrase what she said — and a
  // fallback that guessed at her point would be worse than one that does not
  // claim to know it. It bridges generically and stops there. The specific
  // paraphrase is the AI path's job, enforced by findMissingRandyBridge.
  const bridgeName = String(opts.bridgeName || 'Randy').trim() || 'Randy';
  const randyThread = opts.randyThread === true;

  // "shortly" only while somebody is there to make it true.
  const emailWhen = open
    ? 'Expect a follow-up from our team shortly, or reply here anytime.'
    : (opening?.human
      ? `Our team is out for the day — someone will pick this up ${opening.human} ET. Reply here anytime in the meantime.`
      : 'Our team will pick this up as soon as the office is open. Reply here anytime in the meantime.');

  const smsWhen = open
    ? 'Expect a call from our team shortly, or reply here anytime.'
    : (opening?.human
      ? `Our team is out for the day — someone will reach out ${opening.human} ET. Reply here anytime in the meantime.`
      : 'Our team will reach out as soon as the office is open. Reply here anytime in the meantime.');

  // Rep voice throughout: "I" for the handoff, "our team" for the follow-up.
  // bridgeName is named in the THIRD person and never speaks here.
  const emailOpener = randyThread
    ? `${bridgeName} passed your note along and asked me to reach out to you personally. `
    : `Thanks for reaching out — we want to make sure we get back to you properly. `;

  const smsOpener = randyThread
    ? `Hey {{contact.first_name}} — ${bridgeName} passed your note along and asked me to reach out personally. `
    : `Hey {{contact.first_name}} — thanks for reaching out. We want to make sure we get back to you properly. `;

  if (channel === 'email') {
    return {
      message:
        `${emailOpener}` +
        `${emailWhen}\n\n` +
        `{{custom_values.rep_name}}\nReece Windows & Doors`,
      subject: subject || 'Following up',
    };
  }
  return {
    message: `${smsOpener}${smsWhen}`,
    subject: subject || null,
  };
}

export default { buildAiFallback };
