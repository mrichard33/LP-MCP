/**
 * Rescission Rescue Handler — src/actions/handlers/rescission.js
 *
 * action_type: compute_rescission_dispatch
 *
 * Single fan-out handler that activates the Competitor Rescission Rescue
 * arc when Layer 3 detects "purchased elsewhere" inbound language without
 * a DNC overlay.
 *
 * Flow:
 *   1. Pull source event, extract inbound message text
 *   2. Detect signing date from text; default to today (D1: aggressive rescue)
 *   3. Compute Florida 3-business-day rescission deadline + variant
 *   4. SYNCHRONOUS: write custom fields + apply tags so GHL workflow O.RR
 *      can fire on the tag trigger immediately
 *   5. QUEUE: GroupMe HIGH-priority alert + emit observability event
 *   6. If past_window: skip rescue, queue graceful-exit hand-off to L.1
 *
 * The actual 72-hour rescue arc lives in GHL workflow O.RR (built by Mark
 * in the GHL UI per Phase 2 build checklist). This handler activates it
 * by tagging + alerting; O.RR consumes the tags and runs the sequence.
 *
 * Built 2026-05-06 from Thomas Michaud (YTk89Ra5NOOgdtdbgsGF) post-mortem.
 */

import supabase from '../../supabase.js';
import { applyGHLTag, updateGHLContactFields, getGHLContact } from '../../ghl.js';
import { computeRescissionDeadline, detectSigningDate } from '../../rescission-window.js';

// GHL custom field IDs — provisioned by Mark in GHL UI per Phase 2 checklist.
// If env vars not set, handler still tags the contact (custom field write is
// best-effort and logs a warning).
const FIELD_IDS = {
  rescission_signed_date: process.env.GHL_FIELD_RESCISSION_SIGNED_DATE || null,
  rescission_deadline:    process.env.GHL_FIELD_RESCISSION_DEADLINE    || null,
  rescission_variant:     process.env.GHL_FIELD_RESCISSION_VARIANT     || null,
  rescission_state:       process.env.GHL_FIELD_RESCISSION_STATE       || null,
};

const GROUPME_CHANNEL = 'rescission-rescue';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';

// Known custom field IDs for alert enrichment (from system reference)
const CF_ESTIMATE_VALUE = 'PqUYMgBojosjSGMBEUqX';
const CF_WINDOW_COUNT_PRIMARY = 'h9FJTUbmUHIuD6JKmpXv';
const CF_WINDOW_COUNT_ALT = 'YWhoVixgPtvEDzSXcMpJ';
const CF_MARKET = 'z0MV6mXi0w9WwdCOFThh';
const CF_ASSIGNED_REP = 'lPCvCXOQEQFXtuHekAq8';

async function fetchSourceEvent(eventId) {
  if (!eventId) return null;
  const { data, error } = await supabase
    .from('system_events')
    .select('id, event_type, event_subtype, ghl_contact_id, entity_id, payload, created_at')
    .eq('id', eventId)
    .maybeSingle();
  if (error) {
    console.warn(`[rescission] fetchSourceEvent error for event ${eventId}: ${error.message}`);
    return null;
  }
  return data || null;
}

function extractMessageText(event) {
  const p = event?.payload || {};
  return p.message_text || p.message || p.body || p.text || p.last_message_body || null;
}

async function queueAction(insert) {
  const { data, error } = await supabase.from('agent_actions').insert(insert).select().single();
  if (error) {
    console.error(`[rescission] queue insert failed (${insert.action_type}): ${error.message}`);
    return null;
  }
  return data;
}

function getCFValue(contact, fieldId) {
  if (!contact?.customFields) return null;
  return contact.customFields.find(f => f.id === fieldId)?.value ?? null;
}

