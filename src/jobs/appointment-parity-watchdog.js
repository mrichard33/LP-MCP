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
 *      → NEVER for an appointment LP itself created, or a contact whose LP
 *        visit just happened (2026-10-16, src/appointments/lp-origin-guard.js:
 *        `lp_origin_drift`). Roberta Ritchie: GHL kept our sync's stale 10/17
 *        10 AM after LP moved and issued the visit, and Class A wrote it back
 *        onto her older lead 579742. Then GHL is the stale side; the drift fix
 *        and the post-appointment close own it. A failed read writes nothing.
 *      → AUTO-HEAL. Calls syncAppointmentToLP, the same orchestrator the
 *        webhook path uses: it resolves the LP lead through the 5-step
 *        chain and either runs LP SetAppointment or self-heals by enrolling
 *        the contact in workflow 8e30ff37 (addlead-with-appointment). No new
 *        LP write behaviour is introduced here.
 *
 *   B. ghl_missing_appointment — LP has an appointment in the window, GHL
 *      has none, or only a cancelled/past one.
 *      → AUTO-CREATE since 2026-10-16 (Mark, handoff v3.4: "GHL must match
 *        LP", replacing "escalate only"). The date is no longer the cache's:
 *        the create goes through src/services/mirror-on-link.js, which reads
 *        LP LIVE and runs the reconciler with its guards (stale mirror, year
 *        typo, impossible hour) plus its slot check and create claim. A guard
 *        refusal is never "add it to GHL": a bad LP date/hour is the "LP
 *        date/time looks wrong" card; LP unreadable, a visit inside 60 minutes
 *        or nothing live waits. Only a failed create, or a refusal a person
 *        must judge (a DNC contact, two estimate objects), escalates. The
 *        grace period and live GHL check below still run FIRST. Verif and
 *        ND / No Demo never reach this class (settled, readLpBook).
 *
 *   C. confirmation_drift      — LP says confirmed, GHL does not.
 *      → AUTO-HEAL since 2026-10-16 (Roberta Ritchie). Until then it only
 *        emitted appointment.confirmation_drift, which nothing consumes, so
 *        GHL was never confirmed (63 findings in 14 days). It now runs the same
 *        mirror path as Class B (LP live + the reconciler, which confirms a Set
 *        lead LP's checkbox marks confirmed — the user's ruling) and counts
 *        `confirm_healed` only when GHL changed. The event still goes out for
 *        audit; a heal that did not land is `confirm_emitted`, as before.
 *
 *   D. cancellation_drift      — GHL cancelled, LP still shows set.
 *      → ESCALATE. A cancellation that only half-landed usually means a
 *        human cancelled in one system; which system is authoritative is a
 *        judgement call, so a rep decides.
 *      → ONE exception (Badley, 2026-10-16, Fix 1.7): LP holds a live lead AND
 *        a cancelled duplicate at the SAME slot as the cancelled GHL row, and
 *        LP live confirms the live one — the duplicate's cancel is undone (Set
 *        → new, Cnf / Issue → confirmed) and the S5.2 / rebook tags come off
 *        (src/jobs/appointment-parity-heal.js). An `invalid` GHL row is SETTLED
 *        (Fix 8): never restored, never re-created over, never flagged —
 *        unless LP has since moved the lead to a different slot.
 *
 *   F. post-appointment close (2026-10-16, src/appointments/post-appointment-close.js)
 *      — a GHL estimate still new / confirmed after LP's visit time, with LP
 *        saying what happened: demo → showed (+ P1 → Appointment Completed),
 *        NoHome → noshow, CXL / CCC / NG → cancelled. POST_APPT_CLOSE_MODE
 *        (default shadow). Its writes count against PARITY_MAX_WRITES.
 *
 *   E. lp_cancelled_ghl_active — LP cancelled (CXL/CCC/NoHome/NG), GHL still
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
 * v1.5 — 2026-09-28 — CLASS B TRUSTED A STALE CACHE, AND AGED THE WRONG CLOCK
 *
 * Two false-positive sources in Class B, both seen on one card:
 * SANDRA WATSON / Rose Nelson, contact Bq3lxQMhFduSVV1FX7PF, LP lead 579074.
 *
 * 1. The GHL book comes from the HL Supabase `appointments` cache. The real
 *    GHL appointment PlB224EDUJYZJ2xnJ7mr was created 20:30:23Z and the
 *    reconciler confirmed already_in_sync at 20:35:50Z — but the cache never
 *    received the row, so the 20:37Z sweep escalated a booked customer.
 *    Fix: before escalating a Class B gap, read GHL LIVE for that contact
 *    (fetchUpcomingAppointments, the same lookup the reconciler uses). An
 *    active appointment inside the window suppresses the finding and is
 *    counted as ghl_missing_cache_stale. A failed lookup or an exhausted
 *    per-sweep budget ESCALATES exactly as before — the check can only
 *    remove a finding GHL itself contradicts, never hide one it cannot see.
 *
 * 2. The 90-minute grace aged the lead, not the appointment. This lead was
 *    created 9/27 and SET 9/28 16:28 ET, so it cleared the gate instantly.
 *    Fix: age from lp_leads.set_date when present (95% of future set rows);
 *    fall back to the v1.3 older-clock rule when it is not. set_date does not
 *    move on re-sync — only a genuine new set moves it — so the v1.3 concern
 *    (a re-sync resetting a row's age forever) does not apply to it.
 *
 * CLASS B ONLY. Classes D and E are untouched.
 *
 * ---------------------------------------------------------------------
 * v1.4 — 2026-09-21 — CCC IS A CANCELLATION AND WE WERE NOT READING IT AS ONE
 *
 * RESOLVED_DISPOSITIONS listed CXL / NoHome / NG and omitted CCC — Customer
 * Called to Cancel. So readLpBook put every CCC row in the ACTIVE book, and the
 * Class B/D loop compared it against GHL's cancelled row and called it
 * cancellation_drift: "Cancelled in GHL, still set in LP".
 *
 * Both systems agreed. The customer called, the appointment was cancelled in LP
 * AND in GHL, and the watchdog paged a rep about it anyway. The card is not a
 * near-miss or a stale read — it is wrong on its face, which is the fastest way
 * to get an ops channel muted, and a muted channel is how the 2026-08-02
 * 47-hour outage stayed invisible.
 *
 * Measured 2026-09-21: of the 50 appt_parity:gap:cancellation_drift:* keys in
 * alert_conditions, 33 are contacts currently sitting at CCC — two thirds of
 * that alarm's entire standing history was false. 4,299 lp_leads rows carry the
 * code, so this was never a rare shape.
 *
 * Worked example — Virginia Vargas, LP lead 577249 (contact 3uJGXPPwgvieYhcp9BE9),
 * appointment 2026-09-21 14:00, disposition CCC, GHL appointment cancelled.
 * Nothing about that contact needs a human.
 *
 * Fix: CCC joins RESOLVED_DISPOSITIONS. A CCC row now lands in the `resolved`
 * book, which turns the two cases the right way round:
 *   CCC + GHL cancelled  → both sides agree. No finding, no card. (Was Class D.)
 *   CCC + GHL ACTIVE     → Class E, lp_cancelled_ghl_active. LP gave the slot
 *                          up and GHL is still holding it — a rep is driving to
 *                          a cancelled appointment, which is the case that
 *                          actually warrants the page.
 *
 * The same reasoning that put CXL in the set in v1.2 applies unchanged; CCC was
 * simply missed. Before adding a disposition here, confirm it means the
 * appointment is RESOLVED and not merely re-dispositioned — a live code in this
 * set silently deletes a whole class of real findings.
 *
 * ---------------------------------------------------------------------
 * v1.3 — 2026-09-14 — CLASS B WAS ALARMING ON THE RECONCILER'S OWN LAG
 *
 * Class B escalated any contact with an LP appointment and no active GHL one,
 * with NO minimum age on the LP row. But the LP→GHL reconciler runs in BATCHES
 * every 30 minutes, and this watchdog runs on its own ~27-minute cadence, so it
 * samples BETWEEN batches. Everything booked in LP since the last batch reads
 * as a gap.
 *
 * Verified 2026-09-14 — six alerted contacts, all six self-healed with no human
 * touching them, every GHL appointment matching LP's date and time exactly:
 *   Gulliford  FivBslY9ggCiDhjuUSbA  alert 16:25 ET  appt created 17:00
 *   Syrja      KuqcgHXQ8tszYPn0m1HI  alert 16:25     appt created 16:30
 *   Williams   h11ktAUCjnIvXiMKZZdG  alert 16:25     appt created 16:30
 *   Miller     sw1wdenhbj6gtsJW0pLN  alert 16:52     appt created 17:00
 *   Schweitzer X5atTwAOiJANHiWRgDPt  alert 17:19     appt created 17:30
 *   Godwin     Qpb7g8n9ebG8F83IPVrW  alert 17:19     appt created 17:30
 * Zero real gaps in that sample. The GHL `created_at` timestamps cluster at :00
 * and :30 and are identical within each batch — that IS the reconciler cadence,
 * not a coincidence.
 *
 * Fix: PARITY_GHL_MISSING_MIN_AGE_MIN (default 90) — Class B skips an LP row
 * younger than the gate. Measured canvass-submit → GHL-appointment-created over
 * 30 days is p50 12.8 min, p90 46.7 min, p99 690 min, so 90 minutes suppresses
 * ~95% of the false positives while anything genuinely stranded is caught on
 * the next sweep (the gate delays a finding, it never drops one).
 *
 * CLASS B ONLY. Class E in particular keeps firing immediately: a CANCELLED LP
 * record against a live GHL slot is never a timing artifact.
 *
 * Suppressed findings are COUNTED (`ghl_missing_too_new`) and printed in the
 * summary line. A silent suppression is how an alarm becomes a blind spot —
 * a sweep that held twelve findings has to say so.
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
 *   PARITY_GHL_MISSING_MIN_AGE_MIN=90   Class B grace period (reconciler lag)
 *   PARITY_GHL_LIVE_CHECK=true          Class B live GHL read before escalating
 *   PARITY_GHL_LIVE_CHECK_MAX=40        per-sweep cap on those live reads
 */

import { alertDigestEnabled } from '../alert-posted.js';
import supabase from '../supabase.js';
import { getHlSupabase } from '../admin/hl-client.js';
import { emitEvent } from '../event-emitter.js';
import { syncAppointmentToLP } from '../lp-appointment-sync.js';
import { fetchUpcomingAppointments } from '../knowledge/contact-appointments.js';
import { isGhlOnlyCalendarId } from '../knowledge/booking-calendar-router.js';
import { normalizeGhlStartTime } from '../services/lp-ghl-appointment-reconciler.js';
import { getGHLContact } from '../ghl.js';
import { utcToLpStoredIso, lpStoredAgeMinutes } from '../lp-dates.js';
import { claimAlertConditionSet, confirmAlertSend, sendAlertMessage } from '../alert-state.js';
import { shouldAlertParityGaps, parityAlertKey, formatParityGapCard } from './appointment-parity-alerts.js';
import { isHoldDisposition, isDisqualifiedDisposition } from '../lp-disposition-classes.js';
import { mirrorLeadAppointment } from '../services/mirror-on-link.js';
import { readLiveForSync } from '../services/lp-live-appointment.js';
import { classBOutcome, restoreDecision, sameSlot, sameSlotDuplicateCandidate, S52_REBOOK_TAGS } from './appointment-parity-heal.js';
import { ghlFetch as defaultGhlFetch } from '../actions/helpers.js';
import { runEstimateDriftFix, readSyncCreatedStarts } from '../appointments/estimate-drift-io.js';
import { putReschedule } from '../services/lp-ghl-appointment-reconciler.js';
import { markRescheduleInflight } from '../services/reschedule-inflight.js';
import { resolveSyncLead, notifyLpLooksWrong } from '../actions/handlers/lp-ghl-appointment-sync.js';
import { lpOriginBlock, supersededByNewerLead, readLpOriginFacts } from '../appointments/lp-origin-guard.js';
import { runPostAppointmentClose } from '../appointments/post-appointment-close.js';
import { readLiveLpAppointment } from '../services/lp-live-appointment.js';

/** One agent_actions insert (deps seam: deps.queueAction). */
async function queueAgentAction(row) {
  const { error } = await supabase.from('agent_actions').insert(row);
  if (error) throw new Error(error.message);
}

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
    // 2026-10-06 — create_lp_lead's in1-only path (lp-lead-inbound-only.js):
    // the inquiry had been issued and the appointment was written to its lds.
    case 'inbound_issued_appt_set':
      return 'healed';
    // The inquiry was issued and already carried the appointment — LP has it.
    case 'inbound_issued_appt_present':
      return 'already_present';
    // Still waiting in LP's inbound queue, unreadable, or LP refused the
    // appointment on the issued lead. None of these wrote an appointment, so
    // none may count as a heal (the v1.1 lesson). inbound-checkout-watch
    // re-drives the waiting ones once LP issues them.
    case 'pending_lp_checkout':
    case 'inbound_unverified':
    case 'inbound_issued_appt_failed':
      return 'not_attempted';
    case 'already_set_in_lp':
    case 'already_in_lp_skipped_pre_resolve':
      // Parity read LP as MISSING this appointment while the sync path read it
      // as present. The two disagree, and that disagreement is its own finding
      // — not a heal, and not nothing.
      return 'already_present';
    case 'duplicate_sync_suppressed':
      return 'dedup_suppressed';
    // 2026-10-12 — LP refused the appointment (LP_APPT_GUARD_MODE=enforce), or
    // refused this lead + date + time in the last 24h. LP's answer, not a
    // repair and not an error; the refusal is an lp.appointment_refused event.
    case 'lp_appointment_refused':
    case 'lp_refusal_recent':
      return 'refused';
    case 'skipped_lp_unavailable':
    // 2026-10-08: syncAppointmentToLP refuses a GHL-only calendar and a lead
    // in a non-bookable disposition. Neither wrote anything.
    case 'skipped_ghl_only_calendar':
    case 'skipped_terminal_disposition':
    case 'deferred_pending_lp_issuance':
    case 'held_stale_inbound_holds_appointment':
    case 'past_appointment_left_asis':
    // 2026-10-09 — the post-issue rule (src/lp-post-issue-rebook.js) in live
    // mode. The watchdog never creates a lead: an issued lead is refused, and
    // an unreadable one fails closed. Neither wrote anything.
    case 'skipped_post_issue_lead':
    case 'post_issue_check_failed':
    case 'post_issue_needs_manual_lead':
    case 'newer_lead_pending_in_inbound_queue':
    case 'post_issue_send_failed':
    case 'post_issue_rebook_duplicate':
    // 2026-10-22 — the 15-day lead rule (services/lp-appointment-target.js).
    // The watchdog never "fixes" a mismatch by writing to a lead older than 15
    // days and never creates one: skipped_stale_lead. A new lead already on its
    // way (or an unreadable lookup): skipped_pending_create. An aged lead that
    // still holds a live appointment is a person's move in LP.
    case 'skipped_stale_lead':
    case 'skipped_pending_create':
    case 'skipped_aged_lead_live_appointment':
    case 'waiting_for_new_lead':
    case 'skipped_no_ghl_booking':
    case 'new_lead_queue_failed':
      return 'not_attempted';
    // Not reachable from the watchdog (it never creates), listed so a future
    // caller change surfaces as heal_enrolled rather than unknown_result.
    case 'routed_to_new_lead':
      return 'heal_enrolled';
    case 'lp_lead_creation_enrolled':
    case 'create_lead_already_enrolled':
    case 'enrolled_lead_creation_workflow':
      // The self-heal path: no LP appointment yet, but the contact is enrolled
      // in the addlead-with-appointment workflow that creates one. Real work,
      // not yet a repair — it lands (or does not) on a later sweep.
      //
      // THREE SPELLINGS, ONE OUTCOME. All three mean "enrolled in workflow
      // 8e30ff37", and they are spread across two modules:
      //   lp_lead_creation_enrolled      src/lp-appointment-sync.js
      //   enrolled_lead_creation_workflow  enrollLpLeadCreation success path
      //   create_lead_already_enrolled     enrollLpLeadCreation dedup path
      // Both of the latter come out of the SAME function in
      // src/admin/lp-force-addlead.js, which is why missing one was easy.
      //
      // Each was added only after a live run returned it and it landed in
      // unknown_result — create_lead_already_enrolled on 2026-09-14,
      // enrolled_lead_creation_workflow on 2026-09-15, in the very first sweep
      // after PARITY_AUTOHEAL was switched on (contact pbTY7u8gVQcXv9fMm58g).
      // That bucket is doing its job: it surfaces an unenumerated action
      // instead of quietly inflating the heal count. Before adding a new
      // return value to either module, add it here too.
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

// Class B grace period — see the v1.3 block above. The LP→GHL reconciler runs
// in batches every 30 minutes and this sweep runs between batches, so a
// freshly-booked LP row has not had its turn yet and is not a gap.
const PARITY_GHL_MISSING_MIN_AGE_MIN = Number(process.env.PARITY_GHL_MISSING_MIN_AGE_MIN || 90);

// v1.5 — live GHL read before a Class B escalation. Read-only. ON by default:
// it can only suppress a finding GHL itself contradicts. Set 'false' to disable.
const PARITY_GHL_LIVE_CHECK = process.env.PARITY_GHL_LIVE_CHECK !== 'false';
const PARITY_GHL_LIVE_CHECK_MAX = Number(process.env.PARITY_GHL_LIVE_CHECK_MAX || 40);

// fetchUpcomingAppointments filters only cancelled/noshow/no-show, so re-filter
// the full dead-status set (same list the reconciler uses).
const NON_ACTIVE_GHL_LIVE_STATUSES = new Set([
  'cancelled', 'canceled', 'no_show', 'noshow', 'no-show', 'invalid',
]);

const ACTIVE_GHL_STATUSES = ['new', 'confirmed'];

// LP dispositions that mean the appointment is resolved, not pending.
//   CXL     cancelled
//   CCC     Customer Called to Cancel — added 2026-09-21, see v1.4 above
//   NoHome  not home for the appointment
//   NG      not given / no good
const RESOLVED_DISPOSITIONS = new Set(['CXL', 'CCC', 'NoHome', 'NG']);

// 2026-10-16 (Mark, handoff v3.4) — SETTLED dispositions: GHL is in sync with
// them WHATEVER it holds, so they are never a gap and never auto-fixed here.
//   Verif        a hold ("there is an issue with the lead"); no automation of
//                any kind, so a GHL appointment is neither created, restored,
//                written back to LP nor flagged.
//   ND, No Demo  disqualified; LP_DISP_DISQUALIFIED marks an open GHL estimate
//                `invalid`, and cancelled / invalid / none is the end state.
function isSettledDisposition(code) {
  return isHoldDisposition(code) || isDisqualifiedDisposition(code);
}

// Operational DNC — liftable on a genuine opt-back-in.
const OPERATIONAL_DNC_TAGS = ['dnc', 'dnc-related', 'stage:dnc', 'lp-dnc'];

// Consent-level opt-out — NEVER liftable. See the DNC block above.
// 2026-10-07: stop-bot is the bot-off switch, not a consent opt-out (the
// user's ruling); it is still never lifted by a booking, so it keeps its
// own list with the same treatment.
const BOT_OFF_TAGS = ['stop-bot'];
const CONSENT_OPTOUT_TAGS = ['unsubscribed', 'optedOut', ...BOT_OFF_TAGS];

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
  return bucketGhlBook(data);
}

