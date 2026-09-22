/**
 * Tag hygiene rules — src/tag-hygiene/rules.js
 *
 * 2026-09-22 — pure rule evaluation for the daily sweep
 * (src/jobs/tag-hygiene-sweep.js). No I/O: the caller live-reads the contact
 * and, only when a rule needs them, the LP job verdict and the open P3
 * opportunities, then hands them in. Same split as the *-alerts.js modules:
 * the decision is pure, the job owns the reads, the writes and the log.
 *
 * v1 POLICY — only deterministic fixes remove anything. Anything that needs a
 * judgement (which of two stage tags is newer, whether a loss tag is itself
 * wrong) comes back `needs_review` and is never written.
 *
 * PROTECTED TAGS are filtered out of every removal list as the LAST step,
 * whatever rule matched. A rule that one day widens its match cannot remove a
 * DNC / suppression flag through this path.
 *
 * Tag vocabulary was checked against the HL cache on 2026-09-22, not taken from
 * the handoff alone: the live P3 tags are p3:deferred-timing (not p3:deferred),
 * p3:not-interested-now and p3:not-interested, and loss-reason:no-engagement /
 * loss-reason:timing / loss-reason:invalid exist. R5's stage sets carry both the
 * handoff names and the live names so either spelling resolves.
 */

import { STAGE_MAP } from '../actions/constants.js';

export const PROTECTED_TAGS = Object.freeze([
  'dnc', 'dnc-sms', 'do-not-contact', 'stage:dnc',
  'unsubscribed', 'stop-bot', 'suppress-outbound', 'hard-disqualified',
]);
const PROTECTED = new Set(PROTECTED_TAGS);

export const CUSTOMER_TAGS = Object.freeze([
  'deal-won', 'stage:customer-onboarding', 'buyer:post-decision', 'bj:stage-5-committed',
]);

/**
 * R5 — which p3:* / loss-reason:* tags belong with each P3 stage. Keyed by the
 * stage id from STAGE_MAP so a renamed stage cannot silently drop out.
 * Reactivation Queue (stage 2) is deliberately absent: nothing in the handoff
 * says which tags it keeps, so a contact there comes back needs_review.
 */
export const P3_STAGE_TAGS = Object.freeze({
  [STAGE_MAP['Deferred (Timing)']]: {
    stage: 'Deferred',
    p3: ['p3:deferred', 'p3:deferred-timing', 'p3:financing-denied'],
    lossReason: ['loss-reason:deferred', 'loss-reason:timing', 'loss-reason:financing-denied'],
  },
  [STAGE_MAP['Not Interested (Cooling)']]: {
    stage: 'Cooling',
    p3: ['p3:not-interested', 'p3:not-interested-now', 'p3:ghosted', 'p3:price'],
    lossReason: ['loss-reason:not-interested', 'loss-reason:ghosted', 'loss-reason:no-engagement', 'loss-reason:price'],
  },
  [STAGE_MAP['Bad Fit / Wrong Home']]: {
    stage: 'Bad Fit',
    p3: ['p3:bad-fit-preference'],
    lossReason: ['loss-reason:bad-fit'],
  },
  [STAGE_MAP['Hard Disqualified']]: {
    stage: 'Hard DQ',
    p3: ['p3:hard-disqualified', 'p3:out-of-area'],
    lossReason: ['loss-reason:cannot-qualify', 'loss-reason:out-of-area', 'loss-reason:invalid'],
  },
  [STAGE_MAP['Do Not Contact']]: {
    stage: 'DNC',
    p3: ['p3:dnc', 'p3:collections'],
    lossReason: ['loss-reason:dnc', 'loss-reason:collections'],
  },
});

const KNOWN_P3 = new Set(Object.values(P3_STAGE_TAGS).flatMap((s) => s.p3));
const KNOWN_LOSS = new Set(Object.values(P3_STAGE_TAGS).flatMap((s) => s.lossReason));

export const RULE_IDS = Object.freeze(['R1', 'R2', 'R3', 'R4', 'R4b', 'R5', 'R6']);

const norm = (t) => (typeof t === 'string' ? t.trim().toLowerCase() : '');

function withPrefix(tags, prefix) {
  return tags.filter((t) => norm(t).startsWith(prefix));
}

