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
 *   the S4.5 storyline rotation calendar (§7): BRAND_LINE_VIOLATION,
 *   OUTCOME_GUARANTEE.
 *
 * v1.2 — 2026-05-12. P.S. field migration. MISSING_BOOKING_LINK checks
 *   ps_text too; SKIPPED for stage 1; new BODY_CONTAINS_SIGNATURE.
 *
 * v1.3 — 2026-05-12. Dynamic-UTM migration. New BARE_URL and
 *   WEAK_CTA_TEXT blockers for the friendly-CTA contract.
 *
 * v1.4 — 2026-05-12. MISSING_BOOKING_LINK tier-aware. Previous v1.2
 *   check skipped only when buyer_stage_target === 1 — but in practice
 *   ALL S4.5 prompts have buyer_stage_target = null in the DB, so the
 *   check fired on every generation and killed messages whose model
 *   chose to omit the P.S. (which the prompts explicitly allow for
 *   stage 2 when "the body lands cleanly"). Realigned to mirror the
 *   Antifragile CTA rules from the prompts themselves:
 *     Stage 1 (Indifferent):  NEVER allowed     → skip check
 *     Stage 2 (Curious):       OPTIONAL          → skip check
 *     Stage 3+ (Comparing/...): REQUIRED         → fire check
 *     null buyer_stage_target: defensive skip    → skip check
 *   Net rule: fire the check only when buyer_stage_target is numerically
 *   3 or greater.
 *
 * v1.5 — 2026-05-12. CTA-type-aware MISSING_BOOKING_LINK. The locked
 *   CTA rotation introduces no-URL CTA types (reply_prompt,
 *   reflection_close, self_id_cue, no_cta) where omitting the link is
 *   correct behavior, plus URL-bearing types (soft_booking_offer,
 *   resource_offer, direct_assessment_ask) where the link is required
 *   regardless of buyer_stage_target. Decision tree:
 *     cta_type ∈ NO_URL_CTAS   → SKIP  (intentional omission)
 *     cta_type ∈ URL_CTAS       → FIRE  (URL required)
 *     cta_type missing/legacy   → v1.4 stage-based fallback
 *   has_ps is informational — even URL CTAs can place the URL in the
 *   body (direct_assessment_ask), so has_ps alone doesn't tell us
 *   whether a link should exist. cta_type does.
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
  BRAND_LINE_VIOLATION:    'BRAND_LINE_VIOLATION',
  OUTCOME_GUARANTEE:       'OUTCOME_GUARANTEE',
  BODY_CONTAINS_SIGNATURE: 'BODY_CONTAINS_SIGNATURE',
  BARE_URL:                'BARE_URL',
  WEAK_CTA_TEXT:           'WEAK_CTA_TEXT',
});

// v1.5: CTA type classification for MISSING_BOOKING_LINK decision.
// Must stay aligned with the CTA TYPE PLAYBOOK in S4.5 system prompts.
const NO_URL_CTAS = ['reply_prompt', 'reflection_close', 'self_id_cue', 'no_cta'];
const URL_CTAS    = ['soft_booking_offer', 'resource_offer', 'direct_assessment_ask'];

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

// v1.1: OUTCOME_GUARANTEE detection.
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

// v1.2: BODY_CONTAINS_SIGNATURE detection.
const BODY_SIGNATURE_PATTERNS = [
  /—\s*\{\{\s*custom_values\.rep_name\s*\}\}/i,
  /—\s*(Mark|Randy|Mark Richard|Randy Reece)(\s|<|$|,|\.)/i,
  /Reece\s+Windows\s+(&|&amp;|and)\s+Doors/i,
  /<p[^>]*>\s*(Best|Talk soon|Sincerely|Cheers|Warmly|Regards|All the best),?\s*(<br\s*\/?>|<\/p>|$)/i,
  /—\s*(the\s+)?Reece(\s+team)?(\s|<|$|,|\.)/i,
];

