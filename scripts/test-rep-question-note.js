// "I don't know, I'll leave John a note", backed by a real note (the user,
// 2026-10-24). Only in REHASH_VOICE_MODE=assistant.
import test from 'node:test';
import assert from 'node:assert/strict';

const { repQuestionFor, promisesRepNote, normalizeAskRep, repQuestionKey, repQuestionTask } = await import('../src/services/rep-question.js');
const { fileRepQuestion } = await import('../src/services/rep-question-io.js');

test('the model\'s ask_rep is filed; a note promised with no ask_rep is filed from the lead\'s words', () => {
  assert.deepEqual(repQuestionFor({ voice: 'assistant', askRep: ' Is the glass laminated? ', reply: 'x' }), { question: 'Is the glass laminated?', source: 'model' });
  assert.deepEqual(repQuestionFor({ voice: 'assistant', askRep: null, reply: "I don't know that one, so I'll leave John a note and he'll get back to you.", trigger: 'Does the warranty cover salt air?' }),
    { question: 'Does the warranty cover salt air?', source: 'promise_backed' });
  // 2026-10-24 (the user picked the Reece Team voice): team files too; the rep voice and no rehash line do not.
  assert.deepEqual(repQuestionFor({ voice: 'team', askRep: 'Is the glass laminated?' }), { question: 'Is the glass laminated?', source: 'model' });
  assert.equal(repQuestionFor({ voice: 'team', reply: "Good question, I don't know. We'll have John get back to you on it.", trigger: 'Is it laminated?' })?.source, 'promise_backed');
  assert.equal(repQuestionFor({ voice: 'rep', askRep: 'Is the glass laminated?' }), null, 'never in the rep voice');
  assert.equal(repQuestionFor({ voice: null, askRep: 'Is the glass laminated?' }), null, 'never off the rehash line');
  assert.equal(repQuestionFor({ voice: 'assistant', askRep: 'null', reply: 'Happy to help.' }), null);
});

test('what counts as a promised note', () => {
  assert.ok(promisesRepNote("I'll leave John a note about that."));
  assert.ok(promisesRepNote("Let me ask John and get back to you."));
  assert.ok(promisesRepNote("I'll pass that along to John."));
  assert.ok(!promisesRepNote('John can give you a quick call.'));
  assert.equal(normalizeAskRep('  N/A '), null);
  assert.equal(repQuestionKey('Is the GLASS laminated??'), repQuestionKey('is the glass laminated'));
});

test('the task names the question and never a pronoun for the rep', () => {
  const t = repQuestionTask({ firstName: 'Mark', rep: 'John', question: 'Does it cover salt air?', recent: [{ direction: 'inbound', text: 'Does it cover salt air?' }] });
  assert.match(t.title, /Mark/);
  assert.match(t.note, /QUESTION FOR JOHN/);
  assert.doesNotMatch(`${t.body} ${t.note} ${t.card}`, /\b(?:he|him|his|she|her)\b/i);
});

const fakeDeps = (over = {}) => {
  const calls = { tasks: [], notes: [], cards: [], ops: [] };
  const seen = new Set();
  return {
    calls,
    deps: {
      env: { REHASH_TEAM_USER_IDS: 'TYcZ9DcNkuPCFYsFxRFV' }, log: () => {}, nowMs: Date.parse('2026-10-23T22:00:00Z'),
      getContact: async () => ({ firstName: 'Mark', followers: [] }),
      resolveRep: async () => 'John',
      ghlFetch: async (method, path, body) => { calls.tasks.push({ method, path, body }); return {}; },
      addGHLNote: async (id, note) => { calls.notes.push(note); },
      postToSlack: async (text, channel) => { calls.cards.push({ text, channel }); return { ok: true, ts: '1' }; },
      opsAlert: async (t) => { calls.ops.push(t); },
      filterNew: async ({ items }) => ({ fresh: items.filter(i => !seen.has(i.key + i.reason)) }),
      recordPosted: async ({ items }) => { items.forEach(i => seen.add(i.key + i.reason)); },
      emitEvent: async () => {},
      ...over,
    },
  };
};

test('filing: a task for the rep due next business day, a note, one card; the same question once', async () => {
  const { calls, deps } = fakeDeps();
  const r = await fileRepQuestion({ contactId: 'c1', question: 'Does it cover salt air?' }, deps);
  assert.equal(r.filed, true);
  assert.equal(calls.tasks[0].path, '/contacts/c1/tasks');
  assert.equal(calls.tasks[0].body.assignedTo, 'TYcZ9DcNkuPCFYsFxRFV');
  assert.equal(calls.tasks[0].body.dueDate, '2026-10-26T16:00:00.000Z', 'Friday night → Monday 12:00 ET');
  assert.equal(calls.notes.length, 1);
  assert.equal(calls.cards.length, 1);
  assert.match(calls.cards[0].text, /QUESTION FOR JOHN/);
  const again = await fileRepQuestion({ contactId: 'c1', question: 'does it cover SALT AIR' }, deps);
  assert.equal(again.reason, 'already_filed');
  const other = await fileRepQuestion({ contactId: 'c1', question: 'How long is the install?' }, deps);
  assert.equal(other.filed, true, 'a different question the same day still files');
});

test('a failed card is an ops line, and the task still files', async () => {
  const { calls, deps } = fakeDeps({ postToSlack: async () => ({ ok: false, error: 'not_in_channel' }) });
  const r = await fileRepQuestion({ contactId: 'c2', question: 'Is it laminated?' }, deps);
  assert.equal(r.task, 'created');
  assert.match(r.card, /not_in_channel/);
  assert.equal(calls.ops.length, 1);
});

test('2026-10-24 gate: "I\'ll have John confirm that detail" is a promise a note must back', async () => {
  const { promisesRepNote } = await import('../src/services/rep-question.js');
  assert.ok(promisesRepNote("I don't want to guess on the exact salt spray wording, so I'll have John confirm that detail for you."));
  assert.ok(promisesRepNote("We'll have John look into that and get back to you."));
  assert.ok(!promisesRepNote('John will give you a call then.'));
});
