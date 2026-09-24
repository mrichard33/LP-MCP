import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIELD, resolveServiceMarket, pickIssueText, formatPhone, buildServiceCard, isSoldCustomer,
} from '../src/actions/service-card.js';

const cf = (pairs) => ({ customFields: Object.entries(pairs).map(([id, value]) => ({ id, value })) });

test('Lakeland office overrides ORL market', () => {
  const c = cf({ [FIELD.MARKET]: 'ORL', [FIELD.SERVICING_OFFICE]: '5110 S Florida Ave, Suite 105, Lakeland 33813' });
  assert.equal(resolveServiceMarket(c, 'ORL'), 'LAKE');
});

test('ORL without Lakeland office stays ORL', () => {
  assert.equal(resolveServiceMarket(cf({ [FIELD.MARKET]: 'ORL' }), null), 'ORL');
  assert.equal(resolveServiceMarket(cf({ [FIELD.SERVICING_OFFICE]: 'Orlando office' }), 'ORL'), 'ORL');
});

test('no market resolves to null (falls back to #contact-center)', () => {
  assert.equal(resolveServiceMarket({}, null), null);
});

test('a joined legacy market value is not a code (falls back to #contact-center)', () => {
  assert.equal(resolveServiceMarket(cf({ [FIELD.MARKET]: 'LAKE, FTMYR' }), null), null);
});

test('issue text prefers chat summary, then AI summary, then message, then transcript', () => {
  assert.equal(pickIssueText(cf({ [FIELD.CHAT_SUMMARY]: 'A', [FIELD.AI_SHORT_SUMMARY]: 'B' })), 'A');
  assert.equal(pickIssueText(cf({ [FIELD.AI_SHORT_SUMMARY]: 'B' }), { message_text: 'C' }), 'B');
  assert.equal(pickIssueText({}, { message_text: 'C' }), 'C');
  assert.match(pickIssueText({}), /No details were saved/);
});

test('long issue text is trimmed under the limit', () => {
  const long = 'Screens will not latch. '.repeat(60);
  assert.ok(pickIssueText(cf({ [FIELD.CHAT_SUMMARY]: long })).length <= 451);
});

test('phone formats to (xxx) xxx-xxxx', () => {
  assert.equal(formatPhone('+14074503223'), '(407) 450-3223');
  assert.equal(formatPhone(''), 'No phone on file');
});

test('card carries name, phone, issue, market and link', () => {
  const text = buildServiceCard({
    name: 'Steven Homenda', phone: '+14074503223', contact: { type: 'customer', city: 'Ocoee' },
    marketCode: 'LAKE', issue: 'Slider screens will not latch.', contactId: 'abc', tag: 'customer-service-request',
  });
  assert.match(text, /SERVICE REQUEST · Lakeland/);
  assert.match(text, /Customer: Steven Homenda/);
  assert.match(text, /Phone: \(407\) 450-3223/);
  assert.match(text, /What they need: Slider screens will not latch\./);
  assert.match(text, /Sold customer: Yes/);
  assert.match(text, /contacts\/detail\/abc/);
  assert.ok(text.length < 1000, 'must fit GroupMe 1000-char limit');
});

test('sold customer detection', () => {
  assert.equal(isSoldCustomer({ tags: ['deal-won'] }), true);
  assert.equal(isSoldCustomer({ tags: ['lead'] }), false);
});
