// POST /webhooks/revin + processing (src/revin/webhook.js, src/revin/process.js, 2026-10-19).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase } from './lib/fake-supabase.js';
import { makeRevinWebhookHandler, storableHeaders, parseBody, resetRateLimit, rateLimited, clientIp } from '../src/revin/webhook.js';
import { processRevinEvent, matchContact } from '../src/revin/process.js';

const SECRET = 's3cret-value-for-tests-only-0123456789';
const ENV = { REVIN_WEBHOOK_SECRET: SECRET };

function fakeRes() {
  const r = { code: null, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

/** The fake plus the two UNIQUE keys the migration declares. */
function db(seed = {}) {
  const f = fakeSupabase(seed);
  const from = f.from;
  f.from = (table) => {
    const chain = from(table);
    if (table === 'revin_events_raw') {
      const insert = chain.insert;
      chain.insert = (p) => {
        if ((f.tables.revin_events_raw || []).some((r) => r.payload_hash === p.payload_hash)) {
          const dup = { select: () => dup, maybeSingle: () => dup, then: (res) => res({ data: null, error: { code: '23505', message: 'duplicate key' } }) };
          return dup;
        }
        return insert(p);
      };
    }
    if (table === 'contact_messages') {
      const upsert = chain.upsert;
      chain.upsert = (rows, opts) => {
        const fresh = rows.filter((r) => !(f.tables.contact_messages || []).some((x) => x.source === r.source && x.dedupe_key === r.dedupe_key));
        return upsert(fresh, opts);
      };
    }
    return chain;
  };
  return f;
}

const MATCH_DEPS = (over = {}) => ({
  contactForLead: async () => null,
  contactForPhone: async () => null,
  leadForContact: async () => null,
  ...over,
});

async function post(d, { body, headers = {}, env = ENV, process: proc } = {}) {
  const jobs = [];
  const res = fakeRes();
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  await makeRevinWebhookHandler({ env, deps: {
    supabase: d, trackBackground: (p) => jobs.push(p),
    processRevinEvent: proc || ((id) => processRevinEvent(id, { deps: { supabase: d, ...MATCH_DEPS() } })),
  } })({ body: raw, headers: { 'x-forwarded-for': '1.2.3.4', ...headers }, ip: '10.0.0.1' }, res);
  await Promise.all(jobs);
  return res;
}

test('a missing or wrong secret is 401 and stores nothing', async () => {
  resetRateLimit();
  const d = db();
  assert.equal((await post(d, { body: { body: 'x' } })).code, 401);
  assert.equal((await post(d, { body: { body: 'x' }, headers: { 'x-revin-secret': 'wrong' } })).code, 401);
  assert.equal((d.tables.revin_events_raw || []).length, 0);
});

test('an unset REVIN_WEBHOOK_SECRET refuses everything (fail closed)', async () => {
  resetRateLimit();
  const d = db();
  const res = await post(d, { body: { body: 'x' }, headers: { 'x-revin-secret': '' }, env: {} });
  assert.equal(res.code, 401);
  assert.equal((await post(d, { body: { body: 'x' }, headers: { 'x-revin-secret': 'anything' }, env: {} })).code, 401);
});

test('the good secret: 200, one raw row without the secret header, then one contact_messages row', async () => {
  resetRateLimit();
  const d = db();
  const res = await post(d, {
    body: { event: 'message.sent', to: '3525550188', body: 'Hi', message_id: 'm-1', timestamp: '2026-10-19T14:00:00Z' },
    headers: { 'x-revin-secret': SECRET, authorization: 'Bearer nope', 'content-type': 'application/json' },
  });
  assert.equal(res.code, 200);
  assert.equal(res.body.ok, true);
  const raw = d.tables.revin_events_raw;
  assert.equal(raw.length, 1);
  assert.equal(raw[0].headers['x-revin-secret'], undefined);
  assert.equal(raw[0].headers.authorization, undefined);
  assert.equal(raw[0].headers['content-type'], 'application/json');
  assert.match(raw[0].payload_hash, /^[0-9a-f]{64}$/);
  assert.equal(raw[0].process_status, 'unmatched', 'no contact found → unmatched, still stored');
  assert.equal(d.tables.contact_messages.length, 1);
  assert.equal(d.tables.contact_messages[0].raw_event_id, raw[0].id);
  assert.equal(d.tables.contact_messages[0].ghl_contact_id, null);
});

test('the same delivery twice: one raw row, one contact_messages row', async () => {
  resetRateLimit();
  const d = db();
  const body = { event: 'reply', from: '3525550188', text: 'yes', message_id: 'm-2' };
  const a = await post(d, { body, headers: { 'x-revin-secret': SECRET } });
  const b = await post(d, { body, headers: { 'x-revin-secret': SECRET } });
  assert.equal(a.code, 200);
  assert.equal(b.code, 200);
  assert.equal(b.body.duplicate, true);
  assert.equal(d.tables.revin_events_raw.length, 1);
  assert.equal(d.tables.contact_messages.length, 1);
  // A re-sent body with a different envelope but the same message id: one message row.
  await post(d, { body: { ...body, retry: 1 }, headers: { 'x-revin-secret': SECRET } });
  assert.equal(d.tables.revin_events_raw.length, 2);
  assert.equal(d.tables.contact_messages.length, 1);
});

test('a body that is not JSON is stored and answered 200, never refused', async () => {
  resetRateLimit();
  const d = db();
  const res = await post(d, { body: 'phone=3525550188&msg=hi', headers: { 'x-revin-secret': SECRET } });
  assert.equal(res.code, 200);
  assert.equal(res.body.parsed, false);
  assert.equal(d.tables.revin_events_raw[0].payload._raw_text, 'phone=3525550188&msg=hi');
  assert.equal(d.tables.contact_messages[0].event_type, 'unknown');
});

test('a failed store is a 500 so Revin retries', async () => {
  resetRateLimit();
  const d = db();
  const from = d.from;
  d.from = (t) => {
    const c = from(t);
    if (t === 'revin_events_raw') c.insert = () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: { code: '08006', message: 'connection lost' } }) }) });
    return c;
  };
  const res = await post(d, { body: { body: 'x' }, headers: { 'x-revin-secret': SECRET } });
  assert.equal(res.code, 500);
});

