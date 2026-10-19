/**
 * DNC lifts without a click — src/consent/dnc-auto-lift.js
 *
 * Mark, 2026-10-18: "DNC lifts no longer wait for a Slack Approve click. They
 * run automatically and post a NOTIFICATION (no buttons) to #dnc-lift-approval
 * saying the DNC was removed. EXCEPTION: canvassing leads keep today's Approve
 * / Keep Blocked card exactly as is."
 *
 * Pure and dependency-free, so the decision is unit-tested without GHL, Five9
 * or Supabase. src/consent/dnc-lift-review.js owns the reads and the lift;
 * src/five9/admin-writes.js reads dncLiftApprovalMode() again at execution
 * time, so flipping the switch back to manual stops a lift already queued.
 *
 * WHAT STILL NEEDS A PERSON (every one falls back to the old card, with the
 * reason printed on it):
 *   - a canvassing contact (the exception Mark named);
 *   - a canvass check we could not read: we cannot tell, so a person decides.
 *     Failing toward the card costs one click; failing toward a lift could
 *     call someone a canvasser's team was told to leave alone;
 *   - the new lead's own LP disposition is DNC (they opted out on it);
 *   - a consent opt-out or a Five9 "Do Not Call"/"DNC" disposition after the
 *     new lead (or the inbound call) arrived: a fresh opt-out is never lifted.
 * The 24h review cooldown and the first-party re-entry skip run before this,
 * exactly as before, and a carrier STOP is handled by the batch as before (calls
 * come back, texts stay off).
 */

import { prospectLabel } from '../format-helpers.js';

export const AUTO_DNC_LIFT_RULE_KEY = 'AUTO_DNC_LIFT';
// Who "approved" the Five9 row. Not a Slack user id on purpose: the Slack path
// still refuses anything that is not one, and this path refuses anything else.
export const AUTO_DNC_LIFT_APPROVER = 'system:auto_dnc_lift';
export const AUTO_LIFT_ACTOR = 'Auto-approved (DNC_LIFT_APPROVAL_MODE=auto)';
export const AUTO_LIFT_TAG = 'recovery:dnc-lifted-auto';
export const AUTO_LIFT_EVENT = 'consent.dnc_lifted_auto';
export const AUTO_LIFT_SOURCE = 'auto_lift';

/** DNC_LIFT_APPROVAL_MODE: exactly `auto` is auto; anything else is manual. Pure. */
export function dncLiftApprovalMode(env = process.env) {
  return String(env?.DNC_LIFT_APPROVAL_MODE ?? '').trim().toLowerCase() === 'auto' ? 'auto' : 'manual';
}

// Canvassing markers, each checked against live rows on 2026-10-19:
// entry:canvassing 10,494 contacts, active-entry:canvassing 9,817,
// source:canvass 8,057, canvass-subtype:* 8,087, canvass-v2 2,735, canvassing
// 532; LP sources "Canvass" (70,261 leads) and "Canvass Sticky" (3,294);
// canvassing_intake_marks 2,228 rows (22 of 206 review requests in 30 days).
// Over-matching costs a click; under-matching lifts a canvass lead unseen.
export const CANVASS_TAGS = Object.freeze(['canvass-v2', 'canvassing', 'source:canvass']);
export const CANVASS_TAG_PREFIXES = Object.freeze(['entry:canvass', 'active-entry:canvass', 'canvass-subtype:']);

/**
 * Is this a canvassing contact? Pure.
 * `hasIntakeMark` null/undefined means the read failed: treated as canvassing.
 * `readFailed` true (any canvass read failed) is canvassing too.
 */
export function isCanvassingContact({ tags = [], lpLeadSource = null, hasIntakeMark = false, readFailed = false } = {}) {
  if (readFailed || hasIntakeMark === null || hasIntakeMark === undefined) return true;
  if (hasIntakeMark === true) return true;
  const lower = (Array.isArray(tags) ? tags : []).map((t) => String(t || '').trim().toLowerCase());
  if (lower.some((t) => CANVASS_TAGS.includes(t) || CANVASS_TAG_PREFIXES.some((p) => t.startsWith(p)))) return true;
  const sources = Array.isArray(lpLeadSource) ? lpLeadSource : [lpLeadSource];
  return sources.some((s) => /canvass/i.test(String(s || '')));
}

// The line printed on a card that fell back to a person. It rides on the
// card's "Blocked by:" line (n8n prints blocking_tags as-is), like the Five9
// and consent labels in dnc-lift-review.js, so the live card needs no n8n change.
export const HOLD_REASON_TEXT = Object.freeze({
  canvassing: 'Needs a person: canvassing lead (not auto-lifted)',
  auto_lift_check_failed: 'Needs a person: the auto-lift checks could not be read',
  opted_out_on_this_lead: 'Needs a person: the new LP lead is dispositioned DNC',
  opted_out_after_arrival: 'Needs a person: opted out again after this lead arrived',
});

