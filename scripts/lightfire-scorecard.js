#!/usr/bin/env node
/**
 * LightFire batting average scorecard — run it once a month.
 *
 *   node scripts/lightfire-scorecard.js
 *
 * That is the whole command. It needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 * for the LP Supabase (as on Railway: `railway run node scripts/lightfire-scorecard.js`).
 * Options:
 *   --month=2026-10        the month the card is for (default: this month, Eastern)
 *   --out=reports/lightfire/2026-10   where the files go (default shown; reports/ is gitignored)
 *   --seed=1               which 10 at bats the spot check draws (same seed = same 10)
 *
 * Writes three files:
 *   scorecard.html   the one-page card to send LightFire (works on a phone, no internet needed)
 *   numbers.csv      the monthly numbers behind it, plus the in-house and all-leads comparison rows
 *   notes.md         numbers that may be off and why, the spot check, the 137 cross-check
 *
 * READ-ONLY: it only SELECTs. The arithmetic is src/batting-average.js (pure, reusable by
 * a Reece Dashboard page), the reads src/batting-average-io.js, the page src/batting-average-html.js.
 * Brad's brief: Sales Performance Review, 2026-10-08.
 */

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  agentKey, isLightFireAgent, isDirectToYouLead, atBatsOf, leadOutcome, tallyLeads, tallySourceCost, sumTallies, battingAvg,
  buildScorecard, toCsv, splitByOwner, splitByFirstCaller, drawSample, checkAtBat, duplicateCustomerAtBats, addMonths, monthLabel,
} from '../src/batting-average.js';
import { makeBattingReads } from '../src/batting-average-io.js';
import { renderScorecardHtml } from '../src/batting-average-html.js';

export const BASELINE_FEB = '2026-02';
export const BASELINE_Q2 = ['2026-04', '2026-05', '2026-06'];

/**
 * The whole-team line reads our lp_leads copy once it holds this share of the
 * leads LP's report 136 counts, else the report. Why: the report rows are frozen
 * when each month's last email lands (July as of Aug 10, August as of Sep 1,
 * September as of Oct 1), so the first card compared a fresh LightFire count
 * with a whole team read days after the month closed (Aug 1.8 per 100 then,
 * 2.4 on 2026-10-08). Our copy is live but thin before late July (87% of July's
 * leads, missing mostly unsold ones, which would overstate July), so July keeps
 * the report, dated.
 */
export const WHOLE_TEAM_COPY_MIN_COVERAGE = 0.9;

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function etMonthKey(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit' })
    .formatToParts(d);
  return `${p.find((x) => x.type === 'year').value}-${p.find((x) => x.type === 'month').value}`;
}
function etDate(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(iso));
}

