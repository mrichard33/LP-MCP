/**
 * Tests — an unresolved team names the LINE and stops blocking the note
 * scripts/test-ci-unknown-team.js
 *
 * WHAT THESE 84 CALLS ACTUALLY ARE. They sat in the review queue on
 * review_reason='unknown_team', and the reason that label was wrong is the
 * whole point of this file: every one of them has agent_username AND
 * agent_name NULL. 83 arrived on DNIS 2394930774 ('Canvass Confirmation -
 * Inbound'), every one transferred, averaging 213 seconds; the 84th is the
 * same shape on Main Number. Nobody failed to map an agent. No Reece agent
 * was ever on the call — the caller reached a LINE and was handed to a third
 * party.
 *
 * THE TWO TRAPS:
 *
 * 1. A PHANTOM COLLEAGUE ON A CUSTOMER'S RECORD. The header used to render
 *    `Agent: unknown agent (unassigned)`. A rep reading that asks who took
 *    the call and goes looking for a person who does not exist. The note must
 *    say plainly that no Reece agent was on it, and name the line instead —
 *    the DNIS inbound (the number it came in ON), the ANI outbound (the
 *    number presented OUT).
 * 2. PARKING FOREVER FOR AN ANSWER THAT DOES NOT EXIST. There is no team to
 *    resolve, so a human can never clear these. Blocking them means a real
 *    multi-minute conversation with a customer produces no note at all.
 *
 * AND THE THING THAT MUST NOT MOVE. The FLAG stays. 'unknown_team' is still
 * written to ci_summaries.review_flags and still carried in the ci_events
 * detail — the signal is the flag, and only the block is lifted. A flag that
 * stopped parking AND stopped being recorded would just be deleted.
 *
 * No network, no DB — the Supabase client and the model call are doubles.
 *
 * Run: node --test scripts/test-ci-unknown-team.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { composeNote, formatAgentSegment, formatPhoneLine } from '../src/ci/notes.js';
import { stageAnalyze } from '../src/ci/worker.js';
import {
  analysisReviewFlags,
  blockingReviewFlags,
  NON_BLOCKING_REVIEW_FLAGS,
  ANALYSIS_SCHEMA_VERSION,
  FLAG_KEYS,
} from '../src/ci/analysis-schema.js';
import { parseConfig } from '../src/ci/config.js';

const CFG = parseConfig({});

/** The live shape: a canvass-confirmation call with no agent on it at all. */
const NO_AGENT_CALL = {
  id: '8d41446e-403e-5d4c-a306-65d59b8e4407',
  five9_call_id: '300000010274880',
  call_start: '2026-08-21T16:00:06.000Z',   // 12:00 PM ET
  direction: 'Inbound',
  ani: '9415551212',                        // the CUSTOMER's number on an inbound
  dnis: '2394930774',                       // the line they called
  campaign: 'Canvass Confirmation - Inbound',
  agent_name: null,
  agent_username: null,
  team: 'unknown',
  was_transferred: true,
};

const SUMMARY = { output: { summary: 'The caller was transferred.', outcome: 'appointment_confirmed' } };

const header = (call, agentLabel = null) => composeNote(call, SUMMARY, null, agentLabel).split('\n')[0];

// ─── the number, formatted ──────────────────────────────────────────────────

test('a line number reads as a human dials it', () => {
  assert.equal(formatPhoneLine('2394930774'), '(239) 493-0774');
  assert.equal(formatPhoneLine('+1 (954) 870-4474'), '(954) 870-4474');
  assert.equal(formatPhoneLine('19548008906'), '(954) 800-8906');
});

test('a partial number is NOT rendered — a rep would dial it', () => {
  assert.equal(formatPhoneLine('0774'), null);
  assert.equal(formatPhoneLine(''), null);
  assert.equal(formatPhoneLine(null), null);
  assert.equal(formatPhoneLine(undefined), null);
});

// ─── the header segment ─────────────────────────────────────────────────────

test('no agent on the call names the LINE, not a person', () => {
  assert.equal(formatAgentSegment(NO_AGENT_CALL), 'Agent: No Reece agent | Line: (239) 493-0774');
  const h = header(NO_AGENT_CALL);
  assert.match(h, /\| Agent: No Reece agent \| Line: \(239\) 493-0774 \| Outcome:/);
  // The phantom colleague must be gone from the whole note, not just moved.
  assert.equal(/unknown agent|unassigned/.test(composeNote(NO_AGENT_CALL, SUMMARY)), false);
});

