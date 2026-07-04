#!/usr/bin/env node
/**
 * One-time remediation — scripts/remediate-guest-visitors.js
 *
 * Victor Lopez incident (GHL XdAUR9qR42UdBre6Byrw, 2026-07-04) + the wider
 * guest-visitor cohort. See BUILD HANDOFF v1.1 §4.6.
 *
 *   1. Victor Lopez:
 *      - name already fixed manually 2026-07-04 → NEVER touched here
 *      - address1 "2885 S Oasis Dr", city "Boynton Beach", state "FL"
 *        (fill-if-empty only)
 *      - Jul 5 appointment: if status is confirmed → downgrade to "new"
 *        (wife confirmation still pending in the transcript)
 *      - remove malformed tag "concern-expressed:" and
 *        "bj:stage-4-negotiating" (keep bj:stage-5-committed)
 *
 *   2. Sweep: HL contacts cache for contact_name ILIKE 'guest visitor%'.
 *      Every hit is re-read LIVE from GHL before any mutation. If the
 *      transcript custom field yields a name → promote (placeholder rule);
 *      otherwise tag `name-placeholder`. Any tag ending in ':' is removed.
 *
 *   3. Every mutation logs a system_events row with
 *      event_type "remediation.guest_visitor".
 *
 * Safety:
 *   - All GHL writes go through ghlFetch (token-bucket rate limiter) plus
 *     a 600ms inter-contact delay (≤ 2 req/sec worst case).
 *   - PUT bodies are built from an explicit standard-field allowlist and
 *     NEVER contain a `tags` key (tag-wipe hazard). Tag removals use
 *     DELETE /contacts/{id}/tags only.
 *   - `--dry-run` prints every planned mutation without writing.
 *
 * Usage:
 *   node scripts/remediate-guest-visitors.js [--dry-run] [--limit N] [--skip-victor]
 *
 * Env (same as LP MCP Railway): GHL_API_KEY, SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, HL_SUPABASE_URL, HL_SUPABASE_SERVICE_ROLE_KEY.
 * Without the HL_* pair the sweep is skipped (Victor still runs).
 */

import { createClient } from '@supabase/supabase-js';
import { ghlFetch } from '../src/actions/helpers.js';
import { emitEvent } from '../src/event-emitter.js';
import {
  isPlaceholderName,
  heuristicExtract,
  buildPromotionPayload,
  geocodeStreetToZip,
  NAME_PLACEHOLDER_TAG,
} from '../src/services/identity-extraction.js';

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_VICTOR = process.argv.includes('--skip-victor');
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  // Cohort measured 2026-07-04: 484 cache candidates (116 whole-in-first +
  // 368 split first/last) — default covers the full set in one run.
  return i !== -1 ? parseInt(process.argv[i + 1], 10) || 600 : 600;
})();

const VICTOR_ID = 'XdAUR9qR42UdBre6Byrw';
const TRANSCRIPT_FIELD_ID = 'RF710H9k39oLl9TsQIy4';
const INTER_CONTACT_DELAY_MS = 600; // ≤ 2 req/sec pacing on top of the token bucket

const summary = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function record(contactId, action, detail = '') {
  summary.push({ contact_id: contactId, action, detail });
  console.log(`  ${DRY_RUN ? '[DRY] ' : ''}${contactId} — ${action}${detail ? `: ${detail}` : ''}`);
}

async function logRemediation(contactId, action, payload) {
  if (DRY_RUN) return;
  try {
    await emitEvent({
      event_type: 'remediation.guest_visitor',
      event_subtype: action,
      source: 'lp_mcp',
      entity_type: 'contact',
      entity_id: contactId,
      ghl_contact_id: contactId,
      payload: payload || {},
      priority: 'low',
      bypass_filter: true,
    });
  } catch (err) {
    console.warn(`  event log failed for ${contactId}/${action}: ${err.message}`);
  }
}

async function getLiveContact(contactId) {
  const res = await ghlFetch('GET', `/contacts/${contactId}`);
  return res?.contact || res || null;
}

function readCustomField(contact, fieldId) {
  const cfs = Array.isArray(contact?.customFields) ? contact.customFields : [];
  const f = cfs.find((x) => x?.id === fieldId);
  const v = f?.value ?? null;
  return v == null || String(v).trim() === '' ? null : String(v);
}

/** PUT standard fields only — allowlisted body, never a tags key. */
async function putStandardFields(contactId, fields) {
  const ALLOW = ['firstName', 'lastName', 'email', 'phone', 'address1', 'city', 'state', 'postalCode'];
  const body = {};
  for (const k of ALLOW) {
    if (fields[k] !== undefined && fields[k] !== null) body[k] = fields[k];
  }
  if ('tags' in fields) throw new Error('tags key in standard-field payload — refusing (tag-wipe hazard)');
  if (Object.keys(body).length === 0) return false;
  if (DRY_RUN) return true;
  await ghlFetch('PUT', `/contacts/${contactId}`, body);
  return true;
}

