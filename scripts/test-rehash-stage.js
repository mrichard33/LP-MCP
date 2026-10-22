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
  isInRehash, decideRehash, stageFromRows, rehashRoutingMode, rehashTeamUserIds,
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
  // 2026-10-14 (Mark): only the plain tag goes to GHL; the lead and the demo date go to rehash_stage.
  assert.deepEqual(d.add, ['rehash']);
  assert.deepEqual(d.stageStart, { lp_lead_id: '581695', demo_date: '2026-10-07' });
});

test('active-f.0 and the rehash tag both read as rehash for the reply writer', () => {
  assert.equal(isRehashContact({ tags: ['active-f.0'] }), true);
  assert.equal(isRehashContact({ tags: ['Rehash'] }), true);
  assert.equal(isRehashContact({ tags: ['rehash-done:581695'] }), false);
  assert.equal(isInRehash({ tags: ['active-f.0'], currentLead: null, nowMs: NOW }), true);
});

test('not rehash: a pre-demo lead, a sale, a demo older than 30 days', () => {
  assert.equal(decideRehash({ currentLead: { ...monica, disposition_code: 'Set' }, nowMs: NOW }).action, 'none');
  assert.equal(decideRehash({ currentLead: { ...monica, disposition_code: 'Sale' }, nowMs: NOW }).action, 'none');
  const old = { ...monica, appointment_date: '2026-09-01 14:00:00+00' };
  assert.equal(decideRehash({ currentLead: old, nowMs: NOW }).reason, 'demo_older_than_window');
  assert.equal(isInRehash({ currentLead: old, nowMs: NOW }), false);
});

const tagged = ['rehash', 'canvass-v2'];
const openStage = { open: { lp_lead_id: '581695', demo_date: '2026-10-07' }, doneLeadIds: new Set() };

test('release on a NEWER lead for the same person', () => {
  const d = decideRehash({ tags: tagged, stage: openStage, currentLead: { lp_lead_id: '590001', disposition_code: 'Data', appointment_date: null }, owner: JOHN, rehashTeam: team, nowMs: NOW });
  assert.equal(d.action, 'release');
  assert.equal(d.reason, 'newer_lead');
  assert.deepEqual(d.remove, ['rehash']);
  assert.deepEqual(d.add, []);
  assert.deepEqual(d.stageEnd, { lp_lead_id: '581695', reason: 'newer_lead' });
  assert.equal(d.unassign, true);
});

test('release when our system took the lead out (a sale, NoRehash, a re-set visit)', () => {
  for (const disp of ['Sale', 'NoRehash', 'Set']) {
    const d = decideRehash({ tags: tagged, stage: openStage, currentLead: { ...monica, disposition_code: disp }, owner: JOHN, rehashTeam: team, nowMs: NOW });
    assert.equal(d.action, 'release', disp);
    assert.deepEqual(d.stageEnd, { lp_lead_id: '581695', reason: `disposition_${disp}` });
  }
});

test('30 days from the stored demo date: day 29 stays, day 30 releases', () => {
  const day = (n) => Date.parse('2026-10-07T12:00:00Z') + n * 86_400_000;
  assert.equal(decideRehash({ tags: tagged, stage: openStage, currentLead: monica, nowMs: day(29) }).action, 'none');
  const d = decideRehash({ tags: tagged, stage: openStage, currentLead: monica, owner: JOHN, rehashTeam: team, nowMs: day(30) });
  assert.deepEqual([d.action, d.reason, d.unassign], ['release', '30_days', true]);
  // The clock is the row's demo_date, not a later appointment date on the lead.
  const reset = { ...monica, appointment_date: '2026-11-01 14:00:00+00' };
  assert.equal(decideRehash({ tags: tagged, stage: openStage, currentLead: reset, nowMs: day(30) }).reason, '30_days');
});

test('an owner outside the rehash team is never unassigned', () => {
  const d = decideRehash({ tags: tagged, stage: openStage, currentLead: { ...monica, disposition_code: 'Sale' }, owner: 'someoneElse', rehashTeam: team, nowMs: NOW });
  assert.equal(d.unassign, false);
});

