/**
 * One send gate — src/services/may-message.js
 *
 * 2026-10-07 — ONE answer to "may we message this contact?", pure, no I/O.
 *
 * WHY: five separate checks answered that question and each knew a different
 * list. matchSuppressionTags (this file's neighbour) let every operational
 * suppressor through for a reply while agentic-active was on the contact;
 * send-message-handler.js blocked only the DNC family and stop-bot; the
 * mutation gate knew only stop-bot; info-email.js, the nurture orchestrator
 * and lead selection each kept their own set. out-of-area and dq-out-of-area
 * were in none of the send gates. In 30 days the bot sent 34 replies to 14
 * contacts AFTER suppress-outbound landed: Jessup (LmBvkJUNrqZ9HoVNuovP) got
 * an AI reply and an S5.2 text after SERVICE_AREA_EXIT tagged him out-of-area,
 * and McKoy (rRPO34Ooq0QmtSfXyqSw) was promised a call twice and then texted
 * "Stop text". The rule conditions (106, 161) are a second layer; this is the
 * floor, enforced in code outside the model (AI OS CANON.STD.019, P.001) and
 * before the send it protects (STD.018).
 *
 * THE CLASSES (one constant each; the comment names who sets the tag):
 *
 *   CONSENT_STOP      blocks every purpose on every channel — except that a
 *                     phone-only opt-out does not block email and dnc-email
 *                     blocks only email (the info-email.js list, 2026-09-24,
 *                     and the consent model's "a tag blocks only its own
 *                     channel", 2026-09-29).
 *   BOT_STOP          stop-bot: blocks every purpose on every channel. The
 *                     bot-off switch, not an opt-out (the user, 2026-10-07).
 *   HARD_DQ           blocks 'reply' and 'outreach'. A lead the system
 *                     disqualified gets no bot message; a person may still
 *                     text from GHL (Mark's handoff, 2026-10-06).
 *   OPERATIONAL_HOLD  blocks 'outreach' only — today's behaviour: the
 *                     2026-07-07 always-respond policy still answers a lead
 *                     who texted us while one of these is on.
 *   NEVER_BLOCK       pause-workflow, suppress-automation, pause-bot. Known on
 *                     purpose so nobody adds them to a class by accident:
 *                     pause-workflow is a GHL drip signal (rule 106 adds it
 *                     after every bot reply), not a bot stop.
 *
 * PURPOSES:
 *   'reply'     answering an inbound the lead just sent
 *   'outreach'  anything unprompted: rule sends, nurture, sweeps, selection
 *   'mutation'  putting the contact into something that sends (add_to_workflow)
 *
 * Rollout: SEND_GATE_MODE = shadow | live (default shadow). In shadow every
 * caller keeps its old answer and a disagreement is recorded as a
 * `send_gate.would_block` / `send_gate.would_allow` system event
 * (src/services/send-gate-report.js). In live this answer wins — except a
 * legacy block on a tag this module does not know at all (a route's own
 * extra, e.g. nurture's stop-seinfeld), which stands: live never silently
 * drops a block nobody classified.
 */

// ─── Tag classes ─────────────────────────────────────────────────────────

/** Opt-outs and the lead's own kill switch. */
export const CONSENT_STOP = Object.freeze([
  'dnc',                // staff / legacy lead opt-out (GHL); rule 241 moves objection state
  'dnc-related',        // legacy SUPPRESS_TAGS member; kept so live never loosens it
  'dnc-sms',            // TAG_DNC_SMS_OPTOUT, staff "block calls + texts" (phone)
  'dnc-voice',          // TAG_DNC_VOICE_OPTOUT (phone)
  'dnc-email',          // TAG_DNC_EMAIL_OPTOUT (email only)
  'dnc-all',            // staff, all channels (rule 145's list)
  'do-not-contact',     // legacy lead opt-out
  'stage:dnc',          // pipeline DNC stage
  'unsubscribed',       // email unsubscribe / GHL
  'lp-dnc',             // LP DNC disposition sync (phone: LP's C = Do Not Call)
  'p3:dnc',             // L.6 loss routing, DNC loss reason
  'suppress:dnc-reply', // BEHAVIORAL_DNC_REPLY — a texted STOP (phone)
  'suppress:dnc-voice', // voice opt-out recorded by the consent store (phone)
]);