async function removeTags(contactId, tags) {
  if (!tags.length) return;
  if (DRY_RUN) return;
  await ghlFetch('DELETE', `/contacts/${contactId}/tags`, { tags });
}

async function addTags(contactId, tags) {
  if (!tags.length) return;
  if (DRY_RUN) return;
  await ghlFetch('POST', `/contacts/${contactId}/tags`, { tags });
}

// ─── 1. Victor Lopez ────────────────────────────────────────────────────

async function remediateVictor() {
  console.log(`\n═══ Victor Lopez (${VICTOR_ID}) ═══`);
  const contact = await getLiveContact(VICTOR_ID);
  if (!contact) {
    record(VICTOR_ID, 'error', 'contact not found live');
    return;
  }

  // Name was fixed manually on 2026-07-04 — verify, never touch.
  if (isPlaceholderName([contact.firstName, contact.lastName].filter(Boolean).join(' '))) {
    record(VICTOR_ID, 'warn', 'name still placeholder?! skipping name per handoff — investigate');
  } else {
    record(VICTOR_ID, 'name_ok', `${contact.firstName} ${contact.lastName} (already fixed — untouched)`);
  }

  // Address — fill-if-empty only.
  const addr = {};
  if (!contact.address1) addr.address1 = '2885 S Oasis Dr';
  if (!contact.city) addr.city = 'Boynton Beach';
  if (!contact.state) addr.state = 'FL';
  // Zip was never provided in the transcript — resolved via the Census
  // geocoder (street-level, single unambiguous match only; never from city).
  if (!contact.postalCode) {
    const geo = await geocodeStreetToZip(contact.address1 || '2885 S Oasis Dr', {
      city: contact.city || 'Boynton Beach',
      state: contact.state || 'FL',
    });
    if (geo?.zip) addr.postalCode = geo.zip;
    else record(VICTOR_ID, 'zip_unresolved', 'geocoder had no unambiguous match — ask the customer');
  }
  if (Object.keys(addr).length) {
    await putStandardFields(VICTOR_ID, addr);
    record(VICTOR_ID, 'address_set', JSON.stringify(addr));
    await logRemediation(VICTOR_ID, 'address_set', addr);
  } else {
    record(VICTOR_ID, 'address_ok', 'already populated');
  }

  // Jul 5 appointment → status "new" if currently confirmed.
  try {
    const res = await ghlFetch('GET', `/contacts/${VICTOR_ID}/appointments`);
    const events = res?.events || res?.appointments || [];
    const jul5 = events.filter((a) => String(a?.startTime || '').startsWith('2026-07-05'));
    if (!jul5.length) record(VICTOR_ID, 'appointment_not_found', 'no Jul 5 appointment on record');
    for (const appt of jul5) {
      const status = String(appt.appointmentStatus || appt.status || '').toLowerCase();
      if (status === 'confirmed') {
        if (!DRY_RUN) await ghlFetch('PUT', `/calendars/events/appointments/${appt.id}`, { appointmentStatus: 'new' });
        record(VICTOR_ID, 'appointment_downgraded', `${appt.id} confirmed → new (wife confirmation pending)`);
        await logRemediation(VICTOR_ID, 'appointment_downgraded', { appointment_id: appt.id, from: 'confirmed', to: 'new' });
      } else {
        record(VICTOR_ID, 'appointment_ok', `${appt.id} status=${status || 'unknown'} (left as-is)`);
      }
    }
  } catch (err) {
    record(VICTOR_ID, 'error', `appointment lookup failed: ${err.message}`);
  }

  // Tag cleanup: malformed empty-value tag + stacked bj stage (keep stage-5).
  const tags = Array.isArray(contact.tags) ? contact.tags : [];
  const toRemove = [];
  if (tags.includes('concern-expressed:')) toRemove.push('concern-expressed:');
  if (tags.includes('bj:stage-4-negotiating') && tags.includes('bj:stage-5-committed')) {
    toRemove.push('bj:stage-4-negotiating');
  }
  if (toRemove.length) {
    await removeTags(VICTOR_ID, toRemove);
    record(VICTOR_ID, 'tags_removed', toRemove.join(', '));
    await logRemediation(VICTOR_ID, 'tags_removed', { tags: toRemove });
  } else {
    record(VICTOR_ID, 'tags_ok', 'no malformed/stacked tags found');
  }
}

// ─── 2. Guest-visitor sweep (HL contacts cache → live verify → fix) ────

