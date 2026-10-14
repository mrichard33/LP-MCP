/**
 * Rehash reply routing (John Manieri, 2026-10-14). lp-requeue.js's rehash branch
 * posted "📞 REHASH CALL REQUEST … said yes to a call" with a hard-coded
 * agreed:true for every rehash requeue. Now the card follows the lead's words:
 * a call card only for a call request, a QUOTE REQUEST card, a POST-DEMO
 * CONCERN card, and thanks / still thinking go to the 08:45 ET digest.
 *
 * Run: node --test scripts/test-rehash-reply-route.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeRehashReply } from '../src/notifications/rehash-call.js';
import { buildRehashDigest, digestDays, isDigestTime, runRehashReplyDigest } from '../src/jobs/rehash-reply-digest.js';

const NOW = Date.parse('2026-10-14T15:00:00Z'); // Tue 11:00 ET

function fakeDeps({ slackOk = true, seen = false } = {}) {
  const posts = []; const events = []; const ops = [];
  return {
    posts, events, ops,
    postToSlack: async (text, channel) => { posts.push({ text, channel }); return slackOk ? { ok: true, ts: '1.2' } : { ok: false, error: 'not_in_channel' }; },
    emitEvent: async (e) => { events.push(e); },
    opsAlert: async (t) => { ops.push(t); },
    locationId: 'LOC',
    alreadyRequested: async () => seen,
  };
}
const contact = { firstName: 'Lisa', phone: '+1 (352) 555-0188' };
const route = (text, d, extra = {}) => routeRehashReply({ contactId: 'c1', text, contact, ...extra }, d, { env: {}, nowMs: NOW });

test('thanks and "still thinking" post no card; one digest event each', async () => {
  for (const text of ['Thank you', 'Thinking', 'Melody did a great job.  We learned a lot.']) {
    const d = fakeDeps();
    const r = await route(text, d);
    assert.equal(r.rehash_card, 'digest', text);
    assert.equal(d.posts.length, 0, text);
    assert.equal(d.events.length, 1);
    assert.equal(d.events[0].event_type, 'agentic.f0_rehash_reply_digest');
    assert.match(d.events[0].idempotency_key, /^f0_rehash_digest_c1_2026-10-14$/);
  }
});

test('a quote ask posts the QUOTE REQUEST card, never the call card', async () => {
  const d = fakeDeps();
  const r = await route('Where is my guote?', d, { repName: 'Tim O\'Connor' });
  assert.equal(r.rehash_card, 'quote_request');
  assert.equal(d.posts.length, 1);
  const card = d.posts[0].text;
  assert.match(card, /^📄 QUOTE REQUEST/);
  assert.match(card, /not a call/);
  assert.match(card, /Lisa said: "Where is my guote\?"/);
  assert.match(card, /Rep on the demo: Tim O'Connor/);
  assert.match(card, /Phone: 3525550188/);
  assert.match(card, /Send Lisa the full quote \(all pages\) today/);
  assert.doesNotMatch(card, /said yes to a call/);
  assert.equal(d.posts[0].channel, 'C0C5YMHNYJH');
  assert.equal(d.events[0].event_type, 'agentic.f0_rehash_quote_requested');
});

test('a complaint posts the POST-DEMO CONCERN card', async () => {
  const d = fakeDeps();
  const r = await route('Bill did not receive a call', d);
  assert.equal(r.rehash_card, 'concern');
  assert.match(d.posts[0].text, /^⚠️ POST-DEMO CONCERN/);
  assert.doesNotMatch(d.posts[0].text, /said yes to a call/);
  assert.equal(d.events[0].event_type, 'agentic.f0_rehash_concern');
});

test('only a real call request posts the call card', async () => {
  const d = fakeDeps();
  const r = await route('call me after 3', d);
  assert.equal(r.rehash_card, 'call_request');
  assert.match(d.posts[0].text, /REHASH CALL REQUEST/);
  assert.equal(d.events[0].event_type, 'agentic.f0_rehash_call_requested');
  const d2 = fakeDeps();
  assert.equal((await route('Yes', d2, { lastOutbound: 'Would a quick call help?' })).rehash_card, 'call_request');
  const d3 = fakeDeps();
  assert.equal((await route('Yes', d3)).rehash_card, 'digest', 'a bare yes with no call offer is not a call');
});

test('no lead text: no card at all', async () => {
  const d = fakeDeps();
  const r = await route('', d);
  assert.equal(r.rehash_card, 'none');
  assert.equal(d.posts.length + d.events.length, 0);
});

test('one quote card a day; a failed Slack post is one #ops-alerts line', async () => {
  const seen = fakeDeps({ seen: true });
  assert.equal((await route('Where is my guote?', seen)).reason, 'already_posted_today');
  assert.equal(seen.posts.length, 0);
  const bad = fakeDeps({ slackOk: false });
  const r = await route('Where is my guote?', bad);
  assert.equal(r.reason, 'slack_not_in_channel');
  assert.equal(bad.ops.length, 1);
  assert.match(bad.ops[0], /REHASH QUOTE REQUEST NOT POSTED/);
});

test('REHASH_INTENT_ROUTING=off restores the old call card', async () => {
  const d = fakeDeps();
  const r = await routeRehashReply({ contactId: 'c1', text: 'Thank you', contact }, d, { env: { REHASH_INTENT_ROUTING: 'off' }, nowMs: NOW });
  assert.equal(r.rehash_card, 'call_request');
  assert.match(d.posts[0].text, /REHASH CALL REQUEST/);
});

// ── the 08:45 ET digest ──

test('digest days: yesterday, or Friday to Sunday on a Monday; weekdays from 08:45 ET', () => {
  assert.deepEqual(digestDays(NOW), ['2026-10-13']);
  assert.deepEqual(digestDays(Date.parse('2026-10-19T13:00:00Z')), ['2026-10-16', '2026-10-17', '2026-10-18']);
  assert.equal(isDigestTime(Date.parse('2026-10-14T12:44:00Z')), false); // 08:44 ET
  assert.equal(isDigestTime(Date.parse('2026-10-14T12:45:00Z')), true);  // 08:45 ET
  assert.equal(isDigestTime(Date.parse('2026-10-18T14:00:00Z')), false); // Sunday
});

const row = (id, at, intent, said, first = 'Lisa') => ({ ghl_contact_id: id, created_at: at, payload: { intent, inbound_preview: said, first_name: first } });

test('digest lists the covered days once per contact; empty → null', () => {
  const rows = [
    row('a', '2026-10-13T14:00:00Z', 'ack', 'Thank you'),
    row('a', '2026-10-13T18:00:00Z', 'not_now', 'Thinking'),
    row('b', '2026-10-13T20:00:00Z', 'not_now', 'Thinking it through', 'Bill'),
    row('c', '2026-10-14T13:00:00Z', 'ack', 'today, not yesterday'),
  ];
  const text = buildRehashDigest(rows, { days: ['2026-10-13'], locationId: 'LOC' });
  assert.match(text, /^🗂️ REHASH REPLIES \(2026-10-13\)/);
  assert.match(text, /• Lisa \(thanks\): "Thank you" https:\/\/app\.gohighlevel\.com\/v2\/location\/LOC\/contacts\/detail\/a/);
  assert.match(text, /• Bill \(still deciding\): "Thinking it through"/);
  assert.doesNotMatch(text, /today, not yesterday/);
  assert.equal(text.split('\n').filter((l) => l.startsWith('•')).length, 2);
  assert.equal(buildRehashDigest([], { days: ['2026-10-13'] }), null);
});

test('digest run: posts once, records it, and never posts an empty list', async () => {
  const posts = []; const recorded = [];
  const base = {
    __noDefaults: true, nowMs: NOW, locationId: 'LOC',
    postToSlack: async (text, channel) => { posts.push({ text, channel }); return { ok: true, ts: '9' }; },
    opsAlert: async () => {},
    filterNew: async ({ items }) => ({ fresh: items }),
    recordPosted: async ({ items }) => { recorded.push(...items); },
  };
  const empty = await runRehashReplyDigest({ deps: { ...base, readEvents: async () => [] }, env: {} });
  assert.equal(empty.posted, false);
  assert.equal(posts.length, 0);
  const out = await runRehashReplyDigest({ deps: { ...base, readEvents: async () => [row('a', '2026-10-13T14:00:00Z', 'ack', 'Thank you')] }, env: {} });
  assert.equal(out.posted, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, 'C0C5YMHNYJH');
  assert.deepEqual(recorded, [{ key: '2026-10-14', reason: 'posted' }]);
  const again = await runRehashReplyDigest({ deps: { ...base, filterNew: async () => ({ fresh: [] }), readEvents: async () => [row('a', '2026-10-13T14:00:00Z', 'ack', 'Thank you')] }, env: {} });
  assert.equal(again.posted, false);
  assert.equal(posts.length, 1);
});
