/**
 * Time-change LP note — src/services/time-change-lp-note.js
 *
 * Mark, 2026-10-15 (handoff v3, rule R8). A lead who asked for 6:30 / 7:00 is
 * booked at 6:00 PM (evening-request.js) and the team moves it. The agent who
 * confirms the visit works in Lead Perfection, not GHL, so once the
 * appointment is in LP the request goes onto the LP PROSPECT as an IMPORTANT
 * note, through the existing writer (writeLpNote, ghl-note-pipeline/lp-write.js:
 * "** IMPORTANT **" prefix, GHL_NOTE_IMPORTANT_CATEGORY_ID when set):
 *
 *   "Customer requested 6:30 PM on Thu Oct 16. Bot booked 6:00 PM. Please
 *    confirm with the customer and move the appointment to 6:30 PM."
 *
 * Exactly one note per appt_time_change_requests row. The row is CLAIMED
 * before the write (lp_note_written_at set while still pending), so the
 * LP-sync hook and the 15-minute sweep can never both write it; a failed write
 * releases the claim and records last_error for the next sweep.
 *
 * Two ways in:
 *   - onLpAppointmentSynced: the success path of syncAppointmentToLP
 *     (lp_appointment_set / already_set_in_lp). Fire-and-forget there, so the
 *     sync itself is never delayed or changed (R4).
 *   - sweepTimeChangeNotes: job `time-change-lp-note-sweep`, every
 *     LP_NOTE_SWEEP_MINUTES (15). Per pending row: the GHL appointment
 *     cancelled or moved off 6:00 PM → `superseded`, nothing written; in LP →
 *     write; not in LP past LP_NOTE_ALERT_AFTER_MINUTES (120) → ONE
 *     #contact-center card (alerted_at); still pending after 24h → `failed`.
 * The sweep runs whatever CAPACITY_GATE_ENABLED says: rows already pending
 * still get their note after a rollback.
 */

import { postLpNoteMissingCard } from '../notifications/capacity-cards.js';

const FAIL_AFTER_MS = 24 * 3600_000;
export const JOB_ID = 'time-change-lp-note-sweep';

export function sweepMinutes(env = process.env) {
  const n = Number(env.LP_NOTE_SWEEP_MINUTES ?? 15);
  return Number.isFinite(n) && n >= 1 ? n : 15;
}
export function alertAfterMinutes(env = process.env) {
  const n = Number(env.LP_NOTE_ALERT_AFTER_MINUTES ?? 120);
  return Number.isFinite(n) && n >= 1 ? n : 120;
}

/** The R8 note text. Pure. */
export function buildTimeChangeNote(row) {
  return `Customer requested ${row.requested_label}. Bot booked 6:00 PM. Please confirm with the customer and move the appointment to ${row.requested_time}.`;
}

/** ET 'YYYY-MM-DD' of an instant. Pure. */
function etDate(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(iso));
}
/** An LP or GHL date ('2026-10-16', '10/16/2026', '2026-10-16T…') → 'YYYY-MM-DD'. Pure. */
export function normDate(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}
/** '6:00 PM' / '18:00' / '06:00 PM' → minutes of the day, or null. Pure. */
export function timeMinutes(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i);
  if (!m) return null;
  let h = Number(m[1]) % 24;
  const mer = (m[3] || '').toLowerCase();
  if (mer.startsWith('p') && h < 12) h += 12;
  if (mer.startsWith('a') && h === 12) h = 0;
  return h * 60 + Number(m[2] || 0);
}

/** The prospect id inside an lp_appointment_sync_marks dedup key (`contact:prospect:lds:date:time`). Pure. */
export function prospectFromDedupKey(key) {
  const parts = String(key || '').split(':');
  return parts.length >= 3 && /^\d+$/.test(parts[1]) ? parts[1] : null;
}

/**
 * What the sweep does with one pending row. Pure.
 * @param {object} a
 * @param {object} a.row
 * @param {{ cancelled: boolean, start: string|null }|null} a.appointment  null = could not read
 * @param {string|null} a.prospectId  the LP prospect, when the appointment is in LP
 * @param {boolean} a.sameStart        the GHL start is still the booked 6:00 PM
 * @returns {'superseded'|'write'|'alert'|'fail'|'wait'}
 */