test('inbound uses the DNIS and outbound uses the ANI', () => {
  // The number the call came in ON, and the number presented OUT. Getting
  // these the wrong way round prints the CUSTOMER's number in the header of
  // their own note, which §9 excludes deliberately.
  assert.equal(
    formatAgentSegment({ ...NO_AGENT_CALL, direction: 'Inbound' }),
    'Agent: No Reece agent | Line: (239) 493-0774',
  );
  assert.equal(
    formatAgentSegment({ ...NO_AGENT_CALL, direction: 'Outbound', ani: '9548704474' }),
    'Agent: No Reece agent | Line: (954) 870-4474',
  );
  // The inbound header must not carry the customer's own number.
  assert.equal(composeNote(NO_AGENT_CALL, SUMMARY).includes('941'), false);
});

test('no usable line number omits the segment rather than printing a stub', () => {
  assert.equal(
    formatAgentSegment({ ...NO_AGENT_CALL, dnis: null }),
    'Agent: No Reece agent',
  );
  const h = header({ ...NO_AGENT_CALL, dnis: null });
  assert.match(h, /\| Agent: No Reece agent \| Outcome:/);
  assert.equal(/Line:|null|undefined/.test(h), false);
});

test('an UNKNOWN direction names no line at all', () => {
  // Five9 leaves direction blank on some legs. Defaulting that to outbound
  // would print the ANI — which on an inbound call is the CUSTOMER's own
  // number — into the header of their own note. §9 keeps customer PII out of
  // note text, and this is the one place a header could leak it.
  for (const direction of [null, '', 'internal', 'unknown']) {
    const seg = formatAgentSegment({ ...NO_AGENT_CALL, direction });
    assert.equal(seg, 'Agent: No Reece agent', `direction ${JSON.stringify(direction)} must name no line`);
    assert.equal(seg.includes('941'), false, 'the customer number must never appear');
  }
});

test("Five9's '[None]' sentinel is not an agent name", () => {
  // Five9 renders "no agent on this leg" as the literal string '[None]'.
  // Treating it as a name would put 'Agent: [None]' on a customer's record.
  assert.equal(
    formatAgentSegment({ ...NO_AGENT_CALL, agent_name: '[None]', agent_username: '[None]' }),
    'Agent: No Reece agent | Line: (239) 493-0774',
  );
});

test('a known agent with an unresolved team prints the name and NO parenthetical', () => {
  const call = { ...NO_AGENT_CALL, agent_name: 'John Manieri', agent_username: 'jmanieri', team: 'unknown' };
  assert.equal(formatAgentSegment(call), 'Agent: John Manieri');
  const h = header(call);
  assert.match(h, /\| Agent: John Manieri \| Outcome:/);
  // No empty parentheses, and no placeholder team masquerading as a real one.
  assert.equal(/\(\)|\(unassigned\)|\(unknown\)/.test(h), false);
});

test('a known agent on a known team is byte-for-byte unchanged', () => {
  const call = { ...NO_AGENT_CALL, agent_name: 'John Manieri', agent_username: 'jmanieri', team: 'reece' };
  assert.equal(formatAgentSegment(call), 'Agent: John Manieri (reece)');
  // And the display_name override still wins, as it has since sql/069.
  assert.equal(formatAgentSegment(call, 'Mark Richard'), 'Agent: Mark Richard (reece)');
});

// ─── the flag stays, the block goes ─────────────────────────────────────────

test('unknown_team is still FLAGGED — the signal is not what changed', () => {
  const flags = analysisReviewFlags({ analysis: validAnalysis(), call: { team: 'unknown' } });
  assert.ok(flags.includes('unknown_team'), 'the flag must still be raised and stored');
});

test('unknown_team is named as non-blocking in ONE place', () => {
  assert.ok(NON_BLOCKING_REVIEW_FLAGS.has('unknown_team'));
  assert.deepEqual(blockingReviewFlags(['unknown_team']), []);
  // Everything else still stops the call. A future reason joins this set by
  // somebody deciding it does, never by resembling one already in it.
  assert.deepEqual(
    blockingReviewFlags(['unknown_team', 'low_confidence_transcript', 'low_outcome_confidence']),
    ['low_confidence_transcript', 'low_outcome_confidence'],
  );
  // 'unknown_team' belongs to THIS set alone. dnc_request and
  // cancellation_request also skip the park at analysis, but they go to
  // DEFER_REVIEW_UNTIL_SYNCED — delivered, then queued for a human — which is
  // a different behaviour and a different set. See test-ci-deferred-review.js.
  for (const reason of ['dnc_request', 'cancellation_request', 'low_outcome_confidence', 'transcript_unintelligible']) {
    assert.equal(NON_BLOCKING_REVIEW_FLAGS.has(reason), false, `${reason} is not deliver-and-complete`);
  }
});

// ─── what stageAnalyze does with it ─────────────────────────────────────────

