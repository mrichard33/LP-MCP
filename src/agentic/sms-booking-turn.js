/**
 * src/agentic/sms-booking-turn.js
 *
 * 2026-10-02 (Mark: "look into the text bot speed, and the text bot doesn't
 * book yet in this chat"). On the booking turns of Mark's 5:22 PM chat the
 * SMS model held the wrong time, re-asked the bridge and never booked, while
 * the live chat booked the same chat in ~3s a turn.
 *
 * Part 6 (Mark: "I want there to be AI-generated replies"): AI writes, code
 * decides. This module works out the FACTS of a booking turn: the real slot
 * (a pick resolved against our own offer, or the time we are holding), the
 * ONE thing to ask for next (name → phone → street address with zip → a
 * read-back of an address on file → the decision-maker question, once), or
 * that nothing is missing and the visit is booked now. The facts go into the
 * NEPQ plan block (nepq-backbone.js) and the model writes the reply; then
 * enforceBookingFacts checks the draft: the right time, the one ask, the
 * companion book_appointment with the pinned slot. A draft that misses one
 * of those is replaced by `fallback`, the deterministic line.
 *
 * Pure: the caller hands in the plan, the thread and what the booking gate
 * still needs. Returns null when it cannot resolve a real slot (the model
 * writes the turn as before).
 */

import { offeredSlots, pickSlot, slotMentionIndex } from '../live-chat/cancel-flow.js';
import {
  COLLECT_ASK, COLLECT_ASK_AGAIN, holdLine, dmAsk, parseDecisionMakers, mentionedPartner,
  addressConfirmAsk, addressConfirmState, dmAnswerFromThread, slotLabel,
} from './booking-collect.js';
import { LINES, pickFresh } from './nepq-planner.js';
import { asksIn, enforceOneAsk } from './one-ask.js';

// The booking gate's names for what is missing → our ask keys.
function askKey(missing) {
  const m = String(missing || '');
  if (/^decision/.test(m)) return 'dm';
  if (m === 'zip' || m === 'address') return 'address';
  if (m === 'real_name' || m === 'name') return 'name';
  if (m === 'phone') return 'phone';
  return null;
}
const ORDER = ['name', 'phone', 'address', 'address_confirm', 'dm'];

/**
 * @param {object} a
 * @param {object} a.plan          planNepqTurn result (confirm or collect)
 * @param {string} a.trigger       the lead's message
 * @param {Array}  a.thread        [{direction, text}], oldest first, trigger last
 * @param {Array}  a.slots         every real opening [{iso, day, time, rel?}]
 * @param {string} a.tz            "ET"
 * @param {string[]} a.gateMissing the in-home gate's missing items
 * @param {object|null} a.onFileAddress { address1, city } when the address came from the contact record
 * @param {string|null} a.firstName
 * @param {object} a.calendar      { calendar_id, calendar_name }
 * @param {Function} [a.spread]    (slots) => two other times (spreadOffer)
 * @returns {null|{kind:'hold'|'collect'|'book'|'dm_conflict', slot, ask:string|null, ask_line:string|null, book:boolean,
 *   alternatives:Array, fallback:string, companion:object|null, record:object}}
 */
