// ─── Lead Processing — src/sync-leads.js ──────────────────────────
//
// Core lead upsert logic: upsertLeadOnly (Pass 1), processProspect
// (incremental/webhook), and upsertLeadFromFlat (flat LP responses).
//
// ALL LP date fields are wrapped with lpDateToEastern() for correct
// timezone storage. created_at_lp uses lpCreatedDate() which prefers
// dateentered (has time) over entrydate (midnight-zeroed).
//
// AGENTIC: Disposition changes emit system events for the Decision Engine.
//
// v10.0 (2026-05-23) — Tag operations now route through the executor's
//   tag handlers (src/actions/handlers/tags.js) instead of the raw GHL
//   helpers in ./ghl.js. The handler functions enforce:
//
//     - entry:* IMMUTABILITY (first-touch attribution wins; later
//       adds become no-ops if the namespace is populated)
//     - active-entry:* EXCLUSIVITY (auto-removes conflicting tags in
//       the same namespace before adding the new one)
//     - source:* and other namespace policies
//
//   Why this matters: prior to v10.0, processProspect called applyGHLTag()
//   and removeGHLTags() directly, bypassing the namespace guards. This
//   meant LP sync could:
//
//     (a) Overwrite a contact's entry:* tag with whatever the current LP
//         source resolved to — the agentic system's hygiene rules
//         (e.g. ENTRY_HYGIENE_AT_CREATION_INTERNET) might correctly set
//         active-entry:other at contact creation, but the next LP sync
//         would happily clobber it with whatever resolveSourceBucket()
//         returned for the lead. (Mitigated cosmetically by ac00820
//         fixing the source mapping, but the bypass remained.)
//     (b) Set the active-entry:* tag via a manual pre-remove-all-then-add
//         pattern that duplicated the namespace-exclusivity logic in
//         tags.js — fine in isolation but a source-of-truth split.
//
//   v10.0 routes both flows through executeAddTag/executeRemoveTag so
//   the same namespace policies apply regardless of caller. The manual
//   ALL_ACTIVE_ENTRY_TAGS pre-removal list is REMOVED — the executor's
//   NAMESPACE_EXCLUSIVE_PREFIXES guard handles it automatically.
//
//   Errors are caught + logged; LP sync never fails on tag operation
//   errors (preserves prior best-effort semantics).
//
//   Related: Rochelle Giron VQF4Qlb77XmNpjjCtZan; PR #306; commit ac00820.
//
// v10.1 (2026-06-02) — ghl_contact_id link no longer lost.
//   buildLeadRow now coalesces deriveLeadGhlId() with the existing
//   stored ghl_contact_id, and all three writers (upsertLeadOnly,
//   processProspect, upsertLeadFromFlat) omit the column from the
//   upsert payload when it would be null so a Pass 1 / FORCE_FULL_SYNC
//   never clobbers a link established by the incremental phone/email
//   match. Root cause of resolver Steps 0a/0b being dark for ~98% of
//   lp_leads rows (the appointment-sync false-failure on field-set
//   leads, 2026-06-02).
//
// v10.2 (2026-06-29) — null-source attribution backstop.
//   Some vendor intakes (notably the "Internet, Socius Marketing" and
//   "Internet, Lead Gurus" paid feeds) land in LP with empty source /
//   sourcesubdescr but a populated `promotername` of the form
//   "Channel, Vendor". That left ~30 leads/mo with null source —
//   invisible to revenue attribution and routed to entry:other. The
//   three writers now resolve an EFFECTIVE source via effectiveLeadSource():
//   native source/sourcesubdescr win; when BOTH are blank we recover the
//   attribution from the promoter, scoped to the `internet` channel so
//   rep-entered promoters ("Singer, Jack - ORL", "Richard, Mark") are
//   never mistaken for a source. The derived pair flows into both the
//   persisted columns and resolveSourceBucket(), so bucket/tag stay
//   consistent with the stamped source. entry:* immutability still
//   protects first-touch attribution on already-linked contacts.
//
// v9.3 — Disposition-changed event now emits with the lognumber-
//   preferred GHL contact ID (`newLeadGhlId`) instead of the bare
//   `ghlId` from prospect-level matchToGHL.
//
// v9.2 — `lp_leads.ghl_contact_id` is now ID-DERIVED when possible
//   (from LP `lognumber` field when shape-valid 20-char alphanumeric).
//
// v9.1 — Email enrichment idempotency check via email_enrichment_log.
// v8.0 — active-entry:* tag management (superseded by v10.0).
// v7.1 — Real-time note push after disposition change.
// v7.0 — DISK I/O OPTIMIZATION: Conditional upserts.

import supabase from './supabase.js';
import { getField, normalizePhone, loggedFirstKeys } from './sync-utils.js';
import { logSyncError } from './sync-log.js';
import { resolveSourceBucket } from './sync-sources.js';
import { lpDateToEastern, lpCreatedDate } from './lp-dates.js';
import { matchToGHL } from './ghl.js';
import { executeAddTag, executeRemoveTag } from './actions/handlers/tags.js';
import { upsertProspect } from './upsert-prospect.js';
import { combineNotes } from './safe-notes.js';
import { syncCallLogs, syncNotes, syncActivities, syncJobAndMilestones } from './sync-children.js';
import { emitEvent, dispositionPriority } from './event-emitter.js';
import { pushLeadNotesImmediately } from './ghl-notes-sync.js';
import { GHL_CONTACT_ID_PATTERN, lognumberCandidate } from './ghl-link-shape.js';
import { resolveLeadGhlLink } from './services/link-corroboration.js';
import { shouldRenewConsent } from './services/consent-renewal.js';

// ─── Skip counter for observability ──────────────────────────────
let _skipStats = { leads: 0, prospects: 0 };
export function getSkipStats() { const s = { ..._skipStats }; _skipStats = { leads: 0, prospects: 0 }; return s; }

// ─── Disposition baseline (inbound pre-dispositioned backfill) ───
//
// "Data" is the raw-lead baseline (see sync-dispositions.js
// KNOWN_DISPOSITION_LABELS). A lead carrying anything past this set has
// already been worked by the call center — for LP-inbound leads that means
// it arrived ALREADY dispositioned (Set/Cnf/OPPFDN), having been booked
// before GHL contact creation. The normal `dispositionChanged` emit covers
// genuine state transitions, but a lead whose row first appears already at a
// past-Data disposition (direct backfill, flat upsert, or re-synced unchanged
// after a missed advance) never produces an `lp.disposition_changed` event,
// so the LP_DISP_* rule family never sees it. emitInboundBackfill() closes
// that gap. Null/'' are treated as baseline (nothing to route on).
const BASELINE_DISPOSITIONS = new Set(['Data']);
function isPastData(code) {
  const c = (code == null ? '' : String(code)).trim();
  return c !== '' && !BASELINE_DISPOSITIONS.has(c);
}

