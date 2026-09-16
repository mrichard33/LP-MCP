/**
 * Universal Suppression Check — src/services/suppression-check.js
 *
 * Phase 1 of the Intake/Routing Layer (Issue #51).
 *
 * Centralized tag-based suppression for outbound actions. Reads the contact's
 * current tag set from contact_tag_snapshot (kept current by GHL tag webhook
 * — see src/ghl-tag-handler.js) and matches against the hardcoded
 * SUPPRESS_TAGS list. On match, the caller skips the send and records the
 * skip reason in execution_result.
 *
 * Fail-open semantics — missing supabase, missing contact_id, missing
 * snapshot, or DB error → allow the send (better to over-send than block
 * all outbound during transient infra issues). The hard guarantee is for
 * the steady-state path where the snapshot exists and the query succeeds.
 * This matches the convention used by src/services/outbound-locks.js.
 *
 * Used by:
 *   - executeSendMessageWithLock in src/actions/index.js (before lock acquire)
 *   - future outbound action handlers when they ship
 *
 * NOT used by:
 *   - send_notification (GroupMe to team — internal, not outbound to contact)
 *   - add_to_workflow (queueing only — workflow's own send steps run under
 *     universal suppression at agentic-send time once they migrate)
 *
 * Phase principle: GHL workflows retain only timer + send. Agentic owns
 * routing, suppression, classification. Suppression must be enforced at
 * the agentic outbound gate so no rule can accidentally bypass it.
 *
 * ─── 2026-05-14 ALIGNMENT WITH send-message-handler.js v3.12 ────────
 *
 * Removed `pause-bot` and `suppress-automation` from SUPPRESS_TAGS.
 *
 * Those two tags were the original "agentic bot is in charge" gating
 * signals. As of send-message-handler.js v3.12 (2026-05-08), the canonical
 * signal is `agentic-active`, enforced UPSTREAM at the rule level (e.g.
 * AGENTIC_RESPOND_POST_CHATBOT.context_conditions.has_tag = agentic-active).
 * By the time a send_message action reaches this universal gate, the rule
 * has already verified agentic-active is set. Re-gating on the legacy tags
 * here was silently dropping valid sends — first observed on contact
 * ZREwiRF6uoWsysyrzuKJ (Mary Hayward) 2026-05-13 23:20:52, where
 * AUTOMATION_SUPPRESS_ON_BOOKING's 48hr post-booking pause stamped all
 * three legacy tags onto a contact who then replied to a W8.0 email; the
 * agentic responder was suppressed even though the rule's own conditions
 * had already passed.
 *
 * Compliance / safety tags remain (dnc family, unsubscribed, cooling-active,
 * quarantined, suppress-outbound, stop-bot). stop-bot stays because it is a
 * lead-initiated kill switch that the contact triggered explicitly — that
 * is a universal signal regardless of which subsystem is sending.
 *
 * Defense in depth: send-message-handler.js v3.12 also hard-blocks on
 * dnc / do-not-contact / dnc-sms / stage:dnc and on stop-bot at the local
 * handler. Compliance gates are preserved on both layers.
 */

import supabase from '../supabase.js';
// 2026-07-23 Phase 5 — send-time live re-check reads the contact straight
// from GHL (checkSuppressionLive below). No cycle: helpers.js only imports
// the rate limiter + format helpers.
import { ghlFetch } from '../actions/helpers.js';

/**
 * The canonical list of tags that suppress agentic outbound to a contact.
 * Order does not matter — matching is set-based. Tag names are lowercased
 * (contact_tag_snapshot normalizes on write).
 */
