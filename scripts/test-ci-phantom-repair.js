/**
 * Tests — a key is released only when LP was ASKED and answered "not here"
 * scripts/test-ci-phantom-repair.js
 *
 * WHAT THE SCRIPT DOES. Between 2026-08-24 22:29Z and 2026-08-25 03:00Z, 286
 * ci_syncs rows recorded `synced` for target 'lp' on nothing more than "addNote
 * did not throw" — AddNotes answers every write with the constant "UPDATED
 * SUCCESSFULLY!". Each row holds a UNIQUE(idempotency_key), so a note that
 * never landed can never be re-sent while its row stands.
 *
 * THE DANGER. Releasing a key on a note that DID land means the retry puts a
 * second note on a customer's record — the exact failure the idempotency key
 * exists to prevent. So the safety of this repair is entirely in the narrowness
 * of classifyAudited, and every test below is a fence around it.
 *
 * ── FOUR OUTCOMES, ONE OF THEM ACTIONABLE ──────────────────────────────────
 *   read OK, note present on the prospect   delivered and visible    REFUSE
 *   read OK, note present on the lead       delivered, invisible     REFUSE
 *   read FAILED                             UNKNOWN, not absent      REFUSE
 *   read OK, note not present               proven absent            release
 *
 * The mirror is not consulted anywhere in this, deliberately: 285 of the 286
 * records were never re-read by the lp_notes sync, so mirror absence is a
 * coverage artefact and reading it as evidence is what made the incident look
 * an order of magnitude worse than it was.
 *
 * Pure planners only — no network, no DB, no LP.
 *
 * Run: node --test scripts/test-ci-phantom-repair.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseArgs, classifyAudited, planRepair, planParentReset,
  PARENT_RESET_PATCH, INCIDENT_FROM, INCIDENT_TO,
} from './repair-ci-phantom-syncs.js';

/** An audited row as auditLpNotes returns it, inside the incident window. */
const row = (over = {}) => ({
  sync_id: 'sync-1',
  call_id: '13a24c9e-6eb9-4ff1-8827-6e554468ea3e',
  status: 'synced',
  synced_at: '2026-08-25T00:12:03.059Z',
  external_ref: null,
  rectype: 'ils',
  recid: 568072,
  lp_cst_id: '453031',
  marker: '[AI-CI:13a24c9e',
  read_ok: true,
  found: false,
  side: null,
  lp_note_id: null,
  read_error: null,
  ...over,
});

// ─── the one case that may be released ──────────────────────────────────────

test('a successful read that did not contain the note releases the key', () => {
  const v = classifyAudited(row());
  assert.equal(v.releasable, true);
  assert.equal(v.category, 'absent');
});

// ─── and the three that may not ─────────────────────────────────────────────

test('THE GUARD: a note found on the PROSPECT is refused — it is delivered', () => {
  const v = classifyAudited(row({ found: true, side: 'prospect', lp_note_id: '2238213' }));
  assert.equal(v.releasable, false, 'releasing this is how a customer gets the same note twice');
  assert.equal(v.category, 'delivered');
  assert.match(v.reason, /2238213/, 'the evidence must be printed, not just the refusal');
});

test('THE GUARD: a note found on the LEAD is refused too — invisible is not absent', () => {
  // It was delivered; it is simply attached where a rep does not read. Re-sending
  // as cst leaves TWO copies in LP, and that trade is a human decision.
  const v = classifyAudited(row({ found: true, side: 'lead', lds_id: '568072', lp_note_id: 'L1' }));
  assert.equal(v.releasable, false);
  assert.equal(v.category, 'delivered_invisible');
  assert.match(v.reason, /second copy/, 'the reason must say what re-sending would cost');
});

test('THE GUARD: a FAILED read is refused — unknown is never absent', () => {
  const v = classifyAudited(row({ read_ok: false, read_error: 'ECONNRESET' }));
  assert.equal(v.releasable, false);
  assert.equal(v.category, 'unread');
  assert.match(v.reason, /UNKNOWN is not ABSENT/);
});

test('a row that already carries a verified note id is refused', () => {
  // external_ref is only ever set by the read-back, so its presence IS a
  // receipt — regardless of what this run's read happened to see.
  const v = classifyAudited(row({ external_ref: '2238213' }));
  assert.equal(v.releasable, false);
  assert.equal(v.category, 'has_ref');
});

// ─── the window ─────────────────────────────────────────────────────────────