function hlSupabase() {
  const url = process.env.HL_SUPABASE_URL;
  const key = process.env.HL_SUPABASE_SERVICE_ROLE_KEY || process.env.HL_SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

async function sweepGuestVisitors() {
  const hl = hlSupabase();
  if (!hl) {
    console.log('\n═══ Sweep skipped: HL_SUPABASE_URL / HL_SUPABASE_SERVICE_ROLE_KEY not set ═══');
    return;
  }
  console.log(`\n═══ Guest-visitor sweep (cache candidates, live-verified, limit ${LIMIT}) ═══`);

  // Cache schema uses first_name/last_name (verified 2026-07-04 — there is
  // no contact_name column). The widget writes the placeholder either whole
  // into first_name ("Guest Visitor bljpx") or split ("Guest" / "Visitor x").
  const { data, error } = await hl
    .from('contacts')
    .select('ghl_contact_id, first_name, last_name, tags')
    .or('first_name.ilike.guest visitor%,and(first_name.ilike.guest,last_name.ilike.visitor%)')
    .is('deleted_at', null)
    .limit(LIMIT);
  if (error) {
    console.error(`  cache query failed: ${error.message}`);
    return;
  }
  console.log(`  ${data.length} cache candidate(s)`);

  for (const row of data) {
    const contactId = row.ghl_contact_id;
    if (!contactId || contactId === VICTOR_ID) continue;
    await sleep(INTER_CONTACT_DELAY_MS);

    let contact;
    try {
      contact = await getLiveContact(contactId); // forceLive — cache is only a candidate list
    } catch (err) {
      record(contactId, 'error', `live read failed: ${err.message}`);
      continue;
    }
    if (!contact) { record(contactId, 'skipped', 'not found live (deleted?)'); continue; }

    const liveName = [contact.firstName, contact.lastName].filter(Boolean).join(' ');
    const tags = Array.isArray(contact.tags) ? contact.tags : [];

    // Empty-value tags (trailing colon) — always cleaned.
    const emptyValueTags = tags.filter((t) => typeof t === 'string' && t.trim().endsWith(':'));
    if (emptyValueTags.length) {
      await removeTags(contactId, emptyValueTags);
      record(contactId, 'empty_tags_removed', emptyValueTags.join(', '));
      await logRemediation(contactId, 'empty_tags_removed', { tags: emptyValueTags });
    }

    if (!isPlaceholderName(liveName)) {
      // Already fixed live — clear the placeholder marker if it lingers.
      if (tags.includes(NAME_PLACEHOLDER_TAG)) {
        await removeTags(contactId, [NAME_PLACEHOLDER_TAG]);
        record(contactId, 'placeholder_tag_cleared', `real name "${liveName}" already on record`);
        await logRemediation(contactId, 'placeholder_tag_cleared', { name: liveName });
      } else {
        record(contactId, 'skipped', `real name "${liveName}" already on record`);
      }
      continue;
    }

    // Placeholder name live — try extraction from the chat transcript field.
    const transcript = readCustomField(contact, TRANSCRIPT_FIELD_ID);
    const extracted = transcript ? heuristicExtract([{ direction: 'inbound', text: transcript }]) : null;

    if (extracted?.first_name) {
      // Street extracted but no zip → try the Census geocoder (street-level
      // only, single unambiguous match; never inferred from city).
      if (extracted.address_line1 && !extracted.postal_code && !contact.postalCode) {
        const geo = await geocodeStreetToZip(extracted.address_line1, {
          city: extracted.city || contact.city,
          state: extracted.state || contact.state || 'FL',
        });
        if (geo?.zip) extracted.postal_code = geo.zip;
      }
      const { payload } = buildPromotionPayload(contact, { ...extracted, _source: {
        first_name: 'extracted', last_name: 'extracted', phone: 'extracted', email: 'extracted',
        address_line1: 'extracted', city: 'extracted', state: 'extracted', postal_code: 'extracted',
      } });
      if (Object.keys(payload).length) {
        await putStandardFields(contactId, payload);
        record(contactId, 'promoted', Object.entries(payload).map(([k, v]) => `${k}=${v}`).join(', '));
        await logRemediation(contactId, 'promoted', payload);
        if (tags.includes(NAME_PLACEHOLDER_TAG)) await removeTags(contactId, [NAME_PLACEHOLDER_TAG]);
      }
    } else if (!tags.includes(NAME_PLACEHOLDER_TAG)) {
      await addTags(contactId, [NAME_PLACEHOLDER_TAG]);
      record(contactId, 'tagged_placeholder', transcript ? 'no name in transcript' : 'no transcript field');
      await logRemediation(contactId, 'tagged_placeholder', {});
    } else {
      record(contactId, 'skipped', 'already tagged name-placeholder, no name extractable');
    }
  }
}

// ─── main ───────────────────────────────────────────────────────────────

console.log(`Guest-visitor remediation ${DRY_RUN ? '(DRY RUN — no writes)' : '(LIVE)'}`);

if (!SKIP_VICTOR) await remediateVictor();
await sweepGuestVisitors();

console.log('\n═══ SUMMARY ═══');
console.log('contact_id                     | action                   | detail');
console.log('-------------------------------+--------------------------+----------------------------------------');
for (const row of summary) {
  console.log(`${row.contact_id.padEnd(30)} | ${row.action.padEnd(24)} | ${row.detail}`);
}
console.log(`\n${summary.length} action(s)${DRY_RUN ? ' (dry run — nothing written)' : ''}.`);
process.exit(0);
