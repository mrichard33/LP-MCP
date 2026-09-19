/**
 * Prospect link election — src/prospect-link-election.js
 *
 * ONE question: when the leads under a single LP prospect disagree about which
 * GHL contact they belong to, which one is right — or is the answer "refuse"?
 *
 * Pure. No I/O, no clock, no imports. scripts/elect-prospect-links.js is the
 * only caller; it is a separate module so the decision that can be silently
 * wrong is unit-testable without two database instances.
 *
 * Distinct from src/lp-link-selection.js, which answers the mirror-image
 * question (one contact matches several leads — which lead gets the link). The
 * two share no code on purpose: a shared helper would invite one rule to drift
 * into the other, and they are wrong in opposite directions.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * One LP prospect is one person, so its leads cannot belong to two different
 * GHL contacts. Measured 2026-09-19, 51 prospects violated that. Inspecting
 * them, the pattern is not two plausible people — it is one good contact and
 * one piece of garbage: soft-deleted records, "Test Test", phoneless guest
 * visitors, and digit-transposition pairs (5184217073 vs 5814217083).
 *
 * ─── THE LADDER ─────────────────────────────────────────────────────────────
 * Applied in order; each rung only breaks ties the rung above left:
 *
 *   1. Drop candidates whose contact is gone — absent from the mirror or
 *      soft-deleted. A link to a deleted record is not a rival claim.
 *   2. Drop candidates the corroborator already refused (rejected_*).
 *   3. KEEP ONLY candidates whose contact phone AGREES with a phone on one of
 *      the prospect's own leads. This is the one rung carrying real evidence.
 *      No candidate agrees ⇒ refuse: there is nothing to elect on.
 *   4. Among those, prefer the higher-trust ghl_link_source, by the same
 *      STRENGTH ladder the corroborator uses.
 *
 * MORE THAN ONE SURVIVOR ⇒ REFUSE. Ambiguity is a refusal, never a coin flip:
 * electing between two live, corroborated contacts would be guessing, and the
 * cost of guessing wrong is one customer's history stapled to another's. That
 * is the lesson already encoded in src/lp-link-match.js and it holds here.
 *
 * ─── WHY THERE IS NO "MOST LEADS WINS" RUNG ─────────────────────────────────
 * There was one, and the dry run against live data is why it is gone. It
 * decided 10 of 46 prospects, and inspecting all 10 every answer was unsafe:
 *
 *   6 prospects  — each candidate agreed with a DIFFERENT phone on the
 *     prospect (4079534440 vs 4079226099; 2397457406 vs 2394766125). Two
 *     contacts each corroborated by a real phone is the signature of two real
 *     people, not of one person with a duplicate. Majority would have merged
 *     them.
 *   4 prospects  — NO candidate agreed with any phone on the prospect
 *     (LP 7272421300 against contacts 3525873286 and 8029529651). Majority
 *     there is a coin flip dressed as a rule.
 *
 * Counting rows is not evidence about which person a record belongs to. A
 * prospect that reaches this point goes to a human instead.
 *
 * Note rung 3 tests phone agreement, never name. "Guest Visitor 412" is not
 * unique, and neither is a surname — link-corroboration.js:124 makes the same
 * call for the same reason.
 */

// Same ranking the corroborator uses. Anything unlisted is 1: a repair-written
// or unclassified source is displaceable by real corroboration, which is the
// correct direction.
const STRENGTH = {
  phone_email_match: 3,
  lognumber_corroborated: 3,
  lognumber_verified: 2,
};

const REJECTED = new Set(['rejected_conflict', 'rejected_uncorroborated']);

function strength(source) {
  return (source && STRENGTH[source]) || 1;
}

