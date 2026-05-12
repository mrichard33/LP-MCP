/**
 * Nurture Safety Validator — src/nurture/nurture-safety-validator.js
 *
 * Replaces the prior nurture-hard-blockers.js (Pass A judge). Renamed
 * to make the architectural intent unambiguous: this layer answers
 * "is this email safe to ship?" — NOT "is this email good copy?"
 *
 * The old Pass A grew from a handful of structural checks into a
 * stylistic critic with 17 codes, many of which fought our own
 * architecture (MISSING_BOOKING_LINK fought the CTA evolution layer,
 * STORY_ARC_REPEAT killed legitimate rotations, WEAK_CTA_TEXT had
 * no defensible safety rationale, etc.). Combined with the soft
 * judge below it, the system suppressed 97% of generations.
 *
 * Philosophy (Mark, 2026-05-12):
 *   "Suppress only if the email would materially damage trust, violate
 *    compliance, create operational confusion, expose data, contradict
 *    destination/context, or break the sequence. Otherwise: ship."
 *
 * THE FIVE BLOCKERS — and only these five:
 *
 *   1. BRAND_LINE_VIOLATION
 *      Claims about Reece's founding that misattribute origin (e.g.
 *      "founded in 1972 in Florida" — Reece was founded in NC in 1972
 *      with FL operations from 2005). Founder-line truth is non-
 *      negotiable.
 *
 *   2. PROHIBITED_CLAIM
 *      The model makes a promise the business can't make. Three
 *      categories collapsed here:
 *        (a) Outcome guarantees — "we'll cut your premiums", "your
 *            claim will be approved", "we guarantee savings".
 *        (b) Fake urgency — "expires today", "last chance", "only 24
 *            hours" when no real scarcity signal exists in context.
 *        (c) Always-banned phrases — "dear valued customer" and the
 *            prompt-row's banned_phrases list.
 *
 *   3. PERSONAL_DATA_LEAK
 *      The model hallucinated personally identifying data into the
 *      email. SSN, credit card patterns, account-number-shaped
 *      strings, phone numbers other than Reece's published numbers,
 *      or street addresses that don't match the contact's known
 *      address. A bait-and-switch on identity is unfixable downstream.
 *
 *   4. NULL_BODY
 *      The model produced effectively no body content. Output object
 *      missing, body_html empty, or word count < 50. Distinct from
 *      "short on words" — this is "structurally broken output."
 *
 *   5. DESTINATION_PROMISE_MISMATCH
 *      The copy promises content type X but the linked destination is
 *      type Y. The bait-and-switch we discovered in WK3: "see your
 *      risk profile" copy attached to a generic Window Estimate
 *      booking page. Damages trust coherence even when every other
 *      dimension is fine.
 *
 * Everything else either auto-fixes (see nurture-autofix.js — applied
 * to output BEFORE this validator runs) or ships unmodified.
 *
 * IMPORTANT: There is NO retry layer above this anymore. The orchestrator
 * runs the autofix pipeline, then validates safety, then either ships
 * or suppresses — one shot. Pass B (the LLM soft judge) is no longer
 * called from the nurture orchestrator.
 *
 * v2.0 — 2026-05-12. Initial safety-validator refactor. Replaces
 *   runHardBlockers() and the 17-code list with validateSafety() and
 *   the 5-code list. Companion to autofix pipeline.
 */

export const SAFETY_CODES = Object.freeze({
  BRAND_LINE_VIOLATION:          'BRAND_LINE_VIOLATION',
  PROHIBITED_CLAIM:              'PROHIBITED_CLAIM',
  PERSONAL_DATA_LEAK:            'PERSONAL_DATA_LEAK',
  NULL_BODY:                     'NULL_BODY',
  DESTINATION_PROMISE_MISMATCH:  'DESTINATION_PROMISE_MISMATCH',
});

// ─── BRAND_LINE_VIOLATION ────────────────────────────────────────────
// Preserved verbatim from the old hard-blockers v1.1 — the detection
// is well-tuned and has caught real failures in production. The rule:
// any mention of Reece's founding/origin that places it in Florida
// without a North Carolina qualifier nearby is a violation.

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

// ─── PROHIBITED_CLAIM ────────────────────────────────────────────────
// Consolidated from old OUTCOME_GUARANTEE + FAKE_URGENCY + BANNED_PHRASE.
// Three sub-detectors; any single hit fails the check.

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

const ALWAYS_BANNED = [
  'dear valued customer',
];

