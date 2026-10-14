/**
 * Rehash stage (the user, 2026-10-09). Monica (LP lead 581695, OPPFDN after her
 * 10/7 demo) was handled as a new sales lead on 10/8: a Five9 sales callback, a
 * moved appointment, an LP re-set. Rulings: OPPFDN → rehash tag; a newer lead
 * ends it; 30 days after the demo (or sooner, when our system took the lead
 * out) the tag comes off and the rehash rep stops owning the contact; rehash
 * call requests go to #contact-rehash, never Five9.
 *
 * Run: node --test scripts/test-rehash-stage.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isInRehash, decideRehash, readRehashTags, rehashRoutingMode, rehashTeamUserIds,
} from '../src/agentic/rehash-state.js';
import { isRehashContact } from '../src/agentic/rehash.js';
import { rowsFor, runRehashTagSweep, passSlice } from '../src/jobs/rehash-tag-sweep.js';
import { executeReleaseRehashOwner } from '../src/actions/handlers/rehash-owner.js';
import { readRequeueResult, five9ResultLine, fileBotCallback } from '../src/agentic/bot-callback.js';

const NOW = Date.parse('2026-10-09T15:00:00Z');
const JOHN = 'TYcZ9DcNkuPCFYsFxRFV';
const team = new Set([JOHN]);
const monica = { lp_lead_id: '581695', disposition_code: 'OPPFDN', appointment_date: '2026-10-07 14:00:00+00' };
const env = { REHASH_ROUTING_MODE: 'live' };

test('mode: default shadow, a typo is shadow, off and live parse', () => {
  assert.equal(rehashRoutingMode({}), 'shadow');
  assert.equal(rehashRoutingMode({ REHASH_ROUTING_MODE: 'lvie' }), 'shadow');
  assert.equal(rehashRoutingMode({ REHASH_ROUTING_MODE: 'off' }), 'off');
  assert.equal(rehashRoutingMode({ REHASH_ROUTING_MODE: 'LIVE' }), 'live');
});

test('team: John Manieri by default, the env list when set', () => {
  assert.deepEqual([...rehashTeamUserIds({})], [JOHN]);
  assert.deepEqual([...rehashTeamUserIds({ REHASH_TEAM_USER_IDS: 'a, b' })], ['a', 'b']);
});

test('Monica: an OPPFDN demo 2 days ago with no F.0 tag is in rehash and gets tagged', () => {
  assert.equal(isInRehash({ tags: [], currentLead: monica, nowMs: NOW }), true);
  const d = decideRehash({ tags: [], currentLead: monica, nowMs: NOW });
  assert.equal(d.action, 'tag');
  assert.deepEqual(d.add, ['rehash', 'rehash-lead:581695', 'rehash-since:2026-10-07']);
});

test('active-f.0 and the rehash tag both read as rehash for the reply writer', () => {
  assert.equal(isRehashContact({ tags: ['active-f.0'] }), true);
  assert.equal(isRehashContact({ tags: ['Rehash'] }), true);
  assert.equal(isRehashContact({ tags: ['rehash-done:581695'] }), false);
});

test('not rehash: a pre-demo lead, a sale, a demo older than 30 days', () => {
  assert.equal(decideRehash({ currentLead: { ...monica, disposition_code: 'Set' }, nowMs: NOW }).action, 'none');
  assert.equal(decideRehash({ currentLead: { ...monica, disposition_code: 'Sale' }, nowMs: NOW }).action, 'none');
  const old = { ...monica, appointment_date: '2026-09-01 14:00:00+00' };
  assert.equal(decideRehash({ currentLead: old, nowMs: NOW }).reason, 'demo_older_than_window');
  assert.equal(isInRehash({ currentLead: old, nowMs: NOW }), false);
});

const tagged = ['rehash', 'rehash-lead:581695', 'rehash-since:2026-10-07', 'canvass-v2'];

test('release on a NEWER lead for the same person', () => {
  const d = decideRehash({ tags: tagged, currentLead: { lp_lead_id: '590001', disposition_code: 'Data', appointment_date: null }, owner: JOHN, rehashTeam: team, nowMs: NOW });
  assert.equal(d.action, 'release');
  assert.equal(d.reason, 'newer_lead');
  assert.deepEqual(d.remove, ['rehash', 'rehash-lead:581695', 'rehash-since:2026-10-07']);
  assert.deepEqual(d.add, ['rehash-done:581695']);
  assert.equal(d.unassign, true);
});

test('release when our system took the lead out (a sale, NoRehash, a re-set visit)', () => {
  for (const disp of ['Sale', 'NoRehash', 'Set']) {
    const d = decideRehash({ tags: tagged, currentLead: { ...monica, disposition_code: disp }, owner: JOHN, rehashTeam: team, nowMs: NOW });
    assert.equal(d.action, 'release', disp);
  }
});

test('30 days: day 29 stays, day 30 releases', () => {
  const day = (n) => Date.parse('2026-10-07T12:00:00Z') + n * 86_400_000;
  assert.equal(decideRehash({ tags: tagged, currentLead: monica, nowMs: day(29) }).action, 'none');
  const d = decideRehash({ tags: tagged, currentLead: monica, owner: JOHN, rehashTeam: team, nowMs: day(30) });
  assert.deepEqual([d.action, d.reason, d.unassign], ['release', '30_days', true]);
});

test('an owner outside the rehash team is never unassigned', () => {
  const d = decideRehash({ tags: tagged, currentLead: { ...monica, disposition_code: 'Sale' }, owner: 'someoneElse', rehashTeam: team, nowMs: NOW });
  assert.equal(d.unassign, false);
});

test('a finished stage never restarts for the same lead; a later lead can enter', () => {
  const done = ['rehash-done:581695'];
  assert.equal(decideRehash({ tags: done, currentLead: monica, nowMs: NOW }).reason, 'already_completed');
  assert.equal(isInRehash({ tags: done, currentLead: monica, nowMs: NOW }), false);
  const later = { lp_lead_id: '590001', disposition_code: 'OPPFDN', appointment_date: '2026-10-08 14:00:00+00' };
  assert.equal(decideRehash({ tags: done, currentLead: later, nowMs: NOW }).action, 'tag');
});

test('readRehashTags reads the lead and the date', () => {
  const t = readRehashTags(tagged);
  assert.deepEqual([t.tagged, t.ldsId, t.since], [true, '581695', '2026-10-07']);
});

test('rowsFor: removes first, then adds, then the owner release, all rule REHASH_TAG_SWEEP', () => {
  const rows = rowsFor('c1', { reason: '30_days', remove: ['rehash'], add: ['rehash-done:1'], unassign: true });
  assert.deepEqual(rows.map((r) => r.action_type), ['remove_tag', 'add_tag', 'release_rehash_owner']);
  assert.ok(rows.every((r) => r.rule_applied === 'REHASH_TAG_SWEEP' && r.status === 'pending' && r.requires_approval === false));
});

// ── the sweep, with fake reads ──────────────────────────────────────────────

function fakeSupabase({ demos = [], history = [], leads = {} } = {}) {
  const inserted = [];
  const builder = (table) => {
    const q = { _table: table, _filters: {} };
    const chain = new Proxy(q, {
      get(target, prop) {
        if (prop === 'then') {
          const data = table === 'lp_leads' && target._filters.ghl_contact_id
            ? (leads[target._filters.ghl_contact_id] || [])
            : table === 'lp_leads' ? demos : history;
          return (res) => res({ data, error: null });
        }
        if (prop === 'insert') return (rows) => { inserted.push(...rows); return Promise.resolve({ error: null }); };
        if (prop === 'eq') return (k, v) => { target._filters[k] = v; return chain; };
        return () => chain;
      },
    });
    return chain;
  };
  return { from: builder, inserted };
}

test('sweep (live): Monica is tagged through three add_tag rows', async () => {
  const sb = fakeSupabase({ demos: [{ ghl_contact_id: 'mon' }], leads: { mon: [monica] } });
  const res = await runRehashTagSweep({
    supabase: sb, env, now: () => NOW, log: () => {},
    getContact: async () => ({ tags: ['canvass-v2'], assignedTo: JOHN }),
    emitEvent: async () => {},
  });
  assert.equal(res.counts.tag, 1);
  assert.deepEqual(sb.inserted.map((r) => r.action_payload.tag), ['rehash', 'rehash-lead:581695', 'rehash-since:2026-10-07']);
});

test('sweep (shadow): decides, queues nothing, records would_tag', async () => {
  const sb = fakeSupabase({ demos: [{ ghl_contact_id: 'mon' }], leads: { mon: [monica] } });
  const events = [];
  const res = await runRehashTagSweep({
    supabase: sb, env: { REHASH_ROUTING_MODE: 'shadow' }, now: () => NOW, log: () => {},
    getContact: async () => ({ tags: [] }), emitEvent: async (e) => { events.push(e.event_type); },
  });
  assert.equal(res.counts.tag, 1);
  assert.equal(sb.inserted.length, 0);
  assert.deepEqual(events, ['rehash.would_tag']);
});

test('sweep: a contact read that fails is skipped, not decided', async () => {
  const sb = fakeSupabase({ demos: [{ ghl_contact_id: 'mon' }], leads: { mon: [monica] } });
  const res = await runRehashTagSweep({
    supabase: sb, env, now: () => NOW, log: () => {},
    getContact: async () => { throw new Error('GHL 429'); }, emitEvent: async () => {},
  });
  assert.equal(res.counts.unreadable, 1);
  assert.equal(sb.inserted.length, 0);
});

test('sweep: off does nothing', async () => {
  const res = await runRehashTagSweep({ env: { REHASH_ROUTING_MODE: 'off' }, supabase: {}, getContact: async () => null, emitEvent: async () => {} });
  assert.equal(res.skipped, true);
});

// ── owner release ───────────────────────────────────────────────────────────

test('release_rehash_owner clears a rehash rep and reads it back', async () => {
  let owner = JOHN;
  const calls = [];
  const res = await executeReleaseRehashOwner({ target_id: 'c1' }, {}, {
    team,
    ghlFetch: async (method, path, body) => {
      calls.push(method);
      if (method === 'PUT') owner = body.assignedTo;
      return { contact: { assignedTo: owner } };
    },
  });
  assert.equal(res.action, 'owner_released');
  assert.deepEqual(calls, ['GET', 'PUT', 'GET']);
});

test('release_rehash_owner leaves a non-rehash owner alone', async () => {
  const res = await executeReleaseRehashOwner({ target_id: 'c1' }, {}, {
    team, ghlFetch: async (m) => { if (m === 'PUT') throw new Error('must not write'); return { contact: { assignedTo: 'sales-rep' } }; },
  });
  assert.equal(res.action, 'owner_not_rehash_team');
});

test('release_rehash_owner fails loudly when GHL keeps the owner', async () => {
  await assert.rejects(executeReleaseRehashOwner({ target_id: 'c1' }, {}, {
    team, ghlFetch: async () => ({ contact: { assignedTo: JOHN } }),
  }), /GHL kept owner/);
});

// ── callbacks: rehash → #contact-rehash, not Five9, no #contact-center card ──

test('a rehash requeue result reads as rehash and its line names #contact-rehash', () => {
  const r = readRequeueResult({ status: 'completed', result: { action: 'skipped_rehash_lead' } });
  assert.equal(r.status, 'rehash');
  assert.match(five9ResultLine(r), /#contact-rehash/);
});

test('fileBotCallback posts no #contact-center card for a rehash lead', async () => {
  let carded = 0;
  const res = await fileBotCallback({ contactId: 'c1', inbound: 'call me', nowMs: NOW }, {
    alreadyFiled: async () => false, claim: async () => {}, log: () => {},
    queueRequeue: async () => ({ status: 'completed', result: { action: 'skipped_rehash_lead' } }),
    routeHandoff: async () => { carded++; },
  });
  assert.equal(res.five9.status, 'rehash');
  assert.equal(carded, 0);
});

test('passSlice rotates so every candidate is reached', () => {
  const ids = Array.from({ length: 150 }, (_, i) => `c${i}`);
  const seen = new Set();
  for (let pass = 0; pass < 3; pass++) for (const id of passSlice(ids, pass * 15 * 60 * 1000)) seen.add(id);
  assert.equal(seen.size, 150);
  assert.deepEqual(passSlice(['a', 'b'], NOW), ['a', 'b']);
});

// stage:post-appointment (the user, 2026-10-09): read only to keep a post-demo
// lead off the Confirmation Call calendar; it never puts a contact in rehash.
test('hasPostAppointmentStage reads the GHL stage tag, case-insensitive', async () => {
  const { hasPostAppointmentStage, isInRehash } = await import('../src/agentic/rehash-state.js');
  assert.equal(hasPostAppointmentStage(['Stage:Post-Appointment']), true);
  assert.equal(hasPostAppointmentStage(['stage:reactivation']), false);
  assert.equal(hasPostAppointmentStage(undefined), false);
  assert.equal(isInRehash({ tags: ['stage:post-appointment'] }), false, 'the stage tag alone is not rehash');
});

// ── GHL reads: decide from the tag snapshot, read live only to act (2026-10-13) ──

test('canSkipLiveRead: only a snapshot "none" with a live read inside 24h', async () => {
  const { canSkipLiveRead, LIVE_RECHECK_MS } = await import('../src/jobs/rehash-tag-sweep.js');
  const none = { action: 'none' };
  assert.equal(canSkipLiveRead({ snapshotDecision: none, lastLiveMs: NOW - 1000, nowMs: NOW }), true);
  assert.equal(canSkipLiveRead({ snapshotDecision: none, lastLiveMs: NOW - LIVE_RECHECK_MS, nowMs: NOW }), false);
  assert.equal(canSkipLiveRead({ snapshotDecision: none, lastLiveMs: undefined, nowMs: NOW }), false);
  assert.equal(canSkipLiveRead({ snapshotDecision: { action: 'tag' }, lastLiveMs: NOW, nowMs: NOW }), false);
  assert.equal(canSkipLiveRead({ snapshotDecision: null, lastLiveMs: NOW, nowMs: NOW }), false);
});

test('sweep: a settled contact read live in the last 24h is not read again', async () => {
  const sb = fakeSupabase({ demos: [{ ghl_contact_id: 'mon' }], leads: { mon: [monica] } });
  let reads = 0;
  const res = await runRehashTagSweep({
    supabase: sb, env, now: () => NOW, log: () => {},
    readSnapshotTags: async () => new Map([['mon', ['rehash', 'rehash-lead:581695', 'rehash-since:2026-10-07']]]),
    liveReadAt: new Map([['mon', NOW - 3_600_000]]),
    getContact: async () => { reads++; return { tags: [] }; },
    emitEvent: async () => {},
  });
  assert.equal(reads, 0);
  assert.equal(res.counts.live_reads_skipped, 1);
  assert.equal(sb.inserted.length, 0);
});

test('sweep: a snapshot that says act is checked live, and the LIVE tags decide', async () => {
  const sb = fakeSupabase({ demos: [{ ghl_contact_id: 'mon' }], leads: { mon: [monica] } });
  // Snapshot is stale (no rehash tag), GHL already has it: no write.
  const liveReadAt = new Map([['mon', NOW - 1000]]);
  let reads = 0;
  const res = await runRehashTagSweep({
    supabase: sb, env, now: () => NOW, log: () => {},
    readSnapshotTags: async () => new Map([['mon', []]]),
    liveReadAt,
    getContact: async () => { reads++; return { tags: ['rehash', 'rehash-lead:581695', 'rehash-since:2026-10-07'] }; },
    emitEvent: async () => {},
  });
  assert.equal(reads, 1);
  assert.equal(res.counts.none, 1);
  assert.equal(sb.inserted.length, 0, 'a stale snapshot never writes');
});

test('sweep: a contact missing from the snapshot, or a failed snapshot read, is read live', async () => {
  for (const readSnapshotTags of [async () => new Map(), async () => null]) {
    const sb = fakeSupabase({ demos: [{ ghl_contact_id: 'mon' }], leads: { mon: [monica] } });
    let reads = 0;
    const res = await runRehashTagSweep({
      supabase: sb, env, now: () => NOW, log: () => {}, readSnapshotTags,
      liveReadAt: new Map([['mon', NOW - 1000]]),
      getContact: async () => { reads++; return { tags: [] }; },
      emitEvent: async () => {},
    });
    assert.equal(reads, 1);
    assert.equal(res.counts.tag, 1);
  }
});

// ── 2026-10-14 (John Manieri: "Koger is already sold and set") ──
test('a SOLD current lead is not in rehash, even with active-f.0 or rehash still on', () => {
  const sold = { lp_lead_id: '582924', disposition_code: 'Sale', appointment_date: '2026-10-12' };
  assert.equal(isInRehash({ tags: ['active-f.0'], currentLead: sold, nowMs: NOW }), false);
  assert.equal(isInRehash({ tags: ['rehash', 'rehash-lead:581701'], currentLead: sold, nowMs: NOW }), false);
  assert.equal(isInRehash({ tags: ['active-f.0'], currentLead: { lp_lead_id: '1', disposition_code: 'OPPFDN', closed_won: true }, nowMs: NOW }), false, 'closed_won counts');
  assert.equal(isInRehash({ tags: ['active-f.0'], currentLead: { lp_lead_id: '1', disposition_code: 'OPPFDN' }, nowMs: NOW }), true, 'an unsold F.0 lead stays in rehash');
  assert.equal(isInRehash({ tags: ['active-f.0'], currentLead: null, nowMs: NOW }), true, 'no LP lead: the tag still decides');
});

test('the sweep releases a tagged lead whose current lead is a Sale', () => {
  const dec = decideRehash({
    tags: ['rehash', 'rehash-lead:582924', 'rehash-since:2026-10-01'],
    currentLead: { lp_lead_id: '582924', disposition_code: 'Sale', appointment_date: '2026-10-01' },
    nowMs: NOW,
  });
  assert.equal(dec.action, 'release');
  assert.equal(dec.reason, 'disposition_Sale');
});

test('rehashLeadFromContext carries closed_won, so the reply writer skips a sold lead', async () => {
  const { rehashLeadFromContext } = await import('../src/agentic/rehash-state.js');
  const lead = rehashLeadFromContext({ matched: true, lead_id: 9, disposition: 'OPPFDN', demo_date: '2026-10-07', closed_won: true });
  assert.equal(lead.closed_won, true);
  assert.equal(isInRehash({ tags: ['active-f.0'], currentLead: lead, nowMs: NOW }), false);
});

test('the rehash Five9 line no longer claims a call card was posted', () => {
  const line = five9ResultLine({ status: 'rehash' });
  assert.doesNotMatch(line, /was told/);
  assert.match(line, /call, quote or concern/);
});

test('the reply writer never treats a sold lead as rehash by its tag (source guard)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/response-generator.js', import.meta.url), 'utf8');
  assert.match(src, /const rehashTagged = channel === 'sms' && !lpSold\(context\.lp\) && isRehashContact\(/);
});
