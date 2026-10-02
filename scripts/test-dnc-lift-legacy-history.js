/**
 * test-dnc-lift-legacy-history.js — the DNC-lift card for a block older than
 * the consent model (2026-10-02)
 *
 * 30 of 32 review cards read "none recorded yet": every one was blocked only on
 * Five9's DNC list from before consent_events existed. These pin:
 *   - the card gets the last Five9 DNC result, last call and LP disposition
 *     when consent history is empty, and nothing extra when it is not;
 *   - every lookup is best-effort: a throw or a hang still posts the card;
 *   - a Five9-only block is seeded ONCE as five9_legacy, never twice;
 *   - the full phone, the LP prospect id and the LP manual-clear flag;
 *   - the approve response's LP manual-clear flag (lpClearOutcome);
 *   - the re-entry sweep does not read a five9_legacy row as a fresh opt-out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';
process.env.GHL_API_KEY ||= 'test_dummy_key';
process.env.GHL_LOCATION_ID ||= 'test_location';

const review = await import('../src/consent/dnc-lift-review.js');
const decision = await import('../src/consent/dnc-lift-decision.js');
const sweep = await import('../src/jobs/dnc-reentry-sweep.js');

const PHONE10 = '3522811388';
const ESS_ROWS = [
  { created_at: '2026-09-30T14:00:00Z', disposition_name: 'Hung Up', campaign: 'Rehash', agent_name: 'Shari Walker - LF', call_end_at: '2026-09-30T14:00:05Z' },
  { created_at: '2026-08-12T15:00:00Z', disposition_name: 'Do Not Call', campaign: 'Data - Warm Leads less than 30', agent_name: 'Craig Deer - LF', call_end_at: '2026-08-12T15:01:00Z' },
];

function reviewDb() {
  return {
    from() {
      const api = {
        select() { return api; }, eq() { return api; }, neq() { return api; }, gte() { return api; },
        limit: async () => ({ data: [], error: null }),
        insert: async () => ({ error: null }),
        update() { return { eq: async () => ({ error: null }) }; },
      };
      return api;
    },
  };
}

/** A Five9-only blocked contact with no consent history; every seam injectable. */
function harness(over = {}) {
  const posts = [];
  const seeds = [];
  const calls = { five9: 0, record: 0 };
  const deps = {
    env: { N8N_DNC_LIFT_REVIEW_WEBHOOK: 'https://n8n.example.com/webhook/x', DNC_LIFT_WEBHOOK_SECRET: 's' },
    supabase: reviewDb(),
    readContact: async () => ({ firstName: 'Pat', lastName: 'Lee', phone: '+1 352-281-1388', tags: ['customer'], customFields: [] }),
    getConsent: async () => ({ status: 'ok', consent: null, events: [] }),
    checkDnc: async () => ({ on_dnc: [PHONE10] }),
    newRequestId: () => 'dnc-lift-t',
    fetch: async (url, init) => { posts.push(JSON.parse(init.body)); return { ok: true, status: 200 }; },
    readFive9History: async () => { calls.five9 += 1; return ESS_ROWS; },
    readContactRecord: async () => { calls.record += 1; return { date: '2026-05-01 10:00:00', campaign: 'Old Campaign' }; },
    readLpLead: async () => ({ prospect_id: '458487', label: 'Do Not Call', date: '2026-05-01T14:00:00.000Z' }),
    hasLegacySeed: async () => seeds.length > 0,
    recordConsentChange: async (p) => { seeds.push(p); return { ok: true }; },
    lookupTimeoutMs: 50,
    ...over,
  };
  const run = () => review.executeRequestDncLiftReview({ id: 1, target_id: 'C1', action_payload: { trigger: 'reentry' } }, {}, deps);
  return { deps, posts, seeds, calls, run };
}

test('formatPhoneFull: (XXX) XXX-XXXX, or null', () => {
  assert.equal(review.formatPhoneFull('+19543792151'), '(954) 379-2151');
  assert.equal(review.formatPhoneFull('9543792151'), '(954) 379-2151');
  assert.equal(review.formatPhoneFull('+1 (352) 281-1388'), '(352) 281-1388');
  assert.equal(review.formatPhoneFull('12345'), null);
  assert.equal(review.formatPhoneFull(null), null);
});

