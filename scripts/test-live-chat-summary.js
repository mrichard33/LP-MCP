/**
 * One Slack card per live chat (2026-10-15) — src/live-chat/chat-summary.js and
 * src/services/live-chat-summary-io.js against in-memory deps.
 *
 * Run: node --test scripts/test-live-chat-summary.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  sessionize, readySessions, toTurn, summarizeFacts, needsAPerson, buildCard, summaryMode, summaryQuietMs,
  cleanSummary, fallbackSummary, openingsFromRows, worthPosting, flagList, summaryChannel, SUMMARY_CHANNEL_DEFAULT,
} = await import('../src/live-chat/chat-summary.js');
const { runLiveChatSummaryPass, threadRootFor, WINDOW_COUNT_FIELD_ID, DOOR_COUNT_FIELD_ID } = await import('../src/services/live-chat-summary-io.js');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-15T18:00:00Z');
const CONTACT = 'jhVZZUtXp3jDrBsXOZcK';
const at = (m) => new Date(T0 + m * MIN).toISOString();

/** An agent_actions row the way the lane writes it. */
function chatRow(id, minute, inbound, er = {}, contact = CONTACT) {
  return {
    id, target_id: contact, created_at: at(minute), status: 'completed',
    action_payload: { trigger_message: inbound },
    execution_result: { send_status: 'sent', sent_body: 'Got it. What made you start looking at this now?', large_job: true, ...er },
  };
}
// The 2026-10-15 chat: six visitor messages in six minutes.
const SIX = ['We have 13 windows', 'yes', 'no', 'Tomorrow', 'Roberta', 'ok'].map((b, i) => chatRow(i + 1, i, b));

/** In-memory deps: a summaries table with the real UNIQUE (contact_id, session_start). */
function makeDeps({ rows = SIX, contact = { name: 'Roberta Smith', phone: '+1 (352) 555-0188' }, post = null, summarize = null, openings = [], optedOut = false } = {}) {
  const state = { table: [], posts: [], updates: [], llm: 0 };
  let nextId = 1;
  let slackTs = 1000;
  const deps = {
    readChatRows: async (sinceIso) => rows.filter(r => r.created_at >= sinceIso),
    readSummaries: async (ids) => state.table.filter(r => ids.includes(r.contact_id)).map(r => ({ ...r })),
    claimSession: async (row) => {
      const dup = state.table.find(r => r.contact_id === row.contact_id && Date.parse(r.session_start) === Date.parse(row.session_start));
      if (dup) return { claimed: false };
      const id = nextId++;
      state.table.push({ id, attempts: 0, posted_at: null, slack_ts: null, thread_ts: null, slack_channel: null, ...row });
      return { claimed: true, id };
    },
    updateSummary: async (id, patch) => { state.updates.push({ id, ...patch }); Object.assign(state.table.find(r => r.id === id), patch); },
    readOpeningsRows: async () => openings,
    readOptedOut: async () => optedOut,
    fetchContact: async () => contact,
    summarize: summarize || (async () => { state.llm++; return 'The visitor wants 13 windows replaced. The chat ended with the visitor giving a first name.'; }),
    postToSlack: post || (async (text, channel, opts = {}) => { state.posts.push({ text, channel, threadTs: opts.threadTs || null }); return { ok: true, ts: String(slackTs++), channel }; }),
    channel: () => 'C_OPS',
    contactUrl: (id) => `https://app.gohighlevel.com/v2/location/LOC/contacts/detail/${id}`,
  };
  return { deps, state };
}
const LIVE = { LIVE_CHAT_SUMMARY_MODE: 'live' };
const SHADOW = { LIVE_CHAT_SUMMARY_MODE: 'shadow' };

test('modes and quiet window: off by default, 15 minutes by default', () => {
  assert.equal(summaryMode({}), 'off');
  assert.equal(summaryMode({ LIVE_CHAT_SUMMARY_MODE: 'LIVE' }), 'live');
  assert.equal(summaryMode({ LIVE_CHAT_SUMMARY_MODE: 'nope' }), 'off');
  assert.equal(summaryQuietMs({}), 15 * MIN);
  assert.equal(summaryQuietMs({ LIVE_CHAT_SUMMARY_QUIET_MIN: '5' }), 5 * MIN);
});

