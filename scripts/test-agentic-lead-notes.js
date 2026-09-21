/**
 * scripts/test-agentic-lead-notes.js
 *
 * Cover for src/services/agentic-lead-notes.js.
 *
 * The fixture mirrors GHL contact L0q6ASoZKJ1hXWv1b0C3 (Cynthia De Leon), read
 * live on 2026-08-03 — real field IDs, real values, real 13-turn transcript.
 * When these assertions move, check the live contact before changing them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readField,
  isWeakNotes,
  formatTranscript,
  buildAgenticLeadNotes,
  buildAugmentedNotes,
  fetchAndBuildAgenticNotes,
  _internal,
} from '../src/services/agentic-lead-notes.js';

const { F } = _internal;

const AI_SHORT_SUMMARY =
  'Cynthia De Leon at 6925 Summer Harbor Lane, Riverview FL 33578, contact ' +
  '813-606-2674, reported 7 windows. No sliders. May consider a door depending ' +
  'on the deal. Asked whether company manufactures and installs or only installs; ' +
  'wants to ask questions before providing other information; requested details on ' +
  'guarantees/warranties, current promotions, and confirmation that ' +
  'consultation/estimate is free and no-obligation.';

const AI_SUMMARY_ALT =
  'Cynthia was trying to obtain a quote, likely for a service or product, and ' +
  'provided the address "6925 Summer Harbor Lane, Riverview, Florida 33578" as ' +
  'requested. The agent asked for the address as specific technical information ' +
  'needed to proceed. However, the conversation concluded with the agent stating ' +
  'they did not have enough information to help Cynthia.';

const TRANSCRIPT = [
  'Hi.  Are you manufacturers and installers or just installers?',
  'We are looking for window replacement',
  'They are still functioning and in good shape, but they are old (23 years) and we would like weather/impact resistant windows',
  "Cynthia De Leon is my name...but before giving you my other information, I'd like to ask a couple of questions",
  '1. What type of guarantees or warranties do you have; 2. Do you have any promotions; and 3. Is your consultation/estimate free with no obligation?',
  '813-606-2674',
  'my email is cindydeleon78782gmail.com',
  'What other information do you need',
  '6925 Summer Harbor Lane, Riverview, Florida  33578',
  '7 windows',
  'No sliders but MAYBE a door, depending on the deal.',
  'Yes',
  'ok',
].join(' / ');

// The live ChatGPT-node output on the reference contact — a HEALTHY brief.
// It carries LEAD/WANTS/OPENER/HEADS UP but no transcript, no objection code,
// no trust score, no market. This is what `augment` mode has to improve on.
const LIVE_CONTACT_SUMMARY =
  'LEAD: Chatbot lead from the website, inquired about impact windows. | ' +
  'WANTS: Interested in impact windows for 7 windows at her home in Riverview; ' +
  'no sliders, may consider adding a door if the deal makes sense. | ' +
  'OPENER: Hi Cynthia, I’m following up from your chat about impact windows ' +
  'for your seven openings and possible door options. | ' +
  'HEADS UP: Very focused on maintenance and trust; wants to confirm we both ' +
  'manufacture and install.';

/** Reference contact. Pass overrides to add/replace individual fields. */
function contactFixture(extra = {}) {
  const fields = {
    [F.AI_SUMMARY]: AI_SHORT_SUMMARY,
    [F.AI_SUMMARY_ALT]: AI_SUMMARY_ALT,
    [F.CHAT_TRANSCRIPT]: TRANSCRIPT,
    [F.PAIN_POINT]: 'Clarity',
    [F.PAIN_CATEGORY]: 'Clarity',
    [F.PAIN_DRIVER]: 'Maintenance',
    [F.EMOTIONAL_ARC]: 'Curious → Cautious → Anxious → Curious',
    [F.TRUST_SCORE]: 3,
    [F.OBJECTION]: 'APPOINTMENT_FRICTION.price_anxiety_pre_demo',
    [F.CHATBOT_EXIT]: 'agentic',
    [F.PREFERRED_CONTACT]: 'Live Chat',
    [F.LANGUAGE]: 'English',
    [F.PRODUCT_INTEREST]: 'Impact Windows',
    [F.WINDOW_COUNT]: 7,
    [F.MARKET_CODE]: 'STPET',
    [F.COUNTY]: 'Hillsborough',
    [F.SOURCE_DETAIL]: '2026_chatbot',
    [F.SOURCE_WIDGET]: 'footer_widget',
    [F.P1_STAGE]: 'P1 Stage 1',
    ...extra,
  };
  return {
    firstName: 'Cynthia',
    customFields: Object.entries(fields).map(([id, value]) => ({ id, value })),
  };
}

