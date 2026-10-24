// ─── The assistant never offers a price itself — src/services/assistant-voice.js ──
//
// 2026-10-24 (the user): "your job is to really be John's assistant." With
// REHASH_VOICE_MODE=assistant the "I" in a reply is the assistant, so the rehash
// track's "If I could get you a better price, would you be open to a quick call?"
// would have the assistant promise a price it cannot give. This moves the offer to
// the rep: "If John could get you a better price, would you be open to a quick
// call?" Only the offer phrases move ("if I could", "I may be able to", "I can
// walk through / look at getting"); "I hear you" or "I'll leave John a note" stay
// the assistant's. Once the rep is named in a sentence, its "a quick call with
// John" drops the repeat. No pronoun for the rep (the user's standing rule). Pure.
// Lives in src/services so the src/agentic regex budget is untouched.

// Captures the gap, so newlines and the sign-off line survive the rewrite.
const SENTENCE_SPLIT = /((?<=[.!?])\s+)/;

/** The text with the rep making every price offer, never the assistant. Pure. */
export function assistantOfferLine(text, rep) {
  const name = String(rep || '').trim();
  const src = String(text || '');
  if (!name || !src) return { text: src, changed: false };
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out = src.split(SENTENCE_SPLIT).map((s, i) => {
    if (i % 2) return s;
    let t = s
      .replace(/\b([Ii])f I could\b/g, (_, i) => `${i}f ${name} could`)
      .replace(/\bI may be able to\b/g, `${name} may be able to`)
      .replace(/\bI can (walk through|look at getting)\b/g, `${name} can $1`);
    if (t !== s) t = t.replace(new RegExp(`(\\bquick call) with ${esc}\\b`, 'g'), '$1');
    return t;
  }).join('');
  return { text: out, changed: out !== src };
}

/** The plan's reference lines rewritten the same way (fixed_line, reference_line). Pure. */
export function assistantPlan(plan, rep) {
  if (!plan || !rep) return plan;
  const next = { ...plan };
  for (const k of ['fixed_line', 'reference_line', 'hint_line']) {
    if (typeof next[k] === 'string') next[k] = assistantOfferLine(next[k], rep).text;
  }
  return next;
}