export function decideRow({ row, appointment, prospectId, sameStart, nowMs = Date.now(), env = process.env }) {
  if (appointment && (appointment.cancelled || !sameStart)) return 'superseded';
  if (prospectId) return 'write';
  const age = nowMs - Date.parse(row.created_at);
  if (age >= FAIL_AFTER_MS) return 'fail';
  if (!row.alerted_at && age >= alertAfterMinutes(env) * 60_000) return 'alert';
  return 'wait';
}

// ── I/O ──────────────────────────────────────────────────────────────────────

async function defaultDeps() {
  const [{ default: supabase }, { writeLpNote }, { ghlFetch }, { sameStartTime }] = await Promise.all([
    import('../supabase.js'),
    import('../ghl-note-pipeline/lp-write.js'),
    import('../actions/helpers.js'),
    import('./lp-ghl-appointment-reconciler.js'),
  ]);
  return {
    supabase,
    writeLpNote,
    sameStartTime,
    postCard: postLpNoteMissingCard,
    async readAppointment(id) {
      const res = await ghlFetch('GET', `/calendars/events/appointments/${id}`);
      const a = res?.appointment || res || {};
      if (!a.id) return { cancelled: true, start: null };   // gone from GHL
      const status = String(a.appointmentStatus || a.status || '').toLowerCase();
      return { cancelled: ['cancelled', 'canceled', 'invalid', 'noshow'].includes(status), start: a.startTime || a.start_time || null };
    },
    // In LP: a successful (non-refused) LP sync for the contact since the booking.
    async readLpProspect(row) {
      const { data: marks } = await supabase.from('lp_appointment_sync_marks')
        .select('dedup_key, created_at').eq('contact_id', row.ghl_contact_id).gte('created_at', row.created_at)
        .order('created_at', { ascending: false }).limit(5);
      const mark = (marks || []).find(m => !String(m.dedup_key || '').startsWith('refused:'));
      if (!mark) return null;
      const fromKey = prospectFromDedupKey(mark.dedup_key);
      if (fromKey) return fromKey;
      const { data: lead } = await supabase.from('lp_leads').select('lp_prospect_id')
        .eq('ghl_contact_id', row.ghl_contact_id).not('lp_prospect_id', 'is', null)
        .order('synced_at', { ascending: false }).limit(1).maybeSingle();
      return lead?.lp_prospect_id ? String(lead.lp_prospect_id) : null;
    },
    async contactName(contactId) {
      try {
        const { getContactCached } = await import('../actions/contact-cache.js');
        const c = await getContactCached(contactId);
        return [c?.firstName, c?.lastName].filter(Boolean).join(' ') || null;
      } catch { return null; }
    },
  };
}

function update(d, id, patch) {
  return d.supabase.from('appt_time_change_requests').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
}

/**
 * Write the note for one row, once. Skips unless status = pending and the row
 * is unclaimed. @returns {Promise<'written'|'skipped'|'error'>}
 */
export async function writeTimeChangeNote(row, prospectId, deps = null) {
  const d = deps || await defaultDeps();
  if (!row || row.status !== 'pending' || !prospectId) return 'skipped';
  // Claim: only the caller whose update finds the row unclaimed writes.
  const claimedAt = new Date().toISOString();
  const { data: claimed, error: claimErr } = await d.supabase.from('appt_time_change_requests')
    .update({ lp_note_written_at: claimedAt, lp_prospect_id: String(prospectId), updated_at: claimedAt })
    .eq('id', row.id).eq('status', 'pending').is('lp_note_written_at', null).select('id');
  if (claimErr || !claimed?.length) return 'skipped';
  try {
    const receipt = await d.writeLpNote(String(prospectId), buildTimeChangeNote(row), true);
    await update(d, row.id, { status: 'written', lp_note_id: receipt?.noteId || null, last_error: null });
    console.log(`[TimeChangeNote] request=${row.id} contact=${row.ghl_contact_id} status=written prospect=${prospectId}`);
    return 'written';
  } catch (err) {
    // Release the claim so the next sweep retries; never a second note.
    await update(d, row.id, { lp_note_written_at: null, last_error: String(err.message || err).slice(0, 500) });
    console.warn(`[TimeChangeNote] request=${row.id} contact=${row.ghl_contact_id} status=pending error=${err.message}`);
    return 'error';
  }
}

