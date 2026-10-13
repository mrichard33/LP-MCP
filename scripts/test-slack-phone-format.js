/**
 * test-slack-phone-format.js — phone numbers on Slack cards are digits only
 * (the user, 2026-10-13: "list the number with numbers only ##########", the
 * full number, never the last four).
 *
 * Run: node --test scripts/test-slack-phone-format.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { slackPhone } from '../src/format-helpers.js';
import { normalizeSlackPhones, normalizeSlackBlocks } from '../src/slack-phone-format.js';

test('slackPhone: 10 digits, no symbols or spacing', () => {
  for (const raw of ['+13525550188', '(352) 555-0188', '352-555-0188', '352.555.0188', '1 352 555 0188', '3525550188']) {
    assert.equal(slackPhone(raw), '3525550188', raw);
  }
  assert.equal(slackPhone('12345'), '12345', 'a short number keeps its digits, never invented');
  assert.equal(slackPhone(''), null);
  assert.equal(slackPhone(null), null);
  assert.equal(slackPhone('no phone'), null);
});

test('normalizeSlackPhones rewrites every phone shape', () => {
  const cases = {
    '(352) 555-0188': '3525550188',
    '(352)555-0188': '3525550188',
    '(239)250-0011': '2392500011',
    '352-555-0188': '3525550188',
    '352.555.0188': '3525550188',
    '+1 352 555 0188': '3525550188',
    '+13525550188': '3525550188',
    '1-352-555-0188': '3525550188',
    'Contact: Jane · (561) 373-9673 · Rep: Mike': 'Contact: Jane · 5613739673 · Rep: Mike',
  };
  for (const [input, want] of Object.entries(cases)) assert.equal(normalizeSlackPhones(input), want, input);
});

test('normalizeSlackPhones never touches dates, times, money, ids or a Slack ts', () => {
  for (const t of ['2026-10-13', '10:00 AM', '$1,500 today', 'LP lead 581695', 'ts 1700000000.000200', '3525550188',
    '13525550188', 'id 123-456-78901', 'v1.2.3', '1760000000000']) {
    assert.equal(normalizeSlackPhones(t), t, t);
  }
});

test('blocks: only text strings change, never a button value', () => {
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: '*Bob* · (352) 555-0188' } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: 'call +1 352 555 0188' }] },
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Approve' }, action_id: 'x', value: '(352) 555-0188' }] },
  ];
  const out = normalizeSlackBlocks(blocks);
  assert.equal(out[0].text.text, '*Bob* · 3525550188');
  assert.equal(out[1].elements[0].text, 'call 3525550188');
  assert.equal(out[2].elements[0].value, '(352) 555-0188');
  assert.equal(blocks[0].text.text, '*Bob* · (352) 555-0188', 'the input is not mutated');
});
