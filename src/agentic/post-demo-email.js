// ─── A post-demo lead who declines by email — src/agentic/post-demo-email.js ─
//
// WHY (Mark, 2026-10-19; Thomas Geary, GHL aueIFUNV3UeZpATu51hc, LP Prospect
// 461733, agent_actions 573254)
//   Thomas, a rehash lead (OPPFDN 10/10), emailed a firm decline with a reason:
//   "We will not be investing 25 % of purchased value when the market value
//   will not justify the cost." The reply worked the objection well (the
//   reframe, the proposal good for a year, his notes to our follow-up team) and
//   then closed on "If anything about the numbers or the warranty terms is
//   still unclear, what is the part you would want walked through again." The
//   post-demo planner is SMS only, so nothing on the email path knew.
//
//   Mark's ruling:
//   - a firm decline by email gets ONE reply that works the objection, and it
//     ends WITHOUT a question; everything else in it may stay;
//   - a second decline after that reply gets a short warm close: thanks, the
//     door open, no reframe, no question.
//
// planPostDemoEmail decides the turn from the lead's words and the plan step
// our previous SENT reply ran on (bot_message_context.plan_step, never our
// wording). enforcePostDemoEmail applies it to the model's draft. The prompt
// is unchanged on a first decline; a second decline adds one plan line
// (P.postDemoEmailCloseBlock).
//
// PURE. No I/O.

import { detectDeferral } from './post-demo-turn.js';
import { isNotInterested } from './not-interested.js';
import { isRehashNo } from './rehash-nepq.js';
import { isPurchasedElsewhere } from './purchased-elsewhere.js';
import { restoreQuestionMark } from './human-voice.js';
import { POST_DEMO_REBUTTAL_RX } from './nepq-planner.js';
import { isPostDemoLead } from './post-demo-lead.js';

export const EMAIL_POST_DEMO_MODES = Object.freeze(['off', 'shadow', 'live']);

/** EMAIL_POST_DEMO_MODE off|shadow|live, default live (Mark, 2026-10-19); a typo is shadow. */
export function emailPostDemoMode(env = process.env) {
  const raw = String(env.EMAIL_POST_DEMO_MODE ?? '').trim().toLowerCase();
  if (!raw) return 'live';
  return EMAIL_POST_DEMO_MODES.includes(raw) ? raw : 'shadow';
}

// The plan steps a reply is recorded under (bot_message_context.plan_step).
export const DECLINE_FIRST_STEP = 'post_demo_email_decline_first';
export const DECLINE_CLOSE_STEP = 'post_demo_email_decline_close';

/** The step a decline kind is recorded under, or null. Pure. */
export function planStepFor(kind) {
  if (kind === 'decline_first') return DECLINE_FIRST_STEP;
  if (kind === 'decline_close') return DECLINE_CLOSE_STEP;
  return null;
}

/**
 * The email turn for a post-demo lead, or null (the email is unchanged).
 *   signed_elsewhere  they bought from someone else (PURCHASED_ELSEWHERE_RX)
 *   defer             a dated "follow up later" (wins over a decline:
 *                     "won't be investing until spring")
 *   decline_first     a firm decline, and our previous reply was not a decline reply
 *   decline_close     a decline (any no, a sign-off too) after our decline reply
 * A message with a question gets an answer, never a decline turn. Pure.
 * @param {{ trigger: string, lastPlanStep?: string|null, nowMs?: number }} a
 */
export function planPostDemoEmail({ trigger, lastPlanStep = null, nowMs = Date.now() } = {}) {
  const t = String(trigger || '');
  if (!t.trim()) return null;
  if (isPurchasedElsewhere(t)) return 'signed_elsewhere';
  if (detectDeferral(t, nowMs)) return 'defer';
  if (t.includes('?')) return null;
  const afterDecline = lastPlanStep === DECLINE_FIRST_STEP || lastPlanStep === DECLINE_CLOSE_STEP;
  if (afterDecline && isRehashNo(t)) return 'decline_close';
  if (isNotInterested(t)) return afterDecline ? 'decline_close' : 'decline_first';
  return null;
}