test('pickFive9History: newest DNC result and newest call, from the shared DNC list', () => {
  const h = review.pickFive9History(ESS_ROWS);
  assert.deepEqual(h.five9_last_dnc_dispo, { name: 'Do Not Call', date: '2026-08-12T15:01:00Z', agent: 'Craig Deer - LF', campaign: 'Data - Warm Leads less than 30' });
  assert.equal(h.five9_last_call.name, 'Hung Up');
  assert.deepEqual(review.pickFive9History([]), { five9_last_dnc_dispo: null, five9_last_call: null });
});

test('pickLpLead: prospect from the newest lead, disposition from the newest one LP actually set', () => {
  const rows = [
    { lp_prospect_id: '461048', disposition_code: 'Data', disposition_label: null, created_at_lp: '2026-10-02T10:54:49.05+00:00' },
    { lp_prospect_id: '461048', disposition_code: 'DNC', disposition_label: null, created_at_lp: '2026-09-01T16:33:37.877+00:00' },
  ];
  const out = review.pickLpLead(rows);
  assert.equal(out.prospect_id, '461048');
  assert.equal(out.label, 'DNC');
  assert.equal(out.date, '2026-09-01T20:33:37.877Z', 'LP wall clock is Eastern');
  assert.equal(review.pickLpLead([rows[0]]).label, 'Data', 'Data only when that is all there is');
  assert.equal(review.pickLpLead([]), null);
});

test('Five9-only block, no history → legacy_block on the card, seeded once as five9_legacy', async () => {
  const h = harness();
  const out = await h.run();
  assert.equal(out.action, 'review_requested');
  const p = h.posts[0];
  assert.equal(p.phone_full, '(352) 281-1388');
  assert.equal(p.phone_last4, '1388', 'kept for older n8n code');
  assert.equal(p.lp_prospect_id, '458487');
  assert.equal(p.lp_manual_clear_required, true);
  assert.deepEqual(p.last_consent_events, []);
  assert.equal(p.legacy_block.note, review.LEGACY_BLOCK_NOTE);
  assert.equal(p.legacy_block.five9_last_dnc_dispo.name, 'Do Not Call');
  assert.equal(p.legacy_block.five9_last_call.name, 'Hung Up');
  assert.deepEqual(p.legacy_block.lp_disposition, { label: 'Do Not Call', date: '2026-05-01T14:00:00.000Z' });
  assert.equal(h.calls.record, 0, 'ESS had a call, so the Five9 contact DB is not asked');

  assert.equal(h.seeds.length, 1);
  assert.deepEqual(h.seeds[0], {
    ghlContactId: 'C1', channel: 'phone', change: 'revoked', source: 'five9_legacy', actor: 'system',
    reason: 'On Five9 DNC before the consent system',
    evidence: { five9_last_dnc_dispo: p.legacy_block.five9_last_dnc_dispo, five9_last_call: p.legacy_block.five9_last_call },
    lpProspectId: '458487',
  });

  await h.run();
  assert.equal(h.seeds.length, 1, 'a second card never seeds twice');
});

test('consent history present → unchanged card: no legacy_block, no Five9 history read, no seed', async () => {
  const h = harness({
    getConsent: async () => ({ status: 'ok', consent: { phone_consent: 'revoked' }, events: [{ id: 9, channel: 'phone', change: 'revoked', source: 'ghl_tag', actor: 'system', created_at: '2026-09-29T00:00:00Z' }] }),
  });
  await h.run();
  assert.equal(h.posts[0].legacy_block, null);
  assert.equal(h.calls.five9, 0);
  assert.equal(h.seeds.length, 0);
});

test('a tag block with no history shows the legacy lines but is NOT seeded (not a Five9-only block)', async () => {
  const h = harness({ readContact: async () => ({ firstName: 'Pat', phone: '3522811388', tags: ['dnc-sms'] }) });
  await h.run();
  assert.ok(h.posts[0].legacy_block);
  assert.equal(h.seeds.length, 0);
});

