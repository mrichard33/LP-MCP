// ─── Lead conversation stage — src/agentic/lead-stage.js ─────────────────────
//
// WHY (handoff "Lead Conversation Stage + chatbot fixes", 2026-10-12)
//   Three AIOS test batches (~35 conversations, live chat + SMS) reached ZERO
//   confirmed bookings while the simulator scorecard passed most of them. The
//   root cause is that nothing remembers where a conversation is:
//   planNepqTurn re-derives the stage from the thread by regex on every turn,
//   so a clear "yes, book it" that did not follow our bridge was never read as
//   a yes, and the bridge went out twice. A second stage system
//   (nepq-layer.js stageBlock, from the analyzer's buyer_stage) told the model
//   something else again.
//
//   This module is the ONE answer to "where is this conversation": the NEPQ
//   conversation stage (Jeremy Miner), persisted per lead. buyer_stage (the
//   Antifragile 5-stage journey) stays a separate axis and informs tone only.
//
// THE NEW-LEAD TRACK (one stage per turn unless the fast lane applies)
//   connection → situation → problem → consequence → qualifying → transition
//   → commitment_offered → slot_held → booked
//   Side states: objection:<type>, reschedule:<step>, handoff, opted_out,
//   disqualified_non_owner, disqualified_out_of_area. The rehash (post-demo)
//   track is recorded as rehash:<stage> from rehash-nepq.js, unchanged.
//
// RULES THAT ARE EASY TO BREAK
//   - "booked" is set ONLY from the real booking-created event (ctx.booked,
//     from ghl.appointment_booked), never from the model's wording.
//   - The main track never moves backward without a reason (an objection or a
//     reschedule): a lead answering a side question after we offered times is
//     still at commitment_offered.
//   - Ownership and decision makers are hard gates (no single-leg visits).
//   - Facts are short codes and the bot's own time labels. No customer free
//     text is ever stored (the tables hold reason codes only).
//
// PURE. No I/O. The store and the GHL mirror live in
// src/services/lead-stage-io.js.

import {
  BRIDGE_RX, YES_RX, SLOT_OFFER_RX, SCHEDULE_ASK_RX, TIME_REQUEST_RX, CONSEQUENCE_RX,
  isNo, objectionType, problemEcho, discoveryEarned, currentSession,
} from './nepq-planner.js';
import { heldSlot } from './booking-collect.js';
import { parseDayPreference } from './day-preference.js';
import { extractZip } from './service-area-turn.js';
import { homeownerFromThread, OWNER_ASK_RX } from './homeowner.js';
import { decisionMakersFromThread, qualifyingUnknowns } from './qualifying.js';

export { decisionMakersFromThread, qualifyingUnknowns };

// ── modes ────────────────────────────────────────────────────────────────

export const LEAD_STAGE_MODES = Object.freeze(['off', 'shadow', 'live']);

/**
 * LEAD_STAGE_MODE off|shadow|live, default shadow; a typo is shadow.
 * shadow: compute, store, mirror to GHL and show; the planner ignores it.
 * live:   the planner and the prompt read it (PR 2 onward).
 */
export function leadStageMode(env = process.env) {
  const raw = String(env.LEAD_STAGE_MODE ?? '').trim().toLowerCase();
  return LEAD_STAGE_MODES.includes(raw) ? raw : 'shadow';
}

// ── the model ────────────────────────────────────────────────────────────

export const TRACKS = Object.freeze({ NEW_LEAD: 'new_lead', REHASH: 'rehash' });

/** The new-lead track, in order. The index is the rank. */
export const NEW_LEAD_STAGES = Object.freeze([
  'connection', 'situation', 'problem', 'consequence', 'qualifying',
  'transition', 'commitment_offered', 'slot_held', 'booked',
]);

/** Side states. objection and reschedule carry a detail after a colon. */
export const SIDE_STATES = Object.freeze([
  'objection', 'reschedule', 'handoff', 'opted_out', 'disqualified_non_owner', 'disqualified_out_of_area',
]);

export const OBJECTION_TYPES = Object.freeze(['price', 'shopping', 'spouse', 'think', 'competitor']);
export const RESCHEDULE_STEPS = Object.freeze(['offered', 'held', 'moved']);

