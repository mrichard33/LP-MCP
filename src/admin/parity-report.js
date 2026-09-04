/**
 * Live LP↔GHL parity report — src/admin/parity-report.js
 *
 * Reports appointment parity by querying LIVE data on BOTH sides — the LP mirror
 * (lp_leads) and the LIVE GHL calendar API — never the HL cache, never a job's
 * self-counted totals. Only trustworthy AFTER the mirror backfill (WS0) has run,
 * because the LP side reads lp_leads.
 *
 * Per contact, the diff surfaces:
 *   missing         LP expects an appointment (Set/Cnf/Verif, appointment_set,
 *                   with a real start time) but GHL has none at that slot.
 *   orphan          GHL has an active estimate appointment for a contact with no
 *                   active LP appointment expectation.
 *   status_mismatch LP is Cnf but the GHL appointment is not confirmed/showed.
 *   duplicate       contact has >1 active estimate appointment (WS2 territory).
 *
 *   GET /admin/parity-report?date=YYYY-MM-DD   (single ET day)
 *   GET /admin/parity-report?horizon_days=N    (now .. now+N days; default 14)
 */

import supabase from '../supabase.js';
import { lpWallClockToGhlStartTime } from '../appointment-dates.js';
import { sameStartTime } from '../services/lp-ghl-appointment-reconciler.js';
import { listEstimatePoolEvents } from '../services/ghl-calendar-read.js';
import { utcToLpStoredIso } from '../lp-dates.js';

const ACTIVE_DISPOSITIONS = ['Set', 'Cnf', 'Verif'];

function isConfirmedStatus(status) {
  const s = String(status || '').toLowerCase();
  return s === 'confirmed' || s === 'showed';
}

/**
 * Pure diff over two maps. Exported for testing.
 * @param {Map<string,{lp_lead_id,disposition_code,start_time}>} lpByContact
 *        start_time = normalized GHL ISO (or null when LP time is TBD).
 * @param {Map<string, Array<{appointment_id,start_time,status}>>} ghlByContact
 * @returns {{ missing, orphan, status_mismatch, duplicate, counts }}
 */
export function computeParity(lpByContact, ghlByContact) {
  const missing = [];
  const orphan = [];
  const statusMismatch = [];
  const duplicate = [];

  const contactIds = new Set([...lpByContact.keys(), ...ghlByContact.keys()]);
  for (const cid of contactIds) {
    const lp = lpByContact.get(cid) || null;
    const events = ghlByContact.get(cid) || [];

    if (events.length > 1) {
      duplicate.push({ contact_id: cid, appointment_ids: events.map((e) => e.appointment_id) });
    }

    if (lp && lp.start_time) {
      const match = events.find((e) => sameStartTime(e.start_time, lp.start_time));
      if (!match) {
        missing.push({ contact_id: cid, lp_lead_id: lp.lp_lead_id, disposition_code: lp.disposition_code, start_time: lp.start_time });
      } else if (lp.disposition_code === 'Cnf' && !isConfirmedStatus(match.status)) {
        statusMismatch.push({ contact_id: cid, lp_lead_id: lp.lp_lead_id, expected: 'confirmed', ghl_status: match.status, appointment_id: match.appointment_id });
      }
    } else if (!lp && events.length > 0) {
      // GHL has an estimate appointment but LP holds no active appointment for
      // this contact — an orphan (LP cancelled/moved, GHL didn't follow).
      orphan.push({ contact_id: cid, appointment_ids: events.map((e) => e.appointment_id), start_times: events.map((e) => e.start_time) });
    }
  }

  return {
    missing, orphan, status_mismatch: statusMismatch, duplicate,
    counts: {
      lp_expected: lpByContact.size,
      ghl_contacts: ghlByContact.size,
      missing: missing.length,
      orphan: orphan.length,
      status_mismatch: statusMismatch.length,
      duplicate: duplicate.length,
    },
  };
}

/**
 * Is an LP appointment_date inside the GHL comparison window [startMs, endMs)?
 *
 * The SQL fetch widens its bounds ±1 day to absorb the ET-wall-clock-mislabeled-
 * as-UTC offset, but the DIFF must re-narrow to the exact window the GHL side was
 * read for — otherwise adjacent-day LP appointments (which GHL was never queried
 * for) show as false "missing". Exact-time rows compare on the true instant;
 * date-only / time-TBD rows (null start) fall back to their ET calendar day,
 * leniently (they have no exact time to place within the day). Exported for testing.
 */
