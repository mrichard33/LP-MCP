/**
 * confirmation-pipeline-clock — src/jobs/confirmation-pipeline-clock.js
 *
 * 2026-10-16 handoff "4. Confirmation Pipeline". Every 15 minutes, 24/7, every
 * OPEN card in confirmation_opportunities is run through the handler
 * (src/actions/handlers/confirmation-pipeline-sync.js) with timeBased=true:
 *   - the 24h move: Set + under CONF_CONFIRM_NOW_HOURS → "3. Confirm Now"
 *     (never over a hand move: the clock is time, not LP),
 *   - the close at appointment + CONF_CLOSE_AFTER_HOURS,
 *   - a reschedule or a repeat homeowner's new lead the LP event did not bring,
 *   - COVERAGE (2026-10-16): a linked lead with a visit in the next 14 days and
 *     no card at all gets one (readUncoveredLeads, 25 a pass).
 * Then the 4h alert: a card not Confirmed / Disqualified, under CONF_ALERT_HOURS
 * to its appointment, alerted_at null → ONE post to CONF_SLACK_CHANNEL (name,
 * time, stage, links) and alerted_at is set. No channel → a warning log, and
 * alerted_at is still set so the warning is once per appointment, not once
 * per pass. Dry run: logged, never posted.
 *
 * The pre-check (clockNeedsWork) is Supabase only: a card that needs nothing
 * this pass costs no GHL call. A hand-moved or locked card would otherwise be
 * read from GHL every 15 minutes for a move the rules refuse.
 */

import supabase from '../supabase.js';
import { runJob } from '../job-runner.js';
import { postToSlack } from '../slack.js';
import { GHL_LOCATION_ID } from '../actions/constants.js';
import { syncConfirmationCard, writeLog } from '../actions/handlers/confirmation-pipeline-sync.js';
import { ghlFetch } from '../actions/helpers.js';
import {
  readConfig, readAppointment, targetFor, clockNeedsWork, alertDue, formatAppointment, ymdInZone,
} from '../confirmation-pipeline/rules.js';

export const JOB_ID = 'confirmation-pipeline-clock';
const INTERVAL_MS = 15 * 60 * 1000;
const PAGE = 1000;

const STAGE_LABEL = {
  new: '1. New Submission (Set)',
  issue: '2. Issue Detected (Verif)',
  confirm_now: '3. Confirm Now (<24h)',
  confirmed: '4. Confirmed (Cnf)',
  disqualified: '5. Disqualified (ND)',
};

export function defaultDeps() {
  return { supabase, ghlFetch, postToSlack, env: process.env, now: () => new Date(), log: console };
}

export function buildAlertText(row, appt, cfg) {
  const contactUrl = `https://app.gohighlevel.com/v2/location/${GHL_LOCATION_ID}/contacts/detail/${row.ghl_contact_id}`;
  const boardUrl = `https://app.gohighlevel.com/v2/location/${GHL_LOCATION_ID}/opportunities/list?pipeline_id=${cfg.pipelineId}`;
  return [
    `⏰ *Not confirmed yet, appointment in under ${cfg.alertHours}h*`,
    `${row.contact_name || 'Unknown'} — ${formatAppointment(appt)} ET`,
    `Stage: ${STAGE_LABEL[row.stage_key] || row.stage_key}`,
    `<${contactUrl}|Contact> · <${boardUrl}|Confirmation board>`,
  ].join('\n');
}

