/**
 * Tests — Call Intelligence discovery: the 5000-row cap, transfer grouping,
 * eligibility, and idempotent upsert
 * scripts/test-ci-discovery.js
 *
 * THE TRAPS THESE GUARD:
 *
 * 1. THE ROW CAP IS SILENT. The saved Call Log report truncates at 5000 rows
 *    and returns no error — you simply get 5000 and lose the rest. Accepting a
 *    capped window means losing calls with no trace, so a window at the cap
 *    must SPLIT and re-pull, and a window that cannot be split further must
 *    THROW rather than return a plausible-looking short answer.
 * 2. RE-DISCOVERY MUST NOT RESET STATE. A call part-way through the pipeline
 *    that gets re-discovered (reconciliation, a retried tick, an overlapping
 *    backfill) must not be dragged back to 'discovered' and re-processed.
 * 3. INELIGIBLE IS RECORDED, NOT DROPPED. A skipped call keeps a reason, so a
 *    wrong duration floor is visible instead of invisible.
 *
 * No network, no DB — the report call and the Supabase client are injected.
 * Run: node --test scripts/test-ci-discovery.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveColumns,
  durationToSeconds,
  parseRecordingSegments,
  zipRow,
  groupByCallId,
  isTransferGroup,
  evaluateEligibility,
  buildCallRow,
  teamFromAgentMap,
  loadAgentMap,
  pullWindow,
  discoverCalls,
  REPORT_ROW_CAP,
} from '../src/ci/discovery.js';
import { parseConfig } from '../src/ci/config.js';

const CFG = parseConfig({});   // shadow, minSeconds 30

const HEADERS = ['CALL ID', 'TIMESTAMP', 'CALL TIME', 'CALL TYPE', 'ANI', 'DNIS', 'CAMPAIGN', 'SKILL', 'DISPOSITION', 'AGENT', 'AGENT ID', 'RECORDINGS'];

/** Build a positional report row matching HEADERS. */
function row({
  callId = '3000000102', ts = '2026-08-05 14:30:12', dur = '00:02:15', type = 'Outbound',
  ani = '9419203087', dnis = '7275551234', campaign = 'Main Number', skill = '', disp = 'Appointment Set',
  agent = 'Miguel Giraldo', agentId = '300000002234619', recordings = '',
} = {}) {
  return [callId, ts, dur, type, ani, dnis, campaign, skill, disp, agent, agentId, recordings];
}

function reportStub(rows, columns = HEADERS) {
  return async () => ({ done: true, columns, rows });
}

/** Minimal Supabase double: records what was upserted. */
function dbStub({ campaignRows = [], agentRows = [], upsertResult } = {}) {
  const calls = { upserts: [] };
  const db = {
    _calls: calls,
    from(table) {
      if (table === 'ci_campaign_map') {
        return { select: async () => ({ data: campaignRows, error: null }) };
      }
      if (table === 'ci_agent_map') {
        return { select: async () => ({ data: agentRows, error: null }) };
      }
      return {
        upsert(rows, opts) {
          calls.upserts.push({ table, rows, opts });
          return {
            select: async () => upsertResult ?? { data: rows.map((_, i) => ({ id: `id-${i}` })), error: null },
          };
        },
      };
    },
  };
  return db;
}

// ─── column resolution ──────────────────────────────────────────────────────

test('report headers resolve to indexes regardless of case and spacing', () => {
  const { index, missing } = resolveColumns(HEADERS);
  assert.deepEqual(missing, []);
  assert.equal(index.callId, 0);
  assert.equal(index.timestamp, 1);
  assert.equal(index.campaign, 6);
  assert.equal(index.recordings, 11);
});

test('a missing REQUIRED column is reported rather than silently null', () => {
  const { missing } = resolveColumns(['CAMPAIGN', 'AGENT']);
  assert.ok(missing.includes('callId'));
  assert.ok(missing.includes('timestamp'));
});

test('zipRow maps positional cells onto names and trims', () => {
  const { index } = resolveColumns(HEADERS);
  const z = zipRow(row({ campaign: '  Main Number  ' }), index);
  assert.equal(z.callId, '3000000102');
  assert.equal(z.campaign, 'Main Number');
});

