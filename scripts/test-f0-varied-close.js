/**
 * F.0 v2: the close is a strategy, not a script — scripts/test-f0-varied-close.js (the user, 2026-10-22)
 * Run: node --test scripts/test-f0-varied-close.js
 *
 * "The messages repeat 'if I could would you' a little too much … this is just
 * the overall strategy but we do not need to say word for word." Any
 * conditional offer counts, and a close that repeats one we already sent fails.
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeSupabase } from './lib/fake-supabase.js';

const { checkF0Copy, f0RetryNote } = await import('../src/siro/f0-copy-checks.js');
const { CONDITIONAL_OFFER_RX, closingQuestion, closeOpener, closeRepeats, earlierClosesLine } = await import('../src/siro/f0-four-step.js');
const { loadF0Context, earlierOutbound } = await import('../src/siro/f0-context.js');

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
  if_i_could: 'make the numbers work better for you both',
};
const STEM = 'James, it makes sense that you want your grandson to look over the numbers first. Getting those rotting windows replaced before the family visits for Christmas still matters.';
const opts = (extra = {}) => ({ facts: FACTS, position: 2, repFirstName: 'John', formula: 'four_step', slots: SLOTS, firstName: 'James', ...extra });

test('the close may be worded any way that offers to make it work better', () => {
  const closes = [
    'If I could make the numbers work better for you both, would you be open to a quick call with John?',
    'If there is a way to make the numbers work better for you both, would a quick call with John be worth it?',
    'I may be able to make the numbers work better for you both. Would you be open to a quick call with John to see?',
    'Would a quick call with John help, to see if we can make the numbers work better for you both?',
    'There may be a way to make the numbers work better for you both. Is a quick call with John worth a few minutes?',
  ];
  for (const c of closes) assert.deepEqual(checkF0Copy(`${STEM} ${c}`, opts()), [], c);
  // No offer at all is still a fail: the strategy stays.
  assert.ok(checkF0Copy(`${STEM} Would you be open to a quick call with John?`, opts()).includes('no_conditional_offer'));
  assert.ok(CONDITIONAL_OFFER_RX.test('If we can make this easier to say yes to, would a quick call with John help?'));
});

test('a close that repeats one we already sent fails', () => {
  const sent = [`${STEM} If I could make the numbers work better for you both, would you be open to a quick call with John?`];
  // "if I/we could" once per thread, the email's "If we could" included.
  const again = `${STEM} If I could make the numbers work better for you both, would a quick call with John help?`;
  assert.ok(checkF0Copy(again, opts({ earlierMessages: sent })).includes('close_repeated'));
  const emailSent = ['<p>Hi James,</p><p>If we could make it work better, would you be open to a quick call with John?</p><p>The Reece Team</p>'];
  assert.ok(checkF0Copy(again, opts({ earlierMessages: emailSent })).includes('close_repeated'));
  // The same four opening words count too.
  const sameOpen = [`${STEM} Would a quick call with John help, to see what we can do?`];
  assert.ok(checkF0Copy(`${STEM} Would a quick call with John help, to see if we can make the numbers work better for you both?`, opts({ earlierMessages: sameOpen })).includes('close_repeated'));
  // A new wording passes.
  assert.deepEqual(checkF0Copy(`${STEM} If there is a way to make the numbers work better for you both, would a quick call with John be worth it?`, opts({ earlierMessages: sent })), []);
  // Our earlier message with no question (P5) and the lead's own words never count.
  assert.equal(closeRepeats(`${STEM} If I could help, would a call with John help?`, ['I will leave it here. - John']), false);
  assert.match(f0RetryNote(['close_repeated'], { position: 2, formula: 'four_step' }), /new way/);
});

test('close helpers: the last question, its opener, the EARLIER CLOSES line', () => {
  assert.equal(closingQuestion('Hi. One thing. Would a call help?'), 'Would a call help?');
  assert.equal(closingQuestion('No question here.'), '');
  assert.equal(closeOpener('If we could make it work, would you?'), closeOpener('If I could make it work, would you?'));
  assert.equal(earlierClosesLine([]), 'none');
  assert.equal(earlierClosesLine(['A. Would a call with John help?', 'B. Would a call with John help?']), '- Would a call with John help?');
  assert.deepEqual(earlierOutbound([{ direction: 'inbound', text: 'hi' }, { direction: 'outbound', body: 'ours?' }]), ['ours?']);
});

test('loadF0Context shows the prompt our earlier closes and passes them to the checks', async () => {
  const context = {
    lp: { lead_id: '583321', prospect_id: '470111', disposition: 'OPPFDN', demo_date: '2026-10-20T22:00:00Z', demo_completed: true },
    lead: { current_tags: ['active-f.0'], phone: '3525550188', first_name: 'James' },
    conversation_recent: [
      { direction: 'outbound', text: 'James, that makes sense. If I could make it work better, would you be open to a quick call with John?' },
      { direction: 'inbound', text: 'Maybe next week' },
    ],
    lead_facts: { note_dq: null },
  };
  const deps = {
    supabase: fakeSupabase({ rehash_stage: [], lp_leads: [], agentic_messages: [] }),
    readSiroRows: async () => [], getCustomValue: async () => 'John', getContact: async () => null, ensureRecordingForLead: async () => 'none',
  };
  const out = await loadF0Context(context, { contact_id: 'c1', workflow_code: 'F.0', sequence_position: 2, channel: 'sms' }, { env: { F0_FORMULA_MODE: 'four_step' }, nowMs: Date.parse('2026-10-22T13:00:00Z'), deps });
  assert.equal(out.vars.earlier_closes, '- If I could make it work better, would you be open to a quick call with John?');
  assert.equal(out.earlierMessages.length, 1);
});

test('the varied-close seed: every good example passes, and no two examples close the same way', () => {
  const sql = fs.readFileSync(new URL('../sql/seeds/2026-10-22_f0_v2_four_step_varied_close.sql', import.meta.url), 'utf8');
  assert.equal((sql.match(/\$f0\$F\.0-P[1-5]-[a-z-]+-V2\$f0\$/g) || []).length, 35);
  assert.doesNotMatch(sql, /active = excluded\.active/);
  assert.match(sql, /EARLIER CLOSES \(never reuse their wording\):\n\{\{siro\.earlier_closes\}\}/);
  assert.match(sql, /a STRATEGY, not a script/);
  const goods = [...new Set([...sql.matchAll(/- GOOD \((?:[a-z-]+|position [34])\): ([^\n]+)/g)].map(m => m[1]))];
  assert.equal(goods.length, 9, 'seven objection examples and positions 3 and 4');
  const openers = new Set();
  let ifCould = 0;
  for (const g of goods) {
    const q = closingQuestion(g);
    assert.ok(CONDITIONAL_OFFER_RX.test(g), g);
    assert.match(q, /\bJohn\b/, g);
    assert.match(q, /\bcall\b/, g);
    openers.add(closeOpener(q));
    if (/\bif\s+(?:i|we)\s+could\b/i.test(g)) ifCould++;
  }
  assert.ok(ifCould <= 1, `"if I could" in ${ifCould} examples`);
  assert.ok(openers.size >= 7, `only ${openers.size} different closes`);
});
