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
  addressConfirmAsk, addressConfirmState, dmAnswerFromThread, slotLabel, nameFromReply,
} from './booking-collect.js';
import { LINES, pickFresh } from './nepq-planner.js';
import { asksIn, enforceOneAsk } from './one-ask.js';
import { checkEveningReply, eveningReplyLine, requestedLabel } from './evening-request.js';

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
// 2026-10-15 (Mark, R5): `pinnedSlot` is the 6:00 PM opening code chose for a
// lead who asked for 6:30 / 7:00 (evening-request.js), and `evening` is that
// ask. A booked 6:00 PM with an evening ask on the thread gets the R5 line as
// its reference instead of the confirm line.
export function smsBookingTurn({ plan, trigger, thread = [], slots = [], tz = 'ET', gateMissing = [], onFileAddress = null, firstName = null, calendar = {}, spread = (s) => s.slice(0, 2), pinnedSlot = null, evening = null, timeZone = 'America/New_York' } = {}) {
  if (!plan || !Array.isArray(slots) || !slots.length) return null;
  const isConfirm = !!pinnedSlot || plan.required_move === 'confirm';
  const isCollect = !pinnedSlot && plan.step === 'collect' && !!plan.held_slot?.text;
  if (!isConfirm && !isCollect) return null;
  const pinned = pinnedSlot || (isConfirm
    ? pickSlot(trigger, offeredSlots(plan.last_offer || '', slots))
    : (offeredSlots(plan.held_slot.text, slots)[0] || null));
  if (!pinned) return null;
  const slot = { ...pinned, tz: pinned.tz || tz };
  const eveningAsk = evening && isSixPm(pinned.iso, timeZone)
    ? { requested_time: evening.requested_time, requested_minutes: evening.minutes ?? evening.requested_minutes ?? null, requested_label: requestedLabel(evening.requested_time, pinned.iso, timeZone) }
    : null;
  const recentOut = thread.filter(m => m.direction === 'outbound').slice(-8).map(m => m.text);
  const inboundTexts = thread.filter(m => m.direction !== 'outbound').map(m => m.text);
  const base = { slot, label: slotLabel(slot, tz), alternatives: [], companion: null, thread_name: nameFromThread(thread) };

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
  // A name typed in this thread counts, like the live chat's collect: a bare
  // "Mark" answering our "first name?" (2026-10-03 replay: the gate still read
  // the name as missing and asked "Who should I put the visit under?").
  const threadName = nameFromThread(thread);
  if (threadName) keys.delete('name');
  if (dmAnswer && dmAnswer !== 'conflict') keys.delete('dm');
  // A spouse named in this text thread is asked about once, whatever an old record says.
  if (partner && !dmAnswer && !plan.dm_known) keys.add('dm');
  // 2026-10-12 (LEAD_STAGE_MODE=live): the qualifying gate already settled the
  // decision makers ("my wife will be there"): never asked again.
  if (plan.dm_known) keys.delete('dm');
  const addrState = addressConfirmState(thread);
  if (onFileAddress?.address1 && !keys.has('address') && (addrState === 'unasked' || addrState === 'pending')) keys.add('address_confirm');
  if (addrState === 'rejected') keys.add('address');
  const next = ORDER.find(k => keys.has(k));
  if (next) {
    const first = next === 'dm' ? dmAsk(inboundTexts) : next === 'address_confirm' ? addressConfirmAsk(onFileAddress) : COLLECT_ASK[next];
    const askLine = pickFresh([first, COLLECT_ASK_AGAIN[next]].filter(Boolean), recentOut, 0);
    if (isConfirm) {
      // R5: the hold says the evening ask is noted, so 6:00 is never a surprise.
      const fallback = eveningAsk
        ? `I'm holding ${slotLabel(pinned, tz)} for you. I've made a note that you would like ${eveningAsk.requested_time}. ${askLine}`
        : holdLine(pinned, tz, askLine);
      return { ...base, kind: 'hold', ask: next, ask_line: askLine, book: false, fallback, ...(eveningAsk ? { evening: eveningAsk } : {}), record: { sms_booking: 'hold', ask: next, slot: pinned.iso, ...(eveningAsk ? { evening: eveningAsk.requested_time } : {}) } };
    }
    const ack = pickFresh(['Got it.', 'Perfect, thanks.', 'Great, thank you.'], recentOut, 0);
    return { ...base, kind: 'collect', ask: next, ask_line: askLine, book: false, fallback: `${ack} ${askLine}`, record: { sms_booking: 'collect', ask: next, slot: pinned.iso } };
  }

  // Nothing missing: book it now (the send handler books before it sends, and
  // says "all set" only if the booking lands).
  return {
    ...base,
    kind: 'book', ask: null, ask_line: null, book: true,
    fallback: eveningAsk ? eveningReplyLine(eveningAsk.requested_time) : LINES.confirm(pinned, tz, firstName || threadName),
    ...(eveningAsk ? { evening: eveningAsk } : {}),
    companion: {
      action_type: 'book_appointment',
      action_payload: {
        calendar_name: calendar.calendar_name || 'Window Estimate',
        ...(calendar.calendar_id ? { calendar_id: calendar.calendar_id } : {}),
        start_time: pinned.iso,
        status: 'new',
        qualifying_data: { decision_makers_present: dmAnswer && dmAnswer !== 'conflict' ? dmAnswer : (plan.dm_known || 'Uncertain') },
      },
      reasoning: 'SMS: the lead picked a real open time and nothing the visit needs is missing (sms-booking-turn)',
    },
    record: { sms_booking: 'book', slot: pinned.iso, ...(eveningAsk ? { evening: eveningAsk.requested_time } : {}) },
  };
}

