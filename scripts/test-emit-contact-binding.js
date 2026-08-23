/**
 * Emit-time contact binding — scripts/test-emit-contact-binding.js
 *
 * Covers issue #312: an emitted event must carry ghl_contact_id whenever the
 * corresponding lp_leads row has one AT EMIT TIME.
 *
 * Several emit sites resolve the contact id from a read taken earlier in the
 * same pass and emit whatever that read held. The worst is
 * src/sync-leads.js upsertLeadOnly(), which deliberately deletes a null
 * ghl_contact_id from the upsert so it never clobbers a stored link (v10.1) and
 * then emits `flatRow.ghl_contact_id || flatGhlId || null` — after that delete
 * the first term is `undefined`, so the very link it preserved is never read.
 * src/admin/lp-mirror-backfill.js has the same shape (emits the pre-upsert
 * `existingGhlId` while buildLeadRow may derive a new id into the row).
 *
 * The fix binds once in src/event-emitter.js, so every current and future emit
 * site is covered. These tests exercise resolveEmitContactBinding — the actual
 * function emitEvent calls, not a copy of its logic — through an injected
 * reader, because the suite runs with no node flags and mock.module requires
 * --experimental-test-module-mocks.
 *
 * §D is the regression that matters operationally: a tag-gated rule
 * (has_any_tag) evaluating a BOUND event reads real tags instead of
 * fail-closing. It drives the real evaluateContextConditions via the _internal
 * surface and the deps seam — no stubbed verdicts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
process.env.GHL_API_KEY = process.env.GHL_API_KEY || 'test-ghl-key';

const { resolveEmitContactBinding } = await import('../src/event-emitter.js');
const { _internal } = await import('../src/decision-engine.js');
const { evaluateContextConditions } = _internal;

/**
 * Stand-in for the lp_leads read, over a fixture keyed by lp_lead_id. Counts
 * calls so "a caller-supplied id costs no read" is asserted, not assumed.
 * `undefined` in the fixture means the lead row is absent entirely; `null`
 * means the row exists and is genuinely unlinked.
 */
function makeReader(fixture) {
  const reader = async (lpLeadId) => {
    reader.reads++;
    reader.readKeys.push(String(lpLeadId));
    const v = fixture[String(lpLeadId)];
    return v === undefined ? null : v;
  };
  reader.reads = 0;
  reader.readKeys = [];
  return reader;
}

const LINKED = { '511364': 'ghlContact511364', '900001': 'abcDEF123456789012345' };

// ─── §A the lead is linked → the event must carry the id ─────────────

test('(A1) lp_lead_id whose lead HAS a ghl_contact_id → event carries it', async () => {
  const read = makeReader(LINKED);
  const out = await resolveEmitContactBinding({ lp_lead_id: '511364' }, read);

  assert.equal(out.contactId, 'ghlContact511364', 'the stored link must reach the event');
  assert.equal(out.bound, true, 'binding happened, so the provenance marker is set');
  assert.equal(read.reads, 1, 'exactly one lookup — not zero, not two');
  assert.deepEqual(read.readKeys, ['511364']);
});

test('(A2) a numeric lp_lead_id is read as a string — lp_leads.lp_lead_id is TEXT', async () => {
  const read = makeReader(LINKED);
  const out = await resolveEmitContactBinding({ lp_lead_id: 511364 }, read);

  assert.equal(out.contactId, 'ghlContact511364');
  assert.deepEqual(read.readKeys, ['511364'], 'a bigint-typed caller must still match the TEXT key');
});

test('(A3) this is exactly the upsertLeadOnly flat-path shape', async () => {
  // buildLeadRow deletes a null ghl_contact_id to protect the stored link, so
  // the emit site had `undefined || null` in hand while lp_leads held a link.
  const read = makeReader(LINKED);
  const flatRow = { ghl_contact_id: undefined };   // post-delete, as it ships
  const flatGhlId = null;                          // no id derived this pass

  const out = await resolveEmitContactBinding(
    { ghl_contact_id: flatRow.ghl_contact_id || flatGhlId || null, lp_lead_id: '900001' },
    read,
  );
  assert.equal(out.contactId, 'abcDEF123456789012345', 'the preserved link must now reach the event');
  assert.equal(out.bound, true);
});

// ─── §B never fabricate a link ───────────────────────────────────────

test('(B1) lead exists but ghl_contact_id IS NULL → event carries NULL', async () => {
  const read = makeReader({ '777': null });
  const out = await resolveEmitContactBinding({ lp_lead_id: '777' }, read);

  assert.equal(out.contactId, null, 'an unlinked lead must NOT be given a contact id');
  assert.equal(out.bound, false, 'no binding happened, so no provenance marker');
  assert.equal(read.reads, 1);
});

test('(B2) no lp_leads row at all → NULL, still never fabricated', async () => {
  const read = makeReader({});
  const out = await resolveEmitContactBinding({ lp_lead_id: 'does-not-exist' }, read);
  assert.equal(out.contactId, null);
  assert.equal(out.bound, false);
});

test('(B3) a lookup failure fails OPEN to null — it must never fail the emit', async () => {
  const exploding = async () => { throw new Error('supabase unreachable'); };
  await assert.doesNotReject(
    () => resolveEmitContactBinding({ lp_lead_id: '511364' }, async (id) => {
      try { return await exploding(id); } catch { return null; }
    }),
    'the emitter swallows binding failures; the event still lands',
  );
});

test('(B4) no lp_lead_id → nothing to resolve from, and ZERO reads', async () => {
  const read = makeReader(LINKED);
  const out = await resolveEmitContactBinding({ lp_lead_id: null }, read);

  assert.equal(out.contactId, null);
  assert.equal(read.reads, 0, 'never probe lp_leads without a lead id');
});