/** Everything the three files are built from. `reads` is makeBattingReads(...). */
export async function collectScorecard({ reads, todayMonth, seed = 1, log = () => {} }) {
  const rosterRows = await reads.roster();
  const roster = new Set(rosterRows.map((r) => agentKey(r.agent_name)));

  // LightFire's start: the first setter call Five9 has from any LightFire agent.
  const firsts = await reads.agentFirstCalls();
  const lfFirst = firsts.filter((r) => isLightFireAgent(r.agent_name, roster))
    .map((r) => r.first_at).filter(Boolean).sort()[0] || null;
  if (!lfFirst) throw new Error('No LightFire agent call found in Five9: cannot place the start date');
  const startDate = etDate(lfFirst);
  const startMonth = startDate.slice(0, 7);
  log(`LightFire's first Five9 setter call: ${startDate}`);

  // Before LightFire: LP's own report 136 by sub-source (see tallySourceCost
  // for why not our lp_leads copy). A month the report never arrived for falls
  // back to lp_leads, and the notes say so.
  const sourceCost = await reads.sourceCost();
  const reportMonth = (m) => sourceCost.filter((r) => r.month === m);
  const before = {};
  const beforeSource = {};
  for (const m of [BASELINE_FEB, ...BASELINE_Q2]) {
    const rows = reportMonth(m);
    if (rows.length) {
      before[m] = tallySourceCost(rows);
      beforeSource[m] = 'LP report 136';
    } else {
      const { atBats } = atBatsOf((await reads.leadsForMonth(m)).filter(isDirectToYouLead));
      before[m] = tallyLeads(atBats);
      beforeSource[m] = 'lp_leads copy (report 136 missing; likely overstated)';
    }
    log(`${m}: ${before[m].atBats} at bats (${beforeSource[m]})`);
  }

  const months = [];
  for (let m = startMonth; m <= todayMonth; m = addMonths(m, 1)) months.push(m);
  if (!months.length) throw new Error(`--month=${todayMonth} is before LightFire's first call (${startDate}): nothing to score`);
  const lightfireMonths = [];
  const inHouseRows = [];
  const allLeadRows = [];
  const quality = [];
  const lfAtBats = [];
  const creditRows = [];
  for (const m of months) {
    const monthRows = await reads.lightfireMonth(m);
    const split = splitByOwner(monthRows, roster);
    const old = splitByFirstCaller(monthRows, roster);
    const lf = tallyLeads(split.lightfire);
    const partial = m === startMonth && !startDate.endsWith('-01')
      ? `LightFire from ${monthLabel(m)} ${Number(startDate.slice(8))}` : null;
    lightfireMonths.push({ month: m, tally: lf, partial });
    const ih = tallyLeads(split.inHouse);
    const floorRows = reportMonth(m);
    const report = floorRows.length ? tallySourceCost(floorRows) : null;
    const copy = tallyLeads([...split.all, ...split.preset]);
    const useCopy = !report || copy.atBats >= WHOLE_TEAM_COPY_MIN_COVERAGE * report.atBats;
    const all = useCopy ? (copy.atBats ? copy : null) : report;
    const allNote = useCopy
      ? `every new lead, whoever called, from our live copy of LP (${report ? `${pct(copy.atBats, report.atBats)} of the leads LP's report counts` : 'no LP report for this month'})`
      : `same basis as Feb/Q2: LP report 136 as of ${floorRows[0].as_of_date || floorRows[0].period_end}${floorRows[0].scope === 'mtd' ? ' (month to date)' : ''}, every new lead, whoever called`;
    inHouseRows.push({ label: `${monthLabel(m)} in-house`, month: m, ...ih, ...battingAvg(ih.hits, ih.atBats), seasonTag: 'in_house_same_month', note: 'set by an in-house agent, or unset with an in-house first call' });
    if (all) allLeadRows.push({ label: `${monthLabel(m)} whole team`, month: m, ...all, ...battingAvg(all.hits, all.atBats), seasonTag: 'whole_team', source: useCopy ? 'copy' : 'report', note: allNote });
    creditRows.push({ month: m, now: lf, before: tallyLeads(old.lightfire), bySetter: split.lightfire.filter((r) => r.owner === 'setter').length });
    const byKey = {};
    for (const r of split.all) byKey[r.matched_by || 'no Five9 setter call'] = (byKey[r.matched_by || 'no Five9 setter call'] || 0) + 1;
    quality.push({ month: m, lfAtBats: lf.atBats, noDispo: lf.noDispo, inHouse: ih.atBats, uncalled: split.uncalled.length, all: split.all.length, lpReportLeads: report ? report.atBats : null, preset: split.preset.length, presetHits: tallyLeads(split.preset).hits, byKey, dupCustomers: duplicateCustomerAtBats(split.lightfire) });
    lfAtBats.push(...split.lightfire);
    log(`${m}: LightFire ${lf.atBats} at bats, in-house ${ih.atBats}, no setter call ${split.uncalled.length}`);
  }

  const model = buildScorecard({
    february: before[BASELINE_FEB],
    q2Months: BASELINE_Q2.map((m) => before[m]),
    lightfireMonths,
    todayMonth,
    startDate,
  });
  const setter137 = await reads.setter137();
  const sample = drawSample(lfAtBats, { n: 10, seed });
  const sibs = reads.siblingSets ? await reads.siblingSets(sample.map((r) => r.lp_lead_id)) : [];
  const spot = sample.map((r) => checkAtBat(r, sibs.filter((x) => String(x.for_lead) === String(r.lp_lead_id))));
  return { model, before, beforeSource, quality, inHouseRows, allLeadRows, creditRows, setter137, spot, startDate, roster };
}

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');