function present(tags, wanted) {
  const want = new Set(wanted);
  return tags.filter((t) => want.has(norm(t)));
}

/** Tags that are candidates for any rule's loss-tag condition. */
function lossTags(tags) {
  return tags.filter((t) => { const n = norm(t); return n.startsWith('p3:') || n.startsWith('loss-reason:'); });
}

/** Does this contact need the LP job verdict? (R4 only.) Pure. */
export function needsLpVerdict(tags) {
  const list = (tags || []).filter((t) => typeof t === 'string');
  return lossTags(list).length > 0 && present(list, CUSTOMER_TAGS).length > 0;
}

/** Does this contact need its open P3 opportunities? (R5 only.) Pure. */
export function needsOpenP3(tags) {
  const list = (tags || []).filter((t) => typeof t === 'string');
  return withPrefix(list, 'p3:').length > 1 || withPrefix(list, 'loss-reason:').length > 1;
}

/**
 * R5 for one family (p3 or loss-reason). Returns the tags to remove, or a
 * needs_review reason. Only called when the family has more than one tag.
 */
function resolveFamily(familyTags, allowed, known, label) {
  const keep = familyTags.filter((t) => allowed.includes(norm(t)));
  if (keep.length !== 1) return { review: `${label}_matches_${keep.length}_for_stage` };
  const extras = familyTags.filter((t) => t !== keep[0]);
  const unknown = extras.filter((t) => !known.has(norm(t)));
  if (unknown.length) return { review: `${label}_unrecognized_tag` };
  // A DNC-flavoured placement is never removed automatically, even when the
  // open opportunity says otherwise: the opportunity may be the stale half.
  if (extras.some((t) => norm(t).includes('dnc'))) return { review: `${label}_would_remove_dnc` };
  return { keep: keep[0], remove: extras };
}

/**
 * Evaluate R1–R6 against a contact's LIVE tags.
 *
 * @param {object} input
 * @param {string[]} input.tags            live tags
 * @param {{verdict?: string, error?: string}|null} [input.lp]
 *        LP job verdict from decidingJob(). null / { error } = could not read.
 *        Only consulted when needsLpVerdict(tags).
 * @param {Array<{id: string, pipelineStageId: string}>|null} [input.openP3Opps]
 *        open P3 opportunities, or null = could not read. Only consulted when needsOpenP3(tags).
 * @returns {Array<{ rule: string, action: 'remove'|'needs_review'|'skipped', tags: string[], reason?: string }>}
 */
