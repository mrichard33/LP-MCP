/**
 * scripts/test-warranty-request.js
 *
 * A copy of the warranty asked for is sent in the same reply
 * (src/agentic/warranty-request.js, 2026-10-15). Jeff Clark
 * (ySxZUqvXqSHInFgglEmL) texted "Please include a copy of your warranty as
 * well. Thanks" on 2026-10-14 and nothing could answer it.
 *
 * Covers the detector, the planner's `warranty` move, the reply guard (no
 * "later", no price guarantee), the links on SMS / live chat, the email
 * attachments on the Conversations API body, the callback route skipped for a
 * fulfilled request, and checkReply.
 */

process.env.SUPABASE_URL ||= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const W = await import('../src/agentic/warranty-request.js');
const { planNepqTurn, checkAgainstReference } = await import('../src/agentic/nepq-planner.js');
const { checkReply } = await import('../src/eval/reply-invariants.js');
const { schedulingCallbackDecision } = await import('../src/agentic/bot-callback.js');

const JEFF = 'Please include a copy of your warranty as well. Thanks';
const URLS = ['https://assets.cdn.filesafe.space/x/warranty-certificate.pdf', 'https://assets.cdn.filesafe.space/x/warranty-information.pdf'];
const ENV = { WARRANTY_PDF_URLS: URLS.join(', ') };

test('the detector: copy / send / info / what it covers, never a service ask', () => {
  for (const t of [JEFF, 'can you send me the warranty', 'warranty info?', 'What does the warranty cover?', 'Could I get a copy of the lifetime warranty', 'email me the warranty paperwork']) {
    assert.equal(W.isWarrantyRequest(t), true, t);
  }
  for (const t of ['My window is broken, is it under warranty?', 'I have a warranty claim', 'warranty repair on my slider', 'The warranty sounds good', 'Thanks', '']) {
    assert.equal(W.isWarrantyRequest(t), false, t);
  }
});

test('no WARRANTY_PDF_URLS: the feature is off', () => {
  assert.deepEqual(W.warrantyUrls({}), []);
  assert.equal(W.warrantyTurn(JEFF, {}), null);
  assert.deepEqual(W.warrantyTurn(JEFF, ENV), { urls: URLS });
  assert.deepEqual(W.warrantyUrls({ WARRANTY_PDF_URLS: 'not-a-url, https://ok/x.pdf' }), ['https://ok/x.pdf']);
});

test('the planner sends it (not a hand-off, nothing booked), on a rehash lead too', () => {
  const plan = planNepqTurn({ channel: 'sms', trigger: JEFF, conversation: [], firstName: 'Jeff', warrantyAvailable: true, postDemo: true, rehash: true, postDemoLead: true });
  assert.equal(plan.required_move, 'warranty');
  assert.ok(!plan.handoff, 'not a hand-off');
  assert.equal(plan.booking.allowed, false);
  assert.match(plan.fixed_line, /^Here's a copy of the warranty, Jeff\./);
  assert.deepEqual(checkAgainstReference("Here's a copy of our warranty, Jeff. Anything in it you'd like me to go over?", plan.fixed_line, [], plan), []);
  assert.ok(checkAgainstReference("I'll have the team send that over.", plan.fixed_line, [], plan).some((p) => p.startsWith('missing:')));
});

test('without the files, or with a call asked for too, the planner does not take the move', () => {
  assert.notEqual(planNepqTurn({ channel: 'sms', trigger: JEFF, conversation: [], warrantyAvailable: false }).required_move, 'warranty');
  assert.notEqual(planNepqTurn({ channel: 'sms', trigger: 'Send me the warranty and can someone call me?', conversation: [], warrantyAvailable: true }).required_move, 'warranty');
});

test('the reply guard: no later delivery, no price guarantee, the warranty line added', () => {
  const w = W.enforceWarrantyReply("Thanks Jeff, I'll have the team send that over shortly. It also has a 30-day price guarantee. Anything else?", { firstName: 'Jeff' });
  assert.equal(w.text, "Here's a copy of the warranty, Jeff. Anything else?");
  assert.deepEqual(w.changes, ['later_delivery_dropped', 'price_guarantee_dropped', 'warranty_line_added']);
  const ok = "Here's a copy of our warranty, Jeff. Your quote is with the team. Anything in it you want me to walk through?";
  assert.deepEqual(W.enforceWarrantyReply(ok, { firstName: 'Jeff' }), { text: ok, changed: false, changes: [] });
  assert.equal(W.enforceWarrantyReply('<p>Hi Jeff,</p><p>Your quote is coming.</p>', { firstName: 'Jeff' }).text, "<p>Hi Jeff,</p><p>Here's a copy of the warranty, Jeff.</p><p>Your quote is coming.</p>");
});

test('SMS / live chat: the links on their own lines, once', () => {
  const out = W.appendWarrantyLinks("Here's a copy of the warranty, Jeff.", URLS);
  assert.equal(out, `Here's a copy of the warranty, Jeff.\n${URLS[0]}\n${URLS[1]}`);
  assert.equal(W.appendWarrantyLinks(out, URLS), out);
});

test('email: the PDFs ride as attachments on the Conversations API body; SMS never does', () => {
  const src = readFileSync(new URL('../src/send-message-handler.js', import.meta.url), 'utf8');
  assert.match(src, /if \(channel === 'email' && Array\.isArray\(opts\.attachments\) && opts\.attachments\.length\) \{\n\s+msgBody\.attachments = opts\.attachments;/);
  assert.match(src, /if \(warrantyFiles && channel !== 'email'\) message = appendWarrantyLinks\(message, warrantyFiles\);/);
  assert.match(src, /\.\.\.\(warrantyFiles && channel === 'email' \? \{ attachments: warrantyFiles \} : \{\}\)/);
  assert.match(src, /warranty_sent: true/);
});

test('a fulfilled warranty request is not a callback; a call asked for still is', () => {
  // The send handler passes recommendedAction null on a warranty turn.
  assert.equal(schedulingCallbackDecision({ recommendedAction: null }), null);
  assert.equal(schedulingCallbackDecision({ recommendedAction: null, requestedFulfillment: 'phone_call' })?.why, 'scheduling_no_booking');
  const src = readFileSync(new URL('../src/send-message-handler.js', import.meta.url), 'utf8');
  assert.match(src, /recommendedAction: warrantyFiles \? null :/);
});

test('checkReply: "here is the warranty" only on a turn that sends it', () => {
  const reply = "Here's a copy of the warranty, Jeff. Anything in it you want me to walk through?";
  assert.equal(checkReply(reply, { channel: 'sms', warrantySent: true }).violations.some((v) => v.code === 'warranty_claim_without_file'), false);
  assert.equal(checkReply(reply, { channel: 'sms', warrantySent: false }).violations.some((v) => v.code === 'warranty_claim_without_file'), true);
  assert.ok(checkReply(reply, { channel: 'sms' }).skipped.includes('warranty_claim'));
  assert.equal(W.claimsWarrantySent('Want me to send you a copy of the warranty?'), false, 'an offer is not a claim');
});
