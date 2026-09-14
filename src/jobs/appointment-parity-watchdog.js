/**
 * Appointment Parity Watchdog — src/jobs/appointment-parity-watchdog.js
 *
 * Continuous bidirectional reconciliation of the appointment book between
 * GoHighLevel and Lead Perfection. The owner rule (Mark, 2026-08-17):
 *
 *   "If there's an appointment set in GHL, it should be an appointment set
 *    in LP. If an appointment is confirmed in LP, it should be confirmed in
 *    GHL. It should be a complete sync."
 *
 * ---------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * Every existing appointment path is EVENT-DRIVEN and one-shot: a booking
 * fires a webhook, the webhook writes the other side, and nothing ever
 * re-checks. So any single dropped event — an LP callback that never
 * landed, a rep who rebooked directly in LP, a GHL workflow that wrote the
 * calendar without emitting, a sync error retried past its budget — leaves
 * a permanent divergence that no later process notices or repairs.
 *
 * Measured 2026-08-17, window 8/17 20:00Z → 10/01, contact-level:
 *   GHL side          185 contacts with an active future appointment
 *   LP side           193 contacts with an appointment set
 *   matched both      153
 *   GHL-only           32   (booked in GHL, LP has nothing)
 *   LP-only            40   (booked in LP, GHL has nothing or stale)
 *
 * ~79% parity. The 40 LP-only contacts get no confirmation sequence, no
 * reminders and no agentic coverage; the 32 GHL-only contacts are invisible
 * to the dial list and to every LP report the owners read.
 *
 * This job closes the loop: it re-derives both books on a fixed cadence and
 * repairs or escalates each divergence class.
 *
 * ---------------------------------------------------------------------
 * DIVERGENCE CLASSES AND WHAT WE DO ABOUT EACH
 *
 *   A. lp_missing_appointment  — GHL has an active future appointment, LP
 *      has none for that contact in the window.
 *      → AUTO-HEAL. Calls syncAppointmentToLP, the same orchestrator the
 *        webhook path uses: it resolves the LP lead through the 5-step
 *        chain and either runs LP SetAppointment or self-heals by enrolling
 *        the contact in workflow 8e30ff37 (addlead-with-appointment). No new
 *        LP write behaviour is introduced here.
 *
 *   B. ghl_missing_appointment — LP has an appointment in the window, GHL
 *      has none, or only a cancelled/past one.
 *      → ESCALATE, DO NOT AUTO-CREATE. The GHL calendar object is the
 *        revenue-bearing artifact: it drives rep dispatch, reminders and
 *        capacity. Creating one from a cache read risks double-booking a
 *        slot a human already gave away, and `lp_leads.appointment_date` is
 *        on the untrustworthy list (overwritten on reset, wrong grain). We
 *        emit the finding and open a rep task instead. Promote to auto-heal
 *        only once the date is sourced from an LP report rather than cache.
 *
 *   C. confirmation_drift      — LP says confirmed, GHL does not.
 *      → EMIT ONLY, despite what this said until v1.1. It emits
 *        appointment.confirmation_drift and nothing consumes it, so GHL is
 *        never actually confirmed. Counted as `confirm_emitted`, not
 *        `healed`, until a consumer exists. Calling it a heal is how the old
 *        number lied.
 *
 *   D. cancellation_drift      — GHL cancelled, LP still shows set.
 *      → ESCALATE. A cancellation that only half-landed usually means a
 *        human cancelled in one system; which system is authoritative is a
 *        judgement call, so a rep decides.
 *
 *   E. lp_cancelled_ghl_active — LP cancelled (CXL/NoHome/NG), GHL still
 *      holds an ACTIVE appointment. The mirror of D, and new in v1.2.
 *      → ESCALATE, never auto-heal. Writing the appointment back into LP
 *        would silently un-cancel something a human cancelled.
 *
 * ---------------------------------------------------------------------
 * DNC HANDLING (owner ruling, Mark 2026-08-17)
 *
 *   "The DNC does not matter. If they opted back in and have a new
 *    appointment, the DNC should actually be lifted."
 *
 * Implemented, with one deliberate carve-out.
 *
 * LIFTED — operational DNC. `dnc`, `dnc-related`, `stage:dnc`, `lp-dnc`.
 * These come from a rep disposition or an internal suppression decision.
 * A homeowner who has since booked a new appointment has plainly re-engaged,
 * and the stale marker is what blocks their confirmation sequence. Lifted
 * only when the appointment was created AFTER the DNC marker was applied —
 * a new booking is the opt-back-in signal, an old one proves nothing.
 *
 * NEVER LIFTED — consent-level opt-out. `unsubscribed`, `optedOut`,
 * `stop-bot`. `unsubscribed`/`optedOut` are carrier-level STOP replies: under
 * TCPA the consumer revoked consent and only the consumer can restore it by
 * texting START. No booking, and no instruction in this file, can reverse
 * that — reinstating messaging on a STOP is the one failure here with legal
 * exposure attached. `stop-bot` is the rep-takeover flag; clearing it would
 * put the bot back on top of a rep who deliberately took the conversation.
 *
 * A lift on a contact carrying BOTH families lifts the operational tags and
 * leaves the consent tags in place, so the appointment syncs and the
 * reminders stay off. That combination is reported as `dnc_partial_lift` so
 * it is visible rather than silent.
 *
 * ---------------------------------------------------------------------
 * SAFETY
 *   - DRY RUN BY DEFAULT. Writes require PARITY_AUTOHEAL=true.
 *   - Per-run write ceiling (PARITY_MAX_WRITES) so a bad read can never
 *     produce an unbounded write storm.
 *   - Two separate Supabases: LP and HL are read independently and compared
 *     in memory. No cross-join is attempted.
 *   - Both books are read against a SINGLE captured instant. The two reads
 *     are seconds apart and appointments start continuously; comparing them
 *     against a moving now() manufactures phantom gaps for anything starting
 *     during the run. That artifact produced a 42-contact false gap in the
 *     2026-08-17 manual audit before it was caught.
 *
 * ---------------------------------------------------------------------
 * v1.2 — 2026-09-14 — WHY THE HEALS NEVER HEALED (Class E)
 *
 * v1.1 made the counters honest, and the first live run under them answered
 * the question immediately: healed=0, already_present=2. A full live sweep
 * with writes enabled repaired NOTHING.
 *
 * The cause was in readLpBook. It dropped every lp_leads row whose disposition
 * was CXL / NoHome / NG, so a contact LP had CANCELLED was indistinguishable
 * from one LP had never heard of. Class A then treated it as a missing
 * appointment and tried to heal it — and syncAppointmentToLP correctly refused
 * every time ("LP already holds appt on <date> ... per GHL LP-synced fields"),
 * because LP does hold the record; it is simply cancelled.
 *
 * So the gap could never clear. It was re-attempted every 30 minutes forever,
 * burning one of only 10 writes per run and holding an alert slot that a
 * genuinely missing appointment needed. The two systems were never in
 * disagreement about the facts — they were answering different questions.
 *
 * Measured 2026-09-14: 28 lp_leads rows sat at CXL with a future appointment
 * inside the 45-day window. Worked example — Frank Sarchapone
 * (oubiIiCW8U0i7GmPMCC7): GHL appointment 4DyGUTgXMOCh12PpCHV5 status=new for
 * 15 Sep 18:00; LP lead 207103, same slot, disposition CXL.
 *
 * Fix: readLpBook now returns { active, resolved } instead of discarding the
 * resolved rows, and Class E escalates that case to a human. Class A is
 * unchanged for contacts LP genuinely lacks.
 *
 * Two smaller fixes rode along:
 *   - classifyHealResult now recognises 'create_lead_already_enrolled'. The
 *     live run returned it and it landed in unknown_result — which is exactly
 *     what that bucket is for, surfacing an unenumerated action rather than
 *     quietly inflating the heal count.
 *   - POST /n8n/appointments/parity-check now takes the authenticate
 *     middleware. It was the only route in its group mounted without it, and
 *     it accepts {dryRun:false} — a live sweep that writes to LP and GHL.
 *
 * ---------------------------------------------------------------------
 * v1.1 — 2026-09-14 — THE SWEEP WAS LYING (PARITY_AUTOHEAL switch-on)
 *
 * PARITY_AUTOHEAL was set true at ~15:30Z and every sweep logged
 * "4 healed, 27 escalated, 0 errors". It had healed nothing and escalated
 * nothing. Two sweeps 29 minutes apart were byte-identical and LP-missing
 * never moved. Verified against production:
 *   - 26 appointment.parity_gap rows in system_events_filtered, reason
 *     event_type_not_in_allowlist. ZERO in system_events, ever.
 *   - Newest lp_appointment_sync_marks row predated the first autoheal sweep
 *     by three hours, so no appointment was written to LP.
 *
 * Three independent causes, all fixed here:
 *
 *   1. `healed++` fired unconditionally after syncAppointmentToLP() returned.
 *      It counted "the call did not throw", not "the appointment is in LP".
 *      Now classifyHealResult() inspects result.action and only
 *      'lp_appointment_set' counts. See the `outcomes` block for the rest.
 *
 *   2. `escalated++` fired before the write gate, and emitEvent returns
 *      {filtered:true} WITHOUT throwing when event intake drops the event —
 *      so 27 discarded events counted as successful writes and errors stayed
 *      at 0. Now classifyEmit() separates emitted / dropped_at_intake /
 *      emit_noop, and the three event types are on the intake allowlist.
 *
 *   3. Class order was A → B/D → C. Class B/D routinely produces 27 findings
 *      against a PARITY_MAX_WRITES of 25, so the escalations consumed the
 *      whole budget and Class C never got a single write — with writes that
 *      were being discarded anyway. Order is now A → C → B/D: repairs first,
 *      notifications last.
 *
 * And the reason none of it was noticed for as long as this job has existed:
 * NOTHING CONSUMES appointment.parity_gap. There is no agent_rule for it, so
 * even the events that would have landed reached no human. The watchdog now
 * sends its own ops card (#ops-alerts via the channel mirror), edge-triggered
 * per contact so ~27 standing gaps announce once rather than every 30 minutes.
 * Reporting is NOT gated on PARITY_AUTOHEAL — that flag governs writes, and a
 * gap nobody is told about is the failure this module exists to prevent.
 *
 * ---------------------------------------------------------------------
 * Tuning:
 *   PARITY_AUTOHEAL=false        writes off by default
 *   PARITY_WINDOW_DAYS=45        how far ahead to reconcile
 *   PARITY_MAX_WRITES=25         per-run write ceiling
 *   PARITY_INTERVAL_MS=30m
 */

