/**
 * Chat leads → LP — src/chat-lead-intake.js
 *
 * Pure and dependency-free. src/jobs/chat-lead-intake-sweep.js owns the reads
 * (the HL contacts mirror, lp_leads, the sweep marks) and the enroll call.
 *
 * WHY (2026-09-28)
 *   13 of the 18 contacts the lead-leak monitor reported as "never reached LP"
 *   that morning were chat leads. GHL sends a contact to LP only when it books
 *   (rules 112 / 147) or picks up a hot-call / estimator tag (workflow
 *   8e30ff37's triggers). A chat lead that talks but does not book matched
 *   neither, so it was never pushed and never dialled. Nothing was broken —
 *   there was simply no path. This module picks those contacts; the sweep
 *   pushes them through the same canonical path force_lp_lead_creation uses.
 *
 * WHO (rulings, 2026-09-28)
 *   Every chat lead with a phone — booked or not — once it is MIN_AGE_HOURS old
 *   (3h by default; the primary chat path and the booking path go first), sent without waiting
 *   for an address (the LP address backfill fills it in later). A contact
 *   carrying an opt-out / delete / suppress tag (EXCLUDE_TAGS) is never sent.
 */

import { LP_ID_FIELDS, excludeTagsSql, hasExcludedTag } from './lead-intake-gap.js';
import { normalizePhone10 } from './lead-leak-classify.js';