// ─── cell parsing ───────────────────────────────────────────────────────────

test('durations parse from HH:MM:SS, MM:SS, and bare seconds', () => {
  assert.equal(durationToSeconds('00:02:15'), 135);
  assert.equal(durationToSeconds('02:15'), 135);
  assert.equal(durationToSeconds('135'), 135);
  assert.equal(durationToSeconds(''), null);
  assert.equal(durationToSeconds('abc'), null);
});

test('RECORDINGS segments parse, including the multi-segment hold case', () => {
  assert.deepEqual(parseRecordingSegments('07:35:54(1:56)'), [{ at: '07:35:54', duration: '1:56' }]);
  // A real Appointment Set call carried 7 segments around holds.
  const seven = parseRecordingSegments(
    '09:00:01(0:30) 09:01:00(0:30) 09:02:00(0:30) 09:03:00(0:30) 09:04:00(0:30) 09:05:00(0:30) 09:06:00(0:30)',
  );
  assert.equal(seven.length, 7);
  assert.deepEqual(parseRecordingSegments(''), []);
});

// ─── transfer detection ─────────────────────────────────────────────────────

test('two rows sharing a Call ID group into ONE call marked transferred', () => {
  const { index } = resolveColumns(HEADERS);
  const rows = [
    zipRow(row({ callId: '300000010260259', type: 'Inbound', campaign: 'Canvass Confirmation - Inbound' }), index),
    zipRow(row({ callId: '300000010260259', type: '3rd party transfer', agent: '', agentId: '' }), index),
  ];
  const groups = groupByCallId(rows);
  assert.equal(groups.size, 1, 'one call, not two');
  const legs = groups.get('300000010260259');
  assert.equal(legs.length, 2);
  assert.equal(isTransferGroup(legs), true);
});

test('a single ordinary leg is not a transfer', () => {
  const { index } = resolveColumns(HEADERS);
  assert.equal(isTransferGroup([zipRow(row({ type: 'Outbound' }), index)]), false);
});

test('a lone leg typed as a transfer still counts as transferred', () => {
  const { index } = resolveColumns(HEADERS);
  assert.equal(isTransferGroup([zipRow(row({ type: '3rd party transfer' }), index)]), true);
});

// ─── eligibility ────────────────────────────────────────────────────────────

test('below the duration floor is skipped WITH a reason', () => {
  const r = evaluateEligibility({ duration_seconds: 12, agent_name: 'X' }, null, CFG);
  assert.deepEqual(r, { eligible: false, reason: 'below_min_seconds' });
});

test('a non-transfer call with no agent is skipped; a transfer leg is not', () => {
  assert.deepEqual(
    evaluateEligibility({ duration_seconds: 120, agent_name: null, agent_five9_id: null, was_transferred: false }, null, CFG),
    { eligible: false, reason: 'no_agent' },
  );
  // Transfer legs are agentless by nature and are IN scope — they classify by
  // IVR module instead. Treating them as ineligible would drop every
  // LightFire leg.
  assert.deepEqual(
    evaluateEligibility({ duration_seconds: 120, agent_name: null, agent_five9_id: null, was_transferred: true }, null, CFG),
    { eligible: true, reason: null },
  );
});

test('campaign map can veto by eligibility flag or by disposition', () => {
  assert.deepEqual(
    evaluateEligibility({ duration_seconds: 120, agent_name: 'X' }, { eligible: false }, CFG),
    { eligible: false, reason: 'campaign_not_eligible' },
  );
  assert.deepEqual(
    evaluateEligibility(
      { duration_seconds: 120, agent_name: 'X', disposition: 'Voicemail' },
      { eligible: true, excluded_dispositions: ['Voicemail'] },
      CFG,
    ),
    { eligible: false, reason: 'disposition_excluded' },
  );
});

test('a missing duration is skipped rather than assumed long enough', () => {
  assert.deepEqual(evaluateEligibility({ agent_name: 'X' }, null, CFG), { eligible: false, reason: 'no_duration' });
});

