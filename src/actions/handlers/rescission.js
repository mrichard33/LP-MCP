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
 *   4. SYNCHRONOUS: write custom fields + apply tags so the GHL rescue
 *      workflow can fire on the tag trigger immediately
 *   5. QUEUE: GroupMe HIGH-priority alert + emit observability event
 *   6. If past_window: skip rescue, queue graceful-exit hand-off to L.1
 *
 * WHERE THE RESCUE ARC ACTUALLY LIVES (corrected 2026-09-09):
 *   O.RR was never built. It exists only in the Phase 2 build checklist —
 *   there is no such workflow in GHL, so for four months this handler tagged
 *   contacts for a workflow that could not consume the tags and the rescue
 *   ran nowhere.
 *
 *   The rescue arc is the COMPETITOR BRANCH of O.0 Objection Handler
 *   (fdf4ad82-33ab-4e73-b581-18d21d51ac42) — PUBLISHED, trigger active; it was
 *   version 157 when read live on 2026-09-09. Do not treat that number as
 *   current: O.0 is edited often (157 landed the same evening). workflow_registry
 *   in the HL Supabase holds canonical status.
 *   O.0 step 20 branches on the tag `objection-confirmed-competitor` — HYPHEN,
 *   not colon — or on webhook payload `objection_type == "competitor"`. The
 *   colon form this handler used to write (`objection-confirmed:competitor`)
 *   matched neither, which is why Wally Scott (GHL 2LT4JDrObOgPlKnn3H0q,
 *   LP 573728) entered nothing on 2026-09-09. Enrollment itself is driven by
 *   agent_rule RESCISSION_RESCUE_HUMAN_OWNED (356), which adds the hyphen tag
 *   and enrolls O.0 with objection_type in the payload; this handler's tags
 *   are the state record the routing guards read.
 *
 * Built 2026-05-06 from Thomas Michaud (YTk89Ra5NOOgdtdbgsGF) post-mortem.
 * Corrected 2026-09-09 from the Wally Scott post-mortem.
 */

import supabase from '../../supabase.js';
import { applyGHLTag, updateGHLContactFields, getGHLContact } from '../../ghl.js';
import { computeRescissionDeadline, detectSigningDate } from '../../rescission-window.js';
import { resolveMarket } from '../enrichment.js';

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

  // 4b. SYNCHRONOUS: tag the contact so the O.0 competitor branch and the
  // rescission routing guards can read the state immediately.
  const tagsToAdd = [
    `urgency:rescission-${stateLabel}`,
    `rescission-variant:${result.message_variant_key}`,
    `rescission-state:${stateLabel}`,
    // HYPHEN, not colon. O.0 step 20 branches on `objection-confirmed-competitor`
    // (or webhook objection_type == "competitor"); the colon form matches nothing
    // and left Wally Scott (2LT4JDrObOgPlKnn3H0q / LP 573728) in no rescue arc at
    // all on 2026-09-09. src/ghl.js normalizeTag is the backstop; this is the root.
    'objection-confirmed-competitor',
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
  // 2026-09-21: resolved, not read raw off z0MV6mXi0w9WwdCOFThh. That field is
  // not reliably a single code — until the writer was fixed it held every
  // branch a prospect had ever been worked by, joined ("LAKE, FTMYR"), and
  // ~136 contacts still carry that until each is re-enriched. Printing it
  // verbatim put a string that is not a market on an operator card.
  // resolveMarket validates it, falls back to the zip, and returns the display
  // NAME the card wanted anyway.
  const market = await resolveMarket({ ghlContact: contact });
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
    reasoning: 'Emit rescue-activated event for O.0 competitor-branch observability.',
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
