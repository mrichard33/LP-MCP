// The GHL contact id on a Slack card is a link to its GHL contact (the user, 2026-10-19).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GHL_CONTACT_URL_DEFAULT, ghlContactUrlBase, ghlContactUrl, linkSlackContacts,
  slackMessageText, slackMessageBlocks, normalizeSlackText, normalizeSlackBlocks,
} from '../src/slack-phone-format.js';

const GHL = 'https://app.gohighlevel.com/v2/location/SsBG7j5KQAIP1SFP2Sca/contacts/detail/';
const LP = 'https://br27a.leadperfection.com/leaddetail.html?custid=';
const ID = 'gxMVJgLkjFCVxTTLnn8A';

test('the GHL base: ours by default, GHL_LOCATION_ID when set', () => {
  assert.equal(GHL_CONTACT_URL_DEFAULT, GHL);
  assert.equal(ghlContactUrlBase({ GHL_LOCATION_ID: 'Abc123Def456Ghi789Jk' }), 'https://app.gohighlevel.com/v2/location/Abc123Def456Ghi789Jk/contacts/detail/');
  assert.equal(ghlContactUrlBase({ GHL_LOCATION_ID: 'bad/value' }), GHL);
  assert.equal(ghlContactUrl(ID), `${GHL}${ID}`);
  assert.equal(ghlContactUrl(''), null);
});

test('every label a card uses for the contact id is linked', () => {
  assert.equal(linkSlackContacts(`Contact ID: ${ID}`), `<${GHL}${ID}|Contact ID: ${ID}>`);
  assert.equal(linkSlackContacts(`Contact: ${ID}`), `<${GHL}${ID}|Contact: ${ID}>`);
  assert.equal(linkSlackContacts(`👤 contact: ${ID} | Window Estimate`), `👤 <${GHL}${ID}|contact: ${ID}> | Window Estimate`);
  assert.equal(linkSlackContacts(`LP: x | GHL: ${ID}`), `LP: x | <${GHL}${ID}|GHL: ${ID}>`);
  assert.equal(linkSlackContacts(`Jane (GHL ${ID}) · in GHL`), `Jane (<${GHL}${ID}|GHL ${ID}>) · in GHL`);
  assert.equal(linkSlackContacts(`against contact ${ID}.`), `against <${GHL}${ID}|contact ${ID}>.`);
});

test('no link for a non-GHL value, inside a link, a URL or code', () => {
  for (const t of [
    'Contact ID: unknown', 'GHL: abc', 'Contact: 58169512345678901234', 'contact sim-abc', 'Contact: abcdefghijklmnopqrst',
    `already <https://x.com|Contact ID: ${ID}>`, `code \`Contact: ${ID}\``,
    `GHL: ${GHL}${ID}`, `Open: ${GHL}${ID}?contact=${ID}`,
  ]) {
    assert.equal(linkSlackContacts(t), t, t);
  }
});

test('the user\'s card: both the contact and the prospect are links', () => {
  const card = `   Contact ID: ${ID} | Prospect: 424550`;
  assert.equal(slackMessageText(card, LP, GHL), `   <${GHL}${ID}|Contact ID: ${ID}> | <${LP}424550|Prospect: 424550>`);
  // GroupMe (the plain pass) never carries Slack markup.
  assert.equal(normalizeSlackText(card), card);
});

test('blocks: only mrkdwn text gets the link', () => {
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `Contact: ${ID}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `Contact: ${ID}` } },
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open' }, value: `Contact: ${ID}` }] },
  ];
  const out = slackMessageBlocks(blocks, LP, GHL);
  assert.equal(out[0].text.text, `Contact: ${ID}`);
  assert.equal(out[1].text.text, `<${GHL}${ID}|Contact: ${ID}>`);
  assert.equal(out[2].elements[0].value, `Contact: ${ID}`);
  assert.deepEqual(normalizeSlackBlocks(blocks), blocks);
});
