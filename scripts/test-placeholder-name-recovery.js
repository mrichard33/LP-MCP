/**
 * Placeholder-name recovery — scripts/test-placeholder-name-recovery.js
 *
 * create_lp_lead must never send LP a "Guest Visitor" name. When the visitor
 * gave a real name in the chat, it is recovered, written to GHL, and sent.
 * Transcript strings below are trimmed from live Chat Transcript fields
 * (2026-09-28).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GHL_API_KEY = process.env.GHL_API_KEY || 'test-key';

const {
  needsNameRecovery, buildRecoveryCorpus, isTrustworthyName, recoverPlaceholderName,
  pickLpRealName, lpProspectsNeedingName,
} = await import('../src/services/placeholder-name-recovery.js');
const { resolveHandlerTimeoutMs } = await import('../src/actions/index.js');
const { llmBudgetMs } = await import('../src/llm-client.js');

// ─── needsNameRecovery ────────────────────────────────────────────

test('widget placeholder in every shape it is stored in', () => {
  assert.equal(needsNameRecovery('Guest Visitor bljpx', ''), true);   // whole in first
  assert.equal(needsNameRecovery('guest', 'visitor kjyzo'), true);    // split
  assert.equal(needsNameRecovery('guest', null), true);               // normalised to bare "guest" (59eU0qiZ0BwhV1BZGFfm)
  assert.equal(needsNameRecovery('GUEST', ''), true);
  assert.equal(needsNameRecovery('', ''), true);
  assert.equal(needsNameRecovery(null, 'Smith'), true);
});
test('real names are left alone', () => {
  assert.equal(needsNameRecovery('Linda', 'Crouse'), false);
  assert.equal(needsNameRecovery('Guy', 'Visitorson'), false);
  assert.equal(needsNameRecovery('Guesta', ''), false);
  assert.equal(needsNameRecovery('Stephen', 'Guest'), false);
});

// ─── buildRecoveryCorpus ──────────────────────────────────────────

test('messages keep their direction; transcript is the visitor side', () => {
  const turns = buildRecoveryCorpus('a / Donna Reece 662-312-5252', [
    { direction: 'outbound', body: 'Hi! What is your name?' },
    { direction: 'inbound', body: 'Donna' },
    { direction: 'inbound', body: '' },
  ]);
  assert.deepEqual(turns.map((t) => t.direction), ['outbound', 'inbound', 'inbound']);
  assert.equal(turns[2].text, 'a / Donna Reece 662-312-5252');
});
test('empty inputs → no turns', () => {
  assert.deepEqual(buildRecoveryCorpus('', []), []);
  assert.deepEqual(buildRecoveryCorpus(null, null), []);
});

// ─── isTrustworthyName ────────────────────────────────────────────

test('a name the visitor typed is trusted', () => {
  const turns = buildRecoveryCorpus('I need a double pane glass / Britt Austen 386-898-1082', []);
  assert.equal(isTrustworthyName('Britt', turns), true);
});
test('a name the visitor never typed is rejected (model invention)', () => {
  const turns = buildRecoveryCorpus('Do your windows include the screens?', []);
  assert.equal(isTrustworthyName('Karen', turns), false);
});
test('a name only in the bot\'s own messages is rejected', () => {
  const turns = buildRecoveryCorpus('', [
    { direction: 'outbound', body: "Hi Linda, I'm Sarah an appointment specialist at Reece Windows." },
    { direction: 'inbound', body: 'how many do I need' },
  ]);
  assert.equal(isTrustworthyName('Linda', turns), false);
  assert.equal(isTrustworthyName('Sarah', turns), false);
});
test('the agent introducing itself inside the transcript is rejected (1cMRCgPa7bU9dnhtMHeI)', () => {
  const turns = buildRecoveryCorpus(' / Hey there, Audrey here regarding Reece Windows, how are you?', []);
  assert.equal(isTrustworthyName('Audrey', turns), false);
});
test('the visitor saying "this is Donna" is still trusted', () => {
  const turns = buildRecoveryCorpus('hi this is Donna, my house was built in 2021', []);
  assert.equal(isTrustworthyName('Donna', turns), true);
});
test('a placeholder is never trusted even if typed', () => {
  const turns = buildRecoveryCorpus('guest', []);
  assert.equal(isTrustworthyName('guest', turns), false);
});

// ─── recoverPlaceholderName (deps seam, no network) ───────────────

const identity = (first, last, extra = {}) => ({
  first_name: first, last_name: last, phone: null, email: null,
  address_line1: null, city: null, state: null, postal_code: null,
  _source: { first_name: 'extracted', ...(last ? { last_name: 'extracted' } : {}) },
  ...extra,
});

function fakeDeps({ messages = [], extracted = null, write = true } = {}) {
  const calls = { updates: [], removed: [] };
  return {
    calls,
    deps: {
      fetchMessages: async () => messages,
      extract: async () => extracted,
      updateFields: async (id, payload) => { calls.updates.push(payload); return write; },
      removeTags: async (id, tags) => { calls.removed.push(tags); },
    },
  };
}

test('bare "guest" contact with a name in the chat → GHL updated, real name returned', async () => {
  const { deps, calls } = fakeDeps({ extracted: identity('Britt', 'Austen') });
  const r = await recoverPlaceholderName('c1', { firstName: 'guest', lastName: null, phone: '+13868981082' },
    { transcript: 'I need a double pane glass / Britt Austen 386-898-1082' }, deps);
  assert.equal(r.found, true);
  assert.equal(r.firstName, 'Britt');
  assert.equal(r.lastName, 'Austen');
  assert.equal(r.ghlWrite, true);
  assert.deepEqual(calls.updates[0], { firstName: 'Britt', lastName: 'Austen' });
  assert.deepEqual(calls.removed[0], ['name-placeholder']);
});
test('the placeholder surname is cleared when only a first name is found', async () => {
  const { deps, calls } = fakeDeps({ extracted: identity('Donna', null) });
  const r = await recoverPlaceholderName('c2', { firstName: 'guest', lastName: 'visitor kjyzo' },
    { transcript: 'this is Donna' }, deps);
  assert.equal(r.found, true);
  assert.equal(calls.updates[0].lastName, '');
});
test('address found in the chat fills an empty contact address, never overwrites one', async () => {
  const withAddr = identity('Victor', 'Lopez', {
    address_line1: '2885 S Oasis Dr', city: 'Boynton Beach',
    _source: { first_name: 'extracted', last_name: 'extracted', address_line1: 'extracted', city: 'extracted' },
  });
  let run = fakeDeps({ extracted: withAddr });
  let r = await recoverPlaceholderName('c3', { firstName: 'Guest Visitor bljpx' },
    { transcript: 'Victor Lopez / 2885 S Oasis Dr Boynton Beach' }, run.deps);
  assert.equal(r.payload.address1, '2885 S Oasis Dr');
  assert.equal(r.payload.city, 'Boynton Beach');

  run = fakeDeps({ extracted: withAddr });
  r = await recoverPlaceholderName('c3', { firstName: 'guest', address1: '1 Other St', city: 'Tampa' },
    { transcript: 'Victor Lopez / 2885 S Oasis Dr Boynton Beach' }, run.deps);
  assert.equal(r.payload.address1, undefined);
  assert.equal(r.payload.city, undefined);
});
test('no name in the chat → not found, GHL untouched', async () => {
  const { deps, calls } = fakeDeps({ extracted: identity(null, null) });
  const r = await recoverPlaceholderName('c4', { firstName: 'guest' },
    { transcript: 'Do your windows include the screens?' }, deps);
  assert.equal(r.found, false);
  assert.equal(calls.updates.length, 0);
});
test('model returns a name the visitor never typed → not found', async () => {
  const { deps, calls } = fakeDeps({ extracted: identity('Karen', null) });
  const r = await recoverPlaceholderName('c5', { firstName: 'guest' },
    { transcript: 'Do your windows include the screens?' }, deps);
  assert.equal(r.found, false);
  assert.match(r.reason, /Karen/);
  assert.equal(calls.updates.length, 0);
});
test('no chat at all → not found without calling the model', async () => {
  let called = false;
  const { deps } = fakeDeps();
  deps.extract = async () => { called = true; return null; };
  const r = await recoverPlaceholderName('c6', { firstName: 'guest' }, { transcript: '' }, deps);
  assert.equal(r.found, false);
  assert.equal(called, false);
});
test('conversation read fails → transcript alone still recovers the name', async () => {
  const { deps } = fakeDeps({ extracted: identity('Britt', 'Austen') });
  deps.fetchMessages = async () => { throw new Error('GHL 503'); };
  const r = await recoverPlaceholderName('c7', { firstName: 'guest' }, { transcript: 'Britt Austen 386-898-1082' }, deps);
  assert.equal(r.found, true);
});
test('GHL write fails → name still returned so LP gets it, with the failure reported', async () => {
  const { deps, calls } = fakeDeps({ extracted: identity('Britt', 'Austen'), write: false });
  const r = await recoverPlaceholderName('c8', { firstName: 'guest' }, { transcript: 'Britt Austen' }, deps);
  assert.equal(r.found, true);
  assert.equal(r.ghlWrite, false);
  assert.equal(calls.removed.length, 0, 'the placeholder tag stays until GHL really has the name');
});

// ─── executor watchdog ────────────────────────────────────────────

test('create_lp_lead watchdog covers the inline appointment handler plus one model call', () => {
  const create = resolveHandlerTimeoutMs('create_lp_lead');
  assert.ok(create >= resolveHandlerTimeoutMs('set_lp_appointment') + llmBudgetMs('identity_extraction'),
    `create_lp_lead ${create}ms must cover set_lp_appointment + identity_extraction`);
  assert.ok(create > resolveHandlerTimeoutMs('add_tag'));
});

// ─── LP side (remediation sweep) ──────────────────────────────────

test('pickLpRealName: newest real name wins, placeholders skipped', () => {
  // 7dhVGD3jZm5K86Q7YS8U: GHL says "guest", LP learned the name.
  assert.deepEqual(pickLpRealName([
    { first_name: 'guest', last_name: 'visitor kfajd', created_at_lp: '2026-09-02T00:00:00' },
    { first_name: 'Stephen', last_name: 'Brookfield', created_at_lp: '2026-09-01T00:00:00' },
    { first_name: 'Steve', last_name: 'B', created_at_lp: '2026-01-01T00:00:00' },
  ]), { firstName: 'Stephen', lastName: 'Brookfield' });
});
test('pickLpRealName: trims LP whitespace; nothing real → null', () => {
  assert.deepEqual(pickLpRealName([{ first_name: ' Robert ', last_name: 'Staufenberg ' }]),
    { firstName: 'Robert', lastName: 'Staufenberg' });
  assert.equal(pickLpRealName([{ first_name: 'guest', last_name: 'visitor wsemf' }, { first_name: null }]), null);
  assert.equal(pickLpRealName(undefined), null);
});
test('lpProspectsNeedingName: only placeholder prospects, de-duplicated', () => {
  assert.deepEqual(lpProspectsNeedingName([
    { lp_prospect_id: 1, first_name: 'guest', last_name: 'visitor yakcx' },
    { lp_prospect_id: 1, first_name: 'guest', last_name: 'visitor yakcx' },
    { lp_prospect_id: 2, first_name: 'Linda', last_name: 'Crouse' },
    { lp_prospect_id: null, first_name: 'guest' },
  ]), ['1']);
});

// ─── remediation sweep: restart-proof run rows (2026-09-28) ───────
// Five dry runs in a row were wiped by redeploys before any finished; the
// in-memory job was the only copy. Every row now also lands in system_events.

const { buildRunRowEvent, runGuestVisitorRemediation } =
  await import('../src/admin/guest-visitor-remediation.js');

test('run row: dry-run subtype, run id in payload, idempotent per row', () => {
  const ev = buildRunRowEvent({
    runId: 'gvr_x', dryRun: true, seq: 7,
    entry: { contact_id: 'c1', action: 'promoted', detail: 'firstName=Britt' },
  });
  assert.equal(ev.event_type, 'remediation.guest_visitor');
  assert.equal(ev.event_subtype, 'dry_run:promoted');
  assert.equal(ev.payload.run_id, 'gvr_x');
  assert.equal(ev.payload.detail, 'firstName=Britt');
  assert.equal(ev.idempotency_key, 'gvr:gvr_x:7');
  assert.equal(ev.ghl_contact_id, 'c1');
  assert.equal(ev.bypass_filter, true);
});
test('run row: live subtype; a "-" placeholder id is not a contact', () => {
  const ev = buildRunRowEvent({ runId: 'r', dryRun: false, seq: 1, entry: { contact_id: '-', action: 'sweep_error', detail: '' } });
  assert.equal(ev.event_subtype, 'live:sweep_error');
  assert.equal(ev.ghl_contact_id, null);
});
test('run: every recorded row is saved before the run returns', async () => {
  const saved = [];
  const prevUrl = process.env.HL_SUPABASE_URL;
  delete process.env.HL_SUPABASE_URL; // no HL cache → one "sweep_skipped" row
  try {
    const r = await runGuestVisitorRemediation(
      { dryRun: true, skipVictor: true, runId: 'gvr_test' },
      { emitEvent: async (ev) => { saved.push(ev); } },
    );
    assert.equal(r.run_id, 'gvr_test');
    assert.equal(saved.length, r.total_actions);
    assert.ok(saved.length >= 1);
    assert.equal(saved[0].event_subtype, 'dry_run:sweep_skipped');
  } finally {
    if (prevUrl !== undefined) process.env.HL_SUPABASE_URL = prevUrl;
  }
});
test('run: a failed save never breaks the sweep', async () => {
  const prevUrl = process.env.HL_SUPABASE_URL;
  delete process.env.HL_SUPABASE_URL;
  try {
    const r = await runGuestVisitorRemediation(
      { dryRun: true, skipVictor: true, runId: 'gvr_test2' },
      { emitEvent: async () => { throw new Error('db down'); } },
    );
    assert.ok(r.total_actions >= 1);
  } finally {
    if (prevUrl !== undefined) process.env.HL_SUPABASE_URL = prevUrl;
  }
});
test('run: no run id → nothing is written', async () => {
  const saved = [];
  const prevUrl = process.env.HL_SUPABASE_URL;
  delete process.env.HL_SUPABASE_URL;
  try {
    await runGuestVisitorRemediation({ dryRun: true, skipVictor: true }, { emitEvent: async (ev) => { saved.push(ev); } });
    assert.equal(saved.length, 0);
  } finally {
    if (prevUrl !== undefined) process.env.HL_SUPABASE_URL = prevUrl;
  }
});
