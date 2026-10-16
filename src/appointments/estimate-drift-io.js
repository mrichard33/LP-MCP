/**
 * Estimate drift correction, I/O — src/appointments/estimate-drift-io.js
 *
 * Runs inside the parity watchdog (the one auto-heal owner; no separate sweep).
 * The decision is pure and lives in estimate-drift.js; this reads the scope,
 * the owning lead and LP live, then logs (shadow) or applies (live).
 *
 *   shadow  "[DriftFix] shadow would <op> appt=… contact=… lp=… reason=…" plus an
 *           appt.drift_detected event per would-do; no GHL write, no card.
 *   live    reschedule in place (markRescheduleInflight first, the reconciler's
 *           PUT) or queue mark_invalid (rule ESTIMATE_DRIFT_FIX) + the one
 *           "LP date/time looks wrong" card.
 *   >25     more than DRIFT_CAP writes in a run applies NONE and posts one
 *           #ops-alerts card: a mass correction is a data problem for a person.
 *
 * Never writes to LP (people fix LP from the card).
 */

import { decideDrift, inDriftScope, overCap, estimateDriftMode, DRIFT_RULE, DRIFT_CAP } from './estimate-drift.js';
import { buildMarkInvalidRows } from './mark-invalid.js';

const CHUNK = 100;

/** appointmentId → the startTime OUR sync created it with (reconciler or delegated endpoint). */
export async function readSyncCreatedStarts(db, appointmentIds) {
  const out = new Map();
  for (let i = 0; i < appointmentIds.length; i += CHUNK) {
    const ids = appointmentIds.slice(i, i + CHUNK);
    const { data, error } = await db.from('system_events')
      .select('payload')
      .eq('event_type', 'appt.booking')
      .eq('event_subtype', 'created')
      .in('payload->>appointmentId', ids)
      .or('payload->>site.eq.reconcileLpAppointmentToGhl,payload->>caller.eq.endpoint');
    if (error) throw new Error(`appt.booking read failed: ${error.message}`);
    for (const row of data || []) {
      const p = row.payload || {};
      if (p.appointmentId && p.startTime && !out.has(p.appointmentId)) out.set(p.appointmentId, p.startTime);
    }
  }
  return out;
}

/**
 * @param {object} a
 * @param {Map} a.ghlActive  watchdog GHL book: contact → earliest active row
 * @param {boolean} [a.dryRun]  the watchdog's report mode: never writes, whatever the mode
 * @param {object} a.deps { readSyncCreatedStarts, resolveLead, readLive, putReschedule, markRescheduleInflight,
 *                          queueRows, notify, emitEvent, sendAlert, mode, nowMs, log }
 */