/** Does a sentence name the requested time without AM/PM ("7", "6:30", "after 6")? Pure. */
function namesRequestedHour(text, requestedTime) {
  const [hm] = String(requestedTime || '').replace(/^after\s+/i, '').split(' ');
  const [h, mm] = hm.split(':');
  if (!h) return false;
  const rx = mm && mm !== '00' ? new RegExp(`\\b${h}:${mm}\\b`) : new RegExp(`\\b${h}(?::00)?\\b(?!:)`);
  return rx.test(String(text || ''));
}

function isSixPm(iso, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return f.format(new Date(iso)) === '18:00';
}

/**
 * Did CODE fix the visit time this turn? (2026-10-13, live-mode gate,
 * book_it_evening_spouse on SMS.) Two evening times were offered and the lead
 * texted "Yes, book it" without picking one: pickSlot found no pick, so no
 * booking facts were built, yet the model's own book_appointment survived and
 * the reply said "You're all set" before asking which time. A model companion
 * may stand only when code pinned the slot: booking facts that book, a pick
 * against our own offer, a held time being collected, or a Rehash Call pick.
 * Pure.
 */
export function bookingBackedByCode({ plan, trigger = '', bookingFacts = null, slots = [] } = {}) {
  if (bookingFacts?.book) return true;
  if (!plan) return false;
  if (plan.rehash_pick) return true;
  if (plan.step === 'collect' && plan.held_slot?.text) return true;
  if (plan.required_move === 'confirm') {
    return !!pickSlot(trigger, offeredSlots(plan.last_offer || '', Array.isArray(slots) ? slots : []));
  }
  return false;
}

const NAME_ASK_RX = /\b(?:first|full|your)\s+name\b|\bwho\s+should\s+i\s+put\b/i;
/** The name the lead typed in this thread, or null. Pure. */
export function nameFromThread(thread = []) {
  let found = null;
  for (let i = 0; i < thread.length; i++) {
    const m = thread[i];
    if (m?.direction === 'outbound') continue;
    const prev = thread.slice(0, i).reverse().find(x => x?.direction === 'outbound');
    const got = nameFromReply(m?.text, { asked: !!prev && NAME_ASK_RX.test(prev.text || '') && /\?/.test(prev.text || '') });
    if (got) found = got;
  }
  return found;
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
  // R5: the time they asked for is named too ("… for 6:30 PM").
  if (facts.evening?.requested_minutes != null) want.push(facts.evening.requested_minutes);
  const times = clockTimes(text);
  if (times.some(t => !want.includes(t))) problems.push('wrong_time');
  const split = (t) => String(t || '').split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(Boolean);
  const slot = facts.slot || {};
  const exact = slot.day && slot.time ? `${slot.day} at ${slot.time}` : null;
  const namesDay = (t) => [slot.day, slot.rel, slot.dayOfWeek].filter(Boolean).some(d => String(t).toLowerCase().includes(String(d).toLowerCase()));
  let message = text;
  if (facts.kind === 'book' && facts.evening) {
    // R5 (Mark, 2026-10-15): 6:00 booked, their time noted, the team confirms
    // and moves it. The model's words stand when they keep those facts.
    problems.push(...checkEveningReply(text, facts.evening).problems);
  } else if (facts.kind === 'book') {
    if (!times.length || !namesDay(text)) problems.push('no_time');
    if (!/\ball\s+set\b/i.test(text) || !/\bconfirm/i.test(text)) problems.push('not_the_confirm_line');
    // The confirmation is a CALL (the user, 2026-10-06): "reach out" alone misses it.
    if (!/\b(?:call|ring)\b/i.test(text)) problems.push('no_confirmation_call');
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
      // R5: the sentence noting their 6:30 / 7:00 ask may name that time.
      // 2026-10-15 (live dry run): "I noted you'd prefer 7" names the hour with no
      // AM/PM, which clockTimes cannot read, so the note was added a second time.
      const evNote = (p) => !!facts.evening && /\bnote/i.test(p)
        && clockTimes(p).every(t => t === facts.evening.requested_minutes)
        && (clockTimes(p).length > 0 || namesRequestedHour(p, facts.evening.requested_time));
      body = body.filter(p => p === own || (!/\bI'?m\s+holding\b/i.test(p) && (!clockTimes(p).length || evNote(p))));
      // Their acknowledgement first, then the hold ("Sure. I'm holding … for you.").
      if (!own) { body = body.length ? [...body, `I'm holding ${slotLabel(slot, slot.tz || '')} for you.`] : [holdLine(slot, slot.tz || '', '').trim()]; notes.push('hold_sentence_fixed'); }
      if (facts.evening && !body.some(evNote)) { body = [...body, `I've made a note that you would like ${facts.evening.requested_time}.`]; notes.push('evening_note_added'); }
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
    book: facts.evening
      ? `say this in your own words, keeping "6:00", "${facts.evening.requested_time}", that it is noted, and "confirm the details": "${eveningReplyLine(facts.evening.requested_time)}" No question`
      : `say they're all set, that someone from our team will give them a call to confirm the details, and that they're on the calendar for ${facts.label}. No question`,
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
