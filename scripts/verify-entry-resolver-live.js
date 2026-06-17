/**
 * GUARDED live verification for the map-driven entry resolver (routing fix
 * Step 2, handoff §9 integration check). NOT part of `npm test` — the filename
 * is intentionally outside the `scripts/test-*.js` glob because it needs live
 * Supabase + GHL credentials.
 *
 * Run (post-deploy, with the flag conceptually ON — this script doesn't read
 * the flag, it exercises the resolver directly):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... GHL_API_KEY=... \
 *     node scripts/verify-entry-resolver-live.js [contactId]
 *
 * It fetches the live Lead Gurus contact (default GMVyKlnwRaPQgXchiFEK),
 * resolves against the live lp_source_mapping snapshot, and ASSERTS THE
 * COMPUTED RESULT ONLY. It writes NOTHING to the contact.
 */

import assert from 'node:assert/strict';
import { resolveEntryFromSourceMap, entryTagSuffix } from '../src/entry-source-map.js';

const contactId = process.argv[2] || 'GMVyKlnwRaPQgXchiFEK';
const GHL_API_KEY = process.env.GHL_API_KEY;

if (!GHL_API_KEY) {
  console.error('GHL_API_KEY is required (and SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY for the map lookup).');
  process.exit(2);
}

async function fetchContact(id) {
  const res = await fetch(`https://services.leadconnectorhq.com/contacts/${id}`, {
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      Version: '2021-07-28',
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`GHL fetch failed: ${res.status}`);
  const data = await res.json();
  return data?.contact || data;
}

const contact = await fetchContact(contactId);
const resolved = await resolveEntryFromSourceMap(contact);

console.log(`[verify] contact ${contactId} →`, resolved);

assert.ok(resolved, 'expected a map match for the Lead Gurus contact');
assert.equal(entryTagSuffix(resolved.entryTag), 'high-intent-digital',
  `expected entry suffix high-intent-digital, got ${entryTagSuffix(resolved.entryTag)}`);
assert.equal(resolved.matchedOn, 'subdetail',
  `expected signal source-map:subdetail, got source-map:${resolved.matchedOn}`);

console.log('[verify] ✅ resolves to high-intent-digital via source-map:subdetail (no tags written)');
