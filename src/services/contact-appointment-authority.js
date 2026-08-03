/**
 * Contact-scoped appointment authority — src/services/contact-appointment-authority.js
 *
 * Appointment authority used to be scoped per LP LEAD, so any lead linked to a
 * GHL contact could drive that contact's single GHL appointment object. On
 * 2026-08-02 three sibling leads on prospect 449759 (contact
 * 4qcX45ReKbXPbKKQTLka) each did, inside 100 minutes: 563753 created the
 * appointment, 563787 rescheduled it, 563790 created a second one and
 * cancelled two. The customer was texted a time nobody had agreed to. The
 * collision WAS detected — action 266796 returned lp_appointment_conflict and
 * wrote the lp-appt-conflict tag — and the handler proceeded anyway.
 * Detection without arbitration. This module is the arbitration.
 *
 * INVARIANT: for any ghl_contact_id, exactly ONE LP lead holds appointment
 * authority at a time. ("At most one live appointment" is a separate invariant
 * already enforced by the reconciler, which treats the three in-home calendars
 * as one logical estimate appointment and blocks on
 * multiple_estimate_appointments.)
 *
 * SHIPS DARK. With APPT_AUTHORITY_ENFORCE unset, every call still claims,
 * still records, and still emits appointment.authority_denied — but returns
 * granted, so no call site changes behaviour. Flip the flag only once the
 * denial set has been reviewed and the authority_unavailable rate is zero.
 *
 * ── Error policy: THREE outcomes, not two ─────────────────────────────────
 *   rpc_missing_open      table/function not applied yet → fail OPEN. There is
 *                         no migration runner in this repo; code deploys before
 *                         DDL, and a missing object must never strand appointment
 *                         sync. Same stance as claim_agent_actions
 *                         (src/actions/index.js) and appointment_sync_claims.
 *   authority_unavailable any OTHER db error/timeout → NOT granted under
 *                         enforcement, and `retryable: true`. The CALLER throws
 *                         so the executor retries; this module never throws, so
 *                         it stays composable and unit-testable. Distinct from a
 *                         real denial on purpose: a terminal noop on a transient
 *                         503 would mark the action completed with the calendar
 *                         unsynced, no retry and no card.
 *   authority_denied      arbitration said no. Terminal.
 *
 * DEPENDENCY DIRECTION: this is a LEAF over supabase.js + event-emitter.js. It
 * must never import decision-engine.js — decision-engine imports the rank map
 * FROM here. (Same discipline as the ESM cycle note in
 * lp-ghl-appointment-reconciler.js.)
 *
 * NOT COVERED BY THIS MODULE, deliberately: src/admin/ghl-appointment-backfill.js
 * calls reconcileLpAppointmentToGhl directly and selects the newest lp_leads row
 * itself, so it is a third write leg that can still stomp the authority owner.
 * Out of scope for v1; see the plan's follow-ups.
 */

import defaultSupabase from '../supabase.js';
import { emitEvent } from '../event-emitter.js';

// ── Authority rank (§4) ─────────────────────────────────────────────────────
// Moved here from decision-engine.js on 2026-08-03 so the event gate
// (olderLeadWinsOnAuthority) and the contact-scoped claim share ONE scale.
// decision-engine.js imports and re-exports it; the value is unchanged from
// PR #610.
//
// Verif ranks WITH Set, not above it. lp_dispositions labels it "Needs
// Verification" — a PRE-confirmation state (it precedes Cnf in 128 of the 210
// leads that reached both over 60 days, and of 8,209 appointment-set Verif
// leads ZERO carry appointment_confirmed). The capacity board groups it the
// same way: CONFIRMED: [Cnf, Issue] | AT-RISK: [Set, Verif]. Cnf is the only
// state that means the customer confirmed the time, so it is the only one that
// beats them.
//
// Unlisted dispositions rank 0 and can never TAKE authority. That includes
// CXL — which is exactly why callers must never gate a cancellation on a
// granted claim. See the cancel carve-out in the LP→GHL handler.
export const BOOKING_AUTHORITY_RANK = { Set: 1, Verif: 1, Cnf: 2 };

/** Rank for an LP disposition code. Unknown/absent → 0. */
export function rankForDisposition(code) {
  return BOOKING_AUTHORITY_RANK[String(code || '').trim()] ?? 0;
}