export function smsBookingTurn({ plan, trigger, thread = [], slots = [], tz = 'ET', gateMissing = [], onFileAddress = null, firstName = null, calendar = {}, spread = (s) => s.slice(0, 2) } = {}) {
  if (!plan || !Array.isArray(slots) || !slots.length) return null;
  const isConfirm = plan.required_move === 'confirm';
  const isCollect = plan.step === 'collect' && !!plan.held_slot?.text;
  if (!isConfirm && !isCollect) return null;
  const pinned = isConfirm
    ? pickSlot(trigger, offeredSlots(plan.last_offer || '', slots))
    : (offeredSlots(plan.held_slot.text, slots)[0] || null);
  if (!pinned) return null;
  const slot = { ...pinned, tz: pinned.tz || tz };
  const recentOut = thread.filter(m => m.direction === 'outbound').slice(-8).map(m => m.text);
  const inboundTexts = thread.filter(m => m.direction !== 'outbound').map(m => m.text);
  const base = { slot, label: slotLabel(slot, tz), alternatives: [], companion: null };

  // "My wife works then": two other real times, never a booking for one person.
  if (isCollect && parseDecisionMakers(trigger) === 'conflict') {
    const others = spread(slots.filter(s => s.iso !== pinned.iso)).map(s => ({ ...s, tz: s.tz || tz }));
    const fallback = others.length === 2
      ? `No problem, let's find a time when you can both be there. ${LINES.offer_slots(others, plan.counters?.slot_offers || 0)}`
      : 'No problem. What day works best when you can both be there?';
    return { ...base, kind: 'dm_conflict', ask: 'day', ask_line: null, book: false, alternatives: others.length === 2 ? others : [], fallback, record: { sms_booking: 'dm_conflict' } };
  }

  // What is still missing, in the order we ask.
  const dmAnswer = dmAnswerFromThread(thread);
  const partner = mentionedPartner(inboundTexts);
  const keys = new Set((gateMissing || []).map(askKey).filter(Boolean));
  if (dmAnswer && dmAnswer !== 'conflict') keys.delete('dm');
  // A spouse named in this text thread is asked about once, whatever an old record says.
  if (partner && !dmAnswer) keys.add('dm');
  const addrState = addressConfirmState(thread);
  if (onFileAddress?.address1 && !keys.has('address') && (addrState === 'unasked' || addrState === 'pending')) keys.add('address_confirm');
  if (addrState === 'rejected') keys.add('address');
  const next = ORDER.find(k => keys.has(k));
  if (next) {
    const first = next === 'dm' ? dmAsk(inboundTexts) : next === 'address_confirm' ? addressConfirmAsk(onFileAddress) : COLLECT_ASK[next];
    const askLine = pickFresh([first, COLLECT_ASK_AGAIN[next]].filter(Boolean), recentOut, 0);
    if (isConfirm) return { ...base, kind: 'hold', ask: next, ask_line: askLine, book: false, fallback: holdLine(pinned, tz, askLine), record: { sms_booking: 'hold', ask: next, slot: pinned.iso } };
    const ack = pickFresh(['Got it.', 'Perfect, thanks.', 'Great, thank you.'], recentOut, 0);
    return { ...base, kind: 'collect', ask: next, ask_line: askLine, book: false, fallback: `${ack} ${askLine}`, record: { sms_booking: 'collect', ask: next, slot: pinned.iso } };
  }

  // Nothing missing: book it now (the send handler books before it sends, and
  // says "all set" only if the booking lands).
  return {
    ...base,
    kind: 'book', ask: null, ask_line: null, book: true,
    fallback: LINES.confirm(pinned, tz, firstName),
    companion: {
      action_type: 'book_appointment',
      action_payload: {
        calendar_name: calendar.calendar_name || 'Window Estimate',
        ...(calendar.calendar_id ? { calendar_id: calendar.calendar_id } : {}),
        start_time: pinned.iso,
        status: 'new',
        qualifying_data: { decision_makers_present: dmAnswer && dmAnswer !== 'conflict' ? dmAnswer : 'Uncertain' },
      },
      reasoning: 'SMS: the lead picked a real open time and nothing the visit needs is missing (sms-booking-turn)',
    },
    record: { sms_booking: 'book', slot: pinned.iso },
  };
}

// ── after the model ──────────────────────────────────────────────────────

const CLOCK_RX = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/gi;
/** Minutes after midnight for every clock time in the text ("2 PM", "10:00 AM"). Pure. */
export function clockTimes(text) {
  return [...String(text || '').matchAll(CLOCK_RX)].map(m => {
    let h = Number(m[1]) % 12;
    if (/p/i.test(m[3])) h += 12;
    return h * 60 + Number(m[2] || 0);
  });
}
const slotMinutes = (slot) => clockTimes(slot?.time || '')[0];

/**
 * The model's draft for a booking turn, checked against the facts. Returns
 * { message, companion, record, fallback_used, problems }. The draft stands
 * when it names the right time (and no other), asks the one thing the facts
 * ask (as a question), and, for a booking, says they're all set with the team
 * confirming. Otherwise the deterministic line ships. The companion always
 * comes from the facts, never from the model. Pure.
 */
