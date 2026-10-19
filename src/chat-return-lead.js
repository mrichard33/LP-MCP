/**
 * Returning lead talks to the website chatbot → a new LP lead — src/chat-return-lead.js
 *
 * Pure and dependency-free. src/jobs/chat-return-lead-sweep.js owns the reads
 * (our live-chat turns, the HL contacts mirror, lp_leads, LP live, the marks)
 * and the writes (LP source stamp, old LP Lead ID cleared, 8e30ff37 enroll).
 *
 * WHY (the user, 2026-10-19)
 *   "Any lead in our system that is over 15 days old and engages with the
 *   chatbot then should be sent back to lead perfection with the Reece Chatbot
 *   as the new source." Nothing did this. GHL merges a chat visitor who types
 *   a known phone into their OLD contact, so I.CT (Contact Created) never
 *   fires, rule 386 never runs, and the chat-lead intake sweep only looks at
 *   contacts created in the last 30 days. Even when create_lp_lead did run,
 *   the old LP Lead ID on the contact made it answer `already_in_lp`, and the
 *   contact's LP Source ID still named the OLD source (Facebook, a vendor), so
 *   any new lead would have been credited to that channel instead of the bot.
 *
 * THE RULE
 *   A website chat (a LIVE_CHAT_FAST_LANE turn) on a GHL contact that was added
 *   more than RETURN_DAYS (15) before the chat, whose newest LP lead is also
 *   more than 15 days old (or who has none), gets a new LP lead with source
 *   Reece ChatBot (830 / 5574). The 15-day test is the inbound-call capture's
 *   (src/inbound-capture-match.js, option B): an LP inquiry still waiting to be
 *   checked out, a lead from the last 15 days, or an older lead LP changed from
 *   an hour before the chat on (the team worked it for this chat, e.g. the
 *   chat booked a visit onto it) is the person's lead, and nothing is created.
 *   A contact added in the last 15 days is a NEW chat lead: rule 386 and the
 *   chat-lead intake sweep own it.
 *
 * NEVER (safety, 2026-10-19)
 *   - an opt-out / delete tag (EXCLUDE_TAGS, the chat intake's list);
 *   - a sold customer (closed won, or Sale on any lead): a customer in the chat
 *     is a service question, not a new sales lead;
 *   - a lead with a live appointment today or later (Set / Cnf / Issue): that
 *     lead is the active one;
 *   - a lead in rehash (the `rehash` / `active-f.0` tags, or a demo
 *     disposition in the last REHASH_DAYS): the rehash team owns it for 30
 *     days, and a newer lead would end its rehash stage;
 *   - twice: once sent, a contact is not sent again for 15 days, and a chat
 *     already decided is not decided again.
 */

import { hasExcludedTag } from './lead-intake-gap.js';
import { normalizePhone10 } from './lead-leak-classify.js';
import { isDemoDisposition } from './demo-truth.js';
import { isLiveAppointmentDisposition } from './lp-disposition-classes.js';
import { LP_SRS, LP_PRO } from './lp-source-ids.js';

const DAY_MS = 86_400_000;

/** The LP source every chatbot lead carries: SubSource 830 "Reece ChatBot", Promoter 5574. */
export const CHATBOT_LP_SOURCE = Object.freeze({
  srsId: LP_SRS.CHATBOT, proId: LP_PRO.CHATBOT, subSource: 'Reece ChatBot', label: 'Chatbot',
});

export const RETURN_DAYS = 15;
export const REHASH_DAYS = 30;
// The chat must be quiet this long first: a chat that books lands its visit on
// the old lead in LP within minutes, and the lead match then reads that lead as
// worked for this chat (no duplicate).
export const QUIET_MIN = 60;
// Look back a day, so a deploy or an outage does not lose a chat.
export const LOOKBACK_HOURS = 24;
export const MAX_PER_PASS = 10;
export const LIVE_CHAT_RULE = 'LIVE_CHAT_FAST_LANE';
export const SENT_PREFIX = 'chat-return:';
export const SEEN_PREFIX = 'chat-return-seen:';
export const REHASH_TAGS = Object.freeze(['rehash', 'active-f.0']);