test('ESS has no call → the Five9 contact record fills the last call', async () => {
  const h = harness({ readFive9History: async () => [] });
  await h.run();
  const lb = h.posts[0].legacy_block;
  assert.equal(h.calls.record, 1);
  assert.equal(lb.five9_last_dnc_dispo, null);
  assert.deepEqual(lb.five9_last_call, { name: null, date: '2026-05-01 10:00:00', agent: null, campaign: 'Old Campaign' });
});

test('every lookup throws or hangs → the card still posts with empty legacy fields; a failed seed only logs', async () => {
  const never = () => new Promise(() => {});
  const h = harness({
    readFive9History: never,
    readContactRecord: async () => { throw new Error('soap fault'); },
    readLpLead: async () => { throw new Error('db down'); },
    recordConsentChange: async () => { throw new Error('rpc down'); },
  });
  const out = await h.run();
  assert.equal(out.action, 'review_requested');
  const lb = h.posts[0].legacy_block;
  assert.deepEqual([lb.five9_last_dnc_dispo, lb.five9_last_call, lb.lp_disposition], [null, null, null]);
  assert.equal(lb.note, review.LEGACY_BLOCK_NOTE);
  assert.equal(h.posts[0].lp_prospect_id, null);
});

test('an unreadable consent record is not seeded (could not tell is not "no history")', async () => {
  const h = harness({ getConsent: async () => ({ status: 'error', consent: null, events: [] }) });
  await h.run();
  assert.equal(h.seeds.length, 0);
});

test('LP prospect id: the GHL field wins, the LP lead row is the fallback', async () => {
  const h = harness({
    readContact: async () => ({ firstName: 'Pat', phone: '3522811388', tags: [], customFields: [{ id: review.LP_PROSPECT_FIELD_ID, value: '462126' }] }),
  });
  await h.run();
  assert.equal(h.posts[0].lp_prospect_id, '462126');
});

test('LP_DNC_CLEAR_WORKING: unset or anything else → manual clear required; "true" → not', () => {
  assert.equal(review.lpManualClearRequired({}), true);
  assert.equal(review.lpManualClearRequired({ LP_DNC_CLEAR_WORKING: 'yes' }), true);
  assert.equal(review.lpManualClearRequired({ LP_DNC_CLEAR_WORKING: ' TRUE ' }), false);
});

test('approve response: lpClearOutcome', () => {
  const lp = (status, result, extra = {}) => [{ action_type: 'update_lp_dnc_status', status, result, ...extra }];
  const on = { LP_DNC_CLEAR_WORKING: 'true' };
  assert.deepEqual(decision.lpClearOutcome(lp('completed', { lp_prospect_id: '462126' }), { env: {} }),
    { lp_prospect_id: '462126', lp_manual_clear_required: true }, 'flag unset → always manual');
  assert.deepEqual(decision.lpClearOutcome(lp('completed', { lp_prospect_id: '462126' }), { env: on }),
    { lp_prospect_id: '462126', lp_manual_clear_required: false });
  assert.equal(decision.lpClearOutcome(lp('failed', null, { error: 'Invalid DNC value' }), { env: on }).lp_manual_clear_required, true);
  assert.equal(decision.lpClearOutcome(lp('pending', null), { env: on }).lp_manual_clear_required, true, 'a retrying clear is not a clear');
  const skipped = decision.lpClearOutcome(lp('completed', { lp_prospect_id: null }), { env: on, reviewPayload: { lp_prospect_id: '458487' } });
  assert.deepEqual(skipped, { lp_prospect_id: '458487', lp_manual_clear_required: true }, 'no prospect id on the contact = LP was never called');
  assert.equal(decision.lpClearOutcome([], { env: on }).lp_manual_clear_required, true);
});

test('re-entry sweep: a five9_legacy row is old history, never an opt-out after arrival', () => {
  const sql = sweep.buildOptedOutAfterSql([{ lp_lead_id: '1', ghl_contact_id: 'C1', phone10: PHONE10, arrived_at: '2026-10-02T12:00:00Z' }]);
  assert.match(sql, /e\.source <> 'five9_legacy'/);
});