/**
 * Lift on our own, or ask a person? Pure.
 * @param {object} p
 *   mode   dncLiftApprovalMode()
 *   tags   the contact's live GHL tags
 *   facts  readAutoLiftFacts()'s answer: { ok, lpLeadSource, hasIntakeMark,
 *          newLeadDisposition, optedOutAfter, error }
 * @returns {{ auto: boolean, reason: string }}
 */
export function decideAutoLift({ mode, tags = [], facts = null } = {}) {
  if (mode !== 'auto') return { auto: false, reason: 'manual_mode' };
  if (!facts || facts.ok !== true) return { auto: false, reason: 'auto_lift_check_failed' };
  if (isCanvassingContact({ tags, lpLeadSource: facts.lpLeadSource, hasIntakeMark: facts.hasIntakeMark })) {
    return { auto: false, reason: 'canvassing' };
  }
  if (String(facts.newLeadDisposition || '').trim().toUpperCase() === 'DNC') return { auto: false, reason: 'opted_out_on_this_lead' };
  if (facts.optedOutAfter !== false) {
    // null = the read did not say; only a clear "no fresh opt-out" lifts.
    return { auto: false, reason: facts.optedOutAfter === true ? 'opted_out_after_arrival' : 'auto_lift_check_failed' };
  }
  return { auto: true, reason: 'ok' };
}

const SYSTEM_LABEL = { ghl: 'GHL', five9: 'Five9', consent: 'Consent record', lp: 'LP', audit: 'Audit event' };

/**
 * The #dnc-lift-approval notice. No buttons: plain mrkdwn text through
 * postToSlack, which links "Prospect 123" to its LP page itself. Pure.
 *
 * @param {object} p
 *   name, phone10, source, subSource, trigger
 *   systems        { ghl|five9|consent|lp|audit: { status: done|retrying|failed, errors } }
 *   lpManual       LP still shows DNC (its clear is not automated yet)
 *   lpProspectId
 *   smsWarning     set when the lead texted STOP
 *   ghlUrl
 *   error          the whole batch failed before it ran
 * @returns {{ text: string, anyFailed: boolean }}
 */
export function formatAutoLiftNotice({ name, phone10, source, subSource, trigger, systems = {}, lpManual = false, lpProspectId = null, smsWarning = null, ghlUrl = null, error = null } = {}) {
  const src = [source, subSource].filter(Boolean).join(' / ') || 'unknown';
  const failedKeys = Object.entries(systems).filter(([k, s]) => s?.status === 'failed' && !(k === 'lp' && lpManual)).map(([k]) => k);
  const anyFailed = !!error || failedKeys.length > 0;
  const head = anyFailed
    ? `:warning: *DNC lift ran automatically but did not fully complete* — ${name || 'Unknown'} · ${phone10 || 'no phone'} · source ${src}`
    : `✅ *DNC removed automatically* — ${name || 'Unknown'} · ${phone10 || 'no phone'} · source ${src}`;
  const lines = [head];
  if (trigger === 'inbound_call') lines.push('Why: they called in and talked with an agent; the LP lead is created once the lift finishes.');
  if (error) lines.push(`• The lift could not run: ${String(error).slice(0, 300)}`);
  for (const key of ['ghl', 'five9', 'consent']) {
    const s = systems[key];
    if (!s) continue;
    if (s.status === 'failed') lines.push(`• ${SYSTEM_LABEL[key]}: ❌ failed — ${String((s.errors || []).join('; ')).slice(0, 300)}`);
    else if (s.status === 'retrying') lines.push(`• ${SYSTEM_LABEL[key]}: ⏳ retrying automatically`);
    else lines.push(`• ${SYSTEM_LABEL[key]}: ✅ done`);
  }
  if (systems.audit?.status === 'failed') lines.push(`• Audit event: ❌ failed — ${String((systems.audit.errors || []).join('; ')).slice(0, 300)}`);
  if (lpManual) lines.push(`• LP: :warning: Clear LP by hand: ${lpProspectId ? prospectLabel(lpProspectId) : 'find the prospect by phone'}`);
  else if (systems.lp) lines.push(`• LP: ${systems.lp.status === 'failed' ? '❌ failed' : systems.lp.status === 'retrying' ? '⏳ retrying automatically' : '✅ done'}`);
  if (smsWarning) lines.push(`:warning: ${smsWarning}`);
  if (ghlUrl) lines.push(`<${ghlUrl}|Open in GHL>`);
  return { text: lines.join('\n'), anyFailed };
}