// Emit a one-time synthetic lp.disposition_changed for a lead already carrying
// a past-Data disposition with no transition event of its own. Shared by the
// processProspect loop and the flat-upsert path so there is a single emit
// implementation. No-op for baseline/null dispositions; the non-dated
// idempotency key dedups to exactly one emit per (lead, disposition).
async function emitDispositionBackfill({
  lpLeadId, lpProspectId, ghlContactId,
  disposition, previousDisposition = null, leadName = null, leadSource = null,
}) {
  if (!isPastData(disposition)) return;
  await emitEvent({
    event_type: 'lp.disposition_changed',
    event_subtype: disposition,
    source: 'inbound-backfill',
    entity_type: 'lead',
    entity_id: lpLeadId,
    ghl_contact_id: ghlContactId || null,
    lp_lead_id: lpLeadId,
    lp_prospect_id: lpProspectId || null,
    payload: {
      disposition_code: disposition,
      previous_disposition: previousDisposition,
      lead_name: leadName,
      lead_source: leadSource,
      synthetic: true,
      reason: 'inbound_pre_dispositioned',
    },
    previous_state: previousDisposition ? { disposition_code: previousDisposition } : { disposition_code: 'Data' },
    new_state: { disposition_code: disposition },
    priority: dispositionPriority(disposition),
    idempotency_key: `disp_${lpLeadId}_backfill_${disposition}`,
  });
}

// ─── Consent renewal on re-entry (Phase 2, 2026-07-24) ───────────────
//
// A DNC disposition normally emits lp.disposition_changed:DNC, which drives
// LP_DISP_DNC + RECONCILE and suppresses the contact. But when a NEW consumer-
// initiated inbound (estimator form / chatbot) lands on a prospect who was DNC
// from PRIOR history, that inbound is a fresh, express-consent inquiry — the
// lead is "born DNC" only because it inherited the prospect's old flag (ref
// incident: Max Lesser, LP lead 561019 / prospect 447640, suppressed before
// the opener landed).
//
// The decision predicate lives in services/consent-renewal.js (pure, unit-
// tested). When it fires we emit consent.reestablished USING the DNC backfill
// idempotency key (`disp_<lead>_backfill_DNC`). Reusing that key BURNS it, so
// every later backfill re-read of this lead dedup-skips its own DNC emit
// (emitEvent dedups on idempotency_key regardless of event_type) — the DNC
// event never fires for a renewed lead, on this pass or any future one.

// Emit the audited consent.reestablished event. Keyed on the DNC backfill
// idempotency key so it also suppresses every future DNC emit for this lead.
// bypass_filter: the audit trail must ALWAYS land, even before the paired
// CONSENT_RENEWAL_ON_REENTRY rule is seeded (its only consumer).
async function emitConsentReestablished({
  lpLeadId, lpProspectId, ghlContactId, bucket, leadSource, leadName,
}) {
  return emitEvent({
    event_type: 'consent.reestablished',
    event_subtype: bucket || 'new_inbound_inquiry',
    source: 'inbound-backfill',
    entity_type: 'lead',
    entity_id: lpLeadId,
    ghl_contact_id: ghlContactId || null,
    lp_lead_id: lpLeadId,
    lp_prospect_id: lpProspectId || null,
    payload: {
      reason: 'new_inbound_inquiry',
      lead_source: leadSource || null,
      lead_name: leadName || null,
      source_bucket: bucket || null,
      lp_lead_id: lpLeadId,
      prospect_id: lpProspectId || null,
      previous_disposition: 'DNC',
      synthetic: true,
    },
    previous_state: { disposition_code: 'DNC' },
    new_state: { consent: 'reestablished' },
    priority: 'high',
    idempotency_key: `disp_${lpLeadId}_backfill_DNC`,
    bypass_filter: true,
  });
}

// ─── v10.0: Tag operation helpers ────────────────────────────────
//
// Thin wrappers that adapt sync-leads' call sites to the executor's
// action-shaped tag handlers. Both swallow errors with a warn log —
// LP sync never fails on tag mutation errors (preserves prior
// best-effort semantics of applyGHLTag/removeGHLTags).
//
// Return value mirrors the old applyGHLTag boolean contract: true
// if the operation completed (including handler-side no-ops like
// "immutable namespace already populated"), false on hard error.
//
// The contract change vs applyGHLTag is subtle but important: a
// "true" return now means "the desired post-state is in effect"
// rather than "we successfully POSTed to GHL." For entry:*, that
// includes the immutability no-op case where the contact already
// had a different entry:* tag — the sync caller still marks
// ghl_tag_applied=true to suppress further attempts.
async function applyTagViaExecutor(contactId, tag) {
  try {
    await executeAddTag({
      target_id: contactId,
      action_payload: { tag },
    });
    return true;
  } catch (err) {
    console.warn(`[Sync] applyTagViaExecutor(${contactId}, ${tag}) failed: ${err.message}`);
    return false;
  }
}

async function removeTagsViaExecutor(contactId, tags) {
  if (!tags || tags.length === 0) return true;
  try {
    await executeRemoveTag({
      target_id: contactId,
      action_payload: { tags },
    });
    return true;
  } catch (err) {
    console.warn(`[Sync] removeTagsViaExecutor(${contactId}, ${tags.length} tags) failed: ${err.message}`);
    return false;
  }
}

// Convert entry:X tag to active-entry:X
function toActiveEntryTag(entryTag) {
  if (!entryTag || !entryTag.startsWith('entry:')) return 'active-entry:other';
  return entryTag.replace('entry:', 'active-entry:');
}

// ─── v9.2: GHL contact ID derivation from LP lognumber ───────────
//
// Shape primitives now live in ghl-link-shape.js (shared with the resolver).

/**
 * @deprecated Shape-check-only adoption of lognumber as a GHL link — the
 * mechanism behind the lead-560362 mis-binding. Use resolveLeadGhlLink()
 * (services/link-corroboration.js), which corroborates the candidate against
 * GHL contact identity before binding. Retained solely as the legacy
 * derivation primitive the resolver reproduces in observe mode.
 */
function deriveLeadGhlId(lead, fallbackGhlId) {
  return lognumberCandidate(lead) || fallbackGhlId || null;
}

// ─── v10.2: Source attribution backstop (derive from LP promoter) ─
//
// Channels whose promoter first segment is a real LP "source" (parent
// channel) rather than a salesperson surname. Scoped deliberately tight:
// the active null-source leak is the "Internet, <Vendor>" paid feeds
// (Socius Marketing, Lead Gurus). Rep-entered promoters are
// "Surname, First - OFFICE" — their first segment is a surname, never in
// this set, so they are left untouched. Extend this set only when a new
// channel-prefixed vendor feed is confirmed to arrive source-less.
const PROMOTER_SOURCE_CHANNELS = new Set(['internet']);

