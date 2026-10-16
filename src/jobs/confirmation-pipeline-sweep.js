/**
 * confirmation-pipeline-sweep — src/jobs/confirmation-pipeline-sweep.js
 *
 * 2026-10-16 handoff "4. Confirmation Pipeline", Step 6. Daily at 00:05 ET,
 * after which the board holds no appointment dated before today:
 *   1. page through EVERY open card in CONF_PIPELINE_ID, cards made by hand
 *      included (GHL, not our table, is the list);
 *   2. close each card whose appointment date is before today (ET):
 *      Confirmed → won, Disqualified → lost, anything else → abandoned;
 *   3. a card whose date cannot be read is NOT closed: it is named in the
 *      summary as "needs a date";
 *   4. one summary line to CONF_SLACK_CHANNEL (counts by status).
 * The date comes from our row, else the contact's Current Appointment Date
 * field, else the "— M/D/YYYY" in the card name (sweepAppointmentYmd).
 * Cards are never deleted: closed cards stay for reporting.
 *
 * Also here: the admin routes for the go-live run (sweep by hand) and the
 * backfill (one handler run per contact with an upcoming Set / Verif / Cnf /
 * ND appointment; never a past one). CONF_PIPE_DRY_RUN decides both, and a
 * route can force a dry run but never force live.
 */

import supabase from '../supabase.js';
import { runJob } from '../job-runner.js';
import { postToSlack } from '../slack.js';
import { ghlFetch } from '../actions/helpers.js';
import { GHL_LOCATION_ID } from '../actions/constants.js';
import { syncConfirmationCard, writeLog } from '../actions/handlers/confirmation-pipeline-sync.js';
import {
  readConfig, stageKeyForId, closeStatusFor, sweepAppointmentYmd, ymdInZone,
} from '../confirmation-pipeline/rules.js';

export const JOB_ID = 'confirmation-pipeline-sweep';
const CURRENT_APPT_DATE_FIELD = 'x8KO5o89WPLfC7ivia3A';
const MAX_PAGES = 200;
const RUN_HOUR_ET = 0;
const RUN_MINUTE_ET = 5;

export function defaultDeps(envOverride = null) {
  return { supabase, ghlFetch, postToSlack, env: envOverride || process.env, now: () => new Date(), log: console };
}

/** All open cards in the pipeline. `truncated` is loud: a short list must not read as a whole one. */
export async function listOpenCards(deps, cfg) {
  const cards = [];
  let startAfter = null; let startAfterId = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    let path = `/opportunities/search?location_id=${GHL_LOCATION_ID}&pipeline_id=${cfg.pipelineId}&status=open&limit=100`;
    if (startAfter && startAfterId) path += `&startAfter=${encodeURIComponent(startAfter)}&startAfterId=${encodeURIComponent(startAfterId)}`;
    const res = await deps.ghlFetch('GET', path);
    const opps = (res?.opportunities || []).filter((o) => o.pipelineId === cfg.pipelineId && (o.status || 'open') === 'open');
    cards.push(...opps);
    const next = res?.meta || {};
    if (!(res?.opportunities || []).length || !next.startAfterId || !next.startAfter
      || (String(next.startAfterId) === String(startAfterId))) {
      return { cards: dedupe(cards), truncated: false };
    }
    startAfter = next.startAfter; startAfterId = next.startAfterId;
  }
  return { cards: dedupe(cards), truncated: true };
}