/** notes.md: every number that may be off, and why. */
export function renderNotes({ model, before, beforeSource, quality, inHouseRows, allLeadRows, creditRows = [], setter137, spot, startDate }) {
  const L = [];
  const feb = before[BASELINE_FEB];
  const q2 = sumTallies(BASELINE_Q2.map((m) => before[m]));
  L.push(`# LightFire scorecard: data notes (${model.todayMonth})`, '');
  L.push(`Headline: LightFire is batting **${model.headline.text}** (${model.headline.per100 ?? '—'} hits per 100) over ${model.headline.span}${model.headline.maturedOnly ? ' (matured months only)' : ''}. February: **${model.headline.febText}**.`, '');
  L.push(`Coaching line: ${model.coaching.line}`, '');

  L.push('## How each period is counted', '');
  L.push(`- **LightFire start:** ${startDate}, LightFire's first setter call in Five9. Five9 has no calls at all before 2026-07-03.`);
  L.push(`- **February and Q2 (before LightFire)** come from LP's own report 136 (Marketing Sub-Source Cost Analysis), which counts leads, sets, demos ("sat") and sales by lead ENTRY month, per sub-source. Source: Feb ${beforeSource[BASELINE_FEB]}; ${BASELINE_Q2.map((m) => `${monthLabel(m)} ${beforeSource[m]}`).join('; ')}.`);
  L.push('- **LightFire months:** a new lead is LightFire\'s at bat when a LightFire agent SET its appointment (LP\'s "set by"), or, when nobody set it, when a LightFire agent made the first setter call (Five9). Sets, demos and sales for that lead come from LP (our synced copy of each lead). This is how LP and report 137 credit a setter.');
  L.push('- Calls are matched to LP by lead key (LDS), then LP\'s inbound id (INQ), then phone. Confirmation, rehash, previous-customer, dispatch, reset and cancel-save campaigns are not setter calls.');
  L.push('- Left out everywhere: canvass, canvass sticky, previous customers, and rep self-generated leads.');
  L.push('- Every lead is counted in the month it was ENTERED in LP, never by appointment date.', '');

  L.push('## Numbers that may be off', '');
  const matured = new Set(model.rows.this.filter((r) => !r.maturing).map((r) => r.month));
  const floorPool = sumTallies(allLeadRows.filter((r) => matured.has(r.month)));
  const floorAvg = battingAvg(floorPool.hits, floorPool.atBats);
  L.push(`1. **Our copy of LP is missing most of February's and Q2's unsold leads, so it is NOT used for the baseline.** It holds 3,149 February leads; LP's report counts 12,444. Sales are copied in by the job sync and unsold leads are not, so February read .097 from our copy against LP's real **${battingAvg(feb.hits, feb.atBats).text}**. From late July our copy holds about 95% of LP's leads, so the LightFire months are counted from it.`);
  L.push(`2. **February's and Q2's at bats include every new lead; LightFire's include only the leads LightFire set or called first.** LP's report cannot say who called, and it also cannot leave out appointments that came with the lead (point 3), which flatters the baseline a little. For a like-for-like check, the WHOLE team (every new lead, whoever called) batted **${floorAvg.text}** over the matured LightFire months${floorPool.atBats ? '' : ' (no rows yet)'}: ${allLeadRows.map((r) => `${monthLabel(r.month)} ${r.text} (${r.note})`).join('; ')}. Rows are in numbers.csv as \`whole_team\`.`);
  const lfPreset = quality.reduce((a, q) => a + q.preset, 0);
  const lfPresetHits = quality.reduce((a, q) => a + q.presetHits, 0);
  L.push(`3. **Appointments that already existed are left out of LightFire's at bats.** When LP says a lead was set by "No, Setter", a bot ("Agent, Revin", "Integration, GoHighLevel") or a vendor ("Internet, Lead Gurus"), the appointment came with the lead or was booked automatically, so a setter could only confirm it. Left out in the LightFire months: ${lfPreset} leads (${lfPresetHits} sales). LP's report cannot separate these for February and Q2, so they stay in the baseline (in our partial copy they were about 13% of February's sales).`);
  const fb = model.rows.this.reduce((a, r) => a + (r.fallbackFlags || 0), 0);
  L.push(`4. **LP's "ever set" / "ever sat" flags are blank on ${fb} LightFire-month leads** (July, from rows not re-synced since the flags were added). For those, sets come from the appointment fields and demos from "demo completed".`);
  L.push('5. **Rehash cannot be separated in February or Q2.** Canvass and previous customers are LP sub-sources and come out cleanly. Rehash is calling work on old leads, not a source; because only leads ENTERED in the month count, rehash calls on older leads never become at bats. A new lead that was later set by the rehash team still counts for its entry month.');
  L.push('6. **The newest two months are still maturing, but only a little.** About 95% of sales close within 23 days of the lead coming in (every month Jan–Sep 2026, measured 2026-10-08), so last month is nearly final and only the running month will rise much. The headline still uses matured months only.');
  const startQ = quality[0];
  L.push(`7. **${monthLabel(startQ.month)} is a partial LightFire month** (from ${startDate}). In-house agents made the first call on leads before then.`);
  L.push('8. **Sales are gross** (LP "sold"), before cancellations and credit declines, in every period.');
  const dupTotal = quality.reduce((a, q) => a + q.dupCustomers, 0);
  const lfTotal = quality.reduce((a, q) => a + q.lfAtBats, 0);
  L.push(`9. **Some customers have two LP leads in the same month.** ${dupTotal} of ${lfTotal} LightFire at bats (${pct(dupTotal, lfTotal)}) share a phone with another LightFire at bat. Each LEAD counts once, as LP's own report does, so a customer with two leads is two at bats; when the set went on the other lead, one of them reads as an out.`, '');

  if (creditRows.length) {
    L.push('## How credit changed (2026-10-08)', '');
    L.push('The first card gave a lead to whoever made the FIRST setter call, so when in-house called first and LightFire set the visit later, the sale counted for in-house. A lead now belongs to whoever SET it (user ruling, 2026-10-08).', '');
    L.push('| Month | At bats (first-call rule → now) | Sets | Demos | Sales | AVG | Placed by LP setter |');
    L.push('|---|---:|---:|---:|---:|---:|---:|');
    for (const c of creditRows) {
      const a = battingAvg(c.before.hits, c.before.atBats), b = battingAvg(c.now.hits, c.now.atBats);
      L.push(`| ${monthLabel(c.month, true)} | ${c.before.atBats} → ${c.now.atBats} | ${c.before.walks} → ${c.now.walks} | ${c.before.onBase} → ${c.now.onBase} | ${c.before.hits} → ${c.now.hits} | ${a.text} → ${b.text} | ${c.bySetter} |`);
    }
    L.push('');
  }

  L.push('## At bats with no disposition', '');
  L.push('A LightFire at bat that LightFire called first is flagged when every call its first agent made on that lead was left as "No Disposition" or blank. These are COUNTED, never dropped.', '');
  L.push('| Month | LightFire at bats | No disposition | Share | In-house at bats | Unset, no setter call | Pre-set (left out) | LightFire at bats sharing a customer | New leads in our copy | New leads, LP report |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const q of quality) L.push(`| ${monthLabel(q.month, true)} | ${q.lfAtBats} | ${q.noDispo} | ${pct(q.noDispo, q.lfAtBats)} | ${q.inHouse} | ${q.uncalled} | ${q.preset} | ${q.dupCustomers} | ${q.all + q.preset} | ${q.lpReportLeads ?? '—'} |`);
  L.push('');
  L.push('How leads were matched to Five9:', '');
  for (const q of quality) L.push(`- ${monthLabel(q.month, true)}: ${Object.entries(q.byKey).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  L.push('');

  L.push('## LightFire vs in-house, same months', '');
  L.push('| Month | LightFire AVG (at bats) | In-house AVG (at bats) |');
  L.push('|---|---:|---:|');
  for (const r of model.rows.this) {
    const ih = inHouseRows.find((x) => x.month === r.month);
    L.push(`| ${r.label}${r.maturing ? ' (maturing)' : ''} | ${r.text} (${r.atBats}) | ${ih.text} (${ih.atBats}) |`);
  }
  L.push('', 'In-house agents mostly pick up inbound calls and callbacks, not the outbound new-lead list, so this is context, not a head-to-head.', '');

  L.push('## Report 137 cross-check', '');
  if (!setter137.length) {
    L.push('**Pending.** LP report 137 "Sales Efficiency, By Setter" has never been scheduled, so no rows exist yet. Once LP emails it to the ingest address, this section compares LightFire\'s issued / sat / sold from 137 with the counts above. Expect gaps: 137 counts by APPOINTMENT date and cannot filter by sub-source; this card counts by lead ENTRY date.');
  } else {
    L.push('137 counts by appointment date; this card counts by lead entry date, so the two will not match exactly. A large gap is worth a look.', '');
    L.push('| 137 period | Scope | Issued | Sat | Sold | Card sets | Card demos | Card sales |');
    L.push('|---|---|---:|---:|---:|---:|---:|---:|');
    for (const s of setter137) {
      const r = model.rows.this.find((x) => s.period_start && s.period_start.startsWith(x.month));
      L.push(`| ${s.period_start}–${s.period_end} | ${s.scope || ''} | ${s.issued} | ${s.sat} | ${s.sold} | ${r ? r.walks : '—'} | ${r ? r.onBase : '—'} | ${r ? r.hits : '—'} |`);
    }
  }
  L.push('');

  L.push('## Spot check: 10 random LightFire at bats, end to end', '');
  const ok = spot.filter((s) => s.verdict === 'match').length;
  const dup = spot.filter((s) => s.why.startsWith('duplicate lead')).length;
  L.push(`**${ok} of ${spot.length} match** (Five9 and LP agree on whether an appointment was set)${dup ? `, ${dup} of them only once the customer's duplicate LP lead is read` : ''}.`, '');
  L.push('| LP lead | Phone | First call (ET) | Agent | Campaign | Matched by | Five9 set | LP set | Demo | Sale | Result |');
  L.push('|---|---|---|---|---|---|:-:|:-:|:-:|:-:|---|');
  const yn = (b) => (b ? '✓' : '·');
  for (const s of spot) {
    const t = s.first_call_at ? new Date(s.first_call_at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    L.push(`| ${s.lp_lead_id} | …${s.phone_last4} | ${t} | ${s.first_agent} | ${s.first_campaign} | ${s.matched_by} | ${yn(s.five9_set)} | ${yn(s.lp_set)} | ${yn(s.lp_demo)} | ${yn(s.lp_sale)} | ${s.verdict}: ${s.why} |`);
  }
  L.push('');
  return L.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const todayMonth = args.month || etMonthKey();
  if (!/^\d{4}-\d{2}$/.test(todayMonth)) throw new Error('--month must be YYYY-MM');
  const outDir = resolve(args.out || join('reports', 'lightfire', todayMonth));
  const seed = Number(args.seed || 1);

  const { runSQL } = await import('../src/admin/supabase-admin.js');
  const reads = makeBattingReads({ runSQL });
  const data = await collectScorecard({ reads, todayMonth, seed, log: (s) => console.log(s) });

  mkdirSync(outDir, { recursive: true });
  const extra = [...data.allLeadRows, ...data.inHouseRows];
  const maturedMonths = new Set(data.model.rows.this.filter((r) => !r.maturing).map((r) => r.month));
  const ctx = data.allLeadRows.filter((r) => r.atBats > 0 && maturedMonths.has(r.month));
  // Two lines under the headline: how many sales LightFire set (the volume, which
  // grew while the average fell as LightFire took over more of the calling), and
  // the whole team on the same months.
  const fullLf = data.model.rows.this.filter((r) => !r.mtd);
  const context = [
    fullLf.length ? `LightFire's sales: ${fullLf.map((r) => `${r.label} ${r.hits}`).join(' · ')}` : null,
    ctx.length ? `Whole team, same months: ${ctx.map((r) => `${monthLabel(r.month)} ${r.text}`).join(' · ')}` : null,
  ].filter(Boolean);
  writeFileSync(join(outDir, 'scorecard.html'), renderScorecardHtml(data.model, { context }));
  writeFileSync(join(outDir, 'numbers.csv'), toCsv(data.model, extra));
  writeFileSync(join(outDir, 'notes.md'), renderNotes(data));
  const h = data.model.headline;
  console.log(`\nLightFire is batting ${h.text} (${h.per100} per 100) over ${h.span}; February ${h.febText}.`);
  console.log(`Wrote ${outDir}/scorecard.html, numbers.csv, notes.md`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}