export const sentKey = (contactId) => `${SENT_PREFIX}${contactId}`;
export const seenKey = (contactId, lastChatAt) => `${SEEN_PREFIX}${contactId}:${Date.parse(lastChatAt) || String(lastChatAt)}`;

const esc = (s) => String(s).replace(/'/g, "''");
const list = (xs) => xs.map((x) => `'${esc(x)}'`).join(',');

/** live (default, the user's ruling 2026-10-19) | shadow | off. */
export function chatReturnMode(env = process.env) {
  const m = String(env.CHAT_RETURN_LP_MODE || 'live').toLowerCase().trim();
  return ['off', 'shadow', 'live'].includes(m) ? m : 'live';
}

/** LP DB: every contact with a live-chat turn in the window whose chat has gone quiet. */
export function buildChatEngagementsSql({ sinceIso, quietBeforeIso }) {
  return `
    SELECT target_id AS ghl_contact_id, min(created_at) AS chat_started_at, max(created_at) AS last_chat_at
      FROM agent_actions
     WHERE rule_applied = '${LIVE_CHAT_RULE}'
       AND action_type = 'send_message'
       AND target_id IS NOT NULL
       AND created_at >= '${esc(sinceIso)}'
     GROUP BY target_id
    HAVING max(created_at) < '${esc(quietBeforeIso)}'
     ORDER BY max(created_at) ASC
  `;
}

/** HL mirror: the contacts behind those chats. */
export function buildContactsSql(ids) {
  return `
    SELECT ghl_contact_id, first_name, last_name, phone, date_added, tags
      FROM contacts
     WHERE deleted_at IS NULL AND ghl_contact_id IN (${list(ids)})
  `;
}

/** LP DB: every lead on these phones, for the customer / live visit / rehash checks. */
export function buildLeadStatusSql(phones) {
  return `
    SELECT right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) AS phone10,
           right(regexp_replace(coalesce(phone_alt, ''), '[^0-9]', '', 'g'), 10) AS alt10,
           disposition_code, closed_won, appointment_date::text AS appointment_date,
           demo_date::text AS demo_date, created_at_lp::text AS created_at_lp
      FROM lp_leads
     WHERE lp_deleted_at IS NULL
       AND (right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) IN (${list(phones)})
            OR right(regexp_replace(coalesce(phone_alt, ''), '[^0-9]', '', 'g'), 10) IN (${list(phones)}))
  `;
}

const dayOf = (v) => {
  const t = Date.parse(v ?? '');
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};
const lower = (tags) => (Array.isArray(tags) ? tags : []).map((t) => String(t).trim().toLowerCase());

/**
 * Why this person's existing LP leads say "do not make a new one", or null.
 * leads: lp_leads rows for the phone. todayEt: 'YYYY-MM-DD' (Eastern).
 */
export function leadStatusBlock(leads, { nowMs, todayEt }) {
  const rows = Array.isArray(leads) ? leads : [];
  if (rows.some((l) => l.closed_won === true || String(l.disposition_code ?? '').trim() === 'Sale')) return 'customer';
  if (rows.some((l) => isLiveAppointmentDisposition(l.disposition_code) && (dayOf(l.appointment_date) ?? '') >= todayEt)) {
    return 'live_appointment';
  }
  const rehashSince = nowMs - REHASH_DAYS * DAY_MS;
  if (rows.some((l) => isDemoDisposition(l.disposition_code)
      && Date.parse(l.demo_date || l.appointment_date || '') >= rehashSince)) return 'rehash';
  return null;
}

/**
 * First cut, before any LP read. Returns { check, skipped } where `check` is the
 * chats worth a lead match (oldest first, capped at `max`).
 *   contacts       Map id → HL contact row
 *   sentRecently   Set of contact ids sent by this sweep in the last 15 days
 *   seen           Set of seenKey()s already decided
 *   recentCreate   Set of contact ids with a create_lp_lead action in 15 days
 */
export function selectChats(engagements, { contacts, sentRecently, seen, recentCreate, max = MAX_PER_PASS }) {
  const skipped = { no_contact: 0, new_contact: 0, no_phone: 0, excluded: 0, rehash: 0, already_sent: 0, already_decided: 0, sent_elsewhere: 0, over_cap: 0 };
  const check = [];
  const phones = new Set();
  for (const e of engagements || []) {
    const id = String(e.ghl_contact_id ?? '');
    const c = contacts?.get(id);
    if (!c) { skipped.no_contact += 1; continue; }
    const chatMs = Date.parse(e.chat_started_at ?? e.last_chat_at ?? '');
    const addedMs = Date.parse(c.date_added ?? '');
    // Added within 15 days of the chat (or no date): a new chat lead, not ours.
    if (!Number.isFinite(addedMs) || !Number.isFinite(chatMs) || addedMs > chatMs - RETURN_DAYS * DAY_MS) { skipped.new_contact += 1; continue; }
    const phone10 = normalizePhone10(c.phone);
    if (!phone10) { skipped.no_phone += 1; continue; }
    if (hasExcludedTag(c.tags)) { skipped.excluded += 1; continue; }
    if (lower(c.tags).some((t) => REHASH_TAGS.includes(t))) { skipped.rehash += 1; continue; }
    if (sentRecently?.has(id)) { skipped.already_sent += 1; continue; }
    if (seen?.has(seenKey(id, e.last_chat_at))) { skipped.already_decided += 1; continue; }
    if (recentCreate?.has(id)) { skipped.sent_elsewhere += 1; continue; }
    if (phones.has(phone10)) { skipped.already_sent += 1; continue; } // two contacts, one person
    if (check.length >= max) { skipped.over_cap += 1; continue; }
    phones.add(phone10);
    check.push({
      ghl_contact_id: id, phone10, first_name: c.first_name ?? null, last_name: c.last_name ?? null,
      date_added: c.date_added ?? null, chat_started_at: e.chat_started_at ?? null, last_chat_at: e.last_chat_at ?? null,
    });
  }
  return { check, skipped };
}

/**
 * The decision for one chat after the reads.
 *   match  readLeadMatch()'s answer ({ verdict, lead, why })
 *   statusBlock  leadStatusBlock()'s answer
 * Returns { decision: 'send' | 'skip' | 'retry', reason, returning }.
 *   retry: could not tell (a failed read). Nothing is marked; the next pass asks again.
 */
export function decideChat({ match, statusBlock }) {
  if (statusBlock) return { decision: 'skip', reason: statusBlock, returning: false };
  const v = match?.verdict;
  if (v === 'create_returning') return { decision: 'send', reason: match.why || 'returning lead', returning: true };
  if (v === 'create') return { decision: 'send', reason: match.why || 'no LP lead for this phone', returning: false };
  if (v === 'reuse') return { decision: 'skip', reason: 'recent_lead', returning: false };
  return { decision: 'retry', reason: match?.why || 'lead match could not tell', returning: false };
}

/** The GHL note left when the old LP Lead ID is cleared. A GHL note may name the lead id. */
export function clearNote(oldLeadId, matchedLead) {
  const when = matchedLead?.at ? String(matchedLead.at).slice(0, 10) : 'an earlier date';
  const prospect = matchedLead?.prospect_id ? `Prospect ${matchedLead.prospect_id}` : 'their earlier prospect';
  return `Returning lead: chatted on the website more than ${RETURN_DAYS} days after their last LP lead `
    + `(${oldLeadId}, ${prospect}, ${when}). LP Lead ID cleared and LP Source set to Reece ChatBot (830 / 5574) `
    + 'so a new LP lead is created for this chat (chat return sweep).';
}
