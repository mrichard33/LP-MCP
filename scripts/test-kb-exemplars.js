/**
 * scripts/test-kb-exemplars.js — Past-win exemplars core (kb-retriever v1.11)
 *
 * Exercises src/knowledge/exemplars-core.js with no env and no network:
 *   1. mode parsing; 2. intent policy; 3. reply/inbound filters incl. internal
 *   notifications and merge tags; 4. PII scrub; 5. templated-reply filter;
 *   6. outcome labeling (rank, window, cancelled ignored, pending vs none);
 *   7. prompt formatter budget + header.
 *
 * Run: node --test scripts/test-kb-exemplars.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getKbExemplarMode,
  shouldRunExemplars,
  isUsableReply,
  isUsableInbound,
  scrubPii,
  dropTemplatedReplies,
  labelOutcome,
  formatExemplarsForPrompt,
  normalizeBody,
  htmlToText,
  scrubNames,
  scrubSchedule,
  prepareExemplar,
  EXEMPLAR_CLEAN_VERSION,
} from '../src/knowledge/exemplars-core.js';
import { runWithSimOverrides, simKbExemplarMode } from '../src/simulator/sim-overrides.js';
import { parseSimRequest } from '../src/tools/simulator-tools.js';

test('mode defaults to off and rejects unknown values', () => {
  assert.equal(getKbExemplarMode({}), 'off');
  assert.equal(getKbExemplarMode({ KB_EXEMPLAR_MODE: 'yes' }), 'off');
  assert.equal(getKbExemplarMode({ KB_EXEMPLAR_MODE: ' Shadow ' }), 'shadow');
  assert.equal(getKbExemplarMode({ KB_EXEMPLAR_MODE: 'live' }), 'live');
});

test('runs on conversational intents, never on compliance/identity gates or empty text', () => {
  for (const i of ['QUESTION', 'OBJECTION', 'PRICING', 'UNCLEAR', 'BOOK', 'NOT_INTERESTED', 'RECONNECT', 'CALLBACK']) {
    assert.equal(shouldRunExemplars(i, 'hi there'), true, i);
  }
  for (const i of ['STOP', 'ANGRY', 'WRONG_NUMBER', 'MOVED', 'WHO_IS_THIS', 'SERVICE_AREA_INQUIRY', undefined]) {
    assert.equal(shouldRunExemplars(i, 'hi there'), false, String(i));
  }
  assert.equal(shouldRunExemplars('QUESTION', '   '), false);
});

test('reply filter drops internal notifications, merge tags, and out-of-range lengths', () => {
  assert.equal(isUsableReply('Happy to help — would Tuesday at 2 or Wednesday at 10 work better?'), true);
  assert.equal(isUsableReply('❌ APPT CANCELLED — Dave Presutti (860) 316-8833 Prospect 456551 | GHL'), false);
  assert.equal(isUsableReply('Here is your link {{trigger_link.abc}} to book'), false);
  assert.equal(isUsableReply('ok'), false);
  assert.equal(isUsableReply('x'.repeat(901)), false);
  assert.equal(isUsableInbound('yes'), false);
  assert.equal(isUsableInbound('will these hold up in a cat 4?'), true);
});

test('scrubPii replaces emails, phones, street addresses, and links', () => {
  const s = scrubPii('Call me at (860) 316-8833 or bob@example.com, 5814 Hawkwood Ct, see https://x.y/z');
  assert.ok(!s.includes('316-8833') && s.includes('[phone]'));
  assert.ok(!s.includes('bob@') && s.includes('[email]'));
  assert.ok(!s.includes('Hawkwood') && s.includes('[address]'));
  assert.ok(!s.includes('https://') && s.includes('[link]'));
  assert.equal(scrubPii('Tuesday at 2 works, 18 windows'), 'Tuesday at 2 works, 18 windows');
});

test('templated replies seen across >3 contacts are dropped; genuine replies stay', () => {
  const drip = 'Just checking in — are you still interested in impact windows?';
  const pairs = [
    ...['a', 'b', 'c', 'd'].map((c) => ({ ghl_contact_id: c, reply_text: drip })),
    { ghl_contact_id: 'e', reply_text: 'Totally fair — a lot of folks compare a few quotes. Want me to send what to look for?' },
    { ghl_contact_id: 'f', reply_text: drip.toUpperCase() },
  ];
  const kept = dropTemplatedReplies(pairs, 3);
  assert.deepEqual(kept.map((p) => p.ghl_contact_id), ['e']);
  assert.equal(normalizeBody('  A  b\n c '), 'a b c');
});

test('labelOutcome ranks showed > confirmed > booked, ignores cancelled/noshow and out-of-window', () => {
  const inbound = '2026-08-01T12:00:00Z';
  const now = new Date('2026-09-01T00:00:00Z');
  assert.deepEqual(labelOutcome([
    { status: 'new', date_added: '2026-08-02T00:00:00Z' },
    { status: 'showed', date_added: '2026-08-03T00:00:00Z' },
    { status: 'cancelled', date_added: '2026-08-04T00:00:00Z' },
  ], inbound, now).outcome, 'showed');
  assert.equal(labelOutcome([{ status: 'confirmed', date_added: '2026-08-05T00:00:00Z' }], inbound, now).outcome, 'confirmed');
  assert.equal(labelOutcome([{ status: 'cancelled', date_added: '2026-08-02T00:00:00Z' }], inbound, now).outcome, 'none');
  assert.equal(labelOutcome([{ status: 'showed', date_added: '2026-07-30T00:00:00Z' }], inbound, now).outcome, 'none', 'added before inbound');
  assert.equal(labelOutcome([{ status: 'showed', date_added: '2026-08-20T00:00:00Z' }], inbound, now).outcome, 'none', 'outside 14-day window');
  assert.equal(labelOutcome([], inbound, new Date('2026-08-05T00:00:00Z')).outcome, 'pending');
  assert.equal(labelOutcome([], inbound, now).outcome, 'none');
});

test('formatExemplarsForPrompt respects count and character budget and carries the no-copy header', () => {
  const rows = [
    { channel: 'sms', outcome: 'showed', similarity: 0.71, inbound_text: 'my husband handles this', reply_text: 'Makes sense — most couples decide together. Would it help if I sent a short summary you can both look at?' },
    { channel: 'sms', outcome: 'booked', similarity: 0.66, inbound_text: 'talk to my wife first', reply_text: 'Of course, take the time you two need.' },
    { channel: 'sms', outcome: 'booked', similarity: 0.60, inbound_text: 'x', reply_text: 'y' },
  ];
  const out = formatExemplarsForPrompt(rows, { max: 2 });
  assert.ok(out.startsWith('PAST WINS'));
  assert.ok(out.includes('NOT the wording'));
  assert.ok(out.includes('1. [sms | outcome: showed'));
  assert.ok(out.includes('2. [sms | outcome: booked'));
  assert.ok(!out.includes('3. ['));
  assert.equal(formatExemplarsForPrompt([]), '');
  assert.equal(formatExemplarsForPrompt(rows, { maxChars: 10 }), '');
});

// ── v1.1 (2026-10-12): the corpus is cleaned before a model sees it ──────
// Shapes below are the real ones served in shadow (names changed where a
// real lead's name would otherwise sit in the repo).

const GHL_HTML = '<p style="margin:0px; padding-left: 0px!important;"><span data-cv-variable="inboundWebhookRequest.message" data-cv-token="true">Single pane in aluminum is drafty &amp; inefficient. What&#39;s bugging you most about them right now?</span></p>';

test('htmlToText unwraps the GHL live-chat wrapper and decodes entities; plain text is unchanged', () => {
  assert.equal(htmlToText(GHL_HTML), "Single pane in aluminum is drafty & inefficient. What's bugging you most about them right now?");
  assert.equal(htmlToText('Tuesday at 2 works <3'), 'Tuesday at 2 works <3');
  assert.equal(htmlToText('line one<br/>line two'), 'line one line two');
});

test('scrubSchedule replaces another lead\'s day and time, never the approach', () => {
  assert.equal(scrubSchedule('I have Fri, Oct 9 at 6:00 PM ET or Fri, Oct 9 at 7:30 PM ET. Which is better for you?'),
    'I have [day] at [time] or [day] at [time]. Which is better for you?');
  assert.equal(scrubSchedule('See you Thursday the 17th at 6 PM.'), 'See you [day] at [time].');
  assert.equal(scrubSchedule('How about Friday Aug 14 at 10 AM or 2 PM?'), 'How about [day] at [time] or [time]?');
  assert.equal(scrubSchedule('I can call at 10:30 AM tomorrow.'), 'I can call at [time] [day].');
  assert.equal(scrubSchedule('Does Tuesday at 2 work?'), 'Does [day] at [time] work?');
  assert.equal(scrubSchedule('Visit set for 9/22.'), 'Visit set for [day].');
  // No time in the sentence: a relative day stays ("What made you reach out today?").
  assert.equal(scrubSchedule('What made you reach out today?'), 'What made you reach out today?');
  // Words that only look like days stay.
  assert.equal(scrubSchedule('Do sun shades help with 12 windows?'), 'Do sun shades help with 12 windows?');
  assert.equal(scrubSchedule('We install on Wed and Sat. Usually Wednesdays.'), 'We install on [day] and [day]. Usually [day].');
});

test('scrubNames removes the contact\'s own name and a name after an opener, never an ordinary word', () => {
  assert.equal(scrubNames('Evenings work, Mocica. Thanks Mocica Smith!', ['Mocica', 'Smith']), 'Evenings work, [name]. Thanks [name] [name]!');
  assert.equal(scrubNames('Anytime, Gina. Hey Myron, quick one.'), 'Anytime, [name]. Hey [name], quick one.');
  assert.equal(scrubNames('Sounds good, thanks. Thanks, everyone!'), 'Sounds good, thanks. Thanks, everyone!');
  assert.equal(scrubNames('Got it, that works.'), 'Got it, that works.');
  assert.equal(scrubNames("Scott, that time isn't open."), "[name], that time isn't open.");
  assert.equal(scrubNames('Absolutely, we can help.'), 'Absolutely, we can help.');
});

test('a street named without its number is scrubbed too', () => {
  assert.equal(prepareExemplar({ channel: 'sms', inbound_text: 'sure', reply_text: 'We have Tuesday at 10 AM open for the in-home estimate at Crown Bridge Drive. Does that work?' }).reply_text,
    'We have [day] at [time] open for the in-home estimate at [address]. Does that work?');
});

test('prepareExemplar: HTML, names, days and times out; a promised call loses "right now"; em dash gone', () => {
  const html = prepareExemplar({ channel: 'livechat', inbound_text: 'tired of what I have', reply_text: GHL_HTML });
  assert.equal(html.excluded_reason, null);
  assert.ok(!html.reply_text.includes('<'));

  // 2026-10-09 (Monica): the exact reply that promised a rehash lead a call "right now".
  const now = prepareExemplar({ channel: 'sms', inbound_text: 'no one was on the other end', reply_text: "Sorry about that, Monica. We're having someone call you back right now. — Reece Team" });
  assert.equal(now.excluded_reason, null);
  assert.equal(now.reply_text, "Sorry about that, [name]. We're having someone call you back soon. — Reece Team");

  const dash = prepareExemplar({ channel: 'sms', inbound_text: 'Friday will not work', reply_text: 'No problem — how about Friday Aug 14 at 10 AM or 2 PM? Both work for the visit.' });
  assert.equal(dash.excluded_reason, null);
  assert.ok(!dash.reply_text.includes('—'), dash.reply_text);
  assert.ok(dash.reply_text.includes('[day] at [time] or [time]?'), dash.reply_text);
});

test('prepareExemplar excludes what is not a reply or breaks a hard check', () => {
  const drip = prepareExemplar({ channel: 'livechat', inbound_text: 'Contact Information: Name: X', reply_text: "Hey Myron, quick question, do you know what rating your windows have?\nReply STOP to unsubscribe at any time.\nThanks, Reece Windows & Doors" });
  assert.equal(drip.excluded_reason, 'workflow_message');
  const money = prepareExemplar({ channel: 'sms', inbound_text: 'how much per window', reply_text: 'It runs about $900 per window installed. Want to book a visit?' });
  assert.equal(money.excluded_reason, 'reply_check:money_figure');
  const short = prepareExemplar({ channel: 'sms', inbound_text: 'ok then', reply_text: '<p>Got it.</p>' });
  assert.equal(short.excluded_reason, 'too_short');
  const long = prepareExemplar({ channel: 'sms', inbound_text: 'tell me more', reply_text: 'We install impact windows. '.repeat(14) });
  assert.equal(long.excluded_reason, 'reply_check:sms_too_long');
});

test('prepareExemplar keeps our own placeholders and is idempotent', () => {
  const row = { channel: 'sms', inbound_text: 'my email is [email]', reply_text: 'Got it, that confirmation will go to [email]. Does Tuesday at 2 still work for the visit?' };
  const once = prepareExemplar(row);
  assert.equal(once.excluded_reason, null, 'a [placeholder] is not a merge-tag slip');
  const twice = prepareExemplar({ channel: 'sms', ...once });
  assert.deepEqual(twice, once);
  assert.equal(typeof EXEMPLAR_CLEAN_VERSION, 'number');
});

test('formatExemplarsForPrompt cleans on the way out, skips excluded rows and explains the brackets', () => {
  const out = formatExemplarsForPrompt([
    { channel: 'livechat', outcome: 'booked', similarity: 0.7, inbound_text: 'tired of them', reply_text: GHL_HTML },
    { channel: 'sms', outcome: 'booked', similarity: 0.6, inbound_text: 'hi', reply_text: 'Thanks for reaching out! Reply STOP to unsubscribe.' },
  ]);
  assert.ok(out.includes('never write a bracket'));
  assert.ok(!/<[a-z/]/i.test(out.split('\n').slice(1).join('\n')), out);
  assert.ok(out.includes('1. [livechat'));
  assert.ok(!out.includes('2. ['), 'the drip is skipped');
});

test('the simulator override is empty outside a run and set only inside one', async () => {
  assert.equal(simKbExemplarMode(), null);
  const inside = await runWithSimOverrides({ kbExemplarMode: 'live' }, async () => { await Promise.resolve(); return simKbExemplarMode(); });
  assert.equal(inside, 'live');
  assert.equal(simKbExemplarMode(), null);
  assert.equal(await runWithSimOverrides({ kbExemplarMode: 'bogus' }, async () => simKbExemplarMode()), null);
});

test('parseSimRequest accepts kb_exemplar_mode off|shadow|live and rejects anything else', () => {
  assert.equal(parseSimRequest({ scenario: 'all', kb_exemplar_mode: 'live' }).kbExemplarMode, 'live');
  assert.equal(parseSimRequest({ scenario: 'all' }).kbExemplarMode, null);
  assert.throws(() => parseSimRequest({ scenario: 'all', kb_exemplar_mode: 'on' }), /kb_exemplar_mode/);
});