export const SUPPRESS_TAGS = [
  // Explicit one-shot suppressor (operational)
  'suppress-outbound',

  // Terminal structural disqualification (hard-DQ closeout chain,
  // 2026-06-10). Applied by rule DQ_MOBILE_NORMALIZE et al.; no
  // reactivation path exists for these contacts.
  'hard-disqualified',

  // Intake/Routing Layer (Phase 1)
  'quarantined',

  // Loss intelligence
  'cooling-active',

  // Consent / compliance
  'dnc',
  'dnc-related',
  'unsubscribed',

  // Contact-initiated kill switch — respected universally because it is a
  // direct lead-initiated signal regardless of which channel the agentic
  // send is using. `pause-bot` (booking-window pause) and `suppress-automation`
  // (legacy GHL workflow throttle) were REMOVED 2026-05-14 — `agentic-active`
  // is now the canonical "agentic in charge" signal, enforced upstream at
  // the rule level. See header comment.
  'stop-bot',
  // Cannot-afford / no-insurance leads pursuing external assistance (2026-06-17).
  // Set by CANNOT_AFFORD_PRE_DEMO_HOLD / MANUAL_PEGGY_CANNOT_AFFORD_FIX and by
  // executeIssueHold when workflow_code='CANNOT_AFFORD'. Sending urgency or pitch
  // messaging to a lead who genuinely cannot pay is actively harmful. This tag
  // suppresses ALL agentic outbound until the hold expires and the tag is removed.
  // The rule-level not_has_any_tag gate on AGENTIC_RESPOND_POST_CHATBOT is a
  // second-layer backstop; this is the universal floor.
  'cannot-afford:pursuing-assistance',

  // 2026-08-08 — canvassing leads are worked door-to-door by a human
  // canvasser. Automated marketing on top of an active canvassing cycle
  // competes with the person standing on the doorstep. 6,065 contacts carry
  // this — the largest entry bucket in the system.
  //
  // Deliberately in SUPPRESS_TAGS (default mode) and NOT in
  // REPLY_BLOCKING_TAGS: if a canvassed homeowner texts us back, the bot
  // should still answer. This blocks proactive outbound and nurture, not a
  // direct reply — matching the 2026-07-07 always-respond policy.
  //
  // This is where the §1a protection re-homes. Once suppress-automation stops
  // gating mutations it stops gating them for canvassing contacts too, tag or
  // no tag, so leaving the tag on them protects nothing. The protection has to
  // sit on the send path, which is here.
  'active-entry:canvassing',
];

// Set for O(1) intersection check
const SUPPRESS_SET = new Set(SUPPRESS_TAGS);

// ─── 2026-07-07 ALWAYS-RESPOND POLICY (owner requirement) ───────────
// "The agentic bot is active and responding any time agentic-active is
// present; only stop-bot turns it off."
//
// While `agentic-active` is on the contact, a DIRECT REPLY may be blocked
// only by stop-bot and the legal/consent opt-out family below — carrier
// compliance that cannot be waived. The operational suppressors
// (suppress-outbound, hard-disqualified, quarantined, cooling-active,
// cannot-afford:pursuing-assistance) keep gating outbound campaigns,
// nurture, and re-enrollment via the default mode, but no longer silence
// an answer to a lead who just texted us. Incidents: 2026-07-06 21:41
// (cooling-active/suppress-outbound swallowed the aluminum-windows reply)
// and the same-day analyzer-guard silence.
//
// Callers opt in with checkSuppression(id, { mode: 'agentic_reply' }) —
// today that is ONLY the send_message flow (executeSendMessageWithLock).
// Every other caller (resurrection eligibility, future outbound handlers)
// keeps the full list.
const REPLY_BLOCKING_TAGS = [
  'stop-bot',
  // Consent / compliance — legally binding opt-outs
  'dnc',
  'dnc-related',
  'dnc-sms',
  'do-not-contact',
  'stage:dnc',
  'unsubscribed',
];
const REPLY_BLOCKING_SET = new Set(REPLY_BLOCKING_TAGS);