const countOf = (haystack, needle) => haystack.split(needle).length - 1;
const sectionOf = (notes, label) => {
  const m = new RegExp(`${label}: ([^|]*)`).exec(notes);
  return m ? m[1] : '';
};

// ── The brief a setter actually opens ────────────────────────────────────

test('reference contact produces a brief carrying the operational facts', () => {
  const out = buildAgenticLeadNotes(contactFixture(), { hasAppointment: false });
  assert.ok(out.includes(AI_SHORT_SUMMARY), 'AI Short Summary must survive');
  assert.ok(out.includes('7 windows'), 'job size must reach the setter');
  assert.ok(out.includes('Impact Windows'));
  assert.ok(out.includes('STPET'));
  assert.ok(out.includes('APPOINTMENT_FRICTION.price_anxiety_pre_demo'));
  assert.ok(out.includes('CONVERSATION:'), 'the transcript is the point of this change');
});

test('AI Short Summary wins over AI Contact Summary (alt)', () => {
  // On the reference contact the alt is the vague one — "did not have enough
  // information to help Cynthia". Preferring it was the spec bug.
  const out = buildAgenticLeadNotes(contactFixture(), {});
  assert.ok(out.includes(AI_SHORT_SUMMARY));
  assert.ok(!out.includes('did not have enough information'));

  // ...and the alt is still the fallback when the Short Summary is absent.
  const alt = buildAgenticLeadNotes(contactFixture({ [F.AI_SUMMARY]: '' }), {});
  assert.ok(alt.includes('did not have enough information'));
});

test('window count renders deterministically, not via LLM prose', () => {
  const bare = contactFixture({
    [F.AI_SUMMARY]: '',
    [F.AI_SUMMARY_ALT]: '',
    [F.CHAT_TRANSCRIPT]: '',
  });
  const out = buildAgenticLeadNotes(bare, {});
  assert.ok(out.includes('WANTS: Impact Windows — 7 windows — STPET / Hillsborough'));
});

test('REGRESSION: Last Sentiment is never included — it holds the raw last message', () => {
  const polluted = contactFixture({
    MP4kHjcOvwYvPSr2QmPi: '6925 Summer Harbor Lane, Riverview, Florida 33578',
  });
  const out = buildAgenticLeadNotes(polluted, {});
  // The address does appear inside the summary and transcript, so assert on the
  // field read itself as well as on the rendered section list.
  assert.equal(readField(polluted, 'MP4kHjcOvwYvPSr2QmPi'), null);
  const bare = contactFixture({
    [F.AI_SUMMARY]: '',
    [F.AI_SUMMARY_ALT]: '',
    [F.CHAT_TRANSCRIPT]: '',
    MP4kHjcOvwYvPSr2QmPi: '6925 Summer Harbor Lane, Riverview, Florida 33578',
  });
  assert.ok(!buildAgenticLeadNotes(bare, {}).includes('Summer Harbor'));
  void out;
});

test('duplicate pain values collapse to one on the HEADS UP line', () => {
  const out = buildAgenticLeadNotes(contactFixture(), {});
  const heads = sectionOf(out, 'HEADS UP');
  assert.ok(heads.includes('Pain Clarity / Maintenance'));
  assert.equal(countOf(heads, 'Clarity'), 1);
});

test('output is a single run of text — LP renders notes without newlines', () => {
  const out = buildAgenticLeadNotes(
    contactFixture({ [F.AI_SUMMARY]: 'line one\nline two\n\nline three' }),
    {}
  );
  assert.ok(!out.includes('\n'));
  assert.ok(out.includes('line one line two line three'));
});

test('header switches on hasAppointment', () => {
  const none = buildAgenticLeadNotes(contactFixture(), { hasAppointment: false });
  assert.ok(none.startsWith('AGENTIC LEAD: NO APPOINTMENT. Call to book.'));

  const booked = buildAgenticLeadNotes(contactFixture(), { hasAppointment: true });
  assert.ok(booked.startsWith('AGENTIC LEAD: appointment attached.'));

  // Anything other than an explicit true is treated as unbooked.
  assert.ok(buildAgenticLeadNotes(contactFixture(), {}).includes('NO APPOINTMENT'));
});

test('maxChars is a hard ceiling; the transcript is what gets dropped', () => {
  const out = buildAgenticLeadNotes(contactFixture(), { maxChars: 600 });
  assert.ok(out.length <= 600, `expected <= 600, got ${out.length}`);
  assert.ok(out.includes('SUMMARY:'), 'the summary outranks the transcript');
  assert.ok(!out.includes('CONVERSATION:'), 'no room left for a transcript');
});