// ── Config ──────────────────────────────────────────────────────────────────
const TABLE = 'contact_appointment_authority';
const DEFAULT_STALE_DAYS = 14;

/**
 * Feature flag, read per call so a Railway redeploy is not needed to flip it in
 * tests. Mirrors isSlotCheckEnabled() in src/appointments/slot-check.js.
 */
export function isAuthorityEnforced() {
  return String(process.env.APPT_AUTHORITY_ENFORCE || '').trim().toLowerCase() === 'true';
}

/** Starvation-release window in seconds (§10). Default 14 days. */
export function staleAfterSeconds() {
  const raw = parseInt(process.env.APPT_AUTHORITY_STALE_DAYS || '', 10);
  const days = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALE_DAYS;
  return days * 24 * 3600;
}

// Matches the deploy-before-DDL detection in src/actions/index.js (claimActions)
// and src/services/agentic-reply-locks.js, plus PostgREST's own codes for a
// function that is not in the schema cache.
const RPC_MISSING_RE =
  /does not exist|could not find|undefined function|42883|42P01|PGRST202|schema cache/i;

// ── Pure policy ─────────────────────────────────────────────────────────────
/**
 * DOCUMENTATION AND DARK-MODE PREVIEW ONLY. **Never a decision input.**
 *
 * The SQL WHERE clause in sql/migrations/2026-08-03_contact_appointment_authority.sql
 * is the single source of truth for arbitration — it runs under the ON CONFLICT
 * row lock, which is the whole point. This mirror exists so the predicate is
 * unit-testable (CI has no Postgres) and readable in JS. If the two ever
 * disagree, the SQL is right and this is a bug. Building a second source of
 * truth for the thing this feature exists to give one source of truth to would
 * be self-defeating, so do not call it to decide anything.
 *
 * Mirrors, in order: §5 r1 owner, §5 r2 higher rank, §5 r4 no live appointment,
 * §10 staleness. §5 r3 (rank-tie → more recently touched) is absent from BOTH —
 * see the SQL comment for why.
 *
 * @returns {{ granted: boolean, reason: string }}
 */
export function arbitrate(current, incoming, { nowMs = Date.now(), staleSeconds } = {}) {
  if (!current) return { granted: true, reason: 'first_claim' };

  if (String(current.owner_lp_lead_id) === String(incoming.owner_lp_lead_id)) {
    return { granted: true, reason: 'owner' };
  }
  if ((incoming.authority_rank ?? 0) > (current.authority_rank ?? 0)) {
    return { granted: true, reason: 'outranks' };
  }

  const startMs = current.appointment_start ? Date.parse(current.appointment_start) : NaN;
  if (!current.ghl_appointment_id || Number.isNaN(startMs) || startMs < nowMs) {
    return { granted: true, reason: 'no_live_appointment' };
  }

  // COALESCE(seen_at, '-infinity') — a NULL updated_at_lp must leave the row
  // RELEASABLE, not permanently wedged. 8 lp_leads rows carry NULL today.
  const seenMs = current.lp_appointment_seen_at
    ? Date.parse(current.lp_appointment_seen_at)
    : -Infinity;
  const windowMs = (staleSeconds ?? staleAfterSeconds()) * 1000;
  if (!(seenMs >= nowMs - windowMs)) return { granted: true, reason: 'owner_stale' };

  return { granted: false, reason: 'authority_denied' };
}

// ── Claim ───────────────────────────────────────────────────────────────────
/**
 * Claim appointment authority for (contact, lead).
 *
 * NEVER THROWS. Callers decide what to do with `retryable`.
 *
 * @param {object}  args
 * @param {string}  args.contactId          GHL contact id. MUST be a GHL contact —
 *   never an LP lead id. The table's PK is ghl_contact_id, and a row keyed on an
 *   lds_id can never be found again by release/record.
 * @param {string}  args.leadId             LP lead id claiming authority
 * @param {string}  [args.dispositionCode]  LP disposition → rank (ignored if rank given)
 * @param {number}  [args.rank]             explicit rank override
 * @param {string}  [args.seenAt]           lp_leads.updated_at_lp (LP's LastChangedOn)
 * @param {string}  [args.appointmentId]    usually null — the claim precedes the write
 * @param {string}  [args.appointmentStart] ET-normalized ISO, via lpWallClockToGhlStartTime
 * @param {string}  [args.prospectId]
 * @param {string}  [args.source]           'lp_disposition' | 'ghl_booking'
 * @param {object}  [args.client]           supabase client injection (tests)
 * @returns {Promise<{granted:boolean, ownerLeadId:string|null, reason:string,
 *   version:number|null, shadowDenied:boolean, retryable:boolean, enforced:boolean}>}
 */
