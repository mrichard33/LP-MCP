/**
 * Tests — PR 5: CRM sync and note composition (§9)
 * scripts/test-ci-sync.js
 *
 * This is the first code in the subsystem that can write to a real customer
 * record, so these tests are about what must NOT happen:
 *
 *   1. SHADOW CALLS NO API — asserted by giving the clients a spy that FAILS
 *      the test if it is ever invoked. Not "check a flag"; prove zero HTTP.
 *   2. THE IDEMPOTENCY KEY BLOCKS A RE-SEND — the ci_syncs unique constraint
 *      is what makes a duplicate a constraint violation rather than a second
 *      note on someone's record.
 *   3. AN LP FAILURE LEAVES GHL INDEPENDENT — one CRM being down must not
 *      cost us the note in the other.
 *
 * Run: node --test scripts/test-ci-sync.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { composeNote, idempotencyKey, formatKeyDetails, formatFollowUp, outcomeLabel, formatEt, shortId } from '../src/ci/notes.js';
import { syncCall, syncToLp, syncToGhl, tierWritable } from '../src/ci/sync.js';
import { parseConfig } from '../src/ci/config.js';

const SHADOW = parseConfig({});
const LIVE_BOTH = parseConfig({
  CALL_INTEL_MODE: 'live', CALL_INTEL_LP_WRITES: 'true', CALL_INTEL_GHL_WRITES: 'true',
});

const CALL = {
  id: '8d41446e-403e-5d4c-a306-65d59b8e4407',
  five9_call_id: '300000010270763',
  call_start: '2026-08-21T16:00:06.000Z',   // 12:00 PM ET
  direction: 'Outbound',
  ani: '7273302574',
  agent_name: 'John Manieri',
  agent_username: 'jmanieri',
  team: 'reece',
};

const SUMMARY = {
  call_id: CALL.id,
  output: {
    summary: 'The agent reached the customer and confirmed the Thursday appointment.',
    outcome: 'appointment_confirmed',
    key_details: [
      { detail: 'Customer will be home after 4pm', source: 'stated', confidence: 0.9 },
      { detail: 'Likely a full-house quote', source: 'inferred', confidence: 0.6 },
    ],
    follow_up: { required: true, when: 'Thursday morning', action: 'Confirm arrival window' },
  },
};

const MATCH = (over = {}) => ({
  tier: 'high',
  ghl_contact_id: 'ghl-contact-1',
  evidence: { note_target: { rectype: 'cst', recid: 453297 } },
  ...over,
});

/**
 * A CRM client that must never be called. Any invocation throws, so a shadow
 * leak surfaces as a failing test rather than a silent live write.
 */
function forbiddenClient(label) {
  return {
    addNote: async () => { throw new Error(`${label} was called in shadow mode — THIS IS A LIVE WRITE`); },
    addGHLNote: async () => { throw new Error(`${label} was called in shadow mode — THIS IS A LIVE WRITE`); },
  };
}

/** In-memory ci_syncs honouring the UNIQUE(idempotency_key) constraint. */
function fakeDb() {
  const rows = [];
  const calls = [];
  return {
    rows,
    calls,
    from(table) {
      const chain = {
        _eq: {},
        select() { return chain; },
        eq(c, v) { chain._eq[c] = v; return chain; },
        maybeSingle: async () => ({ data: null, error: null }),
        insert(row) {
          calls.push({ table, op: 'insert', row });
          const api = {
            select: () => api,
            maybeSingle: async () => {
              if (table === 'ci_syncs') {
                if (rows.some((r) => r.idempotency_key === row.idempotency_key)) {
                  // Postgres 23505 — what the real unique index raises.
                  return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
                }
                const stored = { id: `sync-${rows.length + 1}`, attempts: 0, ...row };
                rows.push(stored);
                return { data: stored, error: null };
              }
              return { data: null, error: null };
            },
            then: (res, rej) => Promise.resolve({ error: null }).then(res, rej),
          };
          return api;
        },
        update(patch) {
          const api = {
            eq(c, v) { calls.push({ table, op: 'update', patch, where: { [c]: v } });
              const row = rows.find((r) => r.id === v);
              if (row) Object.assign(row, patch);
              return Promise.resolve({ error: null }); },
          };
          return api;
        },
      };
      return chain;
    },
  };
}

// ─── §9 note composition ────────────────────────────────────────────────────