async function readOpenRows(db) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from('confirmation_opportunities').select('*')
      .is('closed_status', null).order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(`open rows read failed: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

async function readNewestLeads(db, contactIds) {
  const out = new Map();
  for (let i = 0; i < contactIds.length; i += 150) {
    const chunk = contactIds.slice(i, i + 150);
    const { data, error } = await db.from('lp_leads')
      .select('lp_lead_id, ghl_contact_id, disposition_code, appointment_date, first_name, last_name, lead_source, ghl_entry_tag, ghl_intent_bucket, created_at_lp, updated_at_lp')
      .in('ghl_contact_id', chunk).is('lp_deleted_at', null).order('created_at_lp', { ascending: false });
    if (error) throw new Error(`lp_leads read failed: ${error.message}`);
    for (const l of data || []) if (!out.has(l.ghl_contact_id)) out.set(l.ghl_contact_id, l);
  }
  return out;
}

// ── Coverage (2026-10-16, Roberta Ritchie) ──────────────────────────────
// A card is created only by a CONF_PIPE_* rule, off one lp.disposition_changed
// event. An event that fired before the contact was linked (the engine skips
// it), before the rules went live (10/16 17:46; her Set was 10/15), or as a
// reschedule (no CONF_PIPE rule listened to it until now) left the visit with no
// card, and nothing ever retried. Each pass, up to COVERAGE_CAP linked leads
// with a visit today..+COVERAGE_DAYS and NO confirmation_opportunities row run
// through the same handler, soonest visit first.
export const COVERAGE_CAP = 25;
export const COVERAGE_DAYS = 14;
const COVERAGE_DISPOSITIONS = ['Set', 'Verif', 'Cnf', 'ND'];

export async function readUncoveredLeads(db, { now, tz, days = COVERAGE_DAYS, cap = COVERAGE_CAP }) {
  const today = ymdInZone(now, tz);
  const end = ymdInZone(new Date(now.getTime() + (days + 1) * 86400000), tz);
  // appointment_date holds the ET wall clock labelled UTC, so date strings compare directly.
  const { data: leads, error } = await db.from('lp_leads')
    .select('lp_lead_id, ghl_contact_id, appointment_date')
    .gte('appointment_date', `${today}T00:00:00+00:00`).lt('appointment_date', `${end}T00:00:00+00:00`)
    .in('disposition_code', COVERAGE_DISPOSITIONS).not('ghl_contact_id', 'is', null).is('lp_deleted_at', null)
    .order('appointment_date', { ascending: true }).range(0, 999);
  if (error) throw new Error(`coverage lead read failed: ${error.message}`);
  if (!leads?.length) return [];
  const ids = leads.map((l) => String(l.lp_lead_id));
  const covered = new Set();
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error: e2 } = await db.from('confirmation_opportunities').select('lp_lead_id').in('lp_lead_id', ids.slice(i, i + 150));
    if (e2) throw new Error(`coverage card read failed: ${e2.message}`);
    for (const r of data || []) covered.add(String(r.lp_lead_id));
  }
  const seen = new Set();
  const out = [];
  for (const l of leads) {
    if (out.length >= cap) break;
    if (covered.has(String(l.lp_lead_id)) || seen.has(l.ghl_contact_id)) continue;
    seen.add(l.ghl_contact_id);
    out.push(l);
  }
  return out;
}

async function runCoverage({ deps, cfg, counts, errors }) {
  let missing;
  try {
    missing = await readUncoveredLeads(deps.supabase, { now: deps.now(), tz: cfg.tz });
  } catch (err) {
    errors.push(`coverage: ${err.message}`);
    return;
  }
  for (const l of missing) {
    try {
      const res = await syncConfirmationCard({ contactId: l.ghl_contact_id, source: 'coverage', lpChangedAt: null, deps });
      counts[`coverage_${res.outcome}`] = (counts[`coverage_${res.outcome}`] || 0) + 1;
    } catch (err) {
      counts.coverage_error = (counts.coverage_error || 0) + 1;
      errors.push(`coverage ${l.ghl_contact_id}: ${err.message}`);
    }
  }
}

export async function runConfirmationClock({ deps = defaultDeps() } = {}) {
  const db = deps.supabase;
  const cfg = readConfig(deps.env);
  const counts = {};
  const errors = [];
  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };

  // Coverage first, so a card it creates is also walked by this pass.
  await runCoverage({ deps, cfg, counts, errors });

  const rows = await readOpenRows(db);
  if (!rows.length) return { ok: errors.length === 0, skipped: true, counts, errors, summary: 'no open cards', dry_run: cfg.dryRun };
  const leads = await readNewestLeads(db, [...new Set(rows.map((r) => r.ghl_contact_id))]);

  for (const row of rows) {
    const now = deps.now();
    const lead = leads.get(row.ghl_contact_id) || null;
    try {
      if (!lead) { bump('no_lead'); continue; }
      const appt = readAppointment(lead.appointment_date);
      const target = targetFor({ disposition: lead.disposition_code, appt, now, cfg });
      let current = row;
      if (clockNeedsWork({ row, lead, target, appt, cfg })) {
        const res = await syncConfirmationCard({ contactId: row.ghl_contact_id, lead, timeBased: true, source: 'clock', deps });
        bump(res.outcome);
        if (res.outcome === 'close' || res.outcome === 'skip') continue;
        const { data } = await db.from('confirmation_opportunities').select('*').eq('lp_lead_id', String(lead.lp_lead_id)).maybeSingle();
        current = data || row;
      } else {
        bump('nothing_due');
      }

      if (alertDue({ row: current, appt, now, cfg })) {
        let note;
        if (cfg.dryRun) note = 'dry_run';
        else if (!cfg.slackChannel) {
          note = 'no_channel';
          // lead-id-ok: a server log line, never Slack text
          deps.log.warn?.(`[ConfPipe] 4h alert for lead ${current.lp_lead_id} not posted: CONF_SLACK_CHANNEL is empty`);
        } else {
          const res = await deps.postToSlack(buildAlertText(current, appt, cfg), cfg.slackChannel);
          note = res?.ok ? `posted ts=${res.ts}` : `post_failed: ${res?.error || 'unknown'}`;
          if (!res?.ok) { errors.push(`alert ${current.lp_lead_id}: ${res?.error}`); }
        }
        // A dry run never writes a live row; a failed post is retried next pass.
        const mayWrite = !cfg.dryRun || current.dry_run;
        if (mayWrite && !/post_failed/.test(note)) {
          await db.from('confirmation_opportunities').update({ alerted_at: now.toISOString() }).eq('id', current.id);
        }
        await writeLog(db, {
          lp_lead_id: current.lp_lead_id, ghl_opportunity_id: current.ghl_opportunity_id,
          from_stage: current.stage_key, to_stage: current.stage_key, action: 'alert', source: 'clock',
          lp_disposition: lead.disposition_code, dry_run: cfg.dryRun, note,
        }, deps.log);
        bump('alert');
      }
    } catch (err) {
      errors.push(`${row.lp_lead_id}: ${err.message}`);
      bump('error');
    }
  }
  return { ok: errors.length === 0, dry_run: cfg.dryRun, cards: rows.length, counts, errors: errors.slice(0, 50), summary: `${rows.length} open card(s) ${JSON.stringify(counts)}` };
}

/* --- scheduler -------------------------------------------------------------- */

let timer = null;
let running = false;

export function startConfirmationPipelineClockScheduler() {
  if (timer) return timer;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { value: res } = await runJob(JOB_ID, () => runConfirmationClock());
      if (res && !res.skipped) console.log(`[ConfPipe] clock${res.dry_run ? ' (dry run)' : ''}: ${res.summary}`);
    } catch (err) {
      console.error(`[ConfPipe] clock pass threw: ${err.message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[ConfPipe] clock started — every 15m${readConfig().dryRun ? ' (CONF_PIPE_DRY_RUN)' : ''}`);
  return timer;
}

export function stopConfirmationPipelineClockScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
