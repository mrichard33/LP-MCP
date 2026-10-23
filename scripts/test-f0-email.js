/**
 * F.0 v2 position-0 email — scripts/test-f0-email.js (Mark, 2026-10-21)
 * Run: node --test scripts/test-f0-email.js
 *
 * The visit is the Four-Step test's (Mr. Jackson's shape, names changed): his
 * late wife must never reach the email; the family visiting for Christmas may.
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeSupabase } from './lib/fake-supabase.js';

const {
  isF0EmailRequest, allowsPositionZero, asksPositionZero, f0EmailMode, f0EmailShadow, emailHoldCapMs,
  emailHoldWindow, emailGate, f0EmailOutput, paragraphsToHtml, F0_EMAIL_FALLBACK_TAG, emailFallbackTag,
} = await import('../src/siro/f0-email.js');
const { checkF0Copy, f0RetryNote } = await import('../src/siro/f0-copy-checks.js');
const { postDemoInterrupt } = await import('../src/siro/f0-interrupts.js');
const { buildVisitFacts } = await import('../src/siro/f0-four-step.js');
const { coerceSeqPos } = await import('../src/nurture/nurture-sequence-resolver.js');
const { f0FormulaAllows } = await import('../src/nurture/nurture-prompt-selector.js');
const { buildF0ApprovalCard, runNurtureGeneration } = await import('../src/nurture/nurture-orchestrator.js');
const { loadF0Context, resolveRehashRepFirst, greetingName, applyGreetingName } = await import('../src/siro/f0-context.js');
const { previewF0Generation } = await import('../src/siro/f0-preview.js');

const FACTS = {
  rep_first_name: 'Alex',
  insights: {
    main_objection: 'Decision Maker Not Present',
    secondary_objection: 'Pricing',
    objection_summary: 'The sale did not close because the customer needed his grandson, who handles his financial decisions, to review the proposal before committing funds.',
    emotional_tie: 'Customer recently lost his wife, had his great-grandchildren move out, and wants to protect and restore his longtime home before his family visits for Christmas.',
    scope: 'Replacement of 5 aging windows with rotting frames, including 2 large rear windows and a bathroom window.',
  },
  objections: [
    { type: 'price', said: 'Before proceeding, he wanted to discuss the offer with his grandson, whom he relies on for financial guidance.' },
  ],
  interests: ['Replacing aging windows because the material is rotting and falling out', 'Protecting the home after recent hurricane conditions'],
  summary_lines: ['He loved the window and the heat demonstration'],
  questions: [],
};
const BODY = `Hi James,

Thank you for having us out and for showing Alex around the house. Those rear windows with the frames rotting and falling out are clearly the ones that worry you most, especially after the hurricane weather this season.

I understand you want your grandson to look over the numbers before you commit to anything. That makes complete sense for a decision like this, and there is no rush on our side.

What stayed with me is how much you want the home protected and looking its best when the family visits for Christmas. Getting those rotting windows replaced before then is exactly the kind of project we like to get right.

If I could make the numbers work better for you both, would you be open to a quick call with John?`;
const SLOTS = {
  hesitation: 'you want your grandson to look over the numbers',
  affirm: 'that makes complete sense',
  reframe: 'getting those rotting windows replaced before the family visits for Christmas',
  if_i_could: 'make the numbers work better for you both',
};
const EMAIL = { subject: 'Thank you for having us, James', preheader: 'A few thoughts on those rear windows and Christmas', ps: '' };
const opts = (extra = {}) => ({ facts: FACTS, position: 0, repFirstName: 'John', formula: 'email', slots: SLOTS, firstName: 'James', ...EMAIL, ...extra });

// 2026-10-21: 0 is the INTERNAL position. The workflow sends 1 for the email
// (GHL saves a 0 as blank); scripts/test-f0-positions.js holds that mapping.
test('position 0 is the F.0 email and nothing else', () => {
  assert.equal(isF0EmailRequest({ workflow_code: 'F.0', sequence_position: 0, channel: 'email' }), true);
  assert.equal(isF0EmailRequest({ workflow_code: 'F.0', sequence_position: 1, channel: 'sms' }), false);
  assert.equal(isF0EmailRequest({ workflow_code: 'F.0', sequence_position: 0, channel: 'sms' }), false);
  assert.equal(isF0EmailRequest({ workflow_code: 'S4.5', sequence_position: 0, channel: 'email' }), false);
  assert.equal(allowsPositionZero({ workflow_code: 'F.0', channel: 'email' }), true);
  assert.equal(allowsPositionZero({ workflow_code: 'S4.5', channel: 'email' }), false);
  assert.equal(allowsPositionZero({ workflow_code: 'F.0', channel: 'sms' }), false);
  assert.equal(asksPositionZero('0'), true);
  assert.equal(asksPositionZero(0), true);
  assert.equal(asksPositionZero(''), false);
  assert.equal(asksPositionZero(null), false);
  assert.equal(asksPositionZero('1'), false);
  // The resolver: 0 only when the route allows it (before: 0 silently became 1).
  assert.equal(coerceSeqPos('0'), null);
  assert.equal(coerceSeqPos('0', { allowZero: true }), 0);
  assert.equal(coerceSeqPos('3', { allowZero: true }), 3);
  assert.equal(coerceSeqPos('13', { allowZero: true }), null);
});

test('F0_EMAIL_MODE decides the email alone (the user, 2026-10-21)', () => {
  assert.equal(f0EmailMode({}), 'shadow');
  assert.equal(f0EmailMode({ F0_EMAIL_MODE: 'LIVE' }), 'live');
  assert.equal(f0EmailMode({ F0_EMAIL_MODE: 'typo' }), 'shadow');
  assert.equal(f0EmailShadow({}), true);
  // Live while the texts stay in approval (NURTURE_SHADOW_WORKFLOWS keeps F.0).
  assert.equal(f0EmailShadow({ F0_EMAIL_MODE: 'live', F0_V2_MODE: 'shadow', NURTURE_SHADOW_WORKFLOWS: 'F.0' }), false);
  // The global NURTURE_SHADOW_MODE still wins.
  assert.equal(f0EmailShadow({ F0_EMAIL_MODE: 'live' }, true), true);
});

test('the hold cap: 08:30 ET the day after the demo, DST included', () => {
  // 6 PM EDT on Oct 20 → 08:30 EDT Oct 21 = 12:30Z.
  assert.equal(new Date(emailHoldCapMs({ demoAtMs: Date.parse('2026-10-20T22:00:00Z') })).toISOString(), '2026-10-21T12:30:00.000Z');
  // 6 PM EDT on Oct 31 → 08:30 EST Nov 1 = 13:30Z.
  assert.equal(new Date(emailHoldCapMs({ demoAtMs: Date.parse('2026-10-31T22:00:00Z') })).toISOString(), '2026-11-01T13:30:00.000Z');
  // A late demo (11 PM ET = 03:00Z next day) still caps on the day after its ET date.
  assert.equal(new Date(emailHoldCapMs({ demoAtMs: Date.parse('2026-10-21T03:00:00Z') })).toISOString(), '2026-10-21T12:30:00.000Z');
  assert.equal(new Date(emailHoldCapMs({ demoAtMs: Date.parse('2026-10-20T22:00:00Z'), capEt: '07:15' })).toISOString(), '2026-10-21T11:15:00.000Z');
  assert.equal(emailHoldCapMs({ demoAtMs: NaN }), null);
});

test('the wait for the recording: 2h steps, the last one shorter, nothing past the cap', () => {
  const demoAtMs = Date.parse('2026-10-20T22:00:00Z');
  const evening = emailHoldWindow({ demoAtMs, nowMs: Date.parse('2026-10-21T00:00:00Z') });
  assert.equal(evening.waitMaxH, 14.5);
  assert.equal(evening.waitHoldH, 2);
  assert.equal(evening.pastCap, false);
  const late = emailHoldWindow({ demoAtMs, nowMs: Date.parse('2026-10-21T11:50:00Z') });
  assert.equal(late.waitHoldH, 1);
  // postDemoInterrupt reuses the hold with the email's window.
  const input = { unsoldPostDemo: true, rehashActive: true, siroFacts: null };
  const hold = postDemoInterrupt({ ...input, demoAgeH: 2, waitMaxH: evening.waitMaxH, waitHoldH: evening.waitHoldH });
  assert.deepEqual(hold, { hold: 2, reason: 'awaiting_siro' });
  const past = emailHoldWindow({ demoAtMs, nowMs: Date.parse('2026-10-21T12:30:00Z') });
  assert.equal(past.pastCap, true);
  const pd = postDemoInterrupt({ ...input, demoAgeH: 14.5, waitMaxH: past.waitMaxH, waitHoldH: past.waitHoldH });
  assert.equal(pd, null);
  // Past the cap with no recording: no_recording, with the fallback tag.
  assert.deepEqual(emailGate({ pd, facts: null }), { suppress: 'no_recording', terminal: true, tag: F0_EMAIL_FALLBACK_TAG });
  assert.equal(emailGate({ pd: null, facts: FACTS }), null);
  // Every other suppression passes through untouched (no tag).
  const sold = postDemoInterrupt({ lpSold: true });
  assert.deepEqual(emailGate({ pd: sold, facts: FACTS }), { suppress: 'sold', terminal: true });
  assert.equal(emailGate({ pd: sold, facts: null }).tag, undefined);
});

test('f0EmailOutput: paragraphs, escaping, the plain body kept for the checks', () => {
  const out = f0EmailOutput({ subject: ' Hi ', preheader: 'p', body: 'A & B <b>\n\nSecond\nline', ps: '', slots: SLOTS });
  assert.equal(out.body_html, '<p>A &amp; B &lt;b&gt;</p><p>Second<br>line</p>');
  assert.equal(out.email_plain_body, 'A & B <b>\n\nSecond\nline');
  assert.equal(out.subject, 'Hi');
  assert.equal(out.next_wait_hours, 0);
  assert.equal(out.ps_text, '');
  assert.equal(out.email_invalid, undefined);
  assert.equal(f0EmailOutput({ subject: 's', preheader: 'p', body: '', slots: {} }).email_invalid, 'missing_body');
  assert.equal(f0EmailOutput({ subject: 's', preheader: 'p', body: 'b' }).email_invalid, 'missing_slots');
  assert.equal(f0EmailOutput(null).email_invalid, 'missing_body');
  assert.equal(paragraphsToHtml('one\r\n\r\ntwo'), '<p>one</p><p>two</p>');
});

test('checkF0Copy email: the grounded email passes', () => {
  const words = BODY.split(/\s+/).filter(Boolean).length;
  assert.ok(words >= 120 && words <= 180, `body is ${words} words`);
  assert.deepEqual(checkF0Copy(BODY, opts()), []);
});

test('checkF0Copy email: every rule fails on its own', () => {
  const swap = (from, to) => BODY.replace(from, to);
  const cases = [
    [swap('If I could make', 'Do you want a call? If I could make'), {}, 'question_count'],
    [BODY, { ps: 'Any questions?' }, 'question_count'],
    [swap('Thank you for having us out', 'Thank you for having us out!'), {}, 'exclamation'],
    [swap('there is no rush on our side', 'the quote was $11,000'), {}, 'money'],
    [swap('there is no rush on our side', 'we can get you a great deal'), {}, 'deal_word'],
    [swap('there is no rush on our side', 'our founder always says to take your time'), {}, 'founder'],
    [swap('there is no rush on our side', 'your rep can explain the options'), {}, 'your_rep'],
    [swap('there is no rush on our side', 'Alex will follow up with you about it'), {}, 'sales_rep_follow_up'],
    [swap('What stayed with me', 'Alex and I both noticed what stayed with me'), {}, 'sales_rep_named_twice'],
    [`${BODY.replace(/\?$/, '.')}\n\nReece Windows and Doors, 1200 Main Street. Unsubscribe`, {}, 'footer_text'],
    [swap('there is no rush on our side', 'there is no rush after losing your wife'), {}, 'sensitive_detail'],
    [BODY, { subject: 'Thank you for having us out at the house last night, James, it was great' }, 'subject_length'],
    [BODY, { preheader: 'Thank you for having us out and for showing Alex around the house.' }, 'preheader_repeats_body'],
    ['Hi James,\n\nThank you for having us out. If I could make the numbers work better for you both, would you be open to a quick call with John?', {}, 'body_length'],
    [swap('Hi James,', 'Hello there,'), {}, 'first_name_not_first'],
    [swap('If I could make the numbers work better for you both, would you be open to a quick call with John?', 'Would you be open to a quick call with John?'), {}, 'no_conditional_offer'],
    [BODY, { slots: { ...SLOTS, hesitation: 'they want a pool and a new roof' } }, 'slot_ungrounded:hesitation'],
    [BODY, { slots: { ...SLOTS, reframe: null } }, 'slot_missing:reframe'],
    [BODY, { facts: null }, 'no_visit_facts'],
  ];
  for (const [body, extra, code] of cases) {
    const fails = checkF0Copy(body, opts(extra));
    assert.ok(fails.includes(code), `${code}: got ${JSON.stringify(fails)}`);
  }
  // The email may thank them (its job), and carries no signature (the template's).
  assert.ok(!checkF0Copy(BODY, opts()).includes('generic_opener'));
  assert.ok(!checkF0Copy(BODY, opts()).includes('missing_signature'));
});

test('the re-write note names each email failure', () => {
  const note = f0RetryNote(['body_length', 'exclamation', 'deal_word', 'founder', 'footer_text', 'question_count', 'email_output'], { position: 0, formula: 'email' });
  assert.match(note, /120 to 180 words/);
  assert.match(note, /No exclamation marks/);
  assert.match(note, /"deal"/);
  assert.match(note, /founder/);
  assert.match(note, /footer/);
  assert.match(note, /whole email/);
  assert.match(note, /"subject", "preheader", "body", "ps"/);
  // The texts' notes are unchanged in meaning, the Four-Step cap now named right.
  assert.match(f0RetryNote(['too_long'], { position: 1, formula: 'four_step' }), /300/);
  assert.match(f0RetryNote(['too_long'], { position: 1 }), /300/);
});

test('<visit_facts>: visited_by only for the email; the texts are byte for byte the same', () => {
  const sms = buildVisitFacts(FACTS, { firstName: 'James', repFirstName: 'John' });
  assert.doesNotMatch(sms, /visited_by/);
  const email = buildVisitFacts(FACTS, { firstName: 'James', repFirstName: 'John', visitedBy: 'Alex' });
  assert.match(email, /<visited_by>Alex<\/visited_by>/);
  assert.match(email, /<rep_first_name>John<\/rep_first_name>/);
  assert.doesNotMatch(email, /wife/);
});

test('the email row passes the formula filter in both text formulas', () => {
  const row = { channel: 'email', version: 1 };
  assert.equal(f0FormulaAllows(row, { workflow_code: 'F.0' }, { siro: { formula: 'four_step' } }), true);
  assert.equal(f0FormulaAllows(row, { workflow_code: 'F.0' }, { siro: {} }), true);
  assert.equal(f0FormulaAllows({ channel: 'sms', version: 1 }, { workflow_code: 'F.0' }, { siro: { formula: 'four_step' } }), false);
});

test('the email approval card shows all four parts and the email gate', () => {
  const card = buildF0ApprovalCard({
    request: { contact_id: 'c1', workflow_code: 'F.0', sequence_position: 0, channel: 'email' },
    context: { lead: { first_name: 'James', phone: '+1 (352) 555-0188' }, lp: { prospect_id: '470111', lead_id: '583321' } },
    generationId: 'gen_1', output: { ...f0EmailOutput({ ...EMAIL, body: BODY, ps: 'The heat demo was a hit.', slots: SLOTS }) },
    prompt: { prompt_code: 'F.0-P0-email-V1' }, recordingId: 'rec_1',
  });
  assert.match(card, /F\.0 POST-DEMO EMAIL READY/);
  assert.match(card, /position 1, the evening of the demo/, 'the workflow numbering');
  assert.match(card, /Subject: Thank you for having us, James/);
  assert.match(card, /Preheader: /);
  assert.match(card, /quick call with John\?/);
  assert.match(card, /P\.S\. The heat demo was a hit\./);
  assert.match(card, /AI Msg Send Ready/);
  assert.doesNotMatch(card, /AI SMS Send Ready/);
  assert.match(card, /Prospect 470111/);
  assert.doesNotMatch(card, /583321/);
  assert.doesNotMatch(card, /<p>/);
});

test('the rehash rep is the follower on the lead, else the custom value, else Reece Team', async () => {
  const env = { REHASH_TEAM_USER_IDS: 'TYcZ9DcNkuPCFYsFxRFV,u2', REHASH_TEAM_USER_NAMES: 'u2:Maria Lopez' };
  assert.equal(await resolveRehashRepFirst('c1', { env, deps: { getContact: async () => ({ followers: ['u2'] }), getCustomValue: async () => 'John Manieri' } }), 'Maria');
  assert.equal(await resolveRehashRepFirst('c1', { env, deps: { getContact: async () => ({ followers: [] }), getCustomValue: async () => 'John Manieri' } }), 'John');
  assert.equal(await resolveRehashRepFirst('c1', { env, deps: { getContact: async () => null, getCustomValue: async () => null } }), 'Reece Team');
  // A team follower with no configured name: the GHL user record.
  const env9 = { ...env, REHASH_TEAM_USER_IDS: `${env.REHASH_TEAM_USER_IDS},u9` };
  assert.equal(await resolveRehashRepFirst('c1', { env: env9, deps: { getContact: async () => ({ followers: ['u9'] }), getUserName: async () => 'Sam', getCustomValue: async () => 'John' } }), 'Sam');
  // A follower off the rehash team is never the rep (2026-10-23): the custom value.
  assert.equal(await resolveRehashRepFirst('c1', { env, deps: { getContact: async () => ({ followers: ['u9'] }), getUserName: async () => 'Reece', getCustomValue: async () => 'John' } }), 'John');
});

const NOW = Date.parse('2026-10-21T01:00:00Z');
const ROW = {
  recording_id: 'rec_1', processed: true, deleted: false, lp_lead_id: '583321', recorded_at: '2026-10-20T22:00:00Z',
  rep_name: 'Alex Kowalski', result: 'not closed', summary: [{ name: 'Need', content: 'Rear windows rotting' }],
  moments: [{ kind: 'objection', objection_type: 'price', customer_said: 'I want my grandson to look at the numbers' }],
};
const CONTEXT = {
  lp: { lead_id: '583321', prospect_id: '470111', disposition: 'OPPFDN', demo_date: '2026-10-20T22:00:00Z', demo_completed: true },
  lead: { current_tags: ['active-f.0'], phone: '3525550188', first_name: 'James' },
  conversation_recent: [],
  lead_facts: { note_dq: null },
};
const deps = (rows) => ({
  supabase: fakeSupabase({ rehash_stage: [], lp_leads: [{ lp_lead_id: '583321', lp_prospect_id: '470111', created_at_lp: '2026-10-01' }], agentic_messages: [] }),
  readSiroRows: async () => rows, getCustomValue: async () => 'John Manieri', getContact: async () => null, ensureRecordingForLead: async () => 'none',
});

test('loadF0Context for the email: <visit_facts> with visited_by in v1 too, and the email window', async () => {
  const req = { contact_id: 'c1', workflow_code: 'F.0', sequence_position: 0, channel: 'email' };
  const out = await loadF0Context(CONTEXT, req, { env: {}, nowMs: NOW, deps: deps([ROW]) });
  assert.match(out.vars.visit_facts, /<visited_by>Alex<\/visited_by>/);
  assert.equal(out.vars.formula, undefined, 'the text formula stays v1');
  assert.equal(out.vars.rehash_rep_first_name, 'John');
  // No recording, 3 hours after a 6 PM demo: hold (the cap is 08:30).
  const none = await loadF0Context(CONTEXT, req, { env: {}, nowMs: NOW, deps: deps([]) });
  assert.equal(none.interruptInput.waitMaxH, 14.5);
  const pd = emailGate({ pd: postDemoInterrupt(none.interruptInput), facts: none.facts });
  assert.equal(pd.reason, 'awaiting_siro');
  // Past the cap: no_recording.
  const late = await loadF0Context(CONTEXT, req, { env: {}, nowMs: Date.parse('2026-10-21T13:00:00Z'), deps: deps([]) });
  assert.equal(emailGate({ pd: postDemoInterrupt(late.interruptInput), facts: late.facts }).suppress, 'no_recording');
  // The texts keep their own window.
  const sms = await loadF0Context(CONTEXT, { ...req, sequence_position: 1, channel: 'sms' }, { env: {}, nowMs: NOW, deps: deps([]) });
  assert.equal(sms.interruptInput.waitMaxH, 24);
});

// 2026-10-22, the live preview: GHL's first name "a" (LP: "AJ / Anita") opened the email
// "Hi A," and its subject "…, A". A lone initial is no name; LP's lead is read instead.
test('the greeting name: no lone initial, a couple\'s first person, typed capitals kept', () => {
  const cases = [['a', ''], ['A.', ''], ['a j', ''], ['', ''], [null, ''], ['AJ / Anita', 'AJ'], ['George/Paula', 'George'],
    ['mark', 'Mark'], ['Dana', 'Dana'], ['Mary Ann', 'Mary Ann'], ['TJ', 'TJ']];
  for (const [raw, want] of cases) assert.equal(greetingName(raw), want, JSON.stringify(raw));
});

test('an initial in GHL: LP\'s name greets, and the prompt and the checks read it', async () => {
  const req = { contact_id: 'c1', workflow_code: 'F.0', sequence_position: 0, channel: 'email' };
  const ctx = { ...CONTEXT, lead: { ...CONTEXT.lead, first_name: 'a' } };
  const lpRow = (first_name) => ({ lp_lead_id: ROW.lp_lead_id, lp_prospect_id: '470111', created_at_lp: '2026-10-01', first_name });
  const withLp = (first_name) => ({ ...deps([ROW]), supabase: fakeSupabase({ rehash_stage: [], lp_leads: [lpRow(first_name)], agentic_messages: [] }) });
  const out = await loadF0Context(ctx, req, { env: {}, nowMs: NOW, deps: withLp('AJ / Anita') });
  assert.equal(out.vars.first_name, 'AJ');
  const context = { lead: { ...ctx.lead } };
  applyGreetingName(context, out, { email: true });
  assert.equal(context.lead.first_name, 'AJ', '{{lead.first_name}} is the cleaned name');
  // LP has no usable name either: the email opens with no name, never "A".
  const none = await loadF0Context(ctx, req, { env: {}, nowMs: NOW, deps: withLp('j') });
  assert.equal(none.vars.first_name, '');
  const blank = { lead: { ...ctx.lead } };
  applyGreetingName(blank, none, { email: true });
  assert.equal(blank.lead.first_name, '');
  // A real GHL name is kept as it is; v1 texts are never touched.
  const real = await loadF0Context(CONTEXT, req, { env: {}, nowMs: NOW, deps: withLp('Someone Else') });
  assert.equal(real.vars.first_name, 'James');
  const v1 = { lead: { first_name: 'a' } };
  applyGreetingName(v1, { vars: {} }, {});
  assert.equal(v1.lead.first_name, 'a');
});

test('preview: the email is drafted from the inactive row and checked; no recording never calls the model', async () => {
  let calls = 0;
  const previewDeps = (rows, output) => ({
    ...deps(rows),
    buildLeadContext: async () => JSON.parse(JSON.stringify(CONTEXT)),
    selectPrompt: async (ctx, req) => {
      assert.equal(req.channel, 'email');
      assert.equal(req.sequence_position, 0);
      assert.equal(req.include_inactive, true);
      return { prompt_code: 'F.0-P0-email-V1', system_prompt: 'sys', output_schema: { required: [] } };
    },
    generateNurtureContent: async () => { calls++; return { output }; },
  });
  const good = { ...EMAIL, body: BODY, slots: SLOTS };
  const res = await previewF0Generation('c1', 0, { channel: 'email', deps: previewDeps([ROW], good) });
  assert.equal(res.channel, 'email');
  assert.equal(res.prompt_code, 'F.0-P0-email-V1');
  assert.equal(res.subject, EMAIL.subject);
  assert.match(res.body, /quick call with John\?$/);
  assert.equal(res.visited_by, 'Alex');
  // Grounding reads the real normalized facts here, so only the email's own rules are asserted.
  for (const f of ['exclamation', 'deal_word', 'founder', 'footer_text', 'question_count', 'body_length']) {
    assert.ok(!(Array.isArray(res.checks.f0) && res.checks.f0.includes(f)), `${f}: ${JSON.stringify(res.checks)}`);
  }
  calls = 0;
  // Past the cap with no recording: the model is never called.
  const none = await previewF0Generation('c1', 0, { channel: 'email', deps: { ...previewDeps([], good) } });
  assert.equal(calls, 0);
  assert.match(none.outcome, /^(hold:awaiting_siro|suppressed:no_recording)/);
});

test('the seed: one email row, inactive, position 0, formula-independent', () => {
  const sql = fs.readFileSync(new URL('../sql/seeds/2026-10-21_f0_v2_email_prompt.sql', import.meta.url), 'utf8');
  assert.match(sql, /\$f0\$F\.0-P0-email-V1\$f0\$, 'F\.0', 'email', 0, null,/);
  assert.match(sql, /2000, 0\.7, false, 1, \$f0\$email\$f0\$/);
  assert.match(sql, /where prompt_code = 'F\.0-P0-email-V1'/);
  assert.doesNotMatch(sql, /active = excluded\.active/);
  // The prompt's own good example passes the checks it will be held to.
  const ex = sql.match(/- GOOD body:\n([\s\S]*?)\n- GOOD ps:/)[1];
  const words = ex.split(/\s+/).filter(Boolean).length;
  assert.ok(words >= 120 && words <= 180, `example is ${words} words`);
  assert.equal((ex.match(/\?/g) || []).length, 1);
  assert.doesNotMatch(ex, /!|\bdeal\b|founder|—/i);
});

test('a reply to the email threads: the lead\'s id, email kept, the post-demo email plan', async () => {
  const { inboundReplyEmailId } = await import('../src/send-message-handler.js');
  const { decideReplyChannel } = await import('../src/agentic/reply-sender.js');
  const { planPostDemoEmail } = await import('../src/agentic/post-demo-email.js');
  // GHL keeps every email for a contact in ONE conversation, the workflow's
  // template sends included (HL mirror, 2026-10-21: 15 of 15 S4.5 contacts).
  // A collapsed thread lists our template email first and the lead's reply
  // last; the bot answers with the reply's id, so GHL threads it.
  const reply = { direction: 'inbound', type: 3, meta: { email: { messageIds: ['our_f0_email_id', 'lead_reply_id'] } } };
  assert.equal(inboundReplyEmailId(reply), 'lead_reply_id');
  assert.equal(decideReplyChannel({ requestedChannel: 'email' }).reason, 'email_passthrough');
  assert.equal(decideReplyChannel({ inboundOrigin: 'email' }).channel, 'email');
  // The post-demo email reply path plans the turn.
  assert.equal(planPostDemoEmail({ trigger: 'Thanks, but we are not interested at this time.' }), 'decline_first');
  assert.equal(planPostDemoEmail({ trigger: 'We went with another company.' }), 'signed_elsewhere');
});

// 2026-10-23 (the user): every unsold demo gets the post-demo email. No AI email
// and no rule against one → the tag f0-email-fallback; a real stop → nothing.
test('emailFallbackTag: the static email for a failure, nothing for a real stop', () => {
  assert.equal(F0_EMAIL_FALLBACK_TAG, 'f0-email-fallback');
  for (const r of ['no_recording', 'f0_v2_off', 'f0_email_off', 'email_prompt_inactive', 'no_prompt_match',
    'generation_error', 'retry_error', 'safety_failed_after_retry', 'writeback_error', 'context_build_failed']) {
    assert.equal(emailFallbackTag(r), F0_EMAIL_FALLBACK_TAG, r);
  }
  for (const r of ['sold', 'newer_lead', 'rebooked', 'rehash_ended', 'lp_note_dq', 'post_demo_stop', 'human_replied',
    'recent_reply', 'dnc_or_stop', 'rehash_owned', 'wrong_active_workflow', 'awaiting_siro', 'awaiting_approval', null, undefined, '']) {
    assert.equal(emailFallbackTag(r), null, String(r));
  }
});

test('runNurtureGeneration tags the F.0 email fallback once, in one place', async () => {
  const email = { contact_id: 'c1', workflow_code: 'F.0', sequence_position: 0, channel: 'email' };
  const text = { contact_id: 'c1', workflow_code: 'F.0', sequence_position: 1, channel: 'sms' };
  const run = async (request, result) => {
    const tags = [];
    const out = await runNurtureGeneration(request, {
      inner: async () => { if (result instanceof Error) throw result; return result; },
      addTag: async (contactId, tag) => { tags.push(`${contactId}:${tag}`); },
    });
    return { out, tags };
  };
  // A failed generation and no recording: tagged.
  assert.deepEqual((await run(email, { generation_id: 'g', send_ready: false, suppressed_reason: 'safety_failed_after_retry' })).tags, ['c1:f0-email-fallback']);
  assert.deepEqual((await run(email, { generation_id: 'g', send_ready: false, suppressed_reason: 'no_recording' })).tags, ['c1:f0-email-fallback']);
  // A sold lead, a hold, a ready draft: not tagged.
  assert.deepEqual((await run(email, { generation_id: 'g', send_ready: false, suppressed_reason: 'sold' })).tags, []);
  assert.deepEqual((await run(email, { generation_id: 'g', send_ready: false, suppressed_reason: 'awaiting_siro' })).tags, []);
  assert.deepEqual((await run(email, { generation_id: 'g', send_ready: true })).tags, []);
  // A text that fails is still skipped, never the static email.
  assert.deepEqual((await run(text, { generation_id: 'g', send_ready: false, suppressed_reason: 'generation_error' })).tags, []);
  // A throw tags, then still throws (the route answers 200 with the error).
  const tags = [];
  await assert.rejects(runNurtureGeneration(email, {
    inner: async () => { throw new Error('boom'); },
    addTag: async (contactId, tag) => { tags.push(tag); },
  }), /boom/);
  assert.deepEqual(tags, ['f0-email-fallback']);
});