test('rate limit, client ip and pure helpers', () => {
  resetRateLimit();
  for (let i = 0; i < 3; i++) assert.equal(rateLimited('a', { limit: 3, now: 0 }), false);
  assert.equal(rateLimited('a', { limit: 3, now: 0 }), true);
  assert.equal(rateLimited('a', { limit: 3, now: 60_000 }), false, 'a new minute');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '9.9.9.9, 5.6.7.8' }, ip: '10.0.0.1' }), '5.6.7.8');
  assert.equal(clientIp({ headers: {}, ip: '10.0.0.1' }), '10.0.0.1');
  assert.deepEqual(storableHeaders({ 'X-Revin-Secret': 'x', Cookie: 'c', host: 'h' }), { host: 'h' });
  assert.deepEqual(parseBody(Buffer.from('[1]')).payload, [1]);
  assert.deepEqual(parseBody(Buffer.from('"str"')).payload, { _raw_text: '"str"' });
  assert.deepEqual(parseBody(Buffer.from('')).payload, { _raw_text: '' });
});

test('matching order: LP lead id first, then phone; the lead is filled from the contact', async () => {
  const calls = [];
  const deps = MATCH_DEPS({
    contactForLead: async (l) => { calls.push(`lead:${l}`); return l === '581695' ? 'abcdefghijKLMNOPqrst' : null; },
    contactForPhone: async (p, o) => { calls.push(`phone:${p}:${o.live}`); return 'PHONEcontact00000001'; },
    leadForContact: async (c) => { calls.push(`fill:${c}`); return '999'; },
  });
  assert.deepEqual(await matchContact({ lp_lead_id: '581695', phone_e164: '+13525550188' }, deps), { ghl_contact_id: 'abcdefghijKLMNOPqrst', lp_lead_id: '581695' });
  assert.deepEqual(calls, ['lead:581695']);
  calls.length = 0;
  assert.deepEqual(await matchContact({ lp_lead_id: '1', phone_e164: '+13525550188' }, deps, { live: true }), { ghl_contact_id: 'PHONEcontact00000001', lp_lead_id: '1' });
  assert.deepEqual(calls, ['lead:1', 'phone:+13525550188:true']);
  calls.length = 0;
  assert.deepEqual(await matchContact({ phone_e164: '+13525550188' }, deps), { ghl_contact_id: 'PHONEcontact00000001', lp_lead_id: '999' });
});

test('a processing failure is process_status error with the message, never a throw', async () => {
  const d = db({ revin_events_raw: [{ id: 'r1', payload: { body: 'x', phone: '3525550188' }, payload_hash: 'h', process_status: 'pending', attempts: 0 }] });
  const out = await processRevinEvent('r1', { deps: { supabase: d, ...MATCH_DEPS({ contactForPhone: async () => { throw new Error('mirror down'); } }) } });
  assert.equal(out.status, 'error');
  assert.equal(d.tables.revin_events_raw[0].process_status, 'error');
  assert.match(d.tables.revin_events_raw[0].process_error, /mirror down/);
  assert.equal(d.tables.revin_events_raw[0].attempts, 1);
});

test('a matched event is ok and carries the contact and lead', async () => {
  const d = db({ revin_events_raw: [{ id: 'r2', payload: { event: 'reply', from: '3525550188', text: 'yes' }, payload_hash: 'h2', process_status: 'pending', attempts: 0 }] });
  const out = await processRevinEvent('r2', { deps: { supabase: d, ...MATCH_DEPS({ contactForPhone: async () => 'abcdefghijKLMNOPqrst', leadForContact: async () => '581695' }) } });
  assert.equal(out.status, 'ok');
  assert.equal(d.tables.contact_messages[0].ghl_contact_id, 'abcdefghijKLMNOPqrst');
  assert.equal(d.tables.contact_messages[0].lp_lead_id, '581695');
  assert.equal(d.tables.contact_messages[0].direction, 'inbound');
});