export async function executeComputeRescissionDispatch(action /*, context */) {
  const contactId = action.target_id;
  if (!contactId) throw new Error('compute_rescission_dispatch: missing contact id');

  // 1. Source event for inbound message
  const event = await fetchSourceEvent(action.event_id);
  const messageText = extractMessageText(event) || '';
  const eventCreatedAt = event?.created_at || new Date().toISOString();

  // 2. Sign-date detection — assume today if no temporal cue (D1)
  const detected = detectSigningDate(messageText, { now: eventCreatedAt });
  const signedDate = detected || new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(eventCreatedAt));

  // 3. Compute deadline
  const result = computeRescissionDeadline(signedDate, { now: eventCreatedAt });
  const stateLabel = result.past_window ? 'past-window' : 'active';

  console.log(
    `[rescission] contact=${contactId} ` +
    `signed=${result.signed_date_iso} (${result.signing_dow_name}) ` +
    `deadline=${result.deadline_iso} (${result.deadline_dow_name}) ` +
    `variant=${result.message_variant_key} ` +
    `biz_days_remaining=${result.business_days_remaining} ` +
    `past=${result.past_window} ` +
    `signing_date_source=${detected ? 'detected' : 'default-today'}`
  );

  // 4. SYNCHRONOUS: custom field writes (best-effort)
  const fieldUpdates = [];
  if (FIELD_IDS.rescission_signed_date) fieldUpdates.push({ id: FIELD_IDS.rescission_signed_date, value: result.signed_date_iso });
  if (FIELD_IDS.rescission_deadline)    fieldUpdates.push({ id: FIELD_IDS.rescission_deadline,    value: result.deadline_iso });
  if (FIELD_IDS.rescission_variant)     fieldUpdates.push({ id: FIELD_IDS.rescission_variant,     value: result.message_variant_key });
  if (FIELD_IDS.rescission_state)       fieldUpdates.push({ id: FIELD_IDS.rescission_state,       value: stateLabel });

  if (fieldUpdates.length > 0) {
    try {
      const r = await updateGHLContactFields(contactId, fieldUpdates);
      if (r === 'not_found') console.warn(`[rescission] custom field write: contact ${contactId} not found`);
    } catch (err) {
      console.warn(`[rescission] custom field write failed: ${err.message} — continuing`);
    }
  } else {
    console.warn(`[rescission] no GHL_FIELD_RESCISSION_* env vars set — skipping custom field writes (tags only). See Phase 2 build checklist.`);
  }

  // 4b. SYNCHRONOUS: tag the contact so GHL workflow O.RR can pick it up immediately
  const tagsToAdd = [
    `urgency:rescission-${stateLabel}`,
    `rescission-variant:${result.message_variant_key}`,
    `rescission-state:${stateLabel}`,
    'objection-confirmed:competitor',
    'intent-rescission-rescue',
  ];
  if (result.past_window) {
    tagsToAdd.push('lost-post-rescission', 'loss-reason:competitor');
  }
  let tagsApplied = 0;
  for (const tag of tagsToAdd) {
    const ok = await applyGHLTag(contactId, tag);
    if (ok) tagsApplied++;
  }
  console.log(`[rescission] tags applied: ${tagsApplied}/${tagsToAdd.length} for contact ${contactId}`);

  // 5. Pull contact for alert enrichment (after tags are set)
  let contact = null;
  try {
    contact = await getGHLContact(contactId);
  } catch (err) {
    console.warn(`[rescission] getGHLContact failed for alert enrichment: ${err.message}`);
  }
  const estimateValue = getCFValue(contact, CF_ESTIMATE_VALUE);
  const windowCount = getCFValue(contact, CF_WINDOW_COUNT_PRIMARY) || getCFValue(contact, CF_WINDOW_COUNT_ALT);
  const market = getCFValue(contact, CF_MARKET);
  const repName = getCFValue(contact, CF_ASSIGNED_REP);

  const batchId = `rescission_${event?.id || action.id}_${Date.now()}`;
  const queued = [];

  // 6. Past-window branch: graceful exit, no rescue
  if (result.past_window) {
    queued.push(await queueAction({
      event_id: event?.id || action.event_id,
      action_type: 'send_notification',
      target_system: 'groupme',
      target_entity: 'contact',
      target_id: contactId,
      action_payload: {
        channel: GROUPME_CHANNEL,
        title: `Rescission window closed — graceful exit`,
        body:
          `Past-window rescission detected.\n` +
          `Contact: ${contact?.firstName || ''} ${contact?.lastName || ''}\n` +
          `Phone: ${contact?.phone || 'unknown'}\n` +
          `Signed: ${result.signing_dow_name} ${result.signed_date_iso}\n` +
          `Deadline (passed): ${result.deadline_iso}\n` +
          `Tagged lost-post-rescission + loss-reason:competitor for L.1 routing.\n` +
          (estimateValue ? `Estimate: $${estimateValue}\n` : '') +
          `https://app.gohighlevel.com/v2/location/${GHL_LOCATION_ID}/contacts/detail/${contactId}`,
        priority: 'normal',
      },
      reasoning: 'Rescission window already closed — graceful exit notification + L.1 hand-off via tags.',
      confidence: 1.0,
      rule_applied: 'COMPETITOR_RESCISSION_PAST_WINDOW',
      status: 'pending',
      requires_approval: false,
      batch_id: batchId,
      sequence_order: 0,
    }));

    queued.push(await queueAction({
      event_id: event?.id || action.event_id,
      action_type: 'emit_event',
      target_system: 'lp',
      target_entity: 'contact',
      target_id: contactId,
      action_payload: {
        event_type: 'rescission.past_window',
        event_subtype: result.message_variant_key,
        payload: {
          ghl_contact_id: contactId,
          signed_date: result.signed_date_iso,
          deadline: result.deadline_iso,
          variant: result.message_variant_key,
          source_event_id: event?.id || null,
        },
        priority: 'normal',
        idempotency_key: `rescission_past_${contactId}_${result.signed_date_iso}`,
      },
      reasoning: 'Observability event for past-window rescission detection.',
      confidence: 1.0,
      rule_applied: 'COMPETITOR_RESCISSION_PAST_WINDOW',
      status: 'pending',
      requires_approval: false,
      batch_id: batchId,
      sequence_order: 1,
    }));

    return {
      action: 'rescission_past_window',
      contact_id: contactId,
      signed_date: result.signed_date_iso,
      deadline: result.deadline_iso,
      variant: result.message_variant_key,
      tags_applied: tagsApplied,
      sub_actions_queued: queued.filter(Boolean).length,
      batch_id: batchId,
    };
  }

  // 7. ACTIVE branch: queue HIGH-priority GroupMe alert + observability event
  const alertBody =
    `🚨 RESCISSION RESCUE — ${contact?.firstName || 'Lead'} ${contact?.lastName || ''}\n` +
    `Signed: ${result.signing_dow_name} ${result.signed_date_iso}\n` +
    `Deadline: ${result.deadline_human} (${result.deadline_iso})\n` +
    `Business days remaining: ${result.business_days_remaining}\n` +
    `Variant: ${result.message_variant_key}\n` +
    (estimateValue ? `Estimate: $${estimateValue}\n` : '') +
    (windowCount ? `Windows: ${windowCount}\n` : '') +
    (market ? `Market: ${market}\n` : '') +
    (repName ? `Assigned: ${repName}\n` : '') +
    `Phone: ${contact?.phone || 'unknown'}\n` +
    `https://app.gohighlevel.com/v2/location/${GHL_LOCATION_ID}/contacts/detail/${contactId}`;

  queued.push(await queueAction({
    event_id: event?.id || action.event_id,
    action_type: 'send_notification',
    target_system: 'groupme',
    target_entity: 'contact',
    target_id: contactId,
    action_payload: {
      channel: GROUPME_CHANNEL,
      title: `Rescission Rescue — ${result.business_days_remaining} biz day(s) remaining`,
      body: alertBody,
      priority: 'high',
    },
    reasoning: `Layer 3 detected competitor signing. ${result.business_days_remaining} business days remaining in FL rescission window. Variant: ${result.message_variant_key}.`,
    confidence: 0.9,
    rule_applied: 'COMPETITOR_RESCISSION_WINDOW',
    status: 'pending',
    requires_approval: false,
    batch_id: batchId,
    sequence_order: 0,
  }));

  queued.push(await queueAction({
    event_id: event?.id || action.event_id,
    action_type: 'emit_event',
    target_system: 'lp',
    target_entity: 'contact',
    target_id: contactId,
    action_payload: {
      event_type: 'rescission.rescue_activated',
      event_subtype: result.message_variant_key,
      payload: {
        ghl_contact_id: contactId,
        signed_date: result.signed_date_iso,
        deadline: result.deadline_iso,
        variant: result.message_variant_key,
        business_days_remaining: result.business_days_remaining,
        signing_date_source: detected ? 'detected_from_text' : 'default_today',
        source_event_id: event?.id || null,
      },
      priority: 'high',
      idempotency_key: `rescission_activated_${contactId}_${result.signed_date_iso}`,
    },
    reasoning: 'Emit rescue-activated event for O.RR workflow + observability.',
    confidence: 1.0,
    rule_applied: 'COMPETITOR_RESCISSION_WINDOW',
    status: 'pending',
    requires_approval: false,
    batch_id: batchId,
    sequence_order: 1,
  }));

  return {
    action: 'rescission_active',
    contact_id: contactId,
    signed_date: result.signed_date_iso,
    deadline: result.deadline_iso,
    variant: result.message_variant_key,
    business_days_remaining: result.business_days_remaining,
    tags_applied: tagsApplied,
    sub_actions_queued: queued.filter(Boolean).length,
    batch_id: batchId,
  };
}
