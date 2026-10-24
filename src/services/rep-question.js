// ─── A question for the rehash rep — src/services/rep-question.js ──────────────
//
// WHY (the user, 2026-10-24). "Never lie or give an answer that you do not
// know. It's okay to say you don't know. The team member, in this case John,
// will answer that question, and you let them know that you will put a note for
// John." With REHASH_VOICE_MODE=team (the user's pick, the default) or
// assistant, the reply writer says it does not know and returns `ask_rep` (the
// lead's question). A reply that PROMISES a note
// ("I'll leave John a note", "I'll ask John") is a promise someone must keep, so
// a promise with no `ask_rep` still files one, from the lead's own message.
// Pure; the filing is rep-question-io.js.

const NOTE_PROMISE_RX = /\b(?:I'?ll|I will|[Ww]e'?ll|[Ww]e will|[Ll]et me)\s+(?:leave|put|drop|pass|make|send)\b[^.?!]{0,40}\bnote\b|\b(?:I'?ll|I will|[Ww]e'?ll|[Ww]e will|[Ll]et me)\s+(?:ask|check with|pass (?:this|that|it|your question) (?:on |along )?to|flag (?:this|that|it) for)\s+[A-Z][a-z]+|\b(?:I'?ll|I will|[Ww]e'?ll|[Ww]e will)\s+have\s+[A-Z][a-z]+\s+(?:get back to you|answer|confirm|check|look into|follow up)/;

/** The reply promises the rep a note or a question. Pure. */
export function promisesRepNote(reply) {
  return NOTE_PROMISE_RX.test(String(reply || ''));
}

/** The model's ask_rep, cleaned, or null. Pure. */
export function normalizeAskRep(v) {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  return s && !/^(?:null|none|n\/a)$/i.test(s) ? s.slice(0, 300) : null;
}

/**
 * The question to file for the rep this turn, or null. Only in the team or
 * assistant voice (a rehash line with a named rep); the model's ask_rep first, else the lead's message when the reply
 * promised a note. Pure.
 */
export function repQuestionFor({ voice = null, askRep = null, reply = '', trigger = '' } = {}) {
  if (voice !== 'assistant' && voice !== 'team') return null;
  const asked = normalizeAskRep(askRep);
  if (asked) return { question: asked, source: 'model' };
  if (promisesRepNote(reply)) {
    const said = normalizeAskRep(trigger);
    return said ? { question: said, source: 'promise_backed' } : null;
  }
  return null;
}

/** One question per contact, by its words (a second question the same day still files). Pure. */
export function repQuestionKey(question) {
  return String(question || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120);
}

/** The task, note and card text for one question. Pure. */
export function repQuestionTask({ firstName = null, rep = 'John', question, recent = [] }) {
  const who = firstName || 'This lead';
  const lines = (Array.isArray(recent) ? recent : []).slice(-4)
    .map(m => `${m.direction === 'outbound' ? 'Us' : who}: ${String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  return {
    title: `Answer ${who}'s question`,
    body: `${who} asked: "${question}". The assistant said it did not know and that ${rep} would get back to them.${lines.length ? `\n\nLast messages:\n${lines.join('\n')}` : ''}`,
    note: `❓ QUESTION FOR ${rep.toUpperCase()}: "${question}". The assistant told ${who} that ${rep} would get back to them.`,
    card: `❓ *QUESTION FOR ${rep.toUpperCase()}* — ${who} asked something the assistant could not answer.\n>"${question}"\nThe assistant told them ${rep} will get back to them. A GHL task is on the contact.`,
  };
}
