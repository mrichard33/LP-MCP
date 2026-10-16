/**
 * confirmation-pipeline-clock — src/jobs/confirmation-pipeline-clock.js
 *
 * 2026-10-16 handoff "4. Confirmation Pipeline". Every 15 minutes, 24/7, every
 * OPEN card in confirmation_opportunities is run through the handler
 * (src/actions/handlers/confirmation-pipeline-sync.js) with timeBased=true:
 *   - the 24h move: Set + under CONF_CONFIRM_NOW_HOURS → "3. Confirm Now"
 *     (never over a hand move: the clock is time, not LP),
 *   - the close at appointment + CONF_CLOSE_AFTER_HOURS,
 *   - a reschedule or a repeat homeowner's new lead the LP event did not bring.
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
  readConfig, readAppointment, targetFor, clockNeedsWork, alertDue, formatAppointment,
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

export async function runConfirmationClock({ deps = defaultDeps() } = {}) {
  const db = deps.supabase;
  const cfg = readConfig(deps.env);
  const counts = {};
  const errors = [];
  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };

  const rows = await readOpenRows(db);
  if (!rows.length) return { ok: true, skipped: true, summary: 'no open cards', dry_run: cfg.dryRun };
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