test('sessions split on a gap longer than the quiet window', () => {
  const rows = [...SIX, chatRow(7, 35, 'back again'), chatRow(8, 36, 'still there?')];
  const s = sessionize(rows.map(toTurn), 15 * MIN);
  assert.equal(s.length, 2);
  assert.equal(s[0].turns.length, 6);
  assert.equal(s[0].session_start, at(0));
  assert.equal(s[1].session_start, at(35));
  // Ready only once quiet; a session at the edge of the read window is left alone.
  assert.equal(readySessions(s, { nowMs: T0 + 50 * MIN, quietMs: 15 * MIN, windowStartMs: T0 - 60 * MIN }).length, 1);
  assert.equal(readySessions(s, { nowMs: T0 + 51 * MIN, quietMs: 15 * MIN, windowStartMs: T0 - 60 * MIN }).length, 2);
  assert.equal(readySessions(s, { nowMs: T0 + 51 * MIN, quietMs: 15 * MIN, windowStartMs: T0 - 5 * MIN }).length, 1);
});

test('the 6-message chat: nothing before 15 quiet minutes, then exactly one card, never a second', async () => {
  const { deps, state } = makeDeps();
  let out = await runLiveChatSummaryPass({ env: LIVE, nowMs: T0 + 5 * MIN + 14 * MIN, deps });
  assert.equal(out.ready, 0);
  assert.equal(state.posts.length, 0);
  out = await runLiveChatSummaryPass({ env: LIVE, nowMs: T0 + 5 * MIN + 15 * MIN, deps });
  assert.equal(out.posted, 1);
  for (let i = 1; i <= 3; i++) await runLiveChatSummaryPass({ env: LIVE, nowMs: T0 + 20 * MIN + i * MIN, deps });
  assert.equal(state.posts.length, 1);
  const card = state.posts[0].text;
  assert.equal(state.posts[0].channel, 'C_OPS');
  assert.equal(state.posts[0].threadTs, null);
  assert.match(card, /LIVE CHAT SUMMARY/);
  assert.match(card, /Roberta Smith · 3525550188/, 'phone is 10 digits, nothing else');
  assert.match(card, /contacts\/detail\/jhVZZUtXp3jDrBsXOZcK/);
  assert.match(card, /Outcome: No booking/);
  assert.match(card, /Flags: Large job/);
  assert.match(card, /13 windows replaced/);
  assert.match(card, /Needs a person: Large job with no visit booked/);
  const row = state.table[0];
  assert.ok(row.posted_at && row.slack_ts);
  assert.equal(row.turns, 6);
  assert.doesNotMatch(JSON.stringify(row.payload), /3525550188|555-0188/, 'no phone on the stored row');
});

test('shadow: the row is written with the card facts, nothing is posted', async () => {
  const { deps, state } = makeDeps();
  const out = await runLiveChatSummaryPass({ env: SHADOW, nowMs: T0 + 25 * MIN, deps });
  assert.equal(out.claimed, 1);
  assert.equal(state.posts.length, 0);
  assert.equal(state.table[0].mode, 'shadow');
  assert.equal(state.table[0].payload.facts.large_job, true);
  assert.equal(state.table[0].posted_at, null);
  await runLiveChatSummaryPass({ env: SHADOW, nowMs: T0 + 30 * MIN, deps });
  assert.equal(state.table.length, 1);
});

test('off: reads nothing', async () => {
  const { deps, state } = makeDeps();
  deps.readChatRows = async () => { throw new Error('must not read'); };
  const out = await runLiveChatSummaryPass({ env: {}, nowMs: T0 + 25 * MIN, deps });
  assert.equal(out.skipped, true);
  assert.equal(state.table.length, 0);
});

test('the lead comes back 30 minutes later → one thread reply under the first card, no new top-level card', async () => {
  const rows = [...SIX];
  const { deps, state } = makeDeps({ rows });
  await runLiveChatSummaryPass({ env: LIVE, nowMs: T0 + 21 * MIN, deps });
  rows.push(chatRow(7, 35, 'Actually can you come Friday?'), chatRow(8, 36, 'morning is best'));
  await runLiveChatSummaryPass({ env: LIVE, nowMs: T0 + 45 * MIN, deps });
  assert.equal(state.posts.length, 1, 'still quiet less than 15 minutes');
  await runLiveChatSummaryPass({ env: LIVE, nowMs: T0 + 52 * MIN, deps });
  assert.equal(state.posts.length, 2);
  assert.equal(state.posts.filter(p => !p.threadTs).length, 1, 'one top-level card');
  assert.equal(state.posts[1].threadTs, state.table[0].slack_ts);
  assert.match(state.posts[1].text, /they came back/);
  // A third visit threads under the SAME first card.
  rows.push(chatRow(9, 80, 'hello again'));
  await runLiveChatSummaryPass({ env: LIVE, nowMs: T0 + 96 * MIN, deps });
  assert.equal(state.posts[2].threadTs, state.table[0].slack_ts);
});

