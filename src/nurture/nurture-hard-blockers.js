/**
 * Nurture Hard Blockers — src/nurture/nurture-hard-blockers.js
 *
 * Pass A of the two-pass scoring. Deterministic checks, no LLM calls,
 * runs in <50ms. Pairs with message-content-scorer.js (Pass B).
 *
 * Rule: ANY blocker failure is blocking. Caller retries once with the
 * blocker codes injected into the prompt; if retry fails, suppress.
 *
 * Each blocker has a code from HARD_BLOCKER_CODES. Failures are
 * persisted in agentic_messages.hard_blocker_failures (text[]).
 *
 * Adding a new blocker requires updating:
 *   1. HARD_BLOCKER_CODES
 *   2. The corresponding check in runHardBlockers()
 *   3. Any analytics queries that enumerate codes
 */

export const HARD_BLOCKER_CODES = Object.freeze({
  SUBJECT_TOO_LONG:        'SUBJECT_TOO_LONG',
  PREHEADER_TOO_LONG:      'PREHEADER_TOO_LONG',
  BODY_TOO_SHORT:          'BODY_TOO_SHORT',
  BODY_TOO_LONG:           'BODY_TOO_LONG',
  SMS_TOO_LONG:            'SMS_TOO_LONG',
  BANNED_PHRASE:           'BANNED_PHRASE',
  MISSING_FIRST_NAME:      'MISSING_FIRST_NAME',
  MISSING_BOOKING_LINK:    'MISSING_BOOKING_LINK',
  FAKE_URGENCY:            'FAKE_URGENCY',
  STORY_ARC_REPEAT:        'STORY_ARC_REPEAT',
  INVALID_OUTPUT_SHAPE:    'INVALID_OUTPUT_SHAPE',
  SUBJECT_RECENTLY_USED:   'SUBJECT_RECENTLY_USED',
});

// Phrases that indicate fake urgency unless the prompt has a real
// scarcity signal in context (context.scarcity_real === true).
const FAKE_URGENCY_PHRASES = [
  'expires today',
  'expires tomorrow',
  'only 24 hours',
  'last chance',
  'final notice',
  "don't miss out",
  'dont miss out',
  'act now',
  'limited time',
  'hurry',
];

// Always-banned phrases regardless of the prompt's own banned_phrases.
const ALWAYS_BANNED = [
  'dear valued customer',
];

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Run all Pass A checks against output + prompt + context.
 *
 * @param {object} output   — LLM-generated content
 * @param {object} prompt   — prompt row (for prompt-specific banned_phrases)
 * @param {object} context  — context envelope (for stories_already_deployed etc.)
 * @returns {{ passed: boolean, failures: string[] }}
 */
export function runHardBlockers(output, prompt, context) {
  const failures = [];

  // 1. Output shape — short-circuit; further checks would NPE
  if (!output || typeof output !== 'object') {
    return { passed: false, failures: [HARD_BLOCKER_CODES.INVALID_OUTPUT_SHAPE] };
  }

  // 2. Subject length
  if (output.subject !== undefined && output.subject !== null) {
    if (typeof output.subject !== 'string' || output.subject.length > 60) {
      failures.push(HARD_BLOCKER_CODES.SUBJECT_TOO_LONG);
    }
  }

  // 3. Preheader length
  if (output.preheader !== undefined && output.preheader !== null) {
    if (typeof output.preheader !== 'string' || output.preheader.length > 90) {
      failures.push(HARD_BLOCKER_CODES.PREHEADER_TOO_LONG);
    }
  }

  // 4. Body word count
  if (output.body_html !== undefined && output.body_html !== null) {
    const wordCount = stripHtml(output.body_html).split(/\s+/).filter(Boolean).length;
    if (wordCount < 200) failures.push(HARD_BLOCKER_CODES.BODY_TOO_SHORT);
    if (wordCount > 500) failures.push(HARD_BLOCKER_CODES.BODY_TOO_LONG);
  }

  // 5. SMS length
  if (output.sms_body !== undefined && output.sms_body !== null) {
    if (typeof output.sms_body !== 'string' || output.sms_body.length > 160) {
      failures.push(HARD_BLOCKER_CODES.SMS_TOO_LONG);
    }
  }

  // 6. Banned phrases — always-banned + prompt-specific
  const fullText = [output.subject, output.preheader, output.body_html, output.sms_body]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const promptBanned = Array.isArray(prompt?.banned_phrases) ? prompt.banned_phrases : [];
  const allBanned = [...ALWAYS_BANNED, ...promptBanned.map(s => String(s).toLowerCase())];
  for (const phrase of allBanned) {
    if (phrase && fullText.includes(phrase)) {
      failures.push(HARD_BLOCKER_CODES.BANNED_PHRASE);
      break;
    }
  }

  // 7. First name presence in body
  if (output.body_html && context?.lead?.first_name) {
    const firstName = String(context.lead.first_name).toLowerCase();
    if (!output.body_html.toLowerCase().includes(firstName)) {
      failures.push(HARD_BLOCKER_CODES.MISSING_FIRST_NAME);
    }
  }

  // 8. Booking link in body — accepts http(s) URL or {{trigger_link.*}} tag
  if (output.body_html) {
    const hasUrl = /https?:\/\//i.test(output.body_html);
    const hasMergeTag = /\{\{\s*trigger_link\./i.test(output.body_html);
    if (!hasUrl && !hasMergeTag) {
      failures.push(HARD_BLOCKER_CODES.MISSING_BOOKING_LINK);
    }
  }

  // 9. Fake urgency — unless context.scarcity_real flag is set
  const scarcityReal = context?.scarcity_real === true;
  if (!scarcityReal) {
    for (const phrase of FAKE_URGENCY_PHRASES) {
      if (fullText.includes(phrase)) {
        failures.push(HARD_BLOCKER_CODES.FAKE_URGENCY);
        break;
      }
    }
  }

  // 10. Story arc repeat — last 4 deployed
  const recentArcs = (context?.nurture?.stories_already_deployed || []).slice(-4);
  if (output.story_arc_used && recentArcs.includes(output.story_arc_used)) {
    failures.push(HARD_BLOCKER_CODES.STORY_ARC_REPEAT);
  }

  // 11. Subject novelty — last 10 used (case-insensitive)
  if (output.subject && Array.isArray(context?.nurture?.subjects_already_used)) {
    const recentSubjects = context.nurture.subjects_already_used.map(s => String(s).toLowerCase());
    if (recentSubjects.includes(String(output.subject).toLowerCase())) {
      failures.push(HARD_BLOCKER_CODES.SUBJECT_RECENTLY_USED);
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}