// ─── row shaping ────────────────────────────────────────────────────────────

test('an eligible call shapes to status discovered with UTC call_start', () => {
  const { index } = resolveColumns(HEADERS);
  const { row: out, reject } = buildCallRow([zipRow(row(), index)], null, CFG);
  assert.equal(reject, null);
  assert.equal(out.five9_call_id, '3000000102');
  assert.equal(out.call_start, '2026-08-05T21:30:12.000Z', 'Pacific 14:30 in August is 21:30Z');
  assert.equal(out.duration_seconds, 135);
  assert.equal(out.eligible, true);
  assert.equal(out.status, 'discovered');
  assert.equal(out.customer_phone_e164, '+19419203087');
});

test('an ineligible call shapes to status skipped and keeps its reason', () => {
  const { index } = resolveColumns(HEADERS);
  const { row: out } = buildCallRow([zipRow(row({ dur: '00:00:05' }), index)], null, CFG);
  assert.equal(out.eligible, false);
  assert.equal(out.ineligible_reason, 'below_min_seconds');
  assert.equal(out.status, 'skipped', 'recorded, never dropped');
});

test('an unparseable timestamp is REJECTED, not given a guessed call_start', () => {
  const { index } = resolveColumns(HEADERS);
  const { row: out, reject } = buildCallRow([zipRow(row({ ts: 'sometime tuesday' }), index)], null, CFG);
  assert.equal(out, null);
  assert.equal(reject, 'unparseable_timestamp');
});

test('recording segments and expected count land in raw_metadata', () => {
  const { index } = resolveColumns(HEADERS);
  const { row: out } = buildCallRow([zipRow(row({ recordings: '07:35:54(1:56) 07:38:00(0:42)' }), index)], null, CFG);
  assert.equal(out.raw_metadata.expected_recording_count, 2);
  assert.equal(out.raw_metadata.recording_segments.length, 2);
  assert.equal(out.raw_metadata.legs.length, 1, 'raw legs retained verbatim');
});

// ─── team resolution: suffix → ci_agent_map → unknown ───────────────────────
//
// THE TRAP THIS GUARDS. teamFromName() only matches the ' - LF' / ' - NC' /
// ' - FTM' suffixes the dialer puts on PARTNER agents. Reece's own in-house
// agents carry no suffix at all, so before the map fallback existed every one
// of their calls resolved to team 'unknown' and was flagged unknown_team into
// review — measured live 2026-08-24: 15 of 31 eligible calls at 'unknown', 10
// of them belonging to five named Reece agents whose ci_agent_map rows said
// 'reece' the whole time.
//
// The ORDER is the load-bearing part. Suffix stays FIRST: it is what the
// dialer recorded against this specific call and it is how partner agents are
// identified. The map is the fallback, never the override.

const TEAM_HEADERS = ['CALL ID', 'TIMESTAMP', 'CALL TIME', 'CALL TYPE', 'ANI', 'DNIS', 'CAMPAIGN', 'SKILL', 'DISPOSITION', 'AGENT', 'AGENT NAME', 'RECORDINGS'];

/** A report row carrying BOTH agent columns — the login and the display name. */
function teamRow({ agent = 'jflanders', agentName = 'Jamal Flanders' } = {}) {
  return ['300000010270792', '2026-08-05 14:30:12', '00:02:15', 'Outbound',
    '9419203087', '7275551234', 'Main Number', '', 'Appointment Set', agent, agentName, ''];
}

/**
 * The live map's shape as loadAgentMap() returns it: keys folded to lowercase,
 * the row's own agent_username left verbatim — mixed case included, because
 * that is what the Five9 user records actually hold.
 */
const AGENT_MAP = new Map([
  ['jflanders', { agent_username: 'jflanders', agent_name: 'Jamal Flanders', team: 'reece' }],
  ['bleadbeater2254', { agent_username: 'Bleadbeater2254', agent_name: 'Brandon Leadbeater', team: 'reece' }],
  ['swalker1', { agent_username: 'swalker1', agent_name: 'Shari Walker', team: 'lightfire' }],
  ['etghelpdesk', { agent_username: 'etghelpdesk', agent_name: 'ETG Helpdesk', team: 'unknown' }],
]);

