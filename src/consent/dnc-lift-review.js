/**
 * request_dnc_lift_review — src/consent/dnc-lift-review.js
 *
 * Consent Model v1 (2026-09-28). Asks a PERSON whether a blocked lead may be
 * lifted: posts a contact summary to the n8n workflow "OPS.DNC-LIFT Slack
 * Approval" (N8N_DNC_LIFT_REVIEW_WEBHOOK), which puts an Approve / Keep Blocked
 * card in #dnc-lift-approval. The click comes back to
 * POST /slack/dnc-lift/decision (./dnc-lift-decision.js).
 *
 * Queued by DNC_LIFT_REVIEW_REQUEST (manual `dnc-lift:request` tag) and
 * DNC_LIFT_REVIEW_REQUEST_REENTRY (a re-entry the first-party auto-lift does
 * not own). requires_approval false — it only asks; it changes nothing.
 *
 * What this handler enforces itself, because the rule engine has no operator
 * for it:
 *   - not already reviewed in the last 24h: a dnc_lift_requests row for this
 *     contact younger than 24h (other than a 'failed' one) → skip.
 *   - not a first-party re-entry: a contact still carrying
 *     consent:new-submission and no contact-initiated STOP is DNC_LIFT_ON_REENTRY_E0's
 *     to lift automatically → skip, so a person is never asked to approve what
 *     already happened.
 *
 * The request row is written BEFORE the POST: its request_id is what the
 * Slack buttons carry back, and the decision route only accepts a request_id
 * this service issued for the same contact. If the POST fails the row is
 * marked 'failed' (so the 24h check ignores it) and the action throws, so the
 * executor retries with a fresh request id.
 *
 * Unset N8N_DNC_LIFT_REVIEW_WEBHOOK is a FAILURE, not a skip: a card that
 * silently never appears looks exactly like a quiet day (CLAUDE.md).
 */

import crypto from 'node:crypto';
import supabase from '../supabase.js';
import { ghlFetch } from '../actions/helpers.js';
import { getConsent, detectCarrierStop, blockingTags, isMissingSchemaError } from './consent-store.js';

export const REVIEW_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const FIRST_PARTY_CONSENT_TAG = 'consent:new-submission';
const CONTACT_INITIATED_STOP_TAGS = ['suppress:dnc-reply', 'suppress:dnc-voice'];
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';

// The exact sentence the handoff asked the card to carry. n8n prints it as-is.
export const SMS_CARRIER_STOP_WARNING =
  'This lead texted STOP. Approving restores calls only. Texts stay off until they text START or submit a new form with SMS consent.';

