/**
 * Tests — discovery against the REAL Call Log shape
 * scripts/test-ci-live-calllog.js
 *
 * Every fixture here is copied verbatim from a live pull of the saved report
 * ("Call Log Reports" / "Call Log") for 2026-08-21 09:00–09:15 Pacific. It
 * exists because the first version of discovery.js was written against the
 * handoff's description of the report and would have failed on all four of
 * these points, silently or loudly:
 *
 * 1. TIMESTAMP is 'Fri, 21 Aug 2026 09:00:12' — an RFC-822-ish shape the
 *    parser did not accept. It returned null for EVERY row, so every call
 *    would have been rejected as unparseable_timestamp. Total, silent
 *    ingestion failure: the pull "succeeds" and inserts nothing.
 * 2. There is NO agent-id column. ci_agent_map was seeded keyed on the numeric
 *    Five9 user id, which appears nowhere in the report — the map could never
 *    be joined and every call would fall to team 'unknown'.
 * 3. AGENT (login) and AGENT NAME (display) are SEPARATE columns, and the
 *    alias list resolved the display field to the login column.
 * 4. An agentless leg is the literal string '[None]', not an empty cell — a
 *    truthy value that sails straight past the no_agent eligibility check.
 *
 * Run: node --test scripts/test-ci-live-calllog.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveColumns, zipRow, groupByCallId, isTransferGroup, buildCallRow, evaluateEligibility } from '../src/ci/discovery.js';
import { parsePacificReportTimestamp } from '../src/ci/time.js';
import { teamFromName, stripTeamSuffix, normalizeAgentField } from '../src/ci/teams.js';
import { parseConfig } from '../src/ci/config.js';

const CFG = parseConfig({});

/** The live header row, verbatim. */
const COLUMNS = ['CALL ID', 'TIMESTAMP', 'CAMPAIGN', 'CALL TYPE', 'AGENT', 'AGENT NAME', 'DISPOSITION', 'ANI', 'CUSTOMER NAME', 'DNIS', 'CALL TIME', 'BILL TIME (ROUNDED)', 'COST', 'IVR TIME', 'QUEUE WAIT TIME', 'RING TIME', 'TALK TIME', 'HOLD TIME', 'PARK TIME', 'AFTER CALL WORK TIME', 'TRANSFERS', 'CONFERENCES', 'HOLDS', 'ABANDONED', 'RECORDINGS'];

/** Live rows, verbatim (customer names blanked — PII stays out of fixtures). */
const AGENT_CALL = ['300000010270763x', 'Fri, 21 Aug 2026 09:00:06', 'Rehash', 'Outbound', 'jmanieri', 'John Manieri', 'NA', '7273302574', null, '9075902700', '00:00:46', '00:00:48', '0.0117', null, '00:00:00.235', '00:00:00', '00:00:43', '00:00:00', '00:00:00', '00:00:00', null, null, null, '0', '09:00:25(0:43)'];
const LF_AGENT_CALL = ['300000010270779', 'Fri, 21 Aug 2026 09:02:05', 'DIAL ASAP', 'Preview', 'swalker1', 'Shari Walker - LF', 'Answering Machine', '9047129327', null, '9046735592', '00:00:44', '00:00:48', '0.0064', null, '00:00:00.000', null, '00:00:43', '00:00:00', '00:00:00', '00:00:00', null, null, null, null, '09:02:37(0:43)'];
const TRANSFER_LEG = ['300000010270763', 'Fri, 21 Aug 2026 09:00:12', 'Canvass Confirmation - Inbound', '3rd party transfer', '[None]', null, null, '7272228907', null, '4075126443', '00:03:45', '00:03:48', '0.0304', '00:03:53', '00:00:00.000', null, null, null, null, null, null, null, null, null, '09:00:11(3:46)'];
const TRANSFER_ORIGIN = ['300000010270763', 'Fri, 21 Aug 2026 09:00:04', 'Canvass Confirmation - Inbound', 'Inbound', '[None]', null, 'Transferred To 3rd Party', '7272228907', null, '2394930774', '00:03:54', '00:03:54', '0.0312', '00:03:53', '00:00:00.000', null, null, null, null, null, null, null, null, '0', '09:00:11(3:46)'];
const NO_ANSWER = ['300000010270774', 'Fri, 21 Aug 2026 09:01:06', 'Rehash', 'Outbound', '[None]', null, 'No Answer', '7273302574', null, '9412490652', '00:00:00', '00:00:00', '0.00', null, '00:00:00.000', null, null, null, null, null, null, null, null, null, null];