test('two replicas racing the same pass → one card', async () => {
  const { deps, state } = makeDeps();
  await Promise.all([
    runLiveChatSummaryPass({ env: LIVE, nowMs: T0 + 25 * MIN, deps }),
    runLiveChatSummaryPass({ env: LIVE, nowMs: T0 + 25 * MIN, deps }),
  ]);
  assert.equal(state.posts.length, 1);
  assert.equal(state.table.length, 1);
});

test('out-of-area chat: no Large job flag, outcome Out of area, nobody paged', () => {
  const turns = [chatRow(1, 0, 'Do you service Dallas? 75233 we have 14 windows', { service_area: { zip: '75233', result: 'out', market_code: null } })].map(toTurn);
  const f = summarizeFacts(turns);
  assert.equal(f.large_job, false);
  assert.equal(f.outcome, 'out_of_area');
  assert.equal(f.zip, '75233');
  assert.equal(needsAPerson(f), null);
  const card = buildCard({ facts: f, summary: 'x', contact: {} });
  assert.doesNotMatch(card, /Large job/);
  assert.match(card, /Outcome: Out of area/);
});

test('booked large job: outcome Booked with the time, no "Needs a person" line', () => {
  const turns = [
    chatRow(1, 0, 'We have 13 windows'),
    chatRow(2, 1, 'Tomorrow at 2', { nepq: { booking: 'booked', start: '2026-10-16T18:00:00Z', appointment_id: 'a1' }, service_area: { zip: '33901', result: 'in', market_code: 'FTMYR' } }),
  ].map(toTurn);
  const f = summarizeFacts(turns, { openings: { windows: 13, doors: 0 } });
  assert.equal(f.outcome, 'booked');
  assert.equal(needsAPerson(f), null);
  const card = buildCard({ facts: f, summary: 's', contact: { name: 'A', phone: '352.555.0188' } });
  assert.match(card, /Outcome: Booked \(Fri, Oct 16 at 2:00 PM ET\)/);
  assert.match(card, /Openings: 13 windows · Zip\/market: 33901 \/ FTMYR/);
  assert.match(card, /A · 3525550188/);
  assert.doesNotMatch(card, /Needs a person/);
});

test('flags: Spanish and a last-turn fallback ask for a person; a callback or service hand-off does not (it has its own card)', () => {
  const spanish = summarizeFacts([chatRow(1, 0, 'hola', { large_job: false, language_handoff: 'es' })].map(toTurn));
  assert.match(needsAPerson(spanish), /Spanish/);
  const slow = summarizeFacts([chatRow(1, 0, 'hi', { large_job: false, send_status: 'fallback' })].map(toTurn));
  assert.equal(slow.fallbacks, 1);
  assert.match(needsAPerson(slow), /timed out/);
  const cb = summarizeFacts([chatRow(1, 0, 'call me', { large_job: false, nepq: { handoff: 'callback_request' } })].map(toTurn));
  assert.equal(cb.outcome, 'callback');
  assert.equal(needsAPerson(cb), null);
  const svc = summarizeFacts([chatRow(1, 0, 'my install is broken', { large_job: false, nepq: { handoff: 'service' } })].map(toTurn));
  assert.equal(svc.service, true);
  assert.equal(needsAPerson(svc), null);
  const stopped = summarizeFacts([chatRow(1, 0, 'big job')].map(toTurn), { optedOut: true });
  assert.equal(needsAPerson(stopped), null);
  assert.match(buildCard({ facts: stopped, summary: null }), /Opted out/);
});

test('a failed model call uses the visitor\'s own words; a failed Slack post is retried, then stays one card', async () => {
  let fail = true;
  const posts = [];
  const { deps, state } = makeDeps({
    summarize: async () => { throw new Error('timeout'); },
    post: async (text, channel, opts = {}) => {
      if (fail) return { ok: false, error: 'not_in_channel' };
      posts.push({ text, threadTs: opts.threadTs || null });
      return { ok: true, ts: '9', channel };
    },
  });
  await runLiveChatSummaryPass({ env: LIVE, nowMs: T0 + 25 * MIN, deps });
  assert.equal(state.table[0].attempts, 1);
  assert.equal(state.table[0].error, 'not_in_channel');
  assert.equal(state.table[0].payload.summary_source, 'fallback');
  fail = false;
  await runLiveChatSummaryPass({ env: LIVE, nowMs: T0 + 26 * MIN, deps });
  await runLiveChatSummaryPass({ env: LIVE, nowMs: T0 + 27 * MIN, deps });
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /The visitor said: "Tomorrow" \/ "Roberta" \/ "ok"/);
  assert.equal(state.table[0].error, null);
});

