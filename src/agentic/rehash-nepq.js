// ─── Post-demo NEPQ track — src/agentic/rehash-nepq.js ──────────────────────
//
// WHY (handoff "Rehash bot: post-demo NEPQ + call scheduling", 2026-10-11)
//   A rehash lead (tag active-f.0 or rehash, or texting the rehash line) got
//   the NEW-LEAD NEPQ stage block: fixture 40 rendered "STAGE: CONNECTION —
//   What got you looking at the windows now?" right above the rehash block
//   that bans every windows question. Two instructions, opposite answers, and
//   the model picked one per turn. The lead already had the demo and holds a
//   proposal: the questions are about the PROPOSAL and the decision, and the
//   one goal is a phone call with the rep, framed as making sure they get the
//   best deal possible.
//
//   This module replaces the stage play for those leads, and only that:
//   nepq-layer.js renders it instead of stageBlock / objectionBlock /
//   disciplineBlock / the visit disclosure. The tone rules stay shared.
//
// THE TRACK (one stage per turn, never skip to the pitch)
//   connection → situation → problem → solution → bridge → schedule
//   Objections are asked back, never rebutted, then bridged. Two no's in a row
//   stop the asking. A follow-up date or "we signed elsewhere" is the post-demo
//   planner's turn (post-demo-turn.js); this block only says so.
//
// PURE. No I/O.

import { isNotInterested } from './not-interested.js';
import { detectDeferral, isLeadCloser } from './post-demo-turn.js';
import { PURCHASED_ELSEWHERE_RX } from './purchased-elsewhere.js';
import { simModeOverrides } from '../simulator/sim-overrides.js';
import { rehashBookingFix } from './rehash-flags.js';

// ── A better deal, hinted on every reply (Mark, 2026-10-19, ruling 4) ──────
// REHASH_DEAL_HINT_MODE=every: every rehash reply hints that we may be able to
// make it work better for them, never naming it (no amount, %, discount,
// promotion, financing term or deadline). This SUPERSEDES "the best deal
// possible, once per conversation" (2026-10-11) in that mode only; `once` (the
// default) is today's behaviour. No hint on a stop, a close or sign-off, room
// asked for, a deferral, "we signed elsewhere", a confirmed call, an opt-out,
// or a first no (door_open). The wording varies and never repeats an opener
// already sent in the thread. The bridge becomes "If I could …, would you …?"
// (ruling 3). Plain strings, no new pattern: hasRehashHint reads them back.
export const REHASH_DEAL_HINT_MODES = Object.freeze(['once', 'every']);
export const REHASH_HINT_LINES = Object.freeze([
  "I want to make sure you're getting the best deal possible.",
  "I'd like to see if I can make this work better for you.",
  'There may be a way to make the numbers work better for you.',
  'I may be able to do a little more for you on this.',
  "I'd love to see if there's a way to make this easier on your budget.",
  'Let me see what I can do to make this work for you.',
]);
export const NO_HINT_STEPS = Object.freeze(new Set([
  'post_demo_stop', 'post_demo_close', 'closer', 'post_demo_space', 'sign_off', 'competitor_signed',
  'signed_elsewhere', 'defer', 'follow_up_date', 'rehash_confirm', 'opt_out', 'stop', 'door_open',
]));

/** REHASH_DEAL_HINT_MODE (a bot-gate run may force it). once | every. */
export function rehashDealHintMode(env = process.env) {
  const v = String(simModeOverrides().rehashDealHintMode ?? env?.REHASH_DEAL_HINT_MODE ?? '').trim().toLowerCase();
  return REHASH_DEAL_HINT_MODES.includes(v) ? v : 'once';
}

const hintNorm = (s) => String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const HINT_NORMS = REHASH_HINT_LINES.map(l => hintNorm(l).replace(/^i want to make sure /, ''));

/** A sentence that carries one of our hint lines (or "best deal"). Pure. */
export function hasRehashHint(text) {
  const t = hintNorm(text);
  return /\bbest deal\b/.test(t) || HINT_NORMS.some(h => t.includes(h));
}

