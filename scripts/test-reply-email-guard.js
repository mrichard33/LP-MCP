/**
 * test-reply-email-guard.js — the guard on where the bot tells a customer to
 * email things.
 *
 * REFERENCE CASE (2026-09-11): Alfredo Fontan, GHL VKMKhd8JQ4wsp3zMn8Lt,
 * conversation mivvUZnKmGScwo5FoVUR, LP lead 575210, market ORL.
 *
 *   agent_actions 447887 (19:39Z) — asked "Do you have an email to send this
 *   to you", the bot replied "you can send them to alfredo.fontan@gmail.com".
 *   That is the LEAD'S OWN address.
 *
 *   agent_actions 447988 (19:56Z) — it said the same thing again, after the
 *   lead answered "That's my email".
 *
 * Root cause: no company inbox existed anywhere in the prompts or the KB, and
 * the KNOWN CONTACT PROFILE printed a bare `Email: <lead's address>` with no
 * owner stated. Under ANSWER FIRST the model answered with the only address it
 * had. src/prompts/response-generator/context-frame.js now carries a COMPANY
 * INBOX block and an owner-labelled Email line; findBadEmailDirections is the
 * deterministic backstop, and these are its cases.
 *
 * Run: node --test scripts/test-reply-email-guard.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const { findBadEmailDirections, resolveCompanyInbox } = await import('../src/response-generator.js');

const ALFREDO = 'alfredo.fontan@gmail.com';
const INBOX = 'team@getreecewindows.com';

/** Call the guard the way generateResponse does. */
function check(body, { contactEmail = ALFREDO, allowed = [INBOX] } = {}) {
  return findBadEmailDirections(body, { contactEmail, allowed });
}

const hasOwnEmailViolation = (v) => v.includes('told customer to send to their own email');
const hasUnknownAddress = (v) => v.some(x => x.startsWith('unknown address:'));

test('default company inbox is team@getreecewindows.com', () => {
  delete process.env.REECE_CUSTOMER_INBOX;
  assert.equal(resolveCompanyInbox(), INBOX);
});

test('agent_actions 447887 — "you can send them to <their own address>" is a violation', () => {
  const v = check(
    "Happy to take a look at those. You can send them to alfredo.fontan@gmail.com and we'll go from there."
  );
  assert.ok(hasOwnEmailViolation(v), `expected own-email violation, got: ${JSON.stringify(v)}`);
});

test('agent_actions 447988 — the repeat, after the lead said "That\'s my email"', () => {
  const v = check(
    "Got it. Just send them over to alfredo.fontan@gmail.com whenever you're ready."
  );
  assert.ok(hasOwnEmailViolation(v), `expected own-email violation, got: ${JSON.stringify(v)}`);
});

test('"Please forward them to <their own address>" is a violation', () => {
  const v = check('Please forward the photos to alfredo.fontan@gmail.com.');
  assert.ok(hasOwnEmailViolation(v));
});

test('the correct reply — directing them to the company inbox — is clean', () => {
  assert.deepEqual(check('Send them to team@getreecewindows.com and we\'ll take it from there.'), []);
});

test('sentence-start imperative pointing at the company inbox stays clean', () => {
  assert.deepEqual(
    check('Absolutely. Email your measurements to team@getreecewindows.com and I\'ll flag them for the team.'),
    []
  );
});

test('US sending to THEM is not a violation — "We\'ll email the estimate to <their address>"', () => {
  assert.deepEqual(
    check("We'll email the estimate to alfredo.fontan@gmail.com as soon as it's ready."),
    []
  );
});

test('stating their address back to confirm it is not a violation', () => {
  assert.deepEqual(check('Confirming we have alfredo.fontan@gmail.com on file for you.'), []);
});

test('an address nobody at Reece reads is a violation (a)', () => {
  const v = check('Send it to info@reecewindows.com and someone will pick it up.');
  assert.ok(hasUnknownAddress(v), `expected unknown-address violation, got: ${JSON.stringify(v)}`);
  assert.ok(v.some(x => x.includes('info@reecewindows.com')));
});

test('an invented address is flagged even when we are the sender', () => {
  const v = check("We'll send it over from estimates@reece-windows.net.");
  assert.ok(hasUnknownAddress(v));
});

test('no contact email on file — (b) cannot fire, (a) still does', () => {
  assert.deepEqual(check('Send them to team@getreecewindows.com.', { contactEmail: null }), []);
  const v = check('Send them to someone@example.com.', { contactEmail: null });
  assert.ok(hasUnknownAddress(v));
});

test('a body with no address at all is clean', () => {
  assert.deepEqual(check('Happy to help — what size are the openings?'), []);
});

test('REECE_CUSTOMER_INBOX override makes the new address the allowed one', async () => {
  const prev = process.env.REECE_CUSTOMER_INBOX;
  process.env.REECE_CUSTOMER_INBOX = 'Estimates@GetReeceWindows.com';
  try {
    // Read per call, not at import: the override is live immediately.
    assert.equal(resolveCompanyInbox(), 'estimates@getreecewindows.com');
    assert.deepEqual(
      check('Send them to estimates@getreecewindows.com.', { allowed: [resolveCompanyInbox()] }),
      []
    );
    // …and the old default is no longer allowed once it is overridden.
    const v = check('Send them to team@getreecewindows.com.', { allowed: [resolveCompanyInbox()] });
    assert.ok(hasUnknownAddress(v));
  } finally {
    if (prev === undefined) delete process.env.REECE_CUSTOMER_INBOX;
    else process.env.REECE_CUSTOMER_INBOX = prev;
  }
});

test('REECE_EMAIL_ALLOWLIST additions are accepted', () => {
  assert.deepEqual(
    check('Send them to support@getreecewindows.com.', { allowed: [INBOX, 'support@getreecewindows.com'] }),
    []
  );
});

test('the safe-fallback copy carries no email address', async () => {
  const { buildAiFallback } = await import('../src/ai-fallback.js');
  for (const channel of ['email', 'sms']) {
    const { message } = buildAiFallback(channel);
    assert.deepEqual(
      findBadEmailDirections(message, { contactEmail: ALFREDO, allowed: [INBOX] }),
      [],
      `${channel} fallback should carry no address`
    );
  }
});
