#!/usr/bin/env node
/**
 * Tests for classifyGHLError — scripts/test-ghl-error-classify.js
 *
 * Run: npm test   (node --test scripts/test-*.js)
 *
 * Guards the 2026-07-28 incident fix. The classifier decides whether a GHL API
 * error means "this contact id is unreachable, never retry" or "hard failure,
 * count it toward the kill switch". Getting that boundary wrong is expensive in
 * both directions:
 *
 *   under-match → an orphan id retries forever AND walks the shared
 *                 ghlFailCount toward ghlDisabled, killing every GHL write
 *                 process-wide (the original bug).
 *   over-match  → a real credential/scope revocation is silently swallowed as
 *                 "contact not found" and the kill switch never fires.
 *
 * The bare-403 case below is the one that pins the second direction down.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyGHLError } from '../src/services/ghl-error-classify.js';

// axios error shape (src/ghl.js goes through an axios client)
const axiosErr = (status, data) => ({
  message: `Request failed with status code ${status}`,
  response: { status, data },
});

// ghlFetch error shape (src/actions/helpers.js throws a plain Error whose
// message is the only place the status appears)
const fetchErr = (status, body) =>
  new Error(`GHL GET /contacts/abc123 → ${status}: ${body}`);

const WRONG_LOCATION = 'The token does not have access to this location.';

test('404 classifies as not-found', () => {
  const r = classifyGHLError(axiosErr(404, { message: 'Contact not found' }));
  assert.equal(r.notFound, true);
  assert.equal(r.status, 404);
  assert.equal(r.reason, 'http_404');
});

test('404 with an empty body still classifies as not-found', () => {
  assert.equal(classifyGHLError(axiosErr(404, undefined)).notFound, true);
});

test('400 + "not found" classifies (pre-existing behavior preserved)', () => {
  const r = classifyGHLError(axiosErr(400, { message: 'Contact not found' }));
  assert.equal(r.notFound, true);
  assert.equal(r.reason, 'http_400_not_found');
});

test('400 without "not found" does NOT classify', () => {
  assert.equal(classifyGHLError(axiosErr(400, { message: 'Invalid body' })).notFound, false);
});

test('403 + wrong-location message classifies as not-found', () => {
  const r = classifyGHLError(axiosErr(403, { statusCode: 403, message: WRONG_LOCATION }));
  assert.equal(r.notFound, true);
  assert.equal(r.status, 403);
  assert.equal(r.reason, 'http_403_wrong_location');
});

test('403 wrong-location match is case-insensitive', () => {
  const r = classifyGHLError(axiosErr(403, { message: 'THE TOKEN DOES NOT HAVE ACCESS TO THIS LOCATION.' }));
  assert.equal(r.notFound, true);
});

// ─── The critical negative case ──────────────────────────────────────────────
test('BARE 403 does NOT classify — must stay a hard failure', () => {
  const r = classifyGHLError(axiosErr(403, { message: 'Forbidden' }));
  assert.equal(r.notFound, false, 'a bare 403 must still trip the kill switch');
  assert.equal(r.reason, null);
});

test('403 with an unrelated auth message does NOT classify', () => {
  assert.equal(classifyGHLError(axiosErr(403, { message: 'Invalid JWT' })).notFound, false);
  assert.equal(classifyGHLError(axiosErr(403, {})).notFound, false);
});

test('429 and 5xx do NOT classify', () => {
  assert.equal(classifyGHLError(axiosErr(429, { message: 'Too many requests' })).notFound, false);
  assert.equal(classifyGHLError(axiosErr(500, { message: 'Internal error' })).notFound, false);
  assert.equal(classifyGHLError(axiosErr(502, '')).notFound, false);
});

test('network error with no response does NOT classify', () => {
  const r = classifyGHLError({ message: 'connect ETIMEDOUT', code: 'ETIMEDOUT' });
  assert.equal(r.notFound, false);
  assert.equal(r.status, null);
});

test('null / undefined input is handled without throwing', () => {
  assert.equal(classifyGHLError(undefined).notFound, false);
  assert.equal(classifyGHLError(null).notFound, false);
  assert.equal(classifyGHLError({}).status, null);
});

// ─── ghlFetch message shape (used by the orphan audit script) ────────────────
test('ghlFetch-shaped 403 wrong-location classifies', () => {
  const r = classifyGHLError(fetchErr(403, JSON.stringify({ statusCode: 403, message: WRONG_LOCATION })));
  assert.equal(r.notFound, true);
  assert.equal(r.status, 403);
  assert.equal(r.reason, 'http_403_wrong_location');
});

test('ghlFetch-shaped 404 classifies', () => {
  const r = classifyGHLError(fetchErr(404, '{"message":"not found"}'));
  assert.equal(r.notFound, true);
  assert.equal(r.status, 404);
});

test('ghlFetch-shaped bare 403 does NOT classify', () => {
  const r = classifyGHLError(fetchErr(403, '{"message":"Forbidden"}'));
  assert.equal(r.notFound, false);
  assert.equal(r.status, 403);
});

test('ghlFetch-shaped 500 does NOT classify', () => {
  const r = classifyGHLError(fetchErr(500, 'boom'));
  assert.equal(r.notFound, false);
  assert.equal(r.status, 500);
});

test('a non-GHL Error message is not mis-parsed for a status', () => {
  const r = classifyGHLError(new Error('something broke → not a status: here'));
  assert.equal(r.notFound, false);
  assert.equal(r.status, null);
});
