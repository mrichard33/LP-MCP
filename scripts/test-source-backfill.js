/**
 * Backfill decision tests — scripts/test-source-backfill.js
 *
 * 2026-09-16 (issue #949). scripts/backfill-source-attribution.js re-applies
 * vendor source tags that `source:unknown` evicted from 707 contacts.
 *
 * A repair script is only as safe as its skip logic. The failure mode that
 * matters is not "restored too few" — it is restoring over attribution that
 * something else already fixed, which is the same clobber the script exists to
 * undo, except performed deliberately and in bulk. These tests pin the three
 * pure decisions: who is eligible, which tag wins, and how the recorded events
 * become a plan.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

process.env.GHL_API_KEY = 'test-key';

const { mostSpecific, repairVerdict, lossesFromEvents, lossesFromActions, buildPlan, WIPE_RULES, REQUIRED_ENV } =
  await import('../scripts/backfill-source-attribution.js');

/** The script's plan for one producer, as the old planFromEvents returned it. */
const planFromEvents = (rows) => buildPlan(lossesFromEvents(rows));

// ─── who gets repaired ─────────────────────────────────────────────────

test('a contact still stuck on source:unknown is eligible', () => {
  const v = repairVerdict(['entry:other', 'active-entry:other', 'source:unknown']);
  assert.equal(v.repair, true);
});

test('a contact that already has a specific source tag is left alone', () => {
  const v = repairVerdict(['source:unknown', 'source:internet-homebuddy']);
  assert.equal(v.repair, false);
  assert.equal(v.reason, 'already_has_specific',
    'something already restored it; writing again would swap out the good tag');
});

test('a contact no longer carrying source:unknown is left alone', () => {
  const v = repairVerdict(['source:internet-modernize']);
  assert.equal(v.repair, false);
  assert.equal(v.reason, 'no_longer_unknown');
});

test('a contact with no source tag at all is left alone', () => {
  assert.equal(repairVerdict(['entry:other']).repair, false,
    'the script repairs a known bad state; it does not invent attribution for contacts that never had it');
});

test('an unreadable contact is never written to', () => {
  assert.equal(repairVerdict(null).repair, false);
  assert.equal(repairVerdict(undefined).reason, 'unreadable');
  assert.equal(repairVerdict('not-an-array').repair, false,
    'a failed read must not be mistaken for an empty tag list');
});

// ─── which tag wins ────────────────────────────────────────────────────

test('the specific vendor tag beats the generic parent', () => {
  assert.equal(
    mostSpecific(['source:internet', 'source:internet-homebuddy']),
    'source:internet-homebuddy',
    'this is the exact pair recorded for contact RuUeUK82fcV5MYv4q5AU');
});

test('the generic parent alone is not worth restoring', () => {
  assert.equal(mostSpecific(['source:internet']), null,
    'source:internet carries no vendor information — restoring it is churn, not repair');
});

test('only one tag is ever chosen', () => {
  const picked = mostSpecific(['source:internet', 'source:internet-contractor-appointments-ppl-west']);
  assert.equal(typeof picked, 'string',
    'restoring both would recreate the double-source-tag state that is itself a defect');
  assert.equal(picked, 'source:internet-contractor-appointments-ppl-west');
});

test('source:unknown is never restored — it is the tag we stopped writing', () => {
  // Real case: contact RuUeUK82fcV5MYv4q5AU. The routing-tags path wrote
  // source:unknown, then the hygiene rule wiped it, so source:unknown appears
  // in the removal record. Restoring it would re-create the exact damage.
  assert.equal(mostSpecific(['source:unknown']), null);
  assert.equal(mostSpecific(['source:internet', 'source:unknown']), null,
    'neither the generic parent nor the fallback names a vendor');
  assert.equal(mostSpecific(['source:unknown', 'source:internet-homebuddy']),
    'source:internet-homebuddy',
    'but a real vendor tag alongside it still wins');
});

test('duplicates and empties do not confuse the choice', () => {
  assert.equal(mostSpecific(['source:internet-angi', 'source:internet-angi']), 'source:internet-angi');
  assert.equal(mostSpecific([]), null);
  assert.equal(mostSpecific([null, undefined, '']), null);
});

// ─── events to plan ────────────────────────────────────────────────────

const liveEvent = (contactId, removed) => ({
  ghl_contact_id: contactId,
  payload: {
    step_results: [
      { step: 'add_entry', result: { tag_applied: 'entry:other', contact_id: contactId } },
      { step: 'add_source', result: { tag_applied: 'source:unknown', removed_conflicting: removed } },
    ],
  },
});