function shapeWithMap(overrides, agentMap = AGENT_MAP) {
  const { index } = resolveColumns(TEAM_HEADERS);
  return buildCallRow([zipRow(teamRow(overrides), index)], null, CFG, agentMap).row;
}

test('the SUFFIX wins over the agent map when the two disagree', () => {
  // swalker1 is mapped 'lightfire', but this call's AGENT NAME carries ' - NC'.
  // The dialer's own label for the call is the authority.
  const out = shapeWithMap({ agent: 'swalker1', agentName: 'Shari Walker - NC' });
  assert.equal(out.team, 'north_carolina', 'suffix is first in the order of authority');
  assert.equal(out.agent_name, 'Shari Walker', 'stored without the suffix');
});

test('the agent map resolves a Reece agent who has no suffix', () => {
  const out = shapeWithMap({ agent: 'jflanders', agentName: 'Jamal Flanders' });
  assert.equal(out.team, 'reece', 'the review-queue blocker: was unknown before the fallback');
  assert.equal(out.agent_username, 'jflanders');
});

test('the login match is case-insensitive on the CALL side', () => {
  for (const login of ['Bleadbeater2254', 'bleadbeater2254', 'BLEADBEATER2254']) {
    const out = shapeWithMap({ agent: login, agentName: 'Brandon Leadbeater' });
    assert.equal(out.team, 'reece', `login '${login}' must resolve`);
  }
});

test('an unknown login falls through to unknown rather than throwing', () => {
  const out = shapeWithMap({ agent: 'nosuchlogin', agentName: 'Nobody At All' });
  assert.equal(out.team, 'unknown');
});

test('an agentless leg resolves to unknown, and normalizeAgentField still applies', () => {
  for (const sentinel of ['[None]', '', 'n/a']) {
    const out = shapeWithMap({ agent: sentinel, agentName: sentinel });
    assert.equal(out.team, 'unknown', `'${sentinel}' must not become a team`);
    assert.equal(out.agent_username, null, `'${sentinel}' is not a login`);
    assert.equal(out.agent_name, null, `'${sentinel}' is not a name`);
  }
});

test('an agent mapped to team unknown STAYS unknown', () => {
  // The one ETG helpdesk login is genuinely not on any of the teams. The
  // fallback must not promote it to a real team.
  const out = shapeWithMap({ agent: 'etghelpdesk', agentName: 'ETG Helpdesk' });
  assert.equal(out.team, 'unknown');
});

test('a map row with a null/blank team does not write an empty team', () => {
  const map = new Map([['ghost', { agent_username: 'ghost', team: null }]]);
  assert.equal(shapeWithMap({ agent: 'ghost', agentName: 'Ghost' }, map).team, 'unknown');
  const blank = new Map([['ghost', { agent_username: 'ghost', team: '   ' }]]);
  assert.equal(shapeWithMap({ agent: 'ghost', agentName: 'Ghost' }, blank).team, 'unknown');
});

test('buildCallRow is PURE: no agent map given is unknown, never a lookup', () => {
  // The signature takes the map as an ARGUMENT. If this ever reads Supabase it
  // would do so once per call — 5000 round trips on a capped window.
  const { index } = resolveColumns(TEAM_HEADERS);
  const { row: out } = buildCallRow([zipRow(teamRow(), index)], null, CFG);
  assert.equal(out.team, 'unknown');
  assert.equal(teamFromAgentMap(null, 'jflanders'), null);
  assert.equal(teamFromAgentMap(undefined, 'jflanders'), null);
  assert.equal(teamFromAgentMap(AGENT_MAP, null), null);
});