/**
 * Class F's GHL read (2026-10-16): every estimate-pool row from the look-back
 * on, any status (closeCandidates keeps the open ones). HL mirror, read-only.
 */
async function readGhlCloseRows(fromIso, toIso) {
  const hl = getHlSupabase();
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await hl
      .from('appointments')
      .select('ghl_contact_id, ghl_appointment_id, status, start_time, ghl_calendar_id')
      .is('deleted_at', null)
      .gte('start_time', fromIso)
      .lt('start_time', toIso)
      .in('status', ['new', 'confirmed'])
      .order('start_time', { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(`GHL close read: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

/** Class F's lead read: every lp_leads row per contact (Map cid → rows). */
async function readContactLeads(contactIds) {
  const out = new Map();
  for (let i = 0; i < contactIds.length; i += 100) {
    const { data, error } = await supabase.from('lp_leads')
      .select('lp_lead_id, lp_prospect_id, ghl_contact_id, disposition_code, appointment_date, synced_at, updated_at_lp, created_at_lp, set_date, last_contact_date')
      .in('ghl_contact_id', contactIds.slice(i, i + 100));
    if (error) throw new Error(`lp_leads read failed: ${error.message}`);
    for (const r of data || []) {
      if (!out.has(r.ghl_contact_id)) out.set(r.ghl_contact_id, []);
      out.get(r.ghl_contact_id).push(r);
    }
  }
  return out;
}

/**
 * Pure. Bucket GHL appointment rows into active / cancelled, earliest per contact.
 *
 * GHL-ONLY CALENDARS ARE NOT IN THE BOOK (2026-10-08). A Confirmation Call is a
 * phone touch that LP must never hold, so it can never be a parity gap. Before
 * this, contact 5YGVd3kh5IcY6pUJVcs4's only GHL appointment was a Confirmation
 * Call (JrH56gkBz5uluIHqRUor): Class A read it as "LP is missing the estimate"
 * and auto-healed it into LP lead 581695 (OPPFDN → Set), and the reconciler
 * then created a Window Estimate at the same slot. Dropping the rows here keeps
 * them out of every class: A/E (sync to LP), C (confirmation_drift, which must
 * compare LP's estimate with GHL's estimate, not with the call), and B/D (an
 * earlier call would otherwise stand in for the estimate as "earliest").
 */
function bucketGhlBook(rows) {
  const active = new Map();   // cid -> earliest active appointment
  const cancelled = new Map();
  for (const row of rows || []) {
    if (!row.ghl_contact_id) continue;
    if (isGhlOnlyCalendarId(row.ghl_calendar_id)) continue;
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
 *   resolved — appointments whose disposition is CXL / CCC / NoHome / NG.
 *              CCC (Customer Called to Cancel) joined the set 2026-09-21; see
 *              the v1.4 block above for what its absence cost.
 *
 * Before v1.2 the resolved rows were simply dropped, which made "LP cancelled
 * this appointment" indistinguishable from "LP never had this appointment".
 * That is a real difference and it had a real cost — see Class E below.
 */
async function readLpBook(from, to, deps = {}) {
  // deps seam per CLAUDE.md — anything reaching the database stays injectable.
  // Added 2026-09-15 so the sentinel guard below can be tested against a
  // BACKWARDS-WIDENED window, which is the only configuration where it fires.
  const db = deps.supabase || supabase;
  const { data, error } = await db
    .from('lp_leads')
    // created_at_lp rides along for the Class B grace period (v1.3). Both LP
    // clocks are needed: see lpRowAgeMinutes.
    // 2026-10-16: synced_at / last_contact_date / lead_source / set_by_name ride
    // along for the Class B create (the reconciler's guards and the Fix 4 card).
    .select('ghl_contact_id, lp_lead_id, lp_prospect_id, first_name, last_name, disposition_code, appointment_set, appointment_confirmed, appointment_date, set_date, created_at_lp, updated_at_lp, synced_at, last_contact_date, lead_source, set_by_name')
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
  const settled = new Map();
  const keepNewest = (map, row) => {
    const prev = map.get(row.ghl_contact_id);
    if (!prev) { map.set(row.ghl_contact_id, row); return; }
    const a = row.updated_at_lp ? new Date(row.updated_at_lp).getTime() : 0;
    const b = prev.updated_at_lp ? new Date(prev.updated_at_lp).getTime() : 0;
    if (a > b) map.set(row.ghl_contact_id, row);
  };

  for (const row of data || []) {
    // LP's null sentinel for "no appointment" is a pre-epoch date, not NULL:
    // appointment_set=true with appointment_date=1900-01-01T14:00:00+00:00.
    // 71 such rows exist (measured 2026-09-15). A sentinel is ABSENCE, so the
    // row must never be read as an appointment LP holds.
    //
    // Today this is defence-in-depth and nothing more: the query's lower bound
    // is now(), so a 1900 date cannot come back, and this guard drops zero rows
    // on a live sweep. It is here because the bound is the ONLY thing stopping
    // it — widen the window backwards (a "what did we miss last week" pass would)
    // and every one of those 71 rows becomes a fabricated Class B gap against a
    // real customer. Keep the guard at the row level so that change stays safe.
    if (isSentinelAppointmentDate(row.appointment_date)) continue;
    if (isSettledDisposition(row.disposition_code)) { keepNewest(settled, row); continue; }
    keepNewest(RESOLVED_DISPOSITIONS.has(row.disposition_code) ? resolved : book, row);
  }
  return { active: book, resolved, settled };
}

// LP writes a pre-epoch date rather than NULL when a lead has no appointment,
// so appointment_set=true can sit against 1900-01-01. Anything before this is a
// sentinel, never a booking — Reece has no appointment history before 2000.
const SENTINEL_APPOINTMENT_BEFORE_MS = Date.UTC(2000, 0, 1);

/**
 * True when appointment_date is LP's "no appointment" sentinel rather than a date.
 *
 * Unparseable counts as a sentinel too: a date we cannot read is not evidence
 * that LP holds an appointment, and Class B escalates a human on exactly that
 * claim. This is the opposite posture to lpRowAgeMinutes, where an unreadable
 * clock must NOT suppress a finding — there the unknown is the row's age and
 * silence would hide a real gap; here the unknown is whether the appointment
 * exists at all, and inventing one pages somebody about a customer who has none.
 */
function isSentinelAppointmentDate(value) {
  if (!value) return true;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) return true;
  return ms < SENTINEL_APPOINTMENT_BEFORE_MS;
}

/**
 * How old an lp_leads row is, in real minutes, for the Class B grace period.
 *
 * Two things this must get right, both of which have burned someone here:
 *
 * 1. THE CLOCKS ARE ET WALL-CLOCK WEARING A +00:00 OFFSET. created_at_lp and
 *    updated_at_lp are written through lpDateToEastern(), so subtracting them
 *    from a true-UTC Date.now() reads every row as ~4 h OLDER than it is —
 *    which would let a row booked ten minutes ago clear a 90-minute gate and
 *    defeat the whole change. lpStoredAgeMinutes() does the conversion (and the
 *    DST two-pass) — see the READ SIDE block in src/lp-dates.js. This is the
 *    same class of defect as duplicate-lead-guard.js 2026-09-04.
 *
 * 2. THE OLDER CLOCK WINS. updated_at_lp moves on every re-sync, so gating on
 *    it alone would let a long-standing row reset its own age each time LP
 *    touched it and hide a real gap forever. We take the greater of the two
 *    ages — the earlier clock — so a re-sync can never make a row look newer.
 *
 * Returns null when NEITHER clock is parseable. The caller escalates in that
 * case: "I cannot tell how old this is" must not silence a gap, because a gap
 * nobody is told about is the failure this whole module exists to prevent.
 */
function lpRowAgeMinutes(row, nowMs = Date.now()) {
  // v1.5: the appointment's own clock wins when LP gave us one. set_date is in
  // the same ET-wall-clock frame as the other LP clocks, so the same converter
  // applies. A negative age (set_date in the future) is bad data — fall back.
  if (row?.set_date) {
    const setAge = lpStoredAgeMinutes(row.set_date, nowMs);
    if (Number.isFinite(setAge) && setAge >= 0) return setAge;
  }
  const ages = [row?.created_at_lp, row?.updated_at_lp]
    .map((stamp) => lpStoredAgeMinutes(stamp, nowMs))
    .filter((n) => Number.isFinite(n));
  return ages.length ? Math.max(...ages) : null;
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
  const _fetchUpcomingAppointments = deps.fetchUpcomingAppointments || fetchUpcomingAppointments;

  // ONE captured instant for both books — see SAFETY above.
  const asOf = new Date();
  const windowEnd = new Date(asOf.getTime() + PARITY_WINDOW_DAYS * 86400000);

  const [{ active: ghlActive, cancelled: ghlCancelled }, { active: lpBook, resolved: lpResolved, settled: lpSettled = new Map() }] =
    await Promise.all([
      _readGhlBook(asOf, windowEnd),
      _readLpBook(asOf, windowEnd),
    ]);

  // ---- Fix 8: sync-created estimates that drifted from LP (2026-10-16) ----
  // Behind ESTIMATE_DRIFT_FIX_MODE (default shadow); its own cap of 25, apart
  // from PARITY_MAX_WRITES. Runs first so a corrected time is not read as a gap.
  let drift = null;
  try {
    drift = await (deps.runEstimateDriftFix || runEstimateDriftFix)({
      ghlActive, dryRun, deps: {
        readSyncCreatedStarts: deps.readSyncCreatedStarts || ((ids) => readSyncCreatedStarts(supabase, ids)),
        resolveLead: deps.resolveOwningLead || (async (cid) => (await resolveSyncLead({}, {}, cid)).lead),
        readLive: deps.readLiveForSync || readLiveForSync,
        putReschedule: deps.putReschedule || putReschedule,
        markRescheduleInflight: deps.markRescheduleInflight || markRescheduleInflight,
        queueRows: deps.queueRows || (async (rows) => { const { error } = await supabase.from('agent_actions').insert(rows); if (error) throw new Error(error.message); }),
        notify: deps.notifyLpLooksWrong || notifyLpLooksWrong,
        emitEvent: _emitEvent,
        sendAlert: deps.send || sendAlertMessage,
      },
    });
  } catch (err) {
    console.warn(`[ApptParity] drift fix failed (watchdog continues): ${err.message}`);
  }

  // ---- Class F: close estimates after the visit (2026-10-16) ----
  // Behind POST_APPT_CLOSE_MODE (default shadow). Runs before the classes so a
  // closed appointment is not then read as a gap. Its writes share the budget.
  let close = null;
  try {
    close = await (deps.runPostAppointmentClose || runPostAppointmentClose)({
      dryRun, deps: {
        cap: PARITY_MAX_WRITES,
        readGhlRows: deps.readGhlCloseRows || readGhlCloseRows,
        readLeads: deps.readContactLeads || readContactLeads,
        readLive: deps.readLiveLpAppointment || ((lead) => readLiveLpAppointment(lead.lp_lead_id)),
        putAppointment: deps.putAppointment || ((id, body) => (deps.ghlFetch || defaultGhlFetch)('PUT', `/calendars/events/appointments/${id}`, body)),
        queueAction: deps.queueAction || queueAgentAction,
        emitEvent: deps.emitEvent || emitEvent,
      },
    });
  } catch (err) {
    console.warn(`[ApptParity] post-appointment close failed (watchdog continues): ${err.message}`);
  }

  const findings = [];
  let writes = close?.writes || 0;
  let errors = 0;
  let liveChecks = 0;   // v1.5 — Class B live GHL reads this sweep
  const counts = {
    lp_missing_appointment: 0,
    ghl_missing_appointment: 0,
    // v1.3: Class B findings held back because the LP row is younger than the
    // reconciler's batch cadence. Counted rather than dropped — a suppression
    // nobody can see is how an alarm turns into a blind spot.
    ghl_missing_too_new: 0,
    // v1.5: Class B findings GHL contradicted on a live read (cache was stale),
    // and live reads that failed (those findings still escalate).
    ghl_missing_cache_stale: 0,
    ghl_live_check_failed: 0,
    confirmation_drift: 0,
    cancellation_drift: 0,
    lp_cancelled_ghl_active: 0,
    dnc_lifted: 0,
    dnc_partial_lift: 0,
    dnc_blocked_consent: 0,
    write_ceiling_hit: 0,
    // 2026-10-16: GHL active against a Verif / ND / No Demo LP row — in sync by rule.
    settled_in_sync: 0,
    // 2026-10-16 (handoff v3.4): LP→GHL heals and their refusals.
    invalid_settled: 0,       // GHL holds an `invalid` at LP's slot — settled (Fix 8.5)
    ghl_created: 0,           // Class B created in GHL (Fix 3.2)
    ghl_create_deferred: 0,   // LP unreadable, too late, nothing live — next sweep
    lp_looks_wrong: 0,        // bad LP date/hour — a person fixes LP (Fix 4)
    same_slot_restored: 0,    // a duplicate's cancel undone (Fix 1.7)
    // 2026-10-16 (Roberta Ritchie): Class A refusals — GHL is the stale side.
    lp_origin_drift: 0,       // our sync made it, or LP's visit just happened
    lp_origin_unreadable: 0,  // could not tell — no LP write this sweep
    ghl_create_superseded: 0, // Class B: a newer lead on the prospect owns the visit
  };

  // Class A / B need each contact's LP history (lp-origin-guard.js). One read,
  // before either loop. A failed read: Class A writes nothing to LP (fail
  // closed), Class B behaves as before.
  const originCandidates = new Map();
  for (const [cid, appt] of ghlActive) {
    if (!lpBook.has(cid) && !lpResolved.has(cid) && !lpSettled.has(cid)) originCandidates.set(cid, appt);
  }
  for (const cid of lpBook.keys()) if (!ghlActive.has(cid)) originCandidates.set(cid, null);
  let origin = null;
  let originError = null;
  try {
    origin = await (deps.readLpOrigin || ((candidates) => readLpOriginFacts({
      candidates, db: supabase,
      readSyncCreatedStarts: deps.readSyncCreatedStarts || ((ids) => readSyncCreatedStarts(supabase, ids)),
    })))(originCandidates);
  } catch (err) {
    originError = err;
    console.warn(`[ApptParity] LP-origin read failed — no Class A write to LP this sweep: ${err.message}`);
  }

  const _mirror = deps.mirrorLeadAppointment || mirrorLeadAppointment;
  const _readLive = deps.readLiveForSync || readLiveForSync;
  const _ghlFetch = deps.ghlFetch || defaultGhlFetch;
  const _queueAction = deps.queueAction || queueAgentAction;

  // Class B → create in GHL. Returns 'handled' when no escalation is owed.
  async function tryCreateMissing({ cid, lead }) {
    const finding = { class: 'ghl_missing_appointment', contact_id: cid, name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim(), lp_lead_id: lead.lp_lead_id, lp_appointment_date: lead.appointment_date, lp_disposition: lead.disposition_code, action: 'create_in_ghl' };
    // Report mode: the gap is reported as it always was, marked as a create.
    if (dryRun) return 'dry';
    if (!canWrite()) {
      counts.write_ceiling_hit++;
      counts.ghl_missing_appointment++;   // found, not yet created — still a gap
      findings.push({ ...finding, executed: false, would_create: true });
      return 'handled';   // the next sweep creates it; no person is owed a card
    }
    let rec;
    try {
      rec = await _mirror({ contactId: cid, lead });
    } catch (err) {
      errors++;
      console.warn(`[ApptParity] Class B create failed for ${cid}: ${err.message} — escalating`);
      return 'escalate';
    }
    const o = classBOutcome(rec);
    if (o.kind === 'created') {
      writes++;
      counts.ghl_created++;
      findings.push({ ...finding, executed: true, outcome: rec.outcome, appointment_id: rec.appointment_id || null });
      await emitAutoFixed(cid, 'ghl_created', { lp_lead_id: lead.lp_lead_id, appointment_id: rec.appointment_id || null });
      return 'handled';
    }
    if (o.kind === 'in_sync') { outcomes.already_present++; return 'handled'; }
    if (o.kind === 'lp_looks_wrong') {
      counts.lp_looks_wrong++;
      findings.push({ ...finding, class: 'lp_looks_wrong', reason: o.reason, action: 'fix_in_lp' });
      return 'handled';
    }
    if (o.kind === 'deferred') {
      counts.ghl_create_deferred++;
      findings.push({ ...finding, executed: false, deferred: o.reason });
      return 'handled';
    }
    return 'escalate';
  }

  // Class D, Badley case → restore. Returns 'handled' when no escalation is owed.
  async function tryRestoreSameSlot({ cid, lead, cancelledRow, resolvedRow }) {
    // Pure pre-check first: no LP read unless a same-slot duplicate exists.
    if (!sameSlotDuplicateCandidate({ lead, resolvedRow, cancelledAppt: cancelledRow })) return 'escalate';
    let live;
    try { live = await _readLive(lead, { dryRun }); } catch { return 'escalate'; }
    const d = restoreDecision({ lead, resolvedRow, cancelledAppt: cancelledRow, live });
    if (!d.restore) return 'escalate';
    const finding = { class: 'cancellation_drift', contact_id: cid, name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim(), ghl_appointment_id: cancelledRow.ghl_appointment_id, lp_lead_id: lead.lp_lead_id, cancel_lead_id: resolvedRow?.lp_lead_id || null, action: 'restore_in_ghl', status: d.status };
    if (!canWrite()) {
      if (!dryRun) counts.write_ceiling_hit++;
      findings.push({ ...finding, executed: false, would_restore: true });
      return 'handled';
    }
    try {
      await _ghlFetch('PUT', `/calendars/events/appointments/${cancelledRow.ghl_appointment_id}`, { appointmentStatus: d.status });
      writes++;
      counts.same_slot_restored++;
      await _queueAction({
        action_type: 'remove_tag', target_system: 'ghl', target_entity: 'contact', target_id: cid,
        action_payload: { tags: [...S52_REBOOK_TAGS], claim_key: `parity-restore:${cancelledRow.ghl_appointment_id}:tags` },
        // lead-id-ok: action reasoning; the Slack net strips it on an approval card
        reasoning: `Restored appointment ${cancelledRow.ghl_appointment_id} (${d.status}): the cancel came from duplicate lead ${resolvedRow?.lp_lead_id || '?'} at the same slot as live lead ${lead.lp_lead_id}; S5.2 / rebook tags off.`,
        rule_applied: 'PARITY_SAME_SLOT_RESTORE', status: 'pending', requires_approval: false, priority: 30,
      }).catch((err) => console.warn(`[ApptParity] restore tag cleanup not queued for ${cid}: ${err.message}`));
      findings.push({ ...finding, executed: true });
      await emitAutoFixed(cid, 'same_slot_restored', { appointment_id: cancelledRow.ghl_appointment_id, status: d.status, lp_lead_id: lead.lp_lead_id });
      return 'handled';
    } catch (err) {
      errors++;
      console.warn(`[ApptParity] restore failed for ${cid}: ${err.message} — escalating`);
      return 'escalate';
    }
  }

  // One low-priority event per heal: the morning digest's "Auto-fixed" count.
  async function emitAutoFixed(cid, subtype, payload) {
    try {
      await _emitEvent({
        event_type: 'appointment.parity_auto_fixed', event_subtype: subtype, source: 'appointment_parity_watchdog',
        entity_type: 'contact', entity_id: cid, ghl_contact_id: cid, payload, priority: 'low', bypass_filter: true,
        idempotency_key: `parity_fixed_${subtype}_${cid}_${payload?.appointment_id || payload?.lp_lead_id || ''}_${asOf.toISOString().slice(0, 13)}`,
      });
    } catch { /* telemetry only */ }
  }

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
    refused: 0,            // LP refused the appointment (LP_APPT_GUARD_MODE=enforce)
    unknown_result: 0,     // unrecognised action — logged raw
    escalated: 0,          // parity_gap event that actually inserted
    confirm_emitted: 0,    // confirmation_drift event that actually inserted (heal did not land)
    confirm_healed: 0,     // 2026-10-16: GHL confirmed (or moved + confirmed) to LP
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
    // Verif / ND / No Demo: settled, whatever GHL holds (2026-10-16).
    if (lpSettled.has(cid)) { counts.settled_in_sync++; continue; }
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
    if (lpSettled.has(cid)) continue;   // counted once, in the Class E loop
    // LP is the authority (2026-10-16, Roberta Ritchie): never write back an
    // appointment LP created, or one for a contact whose LP visit just
    // happened. Could not tell → write nothing.
    if (originError) {
      counts.lp_origin_unreadable++;
      findings.push({ class: 'lp_missing_appointment', contact_id: cid, ghl_appointment_id: appt.ghl_appointment_id, ghl_start: appt.start_time, action: 'none', executed: false, outcome: 'lp_origin_unreadable' });
      continue;
    }
    const block = lpOriginBlock({
      syncCreated: origin?.syncCreated?.has(appt.ghl_appointment_id) || false,
      leads: origin?.leadsByContact?.get(cid) || [],
      nowMs: asOf.getTime(),
    });
    if (block.block) {
      counts.lp_origin_drift++;
      findings.push({ class: 'lp_origin_drift', contact_id: cid, ghl_appointment_id: appt.ghl_appointment_id, ghl_start: appt.start_time, ghl_status: appt.status, reason: block.reason, lp_lead_id: block.lp_lead_id || null, action: 'none' });
      continue;
    }

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
      // calendarId rides along so syncAppointmentToLP's own GHL-only refusal
      // backs up the bucketGhlBook filter (2026-10-08).
      const result = await _syncAppointmentToLP({
        contactId: cid,
        appointmentDate: start.toISOString().slice(0, 10),
        appointmentTime: start.toLocaleTimeString('en-US', {
          timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true,
        }),
        calendarId: appt.ghl_calendar_id || undefined,
        // An automatic repair writes only onto a bookable lead (the user,
        // 2026-10-09); a person's rebook of a cancelled lead is allowed.
        requireBookable: true,
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

  // ---- Class C: confirmation drift. AUTO-HEAL (2026-10-16). -----------
  //
  // Runs BEFORE the escalation class as of v1.1. PARITY_MAX_WRITES is 25 and
  // Class B/D routinely produces 27 findings, so in the original order the
  // escalations consumed the entire budget and Class C never got a single
  // write — while 21 of those escalation "writes" were being discarded at
  // event intake anyway. The budget now goes to the classes that change state.
  //
  // Until 2026-10-16 this only emitted an event nothing consumed, so GHL was
  // never confirmed (Roberta Ritchie sat confirmed in LP, `new` in GHL). It now
  // heals through the Class B mirror path: LP live, the reconciler's guards,
  // and its confirm / reschedule_confirm (a Set lead LP's checkbox marks
  // confirmed is confirmed — the user's ruling). The event stays, for audit.
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
      lp_lead_id: lead.lp_lead_id || null,
      disposition_code: lead.disposition_code || null,
      action: 'confirm_in_ghl',
    };

    if (!canWrite()) {
      if (!dryRun) counts.write_ceiling_hit++;
      findings.push({ ...finding, executed: false });
      continue;
    }

    // The heal. One write from the budget whatever it did; a refusal or an
    // error falls through to the audit event below as before.
    let healed = false;
    try {
      const rec = await _mirror({ contactId: cid, lead });
      const o = classBOutcome(rec);
      finding.outcome = rec?.outcome === 'noop' ? (rec?.reason || 'noop') : rec?.outcome;
      if (o.kind === 'created') {
        healed = true;
        outcomes.confirm_healed++;
        await emitAutoFixed(cid, 'confirmed', { appointment_id: rec.appointment_id || appt.ghl_appointment_id, lp_lead_id: lead.lp_lead_id });
      } else if (o.kind === 'lp_looks_wrong') {
        counts.lp_looks_wrong++;
      }
    } catch (err) {
      errors++;
      finding.outcome = 'error';
      console.warn(`[ApptParity] Class C confirm failed for ${cid}: ${err.message}`);
    }
    writes++;

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
        idempotency_key: `parity_confirm_${appt.ghl_appointment_id}${healed ? '_healed' : ''}`,
      });
      const outcome = classifyEmit(res);
      if (!healed) outcomes[outcome === 'emitted' ? 'confirm_emitted' : outcome]++;
      findings.push({ ...finding, executed: healed || outcome === 'emitted', healed });
    } catch (err) {
      if (!healed) errors++;
      findings.push({ ...finding, executed: healed, healed, error: err.message });
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
    const cancelledRow = ghlCancelled.get(cid) || null;
    let cls = cancelledRow ? 'cancellation_drift' : 'ghl_missing_appointment';

    // 2026-10-16 (handoff v3.4 Fix 8.5): `invalid` is the settled kill status —
    // never restored, never re-created over, never flagged as missing. Only a
    // lead that has since moved to a DIFFERENT slot gets a fresh create.
    if (cancelledRow && String(cancelledRow.status || '').toLowerCase() === 'invalid') {
      if (sameSlot(cancelledRow.start_time, lead.appointment_date)) { counts.invalid_settled++; continue; }
      cls = 'ghl_missing_appointment';
    }

    // 2026-10-16 (Fix 1.7): a duplicate lead's cancel at the same slot is
    // restored to the status LP implies; every other cancellation_drift
    // escalates exactly as before.
    if (cls === 'cancellation_drift') {
      const r = await tryRestoreSameSlot({ cid, lead, cancelledRow, resolvedRow: lpResolved.get(cid) || null });
      if (r === 'handled') continue;
    }

    // 2026-10-16 (Roberta Ritchie): a newer lead on the contact / prospect
    // owns the visit (it holds a live one, or its demo just happened). Then
    // this older row is not a GHL appointment to create — the watchdog itself
    // had written GHL's stale time onto her older lead 579742.
    if (cls === 'ghl_missing_appointment' && origin) {
      const sup = supersededByNewerLead({ lead, leads: origin.leadsByContact?.get(cid) || [], nowMs: asOf.getTime() });
      if (sup.superseded) {
        counts.ghl_create_superseded++;
        findings.push({ class: 'ghl_missing_appointment', contact_id: cid, lp_lead_id: lead.lp_lead_id, executed: false, deferred: sup.reason, newer_lp_lead_id: sup.lp_lead_id, action: 'none' });
        continue;
      }
    }

    // v1.3 grace period — CLASS B ONLY. The LP→GHL reconciler runs in batches
    // every 30 minutes and this sweep samples between them, so an LP row booked
    // since the last batch has simply not had its turn yet. Six-for-six on
    // 2026-09-14: every alerted contact self-healed on the next batch.
    //
    // cancellation_drift is deliberately NOT gated: GHL already ACTED on that
    // appointment (it holds a cancelled row), so nothing is pending and the
    // divergence is not a timing artifact. Class E is likewise ungated above.
    //
    // A null age means neither LP clock parsed — escalate, do not suppress.
    if (cls === 'ghl_missing_appointment') {
      const ageMin = lpRowAgeMinutes(lead, asOf.getTime());
      if (ageMin !== null && ageMin < PARITY_GHL_MISSING_MIN_AGE_MIN) {
        counts.ghl_missing_too_new++;
        continue;   // no finding, no event, no ops card — it rides the next sweep
      }

      // v1.5 — the GHL book above is a CACHE. Before paging a human that GHL is
      // missing an appointment, ask GHL. Suppress only on a positive, in-window,
      // active hit. Failure or budget exhaustion falls through and escalates.
      if (PARITY_GHL_LIVE_CHECK && liveChecks < PARITY_GHL_LIVE_CHECK_MAX) {
        liveChecks++;
        try {
          const live = await _fetchUpcomingAppointments(cid);
          if (Array.isArray(live)) {
            const hit = live.find((a) => {
              if (NON_ACTIVE_GHL_LIVE_STATUSES.has(String(a?.status || '').toLowerCase())) return false;
              // A Confirmation Call is not the estimate GHL is missing (2026-10-08).
              if (isGhlOnlyCalendarId(a?.calendar_id)) return false;
              const ms = Date.parse(normalizeGhlStartTime(a?.start_time) || '');
              return Number.isFinite(ms) && ms >= asOf.getTime() && ms < windowEnd.getTime();
            });
            if (hit) {
              counts.ghl_missing_cache_stale++;
              console.warn(`[ApptParity] ${cid}: GHL live holds ${hit.appointment_id} (${hit.status}) — HL cache missing it, not escalating`);
              continue;
            }
          } else {
            counts.ghl_live_check_failed++;   // null = lookup failed; escalate below
          }
        } catch (err) {
          counts.ghl_live_check_failed++;
          console.warn(`[ApptParity] live GHL check failed for ${cid} (escalating): ${err.message}`);
        }
      }
    }

    // 2026-10-16 (Fix 3.2, Mark: GHL must match LP — replaces "Class B
    // escalate only"): create through the one mirror path. A guard refusal is
    // never "add it to GHL"; only a failed create or a person's call escalates.
    let wouldCreate = false;
    if (cls === 'ghl_missing_appointment') {
      const r = await tryCreateMissing({ cid, lead });
      if (r === 'handled') continue;
      wouldCreate = r === 'dry';
    }

    counts[cls]++;

    const finding = {
      class: cls,
      contact_id: cid,
      name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
      lp_appointment_date: lead.appointment_date,
      lp_disposition: lead.disposition_code,
      lp_prospect_id: lead.lp_prospect_id,
      action: wouldCreate ? 'create_in_ghl' : 'escalate_to_rep',
      ...(wouldCreate ? { would_create: true } : {}),
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
    drift_fix: drift,
    post_appointment_close: close,
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
    `${counts.lp_missing_appointment} LP-missing, ${counts.ghl_missing_appointment} GHL-missing` +
    // v1.3: say what the grace period held back. A suppressed finding that never
    // appears in the log is indistinguishable from one that was never found.
    (counts.ghl_missing_too_new
      ? ` (+${counts.ghl_missing_too_new} too-new, <${PARITY_GHL_MISSING_MIN_AGE_MIN}m)`
      : '') +
    (counts.ghl_missing_cache_stale
      ? ` (+${counts.ghl_missing_cache_stale} found live in GHL, HL cache stale)`
      : '') +
    (counts.ghl_live_check_failed
      ? ` (${counts.ghl_live_check_failed} live GHL checks failed — escalated)`
      : '') +
    `, ${counts.confirmation_drift} confirm-drift, ${counts.cancellation_drift} cancel-drift, ` +
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
  const send = deps.send || ((text) => sendAlertMessage(text, { channel: 'ops', noDedup: true }));
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

  // 2026-10-02 (Mark, alert noise cut): no per-key card. New gaps go into the
  // 8 AM digest (src/jobs/ops-morning-digest.js reads these alert_conditions
  // rows by first_seen_at); the claim here is state only.
  if (deps.digestEnabled ?? alertDigestEnabled()) {
    await confirm(claimed.newlyFiring, { client });
    console.log(`[ApptParity] ${claimed.newlyFiring.length} new gap(s) — held for the morning digest`);
    return { action: 'digest', newly: claimed.newlyFiring.length };
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
export const __testing = {
  classifyHealResult, classifyEmit, maybeAlertParityGaps, ALERT_PREFIX,
  lpRowAgeMinutes, PARITY_GHL_MISSING_MIN_AGE_MIN,
  isSentinelAppointmentDate, readLpBook, bucketGhlBook,
};

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