import supabase from '../supabase.js';
import { getHlSupabase } from '../admin/hl-client.js';
import { emitEvent } from '../event-emitter.js';
import { syncAppointmentToLP } from '../lp-appointment-sync.js';
import { getGHLContact } from '../ghl.js';
import { utcToLpStoredIso } from '../lp-dates.js';
import { sendGroupMeMessage } from '../groupme.js';
import { claimAlertConditionSet, confirmAlertSend } from '../alert-state.js';
import { shouldAlertParityGaps, parityAlertKey, formatParityGapCard } from './appointment-parity-alerts.js';

// One alert key per contact per class — see appointment-parity-alerts.js for
// why this is set-valued rather than a per-sweep digest.
const ALERT_PREFIX = 'appt_parity:gap:';

/**
 * Classify what syncAppointmentToLP actually did. The v1.1 defect was that
 * NOTHING inspected this: `healed++` fired whenever the call returned without
 * throwing, so an early return read as a repair. Only 'lp_appointment_set'
 * means an appointment was written to LP.
 */
function classifyHealResult(result) {
  const action = result?.action;
  if (!action) return 'unknown_result';
  switch (action) {
    case 'lp_appointment_set':
      return 'healed';
    case 'already_set_in_lp':
    case 'already_in_lp_skipped_pre_resolve':
      // Parity read LP as MISSING this appointment while the sync path read it
      // as present. The two disagree, and that disagreement is its own finding
      // — not a heal, and not nothing.
      return 'already_present';
    case 'duplicate_sync_suppressed':
      return 'dedup_suppressed';
    case 'skipped_lp_unavailable':
    case 'deferred_pending_lp_issuance':
    case 'past_appointment_left_asis':
      return 'not_attempted';
    case 'lp_lead_creation_enrolled':
    case 'create_lead_already_enrolled':
      // The self-heal path: no LP appointment yet, but the contact is enrolled
      // in the addlead-with-appointment workflow that creates one. Real work,
      // not yet a repair — it lands (or does not) on a later sweep.
      //
      // create_lead_already_enrolled added 2026-09-14: the first live run after
      // v1.1 returned it and it fell into unknown_result, which is exactly what
      // that bucket is for — surfacing an action nobody had enumerated instead
      // of quietly inflating the heal count. Same family, already-enrolled.
      return 'heal_enrolled';
    default:
      return 'unknown_result';
  }
}

