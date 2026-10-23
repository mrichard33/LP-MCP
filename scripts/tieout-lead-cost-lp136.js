#!/usr/bin/env node
/**
 * Lead Cost dollars vs LP report 136 (Mktg Sub-Source Cost Analysis 2) — the tie-out.
 *
 *   node scripts/tieout-lead-cost-lp136.js
 *   node scripts/tieout-lead-cost-lp136.js --from=2026-10-01 --to=2026-10-22
 *
 * Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for the LP Supabase (LP_SUPABASE_* also read).
 * READ-ONLY: SELECTs through run_sql, nothing else.
 *
 * 2026-10-23 (migration 20261023120000): v_market_subsource_cost's Gross $ is now
 * SUM(lp_jobs.job_value) over jobs whose LEAD was created in the period, which is
 * how LP 136 counts. This prints, per sub-source, Gross $ for leads created
 * --from..--to (inclusive, Eastern date = the stored created_at_lp read as UTC) next
 * to the LP 136 figure, and every sub-source off by more than $1. It also checks
 * the view itself: the month's company rows must equal the same query run for
 * the whole month (the view has no day cut, so the day range is read directly).
 *
 * LP136 holds the figures from the 2026-10-23 handoff (10/1-10/22, company).
 * KNOWN_GAPS are reported, never forced to match: the handoff asked for them to be
 * looked into, not hidden.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';

export const LP136 = {
  'Lead Gurus': 777712,
  Modernize: 112750,
  'Bing PPC': 279749,
  'Reece ChatBot': 150705,
  'Self Generated': 159106,
  HomeBuddy: 100205,
  'MVP Marketing': 42090,
  // LP prints Customer Referral on two rows ($99,075 + $96,000).
  'Customer Referral': 195075,
};

/** Gaps the handoff named (dashboard − LP 136 as it read on 2026-10-23). */
export const KNOWN_GAPS = {
  Canvass: 'LP 136 −$7,690 (130 vs 131 jobs)',
  MyHomePros: '+$7,374 vs LP 136',
  Google: '+$10,862 vs LP 136',
  'Senior Expo Home Show': '+$19,300 vs LP 136',
};

/**
 * Pure: compare our Gross $ by sub-source with LP 136. `ours` is
 * { [sub_source]: { gross, jobs } }. Returns one line per LP 136 figure, plus
 * the known gaps, with `off` (ours − LP) and `ok` (|off| <= $1).
 */
export function compareToLp136(ours, lp136 = LP136, knownGaps = KNOWN_GAPS) {
  const lines = [];
  for (const [src, lp] of Object.entries(lp136)) {
    const mine = Number(ours[src]?.gross ?? 0);
    const off = Math.round((mine - lp) * 100) / 100;
    lines.push({ source: src, ours: mine, lp136: lp, off, ok: Math.abs(off) <= 1, jobs: ours[src]?.jobs ?? 0 });
  }
  for (const [src, note] of Object.entries(knownGaps)) {
    lines.push({ source: src, ours: Number(ours[src]?.gross ?? 0), lp136: null, off: null, ok: null, jobs: ours[src]?.jobs ?? 0, note });
  }
  return lines;
}

const ET = "(l.created_at_lp AT TIME ZONE 'UTC')";

/** Gross $ and job count by sub-source for leads created in [from, to], all markets and real markets only. */
export function grossBySourceSql(from, to) {
  return `SELECT json_agg(row_to_json(s)) FROM (
    SELECT COALESCE(l.lead_source_detail, '(none)') AS source,
           SUM(j.job_value) AS gross, COUNT(*) AS jobs,
           SUM(j.job_value) FILTER (WHERE COALESCE(m.market_code, a.resolved_market_code, 'UNASSIGNED') LIKE '%\\_MKT') AS gross_in_markets
    FROM lp_jobs j
    JOIN lp_leads l ON l.lp_lead_id = j.lp_lead_id
    LEFT JOIN lp_branch_market_map m ON m.brn_id = l.lp_branch_id
    LEFT JOIN lp_lead_market_assignments a ON a.lead_id = l.lp_lead_id
    WHERE l.lp_deleted_at IS NULL
      AND ${ET} >= DATE '${from}' AND ${ET} < DATE '${to}' + 1
    GROUP BY 1) s`;
}

export function viewMonthSql(month) {
  return `SELECT json_agg(row_to_json(s)) FROM (
    SELECT lp_sub_source AS source, SUM(gross) AS gross
    FROM v_market_subsource_cost
    WHERE grain = 'month' AND period_start = DATE '${month}' AND market LIKE '%\\_MKT'
    GROUP BY 1) s`;
}

const ymd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '') ? v : null;

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
  const from = ymd(args.from) ?? '2026-10-01';
  const to = ymd(args.to) ?? '2026-10-22';
  const url = process.env.SUPABASE_URL || process.env.LP_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.LP_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (LP) are not set');
  const sb = createClient(url, key);
  const sql = async (q) => {
    const { data, error } = await sb.rpc('run_sql', { query_text: q });
    if (error) throw new Error(error.message);
    return (Array.isArray(data) ? data[0]?.json_agg : data?.json_agg) ?? [];
  };

  const rows = await sql(grossBySourceSql(from, to));
  const ours = Object.fromEntries(rows.map((r) => [r.source, { gross: Number(r.gross), jobs: Number(r.jobs), inMarkets: Number(r.gross_in_markets ?? 0) }]));
  console.log(`Gross $ by sub-source, leads created ${from} .. ${to} (company), vs LP 136:\n`);
  let bad = 0;
  for (const l of compareToLp136(ours)) {
    const money = (v) => (v == null ? '—' : `$${Number(v).toLocaleString('en-US')}`);
    if (l.note) {
      console.log(`  ~ ${l.source.padEnd(24)} ours ${money(l.ours).padStart(12)}  ${l.jobs} jobs   known gap: ${l.note}`);
    } else {
      if (!l.ok) bad += 1;
      console.log(`  ${l.ok ? '✓' : '✗'} ${l.source.padEnd(24)} ours ${money(l.ours).padStart(12)}  LP136 ${money(l.lp136).padStart(12)}  off ${money(l.off)}`);
    }
    const inMkts = ours[l.source]?.inMarkets;
    if (inMkts != null && Math.abs(inMkts - l.ours) > 1) {
      console.log(`      (only ${money(inMkts)} lands on a market row; the rest sits on leads with no market)`);
    }
  }

  // The view must agree with the direct query for a whole month.
  const month = `${from.slice(0, 7)}-01`;
  const monthEnd = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const [viewRows, direct] = await Promise.all([sql(viewMonthSql(month)), sql(grossBySourceSql(month, monthEnd))]);
  const dmap = Object.fromEntries(direct.map((r) => [r.source, Number(r.gross_in_markets ?? 0)]));
  const drift = viewRows.filter((r) => Math.abs(Number(r.gross ?? 0) - (dmap[r.source] ?? 0)) > 1);
  console.log(`\nView check (${month.slice(0, 7)}, market rows): ${drift.length ? `${drift.length} sub-source(s) differ (is migration 20261023120000 applied?)` : 'the view matches the direct query'}`);
  for (const r of drift) console.log(`  ✗ ${r.source}: view ${r.gross} vs direct ${dmap[r.source] ?? 0}`);

  if (bad || drift.length) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