// Parse a promoter of the form "Channel, Vendor" into { source, sourcesubdescr }
// when Channel is a recognized source channel. Returns null otherwise (no
// comma, blank halves, or a non-source first segment like a rep surname).
// "Internet, Socius Marketing" → { source: 'Internet', sourcesubdescr: 'Socius Marketing' }
function deriveSourceFromPromoter(promoterName) {
  if (!promoterName) return null;
  const s = String(promoterName);
  const idx = s.indexOf(',');
  if (idx < 0) return null;
  const channel = s.slice(0, idx).trim();
  const vendor = s.slice(idx + 1).trim();
  if (!channel || !vendor) return null;
  if (!PROMOTER_SOURCE_CHANNELS.has(channel.toLowerCase())) return null;
  return { source: channel, sourcesubdescr: vendor };
}

// Effective LP source for a lead: the native source / sourcesubdescr when
// either is present; otherwise the promoter-derived attribution backstop.
// Both consumers — the persisted lp_leads columns and resolveSourceBucket() —
// read through this so a derived pair stamps the columns AND routes the bucket
// consistently. Returns { source, sourcesubdescr, derivedFromPromoter }.
function effectiveLeadSource(lead) {
  const source = getField(lead, 'source', 'Source');
  const sourcesubdescr = getField(lead, 'sourcesubdescr', 'SourceSubDescr');
  if (source || sourcesubdescr) {
    return { source: source || null, sourcesubdescr: sourcesubdescr || null, derivedFromPromoter: false };
  }
  const derived = deriveSourceFromPromoter(getField(lead, 'promotername', 'PromoterName'));
  if (derived) return { ...derived, derivedFromPromoter: true };
  return { source: source || null, sourcesubdescr: sourcesubdescr || null, derivedFromPromoter: false };
}

// TEST SEAM — pure source-attribution helpers exposed for unit tests
// (mirrors the `_internal` export convention used in entry-source-map.js).
export const _internal = {
  deriveSourceFromPromoter, effectiveLeadSource, PROMOTER_SOURCE_CHANNELS,
  lpBool, needsAttributionBackfill,
};

// ─── LP string-boolean coercion ──────────────────────────────────
//
// LP sends booleans as the strings "true"/"false". Returns undefined for an
// absent field so the key drops at serialization and a previously-stored
// value survives — the same contract as the appointment_confirmed mapping in
// buildLeadRow(). Never coerces an unpopulated field to false: that would
// assert an appointment was never confirmed when LP simply didn't send it.
//
// getField() already collapses '' to null, so the '' arm is belt-and-braces
// for callers reading the raw payload directly.
function lpBool(v) {
  if (v === undefined || v === null || v === '') return undefined;
  return v === 'true' || v === true;
}

// ─── Attribution backfill-on-skip (sql/049) ──────────────────────
//
// Both writers skip the upsert when lastchangedon is unchanged and the funnel
// flags match. LP will never bump lastchangedon just because WE added columns,
// so without this escape a row synced before 049 looks "unchanged" forever and
// the attribution columns stay NULL through a full re-sync — exactly the
// failure mode that forced the lp_branch_id backfill-on-skip below (observed
// live: 20/105 of a day's leads had branch after hours of refreshes).
//
// Fires at most once per row: goes quiet as soon as the columns are populated.
function needsAttributionBackfill(existing, lead) {
  if (!existing) return false;
  if (existing.set_by_name != null && existing.ever_confirmed != null) return false;
  return getField(lead, 'setbyname', 'SetByName') != null
    || getField(lead, 'everconfirmed', 'EverConfirmed') != null;
}