/**
 * Classify what emitEvent did. It returns {filtered:true} when the intake
 * allowlist drops the event and null on an idempotency skip or a write
 * failure — neither throws, which is why v1.1 counted 27 escalations that
 * reached nobody.
 */
function classifyEmit(res) {
  if (res && res.filtered === true) return 'dropped_at_intake';
  if (res && res.id) return 'emitted';
  return 'emit_noop';   // idempotency skip or write failure; emitEvent logs which
}

const PARITY_AUTOHEAL = process.env.PARITY_AUTOHEAL === 'true';
const PARITY_WINDOW_DAYS = Number(process.env.PARITY_WINDOW_DAYS || 45);
const PARITY_MAX_WRITES = Number(process.env.PARITY_MAX_WRITES || 25);
const PARITY_INTERVAL_MS = Number(process.env.PARITY_INTERVAL_MS || 30 * 60 * 1000);

const ACTIVE_GHL_STATUSES = ['new', 'confirmed'];

// LP dispositions that mean the appointment is resolved, not pending.
const RESOLVED_DISPOSITIONS = new Set(['CXL', 'NoHome', 'NG']);

// Operational DNC — liftable on a genuine opt-back-in.
const OPERATIONAL_DNC_TAGS = ['dnc', 'dnc-related', 'stage:dnc', 'lp-dnc'];

// Consent-level opt-out — NEVER liftable. See the DNC block above.
const CONSENT_OPTOUT_TAGS = ['unsubscribed', 'optedOut', 'stop-bot'];

/* ------------------------------------------------------------------ */

