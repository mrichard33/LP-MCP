/**
 * scripts/test-batting-average.js
 *
 * Offline coverage for the LightFire batting-average scorecard:
 * src/batting-average.js (the arithmetic), src/batting-average-io.js (the SQL
 * builders), src/batting-average-html.js (the page) and
 * scripts/lightfire-scorecard.js (collect + notes, through a stubbed reads
 * object). Fixture numbers echo the live ones measured on 2026-10-08.
 *
 * Run: node --test scripts/test-batting-average.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isDirectToYouLead, isDirectToYouSubSource, isSetterCampaign, isNoDisposition, isLightFireAgent,
  agentKey, leadOutcome, isPresetAppointment, atBatsOf, tallyLeads, tallySourceCost, battingAvg,
  isMaturing, risingStreak, coachingLine, buildScorecard, toCsv, splitByFirstCaller, splitByOwner, lpSetterKey, isLightFireLpSetter, spotCheck, checkAtBat,
  duplicateCustomerAtBats,
  monthLabel, addMonths, NON_SETTER_CAMPAIGN_RX,
} from '../src/batting-average.js';
import {
  leadsForMonthSql, lightfireMonthSql, siblingSetsSql, SOURCE_COST_SQL, makeBattingReads,
} from '../src/batting-average-io.js';
import { renderScorecardHtml } from '../src/batting-average-html.js';
import { collectScorecard, renderNotes } from './lightfire-scorecard.js';

const roster = new Set(['craig deer', 'shari walker']);
const lead = (o = {}) => ({
  lp_lead_id: '1', lead_source: 'Internet', lead_source_detail: 'Lead Gurus', lp_deleted_at: null,
  ever_set: false, ever_sat: false, appointment_set: false, set_date: null, appointment_date: null,
  demo_completed: false, closed_won: false, set_by_name: null, ...o,
});

test('Direct to You: canvass, previous customers and self-generated are not at bats', () => {
  assert.equal(isDirectToYouLead(lead()), true);
  for (const src of ['Canvass', 'Canvass Sticky', 'PrevCust', 'SelfGenerated']) {
    assert.equal(isDirectToYouLead(lead({ lead_source: src })), false, src);
  }
  assert.equal(isDirectToYouLead(lead({ lead_source: 'Website', lead_source_detail: 'Previous Customer' })), false);
  assert.equal(isDirectToYouLead(lead({ lp_deleted_at: '2026-09-01' })), false);
  assert.equal(isDirectToYouSubSource('canvass sticky'), false);
  assert.equal(isDirectToYouSubSource('Modernize'), true);
  assert.equal(isDirectToYouSubSource(null), true);
});

test('setter campaigns leave out confirmation, rehash, previous customer, dispatch, resets', () => {
  for (const c of ['Conf - Next Day', 'Canvass Confirmation - Inbound', 'Rehash - New', 'Previous Customer',
    'Dispatch', 'Cancel Contract Outbound', 'Resets-Hot', 'Reset - Inbound']) {
    assert.equal(isSetterCampaign(c), false, c);
  }
  for (const c of ['DIAL ASAP', 'After DIAL ASAP', 'Data - Hot Leads less than 7', 'Main Number']) {
    assert.equal(isSetterCampaign(c), true, c);
  }
  // The regex is a POSIX one the SQL reuses verbatim.
  assert.match(lightfireMonthSql('2026-09'), new RegExp(NON_SETTER_CAMPAIGN_RX.replace(/[()|^]/g, '\\$&')));
});

test('LightFire agents: suffix, or the roster for the weeks before the suffix existed', () => {
  assert.equal(isLightFireAgent('Daana Ellis - LF', new Set()), true);
  assert.equal(isLightFireAgent('Craig Deer', roster), true);
  assert.equal(isLightFireAgent('  craig   deer ', roster), true);
  assert.equal(isLightFireAgent('John Manieri', roster), false);
  assert.equal(isLightFireAgent('Nate Belanger - NC', roster), false);
  assert.equal(agentKey('Shari Walker - LF'), 'shari walker');
});

test('no disposition means blank or "No Disposition"', () => {
  assert.equal(isNoDisposition(''), true);
  assert.equal(isNoDisposition(null), true);
  assert.equal(isNoDisposition('No Disposition'), true);
  assert.equal(isNoDisposition('Hung Up'), false);
});

test('lead outcome: ever_* flags win; older fields only stand in for a NULL flag', () => {
  assert.deepEqual(leadOutcome(lead({ ever_set: true, ever_sat: true, closed_won: true })),
    { walk: true, onBase: true, hit: true, usedFallback: false });
  // ever_set false is an answer, not missing: an old appointment_date does not override it.
  assert.equal(leadOutcome(lead({ ever_set: false, appointment_date: '2026-03-01' })).walk, false);
  const fb = leadOutcome(lead({ ever_set: null, ever_sat: null, appointment_set: true, demo_completed: true }));
  assert.deepEqual(fb, { walk: true, onBase: true, hit: false, usedFallback: true });
  // A sale implies a demo and a set, so the funnel never inverts.
  assert.deepEqual(leadOutcome(lead({ closed_won: true })), { walk: true, onBase: true, hit: true, usedFallback: false });
  assert.equal(leadOutcome(lead({ ever_set: 't' })).walk, true);
});

test('a set appointment by no setter, a bot or a vendor is not an at bat; an unset one is', () => {
  assert.equal(isPresetAppointment(lead({ set_by_name: 'No, Setter', ever_set: true })), true);
  assert.equal(isPresetAppointment(lead({ set_by_name: 'Agent, Revin', ever_set: true })), true);
  assert.equal(isPresetAppointment(lead({ set_by_name: 'Integration, GoHighLevel', ever_set: true })), true);
  assert.equal(isPresetAppointment(lead({ set_by_name: 'Internet, Lead Gurus', ever_set: true })), true);
  assert.equal(isPresetAppointment(lead({ set_by_name: 'No, Setter', ever_set: false })), false);
  assert.equal(isPresetAppointment(lead({ set_by_name: 'Deer - LF, Craig', ever_set: true })), false);
  const { atBats, preset } = atBatsOf([lead(), lead({ set_by_name: 'No, Setter', ever_set: true })]);
  assert.equal(atBats.length, 1);
  assert.equal(preset.length, 1);
});

test('tallies and the baseball average', () => {
  const t = tallyLeads([
    lead({ ever_set: true, ever_sat: true, closed_won: true }),
    lead({ ever_set: true }),
    lead({ no_dispo: true }),
    lead(),
  ]);
  assert.deepEqual(t, { atBats: 4, walks: 2, onBase: 1, hits: 1, fallbackFlags: 0, noDispo: 1 });
  assert.deepEqual(battingAvg(9, 100), { avg: 0.09, text: '.090', per100: 9 });
  assert.equal(battingAvg(280, 10836).text, '.026');
  assert.equal(battingAvg(1, 1).text, '1.000');
  assert.deepEqual(battingAvg(0, 0), { avg: null, text: '—', per100: null });
});

test('LP report 136 rows tally by sub-source, without the excluded ones', () => {
  const t = tallySourceCost([
    { sub_source: 'Modernize', num_raw: '100', num_set: '20', num_sat: '8', num_sold: '3' },
    { sub_source: 'Canvass', num_raw: '50', num_set: '50', num_sat: '40', num_sold: '20' },
    { sub_source: 'Self Generated', num_raw: '5', num_set: '5', num_sat: '5', num_sold: '3' },
    { sub_source: 'UNATTRIBUTED', num_raw: '2', num_set: '0', num_sat: '0', num_sold: '0' },
  ]);
  assert.deepEqual(t, { atBats: 102, walks: 20, onBase: 8, hits: 3, fallbackFlags: 0, noDispo: 0 });
});

test('months: labels, arithmetic, maturing', () => {
  assert.equal(monthLabel('2026-10'), 'Oct');
  assert.equal(monthLabel('2026-02', true), 'Feb 2026');
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(isMaturing('2026-10', '2026-10'), true);
  assert.equal(isMaturing('2026-09', '2026-10'), true);
  assert.equal(isMaturing('2026-08', '2026-10'), false);
});

test('a hot streak is 2+ rises in a row, ending at the latest month', () => {
  assert.equal(risingStreak([{ avg: 0.01 }, { avg: 0.02 }, { avg: 0.03 }]), 2);
  assert.equal(risingStreak([{ avg: 0.03 }, { avg: 0.02 }, { avg: 0.025 }]), 1);
  assert.equal(risingStreak([{ avg: 0.02 }, { avg: 0.02 }]), 0);
  assert.equal(risingStreak([{ avg: null }, { avg: 0.02 }]), 0);
});

test('coaching names the step furthest below February', () => {
  const feb = { atBats: 10836, walks: 2119, onBase: 909, hits: 280 };
  // Live Jul–Aug: set rate 13.8% vs 19.6% is the weakest ratio.
  const lf = { atBats: 3460, walks: 475, onBase: 199, hits: 63 };
  assert.equal(coachingLine(lf, feb).step, 'set');
  assert.equal(coachingLine({ atBats: 100, walks: 20, onBase: 15, hits: 1 }, feb).step, 'close');
  assert.match(coachingLine({ atBats: 100, walks: 20, onBase: 15, hits: 1 }, feb).line, /Getting on base but not scoring/);
  assert.equal(coachingLine({ atBats: 100, walks: 20, onBase: 4, hits: 2 }, feb).step, 'sit');
  assert.equal(coachingLine({ atBats: 100, walks: 30, onBase: 15, hits: 6 }, feb).step, null);
  assert.equal(coachingLine({ atBats: 0, walks: 0, onBase: 0, hits: 0 }, feb).step, null);
});

const T = (atBats, walks, onBase, hits, extra = {}) => ({ atBats, walks, onBase, hits, fallbackFlags: 0, noDispo: 0, ...extra });
function sampleModel() {
  return buildScorecard({
    february: T(10836, 2119, 909, 280),
    q2Months: [T(10671, 2000, 900, 250), T(8653, 1500, 700, 230), T(7407, 1311, 521, 197)],
    lightfireMonths: [
      { month: '2026-07', tally: T(1021, 136, 72, 26), partial: 'LightFire from Jul 20' },
      { month: '2026-08', tally: T(2439, 339, 127, 37, { noDispo: 21 }) },
      { month: '2026-09', tally: T(4387, 449, 172, 44) },
      { month: '2026-10', tally: T(1236, 116, 24, 8) },
    ],
    todayMonth: '2026-10',
    startDate: '2026-07-20',
  });
}

test('scorecard: headline over matured months only, innings judged against February', () => {
  const m = sampleModel();
  assert.equal(m.headline.span, 'Jul–Aug');
  assert.equal(m.headline.atBats, 3460);
  assert.equal(m.headline.hits, 63);
  assert.equal(m.headline.text, '.018');
  assert.equal(m.headline.febText, '.026');
  assert.equal(m.headline.direction, 'down');
  assert.equal(m.rows.last[1].atBats, 26731);
  assert.equal(m.rows.last[1].text, '.025');
  assert.deepEqual(m.innings.map((i) => i.result), ['baseline', 'reference', 'work_on', 'work_on', 'maturing', 'maturing']);
  assert.equal(m.rows.this[3].label, 'Oct MTD');
  assert.equal(m.rows.this[0].note, 'LightFire from Jul 20');
  assert.equal(m.coaching.step, 'set');
  assert.equal(m.hotStreak, null);
});

test('scorecard: a month above February is a win, and two rises make a hot streak', () => {
  const m = buildScorecard({
    february: T(1000, 200, 90, 26),
    q2Months: [T(1000, 200, 90, 25)],
    lightfireMonths: [
      { month: '2026-07', tally: T(1000, 200, 90, 20) },
      { month: '2026-08', tally: T(1000, 200, 90, 30) },
      { month: '2026-09', tally: T(1000, 200, 90, 40) },
    ],
    todayMonth: '2026-12',
  });
  assert.equal(m.innings[2].result, 'work_on');
  assert.equal(m.innings[3].result, 'win');
  assert.deepEqual(m.hotStreak, { months: 3, rises: 2 });
});

test('CSV carries every row, with the extra comparison rows tagged', () => {
  const csv = toCsv(sampleModel(), [{ label: 'Jul whole team', month: '2026-07', atBats: 7265, walks: 1411, onBase: 565, hits: 201, ...battingAvg(201, 7265), seasonTag: 'whole_team_lp_report', note: 'a, b' }]);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 1 + 2 + 4 + 1);
  assert.match(lines[0], /^period,season,month,at_bats/);
  assert.match(lines[1], /^Feb,last_season,2026-02,10836,2119,909,280,0\.026,2\.6/);
  assert.match(lines[7], /whole_team_lp_report.*"a, b"$/);
});

test('split by first caller: LightFire, in-house, uncalled, pre-set; no-disposition flagged', () => {
  const rows = [
    lead({ lp_lead_id: '1', first_agent: 'Craig Deer', first_agent_dispos: ['No Disposition', ''] }),
    lead({ lp_lead_id: '2', first_agent: 'Shari Walker - LF', first_agent_dispos: ['Hung Up', 'No Disposition'] }),
    lead({ lp_lead_id: '3', first_agent: 'John Manieri', first_agent_dispos: ['Appointment Set'] }),
    lead({ lp_lead_id: '4' }),
    lead({ lp_lead_id: '5', lead_source: 'Canvass', first_agent: 'Craig Deer' }),
    lead({ lp_lead_id: '6', set_by_name: 'No, Setter', ever_set: true, first_agent: 'Craig Deer' }),
  ];
  const s = splitByFirstCaller(rows, roster);
  assert.deepEqual(s.lightfire.map((r) => [r.lp_lead_id, r.no_dispo]), [['1', true], ['2', false]]);
  assert.deepEqual(s.inHouse.map((r) => r.lp_lead_id), ['3']);
  assert.deepEqual(s.uncalled.map((r) => r.lp_lead_id), ['4']);
  assert.deepEqual(s.preset.map((r) => r.lp_lead_id), ['6']);
  assert.equal(s.all.length, 4);
});

test('spot check: the same seed draws the same leads, and set disagreement is a mismatch', () => {
  const pool = Array.from({ length: 30 }, (_, i) => lead({
    lp_lead_id: String(i), first_agent: 'Craig Deer - LF', any_appt_set: i % 3 === 0, ever_set: i % 3 === 0 || i === 4,
  }));
  const a = spotCheck(pool, { n: 10, seed: 7 });
  const b = spotCheck(pool, { n: 10, seed: 7 });
  assert.deepEqual(a.map((r) => r.lp_lead_id), b.map((r) => r.lp_lead_id));
  assert.equal(a.length, 10);
  assert.equal(new Set(a.map((r) => r.lp_lead_id)).size, 10);
  const all = spotCheck(pool, { n: 30, seed: 1 });
  const four = all.find((r) => r.lp_lead_id === '4');
  assert.equal(four.verdict, 'mismatch');
  assert.match(four.why, /no Five9 set call/);
  assert.equal(all.find((r) => r.lp_lead_id === '3').verdict, 'match');
});

test('a Five9 set recorded on the customer\'s other LP lead is explained, not a mismatch', () => {
  const r = lead({ lp_lead_id: '577753', any_appt_set: true });
  assert.equal(checkAtBat(r).verdict, 'mismatch');
  const c = checkAtBat(r, [{ lp_lead_id: '577751', lead_source_detail: 'Clever', set_by_name: 'Wright - LF, Carla' }]);
  assert.equal(c.verdict, 'match');
  assert.match(c.why, /other LP lead 577751 \(Clever, by Wright - LF, Carla\)/);
  assert.equal(duplicateCustomerAtBats([{ phone_key: 'a' }, { phone_key: 'a' }, { phone_key: 'b' }, {}]), 2);
});

test('SQL builders refuse a malformed month and keep LP wall-clock bounds', () => {
  assert.throws(() => leadsForMonthSql("2026-09'; drop table x; --"), /YYYY-MM/);
  assert.throws(() => lightfireMonthSql('2026-9'), /YYYY-MM/);
  const sql = lightfireMonthSql('2026-12');
  assert.match(sql, /created_at_lp >= '2026-12-01' AND l\.created_at_lp < '2027-01-01'/);
  assert.match(sql, /AT TIME ZONE 'UTC'\) AT TIME ZONE 'America\/New_York'/);
  // Postgres must see \D (one backslash) in the phone regex.
  assert.match(sql, /regexp_replace\(coalesce\(l\.phone, ''\), '\\D'/);
  assert.match(sql, /'INQ' \|\| in1_id/);
  assert.doesNotMatch(sql, /'INQ' \|\| l?\.?lp_prospect_id/);
  assert.match(SOURCE_COST_SQL, /report_type = 'source_cost'/);
  assert.throws(() => makeBattingReads({}), /runSQL/);
  assert.equal(siblingSetsSql(["1'; --"]), null);
  assert.match(siblingSetsSql(['577753', 'x']), /IN \('577753'\)/);
});

test('the page renders every section, escapes text and stays self-contained', () => {
  const html = renderScorecardHtml(sampleModel(), { generatedAt: new Date('2026-10-08T16:00:00Z'), context: 'Whole team <Jul> .028' });
  assert.match(html, /LightFire is batting/);
  assert.match(html, /<div class="avg">\.018<\/div>/);
  assert.match(html, /Number to beat \(February\): <strong>\.026<\/strong>/);
  assert.match(html, /0\.8 hits per 100 to go/);
  assert.match(html, /From the dugout/);
  assert.match(html, /The scoreboard/);
  assert.match(html, /Season stat line/);
  assert.match(html, /Last season · before LightFire/);
  assert.match(html, /This season · LightFire \(from 2026-07-20\)/);
  assert.equal((html.match(/class="inning /g) || []).length, 6);
  assert.match(html, /Whole team &lt;Jul&gt; \.028/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=/);
});

test('collect + notes run end to end on stubbed reads', async () => {
  const leadRow = (id, agent, o = {}) => lead({ lp_lead_id: id, first_agent: agent, first_agent_dispos: ['Hung Up'], first_call_at: '2026-08-02T14:00:00Z', first_campaign: 'DIAL ASAP', matched_by: 'inbound_key', phone_last4: '1234', ...o });
  const month = {
    '2026-07': [leadRow('a', 'Craig Deer', { ever_set: true, ever_sat: true, closed_won: true, any_appt_set: true })],
    '2026-08': [leadRow('b', 'Shari Walker - LF'), leadRow('c', 'John Manieri'), lead({ lp_lead_id: 'd' })],
    '2026-09': [],
  };
  const reportRow = (m, raw, sold) => ({ month: m, scope: 'month', sub_source: 'Lead Gurus', num_raw: raw, num_set: raw / 5, num_sat: raw / 10, num_sold: sold });
  const reads = {
    roster: async () => [{ agent_name: 'Craig Deer' }],
    agentFirstCalls: async () => [{ agent_name: 'John Manieri', first_at: '2026-07-03T13:00:00Z' }, { agent_name: 'Craig Deer', first_at: '2026-07-20T14:00:00Z' }],
    sourceCost: async () => [reportRow('2026-02', 1000, 26), reportRow('2026-04', 1000, 25), reportRow('2026-05', 1000, 25), { ...reportRow('2026-07', 500, 14), as_of_date: '2026-08-10' }],
    leadsForMonth: async () => [lead(), lead({ closed_won: true })],
    lightfireMonth: async (m) => month[m] || [],
    setter137: async () => [],
  };
  const data = await collectScorecard({ reads, todayMonth: '2026-09' });
  assert.equal(data.startDate, '2026-07-20');
  assert.equal(data.beforeSource['2026-02'], 'LP report 136');
  assert.match(data.beforeSource['2026-06'], /lp_leads copy/);
  assert.equal(data.before['2026-06'].atBats, 2);
  assert.deepEqual(data.model.rows.this.map((r) => [r.label, r.atBats, r.hits]), [['Jul', 1, 1], ['Aug', 1, 0], ['Sep MTD', 0, 0]]);
  assert.equal(data.inHouseRows[1].atBats, 1);
  // July: report 136 (our copy holds 1 of its 500 leads); August: no report, so our copy.
  assert.deepEqual(data.allLeadRows.map((r) => [r.month, r.source, r.atBats]), [['2026-07', 'report', 500], ['2026-08', 'copy', 3]]);
  assert.match(data.allLeadRows[0].note, /as of 2026-08-10/);
  const notes = renderNotes(data);
  assert.match(notes, /## Numbers that may be off/);
  assert.match(notes, /Report 137 cross-check/);
  assert.match(notes, /\*\*Pending\.\*\*/);
  assert.match(notes, /## Spot check/);
  assert.match(notes, /\| Aug 2026 \| 1 \| 0 \|/);
  assert.match(notes, /## How credit changed/);
});

