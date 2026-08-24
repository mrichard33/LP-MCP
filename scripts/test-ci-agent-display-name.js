/**
 * Tests — customer-safe agent display names
 * scripts/test-ci-agent-display-name.js
 *
 * WHAT THIS GUARDS. ci_agent_map.agent_name is seeded from the Five9 user
 * record, and those records carry ADMINISTRATIVE labels. Confirmed live
 * 2026-08-24:
 *
 *     e.ramirez@reecewindows.com  ->  'Mark R (Keep Old Edwin Account)'
 *
 * which the note composer rendered into a CRM note header as
 *
 *     Agent: Mark R (Keep Old Edwin Account) (reece)
 *
 * on a real customer's record, in both CRMs.
 *
 * The fix is a LAYER — ci_agent_map.display_name (sql/069) — so the two things
 * these tests care about are:
 *
 *   1. THE RESOLUTION ORDER, at every fallback step.
 *   2. THAT THE NOTE HEADER AND THE ANALYZER AGREE. A summary and a header
 *      naming the same agent differently reads as two people on one call,
 *      which is worse than either being wrong alone.
 *
 * No network, no DB — the map is a plain Map.
 *
 * Run: node --test scripts/test-ci-agent-display-name.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveAgentLabel } from '../src/ci/teams.js';
import { agentLabelFor } from '../src/ci/worker.js';
import { composeNote } from '../src/ci/notes.js';
import { agentContextLine, buildUserMessage } from '../src/ci/analyze.js';
import { inspectAgentName, buildReport } from './review-ci-agent-names.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The live offender, verbatim. */
const BAD_LABEL = 'Mark R (Keep Old Edwin Account)';
const AGENT_MAP = new Map([
  ['e.ramirez@reecewindows.com', {
    agent_username: 'e.ramirez@reecewindows.com',
    agent_name: BAD_LABEL,
    display_name: 'Mark Richard',
    team: 'reece',
  }],
  ['jflanders', { agent_username: 'jflanders', agent_name: 'Jamal Flanders', display_name: null, team: 'reece' }],
  ['blankdisp', { agent_username: 'blankdisp', agent_name: 'Real Name', display_name: '   ', team: 'reece' }],
]);

// ─── the resolution order ───────────────────────────────────────────────────

test('display_name WINS when it is set', () => {
  assert.equal(
    resolveAgentLabel({ displayName: 'Mark Richard', agentName: BAD_LABEL, agentUsername: 'e.ramirez@reecewindows.com' }),
    'Mark Richard',
  );
});

test('it falls back to agent_name when display_name is null or blank', () => {
  for (const displayName of [null, undefined, '', '   ']) {
    assert.equal(
      resolveAgentLabel({ displayName, agentName: 'Jamal Flanders', agentUsername: 'jflanders' }),
      'Jamal Flanders',
      `displayName ${JSON.stringify(displayName)}`,
    );
  }
});

test('then to the username, then to a filler — never to empty', () => {
  assert.equal(resolveAgentLabel({ agentName: null, agentUsername: 'jflanders' }), 'jflanders');
  assert.equal(resolveAgentLabel({ agentName: '  ', agentUsername: 'jflanders' }), 'jflanders');
  assert.equal(resolveAgentLabel({}), 'unknown agent');
  assert.equal(resolveAgentLabel(), 'unknown agent');
  assert.equal(resolveAgentLabel({ displayName: null, agentName: null, agentUsername: null }), 'unknown agent');
});

// ─── resolving against the loaded map ───────────────────────────────────────

test('agentLabelFor resolves the live offender to the corrected name', () => {
  const call = { agent_username: 'e.ramirez@reecewindows.com', agent_name: BAD_LABEL, team: 'reece' };
  assert.equal(agentLabelFor(call, AGENT_MAP), 'Mark Richard');
});

test('the map lookup is case-insensitive, like every other agent lookup', () => {
  const call = { agent_username: 'E.Ramirez@ReeceWindows.com', agent_name: BAD_LABEL };
  assert.equal(agentLabelFor(call, AGENT_MAP), 'Mark Richard');
});

