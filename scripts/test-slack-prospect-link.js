// The prospect on a Slack card is a link to its LP lead page (the user, 2026-10-16:
// "Can all Slack cards include a hyperlink that ends with the custom Prospect ID …
// Link to the Lead Perfection lead."). The link is added once, at the Slack send
// points (postToSlack, updateSlackMessage, the approval respond()), from the
// "Prospect 463174" every card already prints. GroupMe stays plain text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  LP_PROSPECT_URL_DEFAULT, lpProspectUrlBase, lpProspectUrl, linkSlackProspects,
  slackMessageText, slackMessageBlocks, normalizeSlackText, normalizeSlackBlocks,
} from '../src/slack-phone-format.js';

const BASE = 'https://br27a.leadperfection.com/leaddetail.html?custid=';

test('the default page is the br27a lead page, ending in the prospect id', () => {
  assert.equal(LP_PROSPECT_URL_DEFAULT, BASE);
  assert.equal(lpProspectUrl('463174'), `${BASE}463174`);
  assert.equal(lpProspectUrl(null), null);
  assert.equal(lpProspectUrl('unknown'), null);
});

test('LP_PROSPECT_URL_BASE overrides the page only with an http(s) URL', () => {
  assert.equal(lpProspectUrlBase({}), BASE);
  assert.equal(lpProspectUrlBase({ LP_PROSPECT_URL_BASE: 'not a url' }), BASE);
  assert.equal(lpProspectUrlBase({ LP_PROSPECT_URL_BASE: 'https://br99.leadperfection.com/x?custid=' }), 'https://br99.leadperfection.com/x?custid=');
});

test('every prospect shape on a card becomes a link with the same words', () => {
  assert.equal(linkSlackProspects('📋 LP: Prospect 454810 | GHL: abc'), `📋 LP: <${BASE}454810|Prospect 454810> | GHL: abc`);
  assert.equal(linkSlackProspects('Prospect: 462947'), `<${BASE}462947|Prospect: 462947>`);
  assert.equal(linkSlackProspects('LP Prospect ID: 462947'), `LP <${BASE}462947|Prospect ID: 462947>`);
  assert.equal(linkSlackProspects('*Prospect 463174*'), `*<${BASE}463174|Prospect 463174>*`);
  // Each card links its own prospect.
  assert.equal(linkSlackProspects('Prospect 1111 and Prospect 2222'), `<${BASE}1111|Prospect 1111> and <${BASE}2222|Prospect 2222>`);
});

test('no link without an id, inside a link, inside code, or on a date', () => {
  for (const t of ['LP Prospect: unknown', 'Prospect not yet assigned', 'already <https://x.com|Prospect 222222>', 'code `Prospect 111111`', '```Prospect 111111```', 'prospect 2026-10-16']) {
    assert.equal(linkSlackProspects(t), t, t);
  }
});

test('the Slack text pass still drops lead ids and formats phones first', () => {
  assert.equal(slackMessageText('LP Lead: 581695 | Prospect: 462947 · (352) 555-0188', BASE),
    `LP Lead | <${BASE}462947|Prospect: 462947> · 3525550188`);
  // The plain pass (GroupMe) never carries Slack markup.
  assert.equal(normalizeSlackText('Prospect 462947'), 'Prospect 462947');
});

test('blocks: only mrkdwn text gets the link; plain_text, buttons and values do not', () => {
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Prospect 463174' } },
    { type: 'section', text: { type: 'mrkdwn', text: 'LP: Prospect 463174' }, fields: [{ type: 'mrkdwn', text: 'Prospect 9001' }] },
    { type: 'context', elements: [{ type: 'mrkdwn', text: 'Prospect 9002' }] },
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open' }, value: 'Prospect 463174' }] },
  ];
  const out = slackMessageBlocks(blocks, BASE);
  assert.equal(out[0].text.text, 'Prospect 463174');
  assert.equal(out[1].text.text, `LP: <${BASE}463174|Prospect 463174>`);
  assert.equal(out[1].fields[0].text, `<${BASE}9001|Prospect 9001>`);
  assert.equal(out[2].elements[0].text, `<${BASE}9002|Prospect 9002>`);
  assert.equal(out[3].elements[0].value, 'Prospect 463174');
  assert.deepEqual(normalizeSlackBlocks(blocks), blocks, 'the plain pass adds no link');
});

test('every Slack send point uses the linking pass; GroupMe uses the plain one', () => {
  const slack = fs.readFileSync(new URL('../src/slack.js', import.meta.url), 'utf8');
  const approvals = fs.readFileSync(new URL('../src/slack-approvals.js', import.meta.url), 'utf8');
  const groupme = fs.readFileSync(new URL('../src/groupme.js', import.meta.url), 'utf8');
  for (const [name, src] of [['slack.js', slack], ['slack-approvals.js', approvals]]) {
    assert.doesNotMatch(src, /normalizeSlack(?:Text|Blocks)\(/, `${name} must send through slackMessageText / slackMessageBlocks`);
  }
  assert.equal((slack.match(/text: slackMessageText\(/g) || []).length, 2, 'postToSlack and updateSlackMessage');
  assert.match(approvals, /text: slackMessageText\(body\.text\)/);
  assert.doesNotMatch(groupme, /slackMessage(?:Text|Blocks)\(/, 'GroupMe shows Slack markup as raw text');
});