export async function runEstimateDriftFix({ ghlActive, dryRun = false, deps }) {
  const mode = deps.mode || estimateDriftMode();
  const summary = { mode, candidates: 0, sync_created: 0, would: {}, applied: { reschedule: 0, mark_invalid: 0 }, skipped: {}, capped: false, errors: 0 };
  if (mode === 'off') return summary;
  const log = deps.log || console.log;
  const nowMs = deps.nowMs ?? Date.now();
  const candidates = [...(ghlActive?.values?.() || [])].filter((a) => inDriftScope(a, nowMs));
  summary.candidates = candidates.length;
  if (!candidates.length) return summary;

  let starts;
  try {
    starts = await deps.readSyncCreatedStarts(candidates.map((a) => a.ghl_appointment_id));
  } catch (err) {
    log(`[DriftFix] could not read appt.booking events (no corrections this run): ${err.message}`);
    summary.errors++;
    return summary;
  }
  const writes = mode === 'live' && !dryRun;
  const plans = [];
  for (const appt of candidates) {
    const createdStartTime = starts.get(appt.ghl_appointment_id);
    if (!createdStartTime) continue;   // a person or a workflow made it — never touched
    summary.sync_created++;
    const cid = appt.ghl_contact_id;
    try {
      const lead = await deps.resolveLead(cid);
      const live = lead ? await deps.readLive(lead, { dryRun: !writes }) : null;
      const plan = decideDrift({ appt, lead, live, createdStartTime });
      plans.push({ ...plan, appt, lead, cid });
    } catch (err) {
      summary.errors++;
      log(`[DriftFix] decision failed for appt=${appt.ghl_appointment_id} contact=${cid}: ${err.message}`);
    }
  }
  for (const p of plans) {
    if (p.op === 'reschedule' || p.op === 'mark_invalid') summary.would[p.op] = (summary.would[p.op] || 0) + 1;
    else summary.skipped[p.reason] = (summary.skipped[p.reason] || 0) + 1;
  }

  const acting = plans.filter((p) => p.op === 'reschedule' || p.op === 'mark_invalid' || p.card);
  for (const p of acting) {
    if (p.op !== 'reschedule' && p.op !== 'mark_invalid') continue;
    log(`[DriftFix] ${writes ? 'live' : 'shadow'} would ${p.op} appt=${p.appt.ghl_appointment_id} contact=${p.cid} lp=${p.lead?.lp_lead_id || '?'} reason=${p.reason}${p.startTime ? ` to=${p.startTime}` : ''}`);
    await deps.emitEvent?.({
      event_type: 'appt.drift_detected', event_subtype: p.op, source: 'appointment_parity_watchdog',
      entity_type: 'contact', entity_id: p.cid, ghl_contact_id: p.cid, priority: 'low', bypass_filter: true,
      payload: { appointment_id: p.appt.ghl_appointment_id, lp_lead_id: p.lead?.lp_lead_id || null, reason: p.reason, ghl_start: p.appt.start_time, lp_start: p.startTime || null, mode, applied: false },
      idempotency_key: `drift_${p.op}_${p.appt.ghl_appointment_id}_${String(p.startTime || '').slice(0, 16)}_${new Date(nowMs).toISOString().slice(0, 10)}`,
    }).catch(() => {});
  }
  if (!writes) return summary;

  if (overCap(plans)) {
    summary.capped = true;
    const n = plans.filter((p) => p.op === 'reschedule' || p.op === 'mark_invalid').length;
    log(`[DriftFix] ${n} corrections > cap ${DRIFT_CAP} — applying none`);
    await deps.sendAlert?.(`🚨 Estimate drift fix: ${n} sync-created GHL estimates disagree with LP in one run (cap ${DRIFT_CAP}). None were changed. A mass mismatch is a data problem — check the LP sync before anything is corrected.`, { channel: 'ops' })
      .catch(() => {});
    return summary;
  }

  for (const p of acting) {
    try {
      if (p.op === 'reschedule') {
        await deps.markRescheduleInflight(p.cid).catch(() => {});
        await deps.putReschedule({ appointmentId: p.appt.ghl_appointment_id, calendarId: p.appt.ghl_calendar_id, startTime: p.startTime });
        summary.applied.reschedule++;
      } else if (p.op === 'mark_invalid') {
        await deps.queueRows(buildMarkInvalidRows({
          contactId: p.cid, appointmentId: p.appt.ghl_appointment_id, rule: DRIFT_RULE,
          // lead-id-ok: mark_invalid reasoning on an action row, not a card
          why: `LP lead ${p.lead?.lp_lead_id || '?'}: ${p.reason}`,
        }));
        summary.applied.mark_invalid++;
      }
      if (p.card) await deps.notify?.({ contactId: p.cid, lead: p.lead, result: p.card }).catch(() => {});
      if (p.op === 'reschedule' || p.op === 'mark_invalid') {
        await deps.emitEvent?.({
          event_type: 'appointment.parity_auto_fixed', event_subtype: `drift_${p.op}`, source: 'appointment_parity_watchdog',
          entity_type: 'contact', entity_id: p.cid, ghl_contact_id: p.cid, priority: 'low', bypass_filter: true,
          payload: { appointment_id: p.appt.ghl_appointment_id, lp_lead_id: p.lead?.lp_lead_id || null, reason: p.reason, to: p.startTime || null },
          idempotency_key: `parity_fixed_drift_${p.appt.ghl_appointment_id}_${String(p.startTime || '').slice(0, 16)}`,
        }).catch(() => {});
      }
    } catch (err) {
      summary.errors++;
      log(`[DriftFix] ${p.op} failed for appt=${p.appt.ghl_appointment_id}: ${err.message}`);
    }
  }
  return summary;
}

/**
 * Fix 8.8 — the GHL→LP conflict branch (src/actions/handlers/lp-appointment.js).
 * Before "LP Appointment CONFLICT — manual LP fix needed" is posted: when the
 * GHL appointment is in Fix 8 scope (OUR sync created it and it still sits where
 * we put it), run the drift decision instead. Live → correct GHL to LP and post
 * NO conflict card (outcome ghl_corrected_to_lp). Shadow → log, and the card
 * still posts. A person's booking is never in scope, so its card is unchanged.
 * Never throws; any failed read answers { corrected: false } and the card posts.
 *
 * deps: { fetchUpcomingAppointments, readSyncCreatedStarts, resolveLead, readLive,
 *         putReschedule, markRescheduleInflight, queueRows, notify, mode, log }
 */
