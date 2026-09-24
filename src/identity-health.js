/**
 * identity-health.js — the numbers behind the get_identity_health MCP tool.
 *
 * WHY (2026-09-24). A live audit on 2026-09-23 found LP→GHL links are 99.8%
 * complete for new leads, and three identity gaps that nothing reported:
 *
 *   1. Reporting counts LP ROWS, not PEOPLE. 30,511 linked rows map to 20,120
 *      GHL contacts, so any per-row metric overstates people by about half.
 *   2. 263 GHL ids carry more than one phone or last name across their LP
 *      rows — suspected bad links.
 *   3. Five9 inbound callers with no LP record: 257 Google PPC Windows callers
 *      in 30 days, and calls dispositioned "Appointment Set" with no LP lead.
 *
 * READ-ONLY. It reads the three views in sql/125 plus lp_leads and
 * five9_events_raw, and writes nothing.
 *
 * A FAILED READ THROWS. It never returns zeros in place of an answer: a tool
 * that reports "0 mismatches" because its query failed reads as a clean bill
 * of health. The same reason a percentage over an empty window is null, not 0
 * — "no leads in the window" and "0% of leads linked" are different facts.
 *
 * Windowing is on created_at_lp (lp_leads has no created_at). Link state is
 * read from ghl_contact_id, never from id.
 *
 * The query layer is a `deps.runSQL` seam so the shape is testable offline
 * (scripts/test-identity-health.js).
 */

import { runSQL as defaultRunSQL } from './admin/supabase-admin.js';

export const APPT_SET_DISPOSITION = 'Appointment Set';

export const LEAD_WINDOWS_SQL = `
  SELECT
    count(*)              FILTER (WHERE created_at_lp >= now() - interval '30 days') AS leads_30d,
    count(ghl_contact_id) FILTER (WHERE created_at_lp >= now() - interval '30 days') AS linked_30d,
    count(*)              FILTER (WHERE created_at_lp <  now() - interval '30 days'
                                    AND created_at_lp >= now() - interval '90 days') AS leads_31_90,
    count(ghl_contact_id) FILTER (WHERE created_at_lp <  now() - interval '30 days'
                                    AND created_at_lp >= now() - interval '90 days') AS linked_31_90,
    count(*)              FILTER (WHERE created_at_lp <  now() - interval '90 days') AS leads_91_365,
    count(ghl_contact_id) FILTER (WHERE created_at_lp <  now() - interval '90 days') AS linked_91_365,
    count(*)              FILTER (WHERE created_at_lp >= now() - interval '90 days' AND ever_set)   AS sets_90d,
    count(ghl_contact_id) FILTER (WHERE created_at_lp >= now() - interval '90 days' AND ever_set)   AS sets_linked_90d,
    count(*)              FILTER (WHERE created_at_lp >= now() - interval '90 days' AND closed_won) AS won_90d,
    count(ghl_contact_id) FILTER (WHERE created_at_lp >= now() - interval '90 days' AND closed_won) AS won_linked_90d,
    count(*)              FILTER (WHERE created_at_lp >= now() - interval '90 days'
                                    AND coalesce(btrim(lead_source), '') = '') AS missing_source_90d
  FROM lp_leads
  WHERE created_at_lp >= now() - interval '365 days'`;

export const PEOPLE_SQL = `
  SELECT
    (SELECT count(*)     FROM v_lead_people)              AS people,
    (SELECT sum(lp_rows) FROM v_lead_people)              AS lp_rows,
    (SELECT count(*)     FROM v_identity_link_mismatches) AS link_mismatches`;

export const FIVE9_KEY_SQL = `
  SELECT count(*) AS events_30d,
         count(*) FILTER (WHERE coalesce(lp_rec_key, '') <> '') AS keyed_30d
  FROM five9_events_raw
  WHERE received_at >= now() - interval '30 days'`;

export const UNMATCHED_SQL = `
  SELECT campaign,
         count(*) AS callers,
         count(*) FILTER (WHERE last_disposition = '${APPT_SET_DISPOSITION}') AS appt_set
  FROM v_unmatched_inbound_callers_30d
  GROUP BY campaign
  ORDER BY callers DESC, campaign`;

/** bigint/numeric come back from run_sql as strings; a missing value is 0 rows. */
function num(v) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Percentage, one decimal, clamped to 0..100. Null when there is no
 * denominator — an empty window is "nothing to measure", not "0%".
 */
export function pct(part, whole) {
  const p = num(part);
  const w = num(whole);
  if (w <= 0) return null;
  const v = Math.round((1000 * p) / w) / 10;
  return Math.min(100, Math.max(0, v));
}

function firstRow(rows, label) {
  if (!Array.isArray(rows)) {
    throw new Error(`identity health: ${label} returned no row set`);
  }
  return rows[0] || {};
}

/**
 * Pure: turn the four query results into the tool's JSON shape.
 *
 * overcount_pct is the share of linked LP rows that are a REPEAT of a person
 * already counted — (rows − people) / rows. That is the fraction a row-based
 * report overstates by, and unlike (rows − people) / people it stays inside
 * 0..100 however many times one person re-enters.
 */
export function buildIdentityHealth({ leads, people, five9, unmatched }) {
  const l = firstRow(leads, 'lead windows');
  const p = firstRow(people, 'people');
  const f = firstRow(five9, 'five9 keys');
  const campaigns = Array.isArray(unmatched) ? unmatched : [];

  const peopleCount = num(p.people);
  const lpRows = num(p.lp_rows);

  return {
    lp_to_ghl_link_pct: {
      last_30d: pct(l.linked_30d, l.leads_30d),
      d31_90: pct(l.linked_31_90, l.leads_31_90),
      d91_365: pct(l.linked_91_365, l.leads_91_365),
    },
    // [linked, total] — how many of the window's outcomes a GHL-side report can see.
    outcomes_linked_90d: {
      sets: [num(l.sets_linked_90d), num(l.sets_90d)],
      closed_won: [num(l.won_linked_90d), num(l.won_90d)],
    },
    people_vs_rows: {
      people: peopleCount,
      lp_rows: lpRows,
      overcount_pct: pct(lpRows - peopleCount, lpRows),
    },
    link_mismatches: num(p.link_mismatches),
    five9_events_with_lp_key_pct_30d: pct(f.keyed_30d, f.events_30d),
    unmatched_callers_30d_by_campaign: campaigns.map((r) => ({
      campaign: r.campaign ?? '',
      callers: num(r.callers),
    })),
    appt_set_without_lp_record_30d: campaigns.reduce((s, r) => s + num(r.appt_set), 0),
    leads_missing_source_90d: num(l.missing_source_90d),
  };
}

/** Run the four reads (in parallel) and build the report. Throws on any failed read. */
export async function getIdentityHealth(deps = {}) {
  const runSQL = deps.runSQL || defaultRunSQL;
  const [leads, people, five9, unmatched] = await Promise.all([
    runSQL(LEAD_WINDOWS_SQL),
    runSQL(PEOPLE_SQL),
    runSQL(FIVE9_KEY_SQL),
    runSQL(UNMATCHED_SQL),
  ]);
  return buildIdentityHealth({ leads, people, five9, unmatched });
}