/**
 * Stage key → the exact NEPQ Stage dropdown label in GHL (contact.nepq_stage).
 * Mark set the dropdown to exactly these 16 labels (2026-10-12). Detail
 * (objection type, reschedule step, rehash step) lives in Supabase only.
 */
export const STAGE_GHL_LABEL = Object.freeze({
  connection: 'Connection',
  situation: 'Situation',
  problem: 'Problem',
  consequence: 'Consequence',
  qualifying: 'Qualifying',
  transition: 'Transition',
  commitment_offered: 'Times Offered',
  slot_held: 'Time Held',
  booked: 'Booked',
  objection: 'Objection',
  reschedule: 'Reschedule',
  handoff: 'Handoff',
  opted_out: 'Opted Out',
  disqualified_non_owner: 'Not Owner',
  disqualified_out_of_area: 'Out of Area',
  rehash: 'Rehash',
});

/** The 16 labels, in dropdown order. */
export const GHL_STAGE_LABELS = Object.freeze([...new Set(Object.values(STAGE_GHL_LABEL))]);

/** "objection:price" → "objection". Pure. */
export function stageBase(stage) {
  return String(stage || '').split(':')[0];
}

/** The GHL dropdown label for a stage key, or null for an unknown key. Pure. */
export function ghlLabelFor(stage) {
  return STAGE_GHL_LABEL[stageBase(stage)] || null;
}

/** Rank on the new-lead track, or -1 for a side state / rehash stage. Pure. */
export function stageRank(stage) {
  return NEW_LEAD_STAGES.indexOf(String(stage || ''));
}

/** Is this a known stage key (track stage, side state with a valid detail, or rehash:*)? Pure. */
export function isValidStage(stage) {
  const s = String(stage || '');
  if (NEW_LEAD_STAGES.includes(s)) return true;
  const [base, detail] = s.split(':');
  if (base === 'objection') return OBJECTION_TYPES.includes(detail);
  if (base === 'reschedule') return RESCHEDULE_STEPS.includes(detail);
  if (base === 'rehash') return !!detail;
  return SIDE_STATES.includes(s);
}

/**
 * Allowed moves out of each new-lead stage (the handoff's table), besides the
 * side states, which any stage may enter. Forward skips are the fast lane.
 */
export const TRANSITIONS = Object.freeze({
  connection: ['situation', 'problem', 'consequence', 'qualifying', 'transition', 'commitment_offered', 'slot_held'],
  situation: ['problem', 'consequence', 'qualifying', 'transition', 'commitment_offered', 'slot_held'],
  problem: ['consequence', 'qualifying', 'transition', 'commitment_offered', 'slot_held'],
  consequence: ['qualifying', 'transition', 'commitment_offered', 'slot_held'],
  qualifying: ['transition', 'commitment_offered', 'slot_held'],
  transition: ['commitment_offered', 'slot_held'],
  commitment_offered: ['slot_held', 'commitment_offered'],
  slot_held: ['booked', 'commitment_offered'],
  booked: [],
});

/**
 * May the stage move from `from` to `to`? `booked` is reachable from any stage
 * (the booking event is the authority). A side state may be entered from
 * anywhere and left to any track stage. Backward moves on the track need an
 * objection or reschedule reason (slot_held → commitment_offered is the
 * one built in: the held time was taken and two new ones offered). Pure.
 */
export function isAllowedTransition(from, to) {
  if (!from || from === to) return true;
  if (to === 'booked') return true;
  const fb = stageBase(from);
  const tb = stageBase(to);
  if (SIDE_STATES.includes(tb) || tb === 'rehash') return true;
  if (SIDE_STATES.includes(fb) || fb === 'rehash') return true;
  return (TRANSITIONS[from] || []).includes(to);
}

// ── reading the thread ───────────────────────────────────────────────────

