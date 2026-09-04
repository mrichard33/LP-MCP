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
import { notifyBackstopRun } from './backstop-notify.js';
import { utcToLpStoredIso } from '../lp-dates.js';

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
// Sweep cadence. Defined HERE rather than in admin/lp-contact-backstop.js so the
// scheduler and the notification card's drain-time estimate ("N min to drain at
// this cap") read the same number — a stale hardcode in the card would quietly
// misstate how long a backlog takes to clear. admin imports these.
export const BACKSTOP_INTERVAL_MS = 15 * 60 * 1000;

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

// #292: how many errored leads the job summary carries as a ready-made sample.
// The full list stays in `errors`; every one of them is persisted to
// lp_sync_errors regardless, so the sample is a convenience, not the record.
export const ERROR_SAMPLE_SIZE = 10;
// Same rationale as BACKSTOP_INTERVAL_MS above.
export const INTAKE_INTERVAL_MS = 15 * 60 * 1000;

// ─── Tag mapping (create-time only) ──────────────────────────────────
// Mirrors what I.LP-IN-created contacts carry today (verified on Lopez
// Raices / Cangemi). Invariants: exactly ONE active-entry:* and ONE stage:*.
// lp-backstop-created is distinct from I.LP-IN's lp-inbound so provenance is
// auditable. Mark can tune this later — kept as one exported constant.
export const LP_BACKSTOP_ALWAYS_TAGS = ['lp-backstop-created', 'lp-linked', 'stage:new-lead'];
// 2026-07-26 (second pass) — coverage extended beyond Canvass/Internet/Affiliates.
// Those three were the only mapped sources, so EVERY other lead_source fell to
// LP_BACKSTOP_DEFAULT_TAGS and was created as `source:unknown` with no vendor
// tag at all. Live count of unlinked disposition-"Data" leads by source:
//
//   Internet 80,308 (mapped) | Iheart 4,084 | Canvass 1,863 (mapped)
//   (NULL) 1,574 | Website 1,088 | Old Source 414 | Canvass Sticky 292
//   Simpletext 167 | Magazine 146 | Affiliates 113 (mapped) | Job Signs 28
//
// Iheart is the PARENT source of Simpletext — one of the five sources named in
// the 2026-07-26 linkage handoff as structurally unlinked. Creating 4,084 of
// those as `source:unknown` destroys the attribution the intake backstop exists
// to restore, and re-tagging after the fact is strictly more expensive than
// mapping them before the first contact is minted.
//
// Every value below is a tag that ALREADY EXISTS in GHL (verified live against
// contacts.tags: source:radio, source:magazine, source:job-sign,
// source:previous-customer, source:reece-direct-site, source:self-generated,
// source:tv). No tag name is invented here — an unmapped source landing on
// `source:unknown` is a known, reportable state; a misspelled tag is silent
// attribution loss that no query can find.
export const LP_BACKSTOP_TAG_MAP = {
  Canvass:          ['entry:canvassing', 'active-entry:canvassing', 'source:canvass'],
  'Canvass Sticky': ['entry:canvassing', 'active-entry:canvassing', 'source:canvass'],
  Internet:         ['entry:other', 'active-entry:other', 'source:internet'],
  Affiliates:       ['entry:other', 'active-entry:other', 'source:affiliate'],
  // iHeart is a radio network; Simpletext is its SMS vendor and also appears as
  // a top-level lead_source in LP, so both map to the same channel.
  Iheart:           ['entry:other', 'active-entry:other', 'source:radio'],
  Simpletext:       ['entry:other', 'active-entry:other', 'source:radio'],
  Television:       ['entry:other', 'active-entry:other', 'source:tv'],
  Website:          ['entry:other', 'active-entry:other', 'source:reece-direct-site'],
  'Main Website':   ['entry:other', 'active-entry:other', 'source:reece-direct-site'],
  Magazine:         ['entry:other', 'active-entry:other', 'source:magazine'],
  'Job Signs':      ['entry:other', 'active-entry:other', 'source:job-sign'],
  PrevCust:         ['entry:other', 'active-entry:other', 'source:previous-customer'],
  CustRef:          ['entry:other', 'active-entry:other', 'source:previous-customer'],
  SelfGen:          ['entry:other', 'active-entry:other', 'source:self-generated'],
};
// DELIBERATELY UNMAPPED — these fall to source:unknown because GHL has no
// existing tag that fits, and inventing one would be worse than reporting
// "unknown": Newspaper (88), Mail / Direct Mail (68), Old Source (414),
// Events 2022-2026, Show, 411 Windows, RCI, and NULL lead_source (1,574).
// Add them here only once Mark confirms the tag name.
const LP_BACKSTOP_DEFAULT_TAGS = ['entry:other', 'active-entry:other', 'source:unknown'];