/** GHL book: active appointments per contact in [from, to). */
async function readGhlBook(from, to) {
  const hl = getHlSupabase();
  const { data, error } = await hl
    .from('appointments')
    .select('ghl_contact_id, ghl_appointment_id, status, start_time, ghl_calendar_id')
    .is('deleted_at', null)
    .gte('start_time', from.toISOString())
    .lt('start_time', to.toISOString());
  if (error) throw new Error(`GHL appointment read: ${error.message}`);

  const active = new Map();   // cid -> earliest active appointment
  const cancelled = new Map();
  for (const row of data || []) {
    if (!row.ghl_contact_id) continue;
    const bucket = ACTIVE_GHL_STATUSES.includes(row.status) ? active : cancelled;
    const prev = bucket.get(row.ghl_contact_id);
    if (!prev || new Date(row.start_time) < new Date(prev.start_time)) {
      bucket.set(row.ghl_contact_id, row);
    }
  }
  return { active, cancelled };
}

/**
 * LP book: appointments per contact in [from, to).
 *
 * Returns TWO maps as of v1.2:
 *   active   — appointments in a live disposition. The real LP book.
 *   resolved — appointments whose disposition is CXL / NoHome / NG.
 *
 * Before v1.2 the resolved rows were simply dropped, which made "LP cancelled
 * this appointment" indistinguishable from "LP never had this appointment".
 * That is a real difference and it had a real cost — see Class E below.
 */
async function readLpBook(from, to) {
  const { data, error } = await supabase
    .from('lp_leads')
    .select('ghl_contact_id, lp_lead_id, lp_prospect_id, first_name, last_name, disposition_code, appointment_set, appointment_confirmed, appointment_date, updated_at_lp')
    .eq('appointment_set', true)
    // Bound built in the stored ET-wall-clock frame. Unlike the GHL
    // appointments read above (start_time is true UTC), lp_leads
    // appointment_date holds ET digits tagged +00:00 — see src/lp-dates.js.
    .gte('appointment_date', utcToLpStoredIso(from.getTime()))
    .lt('appointment_date', utcToLpStoredIso(to.getTime()))
    .not('ghl_contact_id', 'is', null);
  if (error) throw new Error(`LP appointment read: ${error.message}`);

  // A contact can carry several lp_leads rows (rebooks, and the known
  // identity-collision class). Keep the most recently updated row per contact
  // in each bucket.
  const book = new Map();
  const resolved = new Map();
  const keepNewest = (map, row) => {
    const prev = map.get(row.ghl_contact_id);
    if (!prev) { map.set(row.ghl_contact_id, row); return; }
    const a = row.updated_at_lp ? new Date(row.updated_at_lp).getTime() : 0;
    const b = prev.updated_at_lp ? new Date(prev.updated_at_lp).getTime() : 0;
    if (a > b) map.set(row.ghl_contact_id, row);
  };

  for (const row of data || []) {
    keepNewest(RESOLVED_DISPOSITIONS.has(row.disposition_code) ? resolved : book, row);
  }
  return { active: book, resolved };
}

/**
 * Decide the DNC action for a contact we are about to sync into LP.
 *
 * Returns { lift: string[], blocked: string[], decision }.
 *   'no_dnc'          nothing present
 *   'lift'            operational tags only, appointment postdates them
 *   'partial_lift'    operational lifted, consent opt-out retained
 *   'consent_only'    nothing liftable — consent opt-out stands alone
 *   'stale_booking'   DNC postdates the appointment; not an opt-back-in
 */
function planDncLift(tags, apptCreatedAt, dncAppliedAt) {
  const held = new Set(Array.isArray(tags) ? tags : []);
  const operational = OPERATIONAL_DNC_TAGS.filter(t => held.has(t));
  const consent = CONSENT_OPTOUT_TAGS.filter(t => held.has(t));

  if (operational.length === 0 && consent.length === 0) {
    return { lift: [], blocked: [], decision: 'no_dnc' };
  }
  if (operational.length === 0) {
    return { lift: [], blocked: consent, decision: 'consent_only' };
  }
  // Only a booking made AFTER the marker counts as opting back in.
  if (apptCreatedAt && dncAppliedAt && apptCreatedAt <= dncAppliedAt) {
    return { lift: [], blocked: [...operational, ...consent], decision: 'stale_booking' };
  }
  return {
    lift: operational,
    blocked: consent,
    decision: consent.length ? 'partial_lift' : 'lift',
  };
}

/* ------------------------------------------------------------------ */