function dedupe(cards) {
  const seen = new Set();
  return cards.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

async function currentApptField(deps, contactId) {
  try {
    const res = await deps.ghlFetch('GET', `/contacts/${contactId}`);
    const fields = (res?.contact || res || {}).customFields || [];
    const f = fields.find((x) => x.id === CURRENT_APPT_DATE_FIELD);
    return f ? (f.value ?? f.field_value ?? null) : null;
  } catch (err) {
    deps.log.warn?.(`[ConfPipe] sweep: contact ${contactId} read failed: ${err.message}`);
    return null;
  }
}

export function formatSweepSummary({ counts, needsDate, truncated, dryRun }) {
  const closed = (counts.won || 0) + (counts.lost || 0) + (counts.abandoned || 0);
  const head = `🧹 Confirmation board sweep${dryRun ? ' (dry run)' : ''}: closed ${closed} past-dated card(s) — won ${counts.won || 0}, lost ${counts.lost || 0}, abandoned ${counts.abandoned || 0}.`;
  const lines = [head];
  if (needsDate.length) lines.push(`Needs a date (${needsDate.length}, left open): ${needsDate.slice(0, 20).map((c) => c.name || c.id).join('; ')}${needsDate.length > 20 ? ' …' : ''}`);
  if (truncated) lines.push('⚠️ The card list hit the page cap; some cards were not checked.');
  return lines.join('\n');
}

export async function runConfirmationSweep({ deps = defaultDeps(), post = true } = {}) {
  const db = deps.supabase;
  const cfg = readConfig(deps.env);
  const now = deps.now();
  const today = ymdInZone(now, cfg.tz);
  const counts = { won: 0, lost: 0, abandoned: 0, kept: 0 };
  const needsDate = [];
  const errors = [];

  const { cards, truncated } = await listOpenCards(deps, cfg);
  const ids = cards.map((c) => c.id);
  const rowsById = new Map();
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await db.from('confirmation_opportunities').select('*').in('ghl_opportunity_id', ids.slice(i, i + 150));
    if (error) throw new Error(`rows read failed: ${error.message}`);
    for (const r of data || []) rowsById.set(r.ghl_opportunity_id, r);
  }

  for (const card of cards) {
    try {
      const row = rowsById.get(card.id) || null;
      let field = null;
      let when = sweepAppointmentYmd({ row, currentApptField: null, cardTitle: null, tz: cfg.tz });
      if (!when.ymd) {
        field = await currentApptField(deps, card.contactId || card.contact?.id);
        when = sweepAppointmentYmd({ row: null, currentApptField: field, cardTitle: card.name, tz: cfg.tz });
      }
      if (!when.ymd) { needsDate.push(card); continue; }
      if (when.ymd >= today) { counts.kept++; continue; }

      const stageKey = stageKeyForId(cfg, card.pipelineStageId) || row?.stage_key;
      const status = row?.last_lp_disposition === 'CXL' ? 'abandoned' : closeStatusFor(stageKey);
      if (!cfg.dryRun) await deps.ghlFetch('PUT', `/opportunities/${card.id}`, { status });
      if (row && (!cfg.dryRun || row.dry_run)) {
        await db.from('confirmation_opportunities').update({ closed_status: status, closed_at: now.toISOString(), updated_at: now.toISOString() }).eq('id', row.id);
      }
      await writeLog(db, {
        lp_lead_id: row?.lp_lead_id || null, ghl_opportunity_id: card.id, from_stage: stageKey,
        to_stage: `closed:${status}`, action: 'close', source: 'sweep', lp_disposition: row?.last_lp_disposition || null,
        dry_run: cfg.dryRun, note: `appointment ${when.ymd} before ${today} (date from ${when.source})`,
      }, deps.log);
      counts[status]++;
    } catch (err) {
      errors.push(`${card.id}: ${err.message}`);
    }
  }

  const text = formatSweepSummary({ counts, needsDate, truncated, dryRun: cfg.dryRun });
  let posted = false;
  if (post && !cfg.dryRun && cfg.slackChannel) {
    const res = await deps.postToSlack(text, cfg.slackChannel);
    posted = !!res?.ok;
    if (!res?.ok) errors.push(`summary post failed: ${res?.error}`);
  } else if (post && !cfg.slackChannel) {
    deps.log.warn?.('[ConfPipe] sweep summary not posted: CONF_SLACK_CHANNEL is empty');
  }
  deps.log.log?.(`[ConfPipe] ${text.replace(/\n/g, ' | ')}`);
  return {
    ok: errors.length === 0 && !truncated,
    dry_run: cfg.dryRun,
    open_cards: cards.length,
    counts,
    needs_date: needsDate.map((c) => ({ id: c.id, name: c.name })),
    truncated,
    posted,
    errors: errors.slice(0, 50),
    summary: text,
  };
}

/* --- backfill --------------------------------------------------------------- */