/**
 * 2026-07-23 Phase 5 — the ONE tag-evaluation predicate, extracted from
 * checkSuppression so the snapshot path and the live path share it. Pure
 * over a tag array; result shapes identical to the historical inline logic.
 * Do not add a parallel inline definition of "suppressed" anywhere else.
 *
 * @param {string[]} tags  lowercased tag array
 * @param {object} [opts]
 * @param {string} [opts.mode]        'default' | 'agentic_reply'
 * @param {string} [opts.logContact]  contact id for the bypass log line (the
 *                                    historical log kept its context)
 */
export function matchSuppressionTags(tags, { mode = 'default', logContact = null } = {}) {
  const t = Array.isArray(tags) ? tags : [];

  // Always-respond policy (see REPLY_BLOCKING_TAGS above): for a direct
  // agentic reply on a contact the bot owns, only stop-bot + the consent
  // family block. Operational suppressors are reported, not enforced.
  if (mode === 'agentic_reply' && t.includes('agentic-active')) {
    const blocking = t.filter(x => REPLY_BLOCKING_SET.has(x));
    if (blocking.length > 0) {
      return {
        suppressed: true,
        reason: 'suppression_tag_match',
        matched_tag: blocking[0],
        all_matches: blocking,
      };
    }
    const bypassed = t.filter(x => SUPPRESS_SET.has(x));
    if (bypassed.length > 0 && logContact) {
      console.log(`[suppression-check] agentic_reply bypass for ${logContact}: agentic-active present — operational tags [${bypassed.join(', ')}] do not block a direct reply`);
    }
    return {
      suppressed: false,
      reason: bypassed.length > 0 ? 'agentic_reply_bypass' : 'no_match',
      bypassed_tags: bypassed,
    };
  }

  const matches = t.filter(x => SUPPRESS_SET.has(x));
  if (matches.length === 0) {
    return { suppressed: false, reason: 'no_match' };
  }

  return {
    suppressed: true,
    reason: 'suppression_tag_match',
    matched_tag: matches[0],
    all_matches: matches,
  };
}

/**
 * Check whether outbound should be suppressed for this contact.
 *
 * @param {string} contact_id  GHL contact ID
 * @returns {Promise<{
 *   suppressed: boolean,
 *   reason: string,
 *   matched_tag?: string,
 *   all_matches?: string[],
 * }>}
 *
 * Result shapes:
 *   { suppressed: false, reason: 'no_supabase_open' }
 *   { suppressed: false, reason: 'no_contact_id_open' }
 *   { suppressed: false, reason: 'snapshot_read_error_open' }
 *   { suppressed: false, reason: 'no_snapshot_open' }
 *   { suppressed: false, reason: 'no_match' }
 *   { suppressed: true,  reason: 'suppression_tag_match',
 *     matched_tag: 'quarantined', all_matches: ['quarantined', 'dnc'] }
 */
export async function checkSuppression(contact_id, { mode = 'default' } = {}) {
  if (!supabase) return { suppressed: false, reason: 'no_supabase_open' };
  if (!contact_id) return { suppressed: false, reason: 'no_contact_id_open' };

  const { data, error } = await supabase
    .from('contact_tag_snapshot')
    .select('tags')
    .eq('ghl_contact_id', contact_id)
    .maybeSingle();

  if (error) {
    console.error(`[suppression-check] snapshot read error for ${contact_id}: ${error.message}`);
    return { suppressed: false, reason: 'snapshot_read_error_open' };
  }

  if (!data || !Array.isArray(data.tags) || data.tags.length === 0) {
    return { suppressed: false, reason: 'no_snapshot_open' };
  }

  return matchSuppressionTags(data.tags, { mode, logContact: contact_id });
}

// ═══════════════════════════════════════════════════════════════════
// 2026-07-23 Phase 5 — send-time LIVE re-check
// ═══════════════════════════════════════════════════════════════════
//
// checkSuppression above runs at the START of the send flow; the GHL call
// happens three steps later, and the snapshot itself lags GHL until the tag
// webhook lands. Both measured races (BEHAVIORAL_DNC_REPLY tagging while
// AGENTIC_ACTIVE_REPLY_BACKSTOP sent, gaps 1.09s / 0.71s, 2026-07) had the
// blocking tag in GHL BEFORE the send — a live read at send time catches
// them. Called immediately before deps.executeSend via the optional
// recheckBeforeSend dep (src/actions/send-message-flow.js), gated by
// SEND_TIME_RECHECK_ENABLED (default on; wired in src/actions/index.js).

