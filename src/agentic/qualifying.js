// ─── The qualifying gate — src/agentic/qualifying.js ────────────────────────
//
// WHY (handoff "Lead Conversation Stage", 2026-10-12; the user's ruling the
// same day): Reece does not run single-leg visits. With LEAD_STAGE_MODE=live
// no visit times are offered until the lead owns the home and every decision
// maker is either the lead alone or named AND able to be there. Batch 3 test 3
// offered a renter times twice; a lead who said "my wife will be there" was
// asked about the spouse again.
//
// This file says what is still unknown, in the order it is asked (one item per
// message), and reads the decision-maker answer. Shared by the stage recorder
// (lead-stage.js) and the planner (nepq-planner.js); it imports neither.
//
// PURE. No I/O.

import { dmAnswerFromThread, parseDecisionMakers } from './booking-collect.js';

// "My wife will be there", "she'll be home", "we'll both be there".
const DM_PRESENT_RX = /\b(?:wife|husband|spouse|partner|fianc[eé]e?|she|he|they|we)(?:'ll|\s+will|\s+can|\s+should)?\s+(?:both\s+)?(?:be\s+(?:there|home|here|available)|make\s+it|join)\b|\bboth\s+(?:of\s+us\s+)?(?:be\s+)?(?:there|home)\b|\bwe'?ll\s+both\b/i;

/**
 * 'unknown' | 'sole' | 'named' | 'named_present' | 'named_absent'. The answer
 * to our decision-maker ask wins; otherwise what the lead volunteered (newest
 * first). Turns are {direction, text}, oldest first. Pure.
 */
// Our presence questions (PR 2's qualify lines read back by meaning): "Will
// they be able to make it to the visit too?" and "What day works best when
// you can both be there?". A yes or a day to either means present; a no means
// absent. dmAnswerFromThread reads a bare "no" as "Solo Owner", which is right
// for "anyone else?" and wrong here.
const PRESENCE_ASK_RX = /\bable\s+to\s+(?:be\s+there|make\s+it)\b[^?]*\?|\bjoin\s+you\b[^?]*\?/i;
const BOTH_DAY_ASK_RX = /\bboth\s+(?:of\s+you\s+)?(?:be\s+there|be\s+home|make\s+it)\b[^?]*\?/i;
const NEGATIVE_RX = /^\s*(?:no(?:pe)?|nah|not\s+(?:really|likely|sure)|probably\s+not|(?:she|he|they)\s+(?:can'?t|won'?t|cannot))\b/i;

/** The reply to our newest presence question, read as present / absent, or null. Pure. */
function presenceAnswer(list) {
  for (let k = list.length - 1; k >= 0; k--) {
    if (list[k].direction !== 'outbound') continue;
    const t = String(list[k].text || '');
    const presence = PRESENCE_ASK_RX.test(t);
    const bothDay = BOTH_DAY_ASK_RX.test(t);
    if (!presence && !bothDay) continue;
    const reply = list.slice(k + 1).find(m => m.direction !== 'outbound');
    if (!reply) return null;
    const r = String(reply.text || '');
    if (parseDecisionMakers(r) === 'conflict' || NEGATIVE_RX.test(r)) return 'named_absent';
    return 'named_present';
  }
  return null;
}

export function decisionMakersFromThread(turns = []) {
  const list = Array.isArray(turns) ? turns : [];
  const presence = presenceAnswer(list);
  if (presence) return presence;
  const ans = dmAnswerFromThread(list);
  const inbound = list.filter(t => t.direction !== 'outbound').map(t => String(t.text || ''));
  const volunteeredPresent = inbound.some(t => DM_PRESENT_RX.test(t));
  if (ans === 'Solo Owner') return 'sole';
  if (ans === 'conflict') return 'named_absent';
  if (ans === 'Yes') return volunteeredPresent ? 'named_present' : 'named';
  for (let i = inbound.length - 1; i >= 0; i--) {
    const t = inbound[i];
    if (parseDecisionMakers(t) === 'conflict') return 'named_absent';
    if (DM_PRESENT_RX.test(t)) return 'named_present';
  }
  return 'unknown';
}

/** Is the decision-maker gate satisfied? Pure. */
export function dmSettled(status) {
  return status === 'sole' || status === 'named_present';
}

/** Items the qualifying gate still needs, in the order they are asked. Pure. */
export function qualifyingUnknowns(facts = {}) {
  const out = [];
  if (facts.homeowner !== 'yes') out.push('homeowner');
  if (!facts.zip) out.push('zip');
  if (!dmSettled(facts.decision_makers)) out.push('decision_makers');
  return out;
}