export function enforceBookingFacts(draft, facts, { companion = null } = {}) {
  const text = String(draft || '').trim();
  const problems = [];
  const notes = [];
  const want = facts.kind === 'dm_conflict' ? facts.alternatives.map(slotMinutes) : [slotMinutes(facts.slot)];
  const times = clockTimes(text);
  if (times.some(t => !want.includes(t))) problems.push('wrong_time');
  const split = (t) => String(t || '').split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(Boolean);
  const slot = facts.slot || {};
  const exact = slot.day && slot.time ? `${slot.day} at ${slot.time}` : null;
  const namesDay = (t) => [slot.day, slot.rel, slot.dayOfWeek].filter(Boolean).some(d => String(t).toLowerCase().includes(String(d).toLowerCase()));
  let message = text;
  if (facts.kind === 'book') {
    if (!times.length || !namesDay(text)) problems.push('no_time');
    if (!/\ball\s+set\b/i.test(text) || !/\bconfirm/i.test(text)) problems.push('not_the_confirm_line');
    if (text.includes('?')) problems.push('asks_after_booking');
  } else if (facts.kind === 'dm_conflict') {
    if (facts.alternatives.length === 2 && !want.every(t => times.includes(t))) problems.push('missing_alternatives');
    if (!text.endsWith('?')) problems.push('no_question');
  } else {
    // One ask, the facts' ask, ending the message in the plan's exact words
    // (heldSlot reads the ask back next turn). The model's acknowledgement
    // and its answer to a question stay as it wrote them.
    const one = enforceOneAsk(text, { ask: facts.ask, timePicked: true, canon: () => facts.ask_line });
    const parts = split(one.text);
    const lineParts = new Set(split(facts.ask_line));
    const asks = parts.filter(p => asksIn(p).ask || lineParts.has(p));
    if (!asks.some(p => lineParts.has(p) || asksIn(p).items.includes(facts.ask))) notes.push('ask_replaced');
    let body = parts.filter(p => !lineParts.has(p) && !asksIn(p).ask);
    if (facts.kind === 'hold') {
      // The hold sentence names the slot exactly as offered, or heldSlot
      // cannot find it next turn: the model's when it does, else ours.
      const own = body.find(p => /\bI'?m\s+holding\b/i.test(p) && exact && slotMentionIndex(p, slot) >= 0);
      body = body.filter(p => p === own || (!/\bI'?m\s+holding\b/i.test(p) && !clockTimes(p).length));
      // Their acknowledgement first, then the hold ("Sure. I'm holding … for you.").
      if (!own) { body = body.length ? [...body, `I'm holding ${slotLabel(slot, slot.tz || '')} for you.`] : [holdLine(slot, slot.tz || '', '').trim()]; notes.push('hold_sentence_fixed'); }
    } else if (body.some(p => clockTimes(p).length)) {
      // Collecting: no time talk (the held time stands; a change is the lead's to ask).
      body = body.filter(p => !clockTimes(p).length);
      notes.push('time_talk_dropped');
    }
    message = [...body, facts.ask_line].join(' ').trim();
    if (/\b(?:all\s+set|booked|scheduled|confirmed)\b/i.test(body.join(' '))) problems.push('booking_claim');
  }
  const fallbackUsed = problems.length > 0;
  return {
    message: fallbackUsed ? facts.fallback : message,
    companion: facts.book ? mergeCompanion(facts.companion, companion) : null,
    record: { ...facts.record, ai_written: !fallbackUsed, ...(fallbackUsed ? { fallback: problems } : {}), ...(notes.length ? { fixes: notes } : {}) },
    fallback_used: fallbackUsed,
    problems,
    notes,
  };
}

/** The re-write instruction after a booking draft failed its checks (Part 7). Pure. */
export function bookingFactsNote(facts, problems = []) {
  const what = {
    hold: `say "I'm holding ${facts.label} for you." and then ask exactly: "${facts.ask_line}"`,
    collect: `thank them in a few words, then ask exactly: "${facts.ask_line}". Mention no other time`,
    book: `say they're all set for ${facts.label} and that our team will reach out to confirm the details. No question`,
    dm_conflict: facts.alternatives?.length === 2
      ? `offer exactly these two times and ask which works better: ${facts.alternatives.map(s => `${s.day} at ${s.time}`).join(' or ')}`
      : 'ask what day works best when they can both be there',
  }[facts.kind] || 'follow the turn plan';
  return `Your previous draft got the booking facts wrong (${problems.join(', ')}). Write it again in your own words for this lead: ${what}. Name no other time.`;
}

// The model's companion may carry useful extras (a note, a duration); the
// slot, the calendar, the status and the decision-maker answer are ours.
function mergeCompanion(ours, theirs) {
  if (!ours) return null;
  const extra = theirs?.action_type === 'book_appointment' ? (theirs.action_payload || {}) : {};
  return {
    ...ours,
    action_payload: {
      ...extra,
      ...ours.action_payload,
      qualifying_data: { ...(extra.qualifying_data || {}), ...ours.action_payload.qualifying_data },
    },
  };
}
