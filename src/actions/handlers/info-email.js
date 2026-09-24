/**
 * send_info_email handler — src/actions/handlers/info-email.js
 *
 * 2026-09-24 (GHL BazzY5Ihu2heR4osVlBF, Mark Test). The bot texted "Want us
 * to send a quick comparison for you and Paloma to look over?", the lead said
 * yes, and the bot replied "Sending that comparison to <email> now". Nothing
 * was ever sent. Its own reasoning called that reply "fulfilling the promise"
 * — to the model, SAYING it was sending was the same as sending, because the
 * reply format gave it no way to send anything by email except the Hurricane
 * Guide. The lead's "I didn't get anything?" and "I checked my email." then
 * went to a silent human handoff. Open issue #220 (2026-07-26) was the same
 * failure on another contact.
 *
 * The fix is a real deliverable: when the lead accepts, the model writes the
 * email in the same turn (companion_action send_info_email) and this handler
 * delivers it through the same email path agentic email replies already use —
 * the Conversations API first, then the "Send Reply" inbound-webhook workflow
 * (GHL_SEND_MESSAGE_WEBHOOK_URL) as the fallback.
 *
 * WHY NOT A PLAIN send_message: send_message is built for REPLIES. It shares
 * the per-(contact, trigger) outbound lock with the SMS that promised this
 * email (same event, same trigger id), and it yields to any newer reply job.
 * Queued as a send_message, the email would be dropped as a duplicate of its
 * own promise, or skipped the moment the lead texted "thanks". A deliverable
 * the lead was told is on its way must not depend on the lead staying quiet.
 *
 * Gates, in order:
 *   1. shape      — subject and body present (the validator already checked)
 *   2. suppression — hard opt-out tags (dnc / do-not-contact) block. The
 *                    executor's mutation gate already blocks stop-bot /
 *                    suppress-automation before this runs.
 *   3. email on file — no address, no send (and an operator is told)
 *   4. already sent — an outbound email with this subject since the action
 *                    was queued means a prior attempt landed; never resend
 *   5. send
 */

