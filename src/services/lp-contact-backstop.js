// LP Contact Auto-Create Backstop — src/services/lp-contact-backstop.js
//
// WHY: GHL contact creation currently depends on LP's outbound webhook
//   reaching GHL workflow I.LP-IN, and delivery is demonstrably inconsistent
//   (verified 2026-07-09: 7 of 23 unique Set leads for July 10 had no
//   ghl_contact_id — same sources/days as delivered ones). LP webhooks don't
//   retry. No contact → no GHL appointment → the lead is invisible to the
//   dashboard, reminders, and confirmation sequences. The polling sync sees
//   100% of LP leads, so this backstop moves contact creation onto the
//   guaranteed pipe: every LP lead with an upcoming Set/Cnf/Verif appointment
//   and no GHL contact gets one (find-before-create), then reconciles its
//   Window Estimate appointment immediately.
//
// 2026-07-26 — INTAKE MODE (second selection path, separately flagged).
//   The appointment sweep above only scans Set/Cnf/Verif WITH an appointment
//   date. A freshly-purchased internet lead arrives at disposition "Data"
//   with no appointment, so it fails both filters and is permanently
//   ineligible — not delayed, ineligible. Live count 2026-07-26:
//
//     disposition | unlinked (60d) | has appointment
//     Data        |          8,331 |               0
//     Set         |            314 |             314
//     (all others |            <15 |            <15)
//
//   By source, % of leads with no ghl_contact_id (60d): Modernize 91.3%,
//   Simpletext 95.4%, Porch101 94.2%, MyHomePros 86.3%, Lead Gurus 62.9%,
//   MVP Marketing 25.7% — against Canvass 0.8% and Website Estimate
//   Calculator 0%. The split is structural: leads that ORIGINATE in GHL link
//   fine; leads that originate in LP ride the unreliable webhook. Spot-check
//   of 12 recent unlinked leads against HL Supabase on normalized last-10
//   phone digits returned ZERO matches — the contacts were never created,
//   this is not a link-writeback failure.
//
//   Consequence: ~139 purchased leads/day with no speed-to-lead, no E.0
//   routing, no indoctrination, no agentic bot, no dashboard presence.
//
//   scanIntakeBackstopCandidates() closes that gap. It selects on
//   disposition "Data" with a RECENCY window (created_at_lp) in place of the
//   appointment-date window, since there is no appointment to bound. Contact
//   creation alone is the payload: it emits ghl.contact_created, which the
//   entry-source hygiene rules and E.0 already consume.
//
//   SAFETY — the reason this ships behind its own flag: at 139/day plus an
//   8,331-lead standing backlog, an unbounded run would mass-create contacts
//   and cascade into speed-to-lead messaging. Two independent guards:
//     1. suppressOutbound (run-level) tags creations `suppress-outbound`
//     2. a per-lead freshness belt applies the same tag to any lead older
//        than INTAKE_FRESH_HOURS regardless of run mode — so a stale lead
//        swept up by the forward-only sweep still cannot be texted
//        "just following up" about a form they filled out weeks ago.
//   Owner decision 2026-07-26: forward-only leads enter the normal motion,
//   backlog leads land suppressed for rep review.
//
// SHAPE: a flag-gated periodic sweep (NOT a decision-engine rule —
//   createActionsFromRule takes target_id from event.ghl_contact_id and
//   auto-skips exactly the unlinked leads we need). The scheduler + admin
//   endpoint live in src/admin/lp-contact-backstop.js; this module is the
//   pure/core logic (scan → per-lead find-or-create → reconcile), all GHL I/O
//   via ghlFetch so the whole path is testable under one global.fetch stub.
//   The intended entry point in production is POST /admin/lp-contact-backstop
//   (dry-run default) and the env-gated 15-min sweep.
//
// COEXISTENCE: races benignly with I.LP-IN — find-before-create + the
//   duplicate-400 re-search dedupe contacts, and reconcileLpAppointmentToGhl
//   is idempotent (same-time skip). Its DNC consent guard makes a matched
//   do-not-contact a link-only case (no appointment).

import supabase from '../supabase.js';
import { ghlFetch } from '../actions/helpers.js';
import { GHL_LOCATION_ID } from '../actions/constants.js';
import { reconcileLpAppointmentToGhl } from './lp-ghl-appointment-reconciler.js';
import { normalizePhone } from '../sync-utils.js';
import { appointmentDelta } from '../appointment-dates.js';
import { emitDispositionBackfill } from '../sync-leads.js';
import { buildClassifiedNotification } from '../actions/notification-classifier.js';
import { sendGroupMeMessage } from '../groupme.js';

