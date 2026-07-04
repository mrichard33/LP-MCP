/**
 * Guest-visitor remediation — shared core + admin HTTP routes
 *
 *   POST /admin/remediate-guest-visitors        { dry_run?, limit?, skip_victor? }
 *   GET  /admin/remediate-guest-visitors/:jobId
 *
 * Mirrors scripts/remediate-guest-visitors.js (the CLI wraps this module) —
 * exposed over HTTP so the one-time sweep can run on Railway without shell
 * access, same pattern as admin/agentic-lead-states.js. See BUILD HANDOFF
 * v1.1 §4.6 (Victor Lopez incident, GHL XdAUR9qR42UdBre6Byrw, 2026-07-04).
 *
 * What it does:
 *   1. Victor Lopez: address fill-if-empty (street/city/state; zip via the
 *      Census geocoder, single unambiguous match only), Jul 5 appointment
 *      confirmed→new if one exists, malformed `concern-expressed:` +
 *      stacked `bj:stage-4-negotiating` removed.
 *   2. Sweep: HL contacts cache candidates (first_name/last_name split OR
 *      whole-in-first placeholder), each re-read LIVE before any mutation.
 *      Transcript-extractable names are promoted (placeholder rule, via
 *      buildPromotionPayload — payload can never carry a tags key);
 *      otherwise the contact is tagged `name-placeholder`. Any tag ending
 *      in ':' is removed.
 *   3. Every mutation logs system_events `remediation.guest_visitor`.
 *
 * Safety: all GHL writes go through ghlFetch (token-bucket limiter) plus a
 * 600ms inter-contact delay; dry_run previews every planned mutation.
 */

import { createClient } from '@supabase/supabase-js';
import { ghlFetch } from '../actions/helpers.js';
import { emitEvent } from '../event-emitter.js';
import {
  isPlaceholderName,
  heuristicExtract,
  buildPromotionPayload,
  geocodeStreetToZip,
  NAME_PLACEHOLDER_TAG,
} from '../services/identity-extraction.js';

