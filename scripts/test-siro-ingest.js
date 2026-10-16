/**
 * Siro ingest, webhook and poll — scripts/test-siro-ingest.js (2026-10-16)
 * Run: node --test scripts/test-siro-ingest.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Webhook } from 'svix';
import { fakeSupabase } from './lib/fake-supabase.js';
import { processRecording, queueDemoNote } from '../src/siro/ingest.js';
import { makeSiroWebhookHandler, readyToAct, registerSiroWebhookRoutes, signatureHeaderNames } from '../src/siro/webhook.js';
import { runSiroRecordingSync, refreshMissingContacts, WATERMARK_KEY } from '../src/jobs/siro-recording-sync.js';
import { RAW_RECORDING, FIXTURE_RECORDED_AT } from './fixtures/siro-recording.js';

const LEAD = { lp_lead_id: '583321', lp_prospect_id: '470111', ghl_contact_id: 'c1', phone: '3525550188', demo_date: '2026-10-14T22:00:00Z' };
const readLeads = async ({ by, values }) => (by === 'lp_lead_id' && values.includes('583321')) ? [LEAD] : [];
const fakeSiro = (rec = RAW_RECORDING) => ({ getRecording: async () => ({ ok: true, status: 200, data: rec }) });
const quiet = () => {};

test('shadow stores the matched row and emits nothing', async () => {
  const db = fakeSupabase({ siro_recordings: [] });
  const emitted = [];
  const out = await processRecording('rec_abc123', {
    source: 'webhook', mode: 'shadow',
    deps: { supabase: db, siro: fakeSiro(), readLeads, emitEvent: async (e) => emitted.push(e), log: quiet },
  });
  assert.equal(out.result, 'stored_shadow');
  assert.equal(db.tables.siro_recordings.length, 1);
  assert.equal(db.tables.siro_recordings[0].lp_lead_id, '583321');
  assert.equal(db.tables.siro_recordings[0].match_method, 'opportunity');
  assert.equal(emitted.length, 0);
  assert.equal((db.tables.agent_actions || []).length, 0);
});

test('live emits once with the idempotency key, and the note is written once', async () => {
  const db = fakeSupabase({ siro_recordings: [] });
  const emitted = [];
  const deps = { supabase: db, siro: fakeSiro(), readLeads, emitEvent: async (e) => { emitted.push(e); return { id: 77 }; }, log: quiet };
  const env = { SIRO_DEMO_NOTE_MODE: 'live' };
  const a = await processRecording('rec_abc123', { source: 'webhook', mode: 'live', env, deps });
  const b = await processRecording('rec_abc123', { source: 'poll', mode: 'live', env, deps });
  assert.equal(a.result, 'live_queued');
  assert.equal(b.result, 'live_already_claimed');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event_type, 'siro.recording_processed');
  assert.equal(emitted[0].idempotency_key, 'siro:rec_abc123');
  assert.deepEqual(emitted[0].payload.objections, ['price', 'spouse']);
  const notes = db.tables.agent_actions;
  assert.equal(notes.length, 1);
  assert.equal(notes[0].action_type, 'add_note');
  assert.equal(notes[0].rule_applied, 'SIRO_DEMO_NOTE');
  assert.equal(notes[0].target_id, 'c1');
  assert.equal(notes[0].priority, 5);
  assert.equal(notes[0].requires_approval, false);
  assert.match(notes[0].action_payload.note, /^DEMO SUMMARY \(Siro\)/);
  assert.equal(db.tables.siro_recordings[0].ghl_note_action_id, notes[0].id);
  assert.ok(db.tables.siro_recordings[0].event_emitted_at);
});

test('a failed note insert clears the claim', async () => {
  const db = fakeSupabase({ siro_recordings: [{ recording_id: 'r1', ghl_note_action_id: null }] });
  const origFrom = db.from;
  db.from = (t) => {
    const c = origFrom(t);
    if (t === 'agent_actions') {
      return { insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: 'boom' } }) }) }) };
    }
    return c;
  };
  const row = { recording_id: 'r1', ghl_contact_id: 'c1', lp_lead_id: '1', processed: true, moments: [], summary: [], recorded_at: new Date().toISOString() };
  const out = await queueDemoNote(row, { mode: 'live', supabase: db, log: quiet });
  assert.equal(out, 'failed');
  assert.equal(db.tables.siro_recordings[0].ghl_note_action_id, null);
});

test('demo notes are for new visits only: older than 48h is too_old, nothing claimed', async () => {
  const db = fakeSupabase({ siro_recordings: [{ recording_id: 'r1', ghl_note_action_id: null }] });
  const nowMs = Date.parse('2026-10-16T12:00:00Z');
  const base = { recording_id: 'r1', ghl_contact_id: 'c1', lp_lead_id: '1', processed: true, moments: [], summary: [] };
  const old = await queueDemoNote({ ...base, recorded_at: '2026-10-14T11:00:00Z' }, { mode: 'live', supabase: db, log: quiet, env: {}, nowMs });
  assert.equal(old, 'too_old');
  assert.equal((db.tables.agent_actions || []).length, 0);
  assert.equal(db.tables.siro_recordings[0].ghl_note_action_id, null);
  // SIRO_DEMO_NOTE_MAX_AGE_H widens the window.
  const wide = await queueDemoNote({ ...base, recorded_at: '2026-10-14T11:00:00Z' }, { mode: 'shadow', supabase: db, log: quiet, env: { SIRO_DEMO_NOTE_MAX_AGE_H: '72' }, nowMs });
  assert.equal(wide, 'shadow');
  assert.equal(await queueDemoNote({ ...base, recorded_at: null }, { mode: 'live', supabase: db, log: quiet, nowMs }), 'too_old');
});

test('the queued note carries the prices; raw never holds GPS, emails, drafts or thinking', async () => {
  const db = fakeSupabase({ siro_recordings: [] });
  const deps = { supabase: db, siro: fakeSiro(), readLeads, emitEvent: async () => ({ id: 1 }), log: quiet };
  await processRecording('rec_abc123', { source: 'webhook', mode: 'live', env: { SIRO_DEMO_NOTE_MODE: 'live' }, deps });
  const note = db.tables.agent_actions[0].action_payload.note;
  assert.match(note, /Final quote: \$18,400/);
  const stored = db.tables.siro_recordings[0];
  assert.equal(stored.recorded_at, FIXTURE_RECORDED_AT);
  assert.equal(stored.rep_name, 'Brian Kowalski');
  assert.equal(stored.pricing.final_price_quote, '$18,400');
  assert.match(stored.insights.objection_summary, /\$18,400/); // prices kept (the user, 2026-10-16)
  const elsewhere = JSON.stringify({ raw: stored.raw, insights: stored.insights, moments: stored.moments, summary: stored.summary });
  assert.doesNotMatch(elsewhere, /latitude|28\.18|dana@example\.com|Dear Dana|HIGH FOLLOW-UP/);
});

test('no lead → stored, nothing emitted', async () => {
  const db = fakeSupabase({});
  const out = await processRecording('rec_abc123', {
    source: 'poll', mode: 'live', deps: { supabase: db, siro: fakeSiro(), readLeads: async () => [], emitEvent: async () => { throw new Error('no'); }, log: quiet },
  });
  assert.equal(out.result, 'stored_no_lead');
});

test('another conversation type is skipped when the filter is set', async () => {
  const db = fakeSupabase({});
  const out = await processRecording('rec_abc123', {
    source: 'poll', mode: 'shadow', env: { SIRO_PRESENTATION_CONVERSATION_TYPE: 'ct-other' },
    deps: { supabase: db, siro: fakeSiro(), readLeads, log: quiet },
  });
  assert.equal(out.result, 'other_conversation_type');
});

function signed(secret, body, id = 'msg_1') {
  const wh = new Webhook(secret);
  const ts = new Date();
  const sig = wh.sign(id, ts, body);
  return { 'svix-id': id, 'svix-timestamp': String(Math.floor(ts.getTime() / 1000)), 'svix-signature': sig };
}
function fakeRes() {
  const r = { code: null, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const SECRET = 'whsec_' + Buffer.from('test-secret-test-secret-123456').toString('base64');
const ENV = { SIRO_WEBHOOK_SECRET: SECRET };

test('webhook: fail closed on the signature; duplicate 200; acts only when processed AND linked', async () => {
  const body = JSON.stringify({ recordingId: 'rec_abc123', recordingProcessed: true, recordingLinked: true, eventType: 'integrations.recordingLinked' });
  const db = fakeSupabase({});
  const jobs = [];
  const deps = { supabase: db, siro: fakeSiro(), readLeads, log: quiet, trackBackground: (p) => jobs.push(p) };
  const call = async (env, headers, b = body) => { const res = fakeRes(); await makeSiroWebhookHandler({ env, deps })({ body: Buffer.from(b), headers }, res); return res; };

  // An unset secret refuses everything.
  assert.equal((await call({}, signed(SECRET, body))).code, 401);
  // Unsigned: 401 even with the mode off.
  assert.equal((await call({ ...ENV, SIRO_WEBHOOK_MODE: 'off' }, {})).code, 401);
  // A bad signature: 401. A leftover header key changes nothing.
  assert.equal((await call(ENV, { ...signed(SECRET, body), 'svix-signature': 'v1,bad' })).code, 401);
  assert.equal((await call(ENV, { 'x-reece-webhook-key': 'anything' })).code, 401);

  // A valid signature alone is accepted (the header key was removed, 2026-10-16).
  const ok = await call(ENV, signed(SECRET, body));
  assert.equal(ok.code, 200);
  assert.equal(ok.body.accepted, true);
  await Promise.all(jobs);
  assert.equal(db.tables.siro_recordings.length, 1);
  assert.equal(db.tables.siro_webhook_events[0].handled, true);

  // A redelivery: the real table's primary key on svix_id answers 23505.
  const realFrom = db.from;
  db.from = (t) => (t === 'siro_webhook_events'
    ? { insert: async () => ({ data: null, error: { code: '23505', message: 'duplicate key' } }) }
    : realFrom(t));
  const dup = await call(ENV, signed(SECRET, body));
  assert.equal(dup.body.duplicate, true);
  db.from = realFrom;

  const half = JSON.stringify({ recordingId: 'rec_2', recordingProcessed: true, recordingLinked: false, eventType: 'integrations.recordingProcessed' });
  const wait = await call(ENV, signed(SECRET, half, 'msg_2'), half);
  assert.equal(wait.body.waiting, 'processed_and_linked');
  assert.equal(readyToAct({ recordingProcessed: true, recordingLinked: true }), true);
});

test('poll: pages, stores, moves the watermark only after a full pass', async () => {
  const db = fakeSupabase({});
  const pages = [
    { ok: true, data: { data: [RAW_RECORDING], cursor: 'p2' } },
    { ok: true, data: { data: [] } },
  ];
  const siro = { ...fakeSiro(), listRecordingsUpdatedSince: async () => pages.shift() };
  const out = await runSiroRecordingSync({ env: { SIRO_SYNC_MODE: 'shadow' }, deps: { supabase: db, siro, readLeads, log: quiet }, nowMs: Date.parse('2026-10-16T00:00:00Z') });
  assert.equal(out.complete, true);
  assert.deepEqual(out.by_reason.stored_shadow, ['rec_abc123']);
  assert.equal(db.tables.siro_sync_state.find(r => r.key === WATERMARK_KEY).value, RAW_RECORDING.updatedAt);

  const db2 = fakeSupabase({});
  const broken = { ...fakeSiro(), listRecordingsUpdatedSince: async () => ({ ok: false, error: 'http_500' }) };
  const out2 = await runSiroRecordingSync({ env: {}, deps: { supabase: db2, siro: broken, readLeads, log: quiet } });
  assert.equal(out2.complete, false);
  assert.equal((db2.tables.siro_sync_state || []).length, 0);
});

test('a reprocess pass re-normalizes stored rows: no event, no note, watermark untouched', async () => {
  // A row stored before this change: the whole Siro record in raw, no rep name.
  const db = fakeSupabase({
    siro_recordings: [{ recording_id: 'rec_abc123', updated_at_siro: RAW_RECORDING.updatedAt, rep_name: null, raw: { latitude: 28.18 } }],
    siro_sync_state: [{ key: WATERMARK_KEY, value: '2026-10-01T00:00:00.000Z' }],
  });
  const pages = [{ ok: true, data: { data: [RAW_RECORDING] } }];
  const siro = { ...fakeSiro(), listRecordingsUpdatedSince: async () => pages.shift() };
  let emitted = 0;
  const out = await runSiroRecordingSync({
    since: '2026-10-09T00:00:00Z', reprocess: true, env: { SIRO_SYNC_MODE: 'live', SIRO_DEMO_NOTE_MODE: 'live' },
    deps: { supabase: db, siro, readLeads, emitEvent: async () => { emitted++; return { id: 1 }; }, log: quiet },
  });
  assert.equal(out.reprocess, true);
  const r = db.tables.siro_recordings.find(x => x.recording_id === 'rec_abc123');
  assert.equal(r.rep_name, 'Brian Kowalski');
  assert.equal(r.raw.latitude, undefined);
  assert.equal(emitted, 0);
  assert.equal((db.tables.agent_actions || []).length, 0);
  assert.equal(db.tables.siro_sync_state.find(x => x.key === WATERMARK_KEY).value, '2026-10-01T00:00:00.000Z');
});

test('a list item without Siro\'s follow-up block is fetched whole; an unchanged one is not fetched at all', async () => {
  const { followups, ...listItem } = RAW_RECORDING; // the LIST call's shape
  assert.ok(followups.length);
  const db = fakeSupabase({ siro_recordings: [] });
  let fetched = 0;
  const siro = { getRecording: async () => { fetched++; return { ok: true, status: 200, data: RAW_RECORDING }; } };
  const deps = { supabase: db, siro, readLeads, userNames: new Map(), log: quiet };
  await processRecording('rec_abc123', { source: 'poll', mode: 'shadow', raw: listItem, onlyIfNewer: true, deps });
  assert.equal(fetched, 1);
  const row = db.tables.siro_recordings[0];
  assert.equal(row.rep_name, 'Brian Kowalski');
  assert.equal(row.pricing.final_price_quote, '$18,400');
  const again = await processRecording('rec_abc123', { source: 'poll', mode: 'shadow', raw: listItem, onlyIfNewer: true, deps });
  assert.equal(again.result, 'unchanged');
  assert.equal(fetched, 1);
  // A reprocess fetches again.
  await processRecording('rec_abc123', { source: 'poll', mode: 'shadow', raw: listItem, onlyIfNewer: true, reprocess: true, deps });
  assert.equal(fetched, 2);
});

test('matched rows with no GHL contact get one from lp_leads', async () => {
  const db = fakeSupabase({
    siro_recordings: [
      { recording_id: 'a', lp_lead_id: '583321', ghl_contact_id: null },
      { recording_id: 'b', lp_lead_id: '999', ghl_contact_id: null },
      { recording_id: 'c', lp_lead_id: null, ghl_contact_id: null },
    ],
    lp_leads: [{ lp_lead_id: '583321', ghl_contact_id: 'c1' }, { lp_lead_id: '999', ghl_contact_id: null }],
  });
  assert.equal(await refreshMissingContacts(db), 1);
  assert.equal(db.tables.siro_recordings.find(r => r.recording_id === 'a').ghl_contact_id, 'c1');
  assert.equal(db.tables.siro_recordings.find(r => r.recording_id === 'b').ghl_contact_id, null);
});

test('the route mounts on POST /webhook/siro and logs its mode', () => {
  const routes = [];
  const logs = [];
  const orig = console.log;
  console.log = (l) => logs.push(String(l));
  try {
    registerSiroWebhookRoutes({ post: (path) => routes.push(path) }, { ...ENV, SIRO_WEBHOOK_MODE: 'live' });
  } finally { console.log = orig; }
  assert.deepEqual(routes, ['/webhook/siro']);
  assert.ok(logs.includes('[Siro] webhook route mounted mode=live'));
});

test('the Standard Webhooks header names (webhook-id / -timestamp / -signature) verify too', async () => {
  const body = JSON.stringify({ recordingId: 'rec_abc123', recordingProcessed: true, recordingLinked: false, eventType: 'integrations.recordingProcessed' });
  const s = signed(SECRET, body, 'msg_std');
  const std = { 'webhook-id': s['svix-id'], 'webhook-timestamp': s['svix-timestamp'], 'webhook-signature': s['svix-signature'] };
  const db = fakeSupabase({});
  const res = fakeRes();
  await makeSiroWebhookHandler({ env: ENV, deps: { supabase: db, log: quiet, trackBackground: () => {} } })({ body: Buffer.from(body), headers: std }, res);
  assert.equal(res.code, 200);
  assert.equal(db.tables.siro_webhook_events[0].svix_id, 'msg_std');
  const bad = fakeRes();
  await makeSiroWebhookHandler({ env: ENV, deps: { supabase: db, log: quiet } })({ body: Buffer.from(body), headers: { ...std, 'webhook-signature': 'v1,bad' } }, bad);
  assert.equal(bad.code, 401);
  assert.deepEqual(signatureHeaderNames({ 'webhook-id': 'x', 'content-type': 'y', 'svix-signature': 'z' }), ['svix-signature', 'webhook-id']);
});
