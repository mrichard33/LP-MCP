// ─── The newest inbound, added to the thread once — src/agentic/burst-trigger.js ─
//
// WHY (bot gate 2026-10-20, two_texts_one_reply_sms)
//   The reply buffer answers a burst of texts once, with the texts joined by
//   newlines as the trigger (behavioral-emitter.js). The thread the planner reads
//   already holds each text, so "add the trigger unless it equals the last
//   inbound" appended the joined copy too: "Still got a couple more quotes to
//   come in" counted twice, the shopping objection read as a SECOND attempt and
//   the first reply was a repeat_objection hand-off with a Five9 callback. The
//   same double count can turn one no into two (the two-no's stop) or one money
//   ask into two. When the trigger's lines are the trailing inbound run, that
//   run is replaced by the one trigger.
//
// PURE. No I/O.

/** The trigger's lines (a real newline, or the two characters I.L3-IN relays). */
function linesOf(text) {
  return String(text || '').split(/\n+|\\n/).map(s => s.trim()).filter(Boolean);
}

/**
 * The thread with the newest inbound added once. `turns` are {direction, text},
 * oldest first; returns a new array. Pure.
 */
export function appendTrigger(turns = [], trigger = '') {
  const list = Array.isArray(turns) ? turns : [];
  const t = String(trigger || '').trim();
  if (!t) return [...list];
  const last = list[list.length - 1];
  if (last && last.direction === 'inbound' && String(last.text || '').trim() === t) return [...list];
  const lines = linesOf(t);
  if (lines.length > 1) {
    let k = list.length;
    let j = lines.length;
    while (j > 0 && k > 0 && list[k - 1].direction === 'inbound' && String(list[k - 1].text || '').trim() === lines[j - 1]) { k--; j--; }
    if (k < list.length) return [...list.slice(0, k), { direction: 'inbound', text: String(trigger) }];
  }
  return [...list, { direction: 'inbound', text: String(trigger) }];
}