export const VICTOR_ID = 'XdAUR9qR42UdBre6Byrw';
const TRANSCRIPT_FIELD_ID = 'RF710H9k39oLl9TsQIy4';
const INTER_CONTACT_DELAY_MS = 600; // ≤ 2 req/sec pacing on top of the token bucket
// Cohort measured 2026-07-04: 484 cache candidates (116 whole-in-first +
// 368 split first/last) — default covers the full set in one run.
const DEFAULT_LIMIT = 600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hlSupabase() {
  const url = process.env.HL_SUPABASE_URL;
  const key = process.env.HL_SUPABASE_SERVICE_ROLE_KEY || process.env.HL_SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
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

/**
 * Run the full remediation. Returns { dry_run, actions, counts }.
 * `onProgress(action)` fires per recorded action (used by the HTTP job).
 */
export async function runGuestVisitorRemediation({
  dryRun = false,
  limit = DEFAULT_LIMIT,
  skipVictor = false,
  onProgress = null,
} = {}) {
  const actions = [];

  const record = (contactId, action, detail = '') => {
    const entry = { contact_id: contactId, action, detail };
    actions.push(entry);
    console.log(`[GuestVisitorRemediation] ${dryRun ? '[DRY] ' : ''}${contactId} — ${action}${detail ? `: ${detail}` : ''}`);
    try { onProgress?.(entry); } catch { /* progress is best-effort */ }
  };

  const logRemediation = async (contactId, action, payload) => {
    if (dryRun) return;
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
      console.warn(`[GuestVisitorRemediation] event log failed for ${contactId}/${action}: ${err.message}`);
    }
  };

  /** PUT standard fields only — allowlisted body, never a tags key. */
  const putStandardFields = async (contactId, fields) => {
    const ALLOW = ['firstName', 'lastName', 'email', 'phone', 'address1', 'city', 'state', 'postalCode'];
    const body = {};
    for (const k of ALLOW) {
      if (fields[k] !== undefined && fields[k] !== null) body[k] = fields[k];
    }
    if ('tags' in fields) throw new Error('tags key in standard-field payload — refusing (tag-wipe hazard)');
    if (Object.keys(body).length === 0) return false;
    if (dryRun) return true;
    await ghlFetch('PUT', `/contacts/${contactId}`, body);
    return true;
  };

  const removeTags = async (contactId, tags) => {
    if (!tags.length || dryRun) return;
    await ghlFetch('DELETE', `/contacts/${contactId}/tags`, { tags });
  };

  const addTags = async (contactId, tags) => {
    if (!tags.length || dryRun) return;
    await ghlFetch('POST', `/contacts/${contactId}/tags`, { tags });
  };

  // ─── 1. Victor Lopez ──────────────────────────────────────────────

  if (!skipVictor) {
    try {
      const contact = await getLiveContact(VICTOR_ID);
      if (!contact) {
        record(VICTOR_ID, 'error', 'contact not found live');
      } else {
        if (isPlaceholderName([contact.firstName, contact.lastName].filter(Boolean).join(' '))) {
          record(VICTOR_ID, 'warn', 'name still placeholder?! skipping name per handoff — investigate');
        } else {
          record(VICTOR_ID, 'name_ok', `${contact.firstName} ${contact.lastName} (already fixed — untouched)`);
        }

        const addr = {};
        if (!contact.address1) addr.address1 = '2885 S Oasis Dr';
        if (!contact.city) addr.city = 'Boynton Beach';
        if (!contact.state) addr.state = 'FL';
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

        try {
          const res = await ghlFetch('GET', `/contacts/${VICTOR_ID}/appointments`);
          const events = res?.events || res?.appointments || [];
          const jul5 = events.filter((a) => String(a?.startTime || '').startsWith('2026-07-05'));
          if (!jul5.length) record(VICTOR_ID, 'appointment_not_found', 'no Jul 5 appointment on record');
          for (const appt of jul5) {
            const status = String(appt.appointmentStatus || appt.status || '').toLowerCase();
            if (status === 'confirmed') {
              if (!dryRun) await ghlFetch('PUT', `/calendars/events/appointments/${appt.id}`, { appointmentStatus: 'new' });
              record(VICTOR_ID, 'appointment_downgraded', `${appt.id} confirmed → new (wife confirmation pending)`);
              await logRemediation(VICTOR_ID, 'appointment_downgraded', { appointment_id: appt.id, from: 'confirmed', to: 'new' });
            } else {
              record(VICTOR_ID, 'appointment_ok', `${appt.id} status=${status || 'unknown'} (left as-is)`);
            }
          }
        } catch (err) {
          record(VICTOR_ID, 'error', `appointment lookup failed: ${err.message}`);
        }

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
    } catch (err) {
      record(VICTOR_ID, 'error', err.message);
    }
  }

  // ─── 2. Guest-visitor sweep ───────────────────────────────────────

  const hl = hlSupabase();
  if (!hl) {
    record('-', 'sweep_skipped', 'HL_SUPABASE_URL / HL_SUPABASE_SERVICE_ROLE_KEY not set');
  } else {
    // Cache schema uses first_name/last_name (verified 2026-07-04 — there is
    // no contact_name column). The widget writes the placeholder either whole
    // into first_name ("Guest Visitor bljpx") or split ("Guest" / "Visitor x").
    const { data, error } = await hl
      .from('contacts')
      .select('ghl_contact_id, first_name, last_name, tags')
      .or('first_name.ilike.guest visitor%,and(first_name.ilike.guest,last_name.ilike.visitor%)')
      .is('deleted_at', null)
      .limit(limit);

    if (error) {
      record('-', 'sweep_error', `cache query failed: ${error.message}`);
    } else {
      console.log(`[GuestVisitorRemediation] ${data.length} cache candidate(s), limit ${limit}`);
      for (const row of data) {
        const contactId = row.ghl_contact_id;
        if (!contactId || contactId === VICTOR_ID) continue;
        await sleep(INTER_CONTACT_DELAY_MS);

        let contact;
        try {
          contact = await getLiveContact(contactId); // live verify — cache is only a candidate list
        } catch (err) {
          record(contactId, 'error', `live read failed: ${err.message}`);
          continue;
        }
        if (!contact) { record(contactId, 'skipped', 'not found live (deleted?)'); continue; }

        const liveName = [contact.firstName, contact.lastName].filter(Boolean).join(' ');
        const tags = Array.isArray(contact.tags) ? contact.tags : [];

        const emptyValueTags = tags.filter((t) => typeof t === 'string' && t.trim().endsWith(':'));
        if (emptyValueTags.length) {
          await removeTags(contactId, emptyValueTags);
          record(contactId, 'empty_tags_removed', emptyValueTags.join(', '));
          await logRemediation(contactId, 'empty_tags_removed', { tags: emptyValueTags });
        }

        if (!isPlaceholderName(liveName)) {
          if (tags.includes(NAME_PLACEHOLDER_TAG)) {
            await removeTags(contactId, [NAME_PLACEHOLDER_TAG]);
            record(contactId, 'placeholder_tag_cleared', `real name "${liveName}" already on record`);
            await logRemediation(contactId, 'placeholder_tag_cleared', { name: liveName });
          } else {
            record(contactId, 'skipped', `real name "${liveName}" already on record`);
          }
          continue;
        }

        const transcript = readCustomField(contact, TRANSCRIPT_FIELD_ID);
        const extracted = transcript ? heuristicExtract([{ direction: 'inbound', text: transcript }]) : null;

        if (extracted?.first_name) {
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
  }

  const counts = actions.reduce((acc, a) => {
    acc[a.action] = (acc[a.action] || 0) + 1;
    return acc;
  }, {});

  return { dry_run: dryRun, total_actions: actions.length, counts, actions };
}

// ─── HTTP routes (background job + status, same shape as agentic-lead-states) ───

const jobs = new Map();

function generateJobId() {
  return `gvr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function registerGuestVisitorRemediationRoutes(app) {
  app.post('/admin/remediate-guest-visitors', (req, res) => {
    const body = req.body || {};
    const dryRun = body.dry_run === true;
    const limit = parseInt(body.limit, 10) || DEFAULT_LIMIT;
    const skipVictor = body.skip_victor === true;

    const jobId = generateJobId();
    const job = {
      id: jobId,
      status: 'running',
      dry_run: dryRun,
      limit,
      skip_victor: skipVictor,
      started_at: new Date().toISOString(),
      completed_at: null,
      progress: 0,
      last_action: null,
      result: null,
      error: null,
    };
    jobs.set(jobId, job);

    setImmediate(async () => {
      try {
        job.result = await runGuestVisitorRemediation({
          dryRun,
          limit,
          skipVictor,
          onProgress: (entry) => { job.progress += 1; job.last_action = entry; },
        });
        job.status = 'complete';
      } catch (err) {
        console.error('[GuestVisitorRemediation] job failed:', err.message);
        job.status = 'failed';
        job.error = err.message;
      } finally {
        job.completed_at = new Date().toISOString();
      }
    });

    return res.json({
      ok: true,
      mode: 'background',
      job_id: jobId,
      dry_run: dryRun,
      status_url: `/admin/remediate-guest-visitors/${jobId}`,
      message: 'Remediation running in background (~600ms per contact). Poll status_url.',
    });
  });

  app.get('/admin/remediate-guest-visitors/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      return res.status(404).json({
        ok: false,
        error: 'job_not_found',
        message: 'Job ID not recognized — may have been lost on server restart. Mutations already applied are durable; query system_events for remediation.guest_visitor rows.',
      });
    }
    return res.json({ ok: true, ...job });
  });

  console.log('[GuestVisitorRemediation] admin routes registered');
}
