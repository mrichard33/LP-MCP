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
import { getConsent, detectCarrierStop, blockingTags, isMissingSchemaError, recordConsentChange } from './consent-store.js';
import { normalizePhone10, contactRecordRows } from '../lead-leak-classify.js';
import { FIVE9_DNC_DISPOSITIONS } from './dnc-reentry.js';
import { lpLocalToUtcMs } from '../lead-speed.js';

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

/** "(954) 379-2151", or null when the phone is not a valid US 10-digit. Pure. */
export function formatPhoneFull(phone) {
  const p = normalizePhone10(phone);
  return p ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : null;
}

// ─── Pre-consent block history (2026-10-02) ─────────────────────────────────
// 30 of 32 review cards read "Recent consent history: none recorded yet". Every
// one was blocked only on Five9's DNC list, set before the consent model existed
// (2026-09-28), so consent_events has nothing to show. When it is empty the card
// gets what we CAN see instead: the last Five9 DNC result for the number, the
// last Five9 call, and LP's disposition. Each piece is best-effort — a lookup
// that fails or is slow is null, never a missing card.

export const LEGACY_BLOCK_NOTE = 'Blocked on Five9 DNC before the consent system (pre-2026-09-28)';
export const FIVE9_LEGACY_SOURCE = 'five9_legacy';
export const LP_PROSPECT_FIELD_ID = 'ZRQAVrzhtzApzLlHmT87';
// Every lookup is capped so a slow read costs one line, not the card.
export const LEGACY_LOOKUP_TIMEOUT_MS = 8000;

/** LP's "Unset" until the clear works (see .env.example). Pure. */
export function lpManualClearRequired(env = process.env) {
  return String(env.LP_DNC_CLEAR_WORKING || '').trim().toLowerCase() !== 'true';
}

function readCustomField(contact, fieldId) {
  const f = (contact?.customFields || []).find((x) => x && x.id === fieldId);
  const v = f?.value;
  return v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim();
}

function five9Entry(row) {
  if (!row) return null;
  return {
    name: row.disposition_name || null,
    date: row.call_end_at || row.call_start_at || row.created_at || null,
    agent: row.agent_name || null,
    campaign: row.campaign || null,
  };
}

/**
 * Newest Five9 DNC result and newest call of any kind, from
 * five9.disposition_set rows ordered newest first. Pure.
 */
export function pickFive9History(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const dnc = new Set(FIVE9_DNC_DISPOSITIONS);
  return {
    five9_last_dnc_dispo: five9Entry(list.find((r) => dnc.has(String(r?.disposition_name || '').trim()))),
    five9_last_call: five9Entry(list[0]),
  };
}

/**
 * The card's legacy_block. `five9` is pickFive9History's answer (null = the
 * lookup failed); `contactRecord` is the Five9 contact-DB fallback used when
 * ESS had no call; `lpLead` is the newest LP lead. Pure.
 */
export function buildLegacyBlock({ five9 = null, contactRecord = null, lpLead = null } = {}) {
  let lastCall = five9?.five9_last_call || null;
  if (!lastCall && contactRecord && (contactRecord.date || contactRecord.campaign)) {
    lastCall = { name: null, date: contactRecord.date || null, agent: null, campaign: contactRecord.campaign || null };
  }
  return {
    five9_last_dnc_dispo: five9?.five9_last_dnc_dispo || null,
    five9_last_call: lastCall,
    lp_disposition: lpLead?.label ? { label: lpLead.label, date: lpLead.date || null } : null,
    note: LEGACY_BLOCK_NOTE,
  };
}

