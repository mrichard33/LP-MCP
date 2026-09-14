// ─── Duplicate live appointment sweep — src/jobs/appt-prospect-dupe-sweep.js ──
//
// Daily, from 08:00 ET: report every lp_prospect_id holding more than one LIVE
// lead row on the same upcoming appointment day. One prospect with two live
// rows on one date double-counts a person across confirmed and set.
//
// THIS IS THE DETECT HALF and it is not a guard. Measured on 2026-09-14
// against all five observed cases, the prevent half
// (services/lp-duplicate-appointment-guard.js) would have blocked NONE of them:
// three arrived from different vendors posting straight into LP, and in every
// one of the five pairs the NEWER lead was set by a human or a vendor rather
// than by "Integration, GoHighLevel". Nothing we run sits upstream of those
// creates. Reporting them is the whole of what is actually available.
//
// SOURCE NAMES ARE THE POINT. v_appt_prospect_dupes (sql/108) does NOT carry
// them — it returns lp_prospect_id, lead_ids, surnames, lead_rows, live_rows,
// slot_date, dispositions and ghl_contact_ids — so this job joins lp_leads for
// lead_source / lead_source_detail and attaches one per lead id. Without them
// the card is a list of ids nobody can act on; with them, repeated vendor pairs
// (MVP / Prolific, Lead Gurus / anything) become a recurring number rather than
// something found by accident.
//
// The decision and the card body are pure and live in
// services/appt-prospect-dupe-alerts.js. This module owns the query, the state
// and the throttle, per the alerting convention in CLAUDE.md.
//
// EDGE-TRIGGERED delivery via reportAlertCondition: one card per incident plus
// a daily reminder while it stands, not one card per tick. A failed read is
// reported as `null` — neither page nor clear — because clearing on "I could
// not tell" announces a recovery nobody earned.
//
// Kill switch: APPT_DUPE_SWEEP_DISABLED (any value).

import supabase from '../supabase.js';
import { todayET, hourET } from './lp-report-common.js';
import { reportAlertCondition } from '../alert-state.js';
import {
  shouldAlertApptProspectDupes,
  activeFromVerdict,
  formatApptProspectDupes,
  formatApptProspectDupesRecovered,
} from '../services/appt-prospect-dupe-alerts.js';

const DISABLED = !!(process.env.APPT_DUPE_SWEEP_DISABLED || '').trim();
const ALERT_KEY = 'appt_prospect_dupes';
const REMIND_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

let sweepTimer = null;

/**
 * Attach `sources` ({ lead_id: 'Source — Detail' }) to each dupe row.
 *
 * Returns the rows unchanged rather than throwing if the join fails: a missing
 * source makes the card weaker, but dropping the whole alert because a second
 * query failed would turn a data-quality signal into silence.
 */
async function attachSources(rows, client) {
  const ids = [...new Set(rows.flatMap((r) => (r.lead_ids || []).map(String)))];
  if (!ids.length) return rows;
  try {
    const { data, error } = await client.from('lp_leads')
      .select('lp_lead_id, lead_source, lead_source_detail')
      .in('lp_lead_id', ids);
    if (error) {
      console.warn(`[ApptDupeSweep] source join failed (card degrades): ${error.message}`);
      return rows;
    }
    const byId = new Map((data || []).map((l) => {
      // lead_source_detail is the vendor ("MVP Marketing", "Lead Gurus");
      // lead_source is the bucket ("Affiliates", "Internet"). The detail is
      // what identifies who was paid, so it leads.
      const label = [l.lead_source_detail, l.lead_source].filter(Boolean).join(' / ') || null;
      return [String(l.lp_lead_id), label];
    }));
    return rows.map((r) => ({
      ...r,
      sources: Object.fromEntries((r.lead_ids || []).map((id) => [String(id), byId.get(String(id)) || null])),
    }));
  } catch (err) {
    console.warn(`[ApptDupeSweep] source join threw (card degrades): ${err.message}`);
    return rows;
  }
}

/**
 * Read the duplicates, attach sources, and report.
 *
 * @param {{ alert?: boolean, client?: object }} [opts]
 * @returns {Promise<{ verdict: string, count: number, rows: object[]|null }>}
 */
export async function checkApptProspectDupes({ alert = true, client } = {}) {
  const db = client ?? supabase;
  if (!db) return { verdict: 'insufficient_evidence', count: 0, rows: null };

  let rows = null;
  try {
    // slot_date >= today ET: a duplicate on a day already past is history the
    // floor cannot act on, and would keep the alert permanently lit.
    const { data, error } = await db.from('v_appt_prospect_dupes')
      .select('*')
      .gt('live_rows', 1)
      .gte('slot_date', todayET())
      .order('slot_date', { ascending: true });
    if (error) {
      console.warn(`[ApptDupeSweep] read failed — reporting as could-not-tell: ${error.message}`);
    } else {
      rows = await attachSources(data || [], db);
    }
  } catch (err) {
    console.warn(`[ApptDupeSweep] read threw — reporting as could-not-tell: ${err.message}`);
  }

  const { verdict, count } = shouldAlertApptProspectDupes(rows);

  if (alert) {
    await reportAlertCondition({
      key: ALERT_KEY,
      active: activeFromVerdict(verdict),
      label: 'Duplicate live appointments',
      text: rows && rows.length ? formatApptProspectDupes(rows) : null,
      recoveredText: formatApptProspectDupesRecovered(),
      detail: { count, prospects: (rows || []).map((r) => r.lp_prospect_id) },
      // Operational alarm → the ops bot, mirrored to SLACK_CHANNEL_OPS.
      channel: 'ops',
      remindMs: REMIND_MS,
    });
  }

  return { verdict, count, rows };
}

export function startApptProspectDupeSweep() {
  if (sweepTimer) return;
  if (DISABLED) {
    console.log('[ApptDupeSweep] DISABLED (APPT_DUPE_SWEEP_DISABLED set)');
    return;
  }
  console.log('[ApptDupeSweep] Started — duplicate live appointment check from 08:00 ET, edge-triggered with a daily reminder');
  sweepTimer = setInterval(async () => {
    // From 08:00 ET: overnight vendor posts have landed and the floor is in.
    if (hourET() < 8) return;
    try {
      await checkApptProspectDupes();
    } catch (err) {
      console.error(`[ApptDupeSweep] sweep failed: ${err.message}`);
    }
  }, SWEEP_INTERVAL_MS);
}

export function stopApptProspectDupeSweep() {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}
