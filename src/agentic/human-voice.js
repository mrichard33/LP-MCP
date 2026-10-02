/**
 * Human voice clean-up — src/agentic/human-voice.js
 *
 * 2026-10-02 (Mark: the bot must "sound very human"). An audit of 40 live
 * replies, run against the no-ai-slop checklist, found the patterns a reader
 * spots as a machine in one glance:
 *   - em dashes: "Got it—old windows…", "We do — vinyl…", "Two options coming
 *     up — which works better?" The SMS prompt has banned them since the
 *     brand rules (banned.js HARD_PROHIBITIONS), and they ship anyway.
 *   - stacked stock openers: "Got it. Great question."
 *   - throat-clearing: "Just to understand what's on your mind — …"
 *   - self-commentary: "That's something worth knowing upfront."
 *
 * HUMAN_VOICE_RULES (banned.js) tells the model not to write these; this pass
 * removes what still slips through, after generation, for the SMS bot and the
 * live chat. It only ever deletes or swaps punctuation and stock phrases — it
 * never adds a claim — and it gives the original back whenever the edit would
 * leave nothing, or would lose the reply's question.
 *
 * Two things are deliberately left alone:
 *   - a trailing "— Randy" sign-off (the identity rule decides that line), and
 *   - an em dash inside a LOCKED KB line the model quoted. banned.js tells the
 *     model to reproduce those exactly, em dashes included, so `keepText` (the
 *     KB pack as the prompt showed it) is checked before any dash is touched.
 *
 * Pure. No I/O.
 */

const DASH_RX = /\s*(?:—|\s–\s|\s--\s)\s*/g;

// Stock acknowledgments. Two in a row read as a script ("Got it. Great question.").
const OPENERS = new Set([
  'got it', 'got it thanks', 'great question', 'good question', 'absolutely', 'totally understand',
  'totally get it', 'i understand', 'understood', 'makes sense', 'that makes sense', 'happy to help',
  'sure thing', 'of course', 'perfect', 'great', 'thanks for sharing that', 'thanks for sharing',
  'thanks for reaching out', 'i hear you', 'fair enough', 'love that', 'okay', 'ok',
]);

// A lead-in that stalls before the question: "Just to understand what's on your mind — what…"
const THROAT_RX = /^(?:just )?(?:to understand|so i (?:know|understand)|to make sure i understand|to get a better sense|so i can point you the right way|out of curiosity)\b[^.?!—,:–-]{0,40}?\s*(?:—|–|--|-|,|:)\s*/i;

