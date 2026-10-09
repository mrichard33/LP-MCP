/**
 * LightFire batting average — src/batting-average.js
 *
 * The at-bat / hit arithmetic behind the monthly LightFire scorecard
 * (scripts/lightfire-scorecard.js). Brad's question (Sales Performance Review,
 * 2026-10-08): "Out of 100 at bats, how many sales does LightFire produce?",
 * head to head against how we did before LightFire.
 *
 *   at bat  = one new Direct to You lead worked by the setter, counted once
 *   walk    = appointment set
 *   on base = demo
 *   hit     = sale
 *   AVG     = hits ÷ at bats (9 per 100 = .090)
 *
 * Pure module: no env, no clients, no import-time work, so a Reece Dashboard
 * page can import it as-is. The reads live in batting-average-io.js.
 *
 * Rulings this encodes (the user, 2026-10-08):
 *  - "Direct to You" is not a Five9 campaign or an LP source anywhere. It means
 *    every NEW incoming lead: canvass, previous customers, rehash and
 *    confirmation work are not at bats.
 *  - Five9 holds no calls before 2026-07-03 (the Call Log report is empty for
 *    February, May and June 30), so the "before" months are counted from LP
 *    and the LightFire months from Five9's first setter call on each lead.
 *  - Every lead is counted by LP ENTRY date, never appointment date.
 */

import { teamFromName, stripTeamSuffix } from './ci/teams.js';

/**
 * LP sources that are never a new incoming lead for a setter: canvass (the
 * canvasser set it at the door), previous customers, and rep self-generated
 * leads (the rep found the customer and booked it: 81 sales from 169 leads,
 * Feb–Sep 2026, which would swamp a setter's average).
 */
export const EXCLUDED_SOURCES = Object.freeze(['Canvass', 'Canvass Sticky', 'PrevCust', 'SelfGenerated']);
/** The same exclusions as LP sub-sources (LP report 136 is keyed by sub-source; a website "Previous Customer" form too). */
export const EXCLUDED_SUB_SOURCES = Object.freeze(['Canvass', 'Canvass Sticky', 'Previous Customer', 'Self Generated']);
const EXCLUDED_SUB_SET = new Set(EXCLUDED_SUB_SOURCES.map((x) => x.toLowerCase()));

/**
 * Five9 campaigns that are follow-up work, not a first set attempt:
 * confirmation ("Conf - Next Day", "Canvass Confirmation - Inbound"), rehash,
 * previous customer, dispatch, cancel-contract saves and resets (a reset is a
 * cancelled appointment being re-set, not a new lead). Same idea as the
 * exclusion in sql/127_new_callers_no_lp_view.sql.
 *
 * Written as a POSIX regex so the IO layer can hand the SAME string to
 * Postgres (`campaign !~* ...`): one definition, never a second copy in SQL.
 */
export const NON_SETTER_CAMPAIGN_RX =
  '(confirmation|^conf -|rehash|previous customer|dispatch|cancel contract|reset)';
const NON_SETTER_RE = new RegExp(NON_SETTER_CAMPAIGN_RX, 'i');

/** Dispositions that mean the agent left the call undispositioned (the open LightFire issue since July). */
const NO_DISPO_RE = /^\s*(no disposition)?\s*$/i;

export function isDirectToYouLead(lead) {
  if (!lead || lead.lp_deleted_at) return false;
  if (EXCLUDED_SOURCES.includes(String(lead.lead_source ?? '').trim())) return false;
  return isDirectToYouSubSource(lead.lead_source_detail);
}

export function isDirectToYouSubSource(subSource) {
  return !EXCLUDED_SUB_SET.has(String(subSource ?? '').trim().toLowerCase());
}