// LP custom field IDs (canonical: src/actions/handlers/lp-lead.js:65,
// src/lp-appointment-sync.js:205-207). Written as { id, field_value } —
// the repo convention (updateGHLContactFields / resolve-or-create.js:151).
const LP_LEAD_ID_FIELD = 'GmAVmW6V9sekD7pVONKr';
const LP_PROSPECT_ID_FIELD = 'ZRQAVrzhtzApzLlHmT87';

// Only live-appointment dispositions. NOT CXL — no value creating a contact
// for a cancelled appointment; NOT DNC/Issue/others.
const DISPOSITIONS = ['Set', 'Cnf', 'Verif'];
const DEFAULT_HORIZON_DAYS = 45;
// Absolute upper bound enforced REGARDLESS of the caller's horizon_days. This
// — not the caller-supplied window — is the guard that keeps garbage-dated LP
// rows (verified live: unlinked "future" appointments dated Sept 2026, and junk
// like year 3026/2033/2029) from ever minting a contact. A mis-parameterized
// POST /admin/lp-contact-backstop {horizon_days: 99999} cannot get past it.
export const MAX_HORIZON_DAYS = 60;
export const DEFAULT_MAX_PER_RUN = 50;

// ─── Intake mode (2026-07-26) ────────────────────────────────────────
// Disposition "Data" = a lead LP has but no appointment has been set for.
export const INTAKE_DISPOSITIONS = ['Data'];
// Forward-only sweep window. Generous enough to absorb a multi-day outage;
// the sweep runs every 15 min so steady-state leads are minutes old.
export const DEFAULT_INTAKE_LOOKBACK_HOURS = 72;
// Absolute ceiling, enforced regardless of the caller — the intake analogue
// of MAX_HORIZON_DAYS. A backlog run must be deliberate, not a typo.
export const MAX_INTAKE_LOOKBACK_HOURS = 24 * 120;
// Leads older than this get `suppress-outbound` at creation even on a
// forward-only run. A lead that filled out a form days ago must not receive
// a speed-to-lead text as if it just arrived.
export const DEFAULT_INTAKE_FRESH_HOURS = 24;
export const DEFAULT_INTAKE_MAX_PER_RUN = 25;
export const LP_INTAKE_SUPPRESS_TAG = 'suppress-outbound';

// ─── Tag mapping (create-time only) ──────────────────────────────────
// Mirrors what I.LP-IN-created contacts carry today (verified on Lopez
// Raices / Cangemi). Invariants: exactly ONE active-entry:* and ONE stage:*.
// lp-backstop-created is distinct from I.LP-IN's lp-inbound so provenance is
// auditable. Mark can tune this later — kept as one exported constant.
export const LP_BACKSTOP_ALWAYS_TAGS = ['lp-backstop-created', 'lp-linked', 'stage:new-lead'];
export const LP_BACKSTOP_TAG_MAP = {
  Canvass:    ['entry:canvassing', 'active-entry:canvassing', 'source:canvass'],
  Internet:   ['entry:other', 'active-entry:other', 'source:internet'],
  Affiliates: ['entry:other', 'active-entry:other', 'source:affiliate'],
};
const LP_BACKSTOP_DEFAULT_TAGS = ['entry:other', 'active-entry:other', 'source:unknown'];

// 2026-07-26 — vendor attribution. Every purchased-media source collapsed to
// `source:internet` / `source:affiliate`, which satisfies the ONE-entry:*
// invariant but destroys per-vendor reporting: Modernize, Porch101, Lead
// Gurus and MyHomePros were indistinguishable once in GHL. The vendor rides
// a THIRD, non-conflicting tag — same shape as `canvass-subtype:door-to-door`
// — so the invariant is untouched and a channel is still one prefix filter.
const SOURCE_DETAIL_PREFIX = {
  Internet: 'source:internet-',
  Affiliates: 'source:affiliate-',
};