// An explicit opt-out. A bare "cancel" is NOT here: in live chat it cancels an
// appointment. "Stop knocking" is not here either (do-not-knock.js).
const OPT_OUT_RX = /^\s*(?:stop|stopall|stop\s+all|unsubscribe|quit|end)\s*[.!]*\s*$|\bleave\s+me\s+alone\b|\bstop\s+(?:texting|messaging|contacting|calling|emailing)\s+(?:me|us)\b|\b(?:remove|take)\s+me\s+(?:off|from)\b|\b(?:do\s+not|don'?t|dont)\s+(?:text|contact|call|message|email)\s+(?:me|us)\b/i;

// Our own asks that belong to the qualifying stage (by meaning).
const ZIP_ASK_RX = /\bzip(?:\s*code)?\b[^?]*\?/i;
const DM_ASK_RX = /(?:\b(?:anyone|anybody|someone)\s+else\b|\bpart\s+of\s+the\s+decision\b|\bweigh\s+in\b|\bwho\s+(?:else\s+)?(?:decides|makes\s+the\s+decision)\b|\bable\s+to\s+(?:be\s+there|make\s+it)\b)[^?]*\?/i;
// A street address the lead typed: a number then a street word.
const ADDRESS_RX = /\b\d{2,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z0-9'.]+(?:\s+[A-Za-z0-9'.]+){0,3}\s+(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|cir|circle|way|pl|place|ter|terrace|pkwy|parkway|hwy|highway|trl|trail|loop|run|pt|point)\b/i;
// Our bot's own time label inside an offer ("Thu, Oct 15 at 10:00 AM ET").
const SLOT_LABEL_RX = /\b(?:today|tomorrow|(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?(?:,?\s+[A-Z][a-z]{2}\.?\s+\d{1,2})?)\s+at\s+\d{1,2}(?::\d{2})?\s*(?:AM|PM)(?:\s+[A-Z]{2,3})?\b/gi;

function normalize(conversation, trigger, reply) {
  const turns = currentSession(conversation)
    .map(m => ({ direction: String(m?.direction || '').toLowerCase() === 'outbound' ? 'outbound' : 'inbound', text: String(m?.text ?? m?.body ?? '') }))
    .filter(m => m.text.trim());
  const last = turns[turns.length - 1];
  if (trigger && !(last && last.direction === 'inbound' && last.text === trigger)) turns.push({ direction: 'inbound', text: String(trigger) });
  if (reply && String(reply).trim()) turns.push({ direction: 'outbound', text: String(reply) });
  return turns;
}

/** Is this message an explicit opt-out? Pure. */
export function isOptOut(text) {
  return OPT_OUT_RX.test(String(text || ''));
}

/** The bot's own slot labels in a message ("tomorrow at 10:00 AM ET"). Pure. */
export function slotLabelsIn(text) {
  return [...String(text || '').matchAll(SLOT_LABEL_RX)].map(m => m[0].replace(/\s+/g, ' ').trim()).slice(0, 4);
}

/** The newest stated day / part-of-day preference label, or null. Pure. */
function preferenceFrom(inbound) {
  for (let i = inbound.length - 1; i >= 0; i--) {
    const p = parseDayPreference(inbound[i]);
    if (p) return p.label;
  }
  return null;
}

/** The newest offer of times we sent, as labels; else the plan's. Pure. */
function latestOffer(outbound, plan) {
  for (let i = outbound.length - 1; i >= 0; i--) {
    if (SLOT_OFFER_RX.test(outbound[i])) {
      const labels = slotLabelsIn(outbound[i]);
      if (labels.length) return labels;
    }
  }
  const fromPlan = (plan?.slots_to_offer || []).slice(0, 2).map(s => `${s.rel || s.day} at ${s.time}${s.tz ? ` ${s.tz}` : ''}`);
  return fromPlan.length ? fromPlan : [];
}

/**
 * The facts this conversation has established. Short codes and the bot's own
 * time labels only. Pure.
 */
export function readFacts({ turns, plan = null, ctx = {}, stored = null }) {
  const inbound = turns.filter(t => t.direction === 'inbound').map(t => t.text);
  const outbound = turns.filter(t => t.direction === 'outbound').map(t => t.text);
  const prev = stored?.facts || {};
  let zip = ctx.zip || null;
  for (let i = inbound.length - 1; i >= 0 && !zip; i--) zip = extractZip(inbound[i]);
  let nos = plan?.counters?.nos_in_a_row;
  if (!Number.isFinite(nos)) {
    nos = 0;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].direction !== 'inbound') continue;
      const prevOut = [...turns.slice(0, i)].reverse().find(x => x.direction === 'outbound')?.text || '';
      if (isNo(turns[i].text, prevOut)) nos++; else break;
    }
  }
  const lastOut = outbound[outbound.length - 1] || '';
  const offered = latestOffer(outbound, plan);
  const held = heldSlot(turns);
  const homeowner = homeownerFromThread(turns);
  const dm = decisionMakersFromThread(turns);
  return {
    problem_word: problemEcho(turns.filter(t => t.direction === 'inbound')) || prev.problem_word || null,
    consequence_answered: discoveryEarned(turns).consequence || !!prev.consequence_answered,
    // A stored answer stands until the thread says otherwise (a new session
    // drops the old turns, not what the lead told us).
    homeowner: homeowner !== 'unknown' ? homeowner : (prev.homeowner || 'unknown'),
    decision_makers: dm !== 'unknown' ? dm : (prev.decision_makers || 'unknown'),
    zip: zip || prev.zip || null,
    market: ctx.market || prev.market || null,
    tz: ctx.tz || prev.tz || null,
    latest_offered_slots: offered.length ? offered : (prev.latest_offered_slots || []),
    held_slot: held?.text || null,
    preference: preferenceFrom(inbound) || prev.preference || null,
    objection: plan?.objection?.type || null,
    nos_in_a_row: nos,
    address_given: inbound.some(t => ADDRESS_RX.test(t)) || !!prev.address_given,
    bridge_sent: outbound.some(t => BRIDGE_RX.test(t)) || !!prev.bridge_sent,
    last_out_bridge: BRIDGE_RX.test(lastOut),
  };
}