// Plain text in, minimal safe HTML out. The Conversations API sends `html`
// for email and does not turn newlines into breaks, so a plain-text body
// arrives as one run-on paragraph. Escape first, then paragraphs.
export function buildInfoEmailHtml(body) {
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return String(body || '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

// Hard opt-outs only. Soft suppression (stop-bot, suppress-automation) is the
// executor's mutation gate; this is the compliance floor, same list the
// reply path treats as hard.
const HARD_OPT_OUT = new Set(['dnc', 'do-not-contact', 'dnc-email', 'stage:dnc', 'unsubscribed']);

/**
 * Pure decision: may this email go out? No I/O.
 * @returns {{send: boolean, reason: string}}
 */
export function decideInfoEmailSend({ subject, body, tags = [], email = null, priorEmailSubjects = [] } = {}) {
  if (!subject || !String(subject).trim() || !body || !String(body).trim()) {
    return { send: false, reason: 'missing_subject_or_body' };
  }
  const lowered = (tags || []).map(t => String(t).toLowerCase());
  const optOut = lowered.find(t => HARD_OPT_OUT.has(t));
  if (optOut) return { send: false, reason: `hard_opt_out:${optOut}` };
  if (!email || !/@/.test(String(email))) return { send: false, reason: 'no_email_on_file' };
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/^(re|fwd?):\s*/i, '');
  if (priorEmailSubjects.some(s => norm(s) === norm(subject))) {
    return { send: false, reason: 'already_sent' };
  }
  return { send: true, reason: 'ok' };
}

/**
 * @param {object} action   agent_actions row (action_payload: { subject, body })
 * @param {object} _context executor context (unused)
 * @param {object} deps     injected I/O — all required in production, see
 *                          defaultDeps() below:
 *   getContact(contactId)           → { email, tags }
 *   getRecentMessages(contactId)    → GHL messages (newest first)
 *   sendEmail(contactId, html, subject, action) → { sendMethod }
 *   emitEvent(evt)                  → Promise
 */
export async function executeSendInfoEmail(action, _context = {}, deps = null) {
  const d = deps || await defaultDeps();
  const contactId = action.target_id;
  if (!contactId) throw new Error('send_info_email: missing target_id');
  const payload = action.action_payload || {};
  const subject = String(payload.subject || '').trim();
  const body = String(payload.body || '').trim();

  const contact = await d.getContact(contactId);
  const email = contact?.email || null;
  const tags = Array.isArray(contact?.tags) ? contact.tags : [];

  // Only emails sent since this action was queued count as "already sent" —
  // an older email with a generic subject must never suppress a new one.
  let priorEmailSubjects = [];
  try {
    const since = Date.parse(action.created_at || '') || 0;
    const msgs = await d.getRecentMessages(contactId);
    priorEmailSubjects = (Array.isArray(msgs) ? msgs : [])
      .filter(m => m?.direction === 'outbound' && (m.messageType === 'TYPE_EMAIL' || m.type === 3))
      .filter(m => (Date.parse(m.dateAdded || m.dateUpdated || '') || 0) >= since)
      .map(m => m?.meta?.email?.subject || '');
  } catch (err) {
    // Cannot tell whether a prior attempt landed. On a FIRST attempt nothing
    // could have landed, so send; on a retry, fail and let a person look
    // rather than risk emailing the same thing twice.
    if ((action.retry_count || 0) > 0) {
      throw new Error(`send_info_email: cannot verify prior attempt (${err.message}) — not resending blind`);
    }
  }

  const decision = decideInfoEmailSend({ subject, body, tags, email, priorEmailSubjects });
  if (!decision.send) {
    console.warn(`[InfoEmail] not sent for ${contactId}: ${decision.reason}`);
    if (decision.reason !== 'already_sent') {
      // The lead was told an email is coming. Anything that stops it is an
      // operator's problem now, not a silent skip.
      await d.emitEvent({
        event_type: 'agentic.info_email_not_sent',
        source: 'lp_mcp', entity_type: 'contact',
        entity_id: String(contactId), ghl_contact_id: String(contactId),
        priority: 'high',
        payload: { reason: decision.reason, subject, action_id: action.id || null },
        idempotency_key: `info_email_not_sent_${action.id || contactId}`,
      }).catch(() => {});
    }
    if (decision.reason === 'already_sent') {
      return { action: 'info_email_already_sent', reason: decision.reason, contact_id: contactId };
    }
    return { skipped: true, action: 'info_email_not_sent', reason: decision.reason, contact_id: contactId };
  }

  const html = buildInfoEmailHtml(body);
  const sent = await d.sendEmail(contactId, html, subject, action);
  console.log(`[InfoEmail] ✅ sent to ${contactId} via ${sent?.sendMethod || 'unknown'}: "${subject}"`);
  await d.emitEvent({
    event_type: 'agentic.info_email_sent',
    source: 'lp_mcp', entity_type: 'contact',
    entity_id: String(contactId), ghl_contact_id: String(contactId),
    priority: 'normal',
    payload: { subject, send_method: sent?.sendMethod || null, action_id: action.id || null, body_chars: body.length },
    idempotency_key: `info_email_sent_${action.id || contactId}`,
  }).catch(() => {});
  return { action: 'info_email_sent', contact_id: contactId, subject, send_method: sent?.sendMethod || null };
}

async function defaultDeps() {
  const [{ getContactCached }, { fetchRecentMessages }, { sendAgenticEmail }, { emitEvent }] = await Promise.all([
    import('../contact-cache.js'),
    import('../../agentic/reply-sender.js'),
    import('../../send-message-handler.js'),
    import('../../event-emitter.js'),
  ]);
  return {
    // GHL's global DND flag is an opt-out too; fold it into the tag check.
    getContact: async (id) => {
      const c = await getContactCached(id);
      const tags = Array.isArray(c?.tags) ? [...c.tags] : [];
      if (c?.dnd === true) tags.push('dnc');
      return { email: c?.email || null, tags };
    },
    getRecentMessages: async (id) => (await fetchRecentMessages(id))?.messages || [],
    sendEmail: (id, html, subject, action) => sendAgenticEmail(id, html, subject, action),
    emitEvent,
  };
}
