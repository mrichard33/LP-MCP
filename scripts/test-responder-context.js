/**
 * test-responder-context.js — agentic responder context integrity
 * (2026-07-29, Kelly Callahan incident: qaYQSOFMN0CA0wbQjMEY, agent_actions
 * 253236, rule AGENTIC_RESPOND_POST_CHATBOT).
 *
 * Kelly replied to an F.0 post-appointment email four days after sitting a
 * completed 90-minute demo. She got back a pre-appointment booking push that
 * opened "{{custom_values.rep_name}} here — Mark asked me to reach out",
 * offered to "get your verification visit back on the calendar" for a visit
 * nobody had scheduled, and ended "is at the link below" with no link below.
 *
 * Four independent defects, locked down here:
 *   D1  the handoff bridge named the same person on both sides, and wrote the
 *       reply-sender slot as a raw merge tag
 *   D2  the generator re-read live contact state at send time, 32.6s after a
 *       sibling rule had overwritten the funnel stage
 *   D5  a dangling "at the link below" with nothing below it
 *   B5  identity extraction scraped a phone number out of an unsubscribe URL's
 *       time_stamp, and the quoted thread fed our own sign-off back to us
 *
 * Pure functions only — no network, no mocks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const {
  formatRepFirstName,
  resolveReplySenderName,
  derivePostAppointment,
  detectContextDrift,
  findUnresolvedTokens,
  stripDanglingLinkReferences,
  findTimelinePromises,
} = await import('../src/response-generator.js');

const { stripQuotedEmail, scrubUrlsForExtraction, htmlEmailToText } =
  await import('../src/email-thread.js');

const { heuristicExtract } = await import('../src/services/identity-extraction.js');

// ── D1: rep name resolution ──────────────────────────────────────────

test('LP "Last, First" format resolves to the first name', () => {
  assert.equal(formatRepFirstName('Dorsett, Beverly'), 'Beverly');
});

test('"First Last" format resolves to the first name', () => {
  assert.equal(formatRepFirstName('Beverly Dorsett'), 'Beverly');
});

test('placeholder rep values never become a name', () => {
  for (const junk of ['', '  ', 'N/A', '-', '.', '{{custom_values.rep_name}}', null, undefined]) {
    assert.equal(formatRepFirstName(junk), null, `expected null for ${JSON.stringify(junk)}`);
  }
});

test('resolver prefers Rep Display Name, then LP Rep Name, then lp.rep_name', () => {
  assert.equal(resolveReplySenderName({
    lead: { rep_display_name: 'Bev', lp_rep_name: 'Dorsett, Beverly' },
    lp: { rep_name: 'Somebody Else' },
  }), 'Bev');

  assert.equal(resolveReplySenderName({
    lead: { lp_rep_name: 'Dorsett, Beverly' },
    lp: { rep_name: 'Somebody Else' },
  }), 'Beverly');

  assert.equal(resolveReplySenderName({
    lead: {},
    lp: { rep_name: 'Dorsett, Beverly' },
  }), 'Beverly');
});

test('no rep on record → null (company voice), never the location global', () => {
  assert.equal(resolveReplySenderName({ lead: {}, lp: {} }), null);
  assert.equal(resolveReplySenderName({}), null);
});

// ── D1: unresolved merge tokens ──────────────────────────────────────

test('the exact Kelly body is rejected for its unresolved merge tag', () => {
  const sent = '{{custom_values.rep_name}} here — Mark asked me to reach out personally after seeing your message.';
  assert.deepEqual(findUnresolvedTokens(sent), ['{{custom_values.rep_name}}']);
});

test('booking trigger-link merge tags are allowlisted, not flagged', () => {
  const body = 'Grab a time that works: {{trigger_link.abc123}}';
  assert.deepEqual(findUnresolvedTokens(body), []);
});

test('a clean body has no unresolved tokens', () => {
  assert.deepEqual(findUnresolvedTokens('Beverly here — thanks for getting back to me.'), []);
});

test('a trigger-link-shaped tag with a bad name is still flagged', () => {
  assert.deepEqual(findUnresolvedTokens('{{trigger_link}}'), ['{{trigger_link}}']);
});

// ── D2: snapshot wins over race-corrupted live state ─────────────────

// The live tags are what the generator actually saw at 14:17:17 — after
// BEHAVIORAL_FAST_TRACK's set_stage landed at 14:16:45.
const kellyLive = {
  lead: {
    current_stage_tag: 'stage:booking-main',
    current_tags: ['stage:booking-main', 'booking:active', 'fast-track:ai-detected', 'lp-demo-completed'],
  },
  lp: { demo_completed: true, disposition_code: 'OPPFDN' },
};

// The context_snapshot the DB trigger wrote at 14:16:27, when the action was queued.
const kellySnapshot = { current_stage_tag: 'stage:post-appointment', buyer_stage: 4 };

test('drift is detected when a sibling rule rewrites the stage mid-flight', () => {
  assert.deepEqual(detectContextDrift(kellyLive, kellySnapshot), {
    snapshot_stage: 'stage:post-appointment',
    live_stage: 'stage:booking-main',
  });
});

test('no drift reported when live and snapshot agree', () => {
  assert.equal(detectContextDrift(kellyLive, { current_stage_tag: 'stage:booking-main' }), null);
});

test('no drift reported when there is no snapshot to compare', () => {
  assert.equal(detectContextDrift(kellyLive, null), null);
});

test('Kelly is post-appointment despite the live stage:booking-main tag', () => {
  const verdict = derivePostAppointment(kellyLive, kellySnapshot);
  assert.equal(verdict.post, true);
  assert.ok(verdict.reasons.includes('snapshot:stage:post-appointment'));
  assert.ok(verdict.reasons.includes('lp.demo_completed'));
});

test('post-appointment holds on LP ground truth alone, with no snapshot', () => {
  // The defense that survives a snapshot-less action: LP fields and the
  // demo tag are not writable by the rules in this fan-out.
  const verdict = derivePostAppointment(kellyLive, null);
  assert.equal(verdict.post, true);
  assert.ok(verdict.reasons.includes('lp.disposition:OPPFDN'));
});

test('a genuine pre-appointment contact is NOT flagged post-appointment', () => {
  const verdict = derivePostAppointment({
    lead: { current_stage_tag: 'stage:booking-main', current_tags: ['stage:booking-main'] },
    lp: { demo_completed: false, disposition_code: 'NIS' },
  }, { current_stage_tag: 'stage:booking-main' });
  assert.equal(verdict.post, false);
  assert.deepEqual(verdict.reasons, []);
});

test('an empty context does not fabricate a post-appointment verdict', () => {
  assert.equal(derivePostAppointment({}, null).post, false);
});

// ── D5: dangling link references ─────────────────────────────────────

test('"at the link below" is stripped when no link is present', () => {
  const out = stripDanglingLinkReferences('You can grab a time that works is at the link below.');
  assert.ok(!/link below/i.test(out), `still references a link: ${out}`);
});

test('"at the link below" is KEPT when a real booking merge tag is present', () => {
  const body = 'Grab a time at the link below. {{trigger_link.abc123}}';
  assert.equal(stripDanglingLinkReferences(body), body);
});

test('"at the link below" is KEPT when a real URL is present', () => {
  const body = 'Details at the link below: https://reecewindows.com/estimate';
  assert.equal(stripDanglingLinkReferences(body), body);
});

test('link-reference stripping is repeatable (no leaky regex state)', () => {
  const body = 'Pick a slot at the link below.';
  const first = stripDanglingLinkReferences(body);
  assert.equal(stripDanglingLinkReferences(body), first);
  assert.equal(stripDanglingLinkReferences(body), first);
});

// ── Acknowledgment-only conduct: no timeline promises ────────────────

test('the exact promise made to Kelly is caught', () => {
  // "...so your estimate gets to you today" — a deadline the system cannot keep.
  const hits = findTimelinePromises('I am flagging this to her and her manager right now so your estimate gets to you today.');
  assert.ok(hits.length > 0, 'the "to you today" promise was not caught');
});

test('every banned timeline phrasing is caught', () => {
  const banned = [
    'She will call you today.',
    'Someone will reach out tomorrow.',
    'We will be in touch this afternoon.',
    'You will hear back within the hour.',
    'Expect a call within 2 business days.',
    'She will follow up right away.',
    'Someone will get to this shortly.',
    'You will have it by end of day.',
    'A rep will call in the next 3 hours.',
  ];
  for (const body of banned) {
    assert.ok(findTimelinePromises(body).length > 0, `not caught: "${body}"`);
  }
});

test('a compliant acknowledgment passes clean', () => {
  const ok = 'Got it, Kelly — you have been waiting on that estimate and that is on us. Beverly owns this and I have flagged it to her and her manager.';
  assert.deepEqual(findTimelinePromises(ok), []);
});

test('acknowledgment copy is not falsely flagged for ordinary words', () => {
  for (const body of [
    'Thanks for getting back to me.',
    'Beverly has your file and I have passed this along.',
    'I hear you — a person is picking this up.',
  ]) {
    assert.deepEqual(findTimelinePromises(body), [], `false positive on: "${body}"`);
  }
});

// ── B5: quoted thread + URL scrubbing ────────────────────────────────

// Kelly's inbound as it reached the pipeline: 17 words of her own, then the
// quoted F.0 email with its Mark sign-off and the GHL unsubscribe footer whose
// time_stamp supplied the phantom phone number.
const KELLY_INBOUND = [
  "I have not received an estimate. I'm interested in the product, but still have not heard from Beverly.",
  '',
  'On Mon, Jul 27, 2026 at 9:02 AM Reece Windows & Doors <mark@reecewindows.com> wrote:',
  '',
  '> Just following up on your estimate.',
  '> Mark',
  '> Reece Windows & Doors',
  '> https://link.msgsndr.com/unsubscribe?c=abc&time_stamp=1785346485266',
].join('\n');

test('the quoted thread is cut, leaving only the customer words', () => {
  const stripped = stripQuotedEmail(KELLY_INBOUND);
  assert.ok(stripped.startsWith('I have not received an estimate'));
  assert.ok(!/wrote:/i.test(stripped), 'quoted-thread header survived');
  assert.ok(!/Mark/i.test(stripped), 'our own sign-off survived — this seeds the bridge bug');
  assert.ok(!/time_stamp/i.test(stripped), 'unsubscribe footer survived');
});

test('no phone is extracted from the unsubscribe URL timestamp', () => {
  // The regression: PHONE_RE matched the last ten digits of
  // time_stamp=1785346485266 and recorded a "phone" of +15346485266.
  const id = heuristicExtract([{ direction: 'inbound', text: KELLY_INBOUND }]);
  assert.equal(id.phone, null, `extracted a phantom phone: ${id.phone}`);
});

test('a phone the customer actually types is still extracted', () => {
  const id = heuristicExtract([{ direction: 'inbound', text: 'Sure, call me at (561) 555-0143.' }]);
  assert.equal(id.phone, '+15615550143');
});

test('URL scrubbing removes links but leaves surrounding words intact', () => {
  const out = scrubUrlsForExtraction('See https://x.com/a/1785346485266 for details');
  assert.ok(!/https?:/.test(out));
  assert.ok(/See/.test(out) && /for details/.test(out));
});

test('an unsubscribe link cuts the footer even without a quote marker', () => {
  const body = 'Thanks!\n\nhttps://link.msgsndr.com/unsubscribe?c=abc&time_stamp=1785346485266';
  assert.equal(stripQuotedEmail(body), 'Thanks!');
});

test('a customer typing "unsubscribe" survives — DNC detection must still see it', () => {
  // behavioral-emitter runs isDNCSignal() on the STRIPPED text. Cutting on the
  // bare word would silently swallow a legally-required opt-out.
  const body = 'Please unsubscribe me from these emails.';
  assert.equal(stripQuotedEmail(body), body);
});

test('HTML email bodies are normalized so the quote markers can fire', () => {
  const html = '<div>Hi there</div><br><div>On Mon, Jul 27, 2026 at 9:02 AM someone wrote:</div><br><div>quoted</div>';
  const stripped = stripQuotedEmail(html);
  assert.ok(stripped.includes('Hi there'));
  assert.ok(!/quoted/.test(stripped));
  assert.ok(!/<div>/.test(stripped));
});

test('plain-text bodies pass through htmlEmailToText untouched', () => {
  const plain = 'Just a normal reply.\n\nThanks';
  assert.equal(htmlEmailToText(plain), plain);
});