test('empty contact yields the header alone and never throws', () => {
  const out = buildAgenticLeadNotes({ customFields: [] }, {});
  assert.equal(out, 'AGENTIC LEAD: NO APPOINTMENT. Call to book.');
  assert.doesNotThrow(() => buildAgenticLeadNotes(null, {}));
  assert.doesNotThrow(() => buildAgenticLeadNotes({}, {}));
});

test('Spanish speakers are flagged first on the HEADS UP line', () => {
  const out = buildAgenticLeadNotes(contactFixture({ [F.LANGUAGE]: 'Spanish' }), {});
  assert.ok(sectionOf(out, 'HEADS UP').startsWith('SPANISH SPEAKER.'));
});

// ── Field reading ────────────────────────────────────────────────────────

test('an unresolved merge token reads as absent, not as a literal', () => {
  const out = buildAgenticLeadNotes(
    contactFixture({
      [F.AI_SUMMARY]: '{{contact.promoter}}',
      [F.AI_SUMMARY_ALT]: '{{contact.ai_summary}}',
    }),
    {}
  );
  assert.ok(!out.includes('{{'));
  assert.ok(!out.includes('SUMMARY:'));
});

test('readField tolerates the write-shape keys and numeric values', () => {
  const c = { customFields: [{ id: F.TRUST_SCORE, field_value: 0 }] };
  assert.equal(readField(c, F.TRUST_SCORE), '0');
  assert.equal(readField({ customField: [{ id: F.COUNTY, value: 'Pinellas' }] }, F.COUNTY), 'Pinellas');
  assert.equal(readField({ customFields: 'not-an-array' }, F.COUNTY), null);
  assert.equal(readField(contactFixture(), 'nope'), null);
});

// ── Weakness gate ────────────────────────────────────────────────────────

test('isWeakNotes decides when a brief is not worth sending', () => {
  assert.equal(isWeakNotes(''), true);
  assert.equal(isWeakNotes('   '), true);
  assert.equal(isWeakNotes(null), true);
  assert.equal(isWeakNotes(undefined), true);
  assert.equal(isWeakNotes('{{contact.contact_summary}}'), true);
  assert.equal(isWeakNotes('x'.repeat(40)), true);
  assert.equal(isWeakNotes('x'.repeat(400)), false);
  // The live ChatGPT-node output is healthy — this is why 'augment' exists.
  assert.equal(isWeakNotes(LIVE_CONTACT_SUMMARY), false);
});

// ── Transcript ───────────────────────────────────────────────────────────

test('transcript trims from the front and says how much it dropped', () => {
  const out = buildAgenticLeadNotes(
    { customFields: [{ id: F.CHAT_TRANSCRIPT, value: TRANSCRIPT }] },
    { maxChars: 400 }
  );
  assert.ok(out.includes('13. ok'), 'the most recent turn must survive');
  assert.ok(!out.includes('Are you manufacturers'), 'the oldest turn is trimmed');
  assert.ok(/\[\d+ earlier turn\(s\) trimmed\]/.test(out), 'the trim must be visible');
});

test('formatTranscript numbers chronologically and handles degenerate input', () => {
  assert.equal(formatTranscript('a / b / c', 500), '1. a 2. b 3. c');
  assert.equal(formatTranscript('', 500), '');
  assert.equal(formatTranscript(null, 500), '');
  assert.equal(formatTranscript('   /   ', 500), '');
  // At an impossibly tight cap the newest turn plus the trim marker still come
  // back — the marker is added after the budget check, so this can overshoot.
  // Callers clamp; buildAgenticLeadNotes also refuses to ask below
  // MIN_TRANSCRIPT_ROOM, so the overshoot is unreachable in production.
  assert.equal(formatTranscript('a / b / c', 5), '[2 earlier turn(s) trimmed] 3. c');
});

// ── Augment ──────────────────────────────────────────────────────────────

test('augment keeps a healthy brief and adds only what it lacks', () => {
  const out = buildAugmentedNotes(LIVE_CONTACT_SUMMARY, contactFixture(), {});
  assert.ok(out.startsWith('AGENTIC LEAD: NO APPOINTMENT'), 'the call-to-action leads');
  assert.ok(out.includes('OPENER: Hi Cynthia'), 'nothing the ChatGPT node wrote is lost');
  assert.ok(out.includes('CONVERSATION:'), 'the transcript is the main gain');
  assert.ok(out.includes('REACH:'));
  // Labels the incoming brief already carries are never duplicated.
  assert.equal(countOf(out, 'WANTS:'), 1);
  assert.equal(countOf(out, 'HEADS UP:'), 1);
});