test('helpers: summary cleanup, fallback, openings rows, thread root', () => {
  assert.equal(cleanSummary('Summary: - Wants windows — 13 of them.\n- Ended with a name.\n- c\n- d'), 'Wants windows, 13 of them. Ended with a name. c');
  assert.equal(cleanSummary(''), null);
  assert.equal(fallbackSummary([]), 'No visitor text was recorded.');
  assert.deepEqual(openingsFromRows([{ action_payload: { fields: [{ id: WINDOW_COUNT_FIELD_ID, field_value: 13 }, { id: DOOR_COUNT_FIELD_ID, field_value: 2 }] } }], { windowFieldId: WINDOW_COUNT_FIELD_ID, doorFieldId: DOOR_COUNT_FIELD_ID }), { windows: 13, doors: 2 });
  assert.equal(threadRootFor('c', [{ contact_id: 'c', posted_at: at(0), slack_ts: '1', slack_channel: 'C' }], T0 + 8 * 24 * 60 * MIN), null, 'older than a week starts a new card');
  assert.deepEqual(threadRootFor('c', [{ contact_id: 'c', posted_at: at(0), slack_ts: '1', slack_channel: 'C' }], T0 + MIN), { thread_ts: '1', channel: 'C' });
});

// ── 2026-10-16: #reece-chatbot, no card for an empty chat, any non-English visitor ──

const GUEST = { name: 'Guest Visitor kupsc', phone: null };
const oneTurn = (inbound, er = {}, contact = 'FbGjckn4HAFe5iydGcAr') =>
  [chatRow(1, 0, inbound, { large_job: false, sent_body: 'Hey there. What brings you in today?', ...er }, contact)];

test('the card goes to #reece-chatbot by default; LIVE_CHAT_SUMMARY_CHANNEL overrides', () => {
  assert.equal(SUMMARY_CHANNEL_DEFAULT, 'C0C9AGEM2N8');
  assert.equal(summaryChannel({}), 'C0C9AGEM2N8');
  assert.equal(summaryChannel({ SLACK_CHANNEL_DISPATCH: 'C_DISPATCH' }), 'C_DISPATCH');
  assert.equal(summaryChannel({ LIVE_CHAT_SUMMARY_CHANNEL: ' C_SUMMARY ', SLACK_CHANNEL_DISPATCH: 'C_DISPATCH' }), 'C_SUMMARY');
});

test('a one-message chat with nothing to act on: row written and marked skipped, no card, never retried', async () => {
  for (const inbound of ['bb', 'English', 'I need the manufacturer of the high impact windows for QMID for energy credit']) {
    const { deps, state } = makeDeps({ rows: oneTurn(inbound), contact: GUEST });
    const out = await runLiveChatSummaryPass({ env: LIVE, nowMs: T0 + 20 * MIN, deps });
    assert.equal(out.claimed, 1, inbound);
    assert.equal(out.skipped, 1, inbound);
    assert.equal(state.posts.length, 0, inbound);
    assert.equal(state.table[0].payload.skipped, 'nothing_to_act_on');
    assert.equal(state.table[0].posted_at, null);
    for (let i = 1; i <= 3; i++) await runLiveChatSummaryPass({ env: LIVE, nowMs: T0 + (20 + i) * MIN, deps });
    assert.equal(state.posts.length, 0, `${inbound}: a skipped row is never retried into a card`);
    assert.equal(state.table.length, 1);
  }
});

test('shadow marks the same chats skipped, so shadow shows what live would skip', async () => {
  const { deps, state } = makeDeps({ rows: oneTurn('bb'), contact: GUEST });
  const out = await runLiveChatSummaryPass({ env: SHADOW, nowMs: T0 + 20 * MIN, deps });
  assert.equal(out.skipped, 1);
  assert.equal(state.table[0].payload.skipped, 'nothing_to_act_on');
});