export async function runAppointmentParityWatchdog({ dryRun = !PARITY_AUTOHEAL, deps = {} } = {}) {
  const started = Date.now();

  // deps seam (CLAUDE.md: anything reaching the network or the database goes
  // through one). Added 2026-09-14 so the write-budget ordering below is
  // testable — it is the kind of behaviour that can only be verified by
  // running the sweep, and it regressed silently for as long as this job has
  // existed.
  const _readGhlBook = deps.readGhlBook || readGhlBook;
  const _readLpBook = deps.readLpBook || readLpBook;
  const _getGHLContact = deps.getGHLContact || getGHLContact;
  const _syncAppointmentToLP = deps.syncAppointmentToLP || syncAppointmentToLP;
  const _emitEvent = deps.emitEvent || emitEvent;

  // ONE captured instant for both books — see SAFETY above.
  const asOf = new Date();
  const windowEnd = new Date(asOf.getTime() + PARITY_WINDOW_DAYS * 86400000);

  const [{ active: ghlActive, cancelled: ghlCancelled }, { active: lpBook, resolved: lpResolved }] =
    await Promise.all([
      _readGhlBook(asOf, windowEnd),
      _readLpBook(asOf, windowEnd),
    ]);

  const findings = [];
  let writes = 0;
  let errors = 0;
  const counts = {
    lp_missing_appointment: 0,
    ghl_missing_appointment: 0,
    confirmation_drift: 0,
    cancellation_drift: 0,
    lp_cancelled_ghl_active: 0,
    dnc_lifted: 0,
    dnc_partial_lift: 0,
    dnc_blocked_consent: 0,
    write_ceiling_hit: 0,
  };

  // v1.1 — 2026-09-14. Outcome counters, one per thing that can actually
  // happen. The single `healed` and `escalated` they replace were incremented
  // unconditionally after a call returned, so a sweep that repaired nothing
  // and notified nobody logged "4 healed, 27 escalated". Every bucket here is
  // reported, so a no-op can no longer hide inside a success number.
  const outcomes = {
    healed: 0,             // appointment actually written to LP
    heal_enrolled: 0,      // enrolled in the addlead-with-appointment self-heal
    already_present: 0,    // sync path says LP has it; parity says it does not
    dedup_suppressed: 0,   // blocked by the 24h lp_appointment_sync_marks entry
    not_attempted: 0,      // LP unavailable / deferred / past appointment
    unknown_result: 0,     // unrecognised action — logged raw
    escalated: 0,          // parity_gap event that actually inserted
    confirm_emitted: 0,    // confirmation_drift event that actually inserted
    dropped_at_intake: 0,  // emitEvent returned {filtered:true}
    emit_noop: 0,          // idempotency skip or write failure
  };

  const canWrite = () => !dryRun && writes < PARITY_MAX_WRITES;

  // ---- Class E: GHL active, LP CANCELLED. ESCALATE. -----------------
  //
  // v1.2 — 2026-09-14. This class did not exist, and its absence was the whole
  // reason autoheal never healed anything. readLpBook dropped every row in a
  // resolved disposition, so a contact LP had CANCELLED looked identical to one
  // LP had never heard of — and Class A below then tried to "heal" it by
  // writing the appointment to LP. syncAppointmentToLP correctly refused every
  // time ("LP already holds appt ... per GHL LP-synced fields"), so the gap
  // could never clear: it was re-attempted every 30 minutes forever, burning a
  // write from a budget of 10 and holding an alert slot that a genuinely
  // missing appointment needed.
  //
  // Verified 2026-09-14: 28 lp_leads rows sat at CXL with a future appointment
  // inside the window. Frank Sarchapone (oubiIiCW8U0i7GmPMCC7) is the worked
  // example — GHL appointment 4DyGUTgXMOCh12PpCHV5 status=new for 15 Sep 18:00,
  // LP lead 207103 same slot, disposition CXL.
  //
  // ESCALATE, never auto-heal — the same reasoning Class D already applies to
  // the mirror case: a cancellation that only half-landed means a human
  // cancelled in one system, and which system is authoritative is a judgement
  // call. Writing the appointment back into LP would silently un-cancel it.
  for (const [cid, appt] of ghlActive) {
    if (lpBook.has(cid)) continue;
    const lpRow = lpResolved.get(cid);
    if (!lpRow) continue;

    counts.lp_cancelled_ghl_active++;
    findings.push({
      class: 'lp_cancelled_ghl_active',
      contact_id: cid,
      name: `${lpRow.first_name || ''} ${lpRow.last_name || ''}`.trim(),
      ghl_appointment_id: appt.ghl_appointment_id,
      ghl_start: appt.start_time,
      ghl_status: appt.status,
      lp_appointment_date: lpRow.appointment_date,
      lp_disposition: lpRow.disposition_code,
      lp_prospect_id: lpRow.lp_prospect_id,
      action: 'escalate_to_rep',
    });
  }

  // ---- Class A: GHL has it, LP does not. AUTO-HEAL. -----------------
  for (const [cid, appt] of ghlActive) {
    if (lpBook.has(cid)) continue;
    // A contact LP has cancelled is Class E above, not a missing appointment.
    if (lpResolved.has(cid)) continue;
    counts.lp_missing_appointment++;
    const finding = {
      class: 'lp_missing_appointment',
      contact_id: cid,
      ghl_start: appt.start_time,
      ghl_status: appt.status,
      action: 'sync_to_lp',
    };

    if (!canWrite()) {
      if (!dryRun) counts.write_ceiling_hit++;
      findings.push({ ...finding, executed: false });
      continue;
    }

    try {
      // DNC first: syncing an appointment onto a contact still carrying a
      // stale operational DNC leaves it booked but unreachable.
      const contact = await _getGHLContact(cid);
      const plan = planDncLift(contact?.tags, new Date(appt.start_time), null);
      if (plan.decision === 'lift') counts.dnc_lifted++;
      if (plan.decision === 'partial_lift') counts.dnc_partial_lift++;
      if (plan.blocked.length) counts.dnc_blocked_consent++;

      if (plan.lift.length) {
        const liftRes = await _emitEvent({
          event_type: 'dnc.lift_requested',
          event_subtype: 'appointment_opt_back_in',
          source: 'appointment_parity_watchdog',
          entity_type: 'contact',
          entity_id: cid,
          ghl_contact_id: cid,
          payload: { lift_tags: plan.lift, retained_tags: plan.blocked, reason: 'new_appointment_after_dnc' },
          priority: 'normal',
          idempotency_key: `parity_dnc_lift_${cid}_${appt.start_time}`,
        });
        const liftOutcome = classifyEmit(liftRes);
        if (liftOutcome !== 'emitted') outcomes[liftOutcome]++;
      }

      const start = new Date(appt.start_time);
      const result = await _syncAppointmentToLP({
        contactId: cid,
        appointmentDate: start.toISOString().slice(0, 10),
        appointmentTime: start.toLocaleTimeString('en-US', {
          timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true,
        }),
      });
      writes++;

      // The load-bearing line. `result.action` decides what happened; the call
      // returning is not evidence of anything.
      const outcome = classifyHealResult(result);
      outcomes[outcome]++;
      if (outcome === 'unknown_result') {
        console.warn(`[ApptParity] unrecognised sync result for ${cid}: ${JSON.stringify(result)?.slice(0, 200)}`);
      }

      findings.push({
        ...finding,
        executed: outcome === 'healed',
        outcome,
        lp_result: result?.action ?? null,
        dnc: plan.decision,
      });
    } catch (err) {
      errors++;
      findings.push({ ...finding, executed: false, outcome: 'error', error: err.message });
    }
  }

  // ---- Class C: confirmation drift. -----------------------------------
  //
  // Runs BEFORE the escalation class as of v1.1. PARITY_MAX_WRITES is 25 and
  // Class B/D routinely produces 27 findings, so in the original order the
  // escalations consumed the entire budget and Class C never got a single
  // write — while 21 of those escalation "writes" were being discarded at
  // event intake anyway. The budget now goes to the classes that change state.
  //
  // NOT an auto-heal today, despite the original header. It emits an event and
  // nothing consumes it, so GHL is never actually confirmed. Counted as
  // `confirm_emitted` rather than `healed` until a consumer exists — calling it
  // a heal is how the old number lied.
  for (const [cid, lead] of lpBook) {
    const appt = ghlActive.get(cid);
    if (!appt) continue;
    if (lead.appointment_confirmed !== true) continue;
    if (appt.status === 'confirmed') continue;

    counts.confirmation_drift++;
    const finding = {
      class: 'confirmation_drift',
      contact_id: cid,
      ghl_appointment_id: appt.ghl_appointment_id,
      ghl_status: appt.status,
      action: 'confirm_in_ghl',
    };

    if (!canWrite()) {
      if (!dryRun) counts.write_ceiling_hit++;
      findings.push({ ...finding, executed: false });
      continue;
    }

    try {
      const res = await _emitEvent({
        event_type: 'appointment.confirmation_drift',
        event_subtype: 'lp_confirmed_ghl_not',
        source: 'appointment_parity_watchdog',
        entity_type: 'contact',
        entity_id: cid,
        ghl_contact_id: cid,
        payload: finding,
        priority: 'normal',
        idempotency_key: `parity_confirm_${appt.ghl_appointment_id}`,
      });
      writes++;
      const outcome = classifyEmit(res);
      outcomes[outcome === 'emitted' ? 'confirm_emitted' : outcome]++;
      findings.push({ ...finding, executed: outcome === 'emitted', outcome });
    } catch (err) {
      errors++;
      findings.push({ ...finding, executed: false, error: err.message });
    }
  }

  // ---- Class B / D: LP has it, GHL does not. ESCALATE. --------------
  //
  // Last of the three as of v1.1: these are notifications, and they must not
  // starve the classes that repair state. The ops card below is what actually
  // reaches a human — no agent_rule consumes appointment.parity_gap, so the
  // event alone reached nobody even before the intake filter dropped it.
  // Class E findings were built above but not yet emitted; they escalate on the
  // same budget and in the same order as B/D.
  const escalations = [
    ...findings.filter((f) => f.class === 'lp_cancelled_ghl_active'),
  ];

  for (const [cid, lead] of lpBook) {
    if (ghlActive.has(cid)) continue;
    const wasCancelled = ghlCancelled.has(cid);
    const cls = wasCancelled ? 'cancellation_drift' : 'ghl_missing_appointment';
    counts[cls]++;

    const finding = {
      class: cls,
      contact_id: cid,
      name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
      lp_appointment_date: lead.appointment_date,
      lp_disposition: lead.disposition_code,
      lp_prospect_id: lead.lp_prospect_id,
      action: 'escalate_to_rep',
    };
    escalations.push(finding);

    if (canWrite()) {
      try {
        const res = await _emitEvent({
          event_type: 'appointment.parity_gap',
          event_subtype: cls,
          source: 'appointment_parity_watchdog',
          entity_type: 'contact',
          entity_id: cid,
          ghl_contact_id: cid,
          payload: finding,
          priority: 'high',
          idempotency_key: `parity_${cls}_${cid}_${String(lead.appointment_date).slice(0, 13)}`,
        });
        writes++;
        const outcome = classifyEmit(res);
        outcomes[outcome === 'emitted' ? 'escalated' : outcome]++;
      } catch (err) { errors++; }
    } else if (!dryRun) {
      counts.write_ceiling_hit++;
    }
    findings.push(finding);
  }

  // Class E emits last — it is the newest class and the least understood, so it
  // yields budget to the classes that have been load-bearing for longer.
  for (const finding of escalations.filter((f) => f.class === 'lp_cancelled_ghl_active')) {
    if (!canWrite()) {
      if (!dryRun) counts.write_ceiling_hit++;
      continue;
    }
    try {
      const res = await _emitEvent({
        event_type: 'appointment.parity_gap',
        event_subtype: 'lp_cancelled_ghl_active',
        source: 'appointment_parity_watchdog',
        entity_type: 'contact',
        entity_id: finding.contact_id,
        ghl_contact_id: finding.contact_id,
        payload: finding,
        priority: 'high',
        idempotency_key: `parity_lp_cancelled_${finding.contact_id}_${String(finding.ghl_start).slice(0, 13)}`,
      });
      writes++;
      const outcome = classifyEmit(res);
      outcomes[outcome === 'emitted' ? 'escalated' : outcome]++;
    } catch (err) { errors++; }
  }

  const ghlCount = ghlActive.size;
  const lpCount = lpBook.size;
  const matched = [...ghlActive.keys()].filter(c => lpBook.has(c)).length;

  const summary = {
    success: true,
    as_of: asOf.toISOString(),
    window_days: PARITY_WINDOW_DAYS,
    ghl_contacts_with_appointment: ghlCount,
    lp_contacts_with_appointment: lpCount,
    matched_both_sides: matched,
    parity_pct: ghlCount + lpCount - matched > 0
      ? Number(((matched / (ghlCount + lpCount - matched)) * 100).toFixed(1))
      : 100,
    counts,
    outcomes,
    // Kept as top-level keys because /n8n/appointments/parity-check consumers
    // read them. Both now mean what they say.
    healed: outcomes.healed,
    escalated: outcomes.escalated,
    writes,
    errors,
    dry_run: !!dryRun,
    elapsed_ms: Date.now() - started,
  };
  // Findings always ride along now, not only on a dry run: the alert step below
  // needs them, and a live sweep is exactly when you want to see what it found.
  summary.findings = findings;

  // Every non-zero outcome is named. A sweep that repaired nothing now says so
  // in the same breath as one that did — which is the whole point of v1.1.
  const outcomeTail = Object.entries(outcomes)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(' ');

  console.log(
    `[ApptParity] GHL ${ghlCount} / LP ${lpCount} / matched ${matched} (${summary.parity_pct}%) — ` +
    `${counts.lp_missing_appointment} LP-missing, ${counts.ghl_missing_appointment} GHL-missing, ` +
    `${counts.confirmation_drift} confirm-drift, ${counts.cancellation_drift} cancel-drift, ` +
    `${counts.lp_cancelled_ghl_active} lp-cancelled-ghl-active — ` +
    `${outcomeTail || 'no writes attempted'}, ${errors} errors` +
    (counts.write_ceiling_hit ? `, ${counts.write_ceiling_hit} over write ceiling` : '') +
    (dryRun ? ' [DRY RUN]' : '')
  );

  await maybeAlertParityGaps(summary, { dryRun, deps });

  return summary;
}