test('a finished stage never restarts for the same lead; a later lead can enter', () => {
  const done = { open: null, doneLeadIds: new Set(['581695']) };
  assert.equal(decideRehash({ tags: [], stage: done, currentLead: monica, nowMs: NOW }).reason, 'already_completed');
  assert.equal(isInRehash({ tags: [], stage: done, currentLead: monica, nowMs: NOW }), false);
  const later = { lp_lead_id: '590001', disposition_code: 'OPPFDN', appointment_date: '2026-10-08 14:00:00+00' };
  const d = decideRehash({ tags: [], stage: done, currentLead: later, nowMs: NOW });
  assert.equal(d.action, 'tag');
  assert.deepEqual(d.stageStart, { lp_lead_id: '590001', demo_date: '2026-10-08' });
});

test('self-heal: an open stage whose GHL tag went missing gets `rehash` back (no new row)', () => {
  const d = decideRehash({ tags: ['canvass-v2'], stage: openStage, currentLead: monica, nowMs: NOW });
  assert.deepEqual([d.action, d.reason, d.add], ['tag', 'self_heal', ['rehash']]);
  assert.equal(d.stageStart, undefined);
  // An open stage that has ended still releases, and removes no tag that is not there.
  const r = decideRehash({ tags: [], stage: openStage, currentLead: { ...monica, disposition_code: 'Sale' }, nowMs: NOW });
  assert.deepEqual([r.action, r.remove], ['release', []]);
});

test('a `rehash` tag with no open row: adopted when the lead qualifies, released when not', () => {
  const adopt = decideRehash({ tags: tagged, currentLead: monica, nowMs: NOW });
  assert.deepEqual([adopt.action, adopt.reason, adopt.add], ['tag', 'adopt_tagged', []]);
  assert.deepEqual(adopt.stageStart, { lp_lead_id: '581695', demo_date: '2026-10-07' });
  const sale = decideRehash({ tags: tagged, currentLead: { ...monica, disposition_code: 'Sale' }, nowMs: NOW });
  assert.deepEqual([sale.action, sale.remove, sale.stageEnd], ['release', ['rehash'], { lp_lead_id: '581695', reason: 'disposition_Sale' }]);
  const finished = decideRehash({ tags: tagged, stage: { open: null, doneLeadIds: new Set(['581695']) }, currentLead: monica, nowMs: NOW });
  assert.deepEqual([finished.action, finished.reason], ['release', 'already_completed']);
  assert.equal(decideRehash({ tags: tagged, currentLead: null, nowMs: NOW }).action, 'none');
});

test('no decision ever adds a tag holding a date or an id', () => {
  const cases = [
    decideRehash({ tags: [], currentLead: monica, nowMs: NOW }),
    decideRehash({ tags: tagged, stage: openStage, currentLead: { ...monica, disposition_code: 'Sale' }, nowMs: NOW }),
    decideRehash({ tags: ['x'], stage: openStage, currentLead: monica, nowMs: NOW }),
  ];
  for (const d of cases) for (const t of [...(d.add || []), ...(d.remove || [])]) assert.equal(t, 'rehash');
});

test('stageFromRows: the open row and the finished leads', () => {
  const st = stageFromRows([
    { lp_lead_id: 581695, demo_date: '2026-10-07', started_at: '2026-10-08T00:00:00Z', ended_at: null },
    { lp_lead_id: '438100', demo_date: null, ended_at: '2026-09-01T00:00:00Z' },
  ]);
  assert.deepEqual(st.open, { lp_lead_id: '581695', demo_date: '2026-10-07' });
  assert.deepEqual([...st.doneLeadIds], ['438100']);
  assert.deepEqual(stageFromRows(null), { open: null, doneLeadIds: new Set() });
});

test('rowsFor: removes first, then adds, then the owner release, all rule REHASH_TAG_SWEEP', () => {
  const rows = rowsFor('c1', { reason: '30_days', remove: ['rehash'], add: ['x'], unassign: true });
  assert.deepEqual(rows.map((r) => r.action_type), ['remove_tag', 'add_tag', 'release_rehash_owner']);
  assert.ok(rows.every((r) => r.rule_applied === 'REHASH_TAG_SWEEP' && r.status === 'pending' && r.requires_approval === false));
});

