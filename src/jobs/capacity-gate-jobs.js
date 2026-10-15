/**
 * Capacity gate jobs — src/jobs/capacity-gate-jobs.js
 *
 * Mark, 2026-10-15 (market capacity gate, handoff v3). Two schedules:
 *
 *   time-change-lp-note-sweep  every LP_NOTE_SWEEP_MINUTES (15). Writes the LP
 *       note for a 6:30 / 7:00 request whose appointment reached LP, marks a
 *       cancelled or moved one superseded, and posts the ONE "LP note not
 *       written" card (src/services/time-change-lp-note.js). Runs even with
 *       CAPACITY_GATE_ENABLED=false so rows already pending still get a note.
 *
 *   capacity-unfiled-alert  hourly, 08:00–18:59 ET. Rule R2 closes every day a
 *       market's reps have not filed, so the bot cannot book it. When any of the
 *       next UNFILED_ALERT_DAYS_AHEAD days is unfiled, that market's
 *       sales-<slug> channel hears it ONCE a day (audit_posted_items, audit
 *       `capacity_unfiled_alert`, keyed on the market and the day). Slack only.
 *       Off with the gate. A horizon read that fails posts nothing (could not
 *       tell is not "unfiled").
 */

import { runJob as defaultRunJob } from '../job-runner.js';
import { todayET } from './lp-report-common.js';
import { CAPACITY_UNIVERSE, capacityGateEnabled } from '../knowledge/market-capacity-gate.js';
import { sweepTimeChangeNotes, sweepMinutes, JOB_ID as NOTE_JOB_ID } from '../services/time-change-lp-note.js';

export const UNFILED_JOB_ID = 'capacity-unfiled-alert';
export const UNFILED_AUDIT = 'capacity_unfiled_alert';

export function unfiledDaysAhead(env = process.env) {
  const n = Number(env.UNFILED_ALERT_DAYS_AHEAD ?? 3);
  return Number.isInteger(n) && n >= 1 && n <= 14 ? n : 3;
}

function addDays(ymd, n) {
  return new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
function shortLabel(ymd) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${ymd}T12:00:00Z`));
}

/**
 * The unfiled days per market in the next N days (tomorrow on). A market with
 * no horizon row has filed nothing, so every day is unfiled. Pure.
 * @param {Map<string,string|null>} horizons  market → horizon_date
 */
export function unfiledByMarket(horizons, { today, days = 3, markets = CAPACITY_UNIVERSE } = {}) {
  const out = [];
  for (const market of markets) {
    const h = horizons.has(market) ? horizons.get(market) : null;
    const dates = [];
    for (let i = 1; i <= days; i++) {
      const d = addDays(today, i);
      if (!h || d > String(h).slice(0, 10)) dates.push(d);
    }
    if (dates.length) out.push({ market, dates });
  }
  return out;
}

/** The market card (the handoff's wording). Pure. */
export function buildUnfiledText(dates) {
  return `Availability not filed for ${dates.map(shortLabel).join(', ')}. The bot can't book these days until reps file.`;
}

async function defaultDeps() {
  const [{ runSQL }, slack, posted] = await Promise.all([
    import('../admin/supabase-admin.js'), import('../slack.js'), import('../alert-posted.js'),
  ]);
  return {
    async readHorizons() {
      const rows = await runSQL('SELECT market, horizon_date::text AS horizon_date FROM v_capacity_submission_horizon');
      return new Map((rows || []).map(r => [r.market, r.horizon_date || null]));
    },
    resolveChannels: slack.resolveSlackChannels,
    postToSlack: slack.postToSlack,
    filterNew: posted.filterNew,
    recordPosted: posted.recordPosted,
  };
}

/** One pass of the late-filing alert. */
export async function runUnfiledAlert({ nowMs = Date.now(), env = process.env } = {}, deps = null) {
  if (!capacityGateEnabled(env)) return { ok: true, skipped: true, summary: 'gate disabled' };
  const d = deps || await defaultDeps();
  const today = todayET(new Date(nowMs));
  let horizons;
  try { horizons = await d.readHorizons(); } catch (err) {
    console.warn(`[CapacityUnfiled] horizon read failed — nothing posted: ${err.message}`);
    return { ok: false, checked: false, summary: 'horizon read failed' };
  }
  const late = unfiledByMarket(horizons, { today, days: unfiledDaysAhead(env) });
  let posted = 0;
  for (const { market, dates } of late) {
    const item = { key: market, reason: `day:${today}` };
    const { fresh } = await d.filterNew({ audit: UNFILED_AUDIT, items: [item], ttlDays: 3, nowMs });
    if (!fresh.length) continue;
    const short = market.replace(/_MKT$/, '');
    const [channel] = await d.resolveChannels('sales', { market: short });
    if (!channel) { console.warn(`[CapacityUnfiled] ${market}: no Slack channel resolved — not posted`); continue; }
    const res = await d.postToSlack(buildUnfiledText(dates), channel);
    if (!res?.ok) { console.warn(`[CapacityUnfiled] ${market}: post failed (${res?.error || 'unknown'})`); continue; }
    await d.recordPosted({ audit: UNFILED_AUDIT, items: [item], nowMs });
    posted++;
    console.log(`[CapacityUnfiled] ${market}: posted (${dates.join(', ')} unfiled)`);
  }
  return { ok: true, late: late.length, posted, summary: `${late.length} market(s) unfiled, ${posted} posted` };
}

// ── Schedulers ──────────────────────────────────────────────────────────────
let noteTimer = null;
let unfiledTimer = null;
let lastUnfiledHour = null;

function etHour(nowMs) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(new Date(nowMs)));
}

export function startCapacityGateJobs(env = process.env) {
  if (!noteTimer) {
    const every = sweepMinutes(env) * 60_000;
    noteTimer = setInterval(() => {
      defaultRunJob(NOTE_JOB_ID, () => sweepTimeChangeNotes()).catch(err => console.error('[TimeChangeNote] sweep failed:', err.message));
    }, every);
    noteTimer.unref?.();
    console.log(`[TimeChangeNote] sweep started — every ${sweepMinutes(env)} min`);
  }
  if (!unfiledTimer) {
    const check = () => {
      const nowMs = Date.now();
      const h = etHour(nowMs);
      const slot = `${todayET(new Date(nowMs))}:${h}`;
      if (h < 8 || h > 18 || slot === lastUnfiledHour) return;
      lastUnfiledHour = slot;
      defaultRunJob(UNFILED_JOB_ID, () => runUnfiledAlert(), { occurrence: slot }).catch(err => console.error('[CapacityUnfiled] run failed:', err.message));
    };
    unfiledTimer = setInterval(check, 5 * 60_000);
    unfiledTimer.unref?.();
    console.log('[CapacityUnfiled] scheduler started — hourly 08:00–18:59 ET');
  }
}

export function stopCapacityGateJobs() {
  if (noteTimer) { clearInterval(noteTimer); noteTimer = null; }
  if (unfiledTimer) { clearInterval(unfiledTimer); unfiledTimer = null; }
}
