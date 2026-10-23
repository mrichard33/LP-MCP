/**
 * F.0 v2 day-4 and day-11 emails — scripts/test-f0-followup-emails.js (the user, 2026-10-23)
 * Run: node --test scripts/test-f0-followup-emails.js
 *
 * "Write personalized when the data is available and use the static as a
 * fallback." GHL positions 7 and 8 are emails written from the visit (internal
 * 6 and 7); when none can be written the contact gets f0-email-fallback and
 * the workflow sends the static email.
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { f0InternalPosition, isF0EmailRequest, isF0FollowupEmail, F0_EMAIL_POSITIONS, closeQuestion, f0EmailOutput } = await import('../src/siro/f0-email.js');
const { splitTeamSignature } = await import('../src/siro/f0-copy-checks.js');
const { previewF0Position } = await import('../src/tools/siro-tools.js');
const { runNurtureGeneration } = await import('../src/nurture/nurture-orchestrator.js');
const { coerceSeqPos } = await import('../src/nurture/nurture-sequence-resolver.js');

test('GHL 7 and 8 by email are the follow-up emails (internal 6 and 7)', () => {
  assert.deepEqual(f0InternalPosition({ channel: 'email', sequence_position: 7 }), { position: 6, ghlPosition: 7, legacy: false });
  assert.deepEqual(f0InternalPosition({ channel: 'email', sequence_position: '8' }), { position: 7, ghlPosition: 8, legacy: false });
  // Unchanged: the evening email and the texts.
  assert.deepEqual(f0InternalPosition({ channel: 'email', sequence_position: 1 }), { position: 0, ghlPosition: 1, legacy: false });
  assert.deepEqual(f0InternalPosition({ channel: 'sms', sequence_position: 6 }), { position: 5, ghlPosition: 6, legacy: false });
  // Never a text at 7 or 8, never an email at 2-6 or 9.
  for (const [channel, p] of [['sms', 7], ['sms', 8], ['email', 2], ['email', 6], ['email', 9]]) {
    assert.deepEqual(f0InternalPosition({ channel, sequence_position: p }), { error: 'unsupported_position' }, `${channel} ${p}`);
  }
  // The route's resolver passes 7 and 8 through.
  assert.equal(coerceSeqPos(7), 7);
  assert.equal(coerceSeqPos(8), 8);
});

test('every F.0 email is an email request; only 6 and 7 are follow-ups', () => {
  assert.deepEqual([...F0_EMAIL_POSITIONS], [0, 6, 7]);
  const req = (p, channel = 'email') => ({ workflow_code: 'F.0', sequence_position: p, channel });
  for (const p of [0, 6, 7]) assert.equal(isF0EmailRequest(req(p)), true, String(p));
  assert.equal(isF0EmailRequest(req(5)), false);
  assert.equal(isF0EmailRequest(req(6, 'sms')), false);
  assert.equal(isF0EmailRequest({ ...req(6), workflow_code: 'S4.5' }), false);
  assert.equal(isF0FollowupEmail(req(0)), false);
  assert.equal(isF0FollowupEmail(req(6)), true);
  assert.equal(isF0FollowupEmail(req(7)), true);
});

test('the preview takes 7 and 8 as the follow-up emails', () => {
  assert.deepEqual(previewF0Position({ preview_f0_position: 7 }), { position: 6, channel: 'email' });
  assert.deepEqual(previewF0Position({ preview_f0_position: 8 }), { position: 7, channel: 'email' });
  assert.deepEqual(previewF0Position({ preview_f0_position: 1 }), { position: 0, channel: 'email' });
  assert.deepEqual(previewF0Position({ preview_f0_position: 3 }), { position: 2, channel: 'sms' });
  assert.ok(previewF0Position({ preview_f0_position: 7, channel: 'sms' }).error);
});

test('a follow-up email that cannot be written gets the static email; a real stop does not', async () => {
  const run = async (sequence_position, suppressed_reason) => {
    const tags = [];
    await runNurtureGeneration({ contact_id: 'c1', workflow_code: 'F.0', sequence_position, channel: 'email' }, {
      inner: async () => ({ generation_id: 'g', send_ready: false, suppressed_reason }),
      addTag: async (_c, tag) => { tags.push(tag); },
    });
    return tags;
  };
  assert.deepEqual(await run(6, 'no_recording'), ['f0-email-fallback']);
  assert.deepEqual(await run(7, 'email_prompt_inactive'), ['f0-email-fallback']);
  assert.deepEqual(await run(7, 'safety_failed_after_retry'), ['f0-email-fallback']);
  assert.deepEqual(await run(6, 'sold'), []);
  assert.deepEqual(await run(6, 'recent_reply'), []);
});

test('the seed: two active rows at 6 and 7, the evening email\'s rules, examples that pass', () => {
  const sql = fs.readFileSync(new URL('../sql/seeds/2026-10-23_f0_v2_followup_emails.sql', import.meta.url), 'utf8');
  assert.match(sql, /\$f0\$F\.0-P6-email-V2\$f0\$, 'F\.0', 'email', 6, null,/);
  assert.match(sql, /\$f0\$F\.0-P7-email-V2\$f0\$, 'F\.0', 'email', 7, null,/);
  assert.equal((sql.match(/2000, 0\.7, true, 2, /g) || []).length, 2);
  assert.doesNotMatch(sql, /active = excluded\.active/);
  assert.equal((sql.match(/THE EMAIL RULES/g) || []).length, 2);
  assert.equal((sql.match(/CALL WITH: \{\{siro\.call_with\}\}/g) || []).length, 2);
  assert.equal((sql.match(/EARLIER CLOSES/g) || []).length >= 4, true);
  const examples = [...sql.matchAll(/- GOOD body:\n([\s\S]*?)\n- GOOD ps:/g)].map(m => m[1]);
  assert.equal(examples.length, 2);
  for (const ex of examples) {
    const { content } = splitTeamSignature(ex);
    const words = content.split(/\s+/).filter(Boolean).length;
    assert.ok(words >= 120 && words <= 180, `example is ${words} words`);
    assert.equal((ex.match(/\?/g) || []).length, 1, 'one question: the call invite at the end');
    assert.match(ex, /John[^.?!]*\?$/, 'ends on the call with CALL WITH');
    assert.doesNotMatch(ex, /\bif we could\b/i, 'the evening email may have used "if we could"');
    assert.doesNotMatch(ex, /thank you for having us/i, 'the evening email already thanked them');
    assert.doesNotMatch(content, /\bI\b|\b(?:me|my)\b/);
    assert.doesNotMatch(ex, /!|\bdeal\b|founder|—|\$\d/i);
  }
});

// 2026-10-23 (the user): the day-11 preview dropped the "?" on its call invite
// and would have gone out as the static email.
test('a dropped closing "?" is put back; a statement is left alone', () => {
  const day11 = 'Thanks for your time.\n\nIf we could make it work better for you, would you be open to a quick call with John to walk through it with both of you';
  assert.equal(closeQuestion(day11).text, `${day11}?`);
  assert.equal(closeQuestion(`${day11}.`).text, `${day11}?`);
  assert.deepEqual(closeQuestion(`${day11}?`), { text: `${day11}?`, changed: false });
  assert.deepEqual(closeQuestion('We will be here when you are ready.'), { text: 'We will be here when you are ready.', changed: false });
  assert.deepEqual(closeQuestion('We will be here when you are ready'), { text: 'We will be here when you are ready', changed: false });
  const out = f0EmailOutput({ subject: 'S', preheader: 'P', body: day11, slots: {} });
  assert.equal(out.email_plain_body, `${day11}?`);
  assert.equal(out.question_mark_restored, true);
  assert.match(out.body_html, /both of you\?<\/p>$/);
  assert.equal(f0EmailOutput({ subject: 'S', preheader: 'P', body: `${day11}?`, slots: {} }).question_mark_restored, undefined);
});