function hasOutcomeGuarantee(text) {
  if (!text) return false;
  for (const rx of OUTCOME_GUARANTEE_PATTERNS) {
    if (rx.test(text)) return true;
  }
  return false;
}

function hasFakeUrgency(textLower, scarcityReal) {
  if (scarcityReal) return false;
  for (const phrase of FAKE_URGENCY_PHRASES) {
    if (textLower.includes(phrase)) return true;
  }
  return false;
}

function hasBannedPhrase(textLower, promptBanned) {
  const allBanned = [...ALWAYS_BANNED, ...promptBanned.map(s => String(s).toLowerCase())];
  for (const phrase of allBanned) {
    if (phrase && textLower.includes(phrase)) return true;
  }
  return false;
}

// ─── PERSONAL_DATA_LEAK ──────────────────────────────────────────────
// Detect hallucinated personal data in the output. Patterns target
// the most common leakage modes:
//   - SSN (XXX-XX-XXXX)
//   - Credit card patterns (16-digit groups in known formats)
//   - Account-number-shaped strings (8+ consecutive digits, not part of
//     a phone, year, or measurement)
//   - Phone numbers that aren't Reece's published numbers and don't
//     match the contact's own phone
//   - Street addresses that don't match the contact's stored address
//
// Defensive bias: we'd rather false-positive and require regeneration
// than send personal data the model invented.

const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/;