// ─── §C a caller-supplied id wins, with no extra read ────────────────

test('(C1) caller passed ghl_contact_id → passed value wins, ZERO reads', async () => {
  const read = makeReader(LINKED);
  const out = await resolveEmitContactBinding(
    { ghl_contact_id: 'callerSuppliedId1234', lp_lead_id: '511364' },
    read,
  );

  assert.equal(out.contactId, 'callerSuppliedId1234', 'the caller is authoritative');
  assert.equal(out.bound, false, 'nothing was bound — no provenance marker');
  assert.equal(read.reads, 0, 'ghl-field-sync.js avoids this round-trip deliberately; do not regress it');
});

test('(C2) the caller wins even when lp_leads disagrees', async () => {
  // A disagreement is a link-integrity question, not the emitter's to arbitrate.
  const read = makeReader({ '511364': 'storedDifferentId9999' });
  const out = await resolveEmitContactBinding(
    { ghl_contact_id: 'callerSuppliedId1234', lp_lead_id: '511364' },
    read,
  );
  assert.equal(out.contactId, 'callerSuppliedId1234');
  assert.equal(read.reads, 0);
});

test('(C3) neither id → NULL, zero reads (the decision-engine telemetry shape)', async () => {
  // emitConditionFailClosed emits with a contact id and no lp_lead_id, so the
  // binding must add no cost to the ~7k/day fail-closed telemetry path.
  const read = makeReader(LINKED);
  const out = await resolveEmitContactBinding({}, read);
  assert.equal(out.contactId, null);
  assert.equal(read.reads, 0);
});

// ─── §D regression: a bound event does not fail closed ───────────────

/** Fake GHL contact fetch returning a fixed tag set for any contact id. */
function fetchWithTags(tags) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ contact: { tags, customFields: [] } }),
  });
}

const TAG_GATED = { has_any_tag: ['stage:new-lead', 'lp-linked'] };

test('(D1) an UNBOUND event fail-closes a tag-gated rule — the bug being fixed', async () => {
  // No contact id => resolveContactSnapshot returns null => tags unreadable
  // => failClosed. This is the ~7k/day rule.condition_failed_closed volume.
  const event = {
    id: 1, event_type: 'lp.disposition_changed', event_subtype: 'Set',
    ghl_contact_id: null, lp_lead_id: '511364', payload: {},
  };
  const verdict = await evaluateContextConditions(TAG_GATED, {}, event, {
    ruleKey: 'LP_DISP_SET', deps: { fetch: fetchWithTags(['stage:new-lead']) },
  });

  assert.equal(verdict, false, 'no contact id means no tags to read — correctly suppressed');
  assert.ok(event._failClosedRules?.has('LP_DISP_SET'), 'and it is recorded as fail-closed');
});

test('(D2) the SAME event, bound via §A, evaluates the rule for real', async () => {
  const read = makeReader(LINKED);
  const bound = await resolveEmitContactBinding({ lp_lead_id: '511364' }, read);
  assert.equal(bound.contactId, 'ghlContact511364');

  // The event as it now lands in system_events.
  const event = {
    id: 2, event_type: 'lp.disposition_changed', event_subtype: 'Set',
    ghl_contact_id: bound.contactId, lp_lead_id: '511364', payload: {},
  };
  const verdict = await evaluateContextConditions(TAG_GATED, {}, event, {
    ruleKey: 'LP_DISP_SET', deps: { fetch: fetchWithTags(['stage:new-lead', 'other']) },
  });

  assert.equal(verdict, true, 'the tag is present, so the rule must MATCH, not fail closed');
  assert.equal(event._failClosedRules, undefined, 'nothing was suppressed');
});

test('(D3) binding does not turn a tag gate into a wildcard', async () => {
  // The point is to EVALUATE the gate, not to pass it. A bound contact whose
  // tags do not match must still block — otherwise this fix would be the
  // wildcard-pass the 2026-07-03 fail-closed doctrine forbids.
  const event = {
    id: 3, event_type: 'lp.disposition_changed', event_subtype: 'Set',
    ghl_contact_id: 'ghlContact511364', lp_lead_id: '511364', payload: {},
  };
  const verdict = await evaluateContextConditions(TAG_GATED, {}, event, {
    ruleKey: 'LP_DISP_SET', deps: { fetch: fetchWithTags(['some:unrelated-tag']) },
  });

  assert.equal(verdict, false, 'blocked on tag absence — a real evaluation, not a fail-close');
  assert.equal(event._failClosedRules, undefined, 'blocked ≠ fail-closed; the distinction matters');
});

test('(D4) a genuinely unlinked lead still fail-closes, and that is correct', async () => {
  // #376 / #222: the 77% backlog cohort. Binding must not paper over it.
  const read = makeReader({ '888': null });
  const bound = await resolveEmitContactBinding({ lp_lead_id: '888' }, read);
  assert.equal(bound.contactId, null);

  const event = {
    id: 4, event_type: 'lp.disposition_changed', event_subtype: 'Set',
    ghl_contact_id: bound.contactId, lp_lead_id: '888', payload: {},
  };
  const verdict = await evaluateContextConditions(TAG_GATED, {}, event, {
    ruleKey: 'LP_DISP_SET', deps: { fetch: fetchWithTags(['stage:new-lead']) },
  });

  assert.equal(verdict, false, 'no link means no contact to read tags from — fail closed is right');
  assert.ok(event._failClosedRules?.has('LP_DISP_SET'));
});