/** Last 10 digits, the only phone comparison this codebase trusts. */
function phone10(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

/**
 * Elect the canonical contact for one prospect.
 *
 * @param {object} input
 * @param {Array<{lp_lead_id: string, ghl_contact_id: string, ghl_link_source: string|null, phone: string|null}>} input.leads
 *   Every LINKED lead under the prospect. Unlinked leads are irrelevant here —
 *   propagation handles those and has nothing to elect between.
 * @param {Map<string, {deleted_at: string|null, phone: string|null}>} input.contacts
 *   The GHL mirror rows for the candidate ids. A missing entry means the
 *   contact is absent from the mirror, which rung 1 treats as gone.
 *
 * @returns {{verdict: 'elected'|'ambiguous'|'no_candidates', contactId: string|null,
 *            reason: string, survivors: string[], dropped: object[]}}
 */
export function electProspectLink({ leads = [], contacts = new Map() } = {}) {
  const dropped = [];
  const linked = leads.filter((l) => l.ghl_contact_id);

  if (!linked.length) {
    return { verdict: 'no_candidates', contactId: null, reason: 'no_linked_leads', survivors: [], dropped };
  }

  // Every phone this prospect is known by, from its own leads. Rung 3 compares
  // against the whole set: a prospect legitimately carries a mobile on one lead
  // and a landline on another, and agreeing with either is agreement.
  const prospectPhones = new Set(linked.map((l) => phone10(l.phone)).filter(Boolean));

  // Collapse to one entry per candidate id, carrying every source it is held
  // under and how many leads hold it.
  //
  // Keeping the whole list matters: a rejected source ranks 1, the same as an
  // unclassified one, so picking the "best" by strength alone would silently
  // discard the fact that a candidate was refused at all.
  const byId = new Map();
  for (const l of linked) {
    const cur = byId.get(l.ghl_contact_id) || { contactId: l.ghl_contact_id, held: 0, sources: [] };
    cur.held++;
    cur.sources.push(l.ghl_link_source || null);
    byId.set(l.ghl_contact_id, cur);
  }
  for (const c of byId.values()) {
    const usable = c.sources.filter((s) => !REJECTED.has(s));
    // Refused only when EVERY lead holding this id was refused. One lead
    // holding it under a good source is still a live claim, and dropping it on
    // a sibling's rejection would throw away the better evidence.
    c.allRejected = usable.length === 0;
    c.source = usable.reduce((best, s) => (strength(s) > strength(best) ? s : best), null);
  }

  let survivors = [...byId.values()];
  if (survivors.length === 1) {
    return {
      verdict: 'elected', contactId: survivors[0].contactId,
      reason: 'unanimous', survivors: [survivors[0].contactId], dropped,
    };
  }

  const drop = (list, reason, keep) => {
    const kept = [];
    for (const c of list) {
      if (keep(c)) kept.push(c);
      else dropped.push({ contactId: c.contactId, reason });
    }
    // A rung that would drop EVERYTHING has not discriminated — it has just
    // told us all the candidates share a flaw. Leave the set alone and let a
    // lower rung speak, rather than reporting no_candidates on a prospect that
    // plainly has some.
    if (!kept.length) {
      while (dropped.length && dropped[dropped.length - 1].reason === reason) dropped.pop();
      return list;
    }
    return kept;
  };

  // Rung 1 — the contact is gone.
  survivors = drop(survivors, 'contact_deleted_or_absent', (c) => {
    const row = contacts.get(c.contactId);
    return row && !row.deleted_at;
  });

  // Rung 2 — the corroborator already refused this one, on every lead holding it.
  survivors = drop(survivors, 'source_rejected', (c) => !c.allRejected);

  // Rung 3 — the contact's phone agrees with one of the prospect's own.
  //
  // Unlike the rungs above this one does NOT fall through when it would empty
  // the set. "No candidate's phone matches this person" is not a tie to break
  // further down; it means there is no evidence here at all, and the honest
  // answer is to refuse.
  if (survivors.length > 1) {
    const agreeing = survivors.filter((c) => {
      const p = phone10(contacts.get(c.contactId)?.phone);
      return p && prospectPhones.has(p);
    });
    if (!agreeing.length) {
      return {
        verdict: 'ambiguous', contactId: null, reason: 'no_phone_evidence',
        survivors: survivors.map((c) => c.contactId), dropped,
      };
    }
    for (const c of survivors) {
      if (!agreeing.includes(c)) dropped.push({ contactId: c.contactId, reason: 'phone_disagrees' });
    }
    survivors = agreeing;
  }

  // Rung 4 — trust ranking of the source it is held under.
  if (survivors.length > 1) {
    const best = Math.max(...survivors.map((c) => strength(c.source)));
    survivors = drop(survivors, 'weaker_source', (c) => strength(c.source) === best);
  }

  if (survivors.length === 1) {
    return {
      verdict: 'elected', contactId: survivors[0].contactId,
      reason: 'ladder', survivors: [survivors[0].contactId], dropped,
    };
  }

  return {
    verdict: 'ambiguous', contactId: null,
    reason: `${survivors.length}_survivors`,
    survivors: survivors.map((c) => c.contactId), dropped,
  };
}

export const _internal = { phone10, strength, STRENGTH, REJECTED };
