/**
 * scripts/test-context-lite.js — the lead-state classifier's light context
 * build, and the shadow Five9 calls read kept off the critical path
 * (src/context-builder.js: contextParts, fetchRecentCalls).
 *
 * 2026-10-14 (GHL budget, PR 3): the lead-state sweep made ~350 FULL context
 * builds an hour (29,608 GHL requests a day), and every build waited up to 6s on
 * a shadow Five9 read that timed out 55 of 55 times.
 *
 *   node --test scripts/test-context-lite.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// context-builder reads these at module scope; set BEFORE the import.
process.env.GHL_API_KEY ||= 'test-key';
process.env.GHL_LOCATION_ID ||= 'TESTLOC';
process.env.SUPABASE_URL ||= 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'stub-key';
process.env.CONTEXT_SB_TIMEOUT_MS ||= '300';

const { contextParts, fetchRecentCalls } = await import('../src/context-builder.js');

test('default build reads everything and is cached', () => {
  assert.deepEqual(contextParts(), { conversation: true, ghlNotes: true, calls: true, cacheable: true });
  assert.deepEqual(contextParts({ skipCache: true }), { conversation: true, ghlNotes: true, calls: true, cacheable: true });
});

test('the classifier build skips the conversation, GHL notes and calls, and is never cached', () => {
  assert.deepEqual(contextParts({ forStateClassifier: true }), { conversation: false, ghlNotes: false, calls: false, cacheable: false });
  // forStateClassifier wins over an explicit includeConversation
  assert.equal(contextParts({ forStateClassifier: true, includeConversation: true }).conversation, false);
});

test('a build without the conversation keeps notes and calls but is not cached (the analyzer reads the cache)', () => {
  assert.deepEqual(contextParts({ includeConversation: false }), { conversation: false, ghlNotes: true, calls: true, cacheable: false });
});

// A Supabase stub whose query never settles: the shape of the 6s timeout.
function hangingSupabase() {
  const q = {
    select() { return q; }, or() { return q; }, gte() { return q; }, order() { return q; },
    limit() { return new Promise(() => {}); },
  };
  return { from: () => q };
}

test('shadow: returns the LP calls without waiting for the Five9 read', async () => {
  const lpCalls = [{ result: 'NA', type: 'Outbound', agent: 'A', date: '2026-10-13T14:00:00Z', phone: '3525550188' }];
  const t0 = Date.now();
  const out = await fetchRecentCalls(
    { ghlContactId: 'c1', phone: '3525550188', lpLeadId: 581695 },
    { source: 'shadow', supabase: hangingSupabase(), fetchLPCalls: async () => lpCalls },
  );
  assert.deepEqual(out, lpCalls);
  assert.ok(Date.now() - t0 < 100, `took ${Date.now() - t0}ms`);
});

test('lp mode never touches Five9', async () => {
  let touched = false;
  const sb = { from: () => { touched = true; return hangingSupabase().from(); } };
  const out = await fetchRecentCalls({ ghlContactId: 'c1', phone: '3525550188', lpLeadId: 1 }, { source: 'lp', supabase: sb, fetchLPCalls: async () => [] });
  assert.deepEqual(out, []);
  assert.equal(touched, false);
});