const esc = (s) => String(s).replace(/'/g, "''");

// A contact is a chat lead by its source OR by one of these tags. The tags are
// the ones the chatbot and chat widget stamp (src/sync-sources.js,
// src/entry-event-handler.js, src/actions/handlers/tags.js).
export const CHAT_TAGS = Object.freeze([
  'entry:chatbot', 'active-entry:chatbot', 'source:reece-chatbot',
  'chatbot', 'chat-widget', 'live-chat',
]);

// 2026-09-28 — 3 hours by default (was 1). The primary chat path (GHL I.CT →
// rule 386 → create_lp_lead) sends at ~65 minutes, and lp_leads syncs ~15
// minutes behind LP. At 3 hours, anything the primary path sent is already in
// lp_leads, so the phone check below sees it. This sweep is the SAFETY NET for
// what the primary path missed — it must never race it.
export const MIN_AGE_HOURS = (() => {
  const n = Number(process.env.CHAT_LP_INTAKE_MIN_AGE_HOURS);
  return Number.isFinite(n) && n >= 1 ? n : 3;
})();

// Tags that mean another path already sent this contact to LP (or linked it).
export const SENT_ELSEWHERE_TAGS = Object.freeze([
  'lp-pushed-by-agentic', 'lp-existing-lead-reused', 'lp-linked', 'lp-lead-issued', 'lp-inbound',
]);

export function hasSentElsewhereTag(tags) {
  const set = new Set(SENT_ELSEWHERE_TAGS);
  return (Array.isArray(tags) ? tags : []).some((t) => set.has(String(t).trim().toLowerCase()));
}
// 30 days, the same window the never-reached-LP monitor reports on, so the
// sweep can clear anything that monitor would count. Measured 2026-09-28: 11
// eligible chat contacts in 30 days — MAX_PER_PASS is never the limit.
export const LOOKBACK_DAYS = 30;
export const MAX_PER_PASS = 20;
export const MARK_PREFIX = 'chat-intake:';

export const markKey = (contactId) => `${MARK_PREFIX}${contactId}`;

export function chatIntakeMode(env = process.env) {
  const m = String(env.CHAT_LP_INTAKE_MODE || 'shadow').toLowerCase().trim();
  return ['off', 'shadow', 'live'].includes(m) ? m : 'shadow';
}

/** Is this contact a chat lead, by source or tag? Case-insensitive. */
export function isChatContact({ source, tags } = {}) {
  if (/chat/i.test(String(source ?? ''))) return true;
  const set = new Set(CHAT_TAGS);
  return (Array.isArray(tags) ? tags : []).some((t) => set.has(String(t).trim().toLowerCase()));
}

/**
 * The HL mirror read: chat contacts added between `sinceIso` and `untilIso`,
 * not deleted, with a 10+ digit phone, no LP id stamped and no exclusion tag.
 */
export function buildChatCandidatesSql({ sinceIso, untilIso }) {
  const ids = LP_ID_FIELDS.map((id) => `'${esc(id)}'`).join(',');
  const tags = CHAT_TAGS.map((t) => `'${esc(t)}'`).join(',');
  return `
    SELECT ghl_contact_id, first_name, last_name, phone, source, tags, date_added
      FROM contacts c
     WHERE c.deleted_at IS NULL
       AND c.date_added >= '${esc(sinceIso)}'
       AND c.date_added <  '${esc(untilIso)}'
       AND length(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g')) >= 10
       AND (coalesce(c.source, '') ILIKE '%chat%'
            OR EXISTS (SELECT 1 FROM unnest(coalesce(c.tags, '{}'::text[])) AS ct(tag)
                        WHERE lower(ct.tag) IN (${tags})))
       AND ${excludeTagsSql('c.tags')}
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.custom_fields::jsonb) = 'array'
                                          THEN c.custom_fields::jsonb ELSE '[]'::jsonb END) e
          WHERE e->>'id' IN (${ids}) AND coalesce(e->>'value', '') <> ''
       )
     ORDER BY c.date_added ASC
  `;
}

/**
 * Decide each candidate. The SQL already filters most of this; re-checking in
 * JS keeps the rules in one testable place and guards against a drifted read.
 *   lpPhones  Set of phone10 with an lp_leads row (already in LP, just unstamped)
 *   marked    Set of contact ids that already carry a chat-intake mark
 *   sentElsewhere  Set of contact ids with a create_lp_lead agent action
 * Returns { send, skipped } — `send` oldest first, capped at `max`.
 */
export function selectChatLeads(candidates, { lpPhones, marked, sentElsewhere, nowMs, max = MAX_PER_PASS }) {
  const skipped = { not_chat: 0, too_new: 0, too_old: 0, no_phone: 0, excluded: 0, in_lp: 0, already_sent: 0, sent_elsewhere: 0, over_cap: 0 };
  const send = [];
  const seenPhones = new Set();
  for (const c of candidates || []) {
    const id = String(c.ghl_contact_id ?? '');
    const phone10 = normalizePhone10(c.phone);
    const addedMs = Date.parse(c.date_added ?? '');
    if (!isChatContact(c)) { skipped.not_chat += 1; continue; }
    if (!phone10) { skipped.no_phone += 1; continue; }
    if (hasExcludedTag(c.tags)) { skipped.excluded += 1; continue; }
    if (!Number.isFinite(addedMs) || addedMs > nowMs - MIN_AGE_HOURS * 3600_000) { skipped.too_new += 1; continue; }
    if (addedMs < nowMs - LOOKBACK_DAYS * 86_400_000) { skipped.too_old += 1; continue; }
    if (marked?.has(id)) { skipped.already_sent += 1; continue; }
    // Another path (rule 147 / rule 386 / I.LP-OUT) already sent or linked it.
    if (sentElsewhere?.has(id) || hasSentElsewhereTag(c.tags)) { skipped.sent_elsewhere += 1; continue; }
    // Same phone twice in one pass (a duplicate contact) → push one.
    if (lpPhones?.has(phone10) || seenPhones.has(phone10)) { skipped.in_lp += 1; continue; }
    if (send.length >= max) { skipped.over_cap += 1; continue; }
    seenPhones.add(phone10);
    send.push({ ghl_contact_id: id, first_name: c.first_name ?? null, last_name: c.last_name ?? null, phone10, source: c.source ?? null, date_added: c.date_added ?? null });
  }
  return { send, skipped };
}

const who = (r) => {
  const first = String(r.first_name ?? '').trim();
  const lastInitial = String(r.last_name ?? '').trim().charAt(0);
  return (first ? `${first}${lastInitial ? ` ${lastInitial}.` : ''}` : 'Unknown') + ` · ${r.ghl_contact_id}`;
};

/** One ops card per pass that sent (or, in shadow, would send) anyone. */
export function formatChatIntakeCard({ mode, sent, failed }) {
  const n = sent.length;
  const head = mode === 'live'
    ? `💬 *Chat leads sent to LP: ${n}*`
    : `💬 *Chat leads that WOULD be sent to LP (shadow): ${n}*`;
  const lines = [head, 'Chat leads that never booked had no path into LP; this sweep sends them through "Send Lead to Lead Perfection".'];
  for (const r of sent.slice(0, 20)) lines.push(`• ${who(r)}`);
  if (failed.length) {
    lines.push(`⚠️ Failed: ${failed.length}`);
    for (const f of failed.slice(0, 10)) lines.push(`• ${who(f)} — ${String(f.error).slice(0, 120)}`);
  }
  return lines.join('\n');
}