test('an agent with no override keeps their real name', () => {
  const call = { agent_username: 'jflanders', agent_name: 'Jamal Flanders' };
  assert.equal(agentLabelFor(call, AGENT_MAP), 'Jamal Flanders');
});

test('a blank display_name is treated as absent, not as an empty label', () => {
  const call = { agent_username: 'blankdisp', agent_name: 'Real Name' };
  assert.equal(agentLabelFor(call, AGENT_MAP), 'Real Name');
});

test('no map, or an unknown login, degrades to the call row alone', () => {
  // The pre-sql/069 behaviour — an unavailable map must not blank the header.
  const call = { agent_username: 'nobody', agent_name: 'Some Agent' };
  assert.equal(agentLabelFor(call, AGENT_MAP), 'Some Agent');
  assert.equal(agentLabelFor(call, null), 'Some Agent');
  assert.equal(agentLabelFor(call, undefined), 'Some Agent');
  assert.equal(agentLabelFor({ agent_username: null, agent_name: null }, AGENT_MAP), 'unknown agent');
});

// ─── the note header ────────────────────────────────────────────────────────

const CALL = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  five9_call_id: '300000010270798',
  call_start: '2026-08-21T16:00:00Z',
  direction: 'Outbound',
  agent_username: 'e.ramirez@reecewindows.com',
  agent_name: BAD_LABEL,
  team: 'reece',
};
const SUMMARY = { output: { summary: 'The agent confirmed the appointment.', outcome: 'appointment_confirmed' } };

test('THE ADMINISTRATIVE LABEL NEVER REACHES THE NOTE HEADER', () => {
  const note = composeNote(CALL, SUMMARY, null, agentLabelFor(CALL, AGENT_MAP));
  assert.match(note, /Agent: Mark Richard \(reece\)/);
  assert.equal(note.includes('Keep Old Edwin Account'), false, 'the internal note must not reach a customer record');
  assert.equal(note.includes('('.repeat(1) + 'Keep'), false);
});

test('composeNote takes NO database dependency', () => {
  // It receives the resolved label. If it ever looked one up, every note test
  // would need a database and the module would stop being pure.
  const src = fs.readFileSync(path.join(ROOT, 'src/ci/notes.js'), 'utf8');
  // Strip comments — the doc block legitimately NAMES ci_agent_map to say the
  // label is resolved elsewhere. What must be absent is code that reaches for it.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/supabase|\.from\(|createClient/.test(code), false, 'notes.js must stay free of any client');
  assert.equal(/ci_agent_map/.test(code), false, 'notes.js must not read the map');
  assert.equal(/^import /m.test(code), false, 'notes.js imports nothing at all — it is pure by contract');
});

test('with no label supplied the header is byte-for-byte what it was', () => {
  const before = composeNote(CALL, SUMMARY);
  assert.equal(composeNote(CALL, SUMMARY, null, null), before);
  assert.match(before, /Agent: Mark R \(Keep Old Edwin Account\) \(reece\)/, 'the old behaviour, unchanged');
});

// ─── the analyzer must agree with the header ────────────────────────────────

test('THE ANALYZER AND THE NOTE HEADER PRINT THE SAME LABEL', () => {
  const label = agentLabelFor(CALL, AGENT_MAP);
  const note = composeNote(CALL, SUMMARY, null, label);
  const line = agentContextLine(CALL, label);

  assert.match(line, /The agent on this call is Mark Richard, an internal Reece call-center agent\./);
  assert.equal(line.includes('Keep Old Edwin Account'), false);

  // The same string appears in both artifacts — that is the actual guarantee.
  assert.ok(note.includes(label), 'the header must carry the resolved label');
  assert.ok(line.includes(label), 'the identity line must carry the same one');
});

test('the analyzer prompt carries the corrected label end to end', () => {
  const msg = buildUserMessage(
    { transcript_text: 't', diarization_method: 'none' },
    CALL,
    agentLabelFor(CALL, AGENT_MAP),
  );
  assert.match(msg, /The agent on this call is Mark Richard/);
  assert.equal(msg.includes('Keep Old Edwin Account'), false);
});