// ── the sweep, with fake reads ──────────────────────────────────────────────

function fakeSupabase({ demos = [], stageRows = [], leads = {}, fail = {} } = {}) {
  const inserted = [];
  const stage = stageRows.map((r) => ({ ended_at: null, end_reason: null, ...r }));
  const stageWrites = [];
  const from = (table) => {
    const f = { eq: {}, is: {}, in: null };
    let op = 'select';
    let payload = null;
    const match = (r) => Object.entries(f.eq).every(([k, v]) => String(r[k]) === String(v))
      && Object.entries(f.is).every(([k, v]) => (r[k] ?? null) === v)
      && (!f.in || f.in[1].includes(r[f.in[0]]));
    const run = () => {
      if (table === 'lp_leads') return { data: f.eq.ghl_contact_id ? (leads[f.eq.ghl_contact_id] || []) : demos, error: null };
      if (table === 'agent_actions') {
        if (op !== 'insert') return { data: [], error: null };
        if (fail.queue) return { error: { message: 'queue down' } };
        inserted.push(...payload);
        return { error: null };
      }
      if (table === 'rehash_stage') {
        if (op === 'insert') {
          if (fail.stageWrite) return { error: { message: 'stage down' } };
          for (const r of [].concat(payload)) {
            if (stage.some((x) => x.ghl_contact_id === r.ghl_contact_id && String(x.lp_lead_id) === String(r.lp_lead_id))) return { error: { code: '23505', message: 'duplicate' } };
            stage.push({ ended_at: null, ...r });
            stageWrites.push({ op: 'insert', ...r });
          }
          return { error: null };
        }
        if (fail.stageRead) return { data: null, error: { message: 'relation "rehash_stage" does not exist' } };
        const rows = stage.filter(match);
        if (op === 'update') {
          for (const r of rows) { Object.assign(r, payload); stageWrites.push({ op: 'update', ...r }); }
          return { data: rows.map((_, i) => ({ id: i + 1 })), error: null };
        }
        return { data: rows, error: null };
      }
      return { data: [], error: null };
    };
    const chain = {
      select: () => chain, not: () => chain, gte: () => chain, limit: () => chain, order: () => chain, contains: () => chain,
      eq: (k, v) => { f.eq[k] = v; return chain; },
      is: (k, v) => { f.is[k] = v; return chain; },
      in: (k, v) => { f.in = [k, v]; return chain; },
      insert: (p) => { op = 'insert'; payload = p; return Promise.resolve(run()); },
      update: (p) => { op = 'update'; payload = p; return chain; },
      then: (res, rej) => Promise.resolve(run()).then(res, rej),
    };
    return chain;
  };
  return { from, inserted, stage, stageWrites };
}

const sweepDeps = (sb, extra = {}) => ({ supabase: sb, env, now: () => NOW, log: () => {}, emitEvent: async () => {}, ...extra });

test('sweep (live): Monica gets ONE add_tag (rehash) and an open rehash_stage row', async () => {
  const sb = fakeSupabase({ demos: [{ ghl_contact_id: 'mon' }], leads: { mon: [monica] } });
  const res = await runRehashTagSweep(sweepDeps(sb, { getContact: async () => ({ tags: ['canvass-v2'], assignedTo: JOHN }) }));
  assert.equal(res.counts.tag, 1);
  assert.deepEqual(sb.inserted.map((r) => r.action_payload.tag), ['rehash']);
  assert.deepEqual(sb.stage.map((r) => [r.ghl_contact_id, r.lp_lead_id, r.demo_date, r.ended_at]), [['mon', '581695', '2026-10-07', null]]);
});