// A whole sentence about the message instead of the subject.
const META_SENTENCE_RX = /^(?:that's|that is|this is|which is)\s+(?:definitely |really |always |also )?(?:something )?(?:worth knowing|good to know|important to know|worth noting|worth mentioning|a great question|a good question)(?:\s+(?:upfront|up front|about))?\s*[.!]?\s*$/i;
const META_LEADIN_RX = /^(?:it's|it is)\s+(?:worth noting|important to note|worth mentioning)\s+(?:that\s+)?/i;

// The only banned words with a safe one-for-one swap.
const WORD_SWAPS = [
  [/\butiliz(?:e|es)\b/gi, 'use'],
  [/\butilizing\b/gi, 'using'],
  [/\butilized\b/gi, 'used'],
];

// A clause that starts like a new sentence after a dash ("…coming up — which works?").
const NEW_CLAUSE_RX = /^(?:what|which|when|where|who|why|how|is|are|do|does|did|can|could|would|will|should|they|they're|it|it's|we|we're|we'll|you|you're|you'll|i|i'm|i'll|that's|there's|there|this|here's)\b/i;

const norm = (s) => String(s || '').replace(/\s+/g, ' ').toLowerCase();
const bare = (s) => norm(s).replace(/[^a-z' ]/g, '').replace(/\s+/g, ' ').trim();
const cap = (s) => s.replace(/^(\s*["'(]?)([a-z])/, (_, a, b) => a + b.toUpperCase());

/** Split into sentences, keeping every separator so a join restores the text. Pure. */
function sentences(text) {
  return String(text).match(/[^.!?\n]+(?:[.!?]+["')\]]*)?\s*|\n+/g) || [];
}

/** Is the dash at `idx` inside a locked line the prompt supplied? Pure. */
function insideKept(text, idx, keepNorm) {
  if (!keepNorm) return false;
  const around = norm(text.slice(Math.max(0, idx - 14), idx + 15)).trim();
  if (around.length < 8) return false;
  return keepNorm.includes(around);
}

/** Replace em dashes with the punctuation a person would type. Pure. */
function fixDashes(body) {
  let out = '';
  let last = 0;
  let changed = false;
  for (const m of body.matchAll(DASH_RX)) {
    const idx = m.index;
    const left = (out + body.slice(last, idx)).replace(/\s+$/, '');
    const restAll = body.slice(idx + m[0].length);
    out = left;
    last = idx + m[0].length;
    changed = true;
    if (!left) continue;                       // a dash at the very start: drop it
    if (!/\w/.test(restAll)) continue;         // a dangling dash before only punctuation: drop it
    if (/[.!?:;,]$/.test(left)) { out += ' '; continue; }
    const leftSentence = left.split(/[.!?\n]\s*/).pop();
    const rightClause = restAll.split(/[.!?]/)[0];
    const toPeriod = OPENERS.has(bare(leftSentence)) || (NEW_CLAUSE_RX.test(restAll.trim()) && rightClause.split(/\s+/).length >= 3);
    if (toPeriod) {
      const lead = restAll.match(/^\s*/)[0].length;
      out += '. ' + restAll.charAt(lead).toUpperCase();
      last += lead + 1;
    } else {
      out += ', ';
    }
  }
  out += body.slice(last);
  return { text: out, changed };
}

/**
 * Clean the machine tells out of a finished reply.
 * @param {string} text
 * @param {{keepText?: string}} [opts]  keepText: the KB pack as shown to the model
 * @returns {{text: string, changes: string[]}}
 */
export function humanizeReply(text, { keepText = '' } = {}) {
  const original = String(text ?? '');
  if (!original.trim()) return { text: original, changes: [] };
  const changes = [];
  const keepNorm = keepText ? norm(keepText) : '';

  // A trailing "— Name" sign-off stays exactly as written.
  const signOff = original.match(/([.!?]\s*|\n\s*)([—–-]\s*[A-Z][A-Za-z.'’ ]{0,40}?)\s*$/);
  let body = signOff ? original.slice(0, signOff.index + signOff[1].length) : original;
  const tail = signOff ? signOff[2] : '';
  const tailSep = signOff && /\n/.test(signOff[1]) ? '\n' : ' ';

  // Sentence-level passes.
  let parts = sentences(body);
  const isSentence = (s) => /\S/.test(s) && !/^\n+$/.test(s);

  // 1. Stacked stock openers at the start → keep the first.
  const firstIdx = parts.findIndex(isSentence);
  if (firstIdx >= 0 && OPENERS.has(bare(parts[firstIdx]))) {
    let j = firstIdx + 1;
    while (j < parts.length && isSentence(parts[j]) && OPENERS.has(bare(parts[j]))) {
      parts[j] = '';
      changes.push('stacked_opener');
      j++;
    }
  }

  // 2. Throat-clearing lead-ins and self-commentary.
  parts = parts.map((s) => {
    if (!isSentence(s)) return s;
    const lead = s.match(/^\s*/)[0];
    const core = s.slice(lead.length);
    if (META_SENTENCE_RX.test(core.trim())) { changes.push('metadiscourse'); return ''; }
    const metaLead = core.match(META_LEADIN_RX);
    if (metaLead && core.length > metaLead[0].length + 3) { changes.push('metadiscourse'); return lead + cap(core.slice(metaLead[0].length)); }
    const throat = core.match(THROAT_RX);
    if (throat && core.length > throat[0].length + 3) { changes.push('throat_clearing'); return lead + cap(core.slice(throat[0].length)); }
    return s;
  });
  body = parts.join('');

  // 3. Em dashes, a sentence at a time. A sentence that quotes a locked line
  // keeps ALL its dashes: fixing one of a pair would mangle the quote.
  let dashChanged = false;
  body = sentences(body).map((s) => {
    const dashes = [...s.matchAll(DASH_RX)];
    if (!dashes.length) return s;
    if (dashes.some((m) => insideKept(s, m.index + m[0].search(/[—–-]/), keepNorm))) return s;
    const fixed = fixDashes(s);
    if (fixed.changed) dashChanged = true;
    return fixed.text;
  }).join('');
  if (dashChanged) changes.push('em_dash');

  // 4. Safe word swaps.
  for (const [rx, to] of WORD_SWAPS) {
    if (rx.test(body)) { body = body.replace(rx, (w) => (w[0] === w[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to)); changes.push('plain_word'); }
    rx.lastIndex = 0;
  }

  if (!changes.length) return { text: original, changes };

  body = body.replace(/[ \t]{2,}/g, ' ').replace(/ ,/g, ',').replace(/,\s*,/g, ',').replace(/^\s+/, '');
  const out = (body.replace(/\s+$/, '') + (tail ? tailSep + tail : '')).trim();

  // Never lose the reply, and never lose its question.
  if (!out || (original.includes('?') && !out.includes('?'))) return { text: original, changes: [] };
  return { text: out, changes: [...new Set(changes)] };
}