/**
 * Hook on the LP appointment sync's success path. Never throws.
 * @param {object} a  { contactId, prospectId, apptDate }
 */
export async function onLpAppointmentSynced({ contactId, prospectId, apptDate, apptTime = null }, deps = null) {
  if (!contactId || !prospectId) return { written: 0 };
  try {
    const d = deps || await defaultDeps();
    const { data: rows, error } = await d.supabase.from('appt_time_change_requests')
      .select('*').eq('ghl_contact_id', contactId).eq('status', 'pending').is('lp_note_written_at', null);
    if (error || !rows?.length) return { written: 0 };
    const day = normDate(apptDate);
    let written = 0;
    for (const row of rows) {
      // The LP appointment set is this request's 6:00 PM day.
      if (day && etDate(row.booked_start) !== day) continue;
      // The same day at another time: the team already moved it off 6:00 PM.
      const mins = timeMinutes(apptTime);
      if (mins != null && mins !== 18 * 60) {
        await update(d, row.id, { status: 'superseded' });
        console.log(`[TimeChangeNote] request=${row.id} contact=${contactId} status=superseded (LP set at ${apptTime})`);
        continue;
      }
      if (await writeTimeChangeNote(row, prospectId, d) === 'written') written++;
    }
    return { written };
  } catch (err) {
    console.warn(`[TimeChangeNote] sync hook failed for ${contactId}: ${err.message}`);
    return { written: 0, error: err.message };
  }
}

/** One sweep over every pending row. @returns {Promise<object>} counts */
export async function sweepTimeChangeNotes({ nowMs = Date.now(), env = process.env } = {}, deps = null) {
  const d = deps || await defaultDeps();
  const out = { checked: 0, written: 0, superseded: 0, alerted: 0, failed: 0, waiting: 0, errors: 0 };
  const { data: rows, error } = await d.supabase.from('appt_time_change_requests')
    .select('*').eq('status', 'pending').order('created_at', { ascending: true }).limit(200);
  if (error) return { ...out, ok: false, error: error.message };
  for (const row of rows || []) {
    out.checked++;
    try {
      let appointment = null;
      try { appointment = await d.readAppointment(row.ghl_appointment_id); } catch { appointment = null; }
      const sameStart = appointment?.start ? d.sameStartTime(appointment.start, row.booked_start) : true;
      const prospectId = (appointment && (appointment.cancelled || !sameStart)) ? null : await d.readLpProspect(row);
      const action = decideRow({ row, appointment, prospectId, sameStart, nowMs, env });
      if (action === 'superseded') {
        await update(d, row.id, { status: 'superseded' });
        out.superseded++;
        console.log(`[TimeChangeNote] request=${row.id} contact=${row.ghl_contact_id} status=superseded`);
      } else if (action === 'write') {
        const r = await writeTimeChangeNote(row, prospectId, d);
        if (r === 'written') out.written++; else if (r === 'error') out.errors++;
      } else if (action === 'fail') {
        await update(d, row.id, { status: 'failed' });
        out.failed++;
        console.warn(`[TimeChangeNote] request=${row.id} contact=${row.ghl_contact_id} status=failed (24h without reaching LP)`);
      } else if (action === 'alert') {
        // Mark first, then post: a crash between the two never posts twice.
        await update(d, row.id, { alerted_at: new Date(nowMs).toISOString() });
        const name = await d.contactName(row.ghl_contact_id);
        await d.postCard({ contactId: row.ghl_contact_id, name, requestedLabel: row.requested_label });
        out.alerted++;
        console.log(`[TimeChangeNote] request=${row.id} contact=${row.ghl_contact_id} status=pending alerted`);
      } else {
        out.waiting++;
      }
    } catch (err) {
      out.errors++;
      console.warn(`[TimeChangeNote] request=${row.id} sweep error: ${err.message}`);
    }
  }
  return { ...out, ok: out.errors === 0 };
}
