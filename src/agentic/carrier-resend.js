/**
 * Carrier re-send decision — src/agentic/carrier-resend.js
 *
 * WHY THIS EXISTS (2026-09-23, following the 2026-09-22 block on GHL
 * hZOcPk6XmMvWVvjZJ7mz / agent_actions 487694)
 * ──────────────────────────────────────────────────────────────────────────
 * A lead asked "Can I pay in Bitcoin?". The bot answered correctly, GHL
 * accepted the send, and the carrier rejected it: Twilio error 30007. From the
 * lead's side the bot stopped replying mid-conversation.
 *
 * Two thirds of that incident are already closed:
 *
 *   PREVENT  src/agentic/carrier-risk.js keeps the trigger vocabulary out of
 *            drafts (standing SMS prompt rule + regenerate-once guard).
 *   DETECT   src/services/send-delivery-verify.js re-reads the message, sees
 *            status=failed, and emits agentic.send_delivery_failed, which
 *            AGENTIC_SEND_BLOCKED_ESCALATE turns into a human task.
 *
 * The missing third is RECOVERY. Waiting for a person means the lead sits in
 * silence until someone picks the task up. This module decides whether the one
 * blocked message can be rewritten and re-sent automatically, and judges the
 * rewrite that comes back.
 *
 * THE LOAD-BEARING IDEA: a re-send is only ever safe when we KNOW the cause was
 * content. GHL reports `failed` for a dead number, a landline and an opt-out
 * too, and re-sending into any of those is useless at best. A known
 * carrier-risk term in the body is our only positive evidence of a content
 * filter — and, not coincidentally, the only case where we know what to change.
 * Everything else falls through to the human path that already exists.
 *
 * PURE. No I/O, no writes, no env reads, no clock. Every input arrives as an
 * argument so scripts/test-carrier-resend.js can drive it directly. The I/O
 * lives in src/services/carrier-resend-runner.js.
 */

import { carrierRisks, carrierRiskNote } from './carrier-risk.js';
import { countQuestions } from './conversation-repetition.js';

/** Widest body we will ever put back on the wire. Two SMS segments of slack. */
const MAX_BODY_CHARS = 1200;
/** A rewrite may shrink (the term goes away) but must still answer the question. */
const MIN_LENGTH_RATIO = 0.4;
/** A rewrite that grew by more than half is not a rewrite, it is a new message. */
const MAX_LENGTH_RATIO = 1.6;

/**
 * May we attempt an automatic re-send of a blocked message?
 *
 * Returns { attempt, reason }. `reason` is recorded on every path — a refusal
 * that cannot be explained afterwards is indistinguishable from a bug.
 *
 * @param {object} facts
 * @param {string} facts.channel          the channel the blocked send used
 * @param {string} facts.sentBody         the exact body the carrier rejected
 * @param {boolean} facts.activityKnown   did the conversation read SUCCEED?
 * @param {boolean} facts.inboundSinceSend
 * @param {boolean} facts.outboundSinceSend
 * @param {boolean} facts.alreadyAttempted
 */
export function resendVerdict({
  channel,
  sentBody,
  activityKnown,
  inboundSinceSend,
  outboundSinceSend,
  alreadyAttempted,
} = {}) {
  // One attempt, ever. Checked first so a stamped row costs nothing else.
  if (alreadyAttempted) return { attempt: false, reason: 'already_attempted' };

  // Email has no carrier filter — a failed email failed for another reason.
  if (channel !== 'sms') return { attempt: false, reason: 'not_sms' };

  if (!sentBody || typeof sentBody !== 'string' || !sentBody.trim()) {
    return { attempt: false, reason: 'no_body_recorded' };
  }

  // THE GATE. No risk term means we have no evidence this was content
  // filtering and no idea what to change. A dead number, a landline and an
  // opt-out all land here, and none of them should be texted again.
  const risks = carrierRisks(sentBody);
  if (risks.length === 0) return { attempt: false, reason: 'no_carrier_risk_term' };

  // "I could not tell" is never permission to act. Same three-way rule as
  // src/alert-state.js: a failed read must neither fire nor clear.
  if (!activityKnown) return { attempt: false, reason: 'activity_unknown' };

  // The lead wrote again — the responder already owns that turn, and this
  // message answers a question they have moved past.
  if (inboundSinceSend) return { attempt: false, reason: 'inbound_since_send' };

  // A later reply landed. The thread continued without this message; dropping
  // an older answer into it now reads as the bot talking to itself.
  if (outboundSinceSend) return { attempt: false, reason: 'outbound_since_send' };

  return { attempt: true, reason: 'carrier_content_block', risks };
}