export function evaluateTagRules({ tags, lp = null, openP3Opps = null } = {}) {
  const list = (tags || []).filter((t) => typeof t === 'string' && t.trim());
  const has = (tag) => list.some((t) => norm(t) === tag);
  const decisions = [];

  // R1 — dq-needs-type is deprecated (its field was removed); it only ever
  // meant "waiting for a DQ type that can no longer be set".
  if (has('dq-needs-type')) {
    decisions.push({ rule: 'R1', action: 'remove', tags: present(list, ['dq-needs-type']) });
  }

  // R2 — a loss reason is present, so "needs a reason" is stale.
  if (withPrefix(list, 'loss-reason:').length > 0 && has('loss-needs-reason')) {
    decisions.push({ rule: 'R2', action: 'remove', tags: present(list, ['loss-needs-reason']) });
  }

  // R3 — hard-disqualified contacts are not deferred.
  if (has('hard-disqualified') && has('lp-route:deferred-standard')) {
    decisions.push({ rule: 'R3', action: 'remove', tags: present(list, ['lp-route:deferred-standard']) });
  }

  // R4 / R4b — a lost contact still wearing customer tags. Only a terminal-dead
  // LP job makes the loss tag trustworthy enough to strip the customer tags;
  // otherwise the LOSS tag may be the wrong one, so a human looks.
  if (needsLpVerdict(list)) {
    const customer = present(list, CUSTOMER_TAGS);
    if (!lp || lp.error || !lp.verdict) {
      decisions.push({ rule: 'R4', action: 'skipped', tags: customer, reason: 'lp_read_failed' });
    } else if (lp.verdict === 'terminal_lost') {
      decisions.push({ rule: 'R4', action: 'remove', tags: customer });
    } else {
      decisions.push({ rule: 'R4b', action: 'needs_review', tags: customer, reason: `lp_verdict_${lp.verdict}` });
    }
  }

  // R5 — more than one p3:* or loss-reason:*. Resolvable only against exactly
  // one open P3 opportunity whose stage names the pair to keep.
  if (needsOpenP3(list)) {
    const p3 = withPrefix(list, 'p3:');
    const loss = withPrefix(list, 'loss-reason:');
    const dupes = [...(p3.length > 1 ? p3 : []), ...(loss.length > 1 ? loss : [])];
    if (!Array.isArray(openP3Opps)) {
      decisions.push({ rule: 'R5', action: 'skipped', tags: dupes, reason: 'p3_read_failed' });
    } else if (openP3Opps.length !== 1) {
      decisions.push({ rule: 'R5', action: 'needs_review', tags: dupes, reason: `open_p3_count_${openP3Opps.length}` });
    } else {
      const stage = P3_STAGE_TAGS[openP3Opps[0]?.pipelineStageId];
      if (!stage) {
        decisions.push({ rule: 'R5', action: 'needs_review', tags: dupes, reason: 'p3_stage_unmapped' });
      } else {
        const parts = [];
        if (p3.length > 1) parts.push(resolveFamily(p3, stage.p3, KNOWN_P3, 'p3'));
        if (loss.length > 1) parts.push(resolveFamily(loss, stage.lossReason, KNOWN_LOSS, 'loss_reason'));
        const review = parts.find((p) => p.review);
        if (review) {
          decisions.push({ rule: 'R5', action: 'needs_review', tags: dupes, reason: review.review });
        } else {
          decisions.push({ rule: 'R5', action: 'remove', tags: parts.flatMap((p) => p.remove), reason: `stage_${stage.stage}` });
        }
      }
    }
  }

  // R6 — conflicting journey markers. v1 has no timestamps to tell which is
  // newest, so this is report-only.
  for (const prefix of ['stage:', 'active-entry:', 'buyer:']) {
    const fam = withPrefix(list, prefix);
    if (fam.length > 1) {
      decisions.push({ rule: 'R6', action: 'needs_review', tags: fam, reason: `multiple_${prefix.slice(0, -1)}` });
    }
  }

  // Protected tags are never removed — final filter, applied to every rule.
  return decisions.map((d) => {
    if (d.action !== 'remove') return d;
    const safe = d.tags.filter((t) => !PROTECTED.has(norm(t)));
    if (safe.length === 0) return { ...d, action: 'skipped', tags: [], reason: 'only_protected_tags' };
    return safe.length === d.tags.length ? d : { ...d, tags: safe, reason: 'protected_tags_kept' };
  });
}

/** Union of every tag the decisions would remove, de-duplicated. Pure. */
export function tagsToRemove(decisions) {
  return [...new Set((decisions || []).filter((d) => d.action === 'remove').flatMap((d) => d.tags))];
}

/** Aggregate decision counts across a run. Pure. */
export function summarizeDecisions(decisions) {
  const counts = { fixed: 0, needs_review: 0, skipped: 0, by_rule: {} };
  for (const d of decisions || []) {
    if (d.action === 'remove') counts.fixed += 1;
    else if (d.action === 'needs_review') counts.needs_review += 1;
    else counts.skipped += 1;
    if (d.action !== 'skipped') counts.by_rule[d.rule] = (counts.by_rule[d.rule] || 0) + 1;
  }
  return counts;
}

/** Silent when nothing needs Mark: post only when something was fixed or needs review. */
export function shouldPostSummary(counts) {
  return (counts?.fixed || 0) > 0 || (counts?.needs_review || 0) > 0;
}

/** The one Slack line. Counts only — never a name, phone, email or contact id. */
export function formatSweepSummary(counts, mode) {
  const top = Object.entries(counts?.by_rule || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([rule, n]) => `${rule} ${n}`)
    .join(', ');
  return `🧹 Tag sweep (${mode}): ${counts?.fixed || 0} fixed · ${counts?.needs_review || 0} need review`
    + (top ? ` · top rules: ${top}` : '');
}