// Credit card: 4-4-4-4 with optional separators, common card prefixes.
const CC_PATTERN = /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6011)[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/;

// Phone-shaped: (xxx) xxx-xxxx, xxx-xxx-xxxx, xxx.xxx.xxxx, +1 prefix.
const PHONE_PATTERN = /(?:\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;

// Reece's published numbers (canonical phone for the company).
// Any of these forms is allowed. The literal company number from
// brand assets — verified against the website footer.
const REECE_PHONE_DIGITS = ['9542545990']; // 954-254-5990

function normalizePhone(s) {
  return String(s).replace(/\D/g, '').replace(/^1/, '');
}

function hasUnknownPhone(text, contactPhone) {
  if (!text) return false;
  const allowed = new Set([...REECE_PHONE_DIGITS]);
  if (contactPhone) {
    const c = normalizePhone(contactPhone);
    if (c.length >= 10) allowed.add(c.slice(-10));
  }
  const matches = String(text).match(PHONE_PATTERN) || [];
  for (const m of matches) {
    const digits = normalizePhone(m);
    if (digits.length < 10) continue;
    const last10 = digits.slice(-10);
    if (!allowed.has(last10)) return true;
  }
  return false;
}

// Address-shaped: number + street word + (street suffix).
// We only flag if the body contains an address-shaped string and the
// contact has a known address that DOESN'T match.
const ADDRESS_PATTERN = /\b(\d{2,5})\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+(Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl|Highway|Hwy)\b/g;

function hasUnknownAddress(text, contactAddress) {
  if (!text) return false;
  const matches = String(text).match(ADDRESS_PATTERN) || [];
  if (matches.length === 0) return false;
  // No contact address on file → any address is suspicious (model
  // wouldn't have a legitimate basis to write one).
  if (!contactAddress) return true;
  const contactLower = String(contactAddress).toLowerCase();
  for (const m of matches) {
    const mLower = m.toLowerCase();
    // Match by street-number presence — exact match too strict.
    const numMatch = mLower.match(/^\d+/);
    if (!numMatch || !contactLower.includes(numMatch[0])) return true;
  }
  return false;
}

// Account-number-shaped: 8+ consecutive digits not preceded/followed
// by other digits, NOT a phone (those are caught above), NOT a year,
// NOT a measurement. This is intentionally narrow.
const ACCOUNT_NUM_PATTERN = /(?<!\d)\d{8,16}(?!\d)/g;

function hasAccountNumberLeak(text) {
  if (!text) return false;
  const matches = String(text).match(ACCOUNT_NUM_PATTERN) || [];
  for (const m of matches) {
    // Years like 19720519 (8 digits) could false-positive — but if
    // the model is emitting a bare 8-digit string in body copy without
    // context, that's almost certainly a leak. We accept the false-
    // positive rate here; the orchestrator will suppress and the
    // human will regenerate.
    if (m.length >= 8) return true;
  }
  return false;
}

function hasPersonalDataLeak(output, context) {
  const text = [output.subject, output.preheader, output.body_html, output.ps_text, output.sms_body]
    .filter(Boolean)
    .join(' ');
  if (SSN_PATTERN.test(text)) return 'ssn_pattern';
  if (CC_PATTERN.test(text)) return 'credit_card_pattern';
  if (hasUnknownPhone(text, context?.lead?.phone)) return 'unknown_phone_number';
  if (hasUnknownAddress(text, context?.lead?.address1 || context?.lead?.address)) return 'unknown_street_address';
  if (hasAccountNumberLeak(text)) return 'account_number_pattern';
  return null;
}

// ─── NULL_BODY ───────────────────────────────────────────────────────
// Replaces INVALID_OUTPUT_SHAPE + BODY_TOO_SHORT. The new threshold is
// 50 words — below that the email is structurally broken, not just
// short. We dropped the old 200-word minimum: a tight 80-word Seinfeld
// email is fine.

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function hasNullBody(output) {
  if (!output || typeof output !== 'object') return 'output_not_object';
  if (!output.body_html && !output.sms_body) return 'body_missing';
  if (output.body_html) {
    const wordCount = stripHtml(output.body_html).split(/\s+/).filter(Boolean).length;
    if (wordCount < 50) return `body_word_count_${wordCount}`;
  }
  if (output.sms_body && typeof output.sms_body === 'string' && output.sms_body.trim().length === 0) {
    return 'sms_body_empty';
  }
  return null;
}

// ─── DESTINATION_PROMISE_MISMATCH ────────────────────────────────────
// The bait-and-switch detector. We classify each URL in the body/ps
// by destination type, then scan the surrounding copy for promise
// phrases that would mislead the recipient about what they'll find
// when they click.
//
// Approach: heuristic, deterministic, no LLM call. The destination
// table covers the URL families used by Reece's funnels. The promise
// phrases are matched against a window around each anchor tag.

const DESTINATION_RULES = [
  {
    type: 'calculator',
    urlPatterns: [/calculator\.reecewindows\.com/i, /reece-calculator/i, /estimate-calculator/i],
    expectedPhrases: ['estimate', 'calculator', 'your numbers', 'pricing', 'rough quote'],
    forbiddenPhrases: [
      'risk profile', 'risk report', 'home risk',
      'book a time', 'book your', 'schedule a', 'schedule your',
      'consultation', 'measurement', 'home protection',
      'review session', 'review call',
    ],
  },
  {
    type: 'booking',
    urlPatterns: [/api\.leadconnectorhq\.com\/widget\/booking/i, /trigger_link\.book/i, /\/book[/?#]/i, /calendar/i, /appointments?\b/i],
    expectedPhrases: [
      'book', 'schedule', 'pick a time', 'find a time', 'calendar',
      'window estimate', 'home protection', 'consultation', 'measurement',
      'review session', 'review call',
    ],
    forbiddenPhrases: [
      'risk profile', 'risk report', 'home risk',
      'your estimate', 'your numbers', 'your calculator',
      'your guide', 'download', 'read more',
    ],
  },
  {
    type: 'hrr',
    urlPatterns: [/risk-report/i, /hrr-results/i, /home-risk/i, /risk-profile/i],
    expectedPhrases: ['risk profile', 'risk report', 'home risk', 'your report', 'your results', 'your numbers'],
    forbiddenPhrases: [
      'book a time', 'schedule', 'consultation',
      'your estimate', 'pricing', 'calculator',
    ],
  },
  {
    type: 'guide',
    urlPatterns: [/hurricane-guide/i, /buyer.?guide/i, /\.pdf$/i, /resources?\//i],
    expectedPhrases: ['guide', 'read', 'download', 'pdf', 'resource'],
    forbiddenPhrases: ['book a time', 'your estimate', 'calculator', 'schedule a call'],
  },
  // No catch-all — unclassified URLs are not checked. Better to
  // ship-and-fix-later than block legitimate copy because a new
  // funnel surface wasn't in the table yet.
];

const ANCHOR_HREF_PATTERN = /<a\s[^>]*href=["']([^"']+)["']/gi;

function classifyUrl(url) {
  if (!url) return null;
  for (const rule of DESTINATION_RULES) {
    for (const rx of rule.urlPatterns) {
      if (rx.test(url)) return rule;
    }
  }
  return null;
}

function checkPromiseAroundAnchor(text, anchorIndex, rule, windowBefore = 200, windowAfter = 250) {
  const start = Math.max(0, anchorIndex - windowBefore);
  const end = Math.min(text.length, anchorIndex + windowAfter);
  // Strip HTML inside the window so we match against natural-language
  // surrounding copy, not nested tags.
  const window = stripHtml(text.slice(start, end)).toLowerCase();
  for (const forbidden of rule.forbiddenPhrases) {
    if (window.includes(forbidden.toLowerCase())) {
      return { mismatch: true, phrase: forbidden };
    }
  }
  return { mismatch: false };
}

function hasDestinationPromiseMismatch(output) {
  const haystack = (output.body_html || '') + '\n' + (output.ps_text || '');
  if (!haystack) return null;
  const rx = new RegExp(ANCHOR_HREF_PATTERN.source, ANCHOR_HREF_PATTERN.flags);
  let match;
  while ((match = rx.exec(haystack)) !== null) {
    const url = match[1];
    const rule = classifyUrl(url);
    if (!rule) continue;
    const result = checkPromiseAroundAnchor(haystack, match.index, rule);
    if (result.mismatch) {
      return { url_type: rule.type, conflicting_phrase: result.phrase };
    }
  }
  return null;
}

// ─── MAIN ────────────────────────────────────────────────────────────

/**
 * Validate the output for safety. Returns { passed, failures, details }
 * where failures is an array of SAFETY_CODES and details is an array
 * of human-readable explanations (one per failure) for logs/audit.
 *
 * @param {object} output   — LLM-generated content (may be invoked
 *                            AFTER autofix has run)
 * @param {object} prompt   — prompt row (for banned_phrases)
 * @param {object} context  — context envelope (for lead phone/address,
 *                            scarcity_real flag)
 */
export function validateSafety(output, prompt, context) {
  const failures = [];
  const details = [];

  // NULL_BODY runs first — if there's no body, other checks are moot.
  const nullReason = hasNullBody(output);
  if (nullReason) {
    failures.push(SAFETY_CODES.NULL_BODY);
    details.push(`NULL_BODY:${nullReason}`);
    return { passed: false, failures, details };
  }

  // Assemble the full text once for the claim checks.
  const fullText = [output.subject, output.preheader, output.body_html, output.sms_body, output.ps_text]
    .filter(Boolean)
    .join(' ');
  const fullTextLower = fullText.toLowerCase();
  const promptBanned = Array.isArray(prompt?.banned_phrases) ? prompt.banned_phrases : [];
  const scarcityReal = context?.scarcity_real === true;

  // BRAND_LINE_VIOLATION
  if (hasBrandLineViolation(fullText)) {
    failures.push(SAFETY_CODES.BRAND_LINE_VIOLATION);
    details.push('BRAND_LINE_VIOLATION:florida_founding_claim');
  }

  // PROHIBITED_CLAIM — three sub-checks, any one fails this code
  let prohibitedReason = null;
  if (hasOutcomeGuarantee(fullText)) prohibitedReason = 'outcome_guarantee';
  else if (hasFakeUrgency(fullTextLower, scarcityReal)) prohibitedReason = 'fake_urgency';
  else if (hasBannedPhrase(fullTextLower, promptBanned)) prohibitedReason = 'banned_phrase';
  if (prohibitedReason) {
    failures.push(SAFETY_CODES.PROHIBITED_CLAIM);
    details.push(`PROHIBITED_CLAIM:${prohibitedReason}`);
  }

  // PERSONAL_DATA_LEAK
  const leakReason = hasPersonalDataLeak(output, context);
  if (leakReason) {
    failures.push(SAFETY_CODES.PERSONAL_DATA_LEAK);
    details.push(`PERSONAL_DATA_LEAK:${leakReason}`);
  }

  // DESTINATION_PROMISE_MISMATCH
  const mismatch = hasDestinationPromiseMismatch(output);
  if (mismatch) {
    failures.push(SAFETY_CODES.DESTINATION_PROMISE_MISMATCH);
    details.push(`DESTINATION_PROMISE_MISMATCH:${mismatch.url_type}:${mismatch.conflicting_phrase}`);
  }

  return {
    passed: failures.length === 0,
    failures,
    details,
  };
}

// Exported for tests.
export const _internal = {
  hasBrandLineViolation,
  hasOutcomeGuarantee,
  hasFakeUrgency,
  hasBannedPhrase,
  hasPersonalDataLeak,
  hasNullBody,
  hasDestinationPromiseMismatch,
  classifyUrl,
  DESTINATION_RULES,
};