/**
 * The bot-off switch (the user, 2026-10-07: "stop-bot should not have anything
 * to do with dnc. This tag is intended to stop all bot communication"). It
 * blocks every bot message on every channel, as it did inside CONSENT_STOP,
 * but it is NOT an opt-out: it records no consent, never asks for a DNC lift,
 * and never stops a person from calling. Set by an opt-out rule, a rep taking
 * over, the hard DQ stop and a team note that says we cannot run the lead.
 */
export const BOT_STOP = Object.freeze(['stop-bot']);

/** Phone-only opt-outs: they block texts, calls and live chat, never email. */
export const PHONE_ONLY_CONSENT = Object.freeze([
  'dnc-sms', 'dnc-voice', 'lp-dnc', 'suppress:dnc-reply', 'suppress:dnc-voice',
]);

/** Email-only opt-outs: they block email and nothing else. */
export const EMAIL_ONLY_CONSENT = Object.freeze(['dnc-email']);

/** The system disqualified this lead. */
export const HARD_DQ = Object.freeze([
  'out-of-area',        // SERVICE_AREA_EXIT (rule 311)
  'dq-out-of-area',     // older out-of-area marker (lead selection, GHL)
  'dq-oa',              // short alias lead selection already honours
  'hard-disqualified',  // rules 276 / 313 / 352 / 353 (mobile home, lanai, height)
  'suppress-outbound',  // rule 311 and the hard-DQ closeout chain
]);

/** Pauses on unprompted messages; a lead who writes to us still gets an answer. */
export const OPERATIONAL_HOLD = Object.freeze([
  'quarantined',                       // Intake/Routing Layer (Phase 1)
  'cooling-active',                    // loss intelligence cooling window
  'cannot-afford:pursuing-assistance', // CANNOT_AFFORD hold (executeIssueHold)
  'active-entry:canvassing',           // a canvasser is working the door (2026-08-08)
  'phone-team',                        // an outside partner's phone team owns the lead (2026-10-21)
]);

/** Never a reason to withhold a message here (see header). */
export const NEVER_BLOCK = Object.freeze(['pause-workflow', 'suppress-automation', 'pause-bot']);

export const PURPOSES = Object.freeze(['reply', 'outreach', 'mutation']);

const CONSENT_SET = new Set(CONSENT_STOP);
const BOT_STOP_SET = new Set(BOT_STOP);
const PHONE_ONLY_SET = new Set(PHONE_ONLY_CONSENT);
const EMAIL_ONLY_SET = new Set(EMAIL_ONLY_CONSENT);
const HARD_DQ_SET = new Set(HARD_DQ);
const HOLD_SET = new Set(OPERATIONAL_HOLD);
const NEVER_SET = new Set(NEVER_BLOCK);

/** Which purposes each class blocks. */
const CLASS_BLOCKS = {
  consent_stop: new Set(['reply', 'outreach', 'mutation']),
  bot_stop: new Set(['reply', 'outreach', 'mutation']),
  hard_dq: new Set(['reply', 'outreach']),
  operational_hold: new Set(['outreach']),
};

function normTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map(t => String(t || '').trim().toLowerCase()).filter(Boolean);
}

/**
 * Does this consent tag apply to this channel? An unknown channel (null) is
 * treated as "could be any": every opt-out applies. That is the fail-closed
 * read for a route that cannot say which channel it will use.
 */
function consentAppliesTo(tag, channel) {
  if (!channel) return true;
  if (channel === 'email') return !PHONE_ONLY_SET.has(tag);
  return !EMAIL_ONLY_SET.has(tag); // sms, livechat, call, anything not email
}

function normChannel(channel) {
  const c = String(channel || '').trim().toLowerCase();
  if (!c) return null;
  if (c === 'sms' || c === 'email' || c === 'livechat' || c === 'call') return c;
  if (c === 'live_chat' || c === 'webchat' || c === 'chat') return 'livechat';
  return null;
}

/**
 * May we message this contact?
 *
 * @param {object} p
 * @param {string[]} p.tags     the contact's tags (any case)
 * @param {string}  [p.channel] 'sms' | 'email' | 'livechat' | 'call'; anything
 *                              else or absent → unknown (every opt-out applies)
 * @param {string}   p.purpose  'reply' | 'outreach' | 'mutation'; anything else
 *                              is treated as 'outreach' (the strictest message purpose)
 * @returns {{ allowed: boolean, reason: string, blockedBy: string|null,
 *             tagClass: string|null, matches: string[] }}
 *   reason: 'ok' | 'consent_stop' | 'bot_stop' | 'hard_dq' | 'operational_hold'
 */
