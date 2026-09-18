/**
 * test-randy-bridge.js — a reply on a Randy thread never opens cold.
 *
 * 2026-09-18, Catherine Crosier (ghl WMDdZiYWnEM4AFta5Gg3). She replied to a
 * broadcast signed by Randy; generation failed and agent_actions 475065 sent
 * the neutral fallback copy, which opens "Thanks for reaching out". From her
 * side a stranger answered an email she sent to Randy, said nothing about why,
 * and did not engage with a word she wrote.
 *
 * Two defences, tested here:
 *   - the AI path is CHECKED, not merely instructed (findMissingRandyBridge);
 *   - the fallback path has a bridge variant, so even with no model the reply
 *     explains itself.
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { findMissingRandyBridge } = await import('../src/response-generator.js');
const { buildAiFallback } = await import('../src/ai-fallback.js');

const R = { bridgeName: 'Randy' };

// ─── the AI-path guard ───────────────────────────────────────────────────

test('a bridge that names the lead\'s point passes', () => {
  for (const msg of [
    "Mark here — Randy asked me to reach out because you mentioned your husband needs to be there too. Happy to find a time that works for both of you.",
    "Mark here — Randy asked me to reach out since you said the timing was the problem. Let's work around it.",
    "Mark here — Randy asked me to get in touch about your question on the install window.",
    "Mark here. Randy asked me to follow up because you raised a concern about the estimate.",
  ]) {
    assert.deepEqual(findMissingRandyBridge(msg, R), [], msg.slice(0, 45));
  }
});

test('the incident copy fails — it never names Randy', () => {
  // The literal body sent to Catherine Crosier, from execution_result.sent_body.
  const sent = 'Thanks for reaching out — we want to make sure we get back to you properly. '
    + 'Expect a follow-up from our team shortly, or reply here anytime.\n\n'
    + '{{custom_values.rep_name}}\nReece Windows & Doors';
  assert.deepEqual(findMissingRandyBridge(sent, R), ['opening does not name Randy']);
});

test('naming Randy without stating the handoff fails', () => {
  const p = findMissingRandyBridge('Mark here. Randy is our founder. Anyway, about your windows — what size are they?', R);
  assert.ok(p.some(x => /does not say Randy asked/.test(x)));
});

test('the OLD generic bridge fails — "your message" is not their point', () => {
  // This was the prompt's verbatim wording before 2026-09-18. It proves an
  // email arrived; it does not prove anyone read it.
  const p = findMissingRandyBridge(
    'Mark here — Randy asked me to reach out personally after seeing your message. Let me know a good time.', R);
  assert.deepEqual(p, ['bridge does not name what the lead actually said']);
});

test('a bridge buried below the opening is not a bridge', () => {
  const buried = 'Thanks for getting in touch about your windows. We install impact glass across the state '
    + 'and our crews are factory-trained. There is a lot to cover on sizing, glass type and permitting, '
    + 'and most homeowners have questions about all three before they are ready to talk numbers with anyone. '
    + 'By the way, Randy asked me to reach out because you mentioned your husband.';
  assert.ok(findMissingRandyBridge(buried, R).length > 0);
});

test('a non-bridged thread is never checked', () => {
  for (const opts of [{}, { bridgeName: null }, { bridgeName: '' }]) {
    assert.deepEqual(findMissingRandyBridge('Any opener at all, no bridge here.', opts), []);
  }
});

test('the guard is case-insensitive on the name', () => {
  assert.deepEqual(
    findMissingRandyBridge('Mark here — RANDY asked me to reach out because you mentioned the storm shutters.', R),
    []);
});

test('an empty or missing draft fails rather than passing silently', () => {
  for (const msg of ['', null, undefined]) {
    assert.ok(findMissingRandyBridge(msg, R).length > 0, String(msg));
  }
});

// ─── the fallback variant ────────────────────────────────────────────────

const OPEN = Date.parse('2026-09-18T15:00:00Z');    // 11:00 ET, staffed
const CLOSED = Date.parse('2026-09-19T02:30:00Z');  // 22:30 ET, closed

test('the Randy fallback bridges, in the rep\'s voice, with Randy in third person', () => {
  const fb = buildAiFallback('email', null, { randyThread: true, atMs: OPEN });
  assert.match(fb.message, /^Randy passed your note along and asked me to reach out to you personally\./);
  assert.match(fb.message, /\{\{custom_values\.rep_name\}\}/);   // signed by the rep, as today
  assert.doesNotMatch(fb.message, /^Randy here/i);               // Randy never authors
  assert.equal(fb.subject, 'Following up');
});

test('the Randy fallback keeps the hours-aware follow-up line', () => {
  const open = buildAiFallback('email', null, { randyThread: true, atMs: OPEN });
  assert.match(open.message, /shortly/);

  const closed = buildAiFallback('email', null, { randyThread: true, atMs: CLOSED });
  assert.doesNotMatch(closed.message, /shortly/);
  assert.match(closed.message, /out for the day|as soon as the office is open/);
  // The bridge still leads, even after hours.
  assert.match(closed.message, /^Randy passed your note along/);
});

test('the Randy fallback exists for SMS too', () => {
  const fb = buildAiFallback('sms', null, { randyThread: true, atMs: OPEN });
  assert.match(fb.message, /^Hey \{\{contact\.first_name\}\} — Randy passed your note along/);
  assert.equal(fb.subject, null);
});

test('a non-Randy thread gets the original copy, byte-for-byte', () => {
  for (const channel of ['email', 'sms']) {
    const plain = buildAiFallback(channel, null, { atMs: OPEN });
    const explicit = buildAiFallback(channel, null, { randyThread: false, atMs: OPEN });
    assert.equal(plain.message, explicit.message, channel);
    assert.doesNotMatch(plain.message, /Randy/, channel);
  }
  assert.match(buildAiFallback('email', null, { atMs: OPEN }).message, /^Thanks for reaching out/);
});

test('the fallback bridge does not claim to know what they said', () => {
  // No model here, so it cannot paraphrase. Guessing would be worse than not
  // claiming to know — that is why this variant is generic on purpose.
  const fb = buildAiFallback('email', null, { randyThread: true, atMs: OPEN });
  assert.doesNotMatch(fb.message, /you mentioned|you said|because you/i);
});

test('the bridge name is overridable and defaults to Randy', () => {
  assert.match(buildAiFallback('email', null, { randyThread: true, bridgeName: 'Chris', atMs: OPEN }).message,
    /^Chris passed your note along/);
  assert.match(buildAiFallback('email', null, { randyThread: true, bridgeName: '', atMs: OPEN }).message,
    /^Randy passed your note along/);
});
