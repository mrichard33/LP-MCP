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
 *      → AUTO-HEAL. Status-only update on an appointment that already
 *        exists on both sides. Nothing is created, nothing is moved.
 *
 *   D. cancellation_drift      — GHL cancelled, LP still shows set.
 *      → ESCALATE. A cancellation that only half-landed usually means a
 *        human cancelled in one system; which system is authoritative is a
 *        judgement call, so a rep decides.
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

/** LP book: appointments per contact in [from, to). */
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
  // identity-collision class). Keep the most recently updated row that is
  // not in a resolved disposition — that is the live appointment.
  const book = new Map();
  for (const row of data || []) {
    if (RESOLVED_DISPOSITIONS.has(row.disposition_code)) continue;
    const prev = book.get(row.ghl_contact_id);
    if (!prev) { book.set(row.ghl_contact_id, row); continue; }
    const a = row.updated_at_lp ? new Date(row.updated_at_lp).getTime() : 0;
    const b = prev.updated_at_lp ? new Date(prev.updated_at_lp).getTime() : 0;
    if (a > b) book.set(row.ghl_contact_id, row);
  }
  return book;
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

export async function runAppointmentParityWatchdog({ dryRun = !PARITY_AUTOHEAL } = {}) {
  const started = Date.now();

  // ONE captured instant for both books — see SAFETY above.
  const asOf = new Date();
  const windowEnd = new Date(asOf.getTime() + PARITY_WINDOW_DAYS * 86400000);

  const [{ active: ghlActive, cancelled: ghlCancelled }, lpBook] = await Promise.all([
    readGhlBook(asOf, windowEnd),
    readLpBook(asOf, windowEnd),
  ]);

  const findings = [];
  let writes = 0;
  let healed = 0;
  let escalated = 0;
  let errors = 0;
  const counts = {
    lp_missing_appointment: 0,
    ghl_missing_appointment: 0,
    confirmation_drift: 0,
    cancellation_drift: 0,
    dnc_lifted: 0,
    dnc_partial_lift: 0,
    dnc_blocked_consent: 0,
    write_ceiling_hit: 0,
  };

  const canWrite = () => !dryRun && writes < PARITY_MAX_WRITES;

  // ---- Class A: GHL has it, LP does not. AUTO-HEAL. -----------------
  for (const [cid, appt] of ghlActive) {
    if (lpBook.has(cid)) continue;
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
      const contact = await getGHLContact(cid);
      const plan = planDncLift(contact?.tags, new Date(appt.start_time), null);
      if (plan.decision === 'lift') counts.dnc_lifted++;
      if (plan.decision === 'partial_lift') counts.dnc_partial_lift++;
      if (plan.blocked.length) counts.dnc_blocked_consent++;

      if (plan.lift.length) {
        await emitEvent({
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
      }

      const start = new Date(appt.start_time);
      const result = await syncAppointmentToLP({
        contactId: cid,
        appointmentDate: start.toISOString().slice(0, 10),
        appointmentTime: start.toLocaleTimeString('en-US', {
          timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true,
        }),
      });
      writes++;
      healed++;
      findings.push({ ...finding, executed: true, lp_result: result?.action, dnc: plan.decision });
    } catch (err) {
      errors++;
      findings.push({ ...finding, executed: false, error: err.message });
    }
  }

  // ---- Class B / D: LP has it, GHL does not. ESCALATE. --------------
  for (const [cid, lead] of lpBook) {
    if (ghlActive.has(cid)) continue;
    const wasCancelled = ghlCancelled.has(cid);
    const cls = wasCancelled ? 'cancellation_drift' : 'ghl_missing_appointment';
    counts[cls]++;
    escalated++;

    const finding = {
      class: cls,
      contact_id: cid,
      name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
      lp_appointment_date: lead.appointment_date,
      lp_disposition: lead.disposition_code,
      lp_prospect_id: lead.lp_prospect_id,
      action: 'escalate_to_rep',
    };

    if (canWrite()) {
      try {
        await emitEvent({
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
      } catch (err) { errors++; }
    }
    findings.push(finding);
  }

  // ---- Class C: confirmation drift. AUTO-HEAL (status only). --------
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

    if (canWrite()) {
      try {
        await emitEvent({
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
        healed++;
        findings.push({ ...finding, executed: true });
        continue;
      } catch (err) { errors++; }
    }
    findings.push({ ...finding, executed: false });
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
    healed,
    escalated,
    writes,
    errors,
    dry_run: !!dryRun,
    elapsed_ms: Date.now() - started,
  };
  if (dryRun) summary.findings = findings;

  console.log(
    `[ApptParity] GHL ${ghlCount} / LP ${lpCount} / matched ${matched} (${summary.parity_pct}%) — ` +
    `${counts.lp_missing_appointment} LP-missing, ${counts.ghl_missing_appointment} GHL-missing, ` +
    `${counts.confirmation_drift} confirm-drift, ${counts.cancellation_drift} cancel-drift, ` +
    `${healed} healed, ${escalated} escalated, ${errors} errors` +
    (dryRun ? ' [DRY RUN]' : '')
  );
  return summary;
}

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

export function registerAppointmentParityRoutes(app) {
  app.post('/n8n/appointments/parity-check', async (req, res) => {
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
