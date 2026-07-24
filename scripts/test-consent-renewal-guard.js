// Tests for the Phase 2 consent-renewal guard (src/sync-leads.js).
// Pure predicates — no network, no DB. Run:
//   node --test scripts/test-consent-renewal-guard.js
//
// These lock down the compliance-critical boundary: a NEW consumer inbound on
// a previously-DNC prospect renews consent, while a re-read of an existing DNC
// lead (a valid STOP revocation — Max Lesser 2026-07-23) NEVER does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRenewConsent, isRecentInbound } from '../src/services/consent-renewal.js';

const nowIso = () => new Date().toISOString();
const daysAgoIso = (d) => new Date(Date.now() - d * 86_400_000).toISOString();

// ─── isRecentInbound ──────────────────────────────────────────────────
test('isRecentInbound: today is recent', () => {
  assert.equal(isRecentInbound(nowIso()), true);
});
test('isRecentInbound: 10 days ago is NOT recent (default 3d window)', () => {
  assert.equal(isRecentInbound(daysAgoIso(10)), false);
});
test('isRecentInbound: null/garbage is not recent', () => {
  assert.equal(isRecentInbound(null), false);
  assert.equal(isRecentInbound('not-a-date'), false);
});

// ─── shouldRenewConsent — the FIRES case ──────────────────────────────
test('FIRES: new estimator inbound, born DNC, first appearance, recent', () => {
  assert.equal(shouldRenewConsent({
    existing: null,                 // first appearance of a NEW lead
    newDisposition: 'DNC',
    bucket: 'estimate-calculator',  // consumer express-consent form
    createdAt: nowIso(),
  }), true);
});
test('FIRES: chatbot inbound too', () => {
  assert.equal(shouldRenewConsent({
    existing: null, newDisposition: 'DNC', bucket: 'chatbot', createdAt: nowIso(),
  }), true);
});

// ─── shouldRenewConsent — the DOES-NOT-FIRE cases ─────────────────────
test('BLOCKED: re-read of an existing DNC lead (Max STOP revocation)', () => {
  // existing row present → re-processing, not new consent. This is the exact
  // guard that keeps a post-inbound STOP revocation suppressed.
  assert.equal(shouldRenewConsent({
    existing: { disposition_code: 'DNC', ghl_contact_id: 'abc' },
    newDisposition: 'DNC', bucket: 'estimate-calculator', createdAt: nowIso(),
  }), false);
});
test('BLOCKED: non-consumer source (reseller/aggregator "other")', () => {
  assert.equal(shouldRenewConsent({
    existing: null, newDisposition: 'DNC', bucket: 'other', createdAt: nowIso(),
  }), false);
});
test('BLOCKED: referral / canvassing buckets', () => {
  for (const bucket of ['referral', 'canvassing', 'high-intent-digital']) {
    assert.equal(shouldRenewConsent({
      existing: null, newDisposition: 'DNC', bucket, createdAt: nowIso(),
    }), false, `bucket ${bucket} must not renew`);
  }
});
test('BLOCKED: old DNC lead surfacing on a backfill sync (stale createdAt)', () => {
  assert.equal(shouldRenewConsent({
    existing: null, newDisposition: 'DNC', bucket: 'estimate-calculator', createdAt: daysAgoIso(30),
  }), false);
});
test('BLOCKED: non-DNC disposition is never intercepted', () => {
  for (const d of ['Data', 'Set', 'Cnf', 'Sale', null]) {
    assert.equal(shouldRenewConsent({
      existing: null, newDisposition: d, bucket: 'estimate-calculator', createdAt: nowIso(),
    }), false, `disposition ${d} must not renew`);
  }
});