/** Did the lead signal they are ready (the fast lane)? Pure. */
export function readySignal(turns) {
  const lastIn = [...turns].reverse().find(t => t.direction === 'inbound');
  if (!lastIn) return null;
  const idx = turns.lastIndexOf(lastIn);
  const prevOut = [...turns.slice(0, idx)].reverse().find(t => t.direction === 'outbound')?.text || '';
  const t = lastIn.text;
  if (SCHEDULE_ASK_RX.test(t)) return 'schedule_ask';
  if (TIME_REQUEST_RX.test(t)) return 'typed_time';
  if (ADDRESS_RX.test(t)) return 'address_given';
  // A yes to ANY offer of ours: the bridge, a time offer, a question about a visit.
  if (YES_RX.test(t) && (BRIDGE_RX.test(prevOut) || SLOT_OFFER_RX.test(prevOut) || /\b(?:visit|come\s+out|measure|appointment|would\s+that\s+help)\b/i.test(prevOut))) return 'yes_to_offer';
  return null;
}

/**
 * Where the main track stands after this turn, from the thread alone. Returns
 * { stage, reason }. Pure.
 */
function deriveTrackStage({ turns, plan, facts }) {
  const outbound = turns.filter(t => t.direction === 'outbound').map(t => t.text);
  const inbound = turns.filter(t => t.direction === 'inbound').map(t => t.text);
  const lastOut = outbound[outbound.length - 1] || '';
  if (facts.held_slot) return { stage: 'slot_held', reason: 'slot_held' };
  if (SLOT_OFFER_RX.test(lastOut) || (plan?.slots_to_offer || []).length >= 2 || plan?.step === 'offer_slots') {
    return { stage: 'commitment_offered', reason: 'slots_offered' };
  }
  if (BRIDGE_RX.test(lastOut) || plan?.required_move === 'bridge') return { stage: 'transition', reason: 'bridge' };
  if (OWNER_ASK_RX.test(lastOut) || DM_ASK_RX.test(lastOut) || (ZIP_ASK_RX.test(lastOut) && !/\bstreet\b/i.test(lastOut))) {
    return { stage: 'qualifying', reason: 'qualifying_ask' };
  }
  const ready = readySignal(turns);
  if (ready) return { stage: 'qualifying', reason: `fast_lane:${ready}` };
  if (facts.consequence_answered || plan?.required_move === 'consequence' || CONSEQUENCE_RX.test(lastOut)) {
    return { stage: 'consequence', reason: 'consequence' };
  }
  if (facts.problem_word || plan?.probe_for === 'why_it_matters') return { stage: 'problem', reason: 'problem_named' };
  if (inbound.length >= 2 && outbound.some(t => t.includes('?'))) return { stage: 'situation', reason: 'situation' };
  return { stage: 'connection', reason: 'connection' };
}