/**
 * A post-demo lead's firm decline, on any channel (rule condition
 * not_post_demo_decline, 2026-10-19): the reply answers it and rule 297 owns
 * the cooling track, so O.0 is never enrolled beside it (agent_actions 573250 /
 * 573270 put Thomas in O.0 twice next to the email). A question or a dated
 * deferral is not a decline (isNotInterested). Pure.
 * @param {{ tags?: string[], text?: string }} a
 */
export function isPostDemoDecline({ tags = [], text = '' } = {}) {
  return isPostDemoLead({ tags }) && isNotInterested(text);
}

// ─── Sentences, keeping the email's paragraphs and lines ──────────────────
// A boundary is end punctuation followed by a space: "getreecewindows.com" and
// a URL's "?" never split a sentence.
function structure(text) {
  return String(text || '').split(/\n[ \t]*\n/).map(p => p.split('\n').map(l => l.split(/(?<=[.!?]["”’')\]]?)[ \t]+/)));
}

function render(paragraphs) {
  return paragraphs
    .map(p => p.map(l => l.filter(s => s.trim()).join(' ')).filter(l => l.trim()).join('\n'))
    .filter(p => p.trim())
    .join('\n\n')
    .trim();
}

/** Does this sentence ask? A "?" or a question written with a period. Pure. */
export function sentenceAsks(sentence) {
  const s = String(sentence || '').trim();
  if (!s) return false;
  if (s.includes('?')) return true;
  return /\.$/.test(s) && restoreQuestionMark(s).changed;
}

/** Drop the sentences a predicate flags, keeping paragraphs. Returns { text, dropped }. Pure. */
export function dropSentences(text, predicate) {
  let dropped = 0;
  const kept = structure(text).map(p => p.map(l => l.filter((s) => {
    if (s.trim() && predicate(s)) { dropped++; return false; }
    return true;
  })));
  return { text: render(kept), dropped };
}

/** The draft minus its last sentence (the never-empty floor). Pure. */
function withoutLastSentence(text) {
  const p = structure(text);
  for (let i = p.length - 1; i >= 0; i--) {
    for (let j = p[i].length - 1; j >= 0; j--) {
      const line = p[i][j];
      for (let k = line.length - 1; k >= 0; k--) {
        if (line[k].trim()) { line.splice(k, 1); return render(p); }
      }
    }
  }
  return '';
}

/** The second decline's reference, and its backup when the draft empties. */
export function declineCloseLine(firstName) {
  const name = String(firstName || '').trim().split(/\s+/)[0];
  return `Thank you${name && !/^guest$/i.test(name) ? `, ${name}` : ''}. We understand, and we respect your decision. ` +
    'Your proposal stays good for a full year, so if anything changes, just reply here.';
}

/**
 * Apply the turn to the model's draft. Pure.
 *   decline_first  every sentence that asks goes (a question written with a
 *                  period included); the reframe, the proposal line and the
 *                  follow-up-team line stay. Never empty: the draft minus its
 *                  last sentence.
 *   decline_close  questions and rebuttal sentences (POST_DEMO_REBUTTAL_RX) go;
 *                  an emptied draft becomes the close line.
 * Any other kind returns the draft unchanged.
 * @returns {{ text: string, dropped: number, changed: boolean }}
 */
export function enforcePostDemoEmail(draft, kind, { firstName = null } = {}) {
  const original = String(draft || '');
  if (kind !== 'decline_first' && kind !== 'decline_close') return { text: original, dropped: 0, changed: false };
  // The whole draft first: the bad line was a question ending in a period.
  const marked = restoreQuestionMark(original);
  const base = marked.changed ? marked.text : original;
  const drop = kind === 'decline_first'
    ? (s) => sentenceAsks(s)
    : (s) => sentenceAsks(s) || POST_DEMO_REBUTTAL_RX.test(s);
  let { text, dropped } = dropSentences(base, drop);
  if (!text.trim()) {
    text = kind === 'decline_first' ? withoutLastSentence(original) : declineCloseLine(firstName);
    if (!text.trim()) text = declineCloseLine(firstName);
  }
  return { text, dropped, changed: text !== original };
}

export default { emailPostDemoMode, planPostDemoEmail, isPostDemoDecline, enforcePostDemoEmail, planStepFor, declineCloseLine, sentenceAsks, dropSentences };