export function phoneLast4(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** First tag with the prefix, minus the prefix. Pure. */
function tagSuffix(tags, prefix) {
  const t = (tags || []).find((x) => String(x || '').toLowerCase().startsWith(prefix));
  return t ? String(t).slice(prefix.length) : null;
}

/**
 * Should this contact be sent to a person at all? Pure.
 * @returns {{ask:boolean, reason:string}}
 */
export function decideReviewEligibility({ tags, recentRequest }) {
  const lower = (tags || []).map((t) => String(t || '').toLowerCase());
  if (blockingTags(tags).length === 0) return { ask: false, reason: 'not_blocked' };
  const hasStop = CONTACT_INITIATED_STOP_TAGS.some((t) => lower.includes(t));
  if (lower.includes(FIRST_PARTY_CONSENT_TAG) && !hasStop) {
    return { ask: false, reason: 'first_party_auto_lift_owns_it' };
  }
  if (recentRequest) return { ask: false, reason: 'reviewed_within_24h' };
  return { ask: true, reason: 'ok' };
}

/**
 * The payload n8n turns into the Slack card. Pure — everything it needs is
 * passed in, so the card's content is unit-tested.
 */
export function buildReviewPayload({ requestId, contactId, contact, context = {}, trigger, consentRead, carrier, reenteredAt }) {
  const tags = contact?.tags || [];
  const name = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim()
    || contact?.contactName || contact?.name || 'Unknown';
  const attribution = Array.isArray(contact?.attributions) ? contact.attributions[0] : null;
  return {
    request_id: requestId,
    ghl_contact_id: contactId,
    contact_name: name,
    phone_last4: phoneLast4(contact?.phone),
    source: contact?.source || tagSuffix(tags, 'entry:') || null,
    sub_source: tagSuffix(tags, 'active-entry:') || attribution?.utmSource || context?.source || null,
    reentered_at: reenteredAt,
    trigger,
    blocking_tags: blockingTags(tags),
    sms_carrier_stop: carrier.carrierStop,
    carrier_stop_basis: carrier.basis,
    sms_warning: carrier.carrierStop ? SMS_CARRIER_STOP_WARNING : null,
    consent: consentRead?.consent || null,
    consent_read_status: consentRead?.status || 'error',
    last_consent_events: consentRead?.events || [],
    ghl_contact_url: `https://app.gohighlevel.com/v2/location/${GHL_LOCATION_ID}/contacts/detail/${contactId}`,
  };
}

export async function executeRequestDncLiftReview(action, context = {}, deps = {}) {
  const env = deps.env || process.env;
  const db = deps.supabase || supabase;
  const now = deps.now ? deps.now() : Date.now();
  const contactId = action.target_id;
  if (!contactId) throw new Error('request_dnc_lift_review requires action.target_id');
  const webhook = String(env.N8N_DNC_LIFT_REVIEW_WEBHOOK || '').trim();
  if (!webhook) throw new Error('request_dnc_lift_review: N8N_DNC_LIFT_REVIEW_WEBHOOK is not set — no review card can be posted');

  const readContact = deps.readContact || (async (id) => (await ghlFetch('GET', `/contacts/${id}`))?.contact || null);
  const contact = await readContact(contactId);
  if (!contact) throw new Error(`request_dnc_lift_review: GHL contact ${contactId} could not be read`);

  const since = new Date(now - REVIEW_COOLDOWN_MS).toISOString();
  const recent = await db.from('dnc_lift_requests')
    .select('request_id, status, requested_at')
    .eq('ghl_contact_id', contactId)
    .neq('status', 'failed')
    .gte('requested_at', since)
    .limit(1);
  if (recent.error) {
    if (isMissingSchemaError(recent.error)) {
      throw new Error('request_dnc_lift_review: dnc_lift_requests is missing — apply sql/140 before asking for reviews');
    }
    throw new Error(`request_dnc_lift_review: 24h check failed: ${recent.error.message}`);
  }

  const verdict = decideReviewEligibility({ tags: contact.tags, recentRequest: (recent.data || [])[0] || null });
  if (!verdict.ask) {
    console.log(`[DncLiftReview] not asking for ${contactId}: ${verdict.reason}`);
    return { action: 'skipped', skipped: true, reason: verdict.reason };
  }

  const consentRead = await (deps.getConsent || getConsent)(contactId, { supabase: db, eventLimit: 5 });
  const carrier = detectCarrierStop({ consent: consentRead.consent, tags: contact.tags, dndSettings: contact.dndSettings });
  const requestId = deps.newRequestId ? deps.newRequestId() : `dnc-lift-${crypto.randomUUID()}`;
  const trigger = action.action_payload?.trigger || (context?.source === 'reentry' ? 'reentry' : 'manual_tag');
  const payload = buildReviewPayload({
    requestId, contactId, contact, context, trigger, consentRead, carrier,
    reenteredAt: context?.occurred_at || action.created_at || new Date(now).toISOString(),
  });

  const ins = await db.from('dnc_lift_requests').insert({
    request_id: requestId,
    ghl_contact_id: contactId,
    status: 'awaiting_decision',
    review_payload: payload,
  });
  if (ins.error) throw new Error(`request_dnc_lift_review: could not record request: ${ins.error.message}`);

  const doFetch = deps.fetch || fetch;
  let res;
  try {
    res = await doFetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    res = { ok: false, status: 0, _err: err.message };
  }
  if (!res.ok) {
    await db.from('dnc_lift_requests').update({ status: 'failed', completed_at: new Date(now).toISOString() })
      .eq('request_id', requestId);
    throw new Error(`request_dnc_lift_review: n8n webhook returned ${res.status}${res._err ? ` (${res._err})` : ''}`);
  }

  console.log(`[DncLiftReview] review card requested for ${contactId} (request ${requestId}, carrier_stop=${carrier.carrierStop})`);
  return {
    action: 'review_requested',
    request_id: requestId,
    sms_carrier_stop: carrier.carrierStop,
    blocking_tags: payload.blocking_tags,
  };
}
