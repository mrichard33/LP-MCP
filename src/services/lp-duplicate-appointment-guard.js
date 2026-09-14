/**
 * Duplicate live appointment guard — src/services/lp-duplicate-appointment-guard.js
 *
 * One lp_prospect_id holding two LIVE lead rows on the same appointment date
 * double-counts a person across confirmed and set. Five cases 9/08-9/17.
 *
 * ══ WHAT THIS CAN AND CANNOT DO — READ BEFORE TRUSTING IT ══
 * This is the PREVENT half, and it only ever sees creates that go through OUR
 * code. Checked against all five observed cases on 2026-09-14, it would have
 * blocked NONE of them:
 *
 *   prospect  leads            apart   sources                     newer row set by
 *   400876    575041/575052    4m      MVP / MVP                   "No, Setter"
 *   458357    574953/574957    9m      Self Generated / Lead Gurus "No, Setter"
 *   230019    572626/572972    1 day   MVP / Prolific              "Deer - LF, Craig"
 *   412674    537047/573470    4 mo    Reecewindows.com / Lead Gurus "No, Setter"
 *   358689    550806/575443    3 mo    Prolific / Prolific         "No, Setter"
 *
 * In every pair the NEWER lead carries a human or vendor setter and linked by
 * phone_email_match, never by the lognumber our creates stamp. Exactly one row
 * in the whole set was ours — Gibbons 537047, "Integration, GoHighLevel" — and
 * it is the OLDER of its pair. The duplicates are arriving from vendors posting
 * straight into LP, downstream of nothing we run.
 *
 * So this guard is a seatbelt for a future double-submit on our own path, not a
 * fix for the observed problem. The DETECTOR (jobs/appt-prospect-dupe-sweep.js)
 * is what actually surfaces these. Do not describe either one as solving the
 * other's half.
 *
 * ══ KEY ══
 * Keyed on (ghl_contact_id, appointment DAY), not (lp_prospect_id, day): at
 * create time LP has not assigned a prospect id yet — it matches the prospect
 * server-side — and the GHL contact is the identity we do hold. Verified that
 * all five duplicate prospects map to exactly one ghl_contact_id each, so on
 * this data the two keys select the same rows.
 *
 * DAY grain, matching v_appt_prospect_dupes rather than the slot. Ingrassia
 * (574953 at 13:00, 574957 at 14:00 on 9/16) is a duplicate DAY and not a
 * duplicate slot, and it is still a person double-counted.
 *
 * ══ FAIL OPEN, ALWAYS ══
 * Every error, missing input and unreadable date resolves to `allow`. A lookup
 * failure must never strand a real booking — the cost of a missed block is one
 * duplicate the detector will report tomorrow; the cost of a false block is a
 * customer with no appointment.
 */

/**
 * Dispositions that mean "this lead is holding a live appointment".
 * Matches the live_rows definition in v_appt_prospect_dupes (sql/108).
 */
export const LIVE_DISPOSITIONS = new Set(['Cnf', 'Issue', 'Set', 'Verif']);

/**
 * Normalize an appointment date to a calendar day, 'YYYY-MM-DD'.
 *
 * Accepts LP's addlead wire format ('MM/DD/YYYY', what resolveAppointment and
 * the GHL proxy both produce) and an ISO timestamp (what lp_leads stores).
 * Returns null for anything it cannot read — which the caller treats as
 * "cannot tell", i.e. allow.
 *
 * Deliberately string-sliced rather than Date-parsed for the ISO case: the
 * stored column is timestamptz and new Date(...).toISOString() would shift the
 * day across the UTC boundary for an evening appointment.
 */
export function lpApptDateToDay(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (s === '') return null;

  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    const [, m, d, y] = us;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  return null;
}

/**
 * PURE decision. Given the live lead rows already on this contact and the day
 * we are about to book, should the create proceed?
 *
 * @param {object}   args
 * @param {object[]|null} args.liveLeads rows of { lp_lead_id, disposition_code,
 *   appointment_date }. `null` means the lookup could not tell — allow.
 * @param {string|null}   args.apptDay   'YYYY-MM-DD', or null when unreadable.
 * @returns {{ action: 'block'|'allow', reason: string, conflicts: object[] }}
 */
export function planDuplicateAppointment({ liveLeads, apptDay } = {}) {
  if (!apptDay) return { action: 'allow', reason: 'no_appointment_day', conflicts: [] };
  if (liveLeads == null) return { action: 'allow', reason: 'lookup_unavailable', conflicts: [] };

  const conflicts = liveLeads.filter((l) =>
    LIVE_DISPOSITIONS.has(String(l?.disposition_code || '').trim())
    && lpApptDateToDay(l?.appointment_date) === apptDay);

  if (!conflicts.length) return { action: 'allow', reason: 'no_live_lead_on_day', conflicts: [] };
  return { action: 'block', reason: 'live_lead_already_on_day', conflicts };
}

/** Human-readable one-liner for the ops card and the log line. */
export function formatDuplicateBlock({ ghlContactId, apptDay, conflicts }) {
  const rows = (conflicts || []).map((c) =>
    `${c.lp_lead_id} (${c.disposition_code})`).join(', ');
  return `🚫 LP duplicate appointment blocked — contact ${ghlContactId} already holds a live lead on ${apptDay}: ${rows}. New create suppressed on our path.`;
}

/**
 * Impure lookup + decision. Fail-open on absolutely everything.
 *
 * Supabase is imported LAZILY, on the one path that needs it, so that
 * src/lp-client.js — the pure LP API client, supabase-free by construction and
 * imported by a dozen unit suites — does not gain a database dependency in its
 * static import graph just by calling this.
 *
 * @param {{ ghlContactId: string|null, apptDate: string|null }} args
 * @param {{ client?: object }} [opts] inject a supabase client for tests
 */
export async function checkDuplicateAppointment({ ghlContactId, apptDate } = {}, { client } = {}) {
  const apptDay = lpApptDateToDay(apptDate);
  if (!apptDay) return { action: 'allow', reason: 'no_appointment_day', conflicts: [] };
  // No contact id means no key to check against. A canvass or vendor create
  // with no GHL link is exactly the case this guard cannot see.
  if (!ghlContactId) return { action: 'allow', reason: 'no_contact_id', conflicts: [] };

  let supabase = client;
  try {
    if (!supabase) supabase = (await import('../supabase.js')).default;
  } catch (err) {
    console.warn(`[LpDupeApptGuard] supabase import failed (fail-open): ${err.message}`);
    return { action: 'allow', reason: 'lookup_unavailable', conflicts: [] };
  }
  if (!supabase) return { action: 'allow', reason: 'lookup_unavailable', conflicts: [] };

  try {
    const { data, error } = await supabase.from('lp_leads')
      .select('lp_lead_id, disposition_code, appointment_date')
      .eq('ghl_contact_id', ghlContactId)
      .not('appointment_date', 'is', null);
    if (error) {
      console.warn(`[LpDupeApptGuard] lookup error for ${ghlContactId} (fail-open): ${error.message}`);
      return { action: 'allow', reason: 'lookup_unavailable', conflicts: [] };
    }
    return planDuplicateAppointment({ liveLeads: data || [], apptDay });
  } catch (err) {
    console.warn(`[LpDupeApptGuard] lookup threw for ${ghlContactId} (fail-open): ${err.message}`);
    return { action: 'allow', reason: 'lookup_unavailable', conflicts: [] };
  }
}
