/**
 * Do-not-knock — src/agentic/do-not-knock.js
 *
 * 2026-10-03 (review of Part 14): a homeowner upset about a canvasser at the
 * door is not a sales lead. The planner's do-not-knock flow (nepq-planner.js)
 * asks for the address (and a name if none), then a card goes to the canvass
 * team. No sales call.
 *
 * Same day, the replay after #1159: "Please stop knocking on my door, your guy
 * was rude" got NO reply on either bot. The opt-out detector (isDNCSignal,
 * behavioral-emitter.js) read the "stop" as a text opt-out, so the SMS webhook
 * filed a DNC event and the live chat went silent, and the do-not-knock flow
 * never ran. Mark's ruling: "stop knocking / stop coming to my door" is NOT a
 * text opt-out; the bot replies and asks for the address. A plain STOP, or
 * "stop texting / calling / contacting me", stays an opt-out: anything that
 * names a messaging or calling channel keeps the opt-out.
 *
 * Pure and dependency-free: the opt-out gate imports it.
 */

// Door words only: "come to my house" is how a lead turns the VISIT down, and
// "nobody came" is a missed visit (a complaint, not a canvasser).
const KNOCK_RX = /\b(?:knock(?:ed|ing|s)?|door[-\s]?to[-\s]?door|canvass\w*|solicit\w*|(?:at|on|to|by)\s+(?:my|our)\s+(?:front\s+)?door)\b/i;
const KNOCK_UPSET_RX = /\b(?:stop|don'?t|do\s+not|never|no\s+more|again|keeps?\s+(?:coming|knocking)|harass\w*|trespass\w*|no\s+soliciting|annoy\w*|bother\w*|rude|aggressive|pushy|leave\s+(?:me|us)\s+alone|not\s+welcome|sign|complain\w*|unprofessional|ridiculous|private\s+property|woke|scared|scam\w*|manager|supervisor|terrible|worst)\b/i;
const MISSED_VISIT_RX = /\b(?:nobody|no\s+one|no-one|never|didn'?t|did\s+not)\s+(?:came|come|showed|show|arrived?)\b/i;

// Anything naming a way we reach them keeps the message an opt-out.
const MESSAGING_OPTOUT_RX = /\b(?:text(?:s|ing|ed)?|txt|messag\w*|sms|call(?:s|ing|ed)?|phone|contact\w*|e-?mail\w*|unsubscribe|opt[\s-]?out|remove\s+me|dnc|leave\s+(?:me|us)\s+alone|lose\s+my\s+number)\b/i;
const BARE_KEYWORD_RX = /^\s*(?:stop|end|cancel|quit|remove|unsubscribe)\s*[.!]?\s*$/i;

/** A homeowner upset about a canvasser at the door. Pure. */
export function isKnockComplaint(text) {
  const t = String(text || '');
  if (!KNOCK_RX.test(t) || MISSED_VISIT_RX.test(t)) return false;
  return KNOCK_UPSET_RX.test(t);
}

/**
 * A door complaint that is NOT a text/call opt-out (Mark, 2026-10-03): the bot
 * answers it. False for a bare keyword or anything naming texts, calls, email
 * or contact. Pure.
 */
export function isKnockNotOptOut(text) {
  const t = String(text || '');
  if (BARE_KEYWORD_RX.test(t)) return false;
  return isKnockComplaint(t) && !MESSAGING_OPTOUT_RX.test(t);
}