/** Resolve to the promise's value, or null on a throw or after `ms`. Never rejects. */
async function bestEffort(label, fn, ms) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((resolve) => { timer = setTimeout(() => { console.warn(`[DncLiftReview] ${label} timed out after ${ms}ms`); resolve(null); }, ms); }),
    ]);
  } catch (err) {
    console.warn(`[DncLiftReview] ${label} failed: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * five9.disposition_set rows for this person, newest first. Matched on the
 * indexed ghl_contact_id / lp_lead_id columns (the event stamps both from its
 * contact match), with the person's LP lead ids found by contact OR phone.
 * Matching the phone inside the payload instead (dnis/ani) has no index: 47s
 * for one number on 2026-10-02, so it would always hit the cap. The id route
 * took milliseconds and found MORE rows for Mark Test (56 vs 52).
 */
async function defaultReadFive9History(contactId, phone10, db) {
  const leads = await db.from('lp_leads').select('lp_lead_id')
    .or(phone10 ? `ghl_contact_id.eq.${contactId},phone.eq.${phone10}` : `ghl_contact_id.eq.${contactId}`)
    .limit(200);
  if (leads.error) throw new Error(leads.error.message);
  const ids = [...new Set((leads.data || []).map((r) => String(r.lp_lead_id || '')).filter((id) => /^\d+$/.test(id)))];
  const { data, error } = await db.from('system_events')
    .select('created_at, disposition_name:payload->>disposition_name, campaign:payload->>campaign, agent_name:payload->>agent_name, call_end_at:payload->>call_end_at, call_start_at:payload->>call_start_at')
    .eq('event_type', 'five9.disposition_set')
    .or(ids.length ? `ghl_contact_id.eq.${contactId},lp_lead_id.in.(${ids.join(',')})` : `ghl_contact_id.eq.${contactId}`)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return data || [];
}

async function defaultReadContactRecord(phone10) {
  const { getContactRecords } = await import('../five9-admin.js');
  const rows = contactRecordRows(await getContactRecords({ criteria: [{ field: 'number1', value: phone10 }] }));
  const withDate = rows
    .map((r) => ({ date: String(r.f9_last_dispo_date_time || '').trim() || null, campaign: String(r.f9_last_campaign || '').trim() || null }))
    .filter((r) => r.date || r.campaign)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return withDate[0] || null;
}

async function defaultReadLpLead(contactId, phone10, db) {
  // disposition_label is never filled (0 of 7,768 leads in 30 days, measured
  // 2026-10-02); the LP disposition lives in disposition_code ('DNC', 'Set', …).
  const pick = 'lp_prospect_id, disposition_code, disposition_label, created_at_lp';
  let { data, error } = await db.from('lp_leads').select(pick)
    .eq('ghl_contact_id', contactId).order('created_at_lp', { ascending: false, nullsFirst: false }).limit(20);
  if (error) throw new Error(error.message);
  if (!(data || []).length && phone10) {
    ({ data, error } = await db.from('lp_leads').select(pick)
      .eq('phone', phone10).order('created_at_lp', { ascending: false, nullsFirst: false }).limit(20));
    if (error) throw new Error(error.message);
  }
  return pickLpLead(data || []);
}

/**
 * LP prospect id (newest lead) and the disposition worth showing, from
 * lp_leads rows newest first. Pure.
 * The newest lead is usually the re-entry that triggered this card, still on
 * LP's default 'Data' (all three live cards checked 2026-10-02). The block's
 * story is on the newest lead LP actually dispositioned; 'Data' only when that
 * is all there is.
 */
export function pickLpLead(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const dispo = (r) => String(r?.disposition_label || r?.disposition_code || '').trim();
  const chosen = rows.find((r) => dispo(r) && dispo(r).toLowerCase() !== 'data') || rows.find((r) => dispo(r)) || null;
  // created_at_lp holds Eastern wall-clock digits under a UTC label.
  const ms = chosen ? lpLocalToUtcMs(chosen.created_at_lp) : null;
  return {
    prospect_id: rows[0].lp_prospect_id ? String(rows[0].lp_prospect_id) : null,
    label: chosen ? dispo(chosen) : null,
    date: Number.isFinite(ms) ? new Date(ms).toISOString() : null,
  };
}

/** Has this contact already been seeded from its old Five9 block? */
async function defaultHasLegacySeed(contactId, db) {
  const { data, error } = await db.from('consent_events').select('id')
    .eq('ghl_contact_id', contactId).eq('source', FIVE9_LEGACY_SOURCE).limit(1);
  if (error) throw new Error(error.message);
  return (data || []).length > 0;
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
export function buildReviewPayload({ requestId, contactId, contact, context = {}, trigger, consentRead, carrier, reenteredAt, vendor = null, leadSource = null, blockedElsewhere = [], lpProspectId = null, legacyBlock = null, env = process.env }) {
  const tags = contact?.tags || [];
  const name = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim()
    || contact?.contactName || contact?.name || 'Unknown';
  const attribution = Array.isArray(contact?.attributions) ? contact.attributions[0] : null;
  return {
    request_id: requestId,
    ghl_contact_id: contactId,
    contact_name: name,
    phone_last4: phoneLast4(contact?.phone),
    phone_full: formatPhoneFull(contact?.phone),
    lp_prospect_id: lpProspectId || null,
    // LP refuses every clear value tried (2026-10-01). Until one is verified on
    // a real record, the card tells the approver to clear LP by hand.
    lp_manual_clear_required: lpManualClearRequired(env),
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
    legacy_block: legacyBlock || null,
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

  // ── LP prospect id + pre-consent history (best-effort; never blocks the card) ──
  const phone10 = normalizePhone10(contact.phone);
  const noHistory = (consentRead?.events || []).length === 0;
  const readLpLead = deps.readLpLead || ((id, p) => defaultReadLpLead(id, p, db));
  const capMs = deps.lookupTimeoutMs ?? LEGACY_LOOKUP_TIMEOUT_MS;
  const [five9Rows, lpLead] = await Promise.all([
    noHistory
      ? bestEffort('Five9 history lookup', () => (deps.readFive9History || ((id, p) => defaultReadFive9History(id, p, db)))(contactId, phone10), capMs)
      : null,
    bestEffort('LP lead lookup', () => readLpLead(contactId, phone10), capMs),
  ]);
  const lpProspectId = readCustomField(contact, LP_PROSPECT_FIELD_ID) || lpLead?.prospect_id || null;
  let legacyBlock = null;
  if (noHistory) {
    const five9 = Array.isArray(five9Rows) ? pickFive9History(five9Rows) : null;
    // ESS starts 2026-07-03; an older call is only on Five9's contact record.
    const contactRecord = !five9?.five9_last_call && phone10
      ? await bestEffort('Five9 contact record lookup', () => (deps.readContactRecord || defaultReadContactRecord)(phone10), capMs)
      : null;
    legacyBlock = buildLegacyBlock({ five9, contactRecord, lpLead });
  }

  const payload = buildReviewPayload({
    requestId, contactId, contact, context, trigger, consentRead, carrier,
    reenteredAt: context?.occurred_at || action.created_at || new Date(now).toISOString(),
    vendor: action.action_payload?.vendor || null,
    leadSource: action.action_payload?.lead_source || null,
    blockedElsewhere,
    lpProspectId,
    legacyBlock,
    env,
  });

  // ── one-time seed (2026-10-02) ──
  // AFTER the payload is built, so THIS card still shows the legacy lines; the
  // next card for the contact shows the seeded row as real history. Only for a
  // Five9-only block, and only when the consent read worked (an unreadable
  // record is not "no history"). Failure logs, never throws.
  if (legacyBlock && blockedElsewhere.includes(BLOCKED_IN_FIVE9) && consentRead?.status === 'ok') {
    try {
      const seeded = await (deps.hasLegacySeed || ((id) => defaultHasLegacySeed(id, db)))(contactId);
      if (!seeded) {
        await (deps.recordConsentChange || ((p) => recordConsentChange(p, { env, supabase: db })))({
          ghlContactId: contactId,
          channel: 'phone',
          change: 'revoked',
          source: FIVE9_LEGACY_SOURCE,
          actor: 'system',
          reason: 'On Five9 DNC before the consent system',
          evidence: { five9_last_dnc_dispo: legacyBlock.five9_last_dnc_dispo, five9_last_call: legacyBlock.five9_last_call },
          lpProspectId,
        });
        console.log(`[DncLiftReview] seeded five9_legacy consent history for ${contactId}`);
      }
    } catch (err) {
      console.warn(`[DncLiftReview] five9_legacy seed failed for ${contactId}: ${err.message}`);
    }
  }

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
