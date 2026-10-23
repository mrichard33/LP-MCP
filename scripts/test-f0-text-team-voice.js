/**
 * F.0 v2 Four-Step texts in the Reece Team voice — scripts/test-f0-text-team-voice.js (the user, 2026-10-23)
 * Run: node --test scripts/test-f0-text-team-voice.js
 *
 * The email is the Reece Team's (2026-10-22); the texts were still written as
 * John and the last one signed "- John", so one conversation came from two
 * senders. With F0_TEXT_VOICE=team (the default) the Four-Step texts are
 * written as "we", the call is with the rehash rep (CALL WITH), and position 5
 * signs " - Reece Team". F0_TEXT_VOICE=rep is the version-2 copy
 * (scripts/test-f0-four-step.js and test-f0-varied-close.js hold it).
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeSupabase } from './lib/fake-supabase.js';

const { checkF0Copy, f0RetryNote } = await import('../src/siro/f0-copy-checks.js');
const { siroModes } = await import('../src/siro/config.js');
const { loadF0Context } = await import('../src/siro/f0-context.js');
const { f0FormulaAllows } = await import('../src/nurture/nurture-prompt-selector.js');
const { closingQuestion } = await import('../src/siro/f0-four-step.js');

const FACTS = {
  rep_first_name: 'Alex',
  insights: {
    main_objection: 'Decision Maker Not Present',
    emotional_tie: 'Wants to protect and restore his longtime home before his family visits for Christmas.',
    scope: 'Replacement of 5 aging windows with rotting frames, including 2 large rear windows and a bathroom window.',
  },
  objections: [{ type: 'spouse', said: 'He wants his grandson to look over the numbers before deciding.' }],
  interests: ['Replacing aging windows because the material is rotting and falling out'],
  summary_lines: [],
  questions: [],
};
const SLOTS = {
  hesitation: 'you want your grandson to look over the numbers',
  affirm: 'that makes sense',
  reframe: 'getting those rotting windows replaced before the family visits for Christmas',
  if_i_could: 'fit this into your budget at a better price',
};
const STEM = 'James, it makes sense that you want your grandson to look over the numbers first. Getting those rotting windows replaced before the family visits for Christmas still matters.';
const GOOD = `${STEM} If we could fit this into your budget at a better price, would you be open to a quick call with John?`;
const opts = (extra = {}) => ({ facts: FACTS, position: 1, repFirstName: 'John', formula: 'four_step', voice: 'team', callWith: 'John', slots: SLOTS, firstName: 'James', ...extra });

test('F0_TEXT_VOICE: team by default, rep is the rollback, a typo is team', () => {
  assert.equal(siroModes({}).f0TextVoice, 'team');
  assert.equal(siroModes({ F0_TEXT_VOICE: 'rep' }).f0TextVoice, 'rep');
  assert.equal(siroModes({ F0_TEXT_VOICE: ' REP' }).f0TextVoice, 'rep');
  assert.equal(siroModes({ F0_TEXT_VOICE: 'john' }).f0TextVoice, 'team');
});

test('positions 1-4: the Reece Team text passes; "I", a sign-off or another name fails', () => {
  assert.deepEqual(checkF0Copy(GOOD, opts()), []);
  assert.deepEqual(checkF0Copy(`${STEM} We may be able to fit this into your budget at a better price. Would a quick call with John help?`, opts({ position: 2 })), []);
  // Written as one person.
  assert.ok(checkF0Copy(GOOD.replace('If we could', 'If I could'), opts()).includes('first_person'));
  assert.ok(checkF0Copy(`${STEM} My hope is to fit this into your budget at a better price. Would a quick call with John help?`, opts()).includes('first_person'));
  // Anything after the call question.
  assert.ok(checkF0Copy(`${GOOD} Thanks, John`, opts()).includes('signed_as_person'));
  assert.ok(checkF0Copy(`${GOOD} Thanks, the Reece Team`, opts()).includes('signature_in_body'));
  // The call is with CALL WITH and nobody else.
  assert.ok(checkF0Copy(GOOD.replace('call with John?', 'call with Alex?'), opts()).includes('call_names_other'));
  // No name found: "our team".
  const ours = GOOD.replace('call with John?', 'call with our team?');
  assert.deepEqual(checkF0Copy(ours, opts({ callWith: 'our team', repFirstName: 'Reece Team' })), []);
  assert.ok(checkF0Copy(GOOD, opts({ callWith: 'our team', repFirstName: 'Reece Team' })).includes('call_names_other'));
});

test('position 5: no question, signed " - Reece Team", never a person', () => {
  const p5 = 'James, we will leave it here for now. If anything changes with those rotting windows, we are a text away.';
  const o = opts({ position: 5, slots: { hesitation: null, affirm: null, reframe: null, if_i_could: null } });
  assert.deepEqual(checkF0Copy(`${p5} - Reece Team`, o), []);
  assert.deepEqual(checkF0Copy(`${p5}\n- The Reece Team`, o), []);
  assert.ok(checkF0Copy(`${p5} — Reece Team`, o).includes('em_dash'));
  assert.ok(checkF0Copy(`${p5} - John`, o).includes('signed_as_person'));
  assert.ok(checkF0Copy(p5, o).includes('missing_signature'));
  assert.ok(checkF0Copy(`James, I will leave it here for now. I am a text away. - Reece Team`, o).includes('first_person'));
});

test('rep voice is unchanged: "If I could" and "- John" still pass there', () => {
  const rep = { ...opts(), voice: 'rep' };
  assert.deepEqual(checkF0Copy(GOOD.replace('If we could', 'If I could'), rep), []);
  const p5 = 'James, I will leave it here for now. If anything changes with those rotting windows, I am a text away. - John';
  assert.deepEqual(checkF0Copy(p5, { ...rep, position: 5, slots: { hesitation: null, affirm: null, reframe: null, if_i_could: null } }), []);
});

test('the re-write note speaks to the team text', () => {
  const note = f0RetryNote(['first_person', 'missing_signature', 'signed_as_person', 'signature_in_body', 'no_call_question'], { position: 5, formula: 'four_step', voice: 'team' });
  assert.match(note, /Write as the Reece Team/);
  assert.match(note, /Sign " - Reece Team" at the very end/);
  assert.match(note, /the last text signs " - Reece Team"/);
  assert.match(note, /End the text on the call question/);
  assert.match(note, /<CALL WITH>/);
  assert.doesNotMatch(note, /template/);
  // The rep voice keeps its lines.
  assert.match(f0RetryNote(['missing_signature'], { position: 5, formula: 'four_step', voice: 'rep' }), /rep first name/);
});

test('the voice picks the text rows: team = version 3, rep = version 2, v1 reads neither', () => {
  const req = { workflow_code: 'F.0' };
  const sms = (version) => ({ channel: 'sms', version });
  assert.equal(f0FormulaAllows(sms(3), req, { siro: { formula: 'four_step', text_voice: 'team' } }), true);
  assert.equal(f0FormulaAllows(sms(2), req, { siro: { formula: 'four_step', text_voice: 'team' } }), false);
  assert.equal(f0FormulaAllows(sms(2), req, { siro: { formula: 'four_step', text_voice: 'rep' } }), true);
  assert.equal(f0FormulaAllows(sms(3), req, { siro: { formula: 'four_step', text_voice: 'rep' } }), false);
  // A caller that set no voice keeps today's version 2.
  assert.equal(f0FormulaAllows(sms(2), req, { siro: { formula: 'four_step' } }), true);
  assert.equal(f0FormulaAllows(sms(3), req, { siro: { formula: 'four_step' } }), false);
  // v1 never reads a Four-Step row.
  assert.equal(f0FormulaAllows(sms(1), req, { siro: {} }), true);
  assert.equal(f0FormulaAllows(sms(2), req, { siro: {} }), false);
  assert.equal(f0FormulaAllows(sms(3), req, { siro: {} }), false);
});

const NOW = Date.parse('2026-10-22T13:00:00Z');
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
const REQ = { contact_id: 'c1', workflow_code: 'F.0', sequence_position: 2, channel: 'sms' };
const ENV = { F0_FORMULA_MODE: 'four_step', REHASH_TEAM_USER_IDS: 'TYcZ9DcNkuPCFYsFxRFV,u2', REHASH_TEAM_USER_NAMES: 'u2:Maria Lopez' };
const deps = ({ customValue = null, followers = [] } = {}) => ({
  supabase: fakeSupabase({ rehash_stage: [], lp_leads: [{ lp_lead_id: '583321', lp_prospect_id: '470111', created_at_lp: '2026-10-01' }], agentic_messages: [] }),
  readSiroRows: async () => [ROW], getCustomValue: async () => customValue, getContact: async () => ({ followers }), ensureRecordingForLead: async () => 'none',
});

test('loadF0Context: a Four-Step text in team voice calls with the email\'s rep: the custom value, else a rehash-team follower, else "our team"', async () => {
  const both = await loadF0Context(CONTEXT, REQ, { env: ENV, nowMs: NOW, deps: deps({ customValue: 'John', followers: ['u2'] }) });
  assert.equal(both.vars.text_voice, 'team');
  assert.equal(both.vars.call_with, 'John');
  const follower = await loadF0Context(CONTEXT, REQ, { env: ENV, nowMs: NOW, deps: deps({ followers: ['u2'] }) });
  assert.equal(follower.vars.call_with, 'Maria');
  const value = await loadF0Context(CONTEXT, REQ, { env: ENV, nowMs: NOW, deps: deps({ customValue: 'John' }) });
  assert.equal(value.vars.call_with, 'John');
  const none = await loadF0Context(CONTEXT, REQ, { env: ENV, nowMs: NOW, deps: deps() });
  assert.equal(none.vars.call_with, 'our team');
  assert.doesNotMatch(JSON.stringify(none.vars.call_with), /\{\{|Reece Team/);
});

test('loadF0Context: never "a quick call with Reece" (Mark Test, 2026-10-23)', async () => {
  // Mark Test's only follower was a "Reece …" GHL user, off the rehash team.
  const offTeam = await loadF0Context(CONTEXT, REQ, { env: ENV, nowMs: NOW, deps: { ...deps({ customValue: 'John', followers: ['reeceUser'] }), getUserName: async () => 'Reece' } });
  assert.equal(offTeam.vars.call_with, 'John');
  const noValue = await loadF0Context(CONTEXT, REQ, { env: ENV, nowMs: NOW, deps: { ...deps({ followers: ['reeceUser'] }), getUserName: async () => 'Reece' } });
  assert.equal(noValue.vars.call_with, 'our team');
  const reeceValue = await loadF0Context(CONTEXT, REQ, { env: ENV, nowMs: NOW, deps: deps({ customValue: 'Reece' }) });
  assert.equal(reeceValue.vars.call_with, 'our team');
});

test('loadF0Context: rep voice and the v1 formula carry no text voice', async () => {
  const rep = await loadF0Context(CONTEXT, REQ, { env: { ...ENV, F0_TEXT_VOICE: 'rep' }, nowMs: NOW, deps: deps({ customValue: 'John' }) });
  assert.equal(rep.vars.text_voice, 'rep');
  assert.equal(rep.vars.call_with, undefined);
  const v1 = await loadF0Context(CONTEXT, REQ, { env: { ...ENV, F0_FORMULA_MODE: 'v1' }, nowMs: NOW, deps: deps({ customValue: 'John' }) });
  assert.equal(v1.vars.text_voice, undefined);
  assert.equal(v1.vars.call_with, undefined);
});

test('the V3 seed: 35 inactive rows, CALL WITH, and every example in the team voice', () => {
  const sql = fs.readFileSync(new URL('../sql/seeds/2026-10-23_f0_v2_four_step_team_voice.sql', import.meta.url), 'utf8');
  const codes = [...new Set(sql.match(/F\.0-P[1-5]-[a-z-]+-V3/g))];
  assert.equal(codes.length, 35);
  assert.equal((sql.match(/1500, 0\.7, false, 3, \$f0\$four-step-team\$f0\$/g) || []).length, 35, 'every row inactive, version 3');
  assert.doesNotMatch(sql, /active = excluded\.active/);
  assert.match(sql, /CALL WITH: \{\{siro\.call_with\}\}/);
  assert.doesNotMatch(sql, /REP FIRST NAME|rehash_rep_first_name/);
  assert.match(sql, /signs " - Reece Team"/);
  const goods = [...new Set([...sql.matchAll(/- GOOD \((?:[a-z-]+|position [345])\): ([^\n]+)/g)].map(m => m[1]))];
  assert.equal(goods.length, 10, 'seven objection examples and positions 3, 4 and 5');
  for (const g of goods) {
    assert.doesNotMatch(g.replace(/ - Reece Team$/, ''), /\bI\b|\b(?:me|my)\b/, g);
    if (/ - Reece Team$/.test(g)) { assert.doesNotMatch(g, /\?/, g); continue; }
    assert.match(closingQuestion(g), /\bcall with John\b/, g);
    assert.doesNotMatch(g, /- John$/, g);
  }
  assert.match(sql, /BAD, written as one person and signed by them/);
});

// 2026-10-23 (the user): "We keep saying 'Would a quick call with John make
// sense?' but we don't explain why." The Reece Team close names the reason.
test('no_call_reason: a team close with no budget / better price reason fails; the rep voice is unchanged', () => {
  const bare = `${STEM} There may be a way to make it work better for you. Would a quick call with John help?`;
  assert.ok(checkF0Copy(bare, opts({ slots: { ...SLOTS, if_i_could: null } })).includes('no_call_reason'));
  const inQuestion = `${STEM} Would a call with John make sense if we could fit this into your budget?`;
  assert.ok(!checkF0Copy(inQuestion, opts({ slots: { ...SLOTS, if_i_could: null } })).includes('no_call_reason'));
  const better = `${STEM} We may be able to get you a better price. Could a quick call with John help?`;
  assert.ok(!checkF0Copy(better, opts({ slots: { ...SLOTS, if_i_could: null } })).includes('no_call_reason'));
  assert.ok(!checkF0Copy(bare, { ...opts({ slots: { ...SLOTS, if_i_could: null } }), voice: 'rep', repFirstName: 'John' }).includes('no_call_reason'));
});