test('sweep (live): a release removes rehash and closes the open row', async () => {
  const sb = fakeSupabase({
    leads: { mon: [{ ...monica, disposition_code: 'Sale' }] },
    stageRows: [{ ghl_contact_id: 'mon', lp_lead_id: '581695', demo_date: '2026-10-07' }],
  });
  const res = await runRehashTagSweep(sweepDeps(sb, { getContact: async () => ({ tags: ['rehash'], assignedTo: JOHN }) }));
  assert.equal(res.counts.release, 1);
  assert.deepEqual(sb.inserted.map((r) => [r.action_type, r.action_payload.tag]), [['remove_tag', 'rehash'], ['release_rehash_owner', undefined]]);
  assert.equal(sb.stage[0].end_reason, 'disposition_Sale');
  assert.ok(sb.stage[0].ended_at);
});

test('sweep (live): a release with no open row records the finished lead as an ended row', async () => {
  const sb = fakeSupabase({ demos: [{ ghl_contact_id: 'mon' }], leads: { mon: [{ ...monica, appointment_date: '2026-09-01' }] } });
  await runRehashTagSweep(sweepDeps(sb, { getContact: async () => ({ tags: ['rehash'] }) }));
  assert.deepEqual(sb.stage.map((r) => [r.lp_lead_id, r.end_reason, Boolean(r.ended_at)]), [['581695', '30_days', true]]);
});

test('sweep (live): a failed queue insert leaves rehash_stage untouched', async () => {
  const sb = fakeSupabase({ demos: [{ ghl_contact_id: 'mon' }], leads: { mon: [monica] }, fail: { queue: true } });
  const res = await runRehashTagSweep(sweepDeps(sb, { getContact: async () => ({ tags: [] }) }));
  assert.equal(res.ok, false);
  assert.equal(sb.stage.length, 0);
});

test('sweep (live): a row written between the read and the insert is not a failure (23505)', async () => {
  const { writeStage } = await import('../src/jobs/rehash-tag-sweep.js');
  const sb = fakeSupabase({ stageRows: [{ ghl_contact_id: 'mon', lp_lead_id: '581695', demo_date: '2026-10-07' }] });
  const err = await writeStage(sb, 'mon', { stageStart: { lp_lead_id: '581695', demo_date: '2026-10-07' } }, new Date(NOW).toISOString());
  assert.equal(err, null);
  assert.equal(sb.stage.length, 1);
});

test('sweep: a rehash_stage read that fails decides nothing', async () => {
  const sb = fakeSupabase({ demos: [{ ghl_contact_id: 'mon' }], leads: { mon: [monica] }, fail: { stageRead: true } });
  let reads = 0;
  const res = await runRehashTagSweep(sweepDeps(sb, { getContact: async () => { reads++; return { tags: [] }; } }));
  assert.equal(res.insufficient_evidence, true);
  assert.equal(reads, 0);
  assert.equal(sb.inserted.length, 0);
});

test('sweep: an open rehash_stage row makes the contact a candidate', async () => {
  const sb = fakeSupabase({
    leads: { old: [{ ...monica, disposition_code: 'NoRehash' }] },
    stageRows: [{ ghl_contact_id: 'old', lp_lead_id: '581695', demo_date: '2026-10-07' }],
  });
  const res = await runRehashTagSweep(sweepDeps(sb, { getContact: async () => ({ tags: ['rehash'] }) }));
  assert.equal(res.candidates, 1);
  assert.equal(res.counts.release, 1);
});

test('sweep (shadow): decides, queues nothing, writes no stage row, records would_tag', async () => {
  const sb = fakeSupabase({ demos: [{ ghl_contact_id: 'mon' }], leads: { mon: [monica] } });
  const events = [];
  const res = await runRehashTagSweep({
    supabase: sb, env: { REHASH_ROUTING_MODE: 'shadow' }, now: () => NOW, log: () => {},
    getContact: async () => ({ tags: [] }), emitEvent: async (e) => { events.push(e); },
  });
  assert.equal(res.counts.tag, 1);
  assert.equal(sb.inserted.length, 0);
  assert.equal(sb.stage.length, 0);
  assert.deepEqual(events.map((e) => e.event_type), ['rehash.would_tag']);
  assert.deepEqual(events[0].payload.stage_start, { lp_lead_id: '581695', demo_date: '2026-10-07' });
});