// ─── Build the lead row payload (DRY helper) ─────────────────────
//
// resolvedLink ({ ghlContactId, linkSource } from resolveLeadGhlLink) is
// authoritative when provided; linkSource null means "leave the stored
// ghl_link_source untouched" (the key is omitted so upsert-on-conflict
// preserves it). Without resolvedLink the legacy v10.1 derivation applies
// and no ghl_link_source key is emitted.
function buildLeadRow(prospect, lead, {
  lpLeadId, lpProspectId, bucket, tag, ghlId = null, existingGhlId = null, resolvedLink = null,
}) {
  // v10.1: never lose a previously-established link — fall back to the
  // existing ghl_contact_id when neither lognumber nor the phone/email
  // match (ghlId) resolves one this run.
  const leadGhlId = resolvedLink
    ? (resolvedLink.ghlContactId || existingGhlId || null)
    : (deriveLeadGhlId(lead, ghlId) || existingGhlId || null);

  // v10.2: stamp the effective source (native, else promoter-derived) so the
  // "Internet, <Vendor>" feeds stop persisting null source/sourcesubdescr.
  const eff = effectiveLeadSource(lead);

  const apptSet = getField(lead, 'apptset', 'ApptSet');
  const sat = getField(lead, 'sat', 'Sat');
  const sold = getField(lead, 'sold', 'Sold');
  const isApptSet = apptSet === 'true' || apptSet === true;
  const isDemoCompleted = sat === 'true' || sat === true;
  const isClosedWon = sold === 'true' || sold === true;

  // Capacity board: GetLead rows carry explicit confirmed/verified booleans —
  // preferred over disposition-code interpretation for the Confirmed count.
  // Only stamped when LP actually sent the field: an absent field must not
  // flip a previously-true value back to false on an unrelated re-sync.
  const confirmedRaw = getField(lead, 'confirmed', 'Confirmed');
  const verifiedRaw  = getField(lead, 'verified', 'Verified');

  // LP's own branch attribution for the LEAD (verified live 2026-07-22:
  // lead-level `brn_id`, e.g. "SAR"). This is what LP's screens group by —
  // market resolution prefers it over the customer ZIP. TRIM (LP pads with
  // trailing spaces); absent never overwrites.
  const brnRaw = getField(lead, 'brn_id', 'BrnId', 'BrnID');
  const lpBranchId = brnRaw == null ? undefined : (String(brnRaw).trim().toUpperCase() || undefined);

  return {
    row: {
      lp_lead_id:         lpLeadId,
      lp_prospect_id:     lpProspectId,
      ghl_contact_id:     leadGhlId,
      // Omitted (undefined) unless the resolver classified the link this
      // run — upsert-on-conflict then preserves the stored value.
      ghl_link_source:    resolvedLink?.linkSource || undefined,
      first_name:         getField(prospect, 'firstname', 'FirstName', 'first_name'),
      last_name:          getField(prospect, 'lastname', 'LastName', 'last_name'),
      email:              getField(prospect, 'email', 'Email'),
      phone:              normalizePhone(getField(prospect, 'phone1', 'Phone1', 'phone')),
      phone_alt:          normalizePhone(prospect.altphones?.[0]?.phone || getField(prospect, 'Phone2', 'phone2')),
      address:            getField(prospect, 'address1', 'Address1'),
      city:               getField(prospect, 'city', 'City'),
      state:              getField(prospect, 'state', 'State'),
      zip:                getField(prospect, 'zip', 'Zip'),
      lead_source:        eff.source,
      lead_source_detail: eff.sourcesubdescr,
      promoter_name:      getField(lead, 'promotername', 'PromoterName'),
      lp_branch_id:       lpBranchId,
      ghl_intent_bucket:  bucket,
      ghl_entry_tag:      tag,
      disposition_code:   getField(lead, 'disposition', 'Disposition'),
      rep_name:           getField(lead, 'salesrepname', 'SalesRepName'),
      appointment_set:    isApptSet,
      // undefined values are dropped at serialization, so an absent LP field
      // leaves the stored boolean untouched instead of overwriting it.
      appointment_confirmed: (confirmedRaw === undefined || confirmedRaw === null)
        ? undefined : (confirmedRaw === 'true' || confirmedRaw === true),
      appointment_verified:  (verifiedRaw === undefined || verifiedRaw === null)
        ? undefined : (verifiedRaw === 'true' || verifiedRaw === true),

      // ─── LP attribution (sql/049, added 2026-07-27) ──────────────────
      // LP supplies these on every lead payload; we had never mapped them.
      // Names arrive "Last, First" — stored verbatim, normalised at read
      // time (any write-time split is lossy for hyphenated/multi-part names).
      // Dates go through lpDateToEastern() like every other LP date: LP sends
      // bare UTC strings and that helper tags them +00:00 (see lp-dates.js).
      set_by_name:       getField(lead, 'setbyname', 'SetByName') || undefined,
      confirmed_by_name: getField(lead, 'confirmedbyname', 'ConfirmedByName') || undefined,
      verified_by_name:  getField(lead, 'verifiedbyname', 'VerifiedByName') || undefined,
      set_date:          lpDateToEastern(getField(lead, 'setdate', 'SetDate')) || undefined,
      confirmed_date:    lpDateToEastern(getField(lead, 'confirmeddate', 'ConfirmedDate')) || undefined,

      // ─── LP latching outcome flags ───────────────────────────────────
      // These SURVIVE cancellation, unlike appointment_confirmed — LP clears
      // confirmed=false when an appointment cancels, which is why no CXL row
      // carries it. Use these for any historical question; use
      // appointment_confirmed for current state (the capacity board).
      ever_set:        lpBool(getField(lead, 'everset', 'EverSet')),
      ever_confirmed:  lpBool(getField(lead, 'everconfirmed', 'EverConfirmed')),
      ever_sat:        lpBool(getField(lead, 'eversat', 'EverSat')),
      ever_issued:     lpBool(getField(lead, 'everissued', 'EverIssued')),
      ever_net_issued: lpBool(getField(lead, 'evernetissued', 'EverNetIssued')),

      appointment_date:   lpDateToEastern(getField(lead, 'apptdate', 'ApptDate')),
      demo_completed:     isDemoCompleted,
      demo_date:          isDemoCompleted ? lpDateToEastern(getField(lead, 'apptdate', 'ApptDate')) : null,
      closed_won:         isClosedWon,
      job_value:          parseFloat(getField(lead, 'gsa', 'GSA', 'grossamount', 'GrossAmount') || 0) || null,
      created_at_lp:      lpCreatedDate(prospect, lead, getField),
      updated_at_lp:      lpDateToEastern(getField(lead, 'lastchangedon', 'LastChangedOn')),
      synced_at:          new Date().toISOString(),
    },
    isApptSet,
    isDemoCompleted,
    isClosedWon,
    leadGhlId,
  };
}

// ─── Pass 1 Helper — upsertLeadOnly() ────────────────────────────
// Used during fullSync Pass 1. Does NOT emit events or manage tags.