/**
 * Tally LP report 136 (Marketing Sub-Source Cost Analysis) rows for one month:
 * leads → at bats, NumSet → walks, NumSat → on base, NumSold → hits, Direct
 * to You sub-sources only. This is LP's own count by lead ENTRY month (its
 * February lead total, 12,444, ties to report 135 exactly), so it is the
 * baseline for the months Five9 cannot see.
 *
 * Why not our lp_leads copy: on 2026-10-08 it held about a quarter of
 * February's leads (3,149 of 12,444) and 25–45% of LP's lead ids for March–May.
 * Sold leads are pulled in by the job sync and unsold ones are not, so a
 * February average from lp_leads read .097 against LP's real .026.
 */
export function tallySourceCost(rows) {
  const t = { atBats: 0, walks: 0, onBase: 0, hits: 0, fallbackFlags: 0, noDispo: 0 };
  for (const r of rows) {
    if (!isDirectToYouSubSource(r.sub_source)) continue;
    t.atBats += Number(r.num_raw || 0);
    t.walks += Number(r.num_set || 0);
    t.onBase += Number(r.num_sat || 0);
    t.hits += Number(r.num_sold || 0);
  }
  return t;
}

export function isSetterCampaign(campaign) {
  return !NON_SETTER_RE.test(String(campaign ?? ''));
}

export function isNoDisposition(name) {
  return NO_DISPO_RE.test(String(name ?? ''));
}

