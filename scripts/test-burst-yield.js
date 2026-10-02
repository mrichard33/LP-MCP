/**
 * 2026-10-02 (Mark): a lead who fires several texts gets ONE reply. A reply
 * job yields to a newer real message that has its own job; never to a
 * trivial event, a bare "ok", or a retry of a message it already answers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { findNewerInbound } from '../src/agentic/burst-yield.js';

function fakeSupabase(rows, seen = {}) {
  const q = {
    _f: [],
    select() { return q; },
    eq(k, v) { q._f.push(['eq', k, v]); return q; },
    gt(k, v) { seen.gt = [k, v]; q._f.push(['gt', k, v]); return q; },
    order() { return q; },
    async limit() {
      let out = rows;
      for (const [op, k, v] of q._f) {
        if (op === 'eq') out = out.filter(r => r[k] === v);
        if (op === 'gt') out = out.filter(r => (k === 'id' ? r.id > v : r.created_at > v));
      }
      return { data: out, error: null };
    },
  };
  return { from() { q._f = []; return q; } };
}
const EV = (id, text, extra = {}) => ({ id, ghl_contact_id: 'C1', event_type: 'ghl.reply_received', event_subtype: null, created_at: `2026-10-02T12:00:${String(id).padStart(2, '0')}Z`, payload: { message_text: text, message_id: `m${id}` }, ...extra });
const PAYLOAD = { last_inbound_event_id: 10, inbound_message_keys: ['m9', 'm10'], message_id: 'm10' };

test('a newer real message after the batch → this reply yields', async () => {
  const rows = [EV(9, 'how much for windows'), EV(10, 'and doors'), EV(12, 'also do you do sliders?')];
  const hit = await findNewerInbound({ contactId: 'C1', payload: PAYLOAD }, { supabase: fakeSupabase(rows) });
  assert.equal(hit.id, 12);
});

test('nothing newer → send', async () => {
  const rows = [EV(9, 'how much for windows'), EV(10, 'and doors')];
  assert.equal(await findNewerInbound({ contactId: 'C1', payload: PAYLOAD }, { supabase: fakeSupabase(rows) }), null);
});

test('a trivial event or a bare "ok" never silences the reply', async () => {
  const rows = [EV(11, 'ok'), EV(12, 'thanks!'), EV(13, 'sounds good', { event_subtype: 'trivial' })];
  assert.equal(await findNewerInbound({ contactId: 'C1', payload: PAYLOAD }, { supabase: fakeSupabase(rows) }), null);
});

test('"yes" is an answer with its own job → yields', async () => {
  const hit = await findNewerInbound({ contactId: 'C1', payload: PAYLOAD }, { supabase: fakeSupabase([EV(11, 'yes')]) });
  assert.equal(hit.id, 11);
});

test('a GHL retry of a message in this batch does not count', async () => {
  const retry = EV(11, 'and doors'); retry.payload.message_id = 'm10';
  assert.equal(await findNewerInbound({ contactId: 'C1', payload: PAYLOAD }, { supabase: fakeSupabase([retry]) }), null);
});

test('no boundary on the payload (older paths) or a read error → send as before', async () => {
  assert.equal(await findNewerInbound({ contactId: 'C1', payload: {} }, { supabase: fakeSupabase([EV(11, 'hello there')]) }), null);
  const broken = { from() { throw new Error('down'); } };
  assert.equal(await findNewerInbound({ contactId: 'C1', payload: PAYLOAD }, { supabase: broken }), null);
});

test('falls back to the created_at boundary when the id is missing', async () => {
  const seen = {};
  const hit = await findNewerInbound({ contactId: 'C1', payload: { last_inbound_event_created_at: '2026-10-02T12:00:10Z' } }, { supabase: fakeSupabase([EV(9, 'old one'), EV(12, 'new one here')], seen) });
  assert.deepEqual(seen.gt, ['created_at', '2026-10-02T12:00:10Z']);
  assert.equal(hit.id, 12);
});