test('worthPosting: a real name, a phone, an outcome, a zip or openings each earn the card', () => {
  const empty = summarizeFacts(oneTurn('bb').map(toTurn));
  assert.equal(worthPosting(empty, GUEST), false);
  assert.equal(worthPosting(empty, null), false, 'a failed contact read with nothing else is still nothing');
  assert.equal(worthPosting(empty, { name: 'Dana', phone: null }), true);
  assert.equal(worthPosting(empty, { name: null, phone: '+1 352 555 0188' }), true);
  assert.equal(worthPosting({ ...empty, zip: '33901' }, GUEST), true);
  assert.equal(worthPosting({ ...empty, openings: { windows: 3, doors: 0 } }, GUEST), true);
  assert.equal(worthPosting({ ...empty, outcome: 'callback' }, GUEST), true);
  assert.equal(worthPosting({ ...empty, opted_out: true }, GUEST), true, 'an opt-out is a flag');
  assert.equal(worthPosting({ ...empty, fallbacks: 1 }, GUEST), true, 'a slow reply is a flag');
  assert.equal(worthPosting(summarizeFacts(SIX.map(toTurn)), { name: 'Roberta Smith', phone: null }), true);
});

test('a visitor who does not speak English is flagged and asks for a person, whatever the language', async () => {
  const rows = oneTurn('no English', { live_chat: { escalation_category: 'language', recommended_action: 'escalate_to_rep' } }, 'wTcbTNm9d0CRDDTKbygg');
  const f = summarizeFacts(rows.map(toTurn));
  assert.equal(f.language, 'unknown');
  assert.equal(f.spanish, false);
  assert.deepEqual(flagList(f), ['Non-English (unknown)']);
  assert.equal(needsAPerson(f), "Doesn't speak English (language unknown): someone who can help should follow up.");
  const { deps, state } = makeDeps({ rows, contact: { name: 'Guest Visitor xiinu', phone: null } });
  await runLiveChatSummaryPass({ env: LIVE, nowMs: T0 + 20 * MIN, deps });
  assert.equal(state.posts.length, 1, 'never skipped: someone has to follow up');
  assert.match(state.posts[0].text, /Flags: Non-English \(unknown\)/);
  assert.match(state.posts[0].text, /Needs a person: Doesn't speak English \(language unknown\)/);
});

test('a Spanish hand-off keeps today\'s flag and line; spanish stays on the facts', () => {
  const rows = [
    chatRow(1, 0, 'hola', { large_job: false }, 'nwwB55NnNUMnsMEahzvR'),
    chatRow(2, 1, 'comoestaflorida', { large_job: false, live_chat: { escalation_category: 'language' } }, 'nwwB55NnNUMnsMEahzvR'),
    chatRow(3, 2, 'español', { large_job: false, language_handoff: 'es', live_chat: { escalation_category: 'language' } }, 'nwwB55NnNUMnsMEahzvR'),
  ];
  const f = summarizeFacts(rows.map(toTurn));
  assert.equal(f.language, 'Spanish');
  assert.equal(f.spanish, true);
  assert.deepEqual(flagList(f), ['Spanish']);
  assert.equal(needsAPerson(f), 'Spanish speaker: a Spanish-speaking person should follow up.');
  // Another language code the hand-off might name one day is shown as it is.
  const other = summarizeFacts(oneTurn('bonjour', { language_handoff: 'fr' }).map(toTurn));
  assert.equal(other.language, 'fr');
  assert.match(needsAPerson(other), /Doesn't speak English \(fr\)/);
});

test('the held 13-window chat still posts, unchanged, and a thread reply stays in the first card\'s channel', async () => {
  const rows = [...SIX];
  const { deps, state } = makeDeps({ rows });
  deps.channel = () => summaryChannel({});
  await runLiveChatSummaryPass({ env: LIVE, nowMs: T0 + 21 * MIN, deps });
  assert.equal(state.posts[0].channel, 'C0C9AGEM2N8');
  assert.match(state.posts[0].text, /Flags: Large job$/m);
  // The first card was posted somewhere else (an #ops-alerts card from before this change): the reply follows it.
  state.table[0].slack_channel = 'C_OLD_OPS';
  rows.push(chatRow(7, 35, 'Actually can you come Friday?'));
  await runLiveChatSummaryPass({ env: LIVE, nowMs: T0 + 51 * MIN, deps });
  assert.equal(state.posts[1].channel, 'C_OLD_OPS');
  assert.equal(state.posts[1].threadTs, state.table[0].slack_ts);
});

test('an old shadow row is never posted once the mode is live', async () => {
  const { deps, state } = makeDeps();
  await runLiveChatSummaryPass({ env: SHADOW, nowMs: T0 + 21 * MIN, deps });
  await runLiveChatSummaryPass({ env: LIVE, nowMs: T0 + 22 * MIN, deps });
  assert.equal(state.posts.length, 0);
});