test('the note carries the §9 header, body, key details and AI footer', () => {
  const note = composeNote(CALL, SUMMARY);
  const lines = note.split('\n');

  assert.match(lines[0], /^\[AI CALL NOTE \| 08\/21 12:00 PM ET \| outbound \| Agent: John Manieri \(reece\) \| Outcome: Appointment confirmed\]$/);
  assert.equal(lines[1], 'The agent reached the customer and confirmed the Thursday appointment.');
  assert.match(note, /^Key: Customer will be home after 4pm • Likely a full-house quote \(likely\)$/m);
  assert.match(note, /^Follow-up: Confirm arrival window — Thursday morning$/m);
  assert.match(lines[lines.length - 1], /^\[AI-CI:8d41446e \| Five9 300000010270763 \| AI-generated from call recording — verify commitments before acting\]$/);
});

test('an INFERRED detail is marked "(likely)" — an unmarked guess becomes a fact', () => {
  assert.equal(
    formatKeyDetails([{ detail: 'Wants gutters too', source: 'inferred', confidence: 0.5 }]),
    'Wants gutters too (likely)',
  );
  assert.equal(
    formatKeyDetails([{ detail: 'Wants gutters too', source: 'stated', confidence: 0.9 }]),
    'Wants gutters too',
  );
  assert.equal(formatKeyDetails([]), null);
});

test('the follow-up line is omitted entirely when none is required', () => {
  assert.equal(formatFollowUp({ required: false, when: 'Thursday', action: 'Call' }), null);
  const note = composeNote(CALL, { output: { ...SUMMARY.output, follow_up: { required: false } } });
  assert.equal(/Follow-up:/.test(note), false);
});

test('the note never contains the customer phone number', () => {
  // §7 captures a spoken number for matching; repeating it in CRM note text
  // scatters contact data into free text across two systems.
  const withPhone = { output: { ...SUMMARY.output, customer: { phone_mentioned: { value: '7273302574', source: 'stated', confidence: 1 } } } };
  const note = composeNote(CALL, withPhone);
  assert.equal(note.includes('7273302574'), false);
});

test('the ET header is DST-aware — unlike the fixed-offset filename clocks', () => {
  assert.equal(formatEt('2026-08-21T16:00:06.000Z'), '08/21 12:00 PM ET');   // EDT, UTC-4
  assert.equal(formatEt('2026-01-21T16:00:06.000Z'), '01/21 11:00 AM ET');   // EST, UTC-5
  assert.equal(formatEt('nonsense'), 'unknown time');
});

test('a DNC outcome is shouted, not softened', () => {
  assert.equal(outcomeLabel('dnc_request'), 'DNC REQUEST');
  assert.equal(outcomeLabel('escalation_required'), 'ESCALATION REQUIRED');
  assert.equal(outcomeLabel('appointment_set'), 'Appointment set');
});

test('an unmapped agent or team degrades to a label, never to blank or "null"', () => {
  // NO agent identity is not an unidentified agent: it means no Reece agent
  // was on the call. This used to render 'Agent: unknown agent (unassigned)',
  // which put a phantom colleague on a customer's record. It names the LINE
  // now — the ANI here, because CALL is outbound.
  const note = composeNote({ ...CALL, agent_name: null, agent_username: null, team: 'unknown' }, SUMMARY);
  assert.match(note, /Agent: No Reece agent \| Line: \(727\) 330-2574/);
  assert.equal(/unassigned|unknown agent/.test(note), false);

  // An agent we DO know, on a team we do not: the name, and no placeholder.
  const knownAgent = composeNote({ ...CALL, team: 'unknown' }, SUMMARY);
  assert.match(knownAgent, /Agent: John Manieri \| Outcome:/);
});

// ─── 1. SHADOW MAKES NO HTTP CALL ───────────────────────────────────────────

test('SHADOW MODE: the note is composed and stored, and NO API is called', async () => {
  const db = fakeDb();
  const r = await syncCall(CALL, SUMMARY, MATCH(), {
    db,
    cfg: SHADOW,
    lpClient: forbiddenClient('lpClient.addNote'),
    ghlClient: forbiddenClient('ghlClient.addGHLNote'),
  });

  assert.equal(r.lp.shadow, true);
  assert.equal(r.ghl.shadow, true);
  assert.equal(r.lp.failed, undefined, 'a forbidden-client throw would show up here');
  assert.equal(r.ghl.failed, undefined);

  // Both rows exist, both carry the exact body, both are marked shadow.
  assert.equal(db.rows.length, 2);
  for (const row of db.rows) {
    assert.equal(row.status, 'shadow');
    assert.ok(row.note_body.startsWith('[AI CALL NOTE'), 'the body stored is the body that would be sent');
  }
});

