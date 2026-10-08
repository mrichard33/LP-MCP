/**
 * LightFire batting average — the reads. src/batting-average-io.js
 *
 * Read-only. Every query goes through the `deps.runSQL` seam, so the shaping is
 * testable offline (scripts/test-batting-average.js). The arithmetic lives in
 * batting-average.js; nothing here decides what counts.
 *
 * Sources (the user's rulings, 2026-10-08):
 *  - LP for the BEFORE months: report 136 per sub-source (SOURCE_COST_SQL).
 *    Five9 has no call history before 2026-07-03, so February and Q2 cannot
 *    come from Five9, and our lp_leads copy is missing most unsold leads for
 *    those months (see tallySourceCost).
 *  - Five9 (five9_events_raw) for WHO made the first setter call on each lead
 *    in the LightFire months; outcomes for that lead still come from LP.
 *  - LP 137 "By Setter" (lp_sales_efficiency_setter_history) as a cross-check
 *    only: it is dated by appointment and has no sub-source.
 *
 * Time: lp_leads.created_at_lp is LP's Eastern WALL CLOCK tagged +00:00
 * (docs/lp-timestamp-skew.md). Month buckets therefore compare the stored value
 * directly; comparing it with a Five9 call time (true UTC) needs the
 * `AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York'` hop below.
 */

import { NON_SETTER_CAMPAIGN_RX, addMonths } from './batting-average.js';

const MONTH_RE = /^\d{4}-\d{2}$/;
function assertMonth(m) {
  if (!MONTH_RE.test(m)) throw new Error(`month must be YYYY-MM, got ${m}`);
}

const LEAD_COLS = `l.lp_lead_id, l.lead_source, l.lead_source_detail, l.lp_deleted_at,
  l.ever_set, l.ever_sat, l.appointment_set, l.set_date, l.appointment_date,
  l.demo_completed, l.closed_won, l.set_by_name`;

/** Every lead entered in a month (LP entry date). The JS side applies isDirectToYouLead. */
export function leadsForMonthSql(month) {
  assertMonth(month);
  return `SELECT ${LEAD_COLS}
    FROM lp_leads l
    WHERE l.created_at_lp >= '${month}-01' AND l.created_at_lp < '${addMonths(month, 1)}-01'
      AND l.lp_deleted_at IS NULL`;
}

/**
 * Leads entered in a month, each with the FIRST setter call Five9 has for it.
 *
 * Match order: LDS<lead id> (the LP lead key), then INQ<in1_id> (LP's inbound
 * id, which is how Five9 keys most brand-new leads: on 2026-10-08 only 9 of
 * 6,507 September leads carried an LDS key), then the phone. Never INQ against
 * a lead or prospect id: the ranges overlap and "match" unrelated leads.
 *
 * A call counts from 2 hours before entry (the inbound call that created the
 * lead) to 30 days after; an older call on the same phone belongs to an older
 * lead. Calls with no agent (dialer drops, abandoned) are not a setter working
 * the lead.
 */