test('loadAgentMap folds the STORED username to lowercase and skips blanks', async () => {
  const m = await loadAgentMap(dbStub({
    agentRows: [
      { agent_username: 'Bleadbeater2254', team: 'reece' },
      { agent_username: 'Mcole2321', team: 'reece' },
      { agent_username: 'C.Garner@reecewindows.com', team: 'reece' },
      { agent_username: null, team: 'lightfire' },
      { agent_username: '   ', team: 'lightfire' },
    ],
  }));
  assert.equal(m.size, 3, 'the two username-less rows are skipped, never keyed on ""');
  assert.equal(m.get('bleadbeater2254').team, 'reece');
  assert.equal(m.get('mcole2321').team, 'reece');
  assert.equal(m.get('c.garner@reecewindows.com').team, 'reece');
  assert.equal(m.get(''), undefined, 'a blank key would answer for every agentless leg');
});

test('loadAgentMap reports a read failure instead of returning an empty map', async () => {
  // An empty map is indistinguishable from "nobody is mapped" — it would send
  // every call to review silently. Fail loudly instead.
  const db = { from: () => ({ select: async () => ({ data: null, error: { message: 'permission denied' } }) }) };
  await assert.rejects(() => loadAgentMap(db), /ci_agent_map read failed: permission denied/);
});

test('discoverCalls threads the agent map from load through to the shaped row', async () => {
  const db = dbStub({ agentRows: [{ agent_username: 'JFlanders', team: 'reece' }] });
  await discoverCalls({
    from: new Date('2026-08-05T00:00:00Z'),
    to: new Date('2026-08-05T06:00:00Z'),
    deps: {
      cfg: CFG, supabase: db, campaignMap: new Map(),
      runReportAndWait: async () => ({ done: true, columns: TEAM_HEADERS, rows: [teamRow()] }),
    },
  });
  const up = db._calls.upserts.at(-1);
  assert.equal(up.rows[0].team, 'reece', 'loaded from ci_agent_map, not hardcoded');
});

test('an injected agent map overrides the loader, like campaignMap does', async () => {
  const db = dbStub({ agentRows: [{ agent_username: 'jflanders', team: 'reece' }] });
  await discoverCalls({
    from: new Date('2026-08-05T00:00:00Z'),
    to: new Date('2026-08-05T06:00:00Z'),
    deps: {
      cfg: CFG, supabase: db, campaignMap: new Map(),
      agentMap: new Map([['jflanders', { team: 'lightfire' }]]),
      runReportAndWait: async () => ({ done: true, columns: TEAM_HEADERS, rows: [teamRow()] }),
    },
  });
  assert.equal(db._calls.upserts.at(-1).rows[0].team, 'lightfire');
});

// ─── the row cap ────────────────────────────────────────────────────────────

test('a window at the row cap SPLITS instead of accepting the truncation', async () => {
  const spans = [];
  let call = 0;
  const runReportAndWait = async ({ startIso, endIso }) => {
    spans.push([startIso, endIso]);
    call += 1;
    // First pull returns a capped page; the halves come back small.
    const n = call === 1 ? REPORT_ROW_CAP : 2;
    return {
      done: true,
      columns: HEADERS,
      rows: Array.from({ length: n }, (_, i) => row({ callId: `c${call}-${i}` })),
    };
  };

  const out = await pullWindow(
    new Date('2026-08-05T00:00:00Z'), new Date('2026-08-05T06:00:00Z'),
    { cfg: CFG, campaignMap: new Map(), deps: { runReportAndWait } },
  );

  assert.equal(out.capHits, 1, 'the cap was detected');
  assert.equal(out.windows, 2, 'and the window was split in two');
  assert.equal(spans.length, 3, 'one capped pull plus two halves');
  assert.equal(out.rows.length, 4);
});

test('a cap hit that cannot be split further THROWS rather than losing rows', async () => {
  const runReportAndWait = async () => ({
    done: true,
    columns: HEADERS,
    rows: Array.from({ length: REPORT_ROW_CAP }, (_, i) => row({ callId: `x${i}` })),
  });
  await assert.rejects(
    pullWindow(new Date('2026-08-05T00:00:00Z'), new Date('2026-08-05T00:00:30Z'),
      { cfg: CFG, campaignMap: new Map(), deps: { runReportAndWait } }),
    /rows are being lost/,
  );
});