/**
 * Compute this turn's conversation stage.
 *
 * @param {object} a
 * @param {object|null} a.stored     the stored row ({ stage, track, facts }) or null (first touch)
 * @param {Array} a.conversation     the thread, oldest first ({direction, text})
 * @param {string} [a.trigger]       the lead's newest message
 * @param {string} [a.reply]         what the bot sent this turn (the stage is where we are AFTER it)
 * @param {object|null} [a.plan]     the NEPQ plan this turn, when one was made
 * @param {object} [a.ctx]           { booked, optedOut, outOfArea, rehash, rehashStage, zip, market, tz, channel }
 * @returns {{ stage, track, facts, reason, from, changed }}
 */
export function computeStage({ stored = null, conversation = [], trigger = '', reply = '', plan = null, ctx = {} } = {}) {
  const turns = normalize(conversation, trigger, reply);
  const facts = readFacts({ turns, plan, ctx, stored });
  const from = stored?.stage || null;
  const done = (stage, reason, track = TRACKS.NEW_LEAD, extra = {}) => {
    const out = { stage, track, facts: { ...facts, ...extra }, reason: from ? reason : `first_touch:${reason}`, from };
    out.changed = out.stage !== from;
    return out;
  };
  const lastIn = [...turns].reverse().find(t => t.direction === 'inbound')?.text || '';

  // 1. The booking event is the authority.
  if (ctx.booked) return done('booked', 'booking_event');
  // 2. An opt-out silences the conversation.
  if (ctx.optedOut || isOptOut(lastIn)) return done('opted_out', 'opt_out');
  // 3. Hard gates: not the owner, out of the service area.
  if (facts.homeowner === 'no') return done('disqualified_non_owner', 'not_owner');
  if (ctx.outOfArea) return done('disqualified_out_of_area', 'out_of_area');
  // 4. The rehash track: recorded, never changed (rehash-nepq.js decides).
  if (ctx.rehash || plan?.post_demo) {
    const step = ctx.rehashStage || plan?.rehash_stage || 'connection';
    return done(`rehash:${step}`, 'rehash', TRACKS.REHASH);
  }
  // Sticky terminal states hold until the lead re-engages.
  const storedBase = stageBase(from);
  if (storedBase === 'booked' && !ctx.reschedule) return done('booked', 'no_change');
  if (storedBase === 'opted_out' && !readySignal(turns)) return done('opted_out', 'no_change');
  // 5. A hand-off, or two no's in a row.
  if (plan?.handoff) return done('handoff', `handoff:${plan.handoff.reason}`, TRACKS.NEW_LEAD, { return_to: returnTo(stored) });
  if (facts.nos_in_a_row >= 2) return done('handoff', 'two_nos', TRACKS.NEW_LEAD, { return_to: returnTo(stored) });
  // 6. A reschedule (PR 5 fills the steps; recorded as given).
  if (ctx.reschedule && RESCHEDULE_STEPS.includes(ctx.reschedule)) {
    return done(`reschedule:${ctx.reschedule}`, `reschedule:${ctx.reschedule}`, TRACKS.NEW_LEAD, { return_to: returnTo(stored) });
  }
  // 7. An objection this turn.
  const lastOutBefore = (() => {
    const i = turns.map(t => t.direction).lastIndexOf('inbound');
    return [...turns.slice(0, i)].reverse().find(t => t.direction === 'outbound')?.text || '';
  })();
  const obj = plan?.objection?.type || objectionType(lastIn, lastOutBefore);
  if (obj && OBJECTION_TYPES.includes(obj)) {
    return done(`objection:${obj}`, `objection:${obj}`, TRACKS.NEW_LEAD, { return_to: returnTo(stored), objection: obj });
  }
  // 8. The main track: never backward without a reason.
  const derived = deriveTrackStage({ turns, plan, facts });
  const base = baseForTrack(stored);
  // slot_held → commitment_offered is allowed: the held time was replaced by a new offer.
  if (base && stageRank(derived.stage) < stageRank(base) && !(base === 'slot_held' && derived.stage === 'commitment_offered')) {
    const resumed = SIDE_STATES.includes(storedBase);
    return done(base, resumed ? 'returned_from_side_state' : 'no_change');
  }
  return done(derived.stage, derived.reason);
}