export function lightfireMonthSql(month) {
  assertMonth(month);
  const from = `${month}-01`;
  const to = `${addMonths(month, 1)}-01`;
  return `WITH leads AS (
    SELECT ${LEAD_COLS},
      (l.created_at_lp AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York' AS entry_utc,
      NULLIF(l.raw_lp_data->>'in1_id', '') AS in1_id,
      NULLIF(right(regexp_replace(coalesce(l.phone, ''), '\\D', '', 'g'), 10), '') AS p1,
      NULLIF(right(regexp_replace(coalesce(l.phone_alt, ''), '\\D', '', 'g'), 10), '') AS p2
    FROM lp_leads l
    WHERE l.created_at_lp >= '${from}' AND l.created_at_lp < '${to}'
      AND l.lp_deleted_at IS NULL
  ), calls AS (
    SELECT id, lp_rec_key, right(regexp_replace(coalesce(dnis, ''), '\\D', '', 'g'), 10) AS d10,
      agent_name, campaign, disposition_name, coalesce(call_start_at, received_at) AS t
    FROM five9_events_raw
    WHERE event_type = 'disposition'
      AND received_at >= timestamptz '${from}' - interval '1 day'
      AND received_at < timestamptz '${to}' + interval '31 days'
      AND coalesce(agent_name, '') <> ''
      AND coalesce(campaign, '') !~* '${NON_SETTER_CAMPAIGN_RX}'
  ), keys AS (
    -- One row per way a lead can be found. Three plain equality joins, not one
    -- OR join: the OR form cannot hash-join and hit the statement timeout.
    SELECT lp_lead_id, entry_utc, 'LDS' || lp_lead_id AS k, NULL::text AS p, 1 AS rank FROM leads
    UNION ALL SELECT lp_lead_id, entry_utc, 'INQ' || in1_id, NULL, 2 FROM leads WHERE in1_id IS NOT NULL
    UNION ALL SELECT lp_lead_id, entry_utc, NULL, p1, 3 FROM leads WHERE length(p1) = 10
    UNION ALL SELECT lp_lead_id, entry_utc, NULL, p2, 3 FROM leads WHERE length(p2) = 10 AND p2 IS DISTINCT FROM p1
  ), hits AS (
    SELECT k.lp_lead_id, k.rank, c.* FROM keys k JOIN calls c ON c.lp_rec_key = k.k
      WHERE c.t >= k.entry_utc - interval '2 hours' AND c.t < k.entry_utc + interval '30 days'
    UNION ALL
    SELECT k.lp_lead_id, k.rank, c.* FROM keys k JOIN calls c ON c.d10 = k.p
      WHERE c.t >= k.entry_utc - interval '2 hours' AND c.t < k.entry_utc + interval '30 days'
  ), matched AS (
    -- A call found both by key and by phone counts once, under the best key.
    SELECT DISTINCT ON (lp_lead_id, id) lp_lead_id, agent_name, campaign, disposition_name, t,
      CASE rank WHEN 1 THEN 'lead_key' WHEN 2 THEN 'inbound_key' ELSE 'phone' END AS matched_by
    FROM hits ORDER BY lp_lead_id, id, rank
  ), firstc AS (
    SELECT DISTINCT ON (lp_lead_id) lp_lead_id, agent_name AS first_agent, campaign AS first_campaign,
      disposition_name AS first_dispo, t AS first_call_at, matched_by
    FROM matched ORDER BY lp_lead_id, t
  ), per_lead AS (
    SELECT m.lp_lead_id,
      count(*) AS setter_calls,
      bool_or(m.disposition_name ~* 'appointment\\s*set') AS any_appt_set,
      array_agg(DISTINCT coalesce(m.disposition_name, '')) FILTER (WHERE m.agent_name = f.first_agent) AS first_agent_dispos
    FROM matched m JOIN firstc f USING (lp_lead_id)
    GROUP BY m.lp_lead_id
  )
  SELECT l.lp_lead_id, l.lead_source, l.lead_source_detail, l.lp_deleted_at, l.ever_set, l.ever_sat,
    l.appointment_set, l.set_date, l.appointment_date, l.demo_completed, l.closed_won, l.set_by_name,
    l.entry_utc, f.first_agent, f.first_campaign, f.first_dispo, f.first_call_at, f.matched_by,
    p.setter_calls, p.any_appt_set, p.first_agent_dispos,
    right(coalesce(l.p1, ''), 4) AS phone_last4,
    CASE WHEN length(l.p1) = 10 THEN md5(l.p1) END AS phone_key
  FROM leads l
  LEFT JOIN firstc f USING (lp_lead_id)
  LEFT JOIN per_lead p USING (lp_lead_id)`;
}

/** LightFire roster from the CI agent map (seeded from Five9 user records, no suffix). */
export const ROSTER_SQL = `SELECT agent_name FROM ci_agent_map WHERE team = 'lightfire'`;

/** First call per agent name, so the start date can be read with the roster rule. */
export const AGENT_FIRST_CALL_SQL = `SELECT agent_name, min(coalesce(call_start_at, received_at)) AS first_at
  FROM five9_events_raw
  WHERE event_type = 'disposition' AND coalesce(agent_name, '') <> ''
    AND coalesce(campaign, '') !~* '${NON_SETTER_CAMPAIGN_RX}'
  GROUP BY agent_name`;

