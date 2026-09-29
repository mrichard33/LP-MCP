/**
 * record_consent_change — src/actions/handlers/consent.js
 *
 * Consent Model v1 (2026-09-28). The action a rule template appends to write
 * one consent change: contact_consent upsert + consent_events insert in one
 * transaction (src/consent/consent-store.js → sql/139).
 *
 * Payload (mirrors recordConsentChange):
 *   {
 *     channel:  'phone' | 'email' | 'all'     // never 'sms'/'call' — see consent-store
 *     change:   'revoked' | 'granted' | 'dnc_full_on' | 'dnc_full_off'
 *               | 'carrier_stop_on' | 'carrier_stop_off'
 *     source:   'sms_stop' | 'voice_request' | 'email_unsub' | 'lp_dnc'
 *               | 'ghl_tag' | 'auto_lift' | 'slack_lift' | 'slack_review' | …
 *     reason?:  free text
 *     actor?:   'system' (default) or the Slack approver
 *     evidence?: object — merged over { rule_applied, event_id, action_id }
 *     require_event_channel?: ['sms', …]
 *   }
 *
 * require_event_channel exists for ONE case: BEHAVIORAL_DNC_REPLY fires on a
 * STOP from any channel (SMS, email, live chat), but carrier_stop_on means
 * "texted STOP". When the triggering event names its channel and it is not in
 * the list, the change is skipped. When the event does NOT name a channel the
 * change is RECORDED — an unknown channel must not un-record a STOP.
 *
 * Not five9-prefixed, so no forced approval. Not mutation-gated: recording an
 * opt-out on a suppressed contact is the whole point.
 */

import { recordConsentChange } from '../../consent/consent-store.js';

export function eventChannelBlocks(requireEventChannel, context) {
  if (!Array.isArray(requireEventChannel) || requireEventChannel.length === 0) return false;
  const ch = String(context?.channel || '').trim().toLowerCase();
  // behavioral-emitter's normalizer answers 'unknown' when it cannot tell —
  // that is "not named", not a channel, so it records like an absent one.
  if (!ch || ch === 'unknown') return false;
  return !requireEventChannel.map((c) => String(c).toLowerCase()).includes(ch);
}

export async function executeRecordConsentChange(action, context = {}, deps = {}) {
  const p = action.action_payload || {};
  if (eventChannelBlocks(p.require_event_channel, context)) {
    return {
      action: 'skipped',
      skipped: true,
      reason: 'event_channel_not_matched',
      event_channel: context?.channel || null,
      require_event_channel: p.require_event_channel,
      channel: p.channel,
      change: p.change,
    };
  }

  const evidence = {
    rule_applied: action.rule_applied || null,
    event_id: action.event_id || null,
    action_id: action.id || null,
    ...(context?.channel ? { event_channel: context.channel } : {}),
    ...(p.evidence && typeof p.evidence === 'object' ? p.evidence : {}),
  };

  const result = await recordConsentChange({
    ghlContactId: action.target_id,
    channel: p.channel,
    change: p.change,
    source: p.source,
    reason: p.reason || null,
    actor: p.actor || 'system',
    evidence,
    lpLeadId: p.lp_lead_id || null,
    lpProspectId: p.lp_prospect_id || null,
  }, deps);

  if (result.skipped) {
    return { action: 'skipped', skipped: true, reason: result.reason, channel: p.channel, change: p.change };
  }
  return {
    action: 'consent_recorded',
    channel: p.channel,
    change: p.change,
    source: p.source,
    event_id: result.event_id,
    consent: result.consent,
    mode: result.mode,
  };
}