test('a write outside the incident window is not this repair\'s business', () => {
  const before = classifyAudited(row({ synced_at: '2026-08-20T10:00:00.000Z' }));
  assert.equal(before.releasable, false);
  assert.equal(before.category, 'out_of_window');

  const after = classifyAudited(row({ synced_at: '2026-08-26T10:00:00.000Z' }));
  assert.equal(after.releasable, false);

  const missing = classifyAudited(row({ synced_at: null }));
  assert.equal(missing.releasable, false, 'a row with no send time cannot be placed in the window');
});

test('the default window brackets the incident and nothing else', () => {
  assert.ok(Date.parse(INCIDENT_FROM) < Date.parse('2026-08-24T22:29:23Z'), 'must include the first write');
  assert.ok(Date.parse(INCIDENT_TO) > Date.parse('2026-08-25T02:58:07Z'), 'must include the last');
  assert.ok((Date.parse(INCIDENT_TO) - Date.parse(INCIDENT_FROM)) <= 6 * 3600 * 1000, 'and stay narrow');
});

// ─── the plan ───────────────────────────────────────────────────────────────

test('planRepair splits every row and loses none', () => {
  const rows = [
    row({ sync_id: 'a' }),
    row({ sync_id: 'b', found: true, side: 'prospect' }),
    row({ sync_id: 'c', read_ok: false, read_error: 'timeout' }),
    row({ sync_id: 'd', found: true, side: 'lead' }),
  ];
  const { release, refuse } = planRepair(rows);
  assert.deepEqual(release.map((r) => r.row.sync_id), ['a']);
  assert.equal(refuse.length, 3);
  assert.equal(release.length + refuse.length, rows.length, 'every row is accounted for');
});

test('an empty audit releases nothing rather than everything', () => {
  const { release, refuse } = planRepair([]);
  assert.equal(release.length, 0);
  assert.equal(refuse.length, 0);
  assert.deepEqual(planRepair(undefined).release, []);
});

// ─── the parent calls ───────────────────────────────────────────────────────

test('only calls whose key this run released are reset', () => {
  const calls = [
    { id: 'c1', status: 'review' },
    { id: 'c2', status: 'review' },
    { id: 'c3', status: 'completed' },
    { id: 'c4', status: 'discovered' },
  ];
  const reset = planParentReset(calls, ['c1', 'c3', 'c4']);
  assert.deepEqual(reset.map((c) => c.id), ['c1', 'c3']);
  // c2's key was not touched, so it is none of this script's business, however
  // it looks. c4 is already moving through the pipeline and must not be shoved.
});

test('the reset clears the lease and the retry timer, not just the status', () => {
  // A call put back in the queue while still holding a lease is invisible to
  // the claimer until the lease expires — it would look repaired and do nothing.
  // 'syncing', not 'matched': stageSync claims 'syncing'. Since the early
  // match gate moved matching ahead of transcription, 'matched' is the
  // TRANSCRIBE rung — resetting there would put a call whose note merely
  // needs re-sending back through analysis.
  assert.equal(PARENT_RESET_PATCH.status, 'syncing');
  assert.equal(PARENT_RESET_PATCH.locked_until, null);
  assert.equal(PARENT_RESET_PATCH.locked_by, null);
  assert.equal(PARENT_RESET_PATCH.next_retry_at, null);
  assert.equal(PARENT_RESET_PATCH.attempts, 0);
});

// ─── the flags ──────────────────────────────────────────────────────────────

test('it is DRY-RUN unless --execute is passed explicitly', () => {
  assert.equal(parseArgs([]).execute, false);
  assert.equal(parseArgs(['--limit=10']).execute, false);
  assert.equal(parseArgs(['--execute']).execute, true);
});

test('there is NO flag that overrides a delivered note', () => {
  // The refusal must not be arguable from the command line. If re-sending the
  // lead-attached notes is ever the right call, it is a separate, deliberate
  // change — not a flag someone reaches for at 2am.
  const forced = parseArgs(['--force', '--resend-lead-attached', '--yes', '--all']);
  assert.equal(forced.execute, false);
  assert.deepEqual(Object.keys(forced).sort(), ['execute', 'from', 'limit', 'status', 'to']);
});

test('an unread row stays refused however the flags are set', () => {
  const unread = row({ read_ok: false, read_error: 'ETIMEDOUT' });
  for (const argv of [[], ['--execute'], ['--limit=1'], ['--status=sent_unconfirmed']]) {
    assert.equal(classifyAudited(unread, parseArgs(argv)).releasable, false);
  }
});

test('nonsense limits fall back to "read everything", never to "read one"', () => {
  assert.equal(parseArgs(['--limit=abc']).limit, null);
  assert.equal(parseArgs(['--limit=0']).limit, null);
  assert.equal(parseArgs(['--limit=50']).limit, 50);
});