export async function correctConflictIfSyncCreated({ contactId, lpLeadId, ghlStartIso, deps = {} }) {
  const log = deps.log || console.log;
  const mode = deps.mode || estimateDriftMode();
  try {
    if (mode === 'off' || !ghlStartIso) return { corrected: false, reason: mode === 'off' ? 'mode_off' : 'no_ghl_time' };
    const { sameStartTime } = await import('../services/lp-ghl-appointment-reconciler.js');
    const upcoming = await deps.fetchUpcomingAppointments(contactId);
    if (!Array.isArray(upcoming)) return { corrected: false, reason: 'ghl_unreadable' };
    const hit = upcoming.find((a) => sameStartTime(a.start_time, ghlStartIso)
      && inDriftScope({ ghl_appointment_id: a.appointment_id, ghl_calendar_id: a.calendar_id, status: a.status, start_time: a.start_time }));
    if (!hit) return { corrected: false, reason: 'not_in_scope' };
    const starts = await deps.readSyncCreatedStarts([hit.appointment_id]);
    const createdStartTime = starts.get(hit.appointment_id);
    if (!createdStartTime) return { corrected: false, reason: 'not_sync_created' };
    const lead = await deps.resolveLead(contactId, lpLeadId);
    const writes = mode === 'live';
    const live = lead ? await deps.readLive(lead, { dryRun: !writes }) : null;
    const appt = { ghl_appointment_id: hit.appointment_id, ghl_calendar_id: hit.calendar_id, start_time: hit.start_time, status: hit.status };
    const plan = decideDrift({ appt, lead, live, createdStartTime });
    if (plan.op !== 'reschedule' && plan.op !== 'mark_invalid') return { corrected: false, reason: plan.reason };
    log(`[DriftFix] conflict ${writes ? 'live' : 'shadow'} would ${plan.op} appt=${hit.appointment_id} contact=${contactId} lp=${lead?.lp_lead_id || lpLeadId} reason=${plan.reason}`);
    if (!writes) return { corrected: false, reason: 'shadow', would: plan.op };
    if (plan.op === 'reschedule') {
      await deps.markRescheduleInflight(contactId).catch(() => {});
      await deps.putReschedule({ appointmentId: hit.appointment_id, calendarId: hit.calendar_id, startTime: plan.startTime });
    } else {
      // lead-id-ok: mark_invalid reasoning on an action row, not a card
      await deps.queueRows(buildMarkInvalidRows({ contactId, appointmentId: hit.appointment_id, rule: DRIFT_RULE, why: `conflict, LP lead ${lead?.lp_lead_id || lpLeadId}: ${plan.reason}` }));
      if (plan.card) await deps.notify?.({ contactId, lead, result: plan.card }).catch(() => {});
    }
    return { corrected: true, op: plan.op, appointment_id: hit.appointment_id, to: plan.startTime || null, reason: plan.reason };
  } catch (err) {
    log(`[DriftFix] conflict check failed for ${contactId} (card posts): ${err.message}`);
    return { corrected: false, reason: 'error' };
  }
}

/** Production deps for correctConflictIfSyncCreated, loaded lazily (no import cycle). */
export async function conflictDriftDeps() {
  const [{ default: supabase }, { fetchUpcomingAppointments }, recon, { markRescheduleInflight }, live, sync] = await Promise.all([
    import('../supabase.js'), import('../knowledge/contact-appointments.js'), import('../services/lp-ghl-appointment-reconciler.js'),
    import('../services/reschedule-inflight.js'), import('../services/lp-live-appointment.js'), import('../actions/handlers/lp-ghl-appointment-sync.js'),
  ]);
  return {
    fetchUpcomingAppointments: async (cid) => {
      const rows = await fetchUpcomingAppointments(cid);
      return Array.isArray(rows) ? rows.map((a) => ({ ...a, start_time: recon.normalizeGhlStartTime(a.start_time) })) : rows;
    },
    readSyncCreatedStarts: (ids) => readSyncCreatedStarts(supabase, ids),
    resolveLead: async (cid, lpLeadId) => (await sync.resolveSyncLead({}, lpLeadId ? { lp_lead_id: lpLeadId } : {}, cid)).lead,
    readLive: live.readLiveForSync,
    putReschedule: recon.putReschedule,
    markRescheduleInflight,
    queueRows: async (rows) => { const { error } = await supabase.from('agent_actions').insert(rows); if (error) throw new Error(error.message); },
    notify: sync.notifyLpLooksWrong,
  };
}
