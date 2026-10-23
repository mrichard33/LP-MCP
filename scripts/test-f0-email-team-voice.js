/**
 * F.0 v2 email in the Reece Team voice — scripts/test-f0-email-team-voice.js (Mark, 2026-10-22)
 * Run: node --test scripts/test-f0-email-team-voice.js
 *
 * The ruling: the email is written and signed as the Reece Team ("we", never
 * "I"), and the call invite names the rehash rep from the GHL custom value
 * rehash_rep_name (else the follower, else "our team"). F0_EMAIL_VOICE=rep is
 * the 2026-10-21 email (scripts/test-f0-email.js holds it).
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeSupabase } from './lib/fake-supabase.js';

const { checkF0Copy, f0RetryNote, splitTeamSignature } = await import('../src/siro/f0-copy-checks.js');
const { f0EmailVoice, f0EmailOutput, F0_TEAM_SIGNATURE } = await import('../src/siro/f0-email.js');
const { loadF0Context, resolveEmailRepFirst, cleanRepFirst } = await import('../src/siro/f0-context.js');
const { f0FormulaAllows } = await import('../src/nurture/nurture-prompt-selector.js');
const { previewF0Generation } = await import('../src/siro/f0-preview.js');

const FACTS = {
  rep_first_name: 'Alex',
  insights: {
    main_objection: 'Decision Maker Not Present',
    objection_summary: 'The customer needed his grandson, who handles his financial decisions, to review the proposal before committing funds.',
    emotional_tie: 'Wants to protect and restore his longtime home before his family visits for Christmas.',
    scope: 'Replacement of 5 aging windows with rotting frames, including 2 large rear windows and a bathroom window.',
  },
  objections: [{ type: 'price', said: 'Before proceeding, he wanted to discuss the offer with his grandson, whom he relies on for financial guidance.' }],
  interests: ['Replacing aging windows because the material is rotting and falling out', 'Protecting the home after recent hurricane conditions'],
  summary_lines: ['He loved the window and the heat demonstration'],
  questions: [],
};
const BODY = `Hi James,

Thank you for having us out and for showing Alex around the house. Those rear windows with the frames rotting and falling out are clearly the ones that worry you most, especially after the hurricane weather this season.

We understand you want your grandson to look over the numbers before you commit to anything. That makes complete sense for a decision like this, and there is no rush on our side.

What stayed with us is how much you want the home protected and looking its best when the family visits for Christmas. Getting those rotting windows replaced before then is exactly the kind of project we like to get right.

If we could make the numbers work better for you both, would you be open to a quick call with John?

The Reece Team`;
const SLOTS = {
  hesitation: 'you want your grandson to look over the numbers',
  affirm: 'that makes complete sense',
  reframe: 'getting those rotting windows replaced before the family visits for Christmas',
  if_i_could: 'make the numbers work better for you both',
};
const EMAIL = { subject: 'Thank you for having us, James', preheader: 'A few thoughts on those rear windows and Christmas', ps: '' };
const opts = (extra = {}) => ({ facts: FACTS, position: 0, repFirstName: 'John', formula: 'email', voice: 'team', callWith: 'John', slots: SLOTS, firstName: 'James', ...EMAIL, ...extra });

test('F0_EMAIL_VOICE: team by default, rep is the rollback, a typo is team', () => {
  assert.equal(f0EmailVoice({}), 'team');
  assert.equal(f0EmailVoice({ F0_EMAIL_VOICE: 'rep' }), 'rep');
  assert.equal(f0EmailVoice({ F0_EMAIL_VOICE: 'REP ' }), 'rep');
  assert.equal(f0EmailVoice({ F0_EMAIL_VOICE: 'jon' }), 'team');
});

test('the rep for the email: the custom value first, then the follower, else nobody', async () => {
  const env = { REHASH_TEAM_USER_IDS: 'TYcZ9DcNkuPCFYsFxRFV,u2', REHASH_TEAM_USER_NAMES: 'u2:Maria Lopez' };
  const follower = { getContact: async () => ({ followers: ['u2'] }) };
  // The custom value wins over the follower (the texts keep the follower first).
  assert.equal(await resolveEmailRepFirst('c1', { env, deps: { ...follower, getCustomValue: async () => 'John' } }), 'John');
  assert.equal(await resolveEmailRepFirst('c1', { env, deps: { ...follower, getCustomValue: async () => 'John Manieri' } }), 'John');
  // Blank, failed or a merge tag: the follower.
  assert.equal(await resolveEmailRepFirst('c1', { env, deps: { ...follower, getCustomValue: async () => '' } }), 'Maria');
  assert.equal(await resolveEmailRepFirst('c1', { env, deps: { ...follower, getCustomValue: async () => { throw new Error('GHL 500'); } } }), 'Maria');
  assert.equal(await resolveEmailRepFirst('c1', { env, deps: { ...follower, getCustomValue: async () => '{{custom_values.rehash_rep_name}}' } }), 'Maria');
  // Neither: no name (never "Reece Team" as a person, never guessed).
  assert.equal(await resolveEmailRepFirst('c1', { env, deps: { getContact: async () => null, getCustomValue: async () => null } }), null);
  assert.equal(cleanRepFirst('{{custom_values.rehash_rep_name}}'), null);
  assert.equal(cleanRepFirst('  john '), 'John');
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
const REQ = { contact_id: 'c1', workflow_code: 'F.0', sequence_position: 0, channel: 'email' };
const ENV = { REHASH_TEAM_USER_IDS: 'TYcZ9DcNkuPCFYsFxRFV,u2', REHASH_TEAM_USER_NAMES: 'u2:Maria Lopez' };
const deps = ({ customValue, followers = [] }) => ({
  supabase: fakeSupabase({ rehash_stage: [], lp_leads: [{ lp_lead_id: '583321', lp_prospect_id: '470111', created_at_lp: '2026-10-01' }], agentic_messages: [] }),
  readSiroRows: async () => [ROW], getCustomValue: async () => customValue, getContact: async () => ({ followers }), ensureRecordingForLead: async () => 'none',
});
const noTags = (o) => assert.doesNotMatch(JSON.stringify(o), /\{\{/, 'no merge tag anywhere');

test('loadF0Context: custom value "John" → the call line says John', async () => {
  const out = await loadF0Context(CONTEXT, REQ, { env: ENV, nowMs: NOW, deps: deps({ customValue: 'John', followers: ['u2'] }) });
  assert.equal(out.vars.email_voice, 'team');
  assert.equal(out.vars.call_with, 'John');
  assert.equal(out.vars.rehash_rep_first_name, 'John');
  noTags(out.vars);
});

test('loadF0Context: custom value blank → the follower', async () => {
  const out = await loadF0Context(CONTEXT, REQ, { env: ENV, nowMs: NOW, deps: deps({ customValue: '', followers: ['u2'] }) });
  assert.equal(out.vars.call_with, 'Maria');
});

test('loadF0Context: both missing → "our team", no rep name', async () => {
  const out = await loadF0Context(CONTEXT, REQ, { env: ENV, nowMs: NOW, deps: deps({ customValue: null }) });
  assert.equal(out.vars.call_with, 'our team');
  assert.equal(out.vars.rehash_rep_first_name, '');
  noTags(out.vars);
  // The prompt reads CALL WITH; checks read the same value.
  const body = BODY.replace('a quick call with John?', 'a quick call with our team?');
  assert.deepEqual(checkF0Copy(body, opts({ repFirstName: null, callWith: out.vars.call_with })), []);
});

test('rep voice and the texts keep the follower first; no email vars on a text', async () => {
  const rep = await loadF0Context(CONTEXT, REQ, { env: { ...ENV, F0_EMAIL_VOICE: 'rep' }, nowMs: NOW, deps: deps({ customValue: 'John', followers: ['u2'] }) });
  assert.equal(rep.vars.email_voice, 'rep');
  assert.equal(rep.vars.rehash_rep_first_name, 'Maria');
  assert.equal(rep.vars.call_with, undefined);
  const sms = await loadF0Context(CONTEXT, { ...REQ, sequence_position: 1, channel: 'sms' }, { env: ENV, nowMs: NOW, deps: deps({ customValue: 'John', followers: ['u2'] }) });
  assert.equal(sms.vars.rehash_rep_first_name, 'Maria');
  assert.equal(sms.vars.email_voice, undefined);
  assert.equal(sms.vars.call_with, undefined);
});

test('checkF0Copy team: the Reece Team email passes', () => {
  const words = splitTeamSignature(BODY).content.split(/\s+/).filter(Boolean).length;
  assert.ok(words >= 120 && words <= 180, `body is ${words} words`);
  assert.equal(splitTeamSignature(BODY).signature, F0_TEAM_SIGNATURE);
  assert.deepEqual(checkF0Copy(BODY, opts()), []);
});

test('checkF0Copy team: a first-person draft fails', () => {
  const cases = [
    BODY.replace('What stayed with us', 'What stayed with me'),
    BODY.replace('We understand you want', 'I understand you want'),
    BODY.replace('there is no rush on our side', 'there is no rush on my side'),
  ];
  for (const b of cases) assert.ok(checkF0Copy(b, opts()).includes('first_person'), b.slice(0, 60));
  assert.ok(checkF0Copy(BODY, opts({ subject: 'I loved meeting you, James' })).includes('first_person'));
  assert.ok(checkF0Copy(BODY, opts({ ps: 'Let me know if anything changes.' })).includes('first_person'));
  // "If I could" is first person: the team says "we".
  assert.ok(checkF0Copy(BODY.replace('If we could', 'If I could'), opts()).includes('first_person'));
});

test('checkF0Copy team: signed as a person, no signature, or the invite names someone else', () => {
  const signed = (sig) => BODY.replace(/The Reece Team$/, sig);
  assert.ok(checkF0Copy(signed('John'), opts()).includes('signed_as_person'));
  assert.ok(checkF0Copy(signed('Best,\nJohn'), opts()).includes('signed_as_person'));
  assert.ok(checkF0Copy(signed('- John Manieri'), opts()).includes('signed_as_person'));
  assert.ok(checkF0Copy(signed(''), opts()).includes('missing_signature'));
  // "Best," before the team line: the autofix would strip the whole paragraph.
  assert.ok(checkF0Copy(signed('Best,\nThe Reece Team'), opts()).includes('missing_signature'));
  assert.deepEqual(checkF0Copy(signed('The Reece Team.'), opts()), []);
  const other = (who) => BODY.replace('a quick call with John?', `a quick call with ${who}?`);
  assert.ok(checkF0Copy(other('Alex'), opts()).includes('call_names_other'));
  assert.ok(checkF0Copy(other('Maria'), opts()).includes('call_names_other'));
  assert.ok(checkF0Copy(other('John or Alex'), opts()).includes('call_names_other'));
  assert.ok(checkF0Copy(other('our team'), opts()).includes('call_names_other'), 'a name was resolved: it is named');
  assert.ok(checkF0Copy(other('John'), opts({ callWith: 'our team' })).includes('call_names_other'));
});

test('the re-write note speaks to the team voice', () => {
  const note = f0RetryNote(['first_person', 'signed_as_person', 'missing_signature', 'call_names_other', 'no_conditional_offer', 'no_call_question'], { position: 0, formula: 'email', voice: 'team' });
  assert.match(note, /Never "I", "me" or "my"/);
  assert.match(note, /exactly "The Reece Team"/);
  assert.match(note, /End the body with the line "The Reece Team"/);
  assert.match(note, /CALL WITH/);
  assert.match(note, /in your own words/);
  // The texts' signature note is unchanged.
  assert.match(f0RetryNote(['missing_signature'], { position: 5 }), /rep first name/);
});

test('the email output keeps the team line and carries no merge tag', () => {
  const out = f0EmailOutput({ ...EMAIL, body: BODY, slots: SLOTS });
  assert.match(out.body_html, /<p>The Reece Team<\/p>$/);
  noTags(out);
});

test('the voice picks the email row: team = V2, rep = V1, texts untouched', () => {
  const v1 = { channel: 'email', version: 1 };
  const v2 = { channel: 'email', version: 2 };
  const req = { workflow_code: 'F.0' };
  assert.equal(f0FormulaAllows(v2, req, { siro: { email_voice: 'team' } }), true);
  assert.equal(f0FormulaAllows(v1, req, { siro: { email_voice: 'team' } }), false);
  assert.equal(f0FormulaAllows(v1, req, { siro: { email_voice: 'rep', formula: 'four_step' } }), true);
  assert.equal(f0FormulaAllows(v2, req, { siro: { email_voice: 'rep' } }), false);
  assert.equal(f0FormulaAllows({ channel: 'sms', version: 2 }, req, { siro: { email_voice: 'team', formula: 'four_step' } }), true);
});

test('the V2 seed: active, version 2, CALL WITH, and its example passes the team checks', () => {
  const sql = fs.readFileSync(new URL('../sql/seeds/2026-10-22_f0_v2_email_prompt_team_voice.sql', import.meta.url), 'utf8');
  assert.match(sql, /\$f0\$F\.0-P0-email-V2\$f0\$, 'F\.0', 'email', 0, null,/);
  assert.match(sql, /2000, 0\.7, true, 2, \$f0\$email-team\$f0\$/);
  assert.match(sql, /CALL WITH: \{\{siro\.call_with\}\}/);
  assert.doesNotMatch(sql, /active = excluded\.active/);
  assert.doesNotMatch(sql, /REP FIRST NAME/);
  const ex = sql.match(/- GOOD body:\n([\s\S]*?)\n- GOOD ps:/)[1];
  assert.match(ex, /\n\nThe Reece Team$/);
  const { content } = splitTeamSignature(ex);
  const words = content.split(/\s+/).filter(Boolean).length;
  assert.ok(words >= 120 && words <= 180, `example is ${words} words`);
  assert.equal((ex.match(/\?/g) || []).length, 1);
  assert.match(ex, /There may be a way/, 'the example close is not "If we could": the idea, not the script');
  assert.doesNotMatch(content, /\bI\b|\b(?:me|my)\b/);
  assert.doesNotMatch(ex, /!|\bdeal\b|founder|—/i);
});

test('preview: team voice reads V2 and checks the team rules; no merge tag in the result', async () => {
  const good = { ...EMAIL, body: BODY, slots: SLOTS };
  const prevEnv = process.env.F0_EMAIL_VOICE;
  delete process.env.F0_EMAIL_VOICE;
  try {
    const res = await previewF0Generation('c1', 0, {
      channel: 'email',
      deps: {
        ...deps({ customValue: 'John' }),
        buildLeadContext: async () => JSON.parse(JSON.stringify(CONTEXT)),
        selectPrompt: async (ctx) => {
          assert.equal(ctx.siro.email_voice, 'team');
          assert.equal(ctx.siro.call_with, 'John');
          return { prompt_code: 'F.0-P0-email-V2', system_prompt: 'sys', output_schema: { required: [] } };
        },
        generateNurtureContent: async () => ({ output: good }),
      },
    });
    assert.equal(res.voice, 'team');
    assert.equal(res.call_with, 'John');
    assert.match(res.body, /quick call with John\?\n\nThe Reece Team$/);
    for (const f of ['first_person', 'signed_as_person', 'missing_signature', 'call_names_other', 'no_conditional_offer']) {
      assert.ok(!(Array.isArray(res.checks.f0) && res.checks.f0.includes(f)), `${f}: ${JSON.stringify(res.checks)}`);
    }
    noTags({ subject: res.subject, preheader: res.preheader, body: res.body, ps: res.ps });
  } finally {
    if (prevEnv !== undefined) process.env.F0_EMAIL_VOICE = prevEnv;
  }
});