test('LP setter names match the roster in either form', () => {
  assert.equal(lpSetterKey('Deer - LF, Craig'), 'craig deer');
  assert.equal(lpSetterKey('Deer, Craig'), 'craig deer');
  assert.equal(lpSetterKey('Craig Deer'), 'craig deer');
  assert.equal(isLightFireLpSetter('Deer - LF, Craig', new Set()), true);
  assert.equal(isLightFireLpSetter('Walker, Shari', roster), true);
  assert.equal(isLightFireLpSetter('Manieri, John', roster), false);
  assert.equal(isLightFireLpSetter(null, roster), false);
});

test('credit goes to whoever SET the lead; an unset lead to the first caller (ruling 2026-10-08)', () => {
  const set = { ever_set: true };
  const rows = [
    // in-house called first, LightFire set it: LightFire's (the first card gave it to in-house)
    lead({ lp_lead_id: 'a', ...set, closed_won: true, set_by_name: 'Deer, Craig', first_agent: 'John Manieri' }),
    // LightFire called first, in-house set it: in-house's
    lead({ lp_lead_id: 'b', ...set, set_by_name: 'Manieri, John', first_agent: 'Shari Walker - LF', first_agent_dispos: ['No Disposition'] }),
    // unset: the first caller
    lead({ lp_lead_id: 'c', first_agent: 'Craig Deer', first_agent_dispos: ['No Disposition'] }),
    lead({ lp_lead_id: 'd', first_agent: 'John Manieri' }),
    // set by LightFire with no Five9 call matched: still LightFire's
    lead({ lp_lead_id: 'e', ...set, set_by_name: 'Walker - LF, Shari' }),
    // set with no setter name: the first caller
    lead({ lp_lead_id: 'f', ...set, first_agent: 'Craig Deer', first_agent_dispos: ['Appointment Set'] }),
    // pre-set: nobody's
    lead({ lp_lead_id: 'g', ...set, set_by_name: 'No, Setter', first_agent: 'Craig Deer' }),
    // unset, never called
    lead({ lp_lead_id: 'h' }),
  ];
  const s = splitByOwner(rows, roster);
  assert.deepEqual(s.lightfire.map((r) => [r.lp_lead_id, r.owner, r.no_dispo]),
    [['a', 'setter', false], ['c', 'first_call', true], ['e', 'setter', false], ['f', 'first_call', false]]);
  assert.deepEqual(s.inHouse.map((r) => r.lp_lead_id), ['b', 'd']);
  assert.deepEqual(s.preset.map((r) => r.lp_lead_id), ['g']);
  assert.deepEqual(s.uncalled.map((r) => r.lp_lead_id), ['h']);
  // the first card's rule, for the change table
  const old = splitByFirstCaller(rows, roster);
  assert.deepEqual(old.lightfire.map((r) => r.lp_lead_id), ['b', 'c', 'f']);
});