test('the plan is built from the recorded removals', () => {
  const plan = planFromEvents([
    liveEvent('c1', ['source:internet', 'source:internet-homebuddy']),
    liveEvent('c2', ['source:internet-modernize']),
  ]);
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.find((p) => p.contactId === 'c1').tag, 'source:internet-homebuddy');
  assert.deepEqual(plan.find((p) => p.contactId === 'c2').tag, 'source:internet-modernize');
});

test('a contact hit more than once appears once, with its best tag', () => {
  const plan = planFromEvents([
    liveEvent('c1', ['source:internet']),
    liveEvent('c1', ['source:internet-my-home-pros']),
  ]);
  assert.equal(plan.length, 1, 'one write per contact, not one per event');
  assert.equal(plan[0].tag, 'source:internet-my-home-pros');
});

test('events that removed nothing are ignored', () => {
  assert.deepEqual(planFromEvents([liveEvent('c1', [])]), [],
    'an add with no eviction destroyed no attribution');
});

test('events that wrote a real source tag are ignored', () => {
  const ok = {
    ghl_contact_id: 'c1',
    payload: { step_results: [{ step: 'add_source', result: { tag_applied: 'source:reece-direct-site', removed_conflicting: ['source:unknown'] } }] },
  };
  assert.deepEqual(planFromEvents([ok]), [],
    'that is attribution improving, which is the behavior we want to keep');
});

test('a contact whose only loss was the generic parent is dropped', () => {
  assert.deepEqual(planFromEvents([liveEvent('c1', ['source:internet'])]), []);
});

test('malformed rows never throw', () => {
  const junk = [
    {},
    { ghl_contact_id: null, payload: {} },
    { ghl_contact_id: 'c1', payload: null },
    { ghl_contact_id: 'c1', payload: '{not json' },
    { ghl_contact_id: 'c1', payload: { step_results: null } },
  ];
  assert.deepEqual(planFromEvents(junk), [],
    'a bad row in a 30-day scan must not abort the repair of every other contact');
  assert.deepEqual(planFromEvents(null), []);
});

test('a payload stored as a JSON string is parsed', () => {
  const row = {
    ghl_contact_id: 'c1',
    payload: JSON.stringify(liveEvent('c1', ['source:internet-lead-gurus']).payload),
  };
  assert.equal(planFromEvents([row])[0].tag, 'source:internet-lead-gurus',
    'system_events.payload comes back as json or text depending on the client');
});

// ─── the agent-rule producer (the one the first version missed) ────────────

const ruleAction = (contactId, removed, rule = 'ENTRY_HYGIENE_AT_CREATION_OTHER') => ({
  target_id: contactId,
  execution_result: Array.isArray(removed)
    ? { tags: removed, prefix: 'source:', contact_id: contactId, tags_removed: removed.length }
    : { contact_id: contactId, tag_removed: removed },
  rule_applied: rule,
});

test('the rule path is read at all — its absence was the defect', () => {
  // ENTRY_HYGIENE_AT_CREATION_* wiped 1,705 contacts vs 710 via routing-tags.
  // The first version of this script read only the latter, so --write would
  // have repaired 30% and reported success.
  const losses = lossesFromActions([
    ruleAction('c1', ['source:internet', 'source:internet-contractor-appointments']),
  ]);
  assert.deepEqual(losses, [
    ['c1', 'source:internet'],
    ['c1', 'source:internet-contractor-appointments'],
  ]);
});

test('a batch removal (tags array) and a single removal (tag_removed) both parse', () => {
  assert.deepEqual(lossesFromActions([ruleAction('c1', ['source:internet-modernize'])]),
    [['c1', 'source:internet-modernize']],
    'executeRemoveTag reports a batch as tags[]');
  assert.deepEqual(lossesFromActions([ruleAction('c2', 'source:internet-angi')]),
    [['c2', 'source:internet-angi']],
    'and a single removal as the tag_removed string — both shapes are in the real data');
});

test('non-source tags removed by the same action are ignored', () => {
  assert.deepEqual(
    lossesFromActions([ruleAction('c1', ['active-entry:other', 'source:internet-homebuddy'])]),
    [['c1', 'source:internet-homebuddy']],
    'these rules also wiped active-entry:; that is not attribution to restore here');
});