test('augment returns null when there is nothing to add', () => {
  const complete =
    'AGENTIC LEAD: x | SUMMARY: y | WANTS: z | HEADS UP: a | REACH: b | CONVERSATION: c';
  assert.equal(buildAugmentedNotes(complete, { customFields: [] }, {}), null);
  assert.equal(buildAugmentedNotes('', contactFixture(), {}), null);
  assert.equal(buildAugmentedNotes(null, contactFixture(), {}), null);
});

test('augment respects the char ceiling', () => {
  const out = buildAugmentedNotes(LIVE_CONTACT_SUMMARY, contactFixture(), { maxChars: 700 });
  assert.ok(out.length <= 700, `expected <= 700, got ${out.length}`);
});

// ── Fetch wrapper: fail-open, never throws ───────────────────────────────

test('fetchAndBuildAgenticNotes returns null on every failure mode', async () => {
  assert.equal(await fetchAndBuildAgenticNotes('', {}, {}), null);
  assert.equal(await fetchAndBuildAgenticNotes(null, {}, {}), null);
  assert.equal(
    await fetchAndBuildAgenticNotes('abc', {}, { getContact: async () => null }),
    null
  );
  assert.equal(
    await fetchAndBuildAgenticNotes('abc', {}, {
      getContact: async () => { throw new Error('GHL down'); },
    }),
    null
  );
  assert.equal(
    await fetchAndBuildAgenticNotes('abc', {}, {
      getContact: async () => { throw new Error('boom'); },
    }),
    null
  );
});

test('fetchAndBuildAgenticNotes builds, and augments when asked', async () => {
  const deps = { getContact: async () => contactFixture() };

  const built = await fetchAndBuildAgenticNotes('abc', { hasAppointment: true }, deps);
  assert.ok(built.startsWith('AGENTIC LEAD: appointment attached.'));
  assert.ok(built.includes('CONVERSATION:'));

  const augmented = await fetchAndBuildAgenticNotes(
    'abc',
    { augmentFrom: LIVE_CONTACT_SUMMARY },
    deps
  );
  assert.ok(augmented.includes('OPENER: Hi Cynthia'));
  assert.ok(augmented.includes('CONVERSATION:'));
});

// ─── the market code on the WANTS line (2026-09-21) ──────────────
//
// z0MV6mXi0w9WwdCOFThh is not reliably single-valued: /n8n/enrich-lead used to
// write every branch a prospect had ever been worked by, comma-joined, and
// ~136 contacts still hold values like "LAKE, FTMYR". Telling a rep the lead
// is in two markets at once is worse than telling them nothing.

test('REGRESSION: a joined market value is dropped from the brief, not printed', () => {
  const out = buildAgenticLeadNotes(contactFixture({ [F.MARKET_CODE]: 'LAKE, FTMYR' }), {});
  assert.ok(!out.includes('LAKE, FTMYR'), 'a two-market string must never reach a rep');
  assert.ok(!out.includes('LAKE'), 'and not half of it either');
});

test('a single valid code still renders on the WANTS line', () => {
  const out = buildAgenticLeadNotes(contactFixture({ [F.MARKET_CODE]: 'FTMYR' }), {});
  assert.ok(out.includes('FTMYR'));
});

test('dropping the market leaves the rest of WANTS intact', () => {
  // The line is a join of product, window count and market — losing one part
  // must not take the others with it.
  const out = buildAgenticLeadNotes(contactFixture({ [F.MARKET_CODE]: 'LAKE, FTMYR' }), {});
  assert.ok(out.includes('7 windows'));
  assert.ok(out.includes('Impact Windows'));
});

test('marketCodeOrNull: one token in, anything else out', () => {
  const { marketCodeOrNull } = _internal;
  assert.equal(marketCodeOrNull('FTMYR'), 'FTMYR');
  assert.equal(marketCodeOrNull('ftmyr'), 'FTMYR');
  assert.equal(marketCodeOrNull('ORL  '), 'ORL', 'LP pads branch codes with spaces');
  for (const v of ['LAKE, FTMYR', 'LAKE,FTMYR', 'FT MYR', 'LAKE;FTMYR', '', '   ', null, undefined]) {
    assert.equal(marketCodeOrNull(v), null, `expected null for ${JSON.stringify(v)}`);
  }
});