/** LP 137 By Setter, LightFire setters only, per ingested snapshot. Empty until LP schedules it. */
export const SETTER_137_SQL = `SELECT s.period_start::text AS period_start, s.period_end::text AS period_end,
    s.scope, sum(h.num_issued) AS issued, sum(h.num_sat) AS sat, sum(h.num_sold) AS sold
  FROM lp_sales_efficiency_setter_history h
  JOIN scorecard_report_snapshots s ON s.id = h.snapshot_id
  WHERE h.setter_name_raw ~* '-\\s*LF\\s*,' AND coalesce(s.is_current, true)
  GROUP BY 1, 2, 3 ORDER BY 1`;

/**
 * LP report 136 rows per sub-source for each month: the current full-month
 * snapshot, and for the running month the newest month-to-date one.
 */
export const SOURCE_COST_SQL = `WITH snaps AS (
    SELECT DISTINCT ON (to_char(period_start, 'YYYY-MM')) id, to_char(period_start, 'YYYY-MM') AS month,
      period_start, period_end, scope, as_of_date
    FROM scorecard_report_snapshots
    WHERE report_type = 'source_cost' AND scope IN ('month', 'mtd')
      AND abandoned_at IS NULL AND coalesce(is_current, true)
      AND period_start = date_trunc('month', period_start)
    ORDER BY to_char(period_start, 'YYYY-MM'), (scope = 'month') DESC, period_end DESC, as_of_date DESC NULLS LAST
  )
  SELECT s.month, s.scope, s.period_end::text AS period_end, h.sub_source,
    h.num_raw, h.num_set, h.num_sat, h.num_sold
  FROM snaps s JOIN lp_source_cost_history h ON h.snapshot_id = s.id`;

/**
 * For a spot check: the customer's OTHER LP leads that were set, within 30
 * days either side. On 2026-10-08 both spot-check mismatches were this case:
 * the LightFire agent set the appointment on the customer's second LP lead.
 */
export function siblingSetsSql(leadIds) {
  const ids = leadIds.map(String).filter((x) => /^\d+$/.test(x));
  if (!ids.length) return null;
  return `WITH t AS (
      SELECT lp_lead_id, created_at_lp, right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) AS p
      FROM lp_leads WHERE lp_lead_id IN (${ids.map((x) => `'${x}'`).join(', ')})
    )
    SELECT t.lp_lead_id AS for_lead, l.lp_lead_id, l.lead_source_detail, l.set_by_name, l.set_date::text AS set_date
    FROM t JOIN lp_leads l
      ON length(t.p) = 10 AND right(regexp_replace(coalesce(l.phone, ''), '\\D', '', 'g'), 10) = t.p
    WHERE l.lp_lead_id <> t.lp_lead_id AND l.lp_deleted_at IS NULL
      AND (l.ever_set OR l.appointment_set)
      AND l.created_at_lp BETWEEN t.created_at_lp - interval '30 days' AND t.created_at_lp + interval '30 days'`;
}

/** Bind the reads to a runSQL. */
export function makeBattingReads(deps = {}) {
  const runSQL = deps.runSQL;
  if (typeof runSQL !== 'function') throw new Error('makeBattingReads needs deps.runSQL');
  const rows = async (sql) => {
    const r = await runSQL(sql);
    return Array.isArray(r) ? r : [];
  };
  return {
    leadsForMonth: (m) => rows(leadsForMonthSql(m)),
    lightfireMonth: (m) => rows(lightfireMonthSql(m)),
    roster: () => rows(ROSTER_SQL),
    agentFirstCalls: () => rows(AGENT_FIRST_CALL_SQL),
    setter137: () => rows(SETTER_137_SQL),
    sourceCost: () => rows(SOURCE_COST_SQL),
    siblingSets: (ids) => { const q = siblingSetsSql(ids); return q ? rows(q) : Promise.resolve([]); },
  };
}