export async function claimAppointmentAuthority({
  contactId, leadId, dispositionCode, rank, seenAt, appointmentId,
  appointmentStart, prospectId, source = 'lp_disposition', client,
} = {}) {
  const enforced = isAuthorityEnforced();
  const supabase = client ?? defaultSupabase;
  const effectiveRank = Number.isFinite(rank) ? rank : rankForDisposition(dispositionCode);

  const open = (reason) => ({
    granted: true, ownerLeadId: leadId ?? null, reason, version: null,
    shadowDenied: false, retryable: false, enforced,
  });

  if (!supabase) return open('no_supabase_open');
  if (!contactId || !leadId) return open('bad_key_open');

  let data, error;
  try {
    ({ data, error } = await supabase.rpc('claim_appointment_authority', {
      p_contact_id: String(contactId),
      p_lead_id: String(leadId),
      p_rank: effectiveRank,
      p_seen_at: seenAt || null,
      p_appointment_id: appointmentId || null,
      p_source: source,
      p_prospect_id: prospectId ? String(prospectId) : null,
      p_appointment_start: appointmentStart || null,
      p_stale_after_seconds: staleAfterSeconds(),
    }));
  } catch (err) {
    console.warn(`[ApptAuthority] claim threw for ${contactId}/${leadId}: ${err.message}`);
    return unavailable(enforced, leadId);
  }

  if (error) {
    if (RPC_MISSING_RE.test(error.message || '')) {
      console.warn(`[ApptAuthority] claim RPC missing (fail-open) — apply sql/migrations/2026-08-03_contact_appointment_authority.sql: ${error.message}`);
      return open('rpc_missing_open');
    }
    console.error(`[ApptAuthority] claim error for ${contactId}/${leadId}: ${error.message}`);
    return unavailable(enforced, leadId);
  }

  // The RPC returns jsonb, so supabase-js hands back an object. Tolerate an
  // array anyway: if the function is ever redefined as RETURNS TABLE, PostgREST
  // returns rows and a bare `data.granted` would read undefined → falsy →
  // EVERY write silently denied. Guarded here and asserted in the client tests.
  const row = Array.isArray(data) ? data[0] : data;

  if (row?.granted) {
    return {
      granted: true, ownerLeadId: row.owner_lp_lead_id || String(leadId),
      reason: 'granted', version: row.version ?? null,
      shadowDenied: false, retryable: false, enforced,
    };
  }

  // Denied. ownerLeadId is ADVISORY — ownership can change between the RPC's
  // two statements, so the owner named here may already be a third lead.
  const ownerLeadId = row?.owner_lp_lead_id || null;
  const reason = row?.reason || 'authority_denied';

  void emitAuthorityDenied({
    contactId, leadId, effectiveRank, ownerLeadId, reason, enforced, prospectId, source,
  });

  if (!enforced) {
    // DARK MODE: the write proceeds. Deliberately reports granted so no call
    // site changes behaviour, but flags shadowDenied so callers skip
    // recordAppointmentAuthorityResult — the appointment about to be created
    // belongs to the DENIED lead, and attaching its id to the owner's row would
    // corrupt exactly the data this soak exists to read.
    return {
      granted: true, ownerLeadId, reason, version: row?.version ?? null,
      shadowDenied: true, retryable: false, enforced: false,
    };
  }

  return {
    granted: false, ownerLeadId, reason, version: row?.version ?? null,
    shadowDenied: false, retryable: false, enforced: true,
  };
}

function unavailable(enforced, leadId) {
  return {
    granted: !enforced,               // dark mode never blocks, not even on infra
    ownerLeadId: enforced ? null : (leadId ?? null),
    reason: 'authority_unavailable',
    version: null,
    shadowDenied: false,
    retryable: true,                  // caller THROWS so the executor retries
    enforced,
  };
}