export async function upsertLeadOnly(prospect) {
  const leads = getField(prospect, 'leads', 'Leads') || [];
  await upsertProspect(prospect, { leads });

  if (leads.length === 0) {
    await upsertLeadFromFlat(prospect, null);
    return 1;
  }

  let count = 0;
  for (const lead of leads) {
    const lpLeadId = String(getField(lead, 'id', 'lds_id', 'LeadID'));
    const lpProspectId = String(getField(prospect, 'cst_id', 'CstID', 'prospectid', 'ProspectID'));

    const newUpdatedAt = lpDateToEastern(getField(lead, 'lastchangedon', 'LastChangedOn'));
    // v10.1: always read existing so we can (a) decide skip and (b) carry
    // the existing ghl_contact_id into buildLeadRow. maybeSingle() returns
    // null cleanly for brand-new leads instead of erroring.
    const { data: existing } = await supabase.from('lp_leads')
      .select('updated_at_lp, ghl_contact_id, ghl_link_source, demo_completed, appointment_set, closed_won, appointment_confirmed, appointment_verified, lp_branch_id, set_by_name, ever_confirmed')
      .eq('lp_lead_id', lpLeadId).maybeSingle();

    // Corroborated link resolution (no matchToGHL in Pass 1, so verifiedGhlId
    // is null — this path can only ever produce lognumber_verified /
    // rejected_* / existing_preserved). In observe mode the returned id is
    // the legacy derivation, so Pass 1 behavior is unchanged.
    const resolved = await resolveLeadGhlLink({
      lead,
      prospect,
      verifiedGhlId: null,
      existingGhlId: existing?.ghl_contact_id || null,
      existingLinkSource: existing?.ghl_link_source || null,
    }, { lpLeadId, lpProspectId });

    // Funnel-flag staleness guard (mirrors processProspect): a Sat/ApptSet/Sold
    // flip that doesn't bump LastChangedOn must still force the upsert, or even
    // a full re-sync (Pass 1) leaves demo_completed/appointment_set/closed_won stale.
    // Confirmed/Verified join the guard (capacity board) — compared only when LP
    // actually sent the field, since an absent field never overwrites.
    const apptSetIn = getField(lead, 'apptset', 'ApptSet');
    const satIn     = getField(lead, 'sat', 'Sat');
    const soldIn    = getField(lead, 'sold', 'Sold');
    const confIn    = getField(lead, 'confirmed', 'Confirmed');
    const verifIn   = getField(lead, 'verified', 'Verified');
    const isApptSetIn = apptSetIn === 'true' || apptSetIn === true;
    const isDemoIn    = satIn === 'true' || satIn === true;
    const isSoldIn    = soldIn === 'true' || soldIn === true;
    const flagsUnchanged = existing
      && existing.appointment_set === isApptSetIn
      && existing.demo_completed  === isDemoIn
      && existing.closed_won      === isSoldIn
      && (confIn == null  || existing.appointment_confirmed === (confIn === 'true' || confIn === true))
      && (verifIn == null || existing.appointment_verified  === (verifIn === 'true' || verifIn === true));

    if (newUpdatedAt && existing?.updated_at_lp && existing.updated_at_lp === newUpdatedAt && flagsUnchanged) {
      const needsGhlIdBackfill = !existing.ghl_contact_id && resolved.ghlContactId;
      // Branch backfill-on-skip (fix-pass 2): a row synced before lp_branch_id
      // existed looks "unchanged" forever (LP won't bump lastchangedon just
      // because WE added a column), so without this the branch never lands —
      // observed live: 20/105 of tomorrow's leads had branch after hours of
      // refreshes. Force the upsert whenever LP provides a branch we lack.
      const needsBranchBackfill = !existing.lp_branch_id
        && String(getField(lead, 'brn_id', 'BrnId', 'BrnID') || '').trim() !== '';
      // Same failure mode for the 049 attribution columns.
      const needsAttrBackfill = needsAttributionBackfill(existing, lead);
      if (!needsGhlIdBackfill && !needsBranchBackfill && !needsAttrBackfill) {
        // Skip path never upserts, so persist a fresh classification here or
        // stable rows would stay unclassified through the observe soak.
        // One-time per row: the resolver's fast path returns null once the
        // stored source matches.
        if (resolved.linkSource && resolved.linkSource !== existing.ghl_link_source) {
          await supabase.from('lp_leads')
            .update({ ghl_link_source: resolved.linkSource })
            .eq('lp_lead_id', lpLeadId);
        }
        _skipStats.leads++;
        count++;
        continue;
      }
    }

    // v10.2: resolve bucket/tag from the effective source (native, else
    // promoter-derived) so derived-source leads route by their real channel.
    const effSrc = effectiveLeadSource(lead);
    const { bucket, tag } = await resolveSourceBucket(
      effSrc.sourcesubdescr, effSrc.source, lpLeadId,
    );

    const { row } = buildLeadRow(prospect, lead, {
      lpLeadId, lpProspectId, bucket, tag,
      existingGhlId: existing?.ghl_contact_id || null,
      resolvedLink: resolved,
    });

    // v10.1: never overwrite an existing ghl_contact_id link with null.
    // Omitting the column from the upsert payload preserves the stored
    // value on conflict (Pass 1 / FORCE_FULL_SYNC must not wipe links).
    if (row.ghl_contact_id == null) delete row.ghl_contact_id;

    const { error: upsertErr } = await supabase.from('lp_leads').upsert(row, { onConflict: 'lp_lead_id' });
    if (upsertErr) throw new Error(`Lead upsert failed for ${lpLeadId}: ${upsertErr.message}`);
    count++;
  }
  return count;
}

// ─── Per-Prospect Processing — processProspect() ─────────────────
//
// AGENTIC: Detects disposition changes and emits system events.
// v8.0: Manages active-entry:* tag based on newest LP lead source.
// v10.0: Tag operations route through executor handlers (immutability +
//        exclusivity enforced; manual stale-tag list removed).