/** A minimal valid §7 output. */
function validAnalysis(over = {}) {
  const triple = () => ({ value: null, source: 'unknown', confidence: 0 });
  return {
    schema_version: ANALYSIS_SCHEMA_VERSION,
    summary: 'The caller reached the confirmation line and was transferred.',
    outcome: 'appointment_confirmed',
    outcome_confidence: 0.91,
    outcome_basis: 'stated',
    customer: { name: triple(), phone_mentioned: triple(), email: triple(), address: triple() },
    appointment: { discussed: true, date: triple(), time: triple(), notes: null },
    follow_up: { required: false, when: null, action: null },
    key_details: [],
    flags: Object.fromEntries(FLAG_KEYS.map((k) => [k, false])),
    quality: { transcript_intelligible: true, uncertainty_notes: null },
    ...over,
  };
}

/** PostgREST-shaped double that records every write. */
function fakeDb({ transcript = null } = {}) {
  const log = [];
  return {
    log,
    from(table) {
      const chain = {
        _eq: {},
        select() { return chain; },
        eq(col, val) { chain._eq[col] = val; return chain; },
        maybeSingle: async () => ({ data: transcript, error: null }),
        update(patch) {
          const thenable = {
            eq(col, val) { chain._eq[col] = val; return thenable; },
            then: (res, rej) => {
              log.push({ table, op: 'update', patch, where: { ...chain._eq } });
              return Promise.resolve({ error: null }).then(res, rej);
            },
          };
          return thenable;
        },
        insert: async (row) => { log.push({ table, op: 'insert', row }); return { error: null }; },
      };
      return chain;
    },
  };
}

const TRANSCRIPT = { call_id: NO_AGENT_CALL.id, transcript_text: 'let me transfer you' };

/** The ci_calls status this run left the call in. */
const statusOf = (db) => db.log.filter((l) => l.table === 'ci_calls' && l.op === 'update').pop()?.patch;
/** The ci_events row this run wrote. */
const eventOf = (db) => db.log.filter((l) => l.table === 'ci_events' && l.op === 'insert').pop()?.row;

test('a call whose ONLY flag is unknown_team advances instead of parking', async () => {
  const db = fakeDb({ transcript: TRANSCRIPT });
  const r = await stageAnalyze(NO_AGENT_CALL, {
    db, cfg: CFG, callJson: async () => ({ json: validAnalysis() }),
  });

  assert.equal(r.outcome, 'advanced');
  assert.equal(r.to, 'analyzed');

  const patch = statusOf(db);
  assert.equal(patch.status, 'analyzed', 'the call must move on, not park');
  assert.equal(patch.review_reason, undefined, 'nothing may set a review reason here');

  // The summary is stored WITH the flag — the signal survives the unblocking.
  const summary = db.log.find((l) => l.table === 'ci_summaries' && l.op === 'insert')?.row;
  assert.deepEqual(summary.review_flags, ['unknown_team']);

  // And so does the ci_events trail. Without this the timeline could not tell
  // this call apart from one that raised nothing at all.
  const event = eventOf(db);
  assert.equal(event.event, 'transition');
  assert.deepEqual(event.detail.review_flags, ['unknown_team']);
  assert.equal(event.detail.blocked, false);
});

test('unknown_team PLUS a blocking flag still parks, on the blocking reason', async () => {
  // The quality gate wins. An unintelligible transcript is not made readable
  // by the fact that the team could not be resolved.
  const db = fakeDb({ transcript: { ...TRANSCRIPT, low_confidence: true } });
  const r = await stageAnalyze(NO_AGENT_CALL, {
    db, cfg: CFG, callJson: async () => ({ json: validAnalysis() }),
  });

  assert.equal(r.outcome, 'review');
  assert.equal(r.reason, 'low_confidence_transcript', 'the review reason must be the BLOCKING one');

  const patch = statusOf(db);
  assert.equal(patch.status, 'review');
  assert.equal(patch.review_reason, 'low_confidence_transcript');

  // The reviewer still sees everything that was raised, not just the stopper.
  const event = eventOf(db);
  assert.equal(event.event, 'review');
  assert.deepEqual(event.detail.review_flags, ['low_confidence_transcript', 'unknown_team']);
});

test('a call with a resolved team and no flags is completely unaffected', async () => {
  const db = fakeDb({ transcript: TRANSCRIPT });
  const r = await stageAnalyze({ ...NO_AGENT_CALL, team: 'reece' }, {
    db, cfg: CFG, callJson: async () => ({ json: validAnalysis() }),
  });

  assert.equal(r.outcome, 'advanced');
  assert.equal(r.review_flags, undefined, 'no flags means no flag key in the result');
  assert.equal(eventOf(db).detail.review_flags, undefined, 'and none in the event detail');
});