const IDX = resolveColumns(COLUMNS).index;
const zip = (r) => zipRow(r, IDX);

// ─── 1. the timestamp shape that would have rejected every call ─────────────

test('THE REAL TIMESTAMP FORMAT parses — this alone rejected 100% of calls', () => {
  const utc = parsePacificReportTimestamp('Fri, 21 Aug 2026 09:00:12');
  assert.notEqual(utc, null, 'must parse; returning null rejects every row in the report');
  // 09:00:12 Pacific in August (UTC-7) is 16:00:12Z.
  assert.equal(utc.toISOString(), '2026-08-21T16:00:12.000Z');
});

test('the weekday prefix is optional and the month is case-insensitive', () => {
  assert.equal(parsePacificReportTimestamp('21 Aug 2026 09:00:12').toISOString(), '2026-08-21T16:00:12.000Z');
  assert.equal(parsePacificReportTimestamp('Fri, 21 AUG 2026 09:00:12').toISOString(), '2026-08-21T16:00:12.000Z');
});

test('January vs August still differ — the report is DST-aware, unlike filenames', () => {
  const aug = parsePacificReportTimestamp('Fri, 21 Aug 2026 09:00:00');   // UTC-7
  const jan = parsePacificReportTimestamp('Wed, 21 Jan 2026 09:00:00');   // UTC-8
  assert.equal(aug.getUTCHours(), 16);
  assert.equal(jan.getUTCHours(), 17);
});

test('a bad month abbreviation is rejected rather than rolled over', () => {
  assert.equal(parsePacificReportTimestamp('Fri, 21 Zzz 2026 09:00:12'), null);
  assert.equal(parsePacificReportTimestamp('Fri, 32 Aug 2026 09:00:12'), null);
});

// ─── 2 & 3. the agent columns ───────────────────────────────────────────────

test('AGENT and AGENT NAME resolve to their OWN columns, not the same one', () => {
  assert.equal(COLUMNS[IDX.agentUsername], 'AGENT');
  assert.equal(COLUMNS[IDX.agentName], 'AGENT NAME');
  assert.notEqual(IDX.agentUsername, IDX.agentName);
});

test('this report has NO agent-id column — the login is the only join key', () => {
  assert.equal(IDX.agentId, undefined,
    'if this ever resolves, revisit sql/064: the map could then key on the id again');
  assert.equal(zip(AGENT_CALL).agentUsername, 'jmanieri');
});

// ─── 4. the '[None]' sentinel ───────────────────────────────────────────────

test("'[None]' normalizes to null — it is NOT an agent name", () => {
  assert.equal(normalizeAgentField('[None]'), null);
  assert.equal(normalizeAgentField('  [none] '), null);
  assert.equal(normalizeAgentField(''), null);
  assert.equal(normalizeAgentField(null), null);
  assert.equal(normalizeAgentField('jmanieri'), 'jmanieri');
});

test('an empty cell is JSON null, and must NOT become the string "null"', () => {
  // Every blank in this report comes back as null, not ''. String(null) is
  // 'null' — four truthy characters that would be stored verbatim and would
  // pass any `if (agent_name)` check downstream.
  const z = zip(NO_ANSWER);
  assert.equal(z.agentName, null);
  assert.notEqual(z.agentName, 'null');
  assert.equal(zip(TRANSFER_LEG).disposition, null);
  assert.equal(z.recordings, null);
});

test("a '[None]' no-answer dial is ineligible, not treated as agent-handled", () => {
  const { row } = buildCallRow([zip(NO_ANSWER)], null, CFG);
  assert.equal(row.agent_username, null);
  assert.equal(row.agent_name, null);
  assert.equal(row.eligible, false);
  // Zero duration trips first, which is correct — but the agent field must
  // still be null, or a longer '[None]' call would pass the no_agent gate.
  // 'below_min_seconds', NOT 'no_duration': CALL TIME was '00:00:00', which
  // parsed fine. 'no_duration' is reserved for cells we could not read.
  assert.equal(row.duration_seconds, 0);
  assert.equal(row.ineligible_reason, 'below_min_seconds');
  assert.deepEqual(
    evaluateEligibility({ duration_seconds: 120, agent_name: null, agent_username: null, was_transferred: false }, null, CFG),
    { eligible: false, reason: 'no_agent' },
  );
});