test('sweep: a contact read that fails is skipped, not decided', async () => {
  const sb = fakeSupabase({ demos: [{ ghl_contact_id: 'mon' }], leads: { mon: [monica] } });
  const res = await runRehashTagSweep(sweepDeps(sb, { getContact: async () => { throw new Error('GHL 429'); } }));
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

const monStage = [{ ghl_contact_id: 'mon', lp_lead_id: '581695', demo_date: '2026-10-07' }];

test('sweep: a settled contact read live in the last 24h is not read again', async () => {
  const sb = fakeSupabase({ demos: [{ ghl_contact_id: 'mon' }], leads: { mon: [monica] }, stageRows: monStage });
  let reads = 0;
  const res = await runRehashTagSweep({
    supabase: sb, env, now: () => NOW, log: () => {},
    readSnapshotTags: async () => new Map([['mon', ['rehash']]]),
    liveReadAt: new Map([['mon', NOW - 3_600_000]]),
    getContact: async () => { reads++; return { tags: [] }; },
    emitEvent: async () => {},
  });
  assert.equal(reads, 0);
  assert.equal(res.counts.live_reads_skipped, 1);
  assert.equal(sb.inserted.length, 0);
});

test('sweep: a snapshot that says act is checked live, and the LIVE tags decide', async () => {
  const sb = fakeSupabase({ demos: [{ ghl_contact_id: 'mon' }], leads: { mon: [monica] }, stageRows: monStage });
  // Snapshot is stale (no rehash tag), GHL already has it: no write.
  const liveReadAt = new Map([['mon', NOW - 1000]]);
  let reads = 0;
  const res = await runRehashTagSweep({
    supabase: sb, env, now: () => NOW, log: () => {},
    readSnapshotTags: async () => new Map([['mon', []]]),
    liveReadAt,
    getContact: async () => { reads++; return { tags: ['rehash'] }; },
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
  assert.equal(isInRehash({ tags: ['rehash'], currentLead: sold, nowMs: NOW }), false);
  assert.equal(isInRehash({ tags: ['active-f.0'], currentLead: { lp_lead_id: '1', disposition_code: 'OPPFDN', closed_won: true }, nowMs: NOW }), false, 'closed_won counts');
  assert.equal(isInRehash({ tags: ['active-f.0'], currentLead: { lp_lead_id: '1', disposition_code: 'OPPFDN' }, nowMs: NOW }), true, 'an unsold F.0 lead stays in rehash');
  assert.equal(isInRehash({ tags: ['active-f.0'], currentLead: null, nowMs: NOW }), true, 'no LP lead: the tag still decides');
});

test('the sweep releases a tagged lead whose current lead is a Sale', () => {
  const dec = decideRehash({
    tags: ['rehash'],
    stage: { open: { lp_lead_id: '582924', demo_date: '2026-10-01' }, doneLeadIds: new Set() },
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

// 2026-10-21 (the user): the first F.0 test's hand-made stage was closed by
// this sweep (Mark Test's own LP lead is 'Data'). A contact listed in
// F0_TEST_LINKS is never opened, closed, tagged or untagged.
test('sweep (live): a test contact linked by F0_TEST_LINKS is skipped entirely', async () => {
  const TEST = 'hZOcPk6XmMvWVvjZJ7mz';
  const sb = fakeSupabase({
    leads: { [TEST]: [{ lp_lead_id: '583364', disposition_code: 'Data', appointment_date: null }] },
    stageRows: [{ ghl_contact_id: TEST, lp_lead_id: '583780', demo_date: '2026-10-14' }],
  });
  let reads = 0;
  const res = await runRehashTagSweep(sweepDeps(sb, {
    env: { ...env, F0_TEST_LINKS: `${TEST}:583780` },
    getContact: async () => { reads++; return { tags: ['rehash', 'aios-test'] }; },
  }));
  assert.equal(res.counts.test_linked_skipped, 1);
  assert.equal(res.counts.release, 0);
  assert.equal(reads, 0);
  assert.deepEqual(sb.inserted, []);
  assert.equal(sb.stage[0].ended_at, null);
});
