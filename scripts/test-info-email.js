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
 *   - INFO_EMAIL_DELIVERY=workflow    the "Hybrid" path through U.SEND-AI
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
  resolveInfoEmailDelivery, makeInfoEmailFieldResolver, registerInfoEmailRoutes,
  INFO_EMAIL_TRIGGER_TAG,
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

// ── Hybrid: sending through U.SEND-AI ────────────────────────────────

function workflowDeps(opts = {}) {
  const { deps, calls } = fakeDeps(opts);
  calls.steps = [];
  Object.assign(deps, {
    delivery: 'workflow',
    ensureFields: async () => ({ subject: { id: 'F_SUBJ' }, body: { id: 'F_BODY' } }),
    writeFields: async (id, cf) => {
      if (opts.writeThrows) throw new Error('ghl 500');
      calls.steps.push(['fields', cf]);
    },
    removeTag: async (id, tag) => { calls.steps.push(['remove', tag]); },
    addTag: async (id, tag) => { calls.steps.push(['add', tag]); },
  });
  return { deps, calls };
}

test('the switch defaults to direct; only "workflow" turns the workflow on', () => {
  assert.equal(resolveInfoEmailDelivery({}), 'direct');
  assert.equal(resolveInfoEmailDelivery({ INFO_EMAIL_DELIVERY: 'Workflow ' }), 'workflow');
  assert.equal(resolveInfoEmailDelivery({ INFO_EMAIL_DELIVERY: 'yes' }), 'direct');
});

test('workflow mode saves the checked text BEFORE adding the trigger tag', async () => {
  const { deps, calls } = workflowDeps();
  const r = await executeSendInfoEmail(ACTION, {}, deps);
  assert.equal(r.delivery, 'workflow');
  assert.equal(calls.sent.length, 0, 'the direct send must not also fire');
  assert.deepEqual(calls.steps.map(s => s[0]), ['fields', 'add']);
  const [, cf] = calls.steps[0];
  assert.deepEqual(cf[0], { id: 'F_SUBJ', field_value: 'Impact windows vs. shutters' });
  assert.match(cf[1].field_value, /^<p>Mark,<\/p>/);
  assert.equal(calls.steps[1][1], INFO_EMAIL_TRIGGER_TAG);
  assert.equal(calls.events.at(-1).payload.delivery, 'workflow');
});

test('a tag left over from last time is removed first, so the workflow fires again', async () => {
  const { deps, calls } = workflowDeps({ tags: ['Trigger-Send-Info'] });
  await executeSendInfoEmail(ACTION, {}, deps);
  assert.deepEqual(calls.steps.map(s => s[0]), ['fields', 'remove', 'add']);
});

test('workflow mode keeps every gate: opt-out, no email, already sent', async () => {
  for (const opts of [
    { tags: ['dnc'] },
    { email: null },
    { messages: [{ direction: 'outbound', messageType: 'TYPE_EMAIL', dateAdded: '2026-09-24T00:21:00Z', meta: { email: { subject: 'Impact windows vs. shutters' } } }] },
  ]) {
    const { deps, calls } = workflowDeps(opts);
    await executeSendInfoEmail(ACTION, {}, deps);
    assert.deepEqual(calls.steps, [], `touched GHL for ${JSON.stringify(opts).slice(0, 60)}`);
  }
});

test('a failed field write adds no tag and fails the action so it retries', async () => {
  const { deps, calls } = workflowDeps({ writeThrows: true });
  await assert.rejects(executeSendInfoEmail(ACTION, {}, deps), /ghl 500/);
  assert.deepEqual(calls.steps, []);
});

test('field resolver reuses existing fields and creates only what is missing', async () => {
  const created = [];
  const ensure = makeInfoEmailFieldResolver({
    listFields: async () => [{ id: 'X1', name: 'Info Email Subject', fieldKey: 'contact.info_email_subject' }],
    createField: async (f) => { created.push(f); return { id: 'X2', fieldKey: 'contact.info_email_body' }; },
  });
  const f = await ensure();
  assert.equal(f.subject.id, 'X1');
  assert.equal(f.body.id, 'X2');
  assert.deepEqual(created, [{ name: 'Info Email Body', dataType: 'LARGE_TEXT', model: 'contact' }]);
  await ensure();
  assert.equal(created.length, 1, 'a complete result is cached');
});

test('field resolver never caches a partial result', async () => {
  let lists = 0;
  const ensure = makeInfoEmailFieldResolver({
    listFields: async () => { lists++; return []; },
    createField: async (f) => (f.name === 'Info Email Body' && lists === 1 ? null : { id: `id-${f.name}` }),
  });
  await assert.rejects(ensure(), /could not resolve or create/);
  const f = await ensure();
  assert.equal(f.body.id, 'id-Info Email Body');
  assert.equal(lists, 2);
});

test('POST /n8n/info-email/ensure-fields rejects an unauthenticated call', async () => {
  const { default: express } = await import('express');
  const { makeAuthenticate } = await import('../src/auth.js');
  let ensured = 0;
  const ensure = async () => { ensured++; return { subject: { id: 'a', fieldKey: 'contact.info_email_subject' }, body: { id: 'b', fieldKey: 'contact.info_email_body' } }; };
  for (const [auth, header, want] of [
    [makeAuthenticate({ token: 'tok', log: () => {} }), null, 401],
    [undefined, 'Bearer tok', 401],
    [makeAuthenticate({ token: 'tok', log: () => {} }), 'Bearer tok', 200],
  ]) {
    const app = express();
    registerInfoEmailRoutes(app, auth, { ensure });
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/n8n/info-email/ensure-fields`, {
        method: 'POST', headers: header ? { Authorization: header } : {},
      });
      assert.equal(res.status, want);
      if (want === 200) assert.equal((await res.json()).merge_tags.body, '{{contact.info_email_body}}');
    } finally { await new Promise(r => server.close(r)); }
  }
  assert.equal(ensured, 1, 'only the authenticated call may create fields');
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