/** GHL dndSettings key per send channel. livechat has no DND channel. */
const DND_CHANNEL_BY_SEND_CHANNEL = { sms: 'SMS', email: 'Email' };

/**
 * Live suppression check against GHL — same predicate as the snapshot path
 * (matchSuppressionTags), evaluated over the contact's CURRENT tags, plus
 * channel-level dndSettings.
 *
 * GHL DND semantics are inverted: dndSettings[Channel].status === 'active'
 * means the DND restriction is ACTIVE, i.e. sending is BLOCKED. It is
 * unverified whether GHL enforces DND on API-originated conversation sends,
 * so we enforce it ourselves.
 *
 * FAIL-OPEN on any error (missing contact, GHL 5xx, timeout) — a fail-closed
 * gate would turn a GHL blip into total outbound silence. Deliberately does
 * NOT use the per-batch _contactCache: a cached read reintroduces the exact
 * staleness this closes.
 *
 * @param {string} contact_id
 * @param {object} [opts]
 * @param {string} [opts.mode]     'default' | 'agentic_reply'
 * @param {string} [opts.channel]  send channel ('sms' | 'email'); null/other
 *                                 → tags-only (no dndSettings evaluation)
 */
export async function checkSuppressionLive(contact_id, { mode = 'default', channel = null } = {}) {
  if (!contact_id) return { suppressed: false, reason: 'no_contact_id_open' };

  let contact;
  try {
    const res = await ghlFetch('GET', `/contacts/${contact_id}`);
    contact = res?.contact || res || {};
  } catch (err) {
    console.warn(`[suppression-check] live read failed for ${contact_id} (fail-open): ${err?.message || err}`);
    return { suppressed: false, reason: 'live_read_error_open' };
  }

  // Live GHL tags are not normalized; the snapshot convention is lowercase.
  const tags = Array.isArray(contact.tags)
    ? contact.tags.map(t => String(t).trim().toLowerCase())
    : [];

  const tagResult = matchSuppressionTags(tags, { mode, logContact: contact_id });
  if (tagResult.suppressed) {
    return { ...tagResult, source: 'live' };
  }

  // Both 'active' AND 'permanent' block. 'permanent' is the carrier-level
  // STOP-keyword state — STRONGER than 'active', not absent (2026-07-23
  // backfill lesson: the contacts who texted STOP are exactly the ones a
  // 'active'-only check would wave through).
  const dndChannel = channel ? DND_CHANNEL_BY_SEND_CHANNEL[String(channel).toLowerCase()] : null;
  const dndStatus = dndChannel ? contact.dndSettings?.[dndChannel]?.status : null;
  if (dndStatus === 'active' || dndStatus === 'permanent') {
    return {
      suppressed: true,
      reason: dndStatus === 'permanent' ? 'dnd_channel_permanent' : 'dnd_channel_active',
      matched_tag: `dnd:${String(channel).toLowerCase()}`,
      all_matches: [`dnd:${String(channel).toLowerCase()}`],
      source: 'live',
    };
  }

  return { ...tagResult, source: 'live' };
}

// ═══════════════════════════════════════════════════════════════════
// 2026-07-03 — MUTATION suppression (pipeline-integrity breach)
// ═══════════════════════════════════════════════════════════════════
//
// suppress-automation / stop-bot on a contact must block ALL mutating action
// types (move_opportunity, workflows, stages, custom fields, non-audit tags)
// — not only send_message. This is the tag check for that gate; the gate
// itself lives in the action executor (src/actions/index.js).
//
// Same snapshot read + fail-open contract as checkSuppression above.