test('malformed action rows never throw', () => {
  assert.deepEqual(lossesFromActions([{}, { target_id: null }, { target_id: 'c1', execution_result: null },
    { target_id: 'c1', execution_result: '{not json' }, { target_id: 'c1', execution_result: {} }]), []);
  assert.deepEqual(lossesFromActions(null), []);
});

test('an execution_result stored as a JSON string is parsed', () => {
  const row = { target_id: 'c1', execution_result: JSON.stringify({ tags: ['source:radio-simpletext'] }) };
  assert.deepEqual(lossesFromActions([row]), [['c1', 'source:radio-simpletext']]);
});

// ─── merging the two producers ─────────────────────────────────────────

test('a contact hit by BOTH producers gets one row with the best tag', () => {
  const plan = buildPlan(
    lossesFromEvents([liveEvent('c1', ['source:internet'])]),
    lossesFromActions([ruleAction('c1', ['source:internet-modernize'])]),
  );
  assert.equal(plan.length, 1, 'one write per contact, not one per producer');
  assert.equal(plan[0].tag, 'source:internet-modernize',
    'the merge must happen BEFORE choosing, or the weaker tag can win');
});

test('the two producers union rather than overwrite', () => {
  const plan = buildPlan(
    lossesFromEvents([liveEvent('c1', ['source:internet-homebuddy'])]),
    lossesFromActions([ruleAction('c2', ['source:internet-angi'])]),
  );
  assert.equal(plan.length, 2);
  assert.equal(plan.find((p) => p.contactId === 'c1').tag, 'source:internet-homebuddy');
  assert.equal(plan.find((p) => p.contactId === 'c2').tag, 'source:internet-angi');
});

test('buildPlan tolerates missing and empty producer lists', () => {
  assert.deepEqual(buildPlan(), []);
  assert.deepEqual(buildPlan(null, undefined, []), []);
});

test('WIPE_RULES names exactly the three rules that wrote source:unknown', () => {
  assert.deepEqual([...WIPE_RULES].sort(), [
    'ENTRY_HYGIENE_AT_CREATION_FALLBACK',
    'ENTRY_HYGIENE_AT_CREATION_OTHER',
    'ENTRY_HYGIENE_AT_CREATION_UNKNOWN',
  ], 'the other 20 hygiene rules wipe source: but then write a SPECIFIC tag — that is an upgrade, not loss');
});

// ─── the direct-run guard must work on Windows ─────────────────────────

test('the direct-run guard matches on Windows-style paths', () => {
  // 2026-09-16 — the guard was `import.meta.url === \`file://${process.argv[1]}\``.
  // On Windows argv[1] is a backslash path, so that comparison was ALWAYS false:
  // main() never ran, and the process exited 0 with no output — a repair script
  // that looks like it succeeded and found nothing. It matched on Linux, which
  // is the only reason it shipped.
  const winPath = 'C:\\Users\\mark\\LP-MCP\\scripts\\backfill-source-attribution.js';
  const winUrl = pathToFileURL(winPath).href;

  assert.notEqual(winUrl, `file://${winPath}`,
    'the old string form is what broke Windows — if these are ever equal the test has stopped testing anything');
  assert.ok(winUrl.startsWith('file:///'),
    `a Windows path must become a triple-slash file URL, got ${winUrl}`);
  assert.ok(!winUrl.includes('\\'), 'and must contain no backslashes');
});

test('the direct-run guard still matches on POSIX paths', () => {
  const posixPath = '/home/user/LP-MCP/scripts/backfill-source-attribution.js';
  assert.equal(pathToFileURL(posixPath).href, `file://${posixPath}`,
    'the fix must not change Linux behaviour, where the old form already worked');
});

test('the guard survives a path containing a space', () => {
  // Latent on Linux too: the old form left the space unencoded, so
  // import.meta.url (which percent-encodes) never matched.
  const spaced = '/home/user/My Repos/LP-MCP/scripts/backfill-source-attribution.js';
  const href = pathToFileURL(spaced).href;
  assert.ok(href.includes('%20'), `expected the space to be encoded, got ${href}`);
  assert.notEqual(href, `file://${spaced}`);
});

test('the env preflight names every credential the script cannot run without', () => {
  // Nothing in the import chain loads dotenv. Without the preflight a missing
  // variable surfaces as "Cannot read properties of null (reading 'from')"
  // several frames into main(), which tells an operator nothing.
  assert.deepEqual([...REQUIRED_ENV].sort(),
    ['GHL_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_URL'],
    'SUPABASE_* reach the LP database; GHL_API_KEY does the live read and the restore write');
});