/** The reschedule step a live-chat cancel-flow outcome stands for, or null. Pure. */
export function rescheduleStepFor(outcome) {
  if (outcome === 'offered_slots') return 'offered';
  if (outcome === 'rescheduled' || outcome === 'would_reschedule') return 'moved';
  return null;
}

/** The track stage a side state returns to. Pure. */
function returnTo(stored) {
  if (!stored?.stage) return null;
  if (stageRank(stored.stage) >= 0) return stored.stage;
  return stored.facts?.return_to || null;
}

/** The track stage this turn may not fall below. Pure. */
function baseForTrack(stored) {
  if (!stored?.stage) return null;
  if (stageRank(stored.stage) >= 0) return stored.stage;
  const back = stored.facts?.return_to;
  return stageRank(back) >= 0 ? back : null;
}

/**
 * Write the GHL label only when it changes, and only a label the live
 * dropdown carries (when the live options are known). Pure.
 * @returns {{ write: boolean, value: string|null, why: string }}
 */
export function ghlLabelWrite(prevLabel, nextLabel, liveOptions = null) {
  if (!nextLabel) return { write: false, value: null, why: 'no_label' };
  if (prevLabel === nextLabel) return { write: false, value: nextLabel, why: 'unchanged' };
  if (Array.isArray(liveOptions) && liveOptions.length && !liveOptions.includes(nextLabel)) {
    return { write: false, value: nextLabel, why: 'not_in_live_options' };
  }
  return { write: true, value: nextLabel, why: 'changed' };
}

/** Labels we write that the live dropdown lacks, and live options we never write. Pure. */
export function labelDifference(liveOptions = []) {
  const live = Array.isArray(liveOptions) ? liveOptions : [];
  return {
    missing_in_ghl: GHL_STAGE_LABELS.filter(l => !live.includes(l)),
    extra_in_ghl: live.filter(l => !GHL_STAGE_LABELS.includes(l)),
  };
}

/**
 * The compact, in-memory input the reply path hands to the recorder after the
 * send (never persisted as such: only computeStage's codes and the bot's own
 * time labels are stored). Pure.
 */
export function buildStageInput({
  conversation = [], trigger = '', plan = null, zip = null, market = null, tz = null,
  outOfArea = false, rehash = false, buyerStage = null, channel = null, reschedule = null,
} = {}) {
  const thread = (Array.isArray(conversation) ? conversation : []).slice(-30).map(m => ({
    direction: String(m?.direction || '').toLowerCase() === 'outbound' ? 'outbound' : 'inbound',
    text: String(m?.text ?? m?.body ?? ''),
    timestamp: m?.timestamp || m?.sent_at || m?.dateAdded || m?.created_at || null,
  }));
  const p = plan ? {
    step: plan.step || null,
    required_move: plan.required_move || null,
    objection: plan.objection?.type ? { type: plan.objection.type } : null,
    handoff: plan.handoff?.reason ? { reason: plan.handoff.reason } : null,
    counters: plan.counters || null,
    probe_for: plan.probe_for || null,
    slots_to_offer: (plan.slots_to_offer || []).slice(0, 2).map(s => ({ day: s.day || null, rel: s.rel || null, time: s.time || null, tz: s.tz || null })),
    post_demo: !!plan.post_demo,
    rehash_stage: plan.rehash_stage || null,
  } : null;
  return {
    conversation: thread,
    trigger: String(trigger || ''),
    plan: p,
    ctx: { zip: zip || null, market: market || null, tz: tz || null, outOfArea: !!outOfArea, rehash: !!rehash, channel, ...(RESCHEDULE_STEPS.includes(reschedule) ? { reschedule } : {}) },
    buyerStage: buyerStage ?? null,
  };
}
