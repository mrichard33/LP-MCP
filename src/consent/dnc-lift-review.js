/**
 * request_dnc_lift_review — src/consent/dnc-lift-review.js
 *
 * Consent Model v1 (2026-09-28). Asks a PERSON whether a blocked lead may be
 * lifted: posts a contact summary to the n8n workflow "OPS.DNC-LIFT Slack
 * Approval" (N8N_DNC_LIFT_REVIEW_WEBHOOK), which puts an Approve / Keep Blocked
 * card in #dnc-lift-approval. The click comes back to
 * POST /slack/dnc-lift/decision (./dnc-lift-decision.js).
 *
 * Queued by DNC_LIFT_REVIEW_REQUEST (manual `dnc-lift:request` tag),
 * DNC_LIFT_REVIEW_REQUEST_REENTRY (a re-entry the first-party auto-lift does
 * not own), POST /webhook/ap/dnc-reentry, and the DNC re-entry sweep
 * (src/jobs/dnc-reentry-sweep.js — a new LP lead for a blocked number).
 * requires_approval false — it only asks; it changes nothing.
 *
 * "Blocked" is not only a GHL tag (2026-10-01). 68 of 73 returning leads whose
 * number sat on Five9's DNC list in one week carried no DNC tag and no consent
 * row — the block predates the consent model and lives only in the dialer. A
 * tag-only check called every one of them "not blocked", so no card ever
 * posted. The handler therefore also counts the consent record and, when
 * neither shows a block, Five9's DNC list.
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
import { normalizePhone10 } from '../lead-leak-classify.js';

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
export function decideReviewEligibility({ tags, recentRequest, blockedElsewhere = [] }) {
  const lower = (tags || []).map((t) => String(t || '').toLowerCase());
  if (blockingTags(tags).length === 0 && blockedElsewhere.length === 0) return { ask: false, reason: 'not_blocked' };
  const hasStop = CONTACT_INITIATED_STOP_TAGS.some((t) => lower.includes(t));
  if (lower.includes(FIRST_PARTY_CONSENT_TAG) && !hasStop) {
    return { ask: false, reason: 'first_party_auto_lift_owns_it' };
  }
  if (recentRequest) return { ask: false, reason: 'reviewed_within_24h' };
  return { ask: true, reason: 'ok' };
}

// Labels for a block that is not a GHL tag. n8n prints blocking_tags as the
// card's "Blocked by:" line, so these ride along there (readable as-is) — the
// live card needs no n8n change to show them.
export const BLOCKED_IN_CONSENT = 'consent record: calls + texts off';
export const BLOCKED_IN_FIVE9 = 'Five9 DNC list';

/** Blocks the consent record shows. Pure. */
export function consentBlocks(consentRead) {
  const c = consentRead?.status === 'ok' ? consentRead.consent : null;
  if (!c) return [];
  return c.dnc_full === true || c.phone_consent === 'revoked' || c.sms_carrier_stop === true ? [BLOCKED_IN_CONSENT] : [];
}

/**
 * The payload n8n turns into the Slack card. Pure — everything it needs is
 * passed in, so the card's content is unit-tested.
 */