/** A hint line whose opening words we have not sent in this thread. Pure. */
export function pickRehashHint(recentOutbound = [], seed = 0) {
  const sent = (Array.isArray(recentOutbound) ? recentOutbound : []).map(hintNorm);
  const opener = (l) => hintNorm(l).split(' ').slice(0, 4).join(' ');
  const fresh = REHASH_HINT_LINES.filter(l => !sent.some(t => t.includes(opener(l))));
  const pool = fresh.length ? fresh : REHASH_HINT_LINES;
  return pool[Math.abs(Number(seed) || 0) % pool.length];
}

/** The hint for this turn, or null (once mode, a no-hint step, a turn that asks nothing). Pure. */
export function rehashHintFor({ step = null, stage = null, noQuestion = false, recentOutbound = [], seed = 0, mode = 'once' } = {}) {
  if (mode !== 'every' || noQuestion) return null;
  if ((step && NO_HINT_STEPS.has(step)) || (stage && NO_HINT_STEPS.has(stage))) return null;
  return pickRehashHint(recentOutbound, seed);
}

/** The "If I could …, would you …?" bridge to the call (ruling 3). Pure. */
export function rehashIfICouldBridge(repName = null) {
  return `If I could make this work better for you, would you be open to a quick call${repName ? ` with ${repName}` : ''}?`;
}

/** The hint (Mark's framing). Said at most once per conversation, at the bridge. */
export const BEST_DEAL_RX = /\bbest\s+deal\b/i;
// Our bridge to the call, read back by meaning (the model words it). The
// first live simulation (2026-10-11) bridged in one message ("best deal
// possible") and asked nothing until the next, so a "yes" two messages later
// still answers it.
export const REHASH_BRIDGE_RX = /\bbest\s+deal\b|\bmay\s+be\s+able\s+to\s+do\s+something\b|\bquick\s+call\b[^.!]*\?/i;

/** Did one of our last two messages bridge to the call? Pure. */
export function bridgedRecently(outboundTexts = []) {
  return (Array.isArray(outboundTexts) ? outboundTexts : []).slice(-2).some(t => REHASH_BRIDGE_RX.test(String(t || '')));
}

/** Stages where "best deal" may not be said yet (only at the bridge). */
export const PRE_BRIDGE_STAGES = Object.freeze(new Set(['connection', 'situation', 'problem', 'solution', 'objection', 'door_open', 'closer', 'stop', 'signed_elsewhere', 'follow_up_date']));