/** Lower-cased, suffix-free person name, so 'Shari Walker - LF' and 'Shari Walker' are one key. */
export function agentKey(name) {
  return stripTeamSuffix(String(name ?? '')).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * LightFire agent? The " - LF" suffix is authoritative when present, but Five9
 * only gained it around 2026-08-21: from 07-20 to 08-21 the same people dialled
 * as plain "Craig Deer". So the roster (ci_agent_map team='lightfire', keyed by
 * agentKey) catches the un-suffixed weeks. `roster` is a Set of agentKey values.
 */
export function isLightFireAgent(name, roster = new Set()) {
  if (teamFromName(name) === 'lightfire') return true;
  return roster.has(agentKey(name));
}

/**
 * LP's set_by name in agentKey form. LP writes "Last, First" ("Deer - LF, Craig",
 * or "Deer, Craig" before the suffix existed); Five9 and the roster write "First
 * Last". The " - LF" tag is dropped, the comma pair is turned round, and the
 * rest is agentKey, so one roster Set serves both sides. (repNameKey in
 * sale-facts.js does the same job but imports supabase; this module stays pure.)
 */
export function lpSetterKey(setByName) {
  const raw = String(setByName ?? '').replace(/\s*-\s*LF\b/i, '');
  const [last, first] = raw.split(',').map((x) => x.trim());
  return agentKey(first ? `${first} ${last}` : last);
}

/** Was this lead SET by a LightFire agent, by LP's own set_by field? */
export function isLightFireLpSetter(setByName, roster = new Set()) {
  if (/-\s*LF\s*,/i.test(String(setByName ?? ''))) return true;
  const k = lpSetterKey(setByName);
  return !!k && roster.has(k);
}

const truthy = (v) => v === true || v === 't' || v === 'true';
const isNull = (v) => v === null || v === undefined;

/**
 * Walk / on base / hit for ONE LP lead.
 *
 * LP's ever_* flags are the record of truth (they survive a cancel), but on
 * 2026-10-08 ever_set / ever_sat were NULL on ~2,400–3,700 leads a month for
 * March–July: rows not re-synced since those columns were added. For a NULL
 * flag only, fall back to the older fields (appointment_set / set_date /
 * appointment_date; demo_completed). Measured: no sale in Feb–Oct lacks a set
 * or a demo under these rules, so the funnel stays a funnel.
 */
export function leadOutcome(lead) {
  const setFallback = isNull(lead.ever_set);
  const sitFallback = isNull(lead.ever_sat);
  const walk = setFallback
    ? truthy(lead.appointment_set) || !isNull(lead.set_date) || !isNull(lead.appointment_date)
    : truthy(lead.ever_set);
  const onBase = sitFallback ? truthy(lead.demo_completed) : truthy(lead.ever_sat);
  const hit = truthy(lead.closed_won);
  return { walk: walk || onBase || hit, onBase: onBase || hit, hit, usedFallback: setFallback || sitFallback };
}

/**
 * LP set_by names that are not a human setter: "No, Setter" (the appointment
 * came WITH the lead, e.g. a vendor-booked visit), the bots ("Agent, Revin",
 * "Agent, Agentic", "Integration, GoHighLevel") and vendors booking direct
 * ("Internet, Lead Gurus", "Affiliate, MVP Marketing"). Measured 2026-10-08.
 */
const PRESET_SETTER_RE = /^\s*(no,\s*setter|agent,|integration,|internet,|affiliate,)/i;

/**
 * Brief: "Exclude any lead where the setter only confirmed or followed up an
 * appointment that already existed." A lead that was SET, by no setter, a bot
 * or a vendor, had its appointment before any setter called; it is not an at
 * bat in any period. An UNSET lead is still an at bat (an out), whatever its
 * placeholder name: LP stamps "No, Setter" on ~9,700 unset leads too.
 * On 2026-10-08 these were 29 of February's 245 sales and 48 of Jul–Aug's.
 */
export function isPresetAppointment(lead) {
  return PRESET_SETTER_RE.test(String(lead.set_by_name ?? '')) && leadOutcome(lead).walk;
}

/** Split leads into at bats and pre-set appointments (counted for the notes, never scored). */
export function atBatsOf(leads) {
  const atBats = [], preset = [];
  for (const l of leads) (isPresetAppointment(l) ? preset : atBats).push(l);
  return { atBats, preset };
}

/** Tally a list of at-bat leads. `noDispo` counts leads flagged by the IO layer. */
export function tallyLeads(leads) {
  const t = { atBats: 0, walks: 0, onBase: 0, hits: 0, fallbackFlags: 0, noDispo: 0 };
  for (const lead of leads) {
    const o = leadOutcome(lead);
    t.atBats += 1;
    if (o.walk) t.walks += 1;
    if (o.onBase) t.onBase += 1;
    if (o.hit) t.hits += 1;
    if (o.usedFallback) t.fallbackFlags += 1;
    if (lead.no_dispo) t.noDispo += 1;
  }
  return t;
}

export function sumTallies(tallies) {
  const out = { atBats: 0, walks: 0, onBase: 0, hits: 0, fallbackFlags: 0, noDispo: 0 };
  for (const t of tallies) for (const k of Object.keys(out)) out[k] += Number(t[k] || 0);
  return out;
}

/** hits ÷ at bats as a baseball average. null when there were no at bats. */
export function battingAvg(hits, atBats) {
  if (!atBats) return { avg: null, text: '—', per100: null };
  const avg = hits / atBats;
  // Baseball prints three decimals with no leading zero: .090, and 1.000.
  const text = avg >= 1 ? '1.000' : `.${String(Math.round(avg * 1000)).padStart(3, '0')}`;
  return { avg, text, per100: Math.round(avg * 1000) / 10 };
}

/** "2026-10" → "Oct", with the year when asked. */
export function monthLabel(key, withYear = false) {
  const [y, m] = key.split('-').map(Number);
  const name = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return withYear ? `${name} ${y}` : name;
}

export function addMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Sales lag the lead by weeks: this month and last month are still maturing. */
export function isMaturing(monthKey, todayMonthKey) {
  return monthKey >= addMonths(todayMonthKey, -1);
}

/**
 * Consecutive month-over-month rises ending at the last month given. A hot
 * streak is 2+ (Brad: "gone up 2+ months in a row"). Feed it FULL months only:
 * a partial month-to-date always looks like a slump.
 */
export function risingStreak(rows) {
  let n = 0;
  for (let i = rows.length - 1; i > 0; i--) {
    const a = rows[i].avg, b = rows[i - 1].avg;
    if (a == null || b == null || !(a > b)) break;
    n += 1;
  }
  return n;
}

const rate = (num, den) => (den ? num / den : null);

/**
 * One coaching line, aimed at the weakest step against the baseline:
 *   set   = walks ÷ at bats   (turning a new lead into an appointment)
 *   sit   = on base ÷ walks   (the appointment actually sitting for a demo)
 *   close = hits ÷ on base    (the demo turning into a sale)
 * The step furthest below its baseline rate (as a ratio) is the one named.
 */
export function coachingLine(current, baseline) {
  const steps = [
    { key: 'set', cur: rate(current.walks, current.atBats), base: rate(baseline.walks, baseline.atBats) },
    { key: 'sit', cur: rate(current.onBase, current.walks), base: rate(baseline.onBase, baseline.walks) },
    { key: 'close', cur: rate(current.hits, current.onBase), base: rate(baseline.hits, baseline.onBase) },
  ].filter((s) => s.cur != null && s.base);
  if (!steps.length) return { step: null, line: 'Not enough at bats yet to call the weakest step.' };
  for (const s of steps) s.ratio = s.cur / s.base;
  const weakest = steps.reduce((a, b) => (b.ratio < a.ratio ? b : a));
  if (weakest.ratio >= 1) {
    return { step: null, line: 'Swinging well at every step. Keep the same approach at the plate.' };
  }
  const LINES = {
    set: 'Plenty of at bats, not enough walks: more first calls need to end with an appointment set.',
    sit: "Drawing walks but not reaching base: set appointments aren't sitting for the demo. Lock in the visit before you hang up.",
    close: "Getting on base but not scoring: demos aren't turning into sales.",
  };
  return { step: weakest.key, line: LINES[weakest.key], steps };
}

/**
 * The whole scorecard model, from tallies already counted.
 *
 * @param {object} p
 * @param {object} p.february          tally for Feb 2026 (the number to beat)
 * @param {object[]} p.q2Months        tallies for Apr, May, Jun (pooled into one Q2 row)
 * @param {{month:string, tally:object}[]} p.lightfireMonths  in month order
 * @param {string} p.todayMonth        'YYYY-MM' of the run date
 * @param {string} [p.startDate]       LightFire's first Five9 setter call, 'YYYY-MM-DD'
 */
export function buildScorecard({ february, q2Months, lightfireMonths, todayMonth, startDate = null }) {
  const row = (label, season, t, extra = {}) => ({
    label, season, ...t, ...battingAvg(t.hits, t.atBats), ...extra,
  });
  const feb = row('Feb', 'last', february, { month: '2026-02', note: 'number to beat' });
  const q2 = row('Q2', 'last', sumTallies(q2Months), { month: '2026-Q2', note: 'Apr–Jun total' });

  const lf = lightfireMonths.map(({ month, tally, partial }) => {
    const mtd = month === todayMonth;
    const maturing = isMaturing(month, todayMonth);
    const label = mtd ? `${monthLabel(month)} MTD` : monthLabel(month);
    return row(label, 'this', tally, {
      month, mtd, maturing, partial: partial || null,
      note: [partial, mtd ? 'month to date' : null, maturing ? 'still maturing' : null].filter(Boolean).join(' · '),
    });
  });
  for (const r of [feb, q2, ...lf]) {
    r.vsFeb = r.avg == null || feb.avg == null ? null : r.avg > feb.avg ? 'up' : r.avg < feb.avg ? 'down' : 'even';
  }

  // Headline: LightFire's season to date over MATURED months (sales on the two
  // newest months are still coming in, so they would drag the number down).
  // With no matured month yet, every month counts, and the label says so.
  const matured = lf.filter((r) => !r.maturing);
  const headlineRows = matured.length ? matured : lf;
  const season = sumTallies(headlineRows);
  const seasonAvg = battingAvg(season.hits, season.atBats);
  const headline = {
    ...season,
    ...seasonAvg,
    span: headlineRows.length
      ? `${headlineRows[0].label}–${headlineRows[headlineRows.length - 1].label}`.replace(/^(\w+)–\1$/, '$1')
      : '',
    maturedOnly: matured.length > 0,
    febText: feb.text,
    febPer100: feb.per100,
    direction: seasonAvg.avg == null || feb.avg == null ? null
      : seasonAvg.avg > feb.avg ? 'up' : seasonAvg.avg < feb.avg ? 'down' : 'even',
  };

  const fullMonths = lf.filter((r) => !r.mtd);
  const streak = risingStreak(fullMonths);
  const coaching = coachingLine(season, february);

  return {
    startDate,
    todayMonth,
    headline,
    rows: { last: [feb, q2], this: lf },
    innings: [feb, q2, ...lf].map((r) => ({
      label: r.label,
      per100: r.per100,
      text: r.text,
      atBats: r.atBats,
      hits: r.hits,
      season: r.season,
      maturing: !!r.maturing,
      result: r.season === 'last' ? (r === feb ? 'baseline' : 'reference')
        : r.maturing ? 'maturing'
        : r.avg != null && feb.avg != null && r.avg > feb.avg ? 'win' : 'work_on',
    })),
    hotStreak: streak >= 2 ? { months: streak + 1, rises: streak } : null,
    coaching,
  };
}

/** CSV of the numbers behind the page (plus any extra rows, e.g. in-house). */
export function toCsv(model, extraRows = []) {
  const head = ['period', 'season', 'month', 'at_bats', 'walks_sets', 'on_base_demos', 'hits_sales',
    'avg', 'hits_per_100', 'no_disposition_at_bats', 'fallback_flag_leads', 'note'];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const line = (r, season) => [r.label, season, r.month, r.atBats, r.walks, r.onBase, r.hits,
    r.avg == null ? '' : r.avg.toFixed(3), r.per100 ?? '', r.noDispo, r.fallbackFlags, r.note || ''].map(esc).join(',');
  return [
    head.join(','),
    ...model.rows.last.map((r) => line(r, 'last_season')),
    ...model.rows.this.map((r) => line(r, 'lightfire')),
    ...extraRows.map((r) => line(r, r.seasonTag || 'other')),
  ].join('\n') + '\n';
}

/**
 * Sort one month's leads (lightfireMonthSql rows) by who OWNS them: the person
 * who set the appointment, and for an unset lead the person who made the first
 * setter call (user ruling, 2026-10-08).
 *
 * Why not first call alone: the first card (2026-10-08) gave a lead to whoever
 * called first, so when an in-house agent took the first call and LightFire set
 * the visit later, the sale counted for in-house. LP's set_by said LightFire set
 * 64 sales on September's leads; the card credited 44, and read as a slump when
 * LightFire's sales had grown 23 → 45 → 64. LP and report 137 credit the setter.
 *
 * Only Direct to You leads are kept, and a pre-set appointment is set aside
 * (isPresetAppointment), never anyone's at bat. A set lead with no setter name
 * falls back to the first caller. A LightFire at bat that LightFire called first
 * and whose calls never got a real disposition is flagged no_dispo (the open
 * LightFire issue since July): counted, never dropped. `owner` says how each
 * lead was placed: 'setter' or 'first_call'.
 */
export function splitByOwner(rows, roster) {
  const out = { lightfire: [], inHouse: [], uncalled: [], all: [], preset: [] };
  for (const r of rows) {
    if (!isDirectToYouLead(r)) continue;
    if (isPresetAppointment(r)) { out.preset.push(r); continue; }
    out.all.push(r);
    const setter = leadOutcome(r).walk && String(r.set_by_name ?? '').trim() ? r.set_by_name : null;
    const firstIsLf = !!r.first_agent && isLightFireAgent(r.first_agent, roster);
    if (setter) {
      const lf = isLightFireLpSetter(setter, roster);
      (lf ? out.lightfire : out.inHouse).push({ ...r, owner: 'setter', no_dispo: lf && firstIsLf && noDispo(r) });
      continue;
    }
    if (!r.first_agent) { out.uncalled.push(r); continue; }
    if (firstIsLf) out.lightfire.push({ ...r, owner: 'first_call', no_dispo: noDispo(r) });
    else out.inHouse.push({ ...r, owner: 'first_call' });
  }
  return out;
}

function noDispo(r) {
  const dispos = Array.isArray(r.first_agent_dispos) ? r.first_agent_dispos : [r.first_dispo];
  return dispos.length > 0 && dispos.every(isNoDisposition);
}

/** The first card's rule (first setter call only), kept for the old-vs-new credit table. */
export function splitByFirstCaller(rows, roster) {
  const out = { lightfire: [], inHouse: [], uncalled: [], all: [], preset: [] };
  for (const r of rows) {
    if (!isDirectToYouLead(r)) continue;
    if (isPresetAppointment(r)) { out.preset.push(r); continue; }
    out.all.push(r);
    if (!r.first_agent) { out.uncalled.push(r); continue; }
    if (isLightFireAgent(r.first_agent, roster)) out.lightfire.push({ ...r, no_dispo: noDispo(r) });
    else out.inHouse.push(r);
  }
  return out;
}

/** Small seeded PRNG (mulberry32), so a spot check can be re-drawn exactly. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * End-to-end spot check of n random at bats: Five9 call → LP lead → result.
 * A lead MATCHES when Five9 and LP agree on whether an appointment was set:
 * a Five9 "Appointment Set" disposition on the lead ⇔ LP shows a set. A set in
 * LP with no Five9 set call is explained by LP's set_by name where it has one.
 */
export function spotCheck(atBats, { n = 10, seed = 1 } = {}) {
  return drawSample(atBats, { n, seed }).map((r) => checkAtBat(r));
}

/** The n leads a spot check looks at (seeded shuffle). */
export function drawSample(atBats, { n = 10, seed = 1 } = {}) {
  const rand = seededRandom(seed);
  const pool = [...atBats];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

/**
 * One spot-checked at bat. `siblings` are the customer's other LP leads that
 * were set (siblingSetsSql): a Five9 set that LP recorded on the customer's
 * other lead is EXPLAINED, not a mismatch, and says which lead.
 */
export function checkAtBat(r, siblings = []) {
  const o = leadOutcome(r);
  const five9Set = truthy(r.any_appt_set);
  let verdict = 'match';
  let why = five9Set ? 'Five9 set ↔ LP set' : 'no set on either side';
  if (five9Set && !o.walk) {
    const sib = siblings[0];
    if (sib) {
      why = `duplicate lead: set on the customer's other LP lead ${sib.lp_lead_id} (${sib.lead_source_detail || 'no sub-source'}${sib.set_by_name ? `, by ${sib.set_by_name}` : ''})`;
    } else {
      verdict = 'mismatch';
      why = 'Five9 says Appointment Set, LP has no set';
    }
  }
  if (!five9Set && o.walk) {
    verdict = 'mismatch';
    why = r.set_by_name ? `LP set by ${r.set_by_name}, no Five9 set call found` : 'LP set, no Five9 set call found';
  }
  return {
    lp_lead_id: r.lp_lead_id, phone_last4: r.phone_last4 || '', first_call_at: r.first_call_at,
    first_agent: r.first_agent || '', first_campaign: r.first_campaign || '', matched_by: r.matched_by || 'no Five9 call',
    five9_set: five9Set, lp_set: o.walk, lp_demo: o.onBase, lp_sale: o.hit, set_by: r.set_by_name || '',
    verdict, why,
  };
}

/** At bats whose customer (same phone) has more than one at-bat lead in the list. */
export function duplicateCustomerAtBats(atBats) {
  const byKey = new Map();
  for (const r of atBats) if (r.phone_key) byKey.set(r.phone_key, (byKey.get(r.phone_key) || 0) + 1);
  let n = 0;
  for (const r of atBats) if (r.phone_key && byKey.get(r.phone_key) > 1) n += 1;
  return n;
}