export function mayMessage({ tags, channel = null, purpose = 'outreach' } = {}) {
  const t = normTags(tags);
  const ch = normChannel(channel);
  const p = PURPOSES.includes(purpose) ? purpose : 'outreach';

  const consent = t.filter(x => CONSENT_SET.has(x) && consentAppliesTo(x, ch));
  if (consent.length && CLASS_BLOCKS.consent_stop.has(p)) {
    return { allowed: false, reason: 'consent_stop', blockedBy: consent[0], tagClass: 'consent_stop', matches: consent };
  }
  const botStop = t.filter(x => BOT_STOP_SET.has(x));
  if (botStop.length && CLASS_BLOCKS.bot_stop.has(p)) {
    return { allowed: false, reason: 'bot_stop', blockedBy: botStop[0], tagClass: 'bot_stop', matches: botStop };
  }
  const dq = t.filter(x => HARD_DQ_SET.has(x));
  if (dq.length && CLASS_BLOCKS.hard_dq.has(p)) {
    return { allowed: false, reason: 'hard_dq', blockedBy: dq[0], tagClass: 'hard_dq', matches: dq };
  }
  const hold = t.filter(x => HOLD_SET.has(x));
  if (hold.length && CLASS_BLOCKS.operational_hold.has(p)) {
    return { allowed: false, reason: 'operational_hold', blockedBy: hold[0], tagClass: 'operational_hold', matches: hold };
  }
  return { allowed: true, reason: 'ok', blockedBy: null, tagClass: null, matches: [] };
}

/** Does this module have an opinion about this tag (a class, or never-block)? */
export function isKnownGateTag(tag) {
  const x = String(tag || '').trim().toLowerCase();
  return CONSENT_SET.has(x) || BOT_STOP_SET.has(x) || HARD_DQ_SET.has(x) || HOLD_SET.has(x) || NEVER_SET.has(x);
}

/**
 * The purpose an old suppression-check mode stood for. Kept exactly as the
 * modes behaved: 'direct_reply' (live chat) is a reply; 'agentic_reply' is a
 * reply only while agentic-active is on (otherwise the old code fell back to
 * the full outbound list); 'default' is outreach.
 */
export function purposeForLegacyMode(mode, tags) {
  if (mode === 'direct_reply') return 'reply';
  if (mode === 'agentic_reply' && normTags(tags).includes('agentic-active')) return 'reply';
  return 'outreach';
}

/** SEND_GATE_MODE: 'live' only when set to exactly that; everything else is shadow. */
export function sendGateMode(env = process.env) {
  return String(env?.SEND_GATE_MODE || '').trim().toLowerCase() === 'live' ? 'live' : 'shadow';
}

/**
 * Combine a route's old answer with mayMessage's. Pure.
 *
 * @param {object} p
 * @param {{blocked: boolean, tag?: string|null}} p.legacy  the route's old answer
 * @param {object} p.decision  mayMessage() result
 * @param {'shadow'|'live'} p.mode
 * @returns {{ blocked: boolean, tag: string|null, source: string,
 *             disagree: null|'would_block'|'would_allow' }}
 *   source: 'legacy' (shadow, or agreement), 'may_message' (live decided),
 *           'legacy_unclassified' (live, but the old block was on a tag
 *           mayMessage does not know — it stands).
 */
export function resolveGate({ legacy, decision, mode }) {
  const legacyBlocked = !!legacy?.blocked;
  const legacyTag = legacy?.tag || null;
  const newBlocked = decision ? !decision.allowed : legacyBlocked;
  let disagree = null;
  if (newBlocked && !legacyBlocked) disagree = 'would_block';
  if (!newBlocked && legacyBlocked) disagree = 'would_allow';

  if (mode !== 'live') {
    return { blocked: legacyBlocked, tag: legacyTag, source: 'legacy', disagree };
  }
  if (newBlocked) {
    return { blocked: true, tag: decision.blockedBy, source: 'may_message', disagree };
  }
  if (legacyBlocked && legacyTag && !isKnownGateTag(legacyTag)) {
    return { blocked: true, tag: legacyTag, source: 'legacy_unclassified', disagree };
  }
  return { blocked: false, tag: null, source: 'may_message', disagree };
}