// ─── the team suffix, which DOES exist in the call log ──────────────────────

test('AGENT NAME carries the LP team suffix — decision #5 was right about the call log', () => {
  assert.equal(zip(LF_AGENT_CALL).agentName, 'Shari Walker - LF');
  assert.equal(teamFromName('Shari Walker - LF'), 'lightfire');
  assert.equal(teamFromName('John Manieri'), null);
});

test('a LightFire agent call classifies to lightfire, with the suffix stripped off the name', () => {
  const { row } = buildCallRow([zip(LF_AGENT_CALL)], null, CFG);
  assert.equal(row.team, 'lightfire');
  assert.equal(row.agent_name, 'Shari Walker', 'stored name must match the seeded ci_agent_map row');
  assert.equal(row.agent_username, 'swalker1');
  assert.equal(stripTeamSuffix('Shari Walker - LF'), 'Shari Walker');
});

test('the NC suffix classifies too — the case that left 10 agents in review', () => {
  // ci_agent_map seeded 2026-08-20 by an email-only rule put the whole North
  // Carolina team in 'unknown', because their addresses are @reecebuilders.com
  // or unlabelled personal gmails. The suffix was in their names all along.
  assert.equal(teamFromName('Brian Lovette - NC'), 'north_carolina');
  assert.equal(teamFromName('Anna Parris - NC'), 'north_carolina');
  assert.equal(stripTeamSuffix('Brian Lovette - NC'), 'Brian Lovette');
  // Suffix matching is anchored: a name merely containing the letters is not
  // a team, or 'Vincent' would read as north_carolina.
  assert.equal(teamFromName('NC Vincent'), null);
  assert.equal(teamFromName('Lance Ford'), null);
});

test('a Reece agent call has no suffix and stays unknown for the map to resolve', () => {
  const { row } = buildCallRow([zip(AGENT_CALL)], null, CFG);
  assert.equal(row.team, 'unknown', 'no suffix → the agent/campaign map decides, never a guess');
  assert.equal(row.agent_name, 'John Manieri');
  assert.equal(row.agent_username, 'jmanieri');
});

// ─── the real transfer pair ─────────────────────────────────────────────────

test('the live transfer pair groups into ONE call and is marked transferred', () => {
  const legs = [zip(TRANSFER_LEG), zip(TRANSFER_ORIGIN)];
  const groups = groupByCallId(legs);
  assert.equal(groups.size, 1);
  assert.equal(isTransferGroup(groups.get('300000010270763')), true);

  const { row } = buildCallRow(groups.get('300000010270763'), null, CFG);
  assert.equal(row.was_transferred, true);
  assert.equal(row.campaign, 'Canvass Confirmation - Inbound');
  // Agentless, but transferred — so still ELIGIBLE. Treating it as no_agent
  // would drop every LightFire leg the pipeline exists to capture.
  assert.equal(row.eligible, true);
  assert.equal(row.duration_seconds, 234, 'longest leg wins: 00:03:54');
});

test('the transfer leg dials the seeded LightFire target', () => {
  assert.equal(zip(TRANSFER_LEG).dnis, '4075126443');
});

test('an ordinary agent call is eligible and shaped correctly end to end', () => {
  const { row, reject } = buildCallRow([zip(AGENT_CALL)], null, CFG);
  assert.equal(reject, null);
  assert.equal(row.call_start, '2026-08-21T16:00:06.000Z');
  assert.equal(row.duration_seconds, 46);
  assert.equal(row.campaign, 'Rehash');
  assert.equal(row.direction, 'Outbound');
  assert.equal(row.disposition, 'NA');
  assert.equal(row.eligible, true);
  assert.equal(row.status, 'discovered');
  assert.equal(row.raw_metadata.expected_recording_count, 1);
});

test('the RECORDINGS column parses from the live single-segment shape', () => {
  const { row } = buildCallRow([zip(AGENT_CALL)], null, CFG);
  assert.deepEqual(row.raw_metadata.recording_segments, [{ at: '09:00:25', duration: '0:43' }]);
});
