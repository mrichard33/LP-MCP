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
 *
 * v1.1 — 2026-05-11. Adds two compliance-gate blockers surfaced from
 *   the S4.5 storyline rotation calendar (§7):
 *     BRAND_LINE_VIOLATION — ties "founded"/"1972" to Florida without
 *       the North Carolina qualifier. Reece was founded in NC in 1972;
 *       Florida operations began in 2005. "Florida company founded in
 *       1972" is a violation regardless of phrasing.
 *     OUTCOME_GUARANTEE — outcome-bound insurance/claim language. All
 *       process language must be true-to-mechanism ("classified",
 *       "documented", "files reviewed") — never "we guarantee your
 *       claim will be paid" or "we'll lower your premium". Past-tense
 *       parable references about other families are NOT flagged; the
 *       patterns require "your" or explicit guarantee verbs.
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
  // v1.1 — compliance gates from S4.5 storyline rotation calendar §7
  BRAND_LINE_VIOLATION:    'BRAND_LINE_VIOLATION',
  OUTCOME_GUARANTEE:       'OUTCOME_GUARANTEE',
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

// v1.1: BRAND_LINE_VIOLATION detection.
// Searches for "founded" / "1972" / "since 19xx" and flags when "florida"
// appears within ±80 chars WITHOUT a North Carolina qualifier ("north
// carolina", "winston-salem", " NC " bordered as a token).
//
// The qualifier check is intentionally permissive — any of the three
// signals nearby is enough to clear the flag. This avoids false
// positives on legitimate copy like "Founded in North Carolina in 1972,
// serving Florida since 2005." Bare "since 1972" with no Florida claim
// also passes (the proximity check fails).
const FOUNDER_TERMS = [
  /\bfounded\b/i,
  /\b1972\b/,
  /\bsince\s+19\d{2}\b/i,
  /\bstarted\s+in\s+19\d{2}\b/i,
  /\bbegan\s+in\s+19\d{2}\b/i,
];

const FLORIDA_PATTERN = /\b(florida|south florida)\b/i;
const NC_QUALIFIER_PATTERN = /\b(north\s+carolina|winston[- ]?salem|\bnc\b)/i;
const BRAND_LINE_WINDOW = 80;

function hasBrandLineViolation(text) {
  if (!text) return false;

  for (const termRx of FOUNDER_TERMS) {
    // Scan all occurrences of this founder term
    const rx = new RegExp(termRx.source, termRx.flags.includes('g') ? termRx.flags : termRx.flags + 'g');
    let match;
    while ((match = rx.exec(text)) !== null) {
      const start = Math.max(0, match.index - BRAND_LINE_WINDOW);
      const end = Math.min(text.length, match.index + match[0].length + BRAND_LINE_WINDOW);
      const window = text.slice(start, end);
      if (FLORIDA_PATTERN.test(window) && !NC_QUALIFIER_PATTERN.test(window)) {
        return true;
      }
    }
  }
  return false;
}

// v1.1: OUTCOME_GUARANTEE detection.
// Eight patterns covering the flagrant cases. Past-tense third-person
// parable references about other families (e.g. "premiums dropped over
// $3,800/year for that family") are intentionally NOT matched — the
// patterns require either "your" addressed to the reader or an explicit
// "guarantee/promise/will" verb tied to a financial outcome.
const OUTCOME_GUARANTEE_PATTERNS = [
  /\bguarantee[ds]?\s+(your|that|to|claim|payout|approval|savings|coverage|premium|reduction)/i,
  /\bwe\s+(?:will|'ll|guarantee)\s+(?:lower|reduce|cut|drop)\s+your\s+(?:premium|premiums|insurance|rate)/i,
  /\byour\s+(?:premium|premiums|rate|rates)\s+(?:will|'ll)\s+(?:drop|reduce|lower|decrease|go\s+down)/i,
  /\b(?:promise|promised|promising)\s+(?:to\s+)?(?:lower|reduce|cut|drop)\s+your\s+(?:premium|insurance)/i,
  /\bguaranteed\s+(?:savings|reduction|approval|payout|claim)/i,
  /\bwe(?:'ll| will)\s+save\s+you\b/i,
  /\byour\s+claim\s+(?:will|'ll)\s+(?:be|get)\s+(?:paid|approved|covered)/i,
  /\bclaim\s+approval\s+guaranteed\b/i,
];

function hasOutcomeGuarantee(text) {
  if (!text) return false;
  for (const rx of OUTCOME_GUARANTEE_PATTERNS) {
    if (rx.test(text)) return true;
  }
  return false;
}

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

  // v1.1
  // 12. Brand-line violation — "founded" / "1972" tied to Florida without NC qualifier.
  //     Scans subject + preheader + body + SMS (concatenated, preserve case for the
  //     regex tests). False positives are rare because the NC qualifier check has
  //     three escape hatches (north carolina / winston-salem / NC token).
  const fullTextPreserveCase = [output.subject, output.preheader, output.body_html, output.sms_body]
    .filter(Boolean)
    .join(' ');
  if (hasBrandLineViolation(fullTextPreserveCase)) {
    failures.push(HARD_BLOCKER_CODES.BRAND_LINE_VIOLATION);
  }

  // 13. Outcome guarantee — outcome-bound insurance/claim language addressed to the
  //     reader. Past-tense parable references about other families are NOT flagged.
  if (hasOutcomeGuarantee(fullTextPreserveCase)) {
    failures.push(HARD_BLOCKER_CODES.OUTCOME_GUARANTEE);
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}