// 2026-08-08 — `suppress-automation` removed from the mutation gate.
//
// WHAT THE TAG ACTUALLY MEANS: 4,591 of 4,837 applications (95%) come from
// AUTOMATION_SUPPRESS_ON_BOOKING — a 48h post-booking marketing pause on a
// CONVERTING lead. Not a disqualification. Of 3,729 carriers, zero are
// customers and 3,137 carry no compliance tag of any kind.
//
// WHY IT HAD TO GO: it was self-sealing. remove_tag had no audit exemption,
// so the tag blocked its own removal — 963 blocked removals against 1,459
// successful ones. A 48-hour pause became permanent on 3,729 contacts,
// 3,052 of whom carry agentic-active, with every mutation against them
// silently dropped.
//
// Three other call sites already treat this tag as a non-blocker
// (SUPPRESS_TAGS 2026-05-14; send-message-handler v3.12; suppression-guard).
//
// THE PAUSE ITSELF IS STILL CORRECT and is preserved — re-scoped to outbound
// in §1b rather than blocking all mutations. Pausing MARKETING on someone who
// just booked is right. Blocking their stage moves, tag hygiene, opportunity
// updates and appointment sync was not.
//
// stop-bot stays. Lead-initiated, universal.
const MUTATION_SUPPRESS_TAGS = ['stop-bot'];
const MUTATION_SUPPRESS_SET = new Set(MUTATION_SUPPRESS_TAGS);

/**
 * Pure predicate over a tag array (unit-testable without a DB).
 */
export function matchMutationSuppression(tags) {
  if (!Array.isArray(tags)) return null;
  return tags.find(t => MUTATION_SUPPRESS_SET.has(String(t).toLowerCase())) || null;
}

// add_tag exception: suppression/audit tags must still land on a suppressed
// contact (they are how suppression is recorded in the first place).
const SUPPRESSION_AUDIT_TAG_RE =
  /^(dnc|dnc-|do-not-contact|stop-bot|suppress[-:]|hard-disqualified|quarantined|audit-|compliance-|loss-reason:)/i;

export function isSuppressionAuditTag(tag) {
  return SUPPRESSION_AUDIT_TAG_RE.test(String(tag || ''));
}

// ─── 2026-09-03 — DE-ESCALATION EXEMPTION ──────────────────────────
// Tom Messick (eqjK58AwEZ1juYJH6szE) told the bot he had lost his wife and
// asked us to stop. stop-bot was applied, and the remove_from_workflow that
// would have pulled him out of S5.2 Appointment Rescue (action 418776) was
// rejected with "mutation suppressed: contact has stop-bot". The tag he
// earned by asking us to stop is what stopped us honoring it.
//
// THE BINDING RULE: an action whose ONLY possible effect is to reduce
// contact is never the thing a suppression tag should block. Suppression
// exists to prevent outreach, and these actions prevent outreach.
//
// Deliberately NARROW. Two things are exempt and nothing else:
//
//   remove_from_workflow — unconditional. There is no payload shape that
//     makes removing a contact from a workflow send more messages.
//
//   remove_tag of an ENROLLMENT tag — the "you are in an outbound sequence"
//     family only. Removing one of these ends a cadence.
//
// EXPLICITLY NOT EXEMPT, each for a reason:
//   - remove_tag of a suppression tag (stop-bot, dnc, cooling-active,
//     unsubscribed, cannot-afford:*). Removing those RESUMES outreach — the
//     exact inversion this gate exists to prevent. The only path to remove
//     them stays the authorized lift's explicit bypass_suppression flag.
//   - remove_tag of stage:* or active-entry:*. One of each per contact is a
//     system invariant; a bare removal leaves the contact stateless and the
//     next router pass has to guess.
//   - cancel_appointment. stop-bot is ALSO the rep-takeover convention, so a
//     rep who takes a contact over would have their customer's appointment
//     auto-cancelled underneath them. Reducing contact is safe; cancelling a
//     booked visit is not the same thing.
const DE_ESCALATION_ACTION_TYPES = new Set(['remove_from_workflow']);