test('shadow stores the SAME body live would send — QA reads the real thing', async () => {
  const shadowDb = fakeDb();
  await syncToLp(CALL, SUMMARY, MATCH(), { db: shadowDb, cfg: SHADOW, lpClient: forbiddenClient('lp') });

  let sentBody = null;
  const liveDb = fakeDb();
  await syncToLp(CALL, SUMMARY, MATCH(), {
    db: liveDb,
    cfg: LIVE_BOTH,
    lpClient: { addNote: async ({ notes }) => { sentBody = notes; return { note_id: 55 }; } },
  });

  assert.equal(shadowDb.rows[0].note_body, sentBody);
});

test('mode=live but the target flag off is still no HTTP', async () => {
  const cfg = parseConfig({ CALL_INTEL_MODE: 'live' });  // both write flags default false
  const db = fakeDb();
  const r = await syncCall(CALL, SUMMARY, MATCH(), {
    db, cfg,
    lpClient: forbiddenClient('lpClient'),
    ghlClient: forbiddenClient('ghlClient'),
  });
  assert.equal(r.lp.shadow, true);
  assert.equal(r.ghl.shadow, true);
});

// ─── 2. the idempotency key blocks a re-send ────────────────────────────────

test('IDEMPOTENCY: a second sync of the same call does not reach the API', async () => {
  const db = fakeDb();
  let sends = 0;
  const lpClient = { addNote: async () => { sends++; return { note_id: 1 }; } };

  const first = await syncToLp(CALL, SUMMARY, MATCH(), { db, cfg: LIVE_BOTH, lpClient });
  // `sent`, not `synced` — LP's acknowledgment is a constant, so delivery is
  // proven by the read-back (src/ci/verify.js), never by the write returning.
  // The idempotency key is held from the moment the row is CLAIMED, which is
  // before the API call and therefore unaffected by that distinction.
  assert.equal(first.sent, true);
  assert.equal(first.confirmed, false);
  assert.equal(sends, 1);

  const second = await syncToLp(CALL, SUMMARY, MATCH(), { db, cfg: LIVE_BOTH, lpClient });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'duplicate');
  assert.equal(sends, 1, 'the constraint must stop the second send BEFORE the API');
});

test('the key is derived from call+target only — not the body or a timestamp', () => {
  // Deriving from the body would let a re-analysis mint a fresh key and post
  // the same call twice, which is the exact failure the constraint prevents.
  assert.equal(idempotencyKey('abc', 'lp'), 'ci:lp:abc');
  assert.equal(idempotencyKey('abc', 'lp'), idempotencyKey('abc', 'lp'));
  assert.notEqual(idempotencyKey('abc', 'lp'), idempotencyKey('abc', 'ghl'));
});

test('LP and GHL hold separate keys, so one does not block the other', async () => {
  const db = fakeDb();
  await syncCall(CALL, SUMMARY, MATCH(), {
    db, cfg: SHADOW, lpClient: forbiddenClient('lp'), ghlClient: forbiddenClient('ghl'),
  });
  const keys = db.rows.map((r) => r.idempotency_key);
  assert.deepEqual([...new Set(keys)].sort(), ['ci:ghl:' + CALL.id, 'ci:lp:' + CALL.id].sort());
});

// ─── 3. the targets are independent ─────────────────────────────────────────

test('AN LP FAILURE LEAVES GHL INDEPENDENT — and vice versa', async () => {
  const db = fakeDb();
  let ghlSends = 0;
  const r = await syncCall(CALL, SUMMARY, MATCH(), {
    db,
    cfg: LIVE_BOTH,
    lpClient: { addNote: async () => { throw new Error('LP is down'); } },
    ghlClient: { addGHLNote: async () => { ghlSends++; return { id: 'note-1' }; } },
  });

  assert.equal(r.lp.failed, true);
  assert.equal(r.ghl.synced, true, 'GHL must still be written when LP is down');
  assert.equal(ghlSends, 1);
});

test('a thrown LP client does not escape and skip GHL', async () => {
  // Promise.allSettled, not Promise.all — an unsettled rejection would abort
  // the sibling write.
  const db = fakeDb();
  let ghlSends = 0;
  const r = await syncCall(CALL, SUMMARY, MATCH(), {
    db,
    cfg: LIVE_BOTH,
    lpClient: null,   // property access on null throws inside syncToLp
    ghlClient: { addGHLNote: async () => { ghlSends++; return { id: 'x' }; } },
  });
  assert.equal(ghlSends, 1);
  assert.equal(r.ghl.synced, true);
  assert.ok(r.lp.failed);
});