test('an unfinished report throws instead of returning a partial window', async () => {
  const runReportAndWait = async () => ({ done: false, identifier: 'abc123' });
  await assert.rejects(
    pullWindow(new Date('2026-08-05T00:00:00Z'), new Date('2026-08-05T06:00:00Z'),
      { cfg: CFG, campaignMap: new Map(), deps: { runReportAndWait } }),
    /did not finish/,
  );
});

test('a report missing a required column throws with the headers it saw', async () => {
  const runReportAndWait = async () => ({ done: true, columns: ['CAMPAIGN'], rows: [] });
  await assert.rejects(
    pullWindow(new Date('2026-08-05T00:00:00Z'), new Date('2026-08-05T06:00:00Z'),
      { cfg: CFG, campaignMap: new Map(), deps: { runReportAndWait } }),
    /missing required column/,
  );
});

// ─── discoverCalls: windowing + idempotency ─────────────────────────────────

test('a day is pulled in windows of the requested size', async () => {
  const seen = [];
  const db = dbStub();
  await discoverCalls({
    from: new Date('2026-08-05T00:00:00Z'),
    to: new Date('2026-08-06T00:00:00Z'),
    windowHours: 6,
    deps: {
      cfg: CFG, supabase: db, campaignMap: new Map(),
      runReportAndWait: async (a) => { seen.push(a); return { done: true, columns: HEADERS, rows: [] }; },
    },
  });
  assert.equal(seen.length, 4, '24h in 6h windows');
  assert.equal(/[Zz]$/.test(seen[0].startIso), false, 'criteria are naive local, no Z');
});

test('re-discovery is a NO-OP: existing rows are never overwritten', async () => {
  const db = dbStub();
  await discoverCalls({
    from: new Date('2026-08-05T00:00:00Z'),
    to: new Date('2026-08-05T06:00:00Z'),
    deps: {
      cfg: CFG, supabase: db, campaignMap: new Map(),
      runReportAndWait: reportStub([row()]),
    },
  });
  const up = db._calls.upserts.at(-1);
  assert.equal(up.table, 'ci_calls');
  assert.equal(up.opts.onConflict, 'five9_call_id');
  assert.equal(up.opts.ignoreDuplicates, true,
    'ignoreDuplicates is what stops a re-discovery resetting an in-flight call to discovered');
});

test('the same Call ID appearing twice in one pull collapses to one row', async () => {
  // A duplicate key inside a SINGLE upsert payload is a Postgres error, not a
  // merge — so the de-dupe has to happen before the write.
  const db = dbStub();
  const out = await discoverCalls({
    from: new Date('2026-08-05T00:00:00Z'),
    to: new Date('2026-08-05T12:00:00Z'),
    windowHours: 6,
    deps: {
      cfg: CFG, supabase: db, campaignMap: new Map(),
      runReportAndWait: reportStub([row({ callId: 'dupe-1' })]),   // same id in both windows
    },
  });
  const up = db._calls.upserts.at(-1);
  assert.equal(up.rows.length, 1, 'de-duped before the upsert');
  assert.equal(out.calls, 1);
});

test('the summary counts eligible and skipped separately', async () => {
  const db = dbStub();
  const out = await discoverCalls({
    from: new Date('2026-08-05T00:00:00Z'),
    to: new Date('2026-08-05T06:00:00Z'),
    deps: {
      cfg: CFG, supabase: db, campaignMap: new Map(),
      runReportAndWait: reportStub([
        row({ callId: 'a', dur: '00:02:00' }),
        row({ callId: 'b', dur: '00:00:05' }),
      ]),
    },
  });
  assert.equal(out.calls, 2);
  assert.equal(out.eligible, 1);
  assert.equal(out.skipped, 1);
});

test('an inverted or empty window pulls nothing rather than looping', async () => {
  const db = dbStub();
  let pulls = 0;
  const out = await discoverCalls({
    from: new Date('2026-08-06T00:00:00Z'),
    to: new Date('2026-08-05T00:00:00Z'),
    deps: {
      cfg: CFG, supabase: db, campaignMap: new Map(),
      runReportAndWait: async () => { pulls += 1; return { done: true, columns: HEADERS, rows: [] }; },
    },
  });
  assert.equal(pulls, 0);
  assert.equal(out.calls, 0);
});
