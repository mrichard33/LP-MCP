/**
 * Nurture Autofix — src/nurture/nurture-autofix.js
 *
 * Formatting normalization that runs BEFORE safety validation. The old
 * Pass A treated formatting trivia (subject too long, preheader too
 * long, body contains signature) as suppression-worthy hard blockers.
 * Per the 2026-05-12 refactor (Mark): formatting issues are not safety
 * issues — they're presentation issues. Auto-fix, then ship.
 *
 * Returns a new output object (never mutates input) with fixes applied,
 * plus an array of `applied` codes for audit logging.
 *
 * AUTO-FIXES:
 *
 *   SUBJECT_TOO_LONG  → truncate at last word boundary before 60 chars,
 *                       fallback to char 57 + "…"
 *   PREHEADER_TOO_LONG → truncate at word boundary before 90, fallback
 *                       to char 87 + "…"
 *   SMS_TOO_LONG      → truncate at word boundary before 160, fallback
 *                       to char 157 + "…"
 *   BODY_HAS_SIGNATURE → strip detected sign-off lines (GHL template
 *                       already adds Mark/Randy/Reece signature; a
 *                       second one in the body creates the double-sig
 *                       artifact). Patterns lifted from the old
 *                       BODY_CONTAINS_SIGNATURE detector.
 *
 * Subject and preheader are user-visible in the inbox, so smart-truncate
 * (word boundary) is important. SMS truncate is more permissive — text
 * messages tolerate cutoff better than email subjects.
 *
 * Anything not listed here passes through unchanged.
 *
 * v1.0 — 2026-05-12. Initial. Companion to nurture-safety-validator.js
 *   refactor. Replaces the suppression paths for these codes.
 */

const SUBJECT_MAX = 60;
const PREHEADER_MAX = 90;
const SMS_MAX = 160;

// Signature patterns lifted from the old hard-blockers BODY_CONTAINS_SIGNATURE
// detector. The GHL email template renders a signature block after the
// body; if the body ALSO contains a sign-off, the recipient sees two.
// We strip the in-body signature, keeping the template's authoritative one.
const SIGNATURE_PATTERNS = [
  /—\s*\{\{\s*custom_values\.rep_name\s*\}\}\s*(?:<br\s*\/?>|<\/p>|$)/gi,
  /—\s*(Mark|Randy|Mark Richard|Randy Reece)(\s+(from\s+)?Reece(\s+Windows\s+(&|&amp;|and)\s+Doors)?)?\s*(?:<br\s*\/?>|<\/p>|<\/?p[^>]*>|$|,|\.)/g,
  /<p[^>]*>\s*(Best|Talk soon|Sincerely|Cheers|Warmly|Regards|All the best),?\s*<br\s*\/?>\s*(Mark|Randy|the Reece team)[^<]*<\/p>/gi,
  /<p[^>]*>\s*(Best|Talk soon|Sincerely|Cheers|Warmly|Regards|All the best),?\s*(<br\s*\/?>|<\/p>)/gi,
  /—\s*(the\s+)?Reece(\s+team)?\s*(?:<br\s*\/?>|<\/p>|$|,|\.)/gi,
];

/**
 * Truncate a string to maxLen, preferring word boundaries. Returns the
 * original if already within limit. Appends "…" only when truncation
 * actually happens.
 */
function smartTruncate(s, maxLen) {
  const str = String(s ?? '');
  if (str.length <= maxLen) return str;
  // Try to break at a space/punctuation boundary in the last 20% of the budget
  const lookback = Math.floor(maxLen * 0.2);
  const slice = str.slice(0, maxLen);
  const boundaryRx = /[\s,;:!?—–-](?=[^\s,;:!?—–-]*$)/;
  const match = slice.slice(-lookback).match(boundaryRx);
  if (match) {
    const cutAt = (maxLen - lookback) + match.index;
    return str.slice(0, cutAt).trimEnd() + '…';
  }
  // No good boundary — hard cut leaving room for the ellipsis
  return str.slice(0, maxLen - 1).trimEnd() + '…';
}

function stripSignaturesFromBody(html) {
  if (!html || typeof html !== 'string') return { html, stripped: false };
  let result = html;
  let stripped = false;
  for (const rx of SIGNATURE_PATTERNS) {
    const before = result;
    result = result.replace(rx, (match) => {
      // Preserve a trailing </p> or <br> so structure isn't broken
      if (/<\/p>\s*$/.test(match)) return '</p>';
      if (/<br\s*\/?>\s*$/.test(match)) return '';
      return '';
    });
    if (result !== before) stripped = true;
  }
  // Clean up empty paragraphs left by stripping
  result = result.replace(/<p[^>]*>\s*<\/p>/gi, '');
  return { html: result, stripped };
}

/**
 * Apply autofixes to an output object. Returns a new object; original
 * is never mutated. The `applied` array lists which fixes ran, for
 * audit/observability.
 *
 * @param {object} output — { subject, preheader, body_html, ps_text, sms_body, ... }
 * @returns {{ output: object, applied: string[] }}
 */
export function applyAutofix(output) {
  if (!output || typeof output !== 'object') {
    return { output, applied: [] };
  }

  const applied = [];
  const fixed = { ...output };

  // SUBJECT
  if (typeof fixed.subject === 'string' && fixed.subject.length > SUBJECT_MAX) {
    fixed.subject = smartTruncate(fixed.subject, SUBJECT_MAX);
    applied.push('SUBJECT_TRUNCATED');
  }

  // PREHEADER
  if (typeof fixed.preheader === 'string' && fixed.preheader.length > PREHEADER_MAX) {
    fixed.preheader = smartTruncate(fixed.preheader, PREHEADER_MAX);
    applied.push('PREHEADER_TRUNCATED');
  }

  // SMS
  if (typeof fixed.sms_body === 'string' && fixed.sms_body.length > SMS_MAX) {
    fixed.sms_body = smartTruncate(fixed.sms_body, SMS_MAX);
    applied.push('SMS_TRUNCATED');
  }

  // BODY signature strip
  if (typeof fixed.body_html === 'string' && fixed.body_html.length > 0) {
    const { html, stripped } = stripSignaturesFromBody(fixed.body_html);
    if (stripped) {
      fixed.body_html = html;
      applied.push('BODY_SIGNATURE_STRIPPED');
    }
  }

  return { output: fixed, applied };
}

// Exported for tests.
export const _internal = {
  smartTruncate,
  stripSignaturesFromBody,
  SUBJECT_MAX,
  PREHEADER_MAX,
  SMS_MAX,
};