export function buildReviewPayload({ requestId, contactId, contact, context = {}, trigger, consentRead, carrier, reenteredAt, vendor = null, leadSource = null, blockedElsewhere = [] }) {
  const tags = contact?.tags || [];
  const name = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim()
    || contact?.contactName || contact?.name || 'Unknown';
  const attribution = Array.isArray(contact?.attributions) ? contact.attributions[0] : null;
  return {
    request_id: requestId,
    ghl_contact_id: contactId,
    contact_name: name,
    phone_last4: phoneLast4(contact?.phone),
    // An ActiveProspect re-entry names the channel and the vendor that just
    // sent the lead — the contact's own source is from whenever it FIRST
    // arrived, which is not what the reviewer is deciding on.
    // The re-entry sweep names the NEW lead's LP source and vendor, for the
    // same reason.
    source: trigger === 'activeprospect' ? 'ActiveProspect'
      : (leadSource || contact?.source || tagSuffix(tags, 'entry:') || null),
    sub_source: trigger === 'activeprospect' || leadSource
      ? (vendor || null)
      : (tagSuffix(tags, 'active-entry:') || attribution?.utmSource || context?.source || null),
    reentered_at: reenteredAt,
    trigger,
    vendor: vendor || null,
    blocking_tags: [...blockingTags(tags), ...blockedElsewhere],
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

  const consentRead = await (deps.getConsent || getConsent)(contactId, { supabase: db, eventLimit: 5 });
  const blockedElsewhere = consentBlocks(consentRead);
  // Five9 is read only when neither the tags nor the consent record show a
  // block: that is the case the tag-only check got wrong, and it keeps one
  // SOAP call off every ordinary card.
  if (blockingTags(contact.tags).length === 0 && blockedElsewhere.length === 0) {
    const phone10 = normalizePhone10(contact.phone);
    if (phone10) {
      const checkDnc = deps.checkDnc || (await import('../five9-admin.js')).checkDncForNumbers;
      let res;
      try {
        res = await checkDnc([phone10]);
      } catch (err) {
        // Could not tell — throw so the executor retries, rather than calling
        // a lead "not blocked" on a failed read.
        throw new Error(`request_dnc_lift_review: Five9 DNC check failed for ${contactId}: ${err.message}`);
      }
      if ((res?.on_dnc || []).includes(phone10)) blockedElsewhere.push(BLOCKED_IN_FIVE9);
    }
  }

  const verdict = decideReviewEligibility({ tags: contact.tags, recentRequest: (recent.data || [])[0] || null, blockedElsewhere });
  if (!verdict.ask) {
    console.log(`[DncLiftReview] not asking for ${contactId}: ${verdict.reason}`);
    return { action: 'skipped', skipped: true, reason: verdict.reason };
  }

  const carrier = detectCarrierStop({ consent: consentRead.consent, tags: contact.tags, dndSettings: contact.dndSettings });
  const requestId = deps.newRequestId ? deps.newRequestId() : `dnc-lift-${crypto.randomUUID()}`;
  const trigger = action.action_payload?.trigger || (context?.source === 'reentry' ? 'reentry' : 'manual_tag');
  const payload = buildReviewPayload({
    requestId, contactId, contact, context, trigger, consentRead, carrier,
    reenteredAt: context?.occurred_at || action.created_at || new Date(now).toISOString(),
    vendor: action.action_payload?.vendor || null,
    leadSource: action.action_payload?.lead_source || null,
    blockedElsewhere,
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
      headers: {
        'Content-Type': 'application/json',
        // The same shared secret the decision route checks, so n8n can refuse
        // a review request that did not come from here. Unset = not sent.
        ...(env.DNC_LIFT_WEBHOOK_SECRET ? { 'X-DNC-Lift-Secret': String(env.DNC_LIFT_WEBHOOK_SECRET) } : {}),
      },
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

// ─── ActiveProspect re-entry → review (2026-09-28) ───────────────────────────
//
// POST /webhook/ap/dnc-reentry — called by n8n I.AP (YOozjkCkeNEe4s3a) on its
// "link" branch: an ActiveProspect lead whose phone matched a contact already
// in GHL. Before this, that branch only added an intake note, so a DNC lead
// who came back through a purchased/exclusive-consent source never reached a
// person — no event, no tag, nothing the rules could see. E.0's `reentry`
// event only covers first-party consent (DNC_LIFT_ON_REENTRY_E0 owns those).
//
// It only ASKS. It queues one request_dnc_lift_review (rule_applied
// AP_DNC_REENTRY); that handler still re-reads the contact live, skips a
// contact reviewed in the last 24h, and skips one E0 lifts on its own.
//
// "Is this contact blocked?" is answered from our own tables — no GHL call on
// every purchased lead. When neither can be read, it queues anyway: the cost
// of asking is one card a person dismisses; the cost of not asking is a lead
// nobody is told about. The handler's live read drops it if it isn't blocked.
//
// Auth: the same fail-closed X-DNC-Lift-Secret as /slack/dnc-lift/decision.

export const AP_DNC_REENTRY_RULE_KEY = 'AP_DNC_REENTRY';
const GHL_CONTACT_ID_RE = /^[A-Za-z0-9]{10,40}$/;

/** Blocked per our own records? true / false / null (could not tell). Pure. */
export function isBlockedPerRecords({ consentRead, snapshotTags }) {
  const c = consentRead?.status === 'ok' ? consentRead.consent : null;
  if (c && (c.dnc_full === true || c.phone_consent === 'revoked' || c.sms_carrier_stop === true)) return true;
  if (Array.isArray(snapshotTags) && blockingTags(snapshotTags).length > 0) return true;
  const consentKnown = consentRead?.status === 'ok';
  const snapshotKnown = Array.isArray(snapshotTags);
  return consentKnown || snapshotKnown ? false : null;
}

export async function handleApDncReentry({ body = {}, headers = {} }, deps = {}) {
  const env = deps.env || process.env;
  const db = deps.supabase || supabase;
  const { checkDncLiftSecret } = await import('./dnc-lift-decision.js');
  const auth = checkDncLiftSecret(headers, env.DNC_LIFT_WEBHOOK_SECRET);
  if (!auth.ok) return { status: auth.reason === 'secret_not_configured' ? 503 : 401, json: { ok: false, error: auth.reason } };

  const contactId = typeof body.contactId === 'string' ? body.contactId.trim() : '';
  if (!GHL_CONTACT_ID_RE.test(contactId)) return { status: 400, json: { ok: false, error: 'contactId is required' } };
  const vendor = typeof body.vendor === 'string' && body.vendor.trim() ? body.vendor.trim().slice(0, 120) : null;
  const leadId = body.lead_id != null && String(body.lead_id).trim() ? String(body.lead_id).trim().slice(0, 80) : null;

  const [consentRead, snap] = await Promise.all([
    (deps.getConsent || getConsent)(contactId, { supabase: db, eventLimit: 1 }),
    // null = could not read; [] = read fine, contact has no snapshot row.
    db.from('contact_tag_snapshot').select('tags').eq('ghl_contact_id', contactId).maybeSingle()
      .then((r) => (r.error ? null : (r.data?.tags || [])), () => null),
  ]);
  const blocked = isBlockedPerRecords({ consentRead, snapshotTags: snap });
  if (blocked === false) {
    // Logged (2026-10-01): six calls in two days came back not_blocked with no
    // trace anywhere, and nobody could tell which contacts I.AP had sent. The
    // DNC re-entry sweep re-checks the same lead against Five9 once it is in LP.
    console.log(`[DncLiftReview] ActiveProspect re-entry for ${contactId}${vendor ? ` (${vendor})` : ''} — not blocked per our records; the re-entry sweep checks Five9`);
    return { status: 200, json: { ok: true, skipped: 'not_blocked' } };
  }

  // One queued ask per contact at a time: a vendor that re-sends the same lead
  // twice in a minute must not produce two cards before the first request row
  // (the handler's 24h record) exists.
  const since = new Date((deps.now ? deps.now() : Date.now()) - REVIEW_COOLDOWN_MS).toISOString();
  const dupe = await db.from('agent_actions').select('id')
    .eq('action_type', 'request_dnc_lift_review').eq('target_id', contactId)
    .in('status', ['pending', 'executing']).gte('created_at', since).limit(1);
  if (!dupe.error && (dupe.data || []).length) {
    return { status: 200, json: { ok: true, skipped: 'already_queued', action_id: dupe.data[0].id } };
  }

  const ins = await db.from('agent_actions').insert({
    action_type: 'request_dnc_lift_review',
    target_system: 'lp',
    target_entity: 'contact',
    target_id: contactId,
    action_payload: { trigger: 'activeprospect', vendor, lead_id: leadId },
    rule_applied: AP_DNC_REENTRY_RULE_KEY,
    reasoning: `ActiveProspect delivered a lead${vendor ? ` from ${vendor}` : ''} for a contact on DNC — asking a person in #dnc-lift-approval`,
    status: 'pending',
    requires_approval: false,
    priority: 20,
  }).select('id').single();
  if (ins.error) return { status: 500, json: { ok: false, error: `could not queue the review: ${ins.error.message}` } };

  console.log(`[DncLiftReview] ActiveProspect re-entry for ${contactId}${vendor ? ` (${vendor})` : ''} — review queued (action ${ins.data.id}, blocked=${blocked === null ? 'unknown' : 'yes'})`);
  return { status: 200, json: { ok: true, queued: true, action_id: ins.data.id, blocked: blocked === null ? 'unknown' : true } };
}

export function registerApDncReentryRoutes(app) {
  app.post('/webhook/ap/dnc-reentry', async (req, res) => {
    const out = await handleApDncReentry({ body: req.body || {}, headers: req.headers || {} })
      .catch((err) => ({ status: 500, json: { ok: false, error: err.message } }));
    res.status(out.status).json(out.json);
  });
}