function hasBodySignature(bodyHtml) {
  if (!bodyHtml) return false;
  for (const rx of BODY_SIGNATURE_PATTERNS) {
    if (rx.test(bodyHtml)) return true;
  }
  return false;
}

// v1.3: BARE_URL detection.
const BARE_URL_TEST = /https?:\/\//i;
const ANCHOR_BLOCK = /<a\s[^>]*href=["'][^"']*["'][^>]*>[\s\S]*?<\/a>/gi;

function hasBareUrl(text) {
  if (!text) return false;
  const stripped = String(text).replace(ANCHOR_BLOCK, '');
  return BARE_URL_TEST.test(stripped);
}

// v1.3: WEAK_CTA_TEXT detection.
const WEAK_CTA_PHRASES = [
  'click here',
  'click',
  'here',
  'this link',
  'read more',
  'learn more',
  'tap here',
  'go here',
];

const ANCHOR_WITH_TEXT = /<a\s[^>]*href=["'][^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;

function hasWeakCtaText(text) {
  if (!text) return false;
  let match;
  const rx = new RegExp(ANCHOR_WITH_TEXT.source, ANCHOR_WITH_TEXT.flags);
  while ((match = rx.exec(text)) !== null) {
    const inner = match[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/[.!?,;:]+$/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (!inner) continue;
    for (const phrase of WEAK_CTA_PHRASES) {
      if (inner === phrase) return true;
      if (inner.startsWith(phrase + ' ')) return true;
    }
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

  // 8. Booking link — accepts http(s) URL or {{trigger_link.*}} merge tag
  //    in EITHER body_html OR ps_text.
  //
  //    CTA-type-aware + tier-aware (v1.5). Decision tree:
  //      cta_type ∈ NO_URL_CTAS  → skip (intentional omission)
  //      cta_type ∈ URL_CTAS      → fire (URL required)
  //      cta_type missing/legacy  → fall back to v1.4 stage-based logic
  //                                   (fire only when buyer_stage_target >= 3)
  const ctaType = prompt?.cta_type;
  let requireBookingLink;
  if (ctaType && NO_URL_CTAS.includes(ctaType)) {
    requireBookingLink = false;
  } else if (ctaType && URL_CTAS.includes(ctaType)) {
    requireBookingLink = true;
  } else {
    const stage = prompt?.buyer_stage_target;
    requireBookingLink = typeof stage === 'number' && stage >= 3;
  }

  if (requireBookingLink) {
    const bodyText = output.body_html || '';
    const psText = output.ps_text || '';
    const combined = bodyText + ' ' + psText;
    const hasUrl = /https?:\/\//i.test(combined);
    const hasMergeTag = /\{\{\s*trigger_link\./i.test(combined);
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
  // 12. Brand-line violation
  const fullTextPreserveCase = [output.subject, output.preheader, output.body_html, output.sms_body]
    .filter(Boolean)
    .join(' ');
  if (hasBrandLineViolation(fullTextPreserveCase)) {
    failures.push(HARD_BLOCKER_CODES.BRAND_LINE_VIOLATION);
  }

  // 13. Outcome guarantee
  if (hasOutcomeGuarantee(fullTextPreserveCase)) {
    failures.push(HARD_BLOCKER_CODES.OUTCOME_GUARANTEE);
  }

  // v1.2
  // 14. Body contains signature
  if (hasBodySignature(output.body_html)) {
    failures.push(HARD_BLOCKER_CODES.BODY_CONTAINS_SIGNATURE);
  }

  // v1.3
  // 15. Bare URL
  const linkScanText = (output.body_html || '') + ' ' + (output.ps_text || '');
  if (hasBareUrl(linkScanText)) {
    failures.push(HARD_BLOCKER_CODES.BARE_URL);
  }

  // 16. Weak CTA text
  if (hasWeakCtaText(linkScanText)) {
    failures.push(HARD_BLOCKER_CODES.WEAK_CTA_TEXT);
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}