/** Lowercase hyphenated slug of an LP lead_source_detail. "Lead Gurus" → "lead-gurus". */
export function vendorSlug(detail) {
  return String(detail || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Per-vendor attribution tag, or null when the source has no vendor axis
 * (Canvass already carries canvass-subtype:*) or the detail is unusable.
 */
export function sourceDetailTagFor(leadSource, leadSourceDetail) {
  const prefix = SOURCE_DETAIL_PREFIX[leadSource];
  if (!prefix) return null;
  const slug = vendorSlug(leadSourceDetail);
  // A detail equal to the source itself ("Internet"/"Affiliates") carries no
  // information — the base source:* tag already says that.
  if (!slug || slug === vendorSlug(leadSource)) return null;
  return `${prefix}${slug}`;
}

/**
 * Create-time tag set for a lead: mapped-or-default base + vendor attribution
 * + always tags, plus `suppress-outbound` when the caller asks for it.
 * Exactly one entry:* and one active-entry:* in every branch.
 */
export function backstopTagsFor(leadSource, leadSourceDetail = null, { suppressOutbound = false } = {}) {
  const base = LP_BACKSTOP_TAG_MAP[leadSource] || LP_BACKSTOP_DEFAULT_TAGS;
  const detail = sourceDetailTagFor(leadSource, leadSourceDetail);
  return [
    ...base,
    ...(detail ? [detail] : []),
    ...LP_BACKSTOP_ALWAYS_TAGS,
    ...(suppressOutbound ? [LP_INTAKE_SUPPRESS_TAG] : []),
  ];
}

// ─── Name hygiene ────────────────────────────────────────────────────
// Light only: trim + collapse whitespace, and drop pure-junk placeholders to
// empty (the existing n8n enrich/name-normalization pipeline does the rest).
const NAME_JUNK = new Set(['n/a', 'na', 'n\\a', '..', '...', '?', '-', '.', 'none', 'null', 'unknown', 'test']);
export function cleanName(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return NAME_JUNK.has(t.toLowerCase()) ? '' : t;
}

// ─── Window predicates ───────────────────────────────────────────────

/**
 * Appointment-mode window: today (>=0) through the ABSOLUTE ceiling
 * (MAX_HORIZON_DAYS), independent of any caller horizon param. Rejects
 * past-dated AND absurd-future rows (Sept-2026 stragglers, year-3026/2033
 * junk) — this bound is the whole protection against minting garbage
 * contacts. Deliberately NOT lpWallClockToGhlStartTime: it returns null for
 * date-only / exact-midnight rows ("time TBD"), which must still get a
 * contact — the appointment follows when LP posts a real time and the
 * LP_APPT_GHL_SYNC_* rules fire.
 */
export function isWithinApptWindow(lead) {
  const d = appointmentDelta(lead.appointment_date);
  return !!(d && d.days_delta >= 0 && d.days_delta <= MAX_HORIZON_DAYS);
}

/**
 * Intake-mode window: lead ENTERED LP within the lookback. There is no
 * appointment to bound against, so recency is the garbage guard — it is what
 * stops a backlog run from reaching back into 2024. Small negative ages are
 * tolerated for clock skew between LP and this process.
 */
export function makeIsWithinIntakeWindow(lookbackHours, nowMs = Date.now()) {
  const eff = Math.min(Math.max(0, lookbackHours), MAX_INTAKE_LOOKBACK_HOURS);
  return (lead) => {
    const t = Date.parse(lead.created_at_lp);
    if (!Number.isFinite(t)) return false;
    const ageHours = (nowMs - t) / 3600000;
    return ageHours >= -1 && ageHours <= eff;
  };
}

// ─── Selection ───────────────────────────────────────────────────────
/**
 * Scan lp_leads for APPOINTMENT-mode backstop candidates: unlinked leads with
 * an upcoming Set/Cnf/Verif appointment and a plausibly-valid phone. Coarse
 * SQL date prefilter (appointment_date stores ET wall-clock mislabeled as UTC
 * → bounds widened a day each side), exact day-granular filtering in JS.
 *
 * @returns {{ targets, noPhone, deferredCapped, eligible, totalRows }}
 *   targets: [{ lead, superseded }] deduped by phone (newest wins), capped.
 *   noPhone: report-only rows dropped for missing/short phone.
 */
export async function scanContactBackstopCandidates({
  horizonDays = DEFAULT_HORIZON_DAYS,
  maxPerRun = DEFAULT_MAX_PER_RUN,
  limit = 0,
} = {}) {
  if (!supabase) throw new Error('Supabase not configured');

  // Clamp the SQL upper bound to the absolute ceiling regardless of the caller's
  // horizonDays — the JS gate in selectBackstopTargets re-asserts the same bound
  // so garbage-dated rows can never slip through either layer.
  const effHorizon = Math.min(Math.max(0, horizonDays), MAX_HORIZON_DAYS);
  const fromIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const toIso = new Date(Date.now() + (effHorizon + 1) * 24 * 3600 * 1000).toISOString();

  const PAGE = 1000;
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('lp_leads')
      .select('lp_lead_id, ghl_contact_id, disposition_code, appointment_date, created_at_lp, first_name, last_name, phone, lead_source, lead_source_detail, lp_prospect_id')
      .is('ghl_contact_id', null)
      .in('disposition_code', DISPOSITIONS)
      .gte('appointment_date', fromIso)
      .lte('appointment_date', toIso)
      .order('created_at_lp', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`lp_leads backstop scan failed at offset ${from}: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  return { ...selectBackstopTargets(rows, { maxPerRun, limit }), totalRows: rows.length };
}

/**
 * Scan lp_leads for INTAKE-mode candidates (2026-07-26): unlinked leads at
 * disposition "Data" that entered LP within the lookback window. These have
 * no appointment — contact creation itself is the deliverable, because it
 * emits ghl.contact_created and puts the lead into the normal entry flow.
 *
 * Same shape as scanContactBackstopCandidates so both feed one run loop.
 */
export async function scanIntakeBackstopCandidates({
  lookbackHours = DEFAULT_INTAKE_LOOKBACK_HOURS,
  maxPerRun = DEFAULT_INTAKE_MAX_PER_RUN,
  limit = 0,
} = {}) {
  if (!supabase) throw new Error('Supabase not configured');

  const effLookback = Math.min(Math.max(0, lookbackHours), MAX_INTAKE_LOOKBACK_HOURS);
  const fromIso = new Date(Date.now() - effLookback * 3600 * 1000).toISOString();

  const PAGE = 1000;
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('lp_leads')
      .select('lp_lead_id, ghl_contact_id, disposition_code, appointment_date, created_at_lp, first_name, last_name, phone, lead_source, lead_source_detail, lp_prospect_id')
      .is('ghl_contact_id', null)
      .in('disposition_code', INTAKE_DISPOSITIONS)
      .gte('created_at_lp', fromIso)
      .order('created_at_lp', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`lp_leads intake scan failed at offset ${from}: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const selected = selectBackstopTargets(rows, {
    maxPerRun,
    limit,
    withinWindow: makeIsWithinIntakeWindow(effLookback),
  });
  return { ...selected, totalRows: rows.length, lookback_hours: effLookback };
}

/**
 * Pure JS selection over already-pulled lp_leads rows (rows MUST be
 * created_at_lp DESC): window gate → phone gate → dedupe by phone
 * (newest wins) → safety cap. Exported for direct testing.
 *
 * `withinWindow` is injectable so appointment mode and intake mode share this
 * function without either loosening the other's guard.
 *
 * @returns {{ targets:[{lead,superseded}], noPhone, deferredCapped, eligible }}
 */
export function selectBackstopTargets(rows, {
  maxPerRun = DEFAULT_MAX_PER_RUN,
  limit = 0,
  withinWindow = isWithinApptWindow,
} = {}) {
  const noPhone = [];
  const phoneValid = [];
  for (const lead of rows) {
    if (!withinWindow(lead)) continue;
    const p = normalizePhone(lead.phone);
    if (!p || p.length < 10) { noPhone.push(lead); continue; }
    phoneValid.push({ lead, phone: p });
  }

  // Dedupe by normalized phone — newest created_at_lp wins (rows are already
  // desc, so first seen per phone wins). Multi-lead reality (Mark Test = 4).
  const byPhone = new Map();
  for (const { lead, phone } of phoneValid) {
    if (!byPhone.has(phone)) byPhone.set(phone, { lead, superseded: 0 });
    else byPhone.get(phone).superseded++;
  }

  const eligibleList = Array.from(byPhone.values());
  const cap = limit > 0 ? Math.min(limit, maxPerRun) : maxPerRun;
  const targets = eligibleList.slice(0, cap);
  const deferredCapped = Math.max(0, eligibleList.length - targets.length);

  return { targets, noPhone, deferredCapped, eligible: eligibleList.length };
}

// ─── GHL contact I/O (all via ghlFetch) ──────────────────────────────
/** Pick the phone-matching contact from a search result, verifying last-10 digits when the projection carries a phone. */
function pickPhoneMatch(contacts, normalizedPhone) {
  const list = Array.isArray(contacts) ? contacts : [];
  if (list.length === 0) return null;
  const want = normalizedPhone.slice(-10);
  const exact = list.find((c) => {
    const cp = normalizePhone(c?.phone);
    return cp && cp.slice(-10) === want;
  });
  if (exact) return exact;
  // No contact carries a matching phone in the projection: only accept the top
  // hit when it has no phone at all (trust the phone query); a mismatching
  // phone is a false positive we must not link.
  return list[0]?.phone ? null : list[0];
}

async function searchByPhone(normalizedPhone) {
  const q = encodeURIComponent(normalizedPhone);
  const res = await ghlFetch('GET', `/contacts/?query=${q}&locationId=${GHL_LOCATION_ID}`);
  return pickPhoneMatch(res?.contacts, normalizedPhone);
}

/** Custom-field stamps needed on an existing contact (only where currently empty). */
function stampFieldsFor(lead, contact) {
  const cfs = Array.isArray(contact?.customFields) ? contact.customFields : [];
  const has = (id) => cfs.some((f) => f.id === id && String(f.field_value ?? f.value ?? '').trim() !== '');
  const stamp = [];
  if (lead.lp_lead_id && !has(LP_LEAD_ID_FIELD)) stamp.push({ id: LP_LEAD_ID_FIELD, field_value: String(lead.lp_lead_id) });
  if (lead.lp_prospect_id && !has(LP_PROSPECT_ID_FIELD)) stamp.push({ id: LP_PROSPECT_ID_FIELD, field_value: String(lead.lp_prospect_id) });
  return stamp;
}

/** A GHL 400 that means "this phone already exists" (server-side dedup). */
function isDuplicate400(err) {
  const m = String(err?.message || '');
  return /→\s*400/.test(m) && /duplicat/i.test(m);
}

/**
 * Should this lead's NEW contact be created suppressed?
 *
 * Two independent triggers, either sufficient:
 *   - the run says so (backlog mode)
 *   - the lead is older than freshHours (belt: a stale lead swept up by the
 *     forward-only sweep must not get a speed-to-lead text either)
 * Unparseable created_at_lp is treated as stale — fail toward silence.
 */
export function shouldSuppressOutbound(lead, { suppressOutbound = false, freshHours = DEFAULT_INTAKE_FRESH_HOURS, nowMs = Date.now() } = {}) {
  if (suppressOutbound) return { suppress: true, reason: 'run_mode_backlog' };
  const t = Date.parse(lead?.created_at_lp);
  if (!Number.isFinite(t)) return { suppress: true, reason: 'unparseable_created_at' };
  const ageHours = (nowMs - t) / 3600000;
  if (ageHours > freshHours) return { suppress: true, reason: `stale_${Math.round(ageHours)}h` };
  return { suppress: false, reason: null };
}

// ─── Per-lead flow (find-before-create) ──────────────────────────────
/**
 * Link-or-create the GHL contact for one unlinked lead, then reconcile its
 * appointment IF it has one. `contactCache` is a per-lead Map shared with
 * the reconciler so a matched contact is read once. `seenPhones` dedupes
 * within a run (belt over the scan-level dedupe).
 *
 * 2026-07-26: appointment reconciliation is now conditional. Intake-mode
 * ("Data") leads have no appointment — calling the reconciler for them would
 * be a no-op at best and a garbage-dated booking at worst.
 *
 * Suppression is applied ONLY on CREATE. A matched EXISTING contact is never
 * given `suppress-outbound` — it may be mid-conversation, and silencing a
 * live thread to fix an attribution gap is not a trade we make.
 */
export async function processOneLead({
  lead,
  dryRun = false,
  seenPhones,
  contactCache,
  suppressOutbound = false,
  freshHours = DEFAULT_INTAKE_FRESH_HOURS,
}) {
  contactCache = contactCache || new Map();
  seenPhones = seenPhones || new Set();
  const base = { lp_lead_id: lead.lp_lead_id, name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim() };

  const phone = normalizePhone(lead.phone);
  if (!phone || phone.length < 10) return { ...base, outcome: 'skipped_no_phone' };
  if (seenPhones.has(phone)) return { ...base, outcome: 'skipped_dup_in_run' };
  seenPhones.add(phone);

  let match = await searchByPhone(phone);
  let contactId = null;
  let action = null; // 'linked' | 'created'
  let suppression = { suppress: false, reason: null };

  if (match) {
    contactId = match.id;
    action = 'linked';
    const full = await ghlFetch('GET', `/contacts/${contactId}`);
    const contact = full?.contact || full || {};
    if (!dryRun) {
      const stamp = stampFieldsFor(lead, contact);
      if (stamp.length) await ghlFetch('PUT', `/contacts/${contactId}`, { customFields: stamp });
    }
    contactCache.set(contactId, contact); // prime reconciler's DNC read
  } else if (!dryRun) {
    suppression = shouldSuppressOutbound(lead, { suppressOutbound, freshHours });
    const body = {
      locationId: GHL_LOCATION_ID,
      firstName: cleanName(lead.first_name),
      lastName: cleanName(lead.last_name),
      phone: lead.phone,
      source: 'lp-backstop',
      tags: backstopTagsFor(lead.lead_source, lead.lead_source_detail, { suppressOutbound: suppression.suppress }),
      customFields: [
        { id: LP_LEAD_ID_FIELD, field_value: String(lead.lp_lead_id) },
        ...(lead.lp_prospect_id ? [{ id: LP_PROSPECT_ID_FIELD, field_value: String(lead.lp_prospect_id) }] : []),
      ],
    };
    try {
      const cr = await ghlFetch('POST', '/contacts/', body);
      contactId = cr?.contact?.id || cr?.id || null;
      action = 'created';
    } catch (err) {
      if (!isDuplicate400(err)) throw err;
      // GHL deduped server-side (I.LP-IN may have raced in). Re-search → link.
      match = await searchByPhone(phone);
      if (!match) throw err;
      contactId = match.id;
      action = 'linked';
      suppression = { suppress: false, reason: null }; // linked, not created
      const full = await ghlFetch('GET', `/contacts/${contactId}`);
      contactCache.set(contactId, full?.contact || full || {});
    }
  } else {
    // Dry-run with no match: would create. Report what the tags WOULD be so a
    // dry run is a real preview of suppression + attribution, not a guess.
    suppression = shouldSuppressOutbound(lead, { suppressOutbound, freshHours });
    return {
      ...base,
      phone,
      outcome: 'created',
      appointment_result: 'dry_run_no_contact',
      would_tag: backstopTagsFor(lead.lead_source, lead.lead_source_detail, { suppressOutbound: suppression.suppress }),
      suppressed: suppression.suppress,
      suppress_reason: suppression.reason,
      dry_run: true,
    };
  }

  if (!contactId) return { ...base, phone, outcome: 'error', error: 'no_contact_id_after_create' };

  if (!dryRun && supabase) {
    const { error: updErr } = await supabase.from('lp_leads')
      .update({ ghl_contact_id: contactId })
      .eq('lp_lead_id', lead.lp_lead_id)
      .is('ghl_contact_id', null); // never clobber a link that raced in
    if (updErr) console.warn(`[LpContactBackstop] ghl_contact_id writeback failed for lead ${lead.lp_lead_id}: ${updErr.message}`);
  }

  // Announce the disposition to the event system for every rescued lead
  // (created OR linked). The direct reconcile below only creates the
  // appointment; without this emit the E.0 router and the rest of the
  // LP_DISP_* rule family never see these previously-invisible leads, which
  // is exactly how the appointment/routing gap re-opens. Idempotency-keyed
  // (disp_<id>_backfill_<disp>) so it never double-fires with the reconciler
  // or a later normal-sync emit; no-op for baseline dispositions — which
  // includes intake-mode "Data". Those leads route off ghl.contact_created
  // instead, which the contact creation above already emits.
  if (!dryRun) {
    await emitDispositionBackfill({
      lpLeadId: lead.lp_lead_id,
      lpProspectId: lead.lp_prospect_id,
      ghlContactId: contactId,
      disposition: lead.disposition_code,
      leadName: base.name || null,
      leadSource: lead.lead_source || null,
    }).catch((e) => console.warn(`[LpContactBackstop] disposition emit failed for lead ${lead.lp_lead_id}: ${e.message}`));
  }

  // Reconcile the appointment ONLY when the lead actually has one. For
  // appointment-mode leads the appointment appearing is the point, so
  // toNotify:true fires reminder/confirmation sequences off the GHL booking
  // trigger. Intake-mode "Data" leads have no appointment_date and skip this
  // entirely — there is nothing to reconcile and a synthesized booking would
  // be a false appointment.
  let apptResult = 'no_appointment';
  let outcome = action;
  if (lead.appointment_date) {
    const rec = await reconcileLpAppointmentToGhl({ contactId, lead, toNotify: true, contactCache, dryRun });
    apptResult = rec.outcome === 'noop' ? rec.reason : rec.outcome;
    if (rec.reason === 'dnc_consent') outcome = 'skipped_dnc'; // matched DNC = link-only
  }

  return {
    ...base,
    phone,
    contact_id: contactId,
    action,
    outcome,
    appointment_result: apptResult,
    suppressed: suppression.suppress || undefined,
    suppress_reason: suppression.reason || undefined,
    dry_run: dryRun || undefined,
  };
}

// ─── Run loop ────────────────────────────────────────────────────────
function leadLine(r) {
  const nm = (r.name || '(no name)').padEnd(24);
  const appt = r.appointment_result ? `appt=${r.appointment_result}` : '';
  const sup = r.suppressed ? ` SUPPRESSED(${r.suppress_reason})` : '';
  return `${String(r.outcome).padEnd(18)} lead=${String(r.lp_lead_id).padEnd(8)} ${nm} ${r.contact_id ? `contact=${r.contact_id} ` : ''}${appt}${sup}`.trimEnd();
}

/**
 * Shared execution over a completed scan. Both modes use this so the
 * per-lead guarantees (sequential GHL I/O, error isolation, no-phone
 * reporting) can never drift apart between them.
 */
async function executeOverScan(scan, { dryRun, suppressOutbound, freshHours, job }) {
  const counts = { linked: 0, created: 0, skipped_no_phone: 0, skipped_dnc: 0, skipped_dup_in_run: 0, error: 0 };
  const lines = [];
  const errors = [];
  const seenPhones = new Set();
  let suppressedCount = 0;

  for (const { lead } of scan.targets) {
    try {
      const r = await processOneLead({ lead, dryRun, seenPhones, contactCache: new Map(), suppressOutbound, freshHours });
      counts[r.outcome] = (counts[r.outcome] || 0) + 1;
      if (r.suppressed) suppressedCount++;
      lines.push(leadLine(r));
    } catch (err) {
      counts.error++;
      const msg = String(err?.message || err).slice(0, 300);
      errors.push({ lp_lead_id: lead.lp_lead_id, error: msg });
      lines.push(`error              lead=${String(lead.lp_lead_id).padEnd(8)} → ${msg}`);
    }
    if (job) { job.processed++; job.errors = errors.length; }
  }

  // Report-only rows (no valid phone): counted, never created.
  counts.skipped_no_phone = scan.noPhone.length;
  for (const l of scan.noPhone) {
    lines.push(`skipped_no_phone   lead=${String(l.lp_lead_id).padEnd(8)} ${`${l.first_name || ''} ${l.last_name || ''}`.trim() || '(no name)'} phone=${l.phone || '—'}`);
  }

  return { counts, lines, errors, suppressedCount };
}

/**
 * Run the APPOINTMENT-mode backstop over scanned candidates. Sequential
 * (ghlFetch's token bucket throttles GHL). `job` is optional live progress
 * state (admin route). Returns the summary; also written to job.summary when
 * a job is passed.
 */
export async function runLpContactBackstop({
  dryRun = true,
  horizonDays = DEFAULT_HORIZON_DAYS,
  maxPerRun = DEFAULT_MAX_PER_RUN,
  limit = 0,
  job = null,
} = {}) {
  const scan = await scanContactBackstopCandidates({ horizonDays, maxPerRun, limit });
  if (job) job.total = scan.targets.length;

  // Appointment mode never suppresses: these leads have a booked appointment
  // and MUST receive reminders/confirmations.
  const { counts, lines, errors } = await executeOverScan(scan, {
    dryRun, suppressOutbound: false, freshHours: Infinity, job,
  });

  const summary = {
    mode: 'appointment',
    dry_run: dryRun,
    horizon_days: horizonDays,
    max_per_run: maxPerRun,
    scanned_rows: scan.totalRows,
    eligible: scan.eligible,
    processed: scan.targets.length,
    deferred_capped: scan.deferredCapped,
    counts,
    errors,
    lines,
  };

  if (job) {
    job.summary = summary;
    job.status = 'completed';
    job.completed_at = new Date().toISOString();
  }

  // One intelligence-class rep summary per LIVE run with activity — no
  // per-contact spam. Best-effort: a send failure never fails the sweep.
  if (!dryRun && (counts.created || counts.linked || counts.skipped_dnc)) {
    try {
      const card = buildClassifiedNotification({
        notification_class: 'intelligence',
        action_verb: 'LP CONTACT BACKSTOP',
        name: 'LP Contact Backstop sweep',
        contactId: '—',
        tier: 'Warm',
        status: 'Backstop sweep',
        narrative:
          `Auto-create backstop swept ${scan.targets.length} unlinked LP lead(s): ` +
          `${counts.created} created, ${counts.linked} linked, ${counts.skipped_dnc} DNC link-only, ` +
          `${counts.skipped_no_phone} no-phone, ${scan.deferredCapped} deferred (cap ${maxPerRun}).`,
        next_step: 'Newest lp_leads rows now linked; LP_APPT_GHL_SYNC_* rules own them going forward.',
      });
      await sendGroupMeMessage(card, { flushNow: true });
    } catch (e) {
      console.warn(`[LpContactBackstop] summary notification failed: ${e.message}`);
    }
  }

  return summary;
}

/**
 * Run the INTAKE-mode backstop (2026-07-26): unlinked disposition-"Data"
 * leads that entered LP within the lookback. No appointment reconciliation —
 * contact creation is the deliverable.
 *
 * suppressOutbound=true is the BACKLOG posture (owner decision 2026-07-26:
 * backlog leads land suppressed for rep review). The forward-only sweep
 * passes false and relies on the per-lead freshness belt in
 * shouldSuppressOutbound to catch anything older than freshHours anyway.
 */
export async function runLpIntakeBackstop({
  dryRun = true,
  lookbackHours = DEFAULT_INTAKE_LOOKBACK_HOURS,
  maxPerRun = DEFAULT_INTAKE_MAX_PER_RUN,
  freshHours = DEFAULT_INTAKE_FRESH_HOURS,
  suppressOutbound = false,
  limit = 0,
  job = null,
} = {}) {
  const scan = await scanIntakeBackstopCandidates({ lookbackHours, maxPerRun, limit });
  if (job) job.total = scan.targets.length;

  const { counts, lines, errors, suppressedCount } = await executeOverScan(scan, {
    dryRun, suppressOutbound, freshHours, job,
  });

  const summary = {
    mode: 'intake',
    dry_run: dryRun,
    lookback_hours: scan.lookback_hours,
    fresh_hours: freshHours,
    suppress_outbound_run: suppressOutbound,
    max_per_run: maxPerRun,
    scanned_rows: scan.totalRows,
    eligible: scan.eligible,
    processed: scan.targets.length,
    deferred_capped: scan.deferredCapped,
    suppressed: suppressedCount,
    counts,
    errors,
    lines,
  };

  if (job) {
    job.summary = summary;
    job.status = 'completed';
    job.completed_at = new Date().toISOString();
  }

  if (!dryRun && (counts.created || counts.linked)) {
    try {
      const card = buildClassifiedNotification({
        notification_class: 'intelligence',
        action_verb: 'LP INTAKE BACKSTOP',
        name: 'LP Intake Backstop sweep',
        contactId: '—',
        tier: 'Warm',
        status: 'Intake sweep',
        narrative:
          `Intake backstop swept ${scan.targets.length} unlinked "Data" lead(s) from the last ` +
          `${scan.lookback_hours}h: ${counts.created} created, ${counts.linked} linked, ` +
          `${suppressedCount} created SUPPRESSED (backlog or older than ${freshHours}h), ` +
          `${counts.skipped_no_phone} no-phone, ${scan.deferredCapped} deferred (cap ${maxPerRun}).`,
        next_step: suppressedCount
          ? `${suppressedCount} contact(s) carry ${LP_INTAKE_SUPPRESS_TAG} — rep review before any outbound.`
          : 'Contacts created live; ghl.contact_created routes them through normal entry hygiene.',
      });
      await sendGroupMeMessage(card, { flushNow: true });
    } catch (e) {
      console.warn(`[LpIntakeBackstop] summary notification failed: ${e.message}`);
    }
  }

  return summary;
}
