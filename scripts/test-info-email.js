/**
 * The bot may only say something is being sent when the same reply sends it.
 *
 * 2026-09-24, GHL BazzY5Ihu2heR4osVlBF (Mark Test): "Want us to send a quick
 * comparison for you and Paloma to look over?" → "Sure that sound great!" →
 * "Sending that comparison to mrichard6275@gmail.com now…". Nothing was ever
 * sent; "I didn't get anything?" and "I checked my email." followed.
 *
 * Covers the three pieces of the fix:
 *   - src/agentic/send-promise.js     detect a promise with no delivery; validate the email
 *   - src/actions/handlers/info-email.js  deliver it (gates, dedup, HTML)
 *   - buildUndeliveredPromiseTask     a surviving promise becomes a rep task
 *   - INFO_EMAIL_WEBHOOK_URL          the GHL inbound-webhook path (subject, preheader, body)
 *
 * Run: node --test scripts/test-info-email.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const {
  findSendPromise, findUndeliveredSendPromise, undeliveredPromiseNote, validateInfoEmailPayload,
} = await import('../src/agentic/send-promise.js');
const {
  buildInfoEmailHtml, decideInfoEmailSend, executeSendInfoEmail,
  resolveInfoEmailDelivery, withPreheader, buildInfoEmailWebhookPayload,
} = await import('../src/actions/handlers/info-email.js');
const { buildUndeliveredPromiseTask, INFO_EMAIL_RULE } = await import('../src/send-message-handler.js');

// ── The live messages ─────────────────────────────────────────────────

const THE_OFFER = 'Shutters cost less up front, true. But you\'re putting them up and down every storm, with no permanent, code-verified record for your insurer. Protection is not what you install. It\'s what you can prove. Want us to send a quick comparison for you and Paloma to look over?';
const THE_PROMISE = 'Sending that comparison to mrichard6275@gmail.com now so you and Paloma can go through it together.';

test('the live 00:20 reply is flagged as a promise with nothing attached', () => {
  assert.equal(findUndeliveredSendPromise(THE_PROMISE, null, { channel: 'sms' }), THE_PROMISE);
});

test('the 00:18 offer is a question, and an offer is allowed', () => {
  assert.equal(findSendPromise(THE_OFFER), null);
});

test('other live promises from 2026-09-23 are caught too', () => {
  for (const text of [
    "Sounds good, Alyce. I'll get that over to you soon.",
    "No problem, Kenneth Sr, timing has to be right. We'll send our free Hurricane Preparedness Guide to the email on file so you have it handy this season. Sound good?",
    "I'll email you the details and call you Monday.",
    'Just sent that to mark@example.com.',
  ]) {
    assert.ok(findSendPromise(text), `missed: ${text}`);
  }
});

test('things this system really delivers elsewhere are not inbox promises', () => {
  for (const text of [
    "We'll get someone to call you tomorrow morning.",
    "You'll get a confirmation shortly, and our team will call you to go over the details.",
    "You can send them over, and I'll put them on your file.",
    "We'll send a reminder text the day before.",
    'Want me to email you a quick rundown?',
  ]) {
    assert.equal(findSendPromise(text), null, `false alarm: ${text}`);
  }
});

test('a promise is fine when the same reply carries the email that keeps it', () => {
  const companion = { action_type: 'send_info_email', action_payload: { subject: 's', body: 'b' } };
  assert.equal(findUndeliveredSendPromise('Just sent that to mark@example.com.', companion), null);
});

test('an accepted guide keeps the promise; a declined one does not', () => {
  const guide = { action_type: 'guide_disposition', action_payload: { outcome: 'accepted' } };
  assert.equal(findUndeliveredSendPromise("We'll send the Hurricane Preparedness Guide to your email within the hour.", guide), null);
  assert.equal(findUndeliveredSendPromise('Perfect, check your inbox within the hour.', guide), null);
  const declined = { action_type: 'guide_disposition', action_payload: { outcome: 'declined' } };
  assert.ok(findUndeliveredSendPromise("We'll send the guide to your email.", declined));
});

test('an email reply is its own delivery and is never flagged', () => {
  assert.equal(findUndeliveredSendPromise("I'm sending the details below.", null, { channel: 'email' }), null);
});

test('the regeneration note names the fix, not just the prohibition', () => {
  const note = undeliveredPromiseNote(THE_PROMISE);
  assert.match(note, /send_info_email/);
  assert.match(note, /ask for the best email/);
  assert.match(note, /GUIDE OFFER/);
});

// ── The email payload ────────────────────────────────────────────────

const GOOD_BODY = 'Mark,\n\nShutters protect only when someone puts them up in time. Impact windows are always on, including when you are away.\n\nWe install to current Florida code and document the work.\n\nReece Windows & Doors';

test('a good payload survives, trimmed', () => {
  const v = validateInfoEmailPayload({ subject: '  Impact windows vs. shutters  ', body: `  ${GOOD_BODY}  ` });
  assert.equal(v.subject, 'Impact windows vs. shutters');
  assert.equal(v.body, GOOD_BODY);
});

test('payloads that would reach a customer wrong are dropped', () => {
  const cases = [
    [{ subject: '', body: GOOD_BODY }, /subject/],
    [{ subject: 'x', body: 'too short' }, /body under/],
    [{ subject: 'x', body: `${GOOD_BODY} See https://example.com` }, /link/],
    [{ subject: 'x', body: `${GOOD_BODY} Starts at $4,000.` }, /dollar/],
    [{ subject: 'Hi {{contact.first_name}}', body: GOOD_BODY }, /merge tag/],
    [{ subject: 'x'.repeat(121), body: GOOD_BODY }, /subject over/],
  ];
  for (const [cap, why] of cases) {
    const v = validateInfoEmailPayload(cap);
    assert.ok(v.error, `accepted: ${JSON.stringify(cap).slice(0, 80)}`);
    assert.match(v.error, why);
  }
});

test('the body becomes escaped paragraphs, not one run-on line', () => {
  const html = buildInfoEmailHtml('Hi <Mark> & co,\n\nLine one\nline two\n\n\nBye');
  assert.equal(html, '<p>Hi &lt;Mark&gt; &amp; co,</p>\n<p>Line one<br>line two</p>\n<p>Bye</p>');
});

// ── Delivery gates ───────────────────────────────────────────────────

test('delivery decisions', () => {
  const base = { subject: 'Impact vs shutters', body: GOOD_BODY, email: 'm@example.com' };
  assert.deepEqual(decideInfoEmailSend(base), { send: true, reason: 'ok' });
  assert.equal(decideInfoEmailSend({ ...base, email: null }).reason, 'no_email_on_file');
  assert.equal(decideInfoEmailSend({ ...base, tags: ['DNC'] }).reason, 'hard_opt_out:dnc');
  assert.equal(decideInfoEmailSend({ ...base, priorEmailSubjects: ['Re: impact vs shutters'] }).reason, 'already_sent');
  assert.equal(decideInfoEmailSend({ ...base, body: '' }).reason, 'missing_subject_or_body');
});

function fakeDeps({ email = 'm@example.com', tags = [], messages = [], messagesThrow = false } = {}) {
  const calls = { sent: [], events: [] };
  return {
    calls,
    deps: {
      getContact: async () => ({ email, tags }),
      getRecentMessages: async () => { if (messagesThrow) throw new Error('ghl down'); return messages; },
      sendEmail: async (id, html, subject) => { calls.sent.push({ id, html, subject }); return { sendMethod: 'conversations_api' }; },
      emitEvent: async (e) => { calls.events.push(e); },
    },
  };
}

const ACTION = {
  id: 9001, target_id: 'BazzY5Ihu2heR4osVlBF', created_at: '2026-09-24T00:20:04Z', retry_count: 0,
  action_payload: { subject: 'Impact windows vs. shutters', body: GOOD_BODY },
};

test('it sends the email the lead was promised', async () => {
  const { deps, calls } = fakeDeps();
  const r = await executeSendInfoEmail(ACTION, {}, deps);
  assert.equal(r.action, 'info_email_sent');
  assert.equal(calls.sent.length, 1);
  assert.equal(calls.sent[0].subject, 'Impact windows vs. shutters');
  assert.match(calls.sent[0].html, /^<p>Mark,<\/p>/);
  assert.equal(calls.events.at(-1).event_type, 'agentic.info_email_sent');
});

test('no email on file: nothing sent, and an operator hears about it', async () => {
  const { deps, calls } = fakeDeps({ email: null });
  const r = await executeSendInfoEmail(ACTION, {}, deps);
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no_email_on_file');
  assert.equal(calls.sent.length, 0);
  assert.equal(calls.events.at(-1).event_type, 'agentic.info_email_not_sent');
});

test('a retry whose first attempt landed does not email twice', async () => {
  const { deps, calls } = fakeDeps({
    messages: [{ direction: 'outbound', messageType: 'TYPE_EMAIL', dateAdded: '2026-09-24T00:21:00Z', meta: { email: { subject: 'Impact windows vs. shutters' } } }],
  });
  const r = await executeSendInfoEmail({ ...ACTION, retry_count: 1 }, {}, deps);
  assert.equal(r.action, 'info_email_already_sent');
  assert.equal(calls.sent.length, 0);
});

test('an OLDER email with the same subject does not suppress a new one', async () => {
  const { deps, calls } = fakeDeps({
    messages: [{ direction: 'outbound', messageType: 'TYPE_EMAIL', dateAdded: '2026-09-20T00:00:00Z', meta: { email: { subject: 'Impact windows vs. shutters' } } }],
  });
  await executeSendInfoEmail(ACTION, {}, deps);
  assert.equal(calls.sent.length, 1);
});

test('a retry that cannot check the thread refuses to resend blind', async () => {
  const { deps, calls } = fakeDeps({ messagesThrow: true });
  await assert.rejects(executeSendInfoEmail({ ...ACTION, retry_count: 1 }, {}, deps), /not resending blind/);
  assert.equal(calls.sent.length, 0);
  // A first attempt cannot have landed yet, so it goes out.
  await executeSendInfoEmail(ACTION, {}, deps);
  assert.equal(calls.sent.length, 1);
});

// ── Subject, preheader and body, on both paths ───────────────────────

test('a missing preheader is filled from the body, skipping the greeting', () => {
  const v = validateInfoEmailPayload({ subject: 'Impact vs shutters', body: GOOD_BODY });
  assert.equal(v.preheader, 'Shutters protect only when someone puts them up in time.');
});

test('a given preheader is kept, trimmed, and capped', () => {
  assert.equal(validateInfoEmailPayload({ subject: 's', preheader: '  What each one asks of you.  ', body: GOOD_BODY }).preheader,
    'What each one asks of you.');
  const long = validateInfoEmailPayload({ subject: 's', preheader: 'word '.repeat(40), body: GOOD_BODY }).preheader;
  assert.ok(long.length <= 110 && long.endsWith('…'));
});

test('the preheader is held to the same lines as the body', () => {
  assert.match(validateInfoEmailPayload({ subject: 's', preheader: 'From $4,000', body: GOOD_BODY }).error, /dollar/);
  assert.match(validateInfoEmailPayload({ subject: 's', preheader: 'see www.x.com', body: GOOD_BODY }).error, /link/);
});

test('the direct path puts the preheader first, hidden and escaped', () => {
  const html = withPreheader('<p>Hi</p>', 'A & B <now>');
  assert.match(html, /^<div style="display:none;[^"]*">A &amp; B &lt;now&gt;<\/div>\n<p>Hi<\/p>$/);
  assert.equal(withPreheader('<p>Hi</p>', ''), '<p>Hi</p>');
});

test('the switch is the webhook URL: set means workflow, unset means direct', () => {
  assert.equal(resolveInfoEmailDelivery({}), 'direct');
  assert.equal(resolveInfoEmailDelivery({ INFO_EMAIL_WEBHOOK_URL: '  ' }), 'direct');
  assert.equal(resolveInfoEmailDelivery({ INFO_EMAIL_WEBHOOK_URL: 'https://services.leadconnectorhq.com/hooks/x' }), 'workflow');
});

function webhookDeps(opts = {}) {
  const { deps, calls } = fakeDeps(opts);
  calls.posts = [];
  Object.assign(deps, {
    delivery: 'workflow',
    postWebhook: async (p) => { if (opts.postThrows) throw new Error('webhook 500'); calls.posts.push(p); },
  });
  return { deps, calls };
}

const ACTION_PH = { ...ACTION, action_payload: { ...ACTION.action_payload, preheader: 'What each one protects.' } };

test('the webhook carries subject, preheader and body in one request', async () => {
  const { deps, calls } = webhookDeps();
  const r = await executeSendInfoEmail(ACTION_PH, {}, deps);
  assert.equal(r.delivery, 'workflow');
  assert.equal(calls.sent.length, 0, 'the direct send must not also fire');
  assert.equal(calls.posts.length, 1);
  const p = calls.posts[0];
  assert.equal(p.contact_id, 'BazzY5Ihu2heR4osVlBF');
  assert.equal(p.email, 'm@example.com');
  assert.equal(p.subject, 'Impact windows vs. shutters');
  assert.equal(p.preheader, 'What each one protects.');
  assert.match(p.body_html, /^<p>Mark,<\/p>/);
  assert.doesNotMatch(p.body_html, /display:none/, 'the workflow sets the preheader itself');
  assert.equal(calls.events.at(-1).payload.preheader, 'What each one protects.');
});

test('the direct path sends the same preheader inside the HTML', async () => {
  const { deps, calls } = fakeDeps();
  await executeSendInfoEmail(ACTION_PH, {}, deps);
  assert.match(calls.sent[0].html, /^<div style="display:none;[^"]*">What each one protects\.<\/div>/);
});

test('the webhook path keeps every gate: opt-out, no email, already sent', async () => {
  for (const opts of [
    { tags: ['dnc'] },
    { email: null },
    { messages: [{ direction: 'outbound', messageType: 'TYPE_EMAIL', dateAdded: '2026-09-24T00:21:00Z', meta: { email: { subject: 'Impact windows vs. shutters' } } }] },
  ]) {
    const { deps, calls } = webhookDeps(opts);
    await executeSendInfoEmail(ACTION_PH, {}, deps);
    assert.equal(calls.posts.length, 0, `posted for ${JSON.stringify(opts).slice(0, 60)}`);
  }
});

test('a failed webhook fails the action so the executor retries it', async () => {
  const { deps } = webhookDeps({ postThrows: true });
  await assert.rejects(executeSendInfoEmail(ACTION_PH, {}, deps), /webhook 500/);
});

test('the webhook payload is exactly the fields the workflow maps', () => {
  const p = buildInfoEmailWebhookPayload({ contactId: 'c1', email: 'e@x.com', subject: 's', preheader: 'p', body: 'Hi\n\nThere', actionId: 5 });
  assert.deepEqual(Object.keys(p).sort(), ['action_id', 'body_html', 'body_text', 'contact_id', 'email', 'preheader', 'source', 'subject']);
  assert.equal(p.body_html, '<p>Hi</p>\n<p>There</p>');
});

// ── A promise that survives becomes a person's job ───────────────────

test('a surviving promise queues a high-priority rep task quoting the promise', () => {
  const t = buildUndeliveredPromiseTask({ contactId: 'c1', eventId: 7, promise: THE_PROMISE });
  assert.equal(t.action_type, 'create_task');
  assert.equal(t.target_id, 'c1');
  assert.equal(t.requires_approval, false);
  assert.equal(t.rule_applied, 'UNDELIVERED_PROMISE_ALERT');
  assert.match(t.action_payload.description, /Sending that comparison/);
  assert.equal(t.action_payload.due_in_hours, 2);
});

test('info emails are countable under their own rule', () => {
  assert.equal(INFO_EMAIL_RULE, 'AGENTIC_INFO_EMAIL');
});
