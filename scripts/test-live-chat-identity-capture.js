/**
 * Live chat → GHL fields — scripts/test-live-chat-identity-capture.js
 *
 * 2026-10-02 review: the old capture overwrote what was on file, never saved a
 * name typed alone or a zip/address, lost everything on one bad email, and
 * could write onto a merged contact. Cases below are real chats (Lori, Danh).
 *
 * Run: node --test scripts/test-live-chat-identity-capture.js
 */

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { chatIdentity, hasIdentity, captureChatIdentity } = await import('../src/live-chat/identity-capture.js');
const { buildPromotionPayload } = await import('../src/services/identity-extraction.js');

const GUEST = { id: 'C1', firstName: 'Guest', lastName: 'Visitor vnazu', email: null, phone: null };

function deps(contact) {
  const calls = [];
  return {
    calls,
    d: {
      fetchContact: async () => contact,
      promote: async (contactId, state, opts) => {
        const { payload } = buildPromotionPayload(opts.current, state.identity);
        calls.push({ contactId, payload });
        return { written: Object.keys(payload).length, conflicts: 0 };
      },
    },
  };
}

test('a name typed on its own is saved over the Guest Visitor placeholder', async () => {
  const { calls, d } = deps(GUEST);
  await captureChatIdentity('C1', { visitorTexts: ['hi'], capture: { name: 'Lori Bridges' } }, d);
  assert.deepEqual(calls[0].payload, { firstName: 'Lori', lastName: 'Bridges' });
});

test('Lori: name, phone, email and the street address with zip all land, fill-if-empty', async () => {
  const { calls, d } = deps(GUEST);
  await captureChatIdentity('C1', { visitorTexts: ['Lori Bridges 508-208-9802 thank you!', 'lbridges814@gmail.com', '9822 Quinta Artesa Way Apt 101 fort Myers 33908'], capture: { name: 'Lori Bridges', phone: '508-208-9802' } }, d);
  const p = calls[0].payload;
  assert.equal(p.firstName, 'Lori');
  assert.equal(p.phone, '+15082089802');
  assert.equal(p.email, 'lbridges814@gmail.com');
  assert.match(p.address1, /9822 Quinta Artesa Way/);
  assert.equal(p.postalCode, '33908');
});

test('what is already on file is never overwritten', async () => {
  const { calls, d } = deps({ id: 'C1', firstName: 'Danh', lastName: 'Ho', email: 'danh.ho@hotmail.com', phone: '+16572420815' });
  await captureChatIdentity('C1', { visitorTexts: ['other@example.com'], capture: { name: 'Dan', email: 'other@example.com' } }, d);
  assert.deepEqual(calls[0].payload, {});
});

test('a malformed email is left out; the phone still lands', async () => {
  const id = chatIdentity({ visitorTexts: ['my email is lori@gmail'], capture: { phone: '508 208 9802', email: 'lori@gmail', email_malformed: true } });
  assert.equal(id.email, null);
  assert.equal(id.phone, '+15082089802');
});

test('a merged-away contact gets no write at all', async () => {
  const gone = deps(null);
  assert.equal((await captureChatIdentity('C1', { capture: { phone: '5082089802' } }, gone.d)).reason, 'contact_gone_or_merged');
  assert.equal(gone.calls.length, 0);
  const other = deps({ id: 'SURVIVOR' });
  assert.equal((await captureChatIdentity('C1', { capture: { phone: '5082089802' } }, other.d)).reason, 'contact_gone_or_merged');
});

test('nothing to capture → no GHL read', async () => {
  let reads = 0;
  const r = await captureChatIdentity('C1', { visitorTexts: ['they are old'], capture: {} }, { fetchContact: async () => { reads++; return GUEST; } });
  assert.equal(r.reason, 'nothing_to_capture');
  assert.equal(reads, 0);
  assert.equal(hasIdentity(chatIdentity({ visitorTexts: ['Guest Visitor'] })), false);
});