// 2026-07-26 — vendor attribution. Every purchased-media source collapsed to
// `source:internet` / `source:affiliate`, which satisfies the ONE-entry:*
// invariant but destroys per-vendor reporting: Modernize, Porch101, Lead
// Gurus and MyHomePros were indistinguishable once in GHL. The vendor rides
// a THIRD, non-conflicting tag — same shape as `canvass-subtype:door-to-door`
// — so the invariant is untouched and a channel is still one prefix filter.
// Only channels with a real vendor axis appear here. Canvass is excluded (it
// already carries canvass-subtype:*), as are single-vendor channels where the
// detail would just restate the source.
const SOURCE_DETAIL_PREFIX = {
  Internet: 'source:internet-',
  Affiliates: 'source:affiliate-',
  // Iheart/Simpletext share the radio channel, so they share its vendor prefix:
  // lead_source "Iheart" + detail "Simpletext" → source:radio-simpletext.
  Iheart: 'source:radio-',
  Simpletext: 'source:radio-',
  Magazine: 'source:magazine-',
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

/**
 * Intake window with an explicit UPPER bound as well as the lookback.
 *
 * makeIsWithinIntakeWindow is lower-bound only ("entered LP within N hours"),
 * which is right for the forward-only sweep: it should always run up to now.
 * A bounded BACKFILL is the opposite shape — it targets a closed historical
 * window and must not spill past it.
 *
 * Measured 2026-08-29: reaching back to 2026-08-13 needs a ~408h lookback, and
 * an unbounded run at that depth also sweeps 21 unlinked "Data" leads created
 * AFTER 2026-08-19. Some of those are fresh enough that shouldSuppressOutbound
 * would let them through un-suppressed — i.e. a backfill would send a
 * speed-to-lead text it was never scoped to send. Hence the upper bound.
 *
 * Fails CLOSED: an unparseable created_at_lp is outside the window, matching
 * makeIsWithinIntakeWindow and shouldSuppressOutbound ("fail toward silence").
 *
 * @param {number} lookbackHours
 * @param {string|null} untilIso  exclusive upper bound; null = no upper bound
 */
export function makeIntakeWindowGate(lookbackHours, untilIso = null, nowMs = Date.now()) {
  const lower = makeIsWithinIntakeWindow(lookbackHours, nowMs);
  if (!untilIso) return lower;
  const untilMs = Date.parse(untilIso);
  if (!Number.isFinite(untilMs)) throw new Error(`untilIso is not a valid date: ${untilIso}`);
  return (lead) => {
    if (!lower(lead)) return false;
    const t = Date.parse(lead?.created_at_lp);
    return Number.isFinite(t) && t < untilMs;
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
  // Bounds in the stored ET-wall-clock frame; appointment_date holds ET
  // digits tagged +00:00. See src/lp-dates.js.
  const fromIso = utcToLpStoredIso(Date.now() - 24 * 3600 * 1000);
  const toIso = utcToLpStoredIso(Date.now() + (effHorizon + 1) * 24 * 3600 * 1000);

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
  untilIso = null,
} = {}) {
  if (!supabase) throw new Error('Supabase not configured');

  const effLookback = Math.min(Math.max(0, lookbackHours), MAX_INTAKE_LOOKBACK_HOURS);
  // created_at_lp is written through lpDateToEastern() and is in the same
  // stored ET-wall-clock frame, so the SQL bound is built there too.
  //
  // This is BEHAVIOUR-NEUTRAL on its own, and deliberately so. The stored-frame
  // bound is ~4h wider than the true-UTC one it replaces, but makeIntakeWindowGate
  // below still compares Date.parse(created_at_lp) against a true-UTC cutoff and
  // trims the extra rows back out — the JS gate remains the binding constraint
  // and the selected set is unchanged. The bound is corrected anyway so the
  // paging query is not quietly cross-frame for whoever reads it next; moving
  // the JS gate too would widen the intake cohort, which is a routing change
  // and does not belong in a guard fix.
  //
  // untilIso is a caller-supplied admin bound and is deliberately left in
  // whatever frame the caller passes.
  const fromIso = utcToLpStoredIso(Date.now() - effLookback * 3600 * 1000);

  const PAGE = 1000;
  const rows = [];
  let from = 0;
  while (true) {
    let q = supabase
      .from('lp_leads')
      .select('lp_lead_id, ghl_contact_id, disposition_code, appointment_date, created_at_lp, first_name, last_name, phone, lead_source, lead_source_detail, lp_prospect_id')
      .is('ghl_contact_id', null)
      .in('disposition_code', INTAKE_DISPOSITIONS)
      .gte('created_at_lp', fromIso);
    // Pushed into SQL as well as the JS gate so a bounded backfill does not
    // page through tens of thousands of rows it will only discard.
    if (untilIso) q = q.lt('created_at_lp', untilIso);
    const { data, error } = await q
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
    withinWindow: makeIntakeWindowGate(effLookback, untilIso),
  });
  return { ...selected, totalRows: rows.length, lookback_hours: effLookback, until_iso: untilIso };
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
/**
 * Pick the phone-matching contact from a search result.
 *
 * 2026-08-15 — CROSS-CONTAMINATION FIX. The previous fallback
 * `return list[0]?.phone ? null : list[0]` accepted the top fuzzy hit whenever
 * that hit carried no phone in the search projection. GHL's /contacts/?query=
 * projection frequently omits phone, so the guard INVERTED: instead of
 * rejecting an unverified match it accepted an arbitrary one. Every
 * chat-widget "guest visitor" record has no phone, which is why they dominate
 * the contaminated set.
 *
 * Live evidence: LP lead 566250 (Yvonne Laing, 904-487-0668) and LP lead
 * 567020 (Lisa Walsh, 352-812-1262) both carry ghl_contact_id
 * ARLDieKRvguzUoTJqLue. Yvonne's lead was additionally stamped onto five
 * unrelated GHL contacts across Aug 11-13: 3w0U57LXmhLlfgSLfRee,
 * 41SRO1JJR60Qsq7wadfj, 81PpkO2mcAdPve2Ajdlm, gUihunGyOa6SiGbJCJ3K,
 * EJycC69RYzoWYjZyi7JO.
 *
 * There is now NO unverified acceptance path. Returns:
 *   { contact, verified: true }    — last-10 digits matched in the projection
 *   { candidate, verified: false } — a hit exists but carries no phone; the
 *                                    caller MUST confirm via a full GET
 *   null                           — nothing usable
 */
function pickPhoneMatch(contacts, normalizedPhone) {
  const list = Array.isArray(contacts) ? contacts : [];
  if (list.length === 0) return null;
  const want = normalizedPhone.slice(-10);
  const exact = list.find((c) => {
    const cp = normalizePhone(c?.phone);
    return cp && cp.slice(-10) === want;
  });
  if (exact) return { contact: exact, verified: true };
  const candidate = list.find((c) => c?.id && !c?.phone);
  if (candidate) return { candidate, verified: false };
  return null;
}

async function searchByPhone(normalizedPhone) {
  const q = encodeURIComponent(normalizedPhone);
  const res = await ghlFetch('GET', `/contacts/?query=${q}&locationId=${GHL_LOCATION_ID}`);
  const pick = pickPhoneMatch(res?.contacts, normalizedPhone);
  if (!pick) return null;
  if (pick.verified) return pick.contact;

  // Unverified candidate: the search projection carried no phone. Confirm
  // against the full contact record before linking anything. A mismatch OR a
  // read failure returns null — creating a duplicate contact is a recoverable
  // annoyance; stamping one lead's LP identity onto a different person is not.
  const want = normalizedPhone.slice(-10);
  try {
    const full = await ghlFetch('GET', `/contacts/${pick.candidate.id}`);
    const contact = full?.contact || full || {};
    const cp = normalizePhone(contact?.phone);
    if (cp && cp.slice(-10) === want) return contact;
    console.warn(`[LpContactBackstop] REJECTED unverified match ${pick.candidate.id} for ${normalizedPhone} (contact phone: ${contact?.phone || 'none'}) — not linking`);
    return null;
  } catch (err) {
    console.warn(`[LpContactBackstop] verification read failed for ${pick.candidate.id}: ${err.message} — refusing to link`);
    return null;
  }
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
      // The lead's real origin, not the pipe that carried it. lead_source is
      // already in scope (both scans select it) and already drives the
      // source:* tags below — the source FIELD was the only place it was
      // being discarded. Provenance is unaffected: LP_BACKSTOP_ALWAYS_TAGS
      // still applies `lp-backstop-created`, which is what makes a
      // backstop-created contact auditable.
      //
      // 'lp-backstop' remains the fallback ONLY where LP itself has no
      // lead_source (1,574 such unlinked "Data" leads as of 2026-07-26).
      // An honest "we don't know, this came in via the backstop" is better
      // than an invented source.
      source: lead.lead_source || 'lp-backstop',
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
/**
 * Persist per-lead sweep failures (2026-08-23, issue #292).
 *
 * Before this, an errored lead survived only in the in-memory job registry
 * (cleared by any redeploy), in `summary.errors` (dies with the process), and
 * in at most MAX_DETAIL_LEADS lines on one GroupMe card. Nothing was queryable
 * afterwards, so "which leads did the drain fail on?" had no answer — the same
 * blind spot that let #222 hide for a month. The 95,702-lead backlog drain
 * makes that unacceptable: at MAX_DETAIL_LEADS=5 per card, a run that fails
 * hundreds of leads reports five of them and forgets the rest.
 *
 * Reuses lp_sync_errors (sql/016) rather than inventing a table — same shape,
 * same reader (supabase_get_sync_errors, src/tools/admin/supabase-tools.js),
 * same auto-resolve helper. sync_type carries the sweep mode so backstop rows
 * are separable from ingestion rows:
 *   backstop_intake | backstop_appointment
 *
 * Best-effort and never throws: the sweep's work is already committed, and a
 * telemetry write must not take down a drain. Skipped entirely on dry runs —
 * a dry run mutates nothing, including this table.
 */
export async function persistSweepErrors(errors, { sweepMode, dryRun, db = supabase } = {}) {
  if (dryRun || !errors || errors.length === 0) return { persisted: 0 };
  if (!db) return { persisted: 0 };
  try {
    const rows = errors.map((e) => ({
      lp_lead_id: e.lp_lead_id != null ? String(e.lp_lead_id) : null,
      lp_prospect_id: e.lp_prospect_id != null ? String(e.lp_prospect_id) : null,
      error_message: String(e.error || 'unknown_error').slice(0, 2000),
      error_stack: null,
      sync_type: `backstop_${sweepMode}`,
      retry_count: 0,
      resolved: false,
    }));
    const { error } = await db.from('lp_sync_errors').insert(rows);
    if (error) {
      console.warn(`[LpContactBackstop] error persistence failed (${sweepMode}): ${error.message}`);
      return { persisted: 0, persist_error: error.message };
    }
    return { persisted: rows.length };
  } catch (err) {
    console.warn(`[LpContactBackstop] error persistence threw (${sweepMode}): ${err.message}`);
    return { persisted: 0, persist_error: String(err.message || err) };
  }
}

/**
 * `processLead` is injectable so the per-lead error-isolation contract (#292)
 * can be exercised with a lead that genuinely throws, without GHL I/O. The
 * production callers never pass it — they get processOneLead.
 */
export async function executeOverScan(scan, {
  dryRun, suppressOutbound, freshHours, job, processLead = processOneLead,
}) {
  const counts = { linked: 0, created: 0, skipped_no_phone: 0, skipped_dnc: 0, skipped_dup_in_run: 0, error: 0 };
  const lines = [];
  const errors = [];
  const results = [];
  const seenPhones = new Set();
  let suppressedCount = 0;

  // Errored leads never enter `results`, so an all-errors run would otherwise
  // have no source to report on exactly the card where source matters most.
  // Every error entry carries its lead's source for that reason.
  const errEntry = (lead, error) => ({
    lp_lead_id: lead.lp_lead_id,
    // Carried for lp_sync_errors persistence (#292) as well as the card.
    lp_prospect_id: lead.lp_prospect_id || null,
    error,
    lead_source: lead.lead_source || null,
    lead_source_detail: lead.lead_source_detail || null,
  });

  for (const { lead } of scan.targets) {
    try {
      const r = await processLead({ lead, dryRun, seenPhones, contactCache: new Map(), suppressOutbound, freshHours });
      counts[r.outcome] = (counts[r.outcome] || 0) + 1;
      if (r.suppressed) suppressedCount++;
      lines.push(leadLine(r));
      // processOneLead's result carries the lead id and outcome but not the
      // lead's attribution; the notification card needs both.
      results.push({
        ...r,
        lead_source: lead.lead_source || null,
        lead_source_detail: lead.lead_source_detail || null,
        lp_prospect_id: lead.lp_prospect_id || null,
      });
      // A returned outcome:'error' (e.g. no_contact_id_after_create) bumps
      // counts.error above without throwing, so without this the card would
      // report a failure it could not name. Keeps counts.error === errors.length.
      if (r.outcome === 'error') errors.push(errEntry(lead, r.error || 'unknown_error'));
    } catch (err) {
      counts.error++;
      const msg = String(err?.message || err).slice(0, 300);
      errors.push(errEntry(lead, msg));
      lines.push(`error              lead=${String(lead.lp_lead_id).padEnd(8)} → ${msg}`);
    }
    if (job) { job.processed++; job.errors = errors.length; }
  }

  // Report-only rows (no valid phone): counted, never created.
  counts.skipped_no_phone = scan.noPhone.length;
  for (const l of scan.noPhone) {
    lines.push(`skipped_no_phone   lead=${String(l.lp_lead_id).padEnd(8)} ${`${l.first_name || ''} ${l.last_name || ''}`.trim() || '(no name)'} phone=${l.phone || '—'}`);
  }

  return { counts, lines, results, errors, suppressedCount };
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
  const { counts, lines, results, errors } = await executeOverScan(scan, {
    dryRun, suppressOutbound: false, freshHours: Infinity, job,
  });

  // #292: persist before summarising, so error_persistence reflects reality.
  const persistence = await persistSweepErrors(errors, { sweepMode: 'appointment', dryRun });

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
    // #292: explicit count + bounded sample, so a caller reading the job
    // summary sees the failure volume without having to length-check `errors`.
    error_count: errors.length,
    error_rate: scan.targets.length > 0 ? errors.length / scan.targets.length : 0,
    error_sample: errors.slice(0, ERROR_SAMPLE_SIZE),
    error_persistence: persistence,
    errors,
    lines,
  };

  if (job) {
    job.summary = summary;
    job.status = 'completed';
    job.completed_at = new Date().toISOString();
  }

  // Exception-only. A healthy sweep is silent; errors and backlog pressure
  // are not. Never throws — the sweep's work is already committed.
  if (!dryRun) {
    await notifyBackstopRun({
      sweepMode: 'appointment',
      scan,
      counts,
      errors,
      results,
      maxPerRun,
      intervalMin: Math.round(BACKSTOP_INTERVAL_MS / 60000),
    });
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
  untilIso = null,
  job = null,
} = {}) {
  const scan = await scanIntakeBackstopCandidates({ lookbackHours, maxPerRun, limit, untilIso });
  if (job) job.total = scan.targets.length;

  const { counts, lines, results, errors, suppressedCount } = await executeOverScan(scan, {
    dryRun, suppressOutbound, freshHours, job,
  });

  // #292: persist before summarising, so error_persistence reflects reality.
  const persistence = await persistSweepErrors(errors, { sweepMode: 'intake', dryRun });

  const summary = {
    mode: 'intake',
    dry_run: dryRun,
    lookback_hours: scan.lookback_hours,
    until_iso: scan.until_iso ?? null,
    fresh_hours: freshHours,
    suppress_outbound_run: suppressOutbound,
    max_per_run: maxPerRun,
    scanned_rows: scan.totalRows,
    eligible: scan.eligible,
    processed: scan.targets.length,
    deferred_capped: scan.deferredCapped,
    suppressed: suppressedCount,
    counts,
    // #292 — see runLpContactBackstop.
    error_count: errors.length,
    error_rate: scan.targets.length > 0 ? errors.length / scan.targets.length : 0,
    error_sample: errors.slice(0, ERROR_SAMPLE_SIZE),
    error_persistence: persistence,
    errors,
    lines,
  };

  if (job) {
    job.summary = summary;
    job.status = 'completed';
    job.completed_at = new Date().toISOString();
  }

  // Exception-only — see runLpContactBackstop. Per-lead suppression surfaces
  // in the card's detail lines, so it no longer needs its own next-step string.
  if (!dryRun) {
    await notifyBackstopRun({
      sweepMode: 'intake',
      scan,
      counts,
      errors,
      results,
      maxPerRun,
      intervalMin: Math.round(INTAKE_INTERVAL_MS / 60000),
    });
  }

  return summary;
}
