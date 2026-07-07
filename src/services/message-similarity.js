/**
 * Message Similarity — src/services/message-similarity.js
 *
 * Conversation Quality Pass v1.0, Item 1b (2026-07-07). Near-duplicate
 * detection for outbound sends. Evidence: the escalation line "I think it'd
 * help to chat with one of our specialists…" delivered verbatim 3× to the
 * same lead, and the slot question "3:30 PM or 4:00 PM?" re-sent identically
 * after the lead had already answered. Exact-hash dedup (send-dedup.js)
 * can't catch these — the repeats came from DIFFERENT jobs with different
 * trigger ids, sometimes with a name token or punctuation differing.
 *
 * normalizeForComparison: lowercase, strip the contact's first-name token,
 * strip punctuation, collapse whitespace — so "Thanks, Mark — 4 PM works!"
 * and "thanks 4 pm works" compare on substance.
 *
 * similarityRatio: normalized Levenshtein ratio (1 = identical). SMS bodies
 * are ≤320 chars, so the O(n·m) DP is trivially cheap at send time.
 *
 * Pure functions — unit-testable without a DB.
 */

export function normalizeForComparison(text, { firstName = null } = {}) {
  if (!text || typeof text !== 'string') return '';
  let out = text.toLowerCase();
  if (firstName && typeof firstName === 'string' && firstName.trim().length > 1) {
    const nameRx = new RegExp(`\\b${firstName.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    out = out.replace(nameRx, ' ');
  }
  return out
    .replace(/\{\{[^}]*\}\}/g, ' ')      // merge tags compare as blanks
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function similarityRatio(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const la = a.length;
  const lb = b.length;
  // Cheap length screen: if lengths differ by more than the block threshold
  // allows, they cannot be ≥0.9 similar.
  if (Math.min(la, lb) / Math.max(la, lb) < 0.5) return 0;

  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  const distance = prev[lb];
  return 1 - distance / Math.max(la, lb);
}

/**
 * @param {string} candidate            the message about to be sent
 * @param {string[]} recentOutbound     bodies of outbound messages to compare against
 * @param {object} [opts]
 * @param {number} [opts.threshold=0.9] similarity at/above which it's a duplicate
 * @param {string} [opts.firstName]     contact first name to strip before comparing
 * @returns {{duplicate: boolean, matched?: string, ratio?: number}}
 */
export function findNearDuplicate(candidate, recentOutbound, { threshold = 0.9, firstName = null } = {}) {
  const normCandidate = normalizeForComparison(candidate, { firstName });
  if (!normCandidate) return { duplicate: false };
  for (const prior of recentOutbound || []) {
    const normPrior = normalizeForComparison(prior, { firstName });
    if (!normPrior) continue;
    const ratio = similarityRatio(normCandidate, normPrior);
    if (ratio >= threshold) {
      return { duplicate: true, matched: prior, ratio };
    }
  }
  return { duplicate: false };
}

export default { normalizeForComparison, similarityRatio, findNearDuplicate };