export async function runConfirmationBackfill({ deps = defaultDeps(), limit = 0 } = {}) {
  const db = deps.supabase;
  const cfg = readConfig(deps.env);
  const today = ymdInZone(deps.now(), cfg.tz);
  const leads = [];
  for (let from = 0; ; from += 1000) {
    // appointment_date holds the ET wall clock labelled UTC, so the date string compares directly.
    const { data, error } = await db.from('lp_leads').select('lp_lead_id, ghl_contact_id')
      .gte('appointment_date', `${today}T00:00:00+00:00`).in('disposition_code', ['Set', 'Verif', 'Cnf', 'ND'])
      .not('ghl_contact_id', 'is', null).is('lp_deleted_at', null)
      .order('appointment_date', { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`backfill lead read failed: ${error.message}`);
    leads.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const contacts = [...new Set(leads.map((l) => l.ghl_contact_id))];
  const todo = limit > 0 ? contacts.slice(0, limit) : contacts;
  const counts = {};
  const errors = [];
  for (const contactId of todo) {
    try {
      const res = await syncConfirmationCard({ contactId, source: 'backfill', lpChangedAt: null, deps });
      counts[res.outcome] = (counts[res.outcome] || 0) + 1;
    } catch (err) {
      counts.error = (counts.error || 0) + 1;
      errors.push(`${contactId}: ${err.message}`);
    }
  }
  return { ok: errors.length === 0, dry_run: cfg.dryRun, contacts: todo.length, counts, errors: errors.slice(0, 50) };
}

/* --- admin routes ----------------------------------------------------------- */

function envFor(body) {
  const forceDry = body?.dryRun === true || body?.dry_run === true;
  return forceDry ? { ...process.env, CONF_PIPE_DRY_RUN: 'true' } : process.env;
}

export function registerConfirmationPipelineRoutes(app, authenticate) {
  let sweepBusy = false;
  let backfill = { running: false, last: null };

  app.post('/admin/confirmation-pipeline/sweep', authenticate, async (req, res) => {
    if (sweepBusy) return res.status(409).json({ error: 'a sweep is already running' });
    sweepBusy = true;
    try {
      res.json(await runConfirmationSweep({ deps: defaultDeps(envFor(req.body)), post: req.body?.post !== false }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      sweepBusy = false;
    }
  });

  // ~350 contacts at a few GHL calls each outlasts an HTTP request: it runs in
  // the background and GET reports the last result.
  app.post('/admin/confirmation-pipeline/backfill', authenticate, (req, res) => {
    if (backfill.running) return res.status(409).json({ error: 'a backfill is already running' });
    backfill = { running: true, started_at: new Date().toISOString(), last: backfill.last };
    runConfirmationBackfill({ deps: defaultDeps(envFor(req.body)), limit: Number(req.body?.limit) || 0 })
      .then((r) => { backfill = { running: false, last: { ...r, finished_at: new Date().toISOString() } }; console.log(`[ConfPipe] backfill: ${JSON.stringify(r.counts)}`); })
      .catch((err) => { backfill = { running: false, last: { ok: false, error: err.message } }; console.error(`[ConfPipe] backfill threw: ${err.message}`); });
    res.status(202).json({ started: true });
  });

  app.get('/admin/confirmation-pipeline/backfill', authenticate, (_req, res) => res.json(backfill));
}

/* --- scheduler: daily 00:05 ET ---------------------------------------------- */

function etClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  return { hour: get('hour'), minute: get('minute'), ymd: ymdInZone(now) };
}

let timer = null;
let lastRunSlot = null;

export function startConfirmationPipelineSweepScheduler() {
  if (timer) return timer;
  const check = async () => {
    const { hour, minute, ymd } = etClock();
    if (hour !== RUN_HOUR_ET || minute < RUN_MINUTE_ET || lastRunSlot === ymd) return;
    lastRunSlot = ymd;
    try {
      const { value: res } = await runJob(JOB_ID, () => runConfirmationSweep(), { occurrence: ymd });
      if (res) console.log(`[ConfPipe] sweep: ${JSON.stringify(res.counts)}${res.needs_date?.length ? `, ${res.needs_date.length} need a date` : ''}`);
    } catch (err) {
      console.error(`[ConfPipe] sweep threw: ${err.message}`);
    }
  };
  timer = setInterval(check, 5 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  console.log('[ConfPipe] sweep scheduler started — daily 00:05 ET');
  return timer;
}

export function stopConfirmationPipelineSweepScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