test("'unknown agent' is treated as no name, not asserted to the model", () => {
  // It is resolveAgentLabel's last-resort filler. Telling the model "The agent
  // on this call is unknown agent." is worse than saying nothing.
  assert.equal(agentContextLine({ agent_name: null }, 'unknown agent'), null);
  assert.equal(agentContextLine({ agent_name: '' }, 'unknown agent'), null);
});

test('no label supplied leaves the analyzer on its previous behaviour', () => {
  const line = agentContextLine(CALL);
  assert.match(line, /The agent on this call is Mark R \(Keep Old Edwin Account\)/);
});

// ─── the review script ──────────────────────────────────────────────────────

test('the parenthesised row is FLAGGED', () => {
  const [row] = buildReport([{ agent_username: 'e.ramirez@reecewindows.com', agent_name: BAD_LABEL, display_name: null, team: 'reece' }]);
  assert.equal(row.needsReview, true);
  assert.ok(row.reasons.some((r) => /parenthes/i.test(r)));
  assert.ok(row.reasons.some((r) => /'keep'/.test(r)));
  assert.ok(row.reasons.some((r) => /'old'/.test(r)));
  assert.equal(row.label, BAD_LABEL, 'with no override, this is what a customer would see');
});

test('a row that ALREADY has an override is not flagged', () => {
  // The concern is answered — what reaches the CRM is the display_name.
  const [row] = buildReport([{ agent_username: 'e.ramirez@reecewindows.com', agent_name: BAD_LABEL, display_name: 'Mark Richard' }]);
  assert.equal(row.needsReview, false);
  assert.equal(row.label, 'Mark Richard');
});

test('ordinary names are not flagged — no false positives on real people', () => {
  for (const name of ['Jamal Flanders', 'Shari Walker', 'Marcorie Toussaint', "Edward Kuriger, Jr", 'Anne Goldstein', 'Maria Testa']) {
    assert.equal(inspectAgentName(name).suspicious, false, `'${name}' must not be flagged`);
  }
});

test('the word match is on boundaries, so Goldstein is not "old"', () => {
  assert.equal(inspectAgentName('Anne Goldstein').suspicious, false);
  assert.equal(inspectAgentName('Maria Testa').suspicious, false);
  assert.equal(inspectAgentName('Old Account').suspicious, true);
  assert.equal(inspectAgentName('TEST USER').suspicious, true);
  assert.equal(inspectAgentName('do not use').suspicious, true);
});

test('an email in the name field is flagged as not-a-name', () => {
  const { suspicious, reasons } = inspectAgentName('c.garner@reecewindows.com');
  assert.equal(suspicious, true);
  assert.ok(reasons.some((r) => /email/.test(r)));
});

test('an empty name is not flagged — that is a different problem', () => {
  assert.equal(inspectAgentName(null).suspicious, false);
  assert.equal(inspectAgentName('').suspicious, false);
});

test('the review script has NO write path', () => {
  // Choosing what a colleague is called on a customer's permanent record is a
  // human decision. A script that could make it would eventually be run
  // without anyone reading the output.
  const src = fs.readFileSync(path.join(ROOT, 'scripts/review-ci-agent-names.js'), 'utf8');
  assert.equal(/--execute/.test(src.replace(/^\s*\*.*$/gm, '')), false, 'no --execute flag');
  assert.equal(/\.update\(|\.upsert\(|\.insert\(|\.delete\(/.test(src), false, 'no write call of any kind');
});

// ─── the migration does not backfill ────────────────────────────────────────

test('sql/069 adds the column and writes NO data', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'sql/069_ci_agent_display_name.sql'), 'utf8');
  const statements = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.match(statements, /ALTER TABLE ci_agent_map ADD COLUMN IF NOT EXISTS display_name text/);
  // A backfilled copy of agent_name goes stale the next time Five9 renames
  // someone, and then two columns disagree with nothing to say which was meant.
  assert.equal(/UPDATE\s+ci_agent_map/i.test(statements), false, 'the migration must not write data');
  assert.equal(/SET\s+display_name/i.test(statements), false);
});
