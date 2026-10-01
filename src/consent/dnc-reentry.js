/**
 * DNC re-entry: a new lead for a blocked number — src/consent/dnc-reentry.js
 *
 * Pure and dependency-free. src/jobs/dnc-reentry-sweep.js owns the reads and
 * the writes; this file owns which leads get a card in #dnc-lift-approval.
 *
 * WHY (2026-10-01)
 *   No lead reached the approval card on its own in the three days after it
 *   shipped. Two holes:
 *     1. The only automatic doors were ActiveProspect's link branch and E.0's
 *        first-party `reentry` event. A lead from Lead Gurus, MVP Marketing,
 *        Modernize, canvass … that LP received directly never knocked.
 *     2. Every door asked "is this contact blocked?" of our own records — GHL
 *        tags and contact_consent. Those only know blocks made since the
 *        consent model went in (2026-09-28). In one week 73 returning leads had
 *        a number on Five9's DNC list and 68 of them had no DNC tag and no
 *        consent row, so all six ActiveProspect calls came back "not_blocked".
 *   So the sweep starts from the lead (every new LP lead, whatever the vendor)
 *   and asks Five9 as well as our records.
 *
 * NEVER ASK TO LIFT A FRESH OPT-OUT
 *   A new lead who says "stop" on the first call goes onto Five9's DNC list
 *   through the agent's Do Not Call disposition, which writes nothing to our
 *   consent tables. 12 of the 73 above were exactly that. A card asking to lift
 *   someone who opted out an hour ago is the worst thing this could do, so a
 *   lead is skipped when:
 *     - its own LP disposition is DNC,
 *     - a consent opt-out was recorded after it arrived, or
 *     - Five9 logged a Do Not Call / DNC disposition on the number after it
 *       arrived,
 *   and each lead is decided ONCE (a mark per lp_lead_id), so a STOP that
 *   comes later can never turn an already-checked lead into a card.
 *
 * It only ASKS. The card's Approve button is the only thing that lifts.
 */

export const MARK_PREFIX = 'dnc-reentry:';
export const LOOKBACK_HOURS = 48;
// A pass that finds more than this asks for the first N and leaves the rest
// unmarked for the next pass, so a backlog trickles in rather than flooding
// the channel with one burst.
export const MAX_ASKS_PER_PASS = 10;
export const RULE_KEY = 'DNC_REENTRY_SWEEP';

export const BLOCKED_TAGS = Object.freeze([
  'dnc', 'dnc-sms', 'dnc-voice', 'stage:dnc', 'p3:dnc', 'lp-dnc', 'do-not-contact',
  'loss-reason:dnc', 'suppress:dnc-reply', 'suppress:dnc-voice',
]);
// Five9 disposition names that put a number on the DNC list (measured
// 2026-10-01: 599 "Do Not Call" and 114 "DNC" in 30 days).
export const FIVE9_DNC_DISPOSITIONS = Object.freeze(['Do Not Call', 'DNC']);

/**
 * DNC_REENTRY_SWEEP_MODE = off | shadow | live. Default LIVE: the sweep only
 * asks a person — the card changes nothing until someone clicks Approve — and
 * the whole point (the user, 2026-10-01) is that nobody has to add a tag.
 */
export function reentryMode(env = process.env) {
  const v = String(env.DNC_REENTRY_SWEEP_MODE || '').trim().toLowerCase();
  return v === 'off' || v === 'shadow' ? v : 'live';
}

export const markKey = (lpLeadId) => `${MARK_PREFIX}${lpLeadId}`;

/**
 * Decide every lead of one pass. Pure.
 *
 * @param {object[]} leads  { lp_lead_id, ghl_contact_id, phone10, lead_source,
 *                            lead_source_detail, disposition_code, arrived_at }
 * @param {object}   facts
 *   marked          Set<lp_lead_id>   already decided on an earlier pass
 *   recordBlocks    Map<contactId, string[]>  blocks our records show
 *   five9Dnc        Set<phone10>      numbers on Five9's DNC list now
 *   optedOutAfter   Set<lp_lead_id>   a consent opt-out or Five9 DNC
 *                                     disposition AFTER the lead arrived
 *   alreadyAsked    Set<contactId>    a review queued or awaiting a decision
 *   max             asks allowed this pass
 * @returns {{ ask: object[], done: object[], deferred: object[] }}
 *   ask      → queue a review AND mark
 *   done     → mark only (decided: nothing to ask), with .reason
 *   deferred → over the cap; left unmarked for the next pass
 */
export function decideReentryAsks(leads, {
  marked = new Set(), recordBlocks = new Map(), five9Dnc = new Set(),
  optedOutAfter = new Set(), alreadyAsked = new Set(), max = MAX_ASKS_PER_PASS,
} = {}) {
  const ask = [];
  const done = [];
  const deferred = [];
  const askedThisPass = new Set();
  for (const lead of leads || []) {
    const id = String(lead.lp_lead_id ?? '');
    if (!id || marked.has(id)) continue;
    const contactId = lead.ghl_contact_id ? String(lead.ghl_contact_id) : '';
    const settle = (reason) => done.push({ ...lead, reason });
    if (!contactId) { settle('no_contact'); continue; }
    if (String(lead.disposition_code || '').trim().toUpperCase() === 'DNC') { settle('opted_out_on_this_lead'); continue; }
    if (optedOutAfter.has(id)) { settle('opted_out_after_arrival'); continue; }
    const blockedIn = [...(recordBlocks.get(contactId) || [])];
    if (lead.phone10 && five9Dnc.has(lead.phone10)) blockedIn.push('five9');
    if (!blockedIn.length) { settle('not_blocked'); continue; }
    if (alreadyAsked.has(contactId) || askedThisPass.has(contactId)) { settle('already_asked'); continue; }
    if (ask.length >= max) { deferred.push(lead); continue; }
    askedThisPass.add(contactId);
    ask.push({ ...lead, blocked_in: blockedIn });
  }
  return { ask, done, deferred };
}

/** Blocks our own records show for one contact. Pure. */
export function recordBlocksFor({ consent, tags }) {
  const out = [];
  if (consent && (consent.dnc_full === true || consent.phone_consent === 'revoked' || consent.sms_carrier_stop === true)) {
    out.push('consent');
  }
  const lower = new Set((Array.isArray(tags) ? tags : []).map((t) => String(t || '').toLowerCase()));
  if (BLOCKED_TAGS.some((t) => lower.has(t))) out.push('tags');
  return out;
}

/** The agent_actions row that asks. Pure. */
export function buildReviewAction(lead) {
  const vendor = lead.lead_source_detail || null;
  return {
    action_type: 'request_dnc_lift_review',
    target_system: 'lp',
    target_entity: 'contact',
    target_id: String(lead.ghl_contact_id),
    action_payload: {
      trigger: 'reentry',
      lead_id: String(lead.lp_lead_id),
      lead_source: lead.lead_source || null,
      vendor,
      blocked_in: lead.blocked_in,
    },
    rule_applied: RULE_KEY,
    reasoning: `New LP lead ${lead.lp_lead_id}${vendor ? ` from ${vendor}` : ''} for a number that is blocked (${lead.blocked_in.join(', ')}) — asking a person in #dnc-lift-approval`,
    status: 'pending',
    requires_approval: false,
    priority: 20,
  };
}