/**
 * The rewrite request for a blocked body.
 *
 * Built on carrierRiskNote(), which names the CATEGORY and never the word —
 * handing the literal token back is how a retry reproduces it.
 *
 * @param {string} sentBody
 * @param {string[]} risks labels from carrierRisks()
 * @returns {{ system: string, user: string }}
 */
export function buildRewriteRequest(sentBody, risks) {
  const system =
    `You rewrite a single already-approved SMS so a mobile carrier will deliver it. ` +
    `You are not writing a new message and you are not restarting the conversation.\n\n` +
    `${carrierRiskNote(risks)}\n\n` +
    `Rules:\n` +
    `- Keep the same facts, the same order and the same voice. Change only what you must.\n` +
    `- Keep it to ONE question mark at most, and do not add a booking ask that was not already there.\n` +
    `- Never claim to be a human.\n` +
    `- Reply with the rewritten message text ONLY. No preamble, no quotes, no explanation.`;

  const user = `Rewrite this message:\n\n${sentBody}`;
  return { system, user };
}

/**
 * Is the rewrite safe to put on the wire?
 *
 * This is the fail-safe for the whole feature. Anything that does not clearly
 * pass abandons the attempt and falls back to the human escalation we already
 * had — the automatic path may never leave the lead worse off than the manual
 * one.
 *
 * @returns {{ ok: boolean, reason: string, message?: string }}
 */
export function acceptRewrite(original, rewrite) {
  if (!rewrite || typeof rewrite !== 'string') return { ok: false, reason: 'empty_rewrite' };

  // Models like to wrap a rewrite in quotes despite being told not to.
  const message = rewrite.trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
  if (!message) return { ok: false, reason: 'empty_rewrite' };

  if (message === String(original || '').trim()) {
    return { ok: false, reason: 'unchanged' };
  }

  // The whole point. If the term survived, the carrier blocks this one too.
  const remaining = carrierRisks(message);
  if (remaining.length) return { ok: false, reason: `risk_survived:${remaining.join(',')}` };

  if (message.length > MAX_BODY_CHARS) return { ok: false, reason: 'too_long' };

  const ratio = message.length / Math.max(1, String(original || '').trim().length);
  if (ratio < MIN_LENGTH_RATIO) return { ok: false, reason: 'too_short' };
  if (ratio > MAX_LENGTH_RATIO) return { ok: false, reason: 'grew_too_much' };

  // NEPQ one-question rule. A recovery message is the worst possible place to
  // start stacking asks — they never saw the first version.
  if (countQuestions(message) > 1) return { ok: false, reason: 'multiple_questions' };

  return { ok: true, reason: 'accepted', message };
}

/**
 * Did anything happen in the thread after the blocked send?
 *
 * Pure. Takes the GHL message list as-is (newest-first, the shape
 * fetchRecentMessages returns) and the blocked message's own id, which is
 * excluded — the blocked send is itself in the list and would otherwise count
 * as activity after itself.
 *
 * A message with no readable timestamp is IGNORED rather than treated as
 * recent: the caller already refuses when the read as a whole failed, and
 * guessing "probably new" here would suppress every legitimate recovery.
 *
 * @param {object[]} messages
 * @param {number} sinceMs      the blocked send's timestamp
 * @param {string} blockedId    the blocked message's GHL id
 */
export function activitySince(messages, sinceMs, blockedId) {
  const list = Array.isArray(messages) ? messages : [];
  let inbound = false;
  let outbound = false;
  for (const m of list) {
    if (!m || (blockedId && m.id === blockedId)) continue;
    const t = Date.parse(m.dateAdded || m.dateUpdated || '');
    if (!Number.isFinite(t) || t <= sinceMs) continue;
    if (m.direction === 'inbound') inbound = true;
    else outbound = true;
  }
  return { inboundSinceSend: inbound, outboundSinceSend: outbound };
}

export const CARRIER_RESEND_VERSION = '1.0';