// Enrollment/cohort membership only. Anchored, and narrow on purpose — a
// pattern that accidentally matched a suppression tag would turn this
// exemption into a suppression-removal hole.
const ENROLLMENT_TAG_RE =
  /^(agentic-active|booking:active|nurture-active|active-s\d|active-s\d+\.\d+|active-w\d)/i;

/**
 * True when the action can only REDUCE contact with this lead.
 * Pure over the action row; unit-tested in
 * scripts/test-suppression-and-tag-hygiene.js.
 */
export function isDeEscalationAction(action) {
  if (!action) return false;
  const type = String(action.action_type || '');

  if (DE_ESCALATION_ACTION_TYPES.has(type)) return true;

  if (type === 'remove_tag') {
    const tag = String(action.action_payload?.tag || '').trim().toLowerCase();
    if (!tag) return false;
    // Belt and braces: never let the enrollment pattern reach a tag that
    // any suppression list also claims. If the two ever overlap, the
    // suppression list wins and the removal stays blocked.
    if (SUPPRESS_SET.has(tag)) return false;
    if (MUTATION_SUPPRESS_SET.has(tag)) return false;
    if (isSuppressionAuditTag(tag)) return false;
    return ENROLLMENT_TAG_RE.test(tag);
  }

  return false;
}

/**
 * Is this action exempt from the mutation-suppression gate? Pure predicate
 * over the action row. Three exemptions:
 *   (a) add_tag of a suppression/audit tag — that is how suppression itself is
 *       recorded on the contact.
 *   (b) 2026-07-11 — an authorized re-engagement lift (DNC_LIFT_ON_REENGAGEMENT)
 *       that explicitly sets action_payload.bypass_suppression:true. The lift
 *       must be able to REMOVE the suppression stack (stop-bot, lp-dnc, …) from
 *       a stop-bot contact; without an exemption the DNC blocks its own removal
 *       (the gate has no remove_tag audit-exemption, only an add_tag one) and a
 *       re-booked lead stays suppressed forever.
 *   (c) 2026-09-03 — a DE-ESCALATION action (isDeEscalationAction): one whose
 *       only possible effect is to reduce contact. See that function's header
 *       for the incident and for what is deliberately excluded.
 * The bypass flag is honored ONLY on rule-authored templates the operator
 * controls; every other mutation on a suppressed contact still blocks.
 */
export function isMutationGateExempt(action) {
  if (!action) return false;
  if (action.action_payload?.bypass_suppression === true) return true;
  if (action.action_type === 'add_tag' && isSuppressionAuditTag(action.action_payload?.tag)) return true;
  if (isDeEscalationAction(action)) return true;
  return false;
}

export async function checkMutationSuppression(contact_id) {
  if (!supabase) return { suppressed: false, reason: 'no_supabase_open' };
  if (!contact_id) return { suppressed: false, reason: 'no_contact_id_open' };

  const { data, error } = await supabase
    .from('contact_tag_snapshot')
    .select('tags')
    .eq('ghl_contact_id', contact_id)
    .maybeSingle();

  if (error) {
    console.error(`[suppression-check] mutation snapshot read error for ${contact_id}: ${error.message}`);
    return { suppressed: false, reason: 'snapshot_read_error_open' };
  }
  if (!data || !Array.isArray(data.tags) || data.tags.length === 0) {
    return { suppressed: false, reason: 'no_snapshot_open' };
  }

  const matched = matchMutationSuppression(data.tags);
  if (!matched) return { suppressed: false, reason: 'no_match' };
  return { suppressed: true, reason: 'mutation_suppression_tag', matched_tag: matched };
}

// Exported for unit tests + introspection
export const __testing = { SUPPRESS_SET, MUTATION_SUPPRESS_SET };