export async function processProspect(prospect, { skipGHL = false } = {}) {
  if (!loggedFirstKeys.has('prospect')) {
    loggedFirstKeys.add('prospect');
    console.log('[Sync] Prospect record keys:', Object.keys(prospect).join(', '));
  }

  let ghlId = null;
  if (!skipGHL) {
    try {
      ghlId = await matchToGHL({
        phone: normalizePhone(getField(prospect, 'phone1', 'Phone1', 'phone', 'Phone')),
        phone_alt: normalizePhone(prospect.altphones?.[0]?.phone || getField(prospect, 'Phone2', 'phone2', 'phone_alt')),
        email: getField(prospect, 'email', 'Email'),
      });
    } catch (err) {
      console.warn(`[Sync] GHL match failed for prospect ${prospect.cst_id}:`, err.message);
    }
  }

  const allLeads = getField(prospect, 'leads', 'Leads') || [];
  await upsertProspect(prospect, { ghlContactId: ghlId, leads: allLeads });

  const leads = allLeads;
  if (leads.length === 0) {
    await upsertLeadFromFlat(prospect, ghlId);
    return { calls: 0, notes: 0, jobs: 0, milestones: 0 };
  }

  if (!loggedFirstKeys.has('lead') && leads.length > 0) {
    loggedFirstKeys.add('lead');
    console.log('[Sync] Lead record keys:', Object.keys(leads[0]).join(', '));
  }

  let subCounts = { calls: 0, notes: 0, jobs: 0, milestones: 0 };

  // ─── v8.0: Track each lead's tag + creation date for active-entry resolution ──
  const leadSourceTracker = [];

  for (const lead of leads) {
    const lpLeadId = String(getField(lead, 'id', 'lds_id', 'LeadID'));
    // v10.2: resolve bucket/tag from the effective source (native, else
    // promoter-derived) so derived-source leads route by their real channel.
    const effSrc = effectiveLeadSource(lead);
    const { bucket, tag } = await resolveSourceBucket(
      effSrc.sourcesubdescr, effSrc.source, lpLeadId,
    );
    const lpProspectId = String(getField(prospect, 'cst_id', 'CstID', 'prospectid', 'ProspectID'));

    // Track for active-entry:* resolution after the loop
    const createdAt = lpCreatedDate(prospect, lead, getField);
    leadSourceTracker.push({ lpLeadId, tag, createdAt });

    // ─── AGENTIC: Read existing state BEFORE upsert ──────────────
    const { data: existing } = await supabase.from('lp_leads')
      .select('ghl_tag_applied, lp_day15_triggered, disposition_code, ghl_contact_id, ghl_link_source, updated_at_lp, demo_completed, appointment_set, closed_won, appointment_confirmed, appointment_verified, lp_branch_id, set_by_name, ever_confirmed')
      .eq('lp_lead_id', lpLeadId).single();

    const previousDisposition = existing?.disposition_code || null;
    const newDisposition = getField(lead, 'disposition', 'Disposition') || null;
    const newUpdatedAt = lpDateToEastern(getField(lead, 'lastchangedon', 'LastChangedOn'));
    const dispositionChanged = newDisposition && newDisposition !== previousDisposition;

    // Corroborated link resolution — runs before the unchanged-guard below
    // (the guard compares the resolved id against the stored link; an
    // unchanged candidate takes the resolver's zero-query fast path, so a
    // stable re-sync never triggers verification).
    const resolved = await resolveLeadGhlLink({
      lead,
      prospect,
      verifiedGhlId: ghlId,
      existingGhlId: existing?.ghl_contact_id || null,
      existingLinkSource: existing?.ghl_link_source || null,
    }, { lpLeadId, lpProspectId });
    const newLeadGhlId = resolved.ghlContactId;

    // Child records (call logs / notes / jobs) must carry the SAME contact id
    // as the lead row. Pre-resolver they got the raw matchToGHL result while
    // the row got the lognumber derivation — the direct mechanism behind one
    // lead's call rows pointing at multiple unrelated contacts.
    const childGhlId = newLeadGhlId || existing?.ghl_contact_id || null;

    // ─── AGENTIC: synthetic disposition backfill for pre-dispositioned leads ─
    //
    // Fires only when the natural `dispositionChanged` emit will NOT (the lead
    // is sitting at a past-Data disposition that produced no transition this
    // pass). One-time per (lead, disposition): the idempotency key omits the
    // date so a stable booked lead emits exactly once, not daily. This is the
    // reliability backstop for LP-inbound leads booked before GHL creation —
    // it guarantees the LP_DISP_* family sees a disposition event even when the
    // contact was already entry-routed to E.5/S2.2. source:'inbound-backfill'
    // keeps these distinguishable from real LP-webhook transitions.
    const emitInboundBackfill = () => emitDispositionBackfill({
      lpLeadId,
      lpProspectId,
      ghlContactId: newLeadGhlId || existing?.ghl_contact_id || null,
      disposition: newDisposition,
      previousDisposition,
      leadName: `${getField(prospect, 'firstname', 'FirstName') || ''} ${getField(prospect, 'lastname', 'LastName') || ''}`.trim(),
      leadSource: getField(lead, 'source', 'Source') || null,
    });

    // ─── Funnel-flag staleness guard ────────────────────────────
    // A Sat/ApptSet/Sold flip on the LP side does not always bump
    // LastChangedOn or advance the disposition, so an updated_at_lp +
    // ghl_contact_id match alone is not enough to call the row unchanged.
    // Derive the incoming flags exactly as buildLeadRow does and force the
    // upsert whenever the cached funnel state disagrees — otherwise
    // demo_completed/appointment_set/closed_won rot silently.
    const apptSetIn = getField(lead, 'apptset', 'ApptSet');
    const satIn     = getField(lead, 'sat', 'Sat');
    const soldIn    = getField(lead, 'sold', 'Sold');
    const confIn    = getField(lead, 'confirmed', 'Confirmed');
    const verifIn   = getField(lead, 'verified', 'Verified');
    const isApptSetIn = apptSetIn === 'true' || apptSetIn === true;
    const isDemoIn    = satIn === 'true' || satIn === true;
    const isSoldIn    = soldIn === 'true' || soldIn === true;
    // Confirmed/Verified join the guard (capacity board) — compared only when
    // LP actually sent the field, since an absent field never overwrites.
    const flagsUnchanged = existing
      && existing.appointment_set === isApptSetIn
      && existing.demo_completed  === isDemoIn
      && existing.closed_won      === isSoldIn
      && (confIn == null  || existing.appointment_confirmed === (confIn === 'true' || confIn === true))
      && (verifIn == null || existing.appointment_verified  === (verifIn === 'true' || verifIn === true));

    // Branch backfill-on-skip (fix-pass 2): a row synced before lp_branch_id
    // existed looks "unchanged" forever (LP won't bump lastchangedon because
    // WE added a column) — observed live: 20/105 of tomorrow's leads had
    // branch after hours of refreshes. LP providing a branch we lack forces
    // the write.
    const needsBranchBackfill = !existing?.lp_branch_id
      && String(getField(lead, 'brn_id', 'BrnId', 'BrnID') || '').trim() !== '';

    // Same failure mode for the 049 attribution columns.
    const needsAttrBackfill = needsAttributionBackfill(existing, lead);

    const recordUnchanged = existing?.updated_at_lp
      && newUpdatedAt
      && existing.updated_at_lp === newUpdatedAt
      && (existing.ghl_contact_id === newLeadGhlId || (!newLeadGhlId && existing.ghl_contact_id))
      && flagsUnchanged
      && !needsBranchBackfill
      && !needsAttrBackfill;

    if (recordUnchanged && !dispositionChanged) {
      // Persist a fresh classification on the skip path (no upsert runs
      // here) — one-time per row via the resolver fast path.
      if (resolved.linkSource && resolved.linkSource !== existing?.ghl_link_source) {
        await supabase.from('lp_leads')
          .update({ ghl_link_source: resolved.linkSource })
          .eq('lp_lead_id', lpLeadId);
      }
      _skipStats.leads++;
      // Reliability backstop: a stable lead sitting at a past-Data disposition
      // that never emitted a transition still needs to reach LP_DISP_*. No-op
      // for baseline/null dispositions and deduped after the first emit.
      await emitInboundBackfill();
      // #512: job/milestone dates (esp. RTP) advance post-sale WITHOUT bumping
      // lead.lastchangedon, so the lead row looks unchanged here while its jobs
      // are fresh. getLeads(options=261120) includes the Job-Modified +
      // Milestone-Updated bits, so the updated jobs are already embedded in this
      // payload — refresh them before we `continue`, or the RTP milestone is
      // dropped and lp_jobs/lp_job_milestones silently rot. Idempotent
      // (onConflict on lp_job_id / lp_job_id,mdt_id), no extra LP call.
      const jobsForRefresh = getField(lead, 'jobs', 'Jobs') || [];
      if (jobsForRefresh.length) {
        await Promise.all(jobsForRefresh.map(job => syncJobAndMilestones(job, lpLeadId, childGhlId)));
      }
      // v10.0: route through executor (entry:* immutability respected)
      if (ghlId && !existing?.ghl_tag_applied) {
        const success = await applyTagViaExecutor(ghlId, tag);
        if (success) {
          await supabase.from('lp_leads').update({ ghl_tag_applied: true }).eq('lp_lead_id', lpLeadId);
        }
      }
      continue;
    }

    const { row, isApptSet, isDemoCompleted, isClosedWon } = buildLeadRow(prospect, lead, {
      lpLeadId, lpProspectId, bucket, tag, ghlId,
      existingGhlId: existing?.ghl_contact_id || null,
      resolvedLink: resolved,
    });

    // v10.1: never overwrite an existing ghl_contact_id link with null.
    if (row.ghl_contact_id == null) delete row.ghl_contact_id;

    const { error: upsertErr } = await supabase.from('lp_leads').upsert(row, { onConflict: 'lp_lead_id' });
    if (upsertErr) throw new Error(`Lead upsert failed for ${lpLeadId}: ${upsertErr.message}`);

    // ─── AGENTIC: Emit disposition change event ──────────────────
    if (dispositionChanged) {
      const contactId = newLeadGhlId || existing?.ghl_contact_id || null;
      const leadName = `${getField(prospect, 'firstname', 'FirstName') || ''} ${getField(prospect, 'lastname', 'LastName') || ''}`.trim();

      // Phase 2 (2026-07-24): a NEW consumer inbound born DNC (inherited from
      // the prospect's prior DNC) is consent RE-ENTRY, not suppression. Emit
      // consent.reestablished INSTEAD of lp.disposition_changed:DNC (which
      // would drive LP_DISP_DNC + RECONCILE, as it did on Max Lesser). The
      // shared idempotency key also blocks every future backfill DNC emit for
      // this lead. See shouldRenewConsent() for the full guard.
      if (shouldRenewConsent({ existing, newDisposition, bucket, createdAt })) {
        // Consent re-entry — emit consent.reestablished in place of the DNC
        // disposition event. The rest of the loop body (entry:* tag, child
        // sync) still runs: this is a real new lead, only the suppression
        // signal is replaced.
        await emitConsentReestablished({
          lpLeadId,
          lpProspectId,
          ghlContactId: contactId,
          bucket,
          leadSource: getField(lead, 'source', 'Source') || null,
          leadName,
        });
        console.log(
          `[Sync] CONSENT RE-ENTRY: lead ${lpLeadId} (prospect ${lpProspectId}, ` +
          `bucket ${bucket}) — emitted consent.reestablished, DNC disposition event suppressed`
        );
      } else {
        await emitEvent({
          event_type: 'lp.disposition_changed',
          event_subtype: newDisposition,
          source: 'lp_sync',
          entity_type: 'lead',
          entity_id: lpLeadId,
          ghl_contact_id: contactId,
          lp_lead_id: lpLeadId,
          lp_prospect_id: lpProspectId,
          payload: {
            disposition_code: newDisposition,
            previous_disposition: previousDisposition,
            lead_name: leadName,
            rep_name: getField(lead, 'salesrepname', 'SalesRepName') || null,
            lead_source: getField(lead, 'source', 'Source') || null,
            appointment_set: isApptSet,
            demo_completed: isDemoCompleted,
            closed_won: isClosedWon,
          },
          previous_state: previousDisposition ? { disposition_code: previousDisposition } : null,
          new_state: { disposition_code: newDisposition },
          priority: dispositionPriority(newDisposition),
          idempotency_key: `disp_${lpLeadId}_${previousDisposition || 'null'}_${newDisposition}_${new Date().toISOString().slice(0, 10)}`,
        });
      }
    } else {
      // Record advanced (notes/jobs/contact-link) but disposition held steady.
      // If it's holding at a past-Data disposition with no prior transition
      // event, backfill it so LP_DISP_* still sees it. No-op otherwise.
      await emitInboundBackfill();
    }

    // v10.0: Apply permanent entry:* tag via executor.
    //
    // The handler's immutability guard ensures that if this contact already
    // has a different entry:* tag (set by an earlier sync or by an agent
    // hygiene rule), the add becomes a no-op rather than overwriting
    // first-touch attribution. We still mark ghl_tag_applied=true so we
    // don't re-attempt the no-op on every sync.
    if (ghlId && !existing?.ghl_tag_applied) {
      const success = await applyTagViaExecutor(ghlId, tag);
      if (success) {
        await supabase.from('lp_leads').update({ ghl_tag_applied: true }).eq('lp_lead_id', lpLeadId);
      }
    }

    const calls = getField(prospect, 'calls', 'Calls') || [];
    const notes = combineNotes(getField(prospect, 'notes', 'Notes'), getField(lead, 'notes', 'Notes'));
    const jobs = getField(lead, 'jobs', 'Jobs') || [];
    subCounts.calls += calls.length;
    subCounts.notes += notes.length;
    subCounts.jobs += jobs.length;
    for (const job of jobs) {
      subCounts.milestones += (getField(job, 'milestones', 'Milestones') || []).length;
    }

    await Promise.all([
      syncCallLogs(lpLeadId, childGhlId, calls),
      syncNotes(lpLeadId, childGhlId, notes),
      syncActivities(lpLeadId, calls, notes),
      ...jobs.map(job => syncJobAndMilestones(job, lpLeadId, childGhlId)),
    ]);

    if (dispositionChanged) {
      const contactId = newLeadGhlId || existing?.ghl_contact_id || null;
      if (contactId) {
        pushLeadNotesImmediately(lpLeadId, contactId).catch(err => {
          console.error(`[Sync] Real-time note push failed for lead ${lpLeadId}:`, err.message);
        });
      }
    }

    if (!existing?.lp_day15_triggered && ghlId) {
      const { checkDay15Handoff } = await import('./sync-triggers.js');
      await checkDay15Handoff(
        lpLeadId, ghlId,
        getField(lead, 'entrydate', 'EntryDate'),
        getField(lead, 'disposition', 'Disposition'),
      );
    }
  }

  // ═════════════════════════════════════════════════════════════════
  // v10.0: ACTIVE-ENTRY TAG MANAGEMENT
  //
  // After processing all leads, find the NEWEST lead's source and
  // apply its active-entry:* tag to the GHL contact via the executor.
  //
  // The executor's NAMESPACE_EXCLUSIVE_PREFIXES guard automatically
  // removes any other active-entry:* tag from the contact in a single
  // batch DELETE before adding the new one. This replaces the v8.0
  // pattern of pre-removing all stale tags from a hard-coded list.
  //
  // Example: Annette enters as estimate-calculator (2025), then
  // re-enters as canvassing (2026). Newest lead = canvassing.
  // executeAddTag('active-entry:canvassing') reads contact, finds
  // active-entry:estimate-calculator, DELETEs it, then POSTs the new
  // tag. GHL ends up with active-entry:canvassing only.
  // ═════════════════════════════════════════════════════════════════
  if (ghlId && leadSourceTracker.length > 0) {
    try {
      // Sort by created_at descending — newest first
      leadSourceTracker.sort((a, b) => {
        const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return db - da;
      });

      const newestTag = leadSourceTracker[0].tag;
      const activeTag = toActiveEntryTag(newestTag);

      // v10.0: single add — namespace exclusivity guard in executeAddTag
      // pre-removes any conflicting active-entry:* tag automatically.
      // No manual ALL_ACTIVE_ENTRY_TAGS list needed.
      await applyTagViaExecutor(ghlId, activeTag);

      if (leadSourceTracker.length > 1) {
        console.log(`[Sync] active-entry:* set to ${activeTag} for ${ghlId} (${leadSourceTracker.length} LP leads, newest=${leadSourceTracker[0].lpLeadId})`);
      }
    } catch (err) {
      console.error(`[Sync] active-entry:* tag management failed for ${ghlId}:`, err.message);
      // Non-critical — don't break sync
    }
  }

  // ═════════════════════════════════════════════════════════════════
  // v9.1: EMAIL ENRICHMENT CHECK (unchanged in v10.0)
  // ═════════════════════════════════════════════════════════════════
  if (ghlId) {
    try {
      const { data: alreadyEnriched } = await supabase
        .from('email_enrichment_log')
        .select('id')
        .eq('ghl_contact_id', ghlId)
        .limit(1)
        .maybeSingle();

      if (alreadyEnriched) {
        // Already enriched — no event, no action, no GroupMe spam.
      } else {
        const { findBestEmailForProspect } = await import('./email-scorer.js');
        const prospectId = String(getField(prospect, 'cst_id', 'CstID', 'prospectid', 'ProspectID'));
        const firstName = getField(prospect, 'firstname', 'FirstName', 'first_name');
        const lastName = getField(prospect, 'lastname', 'LastName', 'last_name');

        const bestEmail = await findBestEmailForProspect(prospectId, { firstName, lastName });

        if (bestEmail && bestEmail.score >= 75) {
          const idempKey = `email_enrich_${ghlId}_${bestEmail.email}`;

          await emitEvent({
            event_type: 'email.enrichment_available',
            event_subtype: bestEmail.score >= 85 ? 'high_confidence' : 'medium_confidence',
            source: 'lp_sync',
            entity_type: 'contact',
            entity_id: ghlId,
            ghl_contact_id: ghlId,
            lp_prospect_id: prospectId,
            payload: {
              candidate_email: bestEmail.email,
              confidence_score: bestEmail.score,
              scoring_reasons: bestEmail.reasons,
              source_lead_id: bestEmail.sourceLeadId,
              prospect_first_name: firstName,
              prospect_last_name: lastName,
            },
            priority: 'normal',
            idempotency_key: idempKey,
          });
        }
      }
    } catch (err) {
      console.error(`[Sync] Email enrichment check failed for ${ghlId}:`, err.message);
    }
  }

  return subCounts;
}