/**
 * Announce NEW escalation-class gaps to the ops channel.
 *
 * Runs on dry-run sweeps too. The reporting half of this watchdog has nothing
 * to do with PARITY_AUTOHEAL — that flag governs whether we WRITE, and a gap
 * nobody is told about is the failure mode this whole module exists to prevent.
 * (2026-09-14: the watchdog ran dry for weeks and reported to nobody, then ran
 * live and still reported to nobody.)
 *
 * Edge-triggered per contact via claimAlertConditionSet, so ~27 standing gaps
 * announce once and only a genuinely new one speaks. A card every 30 minutes
 * would be muted within a day.
 */
async function maybeAlertParityGaps(summary, { dryRun, deps = {} } = {}) {
  const claim = deps.claimAlertConditionSet || claimAlertConditionSet;
  const confirm = deps.confirmAlertSend || confirmAlertSend;
  const send = deps.send || ((text) => sendGroupMeMessage(text, { channel: 'ops', noDedup: true }));
  const client = deps.client;

  const verdict = shouldAlertParityGaps({
    findings: summary.findings,
    errors: summary.errors,
    readOk: summary.success !== false,
  });

  // 'insufficient_evidence' — a sweep that could not read both books proves
  // nothing. Neither page nor clear; leave every claim exactly as it was.
  if (verdict.verdict !== 'alert') {
    if (verdict.verdict === 'insufficient_evidence') {
      console.warn(`[ApptParity] alert skipped — ${verdict.reason}`);
    }
    return { action: verdict.verdict };
  }

  const byKey = new Map(verdict.gaps.map((g) => [parityAlertKey(ALERT_PREFIX, g), g]));

  const claimed = await claim({
    prefix: ALERT_PREFIX,
    activeKeys: [...byKey.keys()],
    label: 'Appointment parity gap',
    detail: `${verdict.gaps.length} standing gap(s) as of ${summary.as_of}`,
    client,
  });

  // ok:false is "I could not tell" — the claim layer degraded. Announce
  // nothing rather than risk a duplicate or a bogus card.
  if (!claimed.ok) {
    console.warn(`[ApptParity] alert claim unavailable (${claimed.reason}) — not alerting this sweep`);
    return { action: 'claim_failed' };
  }
  if (claimed.newlyFiring.length === 0) {
    console.log(`[ApptParity] ${verdict.gaps.length} standing gap(s), none new — silent`);
    return { action: 'silent', newly: 0 };
  }

  const newGaps = claimed.newlyFiring.map((k) => byKey.get(k)).filter(Boolean);
  const text = formatParityGapCard(newGaps, {
    totalGaps: verdict.gaps.length,
    autoheal: !dryRun,
    healed: summary.outcomes.healed,
    alreadyPresent: summary.outcomes.already_present,
    dedupSuppressed: summary.outcomes.dedup_suppressed,
  });

  let sent = false;
  try {
    const r = await send(text);
    sent = r?.sent !== false;
  } catch (err) {
    console.error(`[ApptParity] alert send failed: ${err.message}`);
  }

  if (sent) {
    await confirm(claimed.newlyFiring, { client });
    console.log(`[ApptParity] alerted on ${newGaps.length} new gap(s)`);
    return { action: 'alerted', newly: newGaps.length };
  }

  // The claim already marked these announced, so without this they would never
  // be retried — a silently swallowed page. Release them so the next sweep
  // re-claims and tries again. Same posture as intake-journal.js.
  const releaseClient = client || supabase;
  await Promise.resolve(
    releaseClient.from('alert_conditions').delete().in('alert_key', claimed.newlyFiring),
  ).catch((err) => console.warn(`[ApptParity] claim release failed: ${err.message}`));
  return { action: 'send_failed', newly: newGaps.length };
}

