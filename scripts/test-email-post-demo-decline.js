/**
 * A post-demo decline by email: one objection reply with no question, then a
 * warm close (Mark, 2026-10-19).
 *
 * Canary: Thomas Geary, GHL aueIFUNV3UeZpATu51hc, LP Prospect 461733, a rehash
 * lead (OPPFDN 10/10). agent_actions 573254 (sent 2026-10-12 14:37Z) answered
 * his firm decline well and closed on "If anything about the numbers or the
 * warranty terms is still unclear, what is the part you would want walked
 * through again." Mark: everything but that last line was right.
 *
 * Run: node --test scripts/test-email-post-demo-decline.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  planPostDemoEmail, enforcePostDemoEmail, emailPostDemoMode, planStepFor,
  declineCloseLine, sentenceAsks, DECLINE_FIRST_STEP, DECLINE_CLOSE_STEP,
} = await import('../src/agentic/post-demo-email.js');
const { checkReply } = await import('../src/eval/reply-invariants.js');
const P = await import('../src/prompts/response-generator/index.js');

// His inbound, exactly as GHL relayed it (event 4257716: "\n" as two characters).
const THOMAS_IN = 'Thank you. She did a great job. And would be a great long term investment to your company. We will not be investing 25 % of\\npurchased value when the market value will not justify the cost. You have an above average product with exceptional installation.\\nCongratulations on the longevity of your family owned business.\\n';

// The draft that went out (bot_message_context 645, reply_text): sent_body plus the closing line.
const KEPT = 'Thank you, Thomas. That means a lot, and we will pass your kind words about Lamyaa along.\n\n' +
  'I hear you on the math. A lot of homeowners run that same comparison, treating this as a straight dollar-for-dollar line against resale value. The piece that often gets missed is that the real return is not just the glass, it is the documentation behind it. Protection is not what you install. It is what you can prove, and that is what holds up when an insurer or a future buyer actually looks at the file.\n\n' +
  'We will not push on this one. Your written proposal is good for a full year, so there is no rush on your end. I am passing your notes to our follow-up team so they have the full picture of where you landed, and they will reach out from there.';
const THOMAS_DRAFT = `${KEPT}\n\nIf anything about the numbers or the warranty terms is still unclear, what is the part you would want walked through again.`;

test('Thomas: a first firm decline is decline_first', () => {
  assert.equal(planPostDemoEmail({ trigger: THOMAS_IN }), 'decline_first');
  assert.equal(planPostDemoEmail({ trigger: THOMAS_IN, lastPlanStep: 'post_demo' }), 'decline_first');
  assert.equal(planStepFor('decline_first'), DECLINE_FIRST_STEP);
});

test('Thomas replay: the finished reply is the draft minus its last line', () => {
  const r = enforcePostDemoEmail(THOMAS_DRAFT, 'decline_first');
  assert.equal(r.text, KEPT);
  assert.equal(r.dropped, 1);
  assert.match(r.text, /follow-up team/);
  assert.match(r.text, /good for a full year/);
  assert.match(r.text, /what you can prove/, 'the reframe stays on the first reply');
  assert.ok(!r.text.includes('?'));
  assert.ok(checkReply(r.text, { channel: 'email', postDemoEmailStep: 'decline_first' }).pass);
  // The draft as it went out fails the new check.
  const before = checkReply(THOMAS_DRAFT, { channel: 'email', postDemoEmailStep: 'decline_first' });
  assert.ok(before.violations.some(v => v.code === 'question_after_post_demo_decline_email'));
});

test('no question survives anywhere, a "?" one or a period one', () => {
  const d = 'Thanks, Dana. Would a quick look at the numbers help? Your proposal is good for a year.\n\nIs there anything we missed. Our follow-up team has your notes.';
  const r = enforcePostDemoEmail(d, 'decline_first');
  assert.equal(r.text, 'Thanks, Dana. Your proposal is good for a year.\n\nOur follow-up team has your notes.');
  assert.ok(!sentenceAsks(r.text));
});

test('never an empty body: an all-question draft loses only its last sentence', () => {
  const d = 'Would it help to talk it over? What would make it work for you?';
  const r = enforcePostDemoEmail(d, 'decline_first');
  assert.equal(r.text, 'Would it help to talk it over?');
  assert.ok(r.text.trim());
});

test('a URL is not a sentence break', () => {
  const d = 'Your proposal is at https://getreecewindows.com/p?id=1 any time. What part would you revisit?';
  assert.equal(enforcePostDemoEmail(d, 'decline_first').text, 'Your proposal is at https://getreecewindows.com/p?id=1 any time.');
});

test('a second decline after our decline reply is decline_close', () => {
  assert.equal(planPostDemoEmail({ trigger: 'Again, we will not be moving forward.', lastPlanStep: DECLINE_FIRST_STEP }), 'decline_close');
  assert.equal(planPostDemoEmail({ trigger: 'No thank you.', lastPlanStep: DECLINE_FIRST_STEP }), 'decline_close');
  assert.equal(planPostDemoEmail({ trigger: 'Not interested.', lastPlanStep: DECLINE_CLOSE_STEP }), 'decline_close');
  assert.equal(planStepFor('decline_close'), DECLINE_CLOSE_STEP);
});

test('second decline: no question and no reframe in the finished reply', () => {
  const d = 'Thank you, Thomas, we understand. Cheaper bids usually cut corners somewhere. Protection is what you can prove. Your proposal stays good for a full year. Would you like us to check back in the spring?';
  const r = enforcePostDemoEmail(d, 'decline_close', { firstName: 'Thomas' });
  assert.equal(r.text, 'Thank you, Thomas, we understand. Your proposal stays good for a full year.');
  assert.ok(checkReply(r.text, { channel: 'email', postDemoEmailStep: 'decline_close' }).pass);
  assert.ok(!checkReply(d, { channel: 'email', postDemoEmailStep: 'decline_close' }).pass);
});

test('second decline: an emptied draft becomes the warm close line', () => {
  const r = enforcePostDemoEmail('What changed? Protection is what you can prove.', 'decline_close', { firstName: 'Thomas' });
  assert.equal(r.text, declineCloseLine('Thomas'));
  assert.ok(!r.text.includes('?'));
  assert.ok(!/[—–]/.test(r.text));
});

test('a deferral, a purchase elsewhere and a question are not a decline turn', () => {
  assert.equal(planPostDemoEmail({ trigger: "We won't be investing until spring." }), 'defer');
  assert.equal(planPostDemoEmail({ trigger: 'We signed with another company last week.' }), 'signed_elsewhere');
  assert.equal(planPostDemoEmail({ trigger: "We won't be moving forward, but can you send the warranty?" }), null);
  assert.equal(planPostDemoEmail({ trigger: 'Thanks for the proposal, we are reviewing it.' }), null);
  assert.equal(enforcePostDemoEmail(THOMAS_DRAFT, 'defer').text, THOMAS_DRAFT);
  assert.equal(enforcePostDemoEmail(THOMAS_DRAFT, null).changed, false);
});

test('a sign-off after our decline reply closes; before it, it is not a decline', () => {
  assert.equal(planPostDemoEmail({ trigger: 'Will do. Thanks!' }), null);
  assert.equal(planPostDemoEmail({ trigger: 'Will do. Thanks!', lastPlanStep: DECLINE_FIRST_STEP }), 'decline_close');
});

test('EMAIL_POST_DEMO_MODE: unset is live, off is the rollback, a typo is shadow', () => {
  assert.equal(emailPostDemoMode({}), 'live');
  assert.equal(emailPostDemoMode({ EMAIL_POST_DEMO_MODE: 'off' }), 'off');
  assert.equal(emailPostDemoMode({ EMAIL_POST_DEMO_MODE: 'SHADOW' }), 'shadow');
  assert.equal(emailPostDemoMode({ EMAIL_POST_DEMO_MODE: 'lvie' }), 'shadow');
});

test('the second-decline plan line says thanks, door open, no reframe, no question', () => {
  const block = P.postDemoEmailCloseBlock('Thomas').join('\n');
  assert.match(block, /SECOND DECLINE/);
  assert.match(block, /no reframe or rebuttal/);
  assert.match(block, /good for a year/);
  assert.match(block, /No question/);
  assert.ok(!/[—–]/.test(block.replace(/═/g, '')));
});

test('the response prompt: decline turns never also get the "what changed?" ask', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/response-generator.js', import.meta.url), 'utf8');
  assert.match(src, /opts\.postDemoEmailDecline \? null : notInterestedTurn\(/);
  assert.match(src, /opts\.postDemoEmailDecline === 'decline_close'\) parts\.push\(\.\.\.P\.postDemoEmailCloseBlock/);
  assert.match(src, /\[PostDemoEmail\] \$\{contactId\} \$\{postDemoEmailDecline\} dropped=/);
});