// ── Post-write bookkeeping ──────────────────────────────────────────────────
/**
 * Attach the real appointment to the authority row after a successful write.
 * Owner-guarded server-side. This is what arms the "no live appointment" clause
 * for the next claimant, so skipping it quietly disables enforcement.
 *
 * MUST NOT be called when claim returned shadowDenied — see the dark-mode note
 * in claimAppointmentAuthority.
 *
 * Best-effort: never throws, never blocks the caller's result.
 */
export async function recordAppointmentAuthorityResult(
  contactId, leadId, { appointmentId, calendarId, appointmentStart } = {}, { client } = {},
) {
  const supabase = client ?? defaultSupabase;
  if (!supabase || !contactId || !leadId) return false;
  try {
    const { error } = await supabase.rpc('record_appointment_authority', {
      p_contact_id: String(contactId),
      p_lead_id: String(leadId),
      p_appointment_id: appointmentId || null,
      p_calendar_id: calendarId || null,
      p_appointment_start: appointmentStart || null,
    });
    if (error && !RPC_MISSING_RE.test(error.message || '')) {
      console.warn(`[ApptAuthority] record failed for ${contactId}/${leadId}: ${error.message}`);
      return false;
    }
    return !error;
  } catch (err) {
    console.warn(`[ApptAuthority] record threw for ${contactId}/${leadId}: ${err.message}`);
    return false;
  }
}

/**
 * Release the seat (owner-guarded server-side). Two callers:
 *   - after a successful CANCEL — LP says the estimate is dead, so the next
 *     writer should not have to wait out the 14-day staleness window;
 *   - after the reconciler THROWS following a granted claim — otherwise the
 *     failing lead owns the contact permanently and every sibling is denied.
 *     Mirrors releaseAppointmentCreate() in appointment-sync-claim.js.
 *
 * Best-effort: never throws.
 */
export async function releaseAppointmentAuthority(contactId, leadId, { client } = {}) {
  const supabase = client ?? defaultSupabase;
  if (!supabase || !contactId || !leadId) return false;
  try {
    const { error } = await supabase.rpc('release_appointment_authority', {
      p_contact_id: String(contactId),
      p_lead_id: String(leadId),
    });
    if (error && !RPC_MISSING_RE.test(error.message || '')) {
      console.warn(`[ApptAuthority] release failed for ${contactId}/${leadId}: ${error.message}`);
      return false;
    }
    return !error;
  } catch (err) {
    console.warn(`[ApptAuthority] release threw for ${contactId}/${leadId}: ${err.message}`);
    return false;
  }
}

// ── Denial event (§9) ───────────────────────────────────────────────────────
/**
 * Emitted with bypass_filter, NOT added to ALLOWED_EVENT_TYPES. Those are the
 * two mutually-exclusive precedents in event-intake-filter.js
 * (agentic.disposition_mirror_refreshed is allowlisted;
 * agentic.hold_error bypasses) and bypass is the fit for an observability event
 * with no consuming rule.
 *
 * §9 is explicit that the ghl.tag_added whitelist must NOT be extended to carry
 * this: the lp-appt-conflict tag is a symptom, the denial is the fact.
 */
async function emitAuthorityDenied({
  contactId, leadId, effectiveRank, ownerLeadId, reason, enforced, prospectId, source,
}) {
  try {
    await emitEvent({
      event_type: 'appointment.authority_denied',
      event_subtype: source || 'lp_disposition',
      source: 'lp_mcp',
      entity_type: 'contact',
      entity_id: String(contactId),
      ghl_contact_id: String(contactId),
      lp_lead_id: leadId ? String(leadId) : null,
      lp_prospect_id: prospectId ? String(prospectId) : null,
      priority: 'high',
      bypass_filter: true,
      payload: {
        contact_id: String(contactId),
        denied_lead_id: leadId ? String(leadId) : null,
        denied_rank: effectiveRank,
        owner_lead_id: ownerLeadId,        // ADVISORY — see claim's denial branch
        reason,
        // false ⇒ the write proceeded anyway. Count these to size enforcement
        // before flipping APPT_AUTHORITY_ENFORCE.
        enforced,
      },
    });
  } catch (err) {
    console.warn(`[ApptAuthority] denied-event emit failed for ${contactId}: ${err.message}`);
  }
}

export const _internal = { RPC_MISSING_RE, TABLE, DEFAULT_STALE_DAYS };