// ─── the write threshold ────────────────────────────────────────────────────

test('only exact|high are writable by default; probable needs its flag', () => {
  assert.equal(tierWritable('exact', 'lp', SHADOW), true);
  assert.equal(tierWritable('high', 'lp', SHADOW), true);
  assert.equal(tierWritable('ambiguous', 'lp', SHADOW), false);
  assert.equal(tierWritable('none', 'lp', SHADOW), false);

  // probable is off unless live + lp writes + the probable flag
  assert.equal(tierWritable('probable', 'lp', SHADOW), false);
  const probableOn = parseConfig({
    CALL_INTEL_MODE: 'live', CALL_INTEL_LP_WRITES: 'true', CALL_INTEL_ALLOW_PROBABLE: 'true',
  });
  assert.equal(tierWritable('probable', 'lp', probableOn), true);
  // ...and NEVER for GHL, whatever the flags say — a wrong GHL contact can
  // trigger automation, not just carry a note.
  assert.equal(tierWritable('probable', 'ghl', probableOn), false);
});

test('an ambiguous match is skipped without composing or claiming anything', async () => {
  const db = fakeDb();
  const r = await syncToLp(CALL, SUMMARY, MATCH({ tier: 'ambiguous' }), {
    db, cfg: LIVE_BOTH, lpClient: forbiddenClient('lp'),
  });
  assert.equal(r.skipped, true);
  assert.match(r.reason, /tier_ambiguous_not_writable/);
  assert.equal(db.rows.length, 0, 'no ci_syncs row for a write that must never happen');
});

test('a match with no note target is skipped rather than guessed at', async () => {
  const db = fakeDb();
  const r = await syncToLp(CALL, SUMMARY, MATCH({ evidence: { note_target: { rectype: null, recid: null } } }), {
    db, cfg: LIVE_BOTH, lpClient: forbiddenClient('lp'),
  });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no_note_target');
});

test('GHL is skipped when no contact is linked and creation is off', async () => {
  const db = fakeDb();
  const r = await syncToGhl(CALL, SUMMARY, MATCH({ ghl_contact_id: null }), {
    db, cfg: LIVE_BOTH, ghlClient: forbiddenClient('ghl'),
  });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no_ghl_contact');
});

test('shortId is stable and dash-free, so the footer id is greppable', () => {
  assert.equal(shortId('8d41446e-403e-5d4c-a306-65d59b8e4407'), '8d41446e');
  assert.equal(shortId(null), '');
});

// ─── §10 exception alerts ───────────────────────────────────────────────────

import { sendAlert, shouldSend, __resetAlertsForTest, REVIEW_BACKLOG_THRESHOLD } from '../src/ci/alerts.js';

test('alerts are debounced per kind — a stuck pipeline must not spam', async () => {
  __resetAlertsForTest();
  const cfg = parseConfig({ GROUPME_CI_BOT_ID: 'bot-1' });
  const sent = [];
  const send = async (text) => { sent.push(text); return { sent: true }; };

  const t0 = 1_000_000;
  assert.equal((await sendAlert('review_backlog', 'first', { cfg, send, now: t0 })).sent, true);
  // Same kind, 10 minutes later — suppressed.
  assert.equal((await sendAlert('review_backlog', 'second', { cfg, send, now: t0 + 600_000 })).reason, 'debounced');
  // A DIFFERENT kind is not suppressed; a new problem must still get through.
  assert.equal((await sendAlert('sync_failures', 'other', { cfg, send, now: t0 + 600_000 })).sent, true);
  // Past the window, the original kind may fire again.
  assert.equal((await sendAlert('review_backlog', 'third', { cfg, send, now: t0 + 3_700_000 })).sent, true);

  assert.deepEqual(sent, ['first', 'other', 'third']);
});

test('no CI bot id means no send, not a crash', async () => {
  __resetAlertsForTest();
  const r = await sendAlert('review_backlog', 'x', {
    cfg: parseConfig({}),
    send: async () => { throw new Error('must not be called'); },
  });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'no_ci_bot_id');
});

test('a failing alert transport never throws into the pipeline', async () => {
  __resetAlertsForTest();
  const r = await sendAlert('review_backlog', 'x', {
    cfg: parseConfig({ GROUPME_CI_BOT_ID: 'bot-1' }),
    send: async () => { throw new Error('GroupMe down'); },
  });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'send_failed');
});

test('the backlog threshold is a real number, not a placeholder', () => {
  assert.equal(REVIEW_BACKLOG_THRESHOLD, 20);
  assert.equal(shouldSend('never_sent_kind', 1), true);
});