// Each stage, the question that IS that stage, and how we recognise it in our
// own earlier messages (the model words it, so we read it back by meaning).
// The post-demo planner's own questions (POST_DEMO_QUESTIONS) count too.
// `answeredRx` is what the LEAD says that already answers the stage (Tatyana,
// 2026-10-17: "finish my bathroom remodel first … done by January" still got
// "Where are you at with it?"). A stage answered is never asked.
export const REHASH_STAGES = Object.freeze([
  {
    key: 'connection', label: 'CONNECTION', aim: 'about the proposal, not the windows',
    example: 'Did you get a chance to look over the proposal?',
    // 2026-10-16: the model's own "Did you get a chance to look it over?" (no
    // "proposal") is the same question; reading it back stops a repeat.
    answeredRx: /\b(?:looked|read|went)\s+(?:it\s+|them\s+)?(?:over|through)\b|\bgot\s+the\s+proposal\b|\breviewed\b/i,
    rx: /\b(?:look(?:ed)?\s+(?:it\s+)?over|chance\s+to\s+(?:look|review|go\s+(?:over|through))|had\s+a\s+(?:chance|minute)|get\s+a\s+(?:chance|minute))\b[^?]*\bproposal\b|\bproposal\b[^?]*\b(?:look(?:ed)?\s+over|review(?:ed)?)\b|\bchance\s+to\s+(?:look\s+(?:it|that|them)\s+over|review\s+(?:it|that)|go\s+(?:over|through)\s+(?:it|that))\b/i,
  },
  {
    key: 'situation', label: 'SITUATION', aim: 'where they are in the decision',
    example: 'Where are you at with it?',
    answeredRx: /\bstill\s+(?:getting|comparing|evaluating|deciding|thinking|looking|waiting)\b|\bno\s+decisions?\b|\bhaven(?:'|’)?t\s+decided\b|\bfinish(?:ing)?\s+(?:the|my|our)\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december|spring|summer|fall|winter|holidays)\b|\bplanning\s+stage\b/i,
    rx: /\bwhere\s+(?:are\s+you|you(?:'|’)?re|do\s+you\s+stand|are\s+you\s+landing|you\s+at)\b|\bwhere\s+(?:things|it)\s+(?:stand|stands|is)\b|\blanding\s+on\s+the\s+proposal\b/i,
  },
  {
    key: 'problem', label: 'PROBLEM / CLARIFY', aim: 'what is holding them back',
    example: "What's holding you back, just so I understand?",
    rx: /\bholding\s+you\s+back\b|\bwhat(?:'|’)?s\s+(?:stopping|giving\s+you\s+pause|making\s+you\s+hesitate)\b|\bstill\s+weighing\b|\bon\s+the\s+fence\b/i,
  },
  {
    key: 'solution', label: 'SOLUTION AWARENESS', aim: 'what would make it work for them',
    example: 'What would you need to see to feel good moving forward?',
    rx: /\bwhat\s+would\s+you\s+need\b|\bfeel\s+good\s+(?:about\s+)?(?:moving\s+forward|going\s+ahead)\b|\bwhat\s+would\s+make\s+(?:this|it)\s+(?:an\s+easy|easier|work)\b|\beasy\s+decision\b/i,
  },
  {
    key: 'bridge', label: 'BRIDGE + COMMITMENT', aim: 'hint that something may be possible, and ask for the call',
    example: "I want to make sure you're getting the best deal possible. I may be able to do something for you, it's just easier on a quick call. Would that help?",
    rx: /\bbest\s+deal\b|\bmay\s+be\s+able\s+to\s+do\s+something\b|\bquick\s+call\b[^.!]*\?/i,
  },
]);

// Our own ask-back to an objection, read back by meaning.
const ASK_BACK_RX = /\bcompared\s+to\s+what\b|\bhow\s+do\s+(?:they|their|the\s+(?:numbers|quotes?))\s+compare\b|\bwhat\s+part\b[^?]*\bthink\b|\bwhat\s+do\s+you\s+think\s+(?:they|she|he)(?:'|’)?(?:ll|\s+will)\s+want\s+to\s+know\b/i;

const OBJECTIONS = [
  {
    type: 'price', rx: /\btoo\s+(?:expensive|much|high|pricey|steep)\b|\bcan(?:'|’)?t\s+afford\b|\bout\s+of\s+(?:our|my)\s+(?:budget|price\s+range)\b|\bmore\s+than\s+(?:we|i)\s+(?:wanted|expected|planned)\b|\b(?:price|cost|number)\s+(?:is|was)\s+(?:too\s+)?(?:high|steep|a\s+lot)\b|\bexpensive\b/i,
    ask: 'Too expensive compared to what?',
    then: 'then bridge: the best deal possible, easier on a quick call',
  },
  {
    type: 'other_quote', rx: /\b(?:another|other|different|second|lower|better|cheaper)\s+(?:quote|estimate|bid|offer|price|company|companies)\b|\bgot\s+(?:a|another|some)\s+(?:quote|estimate|bid)s?\b|\bshopping\s+around\b|\bcompar(?:e|ing)\s+(?:quotes|prices|companies)\b/i,
    ask: 'How do they compare, out of curiosity?',
    then: 'then bridge with "the best deal possible"',
  },
  {
    type: 'think', rx: /\bthink\s+(?:about\s+it|it\s+over|on\s+it|about\s+(?:this|that))\b|\bneed\s+(?:some\s+|more\s+)?time\b|\bsleep\s+on\s+it\b|\bmull\s+it\s+over\b|\bnot\s+(?:sure|ready)\s+yet\b/i,
    ask: 'What part do you want to think through?',
    then: 'then bridge to the call',
  },
  {
    type: 'spouse', rx: /\b(?:my|the)\s+(?:wife|husband|spouse|partner|son|daughter|family)\b|\btalk\s+(?:it\s+over\s+)?(?:to|with)\s+(?:my|the)\b|\bwe\s+(?:both\s+)?need\s+to\s+(?:talk|decide|discuss)\b/i,
    ask: "What do you think they'll want to know?",
    then: 'then offer the call with both of them on',
  },
];

const BARE_NO_RX = /^\s*(?:no|nope|nah|no\s+thanks?|no\s+thank\s+you|not\s+really|not\s+now|not\s+right\s+now|not\s+interested|pass|i(?:'|’)?m\s+good|we(?:'|’)?re\s+good)\b[\s.!]*$/i;
const YES_RX = /^\s*(?:y(?:es|eah|ep|up)|sure|ok(?:ay)?|sounds\s+good|that\s+works|please|absolutely|definitely|why\s+not|let(?:'|’)?s\s+do\s+it|i(?:'|’)?d\s+like\s+that|that\s+would\s+help|it\s+would)\b/i;

// 2026-10-21 (Charles, ybKSdqmy1sVVdd0v0QY4; REHASH_BOOKING_FIX_ENABLED): "We are
// not doing windows at this time" got "What changed?" and "Decided not needed at
// this time." got "Where are you at with it?". Neither read as a no, so the track
// asked its next question. A firm decline is a first no (door_open: one line,
// nothing asked), and a second one is the stop.
export const REHASH_FIRM_NO_RX = /^\s*not\s+needed(?:,?\s+(?:thanks?|thank\s+you))?\s*[.!]*\s*$|\b(?:decided\s+)?not\s+needed\s+(?:at\s+(?:this|the\s+moment)|right\s+now|any\s*more|now)\b|\bno\s+longer\s+need(?:ed)?\b|\b(?:have\s+|we(?:'|’)?ve\s+|i(?:'|’)?ve\s+)?decided\s+(?:against\s+(?:it|this|the\s+(?:windows?|project))|not\s+(?:needed|necessary|to\s+(?:do|move|proceed|replace|go\s+(?:ahead|forward)))|to\s+(?:pass|hold\s+off))\b|\bnot\s+doing\s+(?:the\s+|any\s+)?(?:windows?|doors?|project)\b|\bnot\s+moving\s+forward\b|\bwon(?:'|’)?t\s+be\s+(?:moving|going)\s+(?:forward|ahead)\b/i;

/** A no for the two-no's rule on the rehash line; a closer ("Not ready", "Will do") counts (2026-10-17). Pure. */
export function isRehashNo(text) {
  const t = String(text || '');
  return isNotInterested(t) || BARE_NO_RX.test(t) || isLeadCloser(t) || (REHASH_FIRM_NO_RX.test(t) && rehashBookingFix());
}

// 2026-10-21 (Charles: "Ready to move. Would like to see final description of
// project and final costs first." got "Too expensive compared to what you were
// quoted elsewhere?" and he backed out). A lead ready to buy, or asking for the
// final price, is offered the call with the rep at once: never the objection
// ladder. REHASH_BOOKING_FIX_ENABLED.
export const REHASH_READY_RX = /\bready\s+to\s+(?:move(?:\s+forward)?|go(?:\s+ahead)?|sign|get\s+started|start|buy|do\s+(?:it|this))\b|\blet(?:'|’)?s\s+(?:move\s+forward|get\s+started|go\s+ahead|get\s+(?:it|this)\s+(?:going|done))\b|\b(?:see|get|have|know)\s+(?:the\s+|your\s+)?final\s+(?:cost|costs|price|pricing|numbers?|quote|total|description)\b|\b(?:decided|going|want)\s+to\s+go\s+(?:with|ahead\s+with)\s+(?:you|your|reece|the\s+(?:quote|proposal))\b/i;

/** A buying signal on the rehash line ("ready to move", "want the final costs"). Pure. */
export function isRehashReady(text) {
  const t = String(text || '');
  return REHASH_READY_RX.test(t) && !/\bnot\s+(?:quite\s+|yet\s+)?ready\b/i.test(t) && !isNotInterested(t);
}

/** The reason for the call on a buying signal (the rep goes over the final project and price). Pure. */
export function rehashReadyLine(repName = null, { ask = false } = {}) {
  const who = repName ? `${repName} can` : 'I can';
  // With no times to offer, the call is asked for (REHASH_BRIDGE_RX reads "quick call …?" back).
  return ask ? `${who} go over the final project and price with you. Would a quick call work for that?`
    : `${who} go over the final project and price with you on a quick call.`;
}

// The lead already answered the PROBLEM stage when they named an objection.
const answeredProblem = (t) => OBJECTIONS.some(o => o.rx.test(t));
const stageAnswered = (s, inbound) => inbound.some(t => (s.key === 'problem' ? answeredProblem(t) : !!s.answeredRx?.test(t)));

/** The objection in this message, or null. Pure. */
export function rehashObjection(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  if (isRehashNo(t)) return { type: 'not_interested', ask: null, then: 'acknowledge, leave the door open, no pitch' };
  // A spouse named in passing ("my wife liked it") is not an objection; only
  // when it comes with deciding / talking it over.
  for (const o of OBJECTIONS) {
    if (o.type === 'spouse' && !/\b(?:talk|decide|discuss|check|ask|run\s+it\s+by|look\s+at\s+it|go\s+over|see\s+what)\b/i.test(t)) continue;
    if (o.rx.test(t)) return { type: o.type, ask: o.ask, then: o.then };
  }
  return null;
}

function normalize(conversation, trigger) {
  const turns = (Array.isArray(conversation) ? conversation : [])
    .map(m => ({ direction: String(m?.direction || '').toLowerCase() === 'outbound' ? 'outbound' : 'inbound', text: String(m?.text ?? m?.body ?? '').trim() }))
    .filter(m => m.text);
  const now = String(trigger || '').trim();
  const lastIn = [...turns].reverse().find(t => t.direction === 'inbound');
  if (now && lastIn?.text !== now) turns.push({ direction: 'inbound', text: now });
  return turns;
}

/**
 * Where this rehash conversation is on the post-demo track, and the ONE move
 * for this turn. Pure.
 * @returns {{ stage: string, label: string, move: string, example: string|null,
 *   objection: object|null, nos: number, hintUsed: boolean, asked: string[] }}
 */
export function rehashNepqTurn({ conversation = [], trigger = '', nowMs = Date.now(), hintMode = 'once', repName = null } = {}) {
  const turn = rehashNepqTurnCore({ conversation, trigger, nowMs, hintMode, repName });
  if (hintMode !== 'every') return turn;
  const recent = normalize(conversation, trigger).filter(t => t.direction === 'outbound').slice(-8).map(t => t.text);
  return { ...turn, hintMode, hint: rehashHintFor({ stage: turn.stage, recentOutbound: recent, seed: recent.length, mode: hintMode }) };
}

function rehashNepqTurnCore({ conversation = [], trigger = '', nowMs = Date.now(), hintMode = 'once', repName = null } = {}) {
  const every = hintMode === 'every';
  const turns = normalize(conversation, trigger);
  const outbound = turns.filter(t => t.direction === 'outbound').map(t => t.text);
  const now = String(trigger || [...turns].reverse().find(t => t.direction === 'inbound')?.text || '');
  const lastOut = (() => {
    const i = turns.map(t => t.direction).lastIndexOf('outbound');
    return i >= 0 ? turns[i].text : '';
  })();
  // Every mode (2026-10-19): the hint is never "used up".
  const hintUsed = !every && outbound.some(t => BEST_DEAL_RX.test(t));
  const inbound = turns.filter(t => t.direction === 'inbound').map(t => t.text);
  // A stage we asked, or one the lead already answered without being asked.
  const asked = REHASH_STAGES.filter(s => outbound.some(t => s.rx.test(t)) || stageAnswered(s, inbound)).map(s => s.key);

  let nos = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].direction !== 'inbound') continue;
    if (isRehashNo(turns[i].text)) nos++;
    else break;
  }
  const at = (key, move, extra = {}) => {
    const s = REHASH_STAGES.find(x => x.key === key);
    return { stage: key, label: s?.label || key.toUpperCase(), move, example: s?.example || null, objection: null, nos, hintUsed, asked, ...extra };
  };

  if (PURCHASED_ELSEWHERE_RX.test(now)) {
    return at('signed_elsewhere', 'Thank them for letting you know. No congratulations, no question, no call pitch.', { label: 'SIGNED ELSEWHERE' });
  }
  if (detectDeferral(now, nowMs)) {
    return at('follow_up_date', 'Confirm the exact date they gave in plain words and stop. No question, no time, no call pitch.', { label: 'FOLLOW-UP DATE' });
  }
  // A yes to our bridge: the call is agreed. The schedule step is the plan's.
  // Before the closer and the no's (2026-10-17): "Ok" after the bridge is the
  // call, though "ok" alone now reads as a closer.
  if (bridgedRecently(outbound) && YES_RX.test(now) && !isNotInterested(now) && !BARE_NO_RX.test(now)) {
    return at('schedule', 'They said yes to the call. Schedule it (see SCHEDULING in the rehash block). Do not pitch again and do not say "best deal" again.', { label: 'SCHEDULE', example: null });
  }
  // A sign-off ends the exchange (2026-10-17): before the two-no's stop, so two
  // pleasantries in a row are never a rehash_stop card.
  if (isLeadCloser(now)) {
    return at('closer', 'They closed the exchange. One short line that matches theirs, no question, no call pitch, no time.', { label: 'LEAD SIGNED OFF' });
  }
  if (nos >= 2) {
    return at('stop', 'Two no\'s in a row: acknowledge it in one short line, leave the door open, and ask NOTHING. No call pitch, no question mark.', { label: 'STOP ASKING' });
  }
  const objection = rehashObjection(now);
  if (objection?.type === 'not_interested') {
    return at('door_open', 'Acknowledge it in their words, leave the door open in ONE short line, and ask NOTHING. No question mark. No call pitch. A reason they gave ("planning stage", "cost") is never asked about.', { label: 'NOT INTERESTED (first no)', objection });
  }
  // They answered our ask-back: now the bridge.
  if (ASK_BACK_RX.test(lastOut) && !objection) {
    if (every) return at('bridge', 'Reflect what they said in their words, then ask "If I could …, would you be open to a quick call?"', { example: `That makes sense. ${rehashIfICouldBridge(repName)}` });
    return hintUsed
      ? at('bridge', 'Reflect what they said in their words, then ask if a quick call would help. Do NOT say "best deal" again: it was already said once.', { example: 'That makes sense. Would a quick call help?' })
      : at('bridge', 'Reflect what they said in their words, then bridge to the call with the hint, once.');
  }
  if (objection) {
    return at('objection', `Ask back, never rebut: "${objection.ask}" (${objection.then}). One question, no explanation, no defence of the price.`, { label: `OBJECTION — ${objection.type.replace('_', ' ').toUpperCase()}`, objection, example: objection.ask });
  }
  // One stage past the furthest one already asked.
  const idx = Math.max(-1, ...asked.map(k => REHASH_STAGES.findIndex(s => s.key === k)));
  if (idx >= REHASH_STAGES.length - 1) {
    return at('after_bridge', `The call was already offered. Answer what they said, briefly. If the door is still open, ask once more, plainly, if a quick call would help.${hintUsed ? ' Do NOT say "best deal" again.' : ''}`, { label: 'AFTER THE BRIDGE', example: 'Would a quick call help?' });
  }
  const next = REHASH_STAGES[idx + 1];
  const vague = idx === 2 ? ' If their answer to "what is holding you back" was vague, probe with their own last few words first ("Too much how?") and stay on this stage.' : '';
  if (every && next.key === 'bridge') {
    return at('bridge', 'Bridge to the call with "If I could …, would you be open to a quick call?"', { example: rehashIfICouldBridge(repName) });
  }
  const move = next.key === 'bridge'
    ? (hintUsed ? 'Bridge to the call WITHOUT the "best deal" line (already said once): ask if a quick call would help.' : 'Bridge to the call with the hint, once.')
    : `Ask the ${next.label} question, ${next.aim}.${vague}`;
  return at(next.key, move, next.key === 'bridge' && hintUsed ? { example: 'I may be able to do something for you, it\'s just easier on a quick call. Would that help?' } : {});
}

/**
 * The REHASH NEPQ prompt block, rendered in place of the new-lead stage play.
 * @param {object} turn   rehashNepqTurn() output
 * @param {{repName?: string|null}} [o]
 */
export function buildRehashNepqBlock(turn, { repName = null } = {}) {
  const t = turn || rehashNepqTurn({});
  const rep = repName || 'our team';
  const lines = [
    '',
    `STAGE (POST-DEMO REHASH): ${t.label}`,
    '',
    'This lead already had the in-home demo and holds a proposal. This is NOT a new lead.',
    'Never ask what got them looking at windows, how long, which room, or anything about',
    'the windows themselves. Every question is about the proposal and their decision.',
    `The one goal is a scheduled phone call with ${rep}, framed as making sure they are`,
    'getting the best deal possible.',
    '',
    `THIS TURN: ${t.move}`,
    t.example ? `Example (adapt, do not recite): "${t.example}"` : null,
    '',
    'THE TRACK (move ONE stage per turn, never skip to the pitch):',
    ...REHASH_STAGES.map((s, i) => `${i + 1}. ${s.label} — ${s.aim}. e.g. "${s.example}"`),
    '6. SCHEDULE — once they say yes to the call (see SCHEDULING in the rehash block).',
    '',
    'OBJECTIONS (ask back, never rebut):',
    '- "Too expensive" → "Too expensive compared to what?" → then bridge.',
    '- "Got another quote" → "How do they compare, out of curiosity?" → then bridge with "the best deal possible."',
    '- "Need to think about it" → "What part do you want to think through?"',
    '- "Talking to my spouse" → "What do you think they\'ll want to know?" → offer the call with both on.',
    '- "Not interested" → acknowledge, leave the door open, no pitch, NO question. Two no\'s in a row = stop asking.',
    '- A sign-off ("will do", "I\'ll get back to you", "not ready", "ok thanks") → one matching line, no question.',
    '',
    ...(t.hintMode === 'every'
      ? [
        'A BETTER DEAL, HINTED: every reply (except a stop, a sign-off, a no or a confirmed call) carries ONE',
        'short line that we may be able to make this work better for them, in new words each time.',
        t.hint ? `THIS TURN'S HINT (adapt, do not recite): "${t.hint}"` : 'THIS TURN: no hint.',
        'The bridge to the call is "If I could …, would you be open to a quick call?"',
      ]
      : [t.hintUsed
        ? '"THE BEST DEAL POSSIBLE": ALREADY SAID in this conversation. Do not say it again, in any wording.'
        : '"THE BEST DEAL POSSIBLE": may be said at most ONCE per conversation, and only at the bridge.']),
    'Never name what the deal is: no amount, no percentage, no discount, no promotion, no',
    'special price or financing, never "a deal", "a great deal" or "a special deal".',
    '',
    'CONSEQUENCE: at most ONE per conversation, only after they named a holdup in their own',
    'words, and only about cost, comfort or another season of the same thing. Never danger,',
    'never an insurance outcome, never a price that rises, never a deadline.',
  ];
  return lines.filter(l => l !== null).join('\n');
}