// Exported for tests.
export const __testing = { classifyHealResult, classifyEmit, maybeAlertParityGaps, ALERT_PREFIX };

let handle = null;

export function startAppointmentParityScheduler() {
  if (handle) return;
  setTimeout(() => {
    runAppointmentParityWatchdog().catch(e => console.error('[ApptParity] run failed:', e.message));
    handle = setInterval(() => {
      runAppointmentParityWatchdog().catch(e => console.error('[ApptParity] run failed:', e.message));
    }, PARITY_INTERVAL_MS);
  }, 240000);
  console.log(`[ApptParity] Scheduler armed: ${PARITY_WINDOW_DAYS}d window, ${PARITY_INTERVAL_MS / 60000}min cadence, autoheal=${PARITY_AUTOHEAL}`);
}

export function registerAppointmentParityRoutes(app, authenticate = (req, res, next) => next()) {
  // authenticate is REQUIRED in practice — this route can run a live sweep that
  // writes to LP and GHL (POST {dryRun:false}). The permissive default exists
  // only so tests can mount the route without building an auth stack; index.js
  // passes the real middleware.
  app.post('/n8n/appointments/parity-check', authenticate, async (req, res) => {
    try {
      const dryRun = req.body?.dryRun !== false && !PARITY_AUTOHEAL ? true : req.body?.dryRun === true;
      res.json(await runAppointmentParityWatchdog({ dryRun }));
    } catch (err) {
      console.error('[ApptParity] route error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });
  console.log('[ApptParity] Registered: POST /n8n/appointments/parity-check');
}

export { planDncLift, OPERATIONAL_DNC_TAGS, CONSENT_OPTOUT_TAGS };
