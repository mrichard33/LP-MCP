/**
 * test-dedup-confirm.js — a 'deduped' analyzer verdict must be CONFIRMED.
 *
 * Exercises src/services/analysis-confirm.js against an in-memory mock of the
 * system_events table.
 *
 * The defect this locks down (2026-08-02, contact KJRaCnNiHBhpABCUjEtF, event
 * 2456618): two consumers race for every inbound message. The loser gets
 * {skipped:true, reason:'recently_analyzed'}, which /n8n/analyze-message
 * reports as {success:true, deduped:true} and triggerAgenticPipeline treated as
 * TERMINAL SUCCESS — letting markBufferEventsProcessed mark the source
 * system_events processed. Correct only if the winner actually succeeded.
 * During the GHL 429 blackout neither consumer could complete an analysis, so
 * replies were marked processed while emitting no ai.analysis_completed:
 * silent, unretryable, unalerted loss for 47 hours.
 *
 * Core property: recentAnalysisExists() returns false ONLY on a successful read
 * that found nothing — the unconfirmed-dedup case the pipeline must treat as a
 * failure so the reply is retried and then handed to the durable backstop.
 * EVERY failure path fails OPEN (true), because a Supabase read failure turning
 * genuine dedups into a retry storm is worse than occasionally trusting a
 * dedup, and the caller's retries are bounded by BUFFER_MAX_RETRIES anyway.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// No real client — proves the module never reaches the network and lets the
// no-supabase fail-open case be exercised with client omitted.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { recentAnalysisExists, DEDUP_CONFIRM_WINDOW_MS } = await import(
  '../src/services/analysis-confirm.js'
);

const CONTACT = 'KJRaCnNiHBhpABCUjEtF'; // the canary contact
const NOW = Date.now();
const ago = (ms) => new Date(NOW - ms).toISOString();

// Stateful mock of system_events. Each row: { id, event_type, ghl_contact_id,
// created_at }. Mirrors the PostgREST chain the module actually uses:
// from().select().eq().eq().gte().limit() → { data, error }.
function mockClient(rows = [], { error = null, throws = false } = {}) {
  return {
    from(table) {
      assert.equal(table, 'system_events');
      const filters = [];
      let gteCreatedAt = null;
      const api = {
        select() { return api; },
        eq(col, val) { filters.push([col, val]); return api; },
        gte(col, val) {
          assert.equal(col, 'created_at');
          gteCreatedAt = val;
          return api;
        },
        limit(n) {
          if (throws) throw new Error('connection reset by peer');
          if (error) return Promise.resolve({ data: null, error });
          const matched = rows.filter((r) =>
            filters.every(([col, val]) => r[col] === val)
            && (!gteCreatedAt || r.created_at >= gteCreatedAt));
          return Promise.resolve({ data: matched.slice(0, n), error: null });
        },
      };
      return api;
    },
  };
}

const analysisRow = (overrides = {}) => ({
  id: 2456999,
  event_type: 'ai.analysis_completed',
  ghl_contact_id: CONTACT,
  created_at: ago(30000),
  ...overrides,
});

test('a real ai.analysis_completed inside the window confirms the dedup', async () => {
  const ok = await recentAnalysisExists(CONTACT, { client: mockClient([analysisRow()]) });
  assert.equal(ok, true);
});

test('REGRESSION: no matching analysis → unconfirmed, so the reply is not dropped', async () => {
  // The Engelke drop. The message key was claimed in agentic_consumed_messages
  // and the source event marked combined_into_reply_buffer, but no
  // ai.analysis_completed was ever emitted for this contact.
  const ok = await recentAnalysisExists(CONTACT, { client: mockClient([]) });
  assert.equal(ok, false, 'must report UNCONFIRMED so the pipeline returns false');
});

test('an analysis older than the window does not confirm', async () => {
  const stale = analysisRow({ created_at: ago(DEDUP_CONFIRM_WINDOW_MS + 60000) });
  const ok = await recentAnalysisExists(CONTACT, { client: mockClient([stale]) });
  assert.equal(ok, false);

  // Same row, window widened to cover it → confirmed. Proves the gte bound is
  // what excluded it, not the contact/event_type filters.
  const widened = await recentAnalysisExists(CONTACT, {
    client: mockClient([stale]),
    windowMs: DEDUP_CONFIRM_WINDOW_MS + 120000,
  });
  assert.equal(widened, true);
});

test('another contact\'s analysis does not confirm this one', async () => {
  const other = analysisRow({ ghl_contact_id: '4qcX45ReKbXPbKKQTLka' });
  const ok = await recentAnalysisExists(CONTACT, { client: mockClient([other]) });
  assert.equal(ok, false);
});

test('a different event_type for this contact does not confirm', async () => {
  // ghl.reply_received is exactly what WAS present for the stranded contacts
  // while ai.analysis_completed was absent — the shape of the outage.
  const reply = analysisRow({ event_type: 'ghl.reply_received' });
  const ok = await recentAnalysisExists(CONTACT, { client: mockClient([reply]) });
  assert.equal(ok, false);
});

test('a Supabase error fails OPEN — no retry storm', async () => {
  const ok = await recentAnalysisExists(CONTACT, {
    client: mockClient([], { error: { message: 'statement timeout' } }),
  });
  assert.equal(ok, true);
});

test('a throwing client fails OPEN', async () => {
  const ok = await recentAnalysisExists(CONTACT, {
    client: mockClient([], { throws: true }),
  });
  assert.equal(ok, true);
});

test('no supabase client at all fails OPEN', async () => {
  // client omitted; the module default is null because the env vars are unset.
  const ok = await recentAnalysisExists(CONTACT);
  assert.equal(ok, true);
});

test('the confirm window is wider than the analyzer cache TTL it must cover', () => {
  // ANALYSIS_CACHE_TTL_MS (message-analyzer.js) is 120000. The dedup sentinel
  // that produces a 'deduped' verdict cannot outlive that cache, so a genuine
  // dedup's confirming event is always well inside this window. If this ever
  // inverts, real dedups start reading as unconfirmed and replies get retried
  // for no reason.
  assert.ok(
    DEDUP_CONFIRM_WINDOW_MS > 120000,
    `expected DEDUP_CONFIRM_WINDOW_MS (${DEDUP_CONFIRM_WINDOW_MS}) > ANALYSIS_CACHE_TTL_MS (120000)`,
  );
});