export function expectationInWindow(appointmentDate, startMs, endMs) {
  const st = lpWallClockToGhlStartTime(appointmentDate);
  if (st) {
    const ms = Date.parse(st);
    if (Number.isNaN(ms)) return false;
    return ms >= startMs && ms < endMs;               // half-open
  }
  // Date-only / TBD: place on its ET calendar day; keep if that day overlaps
  // the window (± the same 1-day leniency the SQL fetch uses).
  const dayStr = String(appointmentDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayStr)) return false;
  const dayMs = Date.parse(`${dayStr}T00:00:00-04:00`);
  if (Number.isNaN(dayMs)) return false;
  return dayMs >= startMs - 24 * 3600 * 1000 && dayMs < endMs;
}

// ─── LP-side scan (newest lead per contact) ──────────────────────────
async function scanLpExpectations({ fromIso, toIso, startMs, endMs }) {
  if (!supabase) throw new Error('Supabase not configured');
  const PAGE = 1000;
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('lp_leads')
      .select('lp_lead_id, ghl_contact_id, disposition_code, appointment_date, appointment_set, created_at_lp')
      .in('disposition_code', ACTIVE_DISPOSITIONS)
      .eq('appointment_set', true)
      .not('ghl_contact_id', 'is', null)
      .gte('appointment_date', fromIso)
      .lte('appointment_date', toIso)
      .order('created_at_lp', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`lp_leads parity scan failed at offset ${from}: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  // Newest lead per contact wins (rows already created_at_lp desc). Drop any
  // expectation outside the exact GHL window — the ±1-day SQL widening is only
  // to survive the offset mislabeling, NOT to diff adjacent days GHL wasn't read for.
  const byContact = new Map();
  for (const r of rows) {
    if (byContact.has(r.ghl_contact_id)) continue;
    if (!expectationInWindow(r.appointment_date, startMs, endMs)) continue;
    byContact.set(r.ghl_contact_id, {
      lp_lead_id: r.lp_lead_id,
      disposition_code: r.disposition_code,
      start_time: lpWallClockToGhlStartTime(r.appointment_date), // null when time TBD
    });
  }
  return byContact;
}

export async function runParityReport({ date = null, horizonDays = 14 } = {}) {
  // Window: a single ET day, or [now, now+horizon]. lp_leads stores ET wall
  // clock mislabeled UTC, so widen the coarse SQL bounds a day each side; the
  // exact per-appointment comparison happens on normalized start times.
  let startMs;
  let endMs;
  if (date) {
    startMs = Date.parse(`${date}T00:00:00-04:00`);
    endMs = startMs + 24 * 3600 * 1000;
  } else {
    startMs = Date.now();
    endMs = startMs + horizonDays * 24 * 3600 * 1000;
  }
  // Bounds in the stored ET-wall-clock frame; appointment_date holds ET
  // digits tagged +00:00. See src/lp-dates.js.
  const fromIso = utcToLpStoredIso(startMs - 24 * 3600 * 1000);
  const toIso = utcToLpStoredIso(endMs + 24 * 3600 * 1000);

  const lpByContact = await scanLpExpectations({ fromIso, toIso, startMs, endMs });

  const events = await listEstimatePoolEvents({ startMs, endMs, activeOnly: true });
  const ghlByContact = new Map();
  for (const e of events) {
    if (!e.contact_id) continue;
    if (!ghlByContact.has(e.contact_id)) ghlByContact.set(e.contact_id, []);
    ghlByContact.get(e.contact_id).push(e);
  }

  const parity = computeParity(lpByContact, ghlByContact);
  return {
    window: date ? { date } : { from: new Date(startMs).toISOString(), to: new Date(endMs).toISOString() },
    scanned_ghl_events: events.length,
    ...parity,
  };
}

export function registerParityReportRoutes(app) {
  app.get('/admin/parity-report', async (req, res) => {
    const date = (req.query?.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) ? req.query.date : null;
    const horizonDays = parseInt(req.query?.horizon_days, 10) || 14;
    try {
      const report = await runParityReport({ date, horizonDays });
      return res.json({ ok: true, ...report });
    } catch (err) {
      return res.status(502).json({ ok: false, error: String(err.message || err).slice(0, 300) });
    }
  });
  console.log('[ParityReport] Registered: GET /admin/parity-report');
}
