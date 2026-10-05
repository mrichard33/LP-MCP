/**
 * Rep brief — src/services/rep-brief.js (2026-10-05).
 *
 * Fixture: prospect 462947 (Daniel, GHL LgCeHyniTQPfrnT4Ga7j), whose LP note
 * was 1,400 characters of repeats, "tomorrow", a "[YOUR NAME]" script and a
 * one-sided chat log. Run: node --test scripts/test-rep-brief.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRepBrief, checkRepBrief, fallbackBrief, briefFacts, formatApptDate, formatApptTime,
  formatAddress, appointmentSentence, formatThread, buildUserPrompt, replaceableNotes, repBriefMode,
  countSentences,
} from '../src/services/rep-brief.js';

const cf = (id, value) => ({ id, value });
const DANIEL = {
  id: 'LgCeHyniTQPfrnT4Ga7j',
  firstName: 'Daniel',
  address1: '3418 Westclox St',
  city: 'Immokalee',
  postalCode: '34142',
  customFields: [
    cf('dDFaBRpRn2aHVZTboUeB', 'Customer requested a quote for new windows and doors; appointment confirmed for tomorrow; property address 3418 Westclox St, Immokalee, FL 34142; contact email dandrrentals@gmail.com; customer requests the quote include a timeline.'),
    cf('jhtIXVo1LuAL6SV7sCbd', 'ASAP'),
    cf('GH1QGGOseMKmJAMqajiN', 'Uncertain'),
    cf('3vQsf4lNxL0LrDpgHY9Q', 'English'),
    cf('yU8H6nzSs0A6RaGfvARI', 'Readiness'),
    cf('zrghbp0ZLrOyTWc9x6Ai', 3),
  ],
};
// What LP received for 581084 (zip with LP's trailing spaces).
const DANIEL_BODY = {
  firstname: 'Daniel', address1: '3418 Westclox St', city: 'Immokalee', zip: '34142  ',
  adate: '2026-10-05', atime: '2:00 PM', lognumber: 'LgCeHyniTQPfrnT4Ga7j',
};
const DANIEL_THREAD = [
  ['inbound', 'need a quote for new windows and doors'],
  ['outbound', 'Happy to help with that. What kind of project is it?'],
  ['inbound', 'New addition'],
  ['outbound', 'Got it. Would you like a free in-home estimate?'],
  ['inbound', 'yes tomorrow'],
  ['inbound', 'Daniel'],
  ['inbound', '3418 westclox st. Immokalee fl 34142'],
  ['inbound', '??'],
  ['inbound', 'Nope just need quote with timeline'],
].map(([direction, text], i) => ({ direction, text, channel: 'livechat', timestamp: `2026-10-04T23:3${i}:00Z` }));

const GOOD_AI = 'Daniel wants a quote with a timeline for windows and doors on a NEW ADDITION, ASAP. Decision makers not confirmed; Daniel gave short answers and got impatient with the bot, so keep it quick.';
const fakeLLM = (...texts) => {
  const calls = [];
  const fn = async (args) => { calls.push(args); const t = texts[Math.min(calls.length - 1, texts.length - 1)]; if (t instanceof Error) throw t; return { text: t }; };
  fn.calls = calls;
  return fn;
};
const quiet = () => {};

// ── Sentence 1: code-owned appointment line ────────────────────────────────

test('dates: LP wall-clock formats → "Mon Oct 5"; junk → null', () => {
  assert.equal(formatApptDate('2026-10-05'), 'Mon Oct 5');
  assert.equal(formatApptDate('10/05/2026'), 'Mon Oct 5');
  assert.equal(formatApptDate('2026-10-05T14:00:00'), 'Mon Oct 5');
  assert.equal(formatApptDate('2026-02-30'), null);
  assert.equal(formatApptDate('tomorrow'), null);
  assert.equal(formatApptDate(''), null);
});

test('times: "2:00 PM" → "2 PM", minutes kept, 24h read, junk → null', () => {
  assert.equal(formatApptTime('2:00 PM'), '2 PM');
  assert.equal(formatApptTime('02:00 PM'), '2 PM');
  assert.equal(formatApptTime('10:30 AM'), '10:30 AM');
  assert.equal(formatApptTime('14:00'), '2 PM');
  assert.equal(formatApptTime('6 PM'), '6 PM');
  assert.equal(formatApptTime('noonish'), null);
});

test('address: trailing dot and LP zip padding dropped', () => {
  assert.equal(formatAddress({ street: '3418 westclox st.', city: 'Immokalee', zip: '34142  ' }), '3418 westclox st, Immokalee 34142');
  assert.equal(formatAddress({}), '');
});

test('appointment sentence: booked, unreadable date, none', () => {
  assert.equal(appointmentSentence({ hasAppointment: true, adate: '2026-10-05', atime: '2:00 PM', address: '3418 Westclox St, Immokalee 34142' }),
    'Mon Oct 5, 2 PM at 3418 Westclox St, Immokalee 34142.');
  assert.match(appointmentSentence({ hasAppointment: true, adate: 'soon', atime: '', address: '' }), /^Appointment set \(see LP/);
  assert.equal(appointmentSentence({ hasAppointment: false, address: '1 Main St, Tampa 33601' }),
    'NO APPOINTMENT. Call to book. 1 Main St, Tampa 33601.');
});

// ── The check ──────────────────────────────────────────────────────────────

test('check: the good Daniel draft passes', () => {
  const r = checkRepBrief(GOOD_AI);
  assert.equal(r.ok, true, r.reasons.join(','));
});

test('check: each banned pattern is caught', () => {
  const cases = {
    relative_day: 'Daniel wants windows and the visit is tomorrow.',
    date_or_time: 'Daniel wants windows; visit is at 2 PM.',
    script: 'Hi Daniel, this is [YOUR NAME] with Reece.',
    contact_detail: 'Daniel wants windows, reach at 239-250-0011.',
    address: 'Daniel wants windows at 3418 Westclox St.',
    label: 'WANTS: windows and doors for Daniel.',
    jargon: 'Daniel came in at P1 Stage 6 from the footer widget.',
    pronoun: 'Daniel wants windows and he is in a hurry.',
  };
  for (const [reason, text] of Object.entries(cases)) {
    assert.ok(checkRepBrief(text).reasons.includes(reason), `${reason}: ${checkRepBrief(text).reasons}`);
  }
  assert.ok(checkRepBrief('x'.repeat(400)).reasons.includes('too_long'));
  assert.ok(checkRepBrief('One. Two. Three.').reasons.includes('too_many_sentences'));
  assert.deepEqual(checkRepBrief('  ').reasons, ['empty']);
});

test('check: they/their is the neutral default and is allowed', () => {
  assert.equal(checkRepBrief('Daniel wants windows for their new addition.').ok, true);
});

test('countSentences counts the obvious', () => {
  assert.equal(countSentences(GOOD_AI), 2);
});

// ── Prompt ─────────────────────────────────────────────────────────────────

test('prompt: both sides of the chat, labelled, email turns dropped', () => {
  const t = formatThread([...DANIEL_THREAD, { direction: 'outbound', text: 'Your confirmation email', channel: 'email' }]);
  assert.match(t, /^Homeowner: need a quote/);
  assert.match(t, /Reece: Happy to help/);
  assert.doesNotMatch(t, /confirmation email/);
  const u = buildUserPrompt(briefFacts(DANIEL, DANIEL_BODY), DANIEL_THREAD, ['relative_day']);
  assert.match(u, /Decision makers present: Uncertain/);
  assert.match(u, /<conversation>[\s\S]*New addition[\s\S]*<\/conversation>/);
  assert.match(u, /broke these rules: relative_day/);
});

// ── The build ──────────────────────────────────────────────────────────────

test('Daniel: AI note is short, dated, and says "new addition"', async () => {
  const llm = fakeLLM(GOOD_AI);
  const out = await buildRepBrief({ contact: DANIEL, contactId: DANIEL.id, body: DANIEL_BODY },
    { callLLM: llm, readThread: async () => DANIEL_THREAD, log: quiet });
  assert.equal(out.source, 'ai');
  assert.ok(out.notes.startsWith('Mon Oct 5, 2 PM at 3418 Westclox St, Immokalee 34142.'), out.notes);
  assert.match(out.notes, /new addition/i);
  for (const bad of [/tomorrow/i, /\[YOUR NAME\]/, /P1 Stage/, /CONVERSATION:/, /OPENER:/]) assert.doesNotMatch(out.notes, bad);
  assert.ok(out.notes.length <= 450, `length ${out.notes.length}`);
  assert.equal(llm.calls[0].fn, 'rep_brief');
  assert.equal(llm.calls[0].cacheSystem, true);
});

test('a rejected draft gets one re-write, with the reasons', async () => {
  const llm = fakeLLM('Daniel has a visit tomorrow.', GOOD_AI);
  const out = await buildRepBrief({ contact: DANIEL, contactId: DANIEL.id, body: DANIEL_BODY },
    { callLLM: llm, readThread: async () => DANIEL_THREAD, log: quiet });
  assert.equal(out.source, 'ai');
  assert.equal(llm.calls.length, 2);
  assert.match(llm.calls[1].user, /relative_day/);
});

test('two bad drafts → fixed sentences', async () => {
  const llm = fakeLLM('Hi Daniel, this is [YOUR NAME].');
  const out = await buildRepBrief({ contact: DANIEL, contactId: DANIEL.id, body: DANIEL_BODY },
    { callLLM: llm, readThread: async () => DANIEL_THREAD, log: quiet });
  assert.equal(out.source, 'fallback');
  assert.equal(llm.calls.length, 2);
  assert.equal(out.notes,
    'Mon Oct 5, 2 PM at 3418 Westclox St, Immokalee 34142. Daniel is interested in a window and door estimate, timeline ASAP. Decision makers not confirmed; ask who else will be there.');
});

test('model error or timeout → fixed sentences, never a throw', async () => {
  const err = await buildRepBrief({ contact: DANIEL, contactId: DANIEL.id, body: DANIEL_BODY },
    { callLLM: fakeLLM(new Error('529 overloaded')), readThread: async () => [], log: quiet });
  assert.equal(err.source, 'fallback');
  const slow = await buildRepBrief({ contact: DANIEL, contactId: DANIEL.id, body: DANIEL_BODY },
    { callLLM: () => new Promise(() => {}), readThread: async () => [], aiTimeoutMs: 20, log: quiet });
  assert.equal(slow.source, 'fallback');
  const badThread = await buildRepBrief({ contact: DANIEL, contactId: DANIEL.id, body: DANIEL_BODY },
    { callLLM: fakeLLM(GOOD_AI), readThread: async () => { throw new Error('ghl down'); }, log: quiet });
  assert.equal(badThread.source, 'ai');
});

test('no appointment: the call-to-book line leads', async () => {
  const out = await buildRepBrief({ contact: DANIEL, contactId: DANIEL.id, body: { ...DANIEL_BODY, adate: '', atime: '' } },
    { log: quiet });
  assert.ok(out.notes.startsWith('NO APPOINTMENT. Call to book. 3418 Westclox St, Immokalee 34142.'), out.notes);
});

test('fallback: Spanish, objection, window count, solo owner', () => {
  const s = fallbackBrief({ firstName: 'Ana', product: 'Impact Windows', windowCount: '7', timeline: '1-3 months',
    language: 'Spanish', objection: 'PRICE', decisionMakers: 'Solo Owner' });
  assert.equal(s, 'Ana is interested in Impact Windows (7 windows), timeline 1-3 months. Spanish speaker. Concern: price. Sole decision maker.');
  assert.equal(fallbackBrief({}), 'The homeowner is interested in a window and door estimate.');
});

// ── Which notes may be replaced ────────────────────────────────────────────

test('replaceableNotes: AI blocks and blanks yes, a person\'s note no', () => {
  assert.equal(replaceableNotes(''), true);
  assert.equal(replaceableNotes('{{contact.contact_summary}}'), true);
  assert.equal(replaceableNotes('LEAD: Came in through the website chatbot | WANTS: x | OPENER: Hi'), true);
  assert.equal(replaceableNotes('AGENTIC LEAD: appointment attached. | SUMMARY: y'), true);
  assert.equal(replaceableNotes('Property Type: House\nWindow Count: 7\nNotes: gate code 1234'), false);
  assert.equal(replaceableNotes('Customer asked for a call after 5'), false);
});

test('mode: default shadow; live and off read; junk → shadow', () => {
  const prev = process.env.LP_REP_BRIEF_MODE;
  delete process.env.LP_REP_BRIEF_MODE; assert.equal(repBriefMode(), 'shadow');
  process.env.LP_REP_BRIEF_MODE = 'LIVE'; assert.equal(repBriefMode(), 'live');
  process.env.LP_REP_BRIEF_MODE = 'off'; assert.equal(repBriefMode(), 'off');
  process.env.LP_REP_BRIEF_MODE = 'yes'; assert.equal(repBriefMode(), 'shadow');
  if (prev === undefined) delete process.env.LP_REP_BRIEF_MODE; else process.env.LP_REP_BRIEF_MODE = prev;
});