// Fallback: upsert from flat data (when LP returns non-nested response)
export async function upsertLeadFromFlat(lp, ghlId) {
  const lpLeadId = String(getField(lp, 'lds_id', 'id', 'LeadID', 'cst_id', 'ProspectID'));
  const lpProspectId = String(getField(lp, 'cst_id', 'CstID', 'ProspectID') || '');

  // Flat records carry prospect-level identity directly, so the record
  // doubles as both lead and prospect for corroboration.
  const { data: existingFlat } = await supabase.from('lp_leads')
    .select('ghl_contact_id, ghl_link_source')
    .eq('lp_lead_id', lpLeadId).maybeSingle();
  const resolved = await resolveLeadGhlLink({
    lead: lp,
    prospect: lp,
    verifiedGhlId: ghlId || null,
    existingGhlId: existingFlat?.ghl_contact_id || null,
    existingLinkSource: existingFlat?.ghl_link_source || null,
  }, { lpLeadId, lpProspectId });
  const flatGhlId = resolved.ghlContactId || existingFlat?.ghl_contact_id || null;

  // v10.2: stamp the effective source (native, else promoter-derived) on the
  // flat path too, so source-less "Internet, <Vendor>" inbound never persists null.
  const effFlat = effectiveLeadSource(lp);

  const flatRow = {
    lp_lead_id:         lpLeadId,
    lp_prospect_id:     lpProspectId,
    ghl_contact_id:     flatGhlId,
    ghl_link_source:    resolved.linkSource || undefined,
    first_name:         getField(lp, 'firstname', 'FirstName', 'first_name'),
    last_name:          getField(lp, 'lastname', 'LastName', 'last_name'),
    email:              getField(lp, 'email', 'Email'),
    phone:              normalizePhone(getField(lp, 'phone1', 'Phone1', 'phone', 'Phone')),
    phone_alt:          normalizePhone(getField(lp, 'phone2', 'Phone2', 'phone_alt')),
    address:            getField(lp, 'address1', 'Address1'),
    city:               getField(lp, 'city', 'City'),
    state:              getField(lp, 'state', 'State'),
    zip:                getField(lp, 'zip', 'Zip'),
    lead_source:        effFlat.source,
    lead_source_detail: effFlat.sourcesubdescr,
    promoter_name:      getField(lp, 'promotername', 'PromoterName'),
    lp_branch_id:       (() => {
      const b = getField(lp, 'brn_id', 'BrnId', 'BrnID');
      return b == null ? undefined : (String(b).trim().toUpperCase() || undefined);
    })(),
    disposition_code:   getField(lp, 'disposition', 'Disposition'),
    rep_name:           getField(lp, 'salesrepname', 'SalesRepName', 'rep_name'),
    created_at_lp:      lpDateToEastern(getField(lp, 'dateadded', 'DateAdded', 'entrydate', 'EntryDate')),
    updated_at_lp:      lpDateToEastern(getField(lp, 'lastchangedon', 'LastChangedOn')),
    synced_at:          new Date().toISOString(),
  };

  // v10.1: never overwrite an existing ghl_contact_id link with null.
  if (flatRow.ghl_contact_id == null) delete flatRow.ghl_contact_id;

  await supabase.from('lp_leads').upsert(flatRow, { onConflict: 'lp_lead_id' });

  // Reliability backstop for the flat path: this upsert carries a disposition
  // but emits no transition event of its own. If the lead is already past the
  // raw-lead baseline (pre-dispositioned inbound), backfill a one-time
  // lp.disposition_changed so the LP_DISP_* family sees it. No-op otherwise.
  await emitDispositionBackfill({
    lpLeadId,
    lpProspectId,
    ghlContactId: flatRow.ghl_contact_id || flatGhlId || null,
    disposition: flatRow.disposition_code,
    leadName: `${flatRow.first_name || ''} ${flatRow.last_name || ''}`.trim() || null,
    leadSource: flatRow.lead_source || null,
  });
}

// v9.2: Export for use by other modules (e.g., one-shot backfill scripts)
// buildLeadRow exported for the cohort-reconcile sweep (cache-only forced upsert).
// emitDispositionBackfill exported for the mirror-backfill sweep (recovered-lead
// emits) and the LP contact backstop (rescued-lead emits) — both need the same
// idempotency-keyed synthetic lp.disposition_changed this module already emits.
export { deriveLeadGhlId, GHL_CONTACT_ID_PATTERN, buildLeadRow, emitDispositionBackfill };
