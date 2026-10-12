// ─── SMS reply format — src/agentic/sms-format.js ──────────────────────────
//
// WHY (handoff "Lead Conversation Stage", PR 6, 2026-10-12; AIOS batch 3)
//   The text bot's drafts reached leads with:
//   - a sentence fragment as the opener ("With a quote on your 12 windows.");
//   - the "— Reece Team" sign-off twice, mid-message, or on one reply and not
//     the next, because only the prompt decided it;
//   - "our scheduled call time already passed" answering a plain "Hi", twice:
//     a stale call nobody raised;
//   - a reply nearly identical to the one before it (batch 3 #6);
//   - a promised call recorded after "leave me alone" (the simulator's
//     "would record promised call").
//   Each pass here deletes or swaps; none invents copy. PURE.

// ── a fragment opener ────────────────────────────────────────────────────

const FRAGMENT_LEAD_RX = /^(?:with|for|on|about|regarding|as\s+for|given|after|before|in\s+terms\s+of)\b/i;
// A finite verb or a contraction that makes a clause a sentence.
const VERB_RX = /\b(?:is|are|was|were|be|been|will|would|can|could|should|shall|may|might|must|have|has|had|do|does|did|get|gets|need|needs|want|wants|make|makes|let|take|takes|help|helps|work|works|sound|sounds|look|looks|see|come|comes|go|goes|give|gives|offer|offers|happy|glad)\b|(?:'s|’s|'re|’re|'ll|’ll|'ve|’ve|'d|’d|n't|n’t)\b/i;

function splitSentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

/** Is this sentence a fragment ("With a quote on your 12 windows.")? Pure. */
export function isFragment(sentence) {
  const s = String(sentence || '').trim();
  if (!FRAGMENT_LEAD_RX.test(s)) return false;
  if (s.includes(',') || s.includes('?')) return false;
  return !VERB_RX.test(s);
}

/** Drop a fragment opener when something is left after it. Pure. */
export function dropFragmentOpener(text) {
  const parts = splitSentences(text);
  if (parts.length < 2 || !isFragment(parts[0])) return { text: String(text || ''), changed: false };
  return { text: parts.slice(1).join(' '), changed: true };
}

// ── the sign-off ─────────────────────────────────────────────────────────

/**
 * The sign-off exactly once, at the end, or not at all. `sign` says whether
 * this reply signs (the thread has not been signed yet). Pure.
 */
export function normalizeSignature(text, { signature = null, sign = false } = {}) {
  const raw = String(text || '');
  if (!signature) return { text: raw, changed: false };
  const escaped = String(signature).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const anyRx = new RegExp(`\\s*[—–-]\\s*(?:the\\s+)?${escaped}\\b\\s*([.!]?)`, 'gi');
  const stripped = raw.replace(anyRx, '$1').replace(/\s{2,}/g, ' ').replace(/([.!?])(?=[A-Z])/g, '$1 ').trim();
  const out = sign ? `${stripped} — ${signature}` : stripped;
  return { text: out, changed: out !== raw.trim() };
}

// ── a stale call mention ─────────────────────────────────────────────────

// "our scheduled call time already passed", "we missed you on the call",
// "sorry we missed your call", "the call came and went".
const STALE_CALL_RX = /\b(?:(?:scheduled|our|the|your)\s+(?:phone\s+)?call(?:\s+time)?\b[^.?!]{0,40}\b(?:passed|came\s+and\s+went|missed)|missed\s+(?:you\s+on\s+)?(?:the|our|your)\s+(?:scheduled\s+)?call|(?:we|i)\s+missed\s+(?:you|connecting))\b/i;
// The lead raised a call themselves.
const LEAD_CALL_RX = /\b(?:call(?:ed|ing)?|phone|rang|missed|voicemail)\b/i;

/**
 * Drop a sentence about a missed or passed call unless the lead raised a call
 * or the call was within the last 24 hours (`recentCall`). Pure.
 */
export function dropStaleCallMention(text, { inbound = '', recentCall = false } = {}) {
  const raw = String(text || '');
  if (recentCall || LEAD_CALL_RX.test(String(inbound || ''))) return { text: raw, changed: false };
  const parts = splitSentences(raw);
  const kept = parts.filter(s => !STALE_CALL_RX.test(s));
  if (kept.length === parts.length || !kept.length) return { text: raw, changed: false };
  return { text: kept.join(' '), changed: true };
}

// ── a near repeat of our last message ─────────────────────────────────────

function words(text) {
  return String(text || '').toLowerCase().replace(/[—–-]\s*[a-z ]+$/i, '').match(/[a-z0-9']+/g) || [];
}

/** Word-overlap similarity of two replies (0..1, Jaccard on words). Pure. */
export function replySimilarity(a, b) {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

export const NEAR_REPEAT_THRESHOLD = 0.8;

/** Is the draft nearly the same as our previous message? Pure. */
export function isNearRepeat(draft, lastOutbound, threshold = NEAR_REPEAT_THRESHOLD) {
  if (!lastOutbound || !draft) return false;
  return replySimilarity(draft, lastOutbound) >= threshold;
}

export const NEAR_REPEAT_NOTE = 'Your draft says nearly the same thing as your previous message. The lead has read that already. Answer what they just said in new words, move the conversation one step forward, and do not repeat your last message.';

// ── a promised call on a close ───────────────────────────────────────────

const CLOSE_OR_OPT_OUT_RX = /^\s*(?:stop|stopall|unsubscribe|quit|end)\s*[.!]*\s*$|\bleave\s+me\s+alone\b|\b(?:stop|quit)\s+(?:texting|messaging|contacting|calling)\b|\b(?:do\s+not|don'?t|dont)\s+(?:text|contact|call|message)\s+(?:me|us)\b|\bnot\s+interested\b|\bgo\s+away\b|\bremove\s+me\b|\btake\s+me\s+off\b/i;

/**
 * May a promise of a call in this reply be recorded (promised_callbacks)?
 * Not when the lead opted out or closed the conversation, nor on a planned
 * close or the two-no's stop: those replies promise no call. Pure.
 */
export function shouldRecordPromise({ trigger = '', plan = null } = {}) {
  if (CLOSE_OR_OPT_OUT_RX.test(String(trigger || ''))) return false;
  const step = plan?.step || null;
  if (step === 'close' || step === 'not_interested') return false;
  if (plan?.handoff?.reason === 'two_nos' || plan?.handoff === 'two_nos') return false;
  return true;
}
