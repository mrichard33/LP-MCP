/**
 * sync_confirmation_opportunity — src/actions/handlers/confirmation-pipeline-sync.js
 *
 * 2026-10-16 handoff "4. Confirmation Pipeline". Keeps ONE GHL card per LP
 * appointment in "4. Confirmation Pipeline" (ThrBNpyzJhAON4WFC855). Fired by the
 * CONF_PIPE_SET / VERIF / CNF / ND / CXL rules on lp.disposition_changed, by the
 * 15-minute clock (src/jobs/confirmation-pipeline-clock.js, timeBased) and by
 * the go-live backfill. The decisions are all in
 * src/confirmation-pipeline/rules.js; this file reads, writes and logs.
 *
 * Every run re-reads the NEWEST lp_leads row for the contact (by created_at_lp).
 * The rule's params are a cross-check only. One card per contact per pipeline
 * is all GHL allows, so a returning homeowner's new lead re-points the
 * contact's existing card (the user, 2026-10-16): renamed, reopened,
 * re-evaluated, and the row's lp_lead_id moves to the new lead.
 *
 * What it touches: only opportunities in CONF_PIPELINE_ID (create, move,
 * rename, close). NEVER a calendar appointment (sync_lp_appointment_to_ghl owns
 * that), never "5. Canvass Confirmation Pipeline" (GHL-native: canvass leads are
 * skipped), and every GHL search carries pipeline_id.
 *
 * Before every move it reads the live card. A stage that differs from the one
 * we stored means a person moved it: that is recorded (last_moved_by='manual')
 * and respected by the rules.
 *
 * CONF_PIPE_DRY_RUN (default TRUE): every decision is computed and logged in
 * confirmation_opportunity_log, GHL is only read, Slack is never posted. State
 * rows are written with dry_run=true so the clock can simulate a day; the first
 * live run treats a dry-run row as no state at all (there is no card behind it).
 *
 * Throws only for a failed GHL or Supabase call the executor should retry;
 * every decision (skip, noop, blocked) is a return.
 */

import supabase from '../../supabase.js';
import { ghlFetch } from '../helpers.js';
import { GHL_LOCATION_ID } from '../constants.js';
import {
  readConfig, readAppointment, targetFor, decideMove, cardName, isCanvassLead,
  stageKeyForId,
} from '../../confirmation-pipeline/rules.js';

const LEAD_COLUMNS =
  'lp_lead_id, ghl_contact_id, disposition_code, appointment_date, first_name, last_name, ' +
  'lead_source, ghl_entry_tag, ghl_intent_bucket, created_at_lp, updated_at_lp';

export function defaultDeps() {
  return { supabase, ghlFetch, env: process.env, now: () => new Date(), log: console };
}

// One card per contact: serialise runs for the same contact in this process,
// so an LP event and a clock pass cannot both create a card.
const locks = new Map();
async function withContactLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const chained = prev.then(() => mine);
  locks.set(key, chained);
  await prev.catch(() => {});
  try { return await fn(); } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

export async function readNewestLead(db, contactId) {
  const { data, error } = await db.from('lp_leads').select(LEAD_COLUMNS)
    .eq('ghl_contact_id', contactId).is('lp_deleted_at', null)
    .order('created_at_lp', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`confirmation pipeline: lp_leads read failed: ${error.message}`);
  return data || null;
}

async function readRows(db, lpLeadId, contactId) {
  const byLead = await db.from('confirmation_opportunities').select('*').eq('lp_lead_id', String(lpLeadId)).maybeSingle();
  if (byLead.error) throw new Error(`confirmation pipeline: row read failed: ${byLead.error.message}`);
  if (byLead.data) return { row: byLead.data, rebind: false };
  const byContact = await db.from('confirmation_opportunities').select('*').eq('ghl_contact_id', contactId)
    .order('updated_at', { ascending: false }).limit(1).maybeSingle();
  if (byContact.error) throw new Error(`confirmation pipeline: row read failed: ${byContact.error.message}`);
  return { row: byContact.data || null, rebind: !!byContact.data };
}

function liveFrom(cfg, opp) {
  if (!opp) return null;
  return {
    id: opp.id,
    pipelineId: opp.pipelineId,
    stageKey: stageKeyForId(cfg, opp.pipelineStageId),
    status: opp.status || 'open',
    name: opp.name || '',
    lastStageChangeAt: opp.lastStageChangeAt || opp.lastStatusChangeAt || opp.updatedAt || null,
    lastStatusChangeAt: opp.lastStatusChangeAt || null,
  };
}

/** The live card: by stored id first, then a pipeline-scoped search (never unscoped). */
async function readLiveCard(deps, cfg, row, contactId) {
  if (row?.ghl_opportunity_id) {
    try {
      const res = await deps.ghlFetch('GET', `/opportunities/${row.ghl_opportunity_id}`);
      const opp = res?.opportunity || null;
      if (opp && opp.pipelineId === cfg.pipelineId) return { live: liveFrom(cfg, opp), leftPipeline: false };
      if (opp) return { live: null, leftPipeline: true };
    } catch (err) {
      if (!/→ 404/.test(err.message)) throw err;
    }
  }
  const res = await deps.ghlFetch('GET',
    `/opportunities/search?location_id=${GHL_LOCATION_ID}&contact_id=${contactId}&pipeline_id=${cfg.pipelineId}`);
  const opps = (res?.opportunities || []).filter((o) => !o.pipelineId || o.pipelineId === cfg.pipelineId);
  if (!opps.length) return { live: null, leftPipeline: false };
  const open = opps.filter((o) => (o.status || 'open') === 'open');
  const pool = open.length ? open : opps;
  pool.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
  return { live: liveFrom(cfg, pool[0]), leftPipeline: false };
}

export async function writeLog(db, entry, log = console) {
  const { error } = await db.from('confirmation_opportunity_log').insert(entry);
  if (error) log.warn?.(`[ConfPipe] log write failed: ${error.message}`);
}

function contactDisplayName(c) {
  return [c?.firstName, c?.lastName].filter(Boolean).join(' ') || c?.contactName || c?.name || '';
}

/**
 * The work. Exported for the clock, the backfill and the tests.
 *
 * @param {object} a
 * @param {string} a.contactId
 * @param {string} [a.lpLeadId]     the event's lead, cross-check only
 * @param {string} [a.lpChangedAt]  when LP's disposition changed (event time)
 * @param {boolean} [a.timeBased]   from the clock: never overrides a hand move
 * @param {object} [a.lead]         a preloaded newest lead (the clock batches the read)
 * @param {string} [a.source]       'rule' | 'clock' | 'backfill'
 */
export async function syncConfirmationCard({ contactId, lpLeadId = null, lpChangedAt = null, timeBased = false, lead = null, source = 'rule', deps = defaultDeps() } = {}) {
  if (!contactId) return { outcome: 'skip', reason: 'no_contact' };
  return withContactLock(String(contactId), () => runOne({ contactId, lpLeadId, lpChangedAt, timeBased, lead, source, deps }));
}

async function runOne({ contactId, lpLeadId, lpChangedAt, timeBased, lead, source, deps }) {
  const db = deps.supabase;
  const log = deps.log || console;
  const cfg = readConfig(deps.env);
  const now = deps.now();
  const dry = cfg.dryRun;

  lead = lead || await readNewestLead(db, contactId);
  if (!lead) {
    await writeLog(db, { lp_lead_id: lpLeadId ? String(lpLeadId) : null, action: 'skip', source, dry_run: dry, note: 'no_lp_lead' }, log);
    return { outcome: 'skip', reason: 'no_lp_lead' };
  }
  const leadId = String(lead.lp_lead_id);
  const disposition = String(lead.disposition_code || '');
  const notes = [];
  if (lpLeadId && String(lpLeadId) !== leadId) notes.push(`event lead ${lpLeadId} is not the newest (${leadId})`);

  if (isCanvassLead(lead)) {
    await writeLog(db, { lp_lead_id: leadId, action: 'skip', source, lp_disposition: disposition, dry_run: dry, note: 'canvass_lead' }, log);
    return { outcome: 'skip', reason: 'canvass_lead' };
  }

  const appt = readAppointment(lead.appointment_date);
  const target = targetFor({ disposition, appt, now, cfg });

  const { row: rawRow, rebind } = await readRows(db, leadId, contactId);
  // A dry-run row has no card behind it: a live run decides as if it were not there.
  const row = (rawRow && rawRow.dry_run && !dry) ? null : rawRow;
  const writable = !dry || !rawRow || rawRow.dry_run;

  // Never create a card for a past or cancelled appointment, and do not spend a
  // GHL read when there is no card and nothing to make.
  if (!row && (target.kind !== 'stage')) {
    if (rawRow && writable && target.kind === 'close') {
      await db.from('confirmation_opportunities').update({ closed_status: target.status || 'abandoned', closed_at: now.toISOString(), updated_at: now.toISOString(), dry_run: dry }).eq('id', rawRow.id);
    }
    await writeLog(db, { lp_lead_id: leadId, action: 'skip', source, lp_disposition: disposition, dry_run: dry, note: `${target.reason}${rawRow ? ' (dry-run row, no card)' : ''}` }, log);
    return { outcome: 'skip', reason: target.reason };
  }

  const { live, leftPipeline } = await readLiveCard(deps, cfg, row, contactId);
  if (leftPipeline) {
    await writeLog(db, { lp_lead_id: leadId, ghl_opportunity_id: row?.ghl_opportunity_id, action: 'skip', source, lp_disposition: disposition, dry_run: dry, note: 'card_left_pipeline' }, log);
    return { outcome: 'skip', reason: 'card_left_pipeline' };
  }

  const decision = decideMove({
    row, live, target, disposition, apptAt: appt?.at || null,
    lpChangedAt, timeBased, rebind: rebind && !!row, now,
  });
  const fromStage = live?.stageKey || row?.stage_key || null;

  if (decision.manualDetected) {
    await writeLog(db, {
      lp_lead_id: leadId, ghl_opportunity_id: live.id, from_stage: row.stage_key, to_stage: live.stageKey,
      action: 'manual_detected', source, lp_disposition: disposition, dry_run: dry, note: 'live stage differs from stored stage',
    }, log);
  }

  // Contact name (and canvass tags) only when a card is made or renamed.
  let contactName = row?.contact_name || null;
  const needsName = decision.op === 'create' || decision.reschedule || (rebind && !!row) || !contactName;
  if (needsName && (decision.op === 'create' || live)) {
    try {
      const res = await deps.ghlFetch('GET', `/contacts/${contactId}`);
      const contact = res?.contact || res || {};
      if (decision.op === 'create' && isCanvassLead(lead, contact.tags || [])) {
        await writeLog(db, { lp_lead_id: leadId, action: 'skip', source, lp_disposition: disposition, dry_run: dry, note: 'canvass_contact_tag' }, log);
        return { outcome: 'skip', reason: 'canvass_lead' };
      }
      contactName = contactDisplayName(contact) || contactName;
    } catch (err) {
      if (decision.op === 'create') throw err;
      log.warn?.(`[ConfPipe] contact read failed for ${contactId}: ${err.message} — keeping the card name`);
    }
  }
  contactName = contactName || [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Unknown';
  const expectedName = cardName(contactName, appt);
  const rename = !!(live && appt && live.name !== expectedName
    && (decision.reschedule || (rebind && !!row) || !row?.card_name || row.card_name !== expectedName));

  // ── GHL writes ─────────────────────────────────────────────────────────────
  let oppId = live?.id || row?.ghl_opportunity_id || null;
  let toStage = fromStage;
  let closedStatus = null;
  const body = {};
  if (decision.op === 'move' || decision.op === 'reopen') {
    body.pipelineStageId = cfg.stages[decision.toStage];
    body.status = 'open';
    toStage = decision.toStage;
  } else if (decision.op === 'close') {
    body.status = decision.status;
    closedStatus = decision.status;
  } else if (decision.op === 'create') {
    toStage = decision.toStage;
  }
  if (rename) body.name = expectedName;

  if (!dry) {
    if (decision.op === 'create') {
      oppId = await createCard(deps, cfg, { contactId, stage: decision.toStage, name: expectedName });
    } else if (oppId && Object.keys(body).length) {
      await deps.ghlFetch('PUT', `/opportunities/${oppId}`, body);
    }
  }

  // ── State row ──────────────────────────────────────────────────────────────
  const nowIso = now.toISOString();
  if (writable && ['create', 'move', 'reopen', 'close', 'noop', 'blocked'].includes(decision.op)) {
    const fresh = decision.reschedule || (rebind && !!row) || (rawRow && rawRow.dry_run && !dry);
    // We moved it → 'agent'. A hand move we just found (and did not override) →
    // 'manual'. A reschedule or a new lead starts over. Otherwise unchanged.
    let movedBy;
    if (['move', 'reopen', 'create'].includes(decision.op) || fresh) movedBy = 'agent';
    else if (decision.manualDetected) movedBy = 'manual';
    else movedBy = row?.last_moved_by || 'agent';
    const rec = {
      lp_lead_id: leadId,
      ghl_contact_id: String(contactId),
      ghl_opportunity_id: oppId,
      stage_key: toStage || decision.toStage || 'new',
      last_lp_disposition: disposition,
      last_moved_by: movedBy,
      appointment_at: appt?.at ? appt.at.toISOString() : (row?.appointment_at || null),
      last_lp_change_at: lpChangedAt || row?.last_lp_change_at || null,
      contact_name: contactName,
      card_name: (decision.op === 'create' || rename) ? expectedName : (row?.card_name || live?.name || null),
      dry_run: dry,
      updated_at: nowIso,
    };
    if (decision.manualDetected) rec.last_manual_move_at = new Date(decision.manualAt).toISOString();
    if (fresh) rec.alerted_at = null;
    if (decision.op === 'close') { rec.closed_status = closedStatus; rec.closed_at = nowIso; }
    if (decision.op === 'reopen' || (fresh && decision.op !== 'close')) { rec.closed_status = null; rec.closed_at = null; }
    if (rawRow) {
      const { error } = await db.from('confirmation_opportunities').update(rec).eq('id', rawRow.id);
      if (error) throw new Error(`confirmation pipeline: row update failed: ${error.message}`);
    } else {
      const { error } = await db.from('confirmation_opportunities').insert(rec);
      if (error) throw new Error(`confirmation pipeline: row insert failed: ${error.message}`);
    }
  }

  if (rebind && row) notes.push(`rebind from lead ${row.lp_lead_id}`);
  if (decision.reschedule) notes.push('reschedule');
  if (rename) notes.push(`rename → ${expectedName}`);
  await writeLog(db, {
    lp_lead_id: leadId,
    ghl_opportunity_id: oppId,
    from_stage: fromStage,
    to_stage: decision.op === 'close' ? `closed:${closedStatus}` : (decision.toStage || toStage),
    action: decision.op === 'noop' && rename ? 'rename' : decision.op,
    source,
    lp_disposition: disposition,
    dry_run: dry,
    note: [decision.reason, ...notes].join('; '),
  }, log);

  return {
    outcome: decision.op,
    reason: decision.reason,
    lp_lead_id: leadId,
    opportunity_id: oppId,
    from_stage: fromStage,
    to_stage: decision.toStage || toStage,
    closed_status: closedStatus,
    renamed: rename,
    manual_detected: decision.manualDetected,
    dry_run: dry,
  };
}

/**
 * POST a new card. GHL rejects a second card for the same contact in the same
 * pipeline with 400 "duplicate opportunity" naming meta.existingId: that card
 * is adopted ONLY when it is in this pipeline. The old move_opportunity
 * recovery PUT onto whatever card GHL named, whichever pipeline it was in.
 */
async function createCard(deps, cfg, { contactId, stage, name }) {
  try {
    const res = await deps.ghlFetch('POST', '/opportunities/', {
      pipelineId: cfg.pipelineId,
      pipelineStageId: cfg.stages[stage],
      locationId: GHL_LOCATION_ID,
      contactId,
      name,
      status: 'open',
    });
    return res?.opportunity?.id || null;
  } catch (err) {
    const m = /"existingId"\s*:\s*"([^"]+)"/.exec(err?.message || '');
    if (!m) throw err;
    const existing = await deps.ghlFetch('GET', `/opportunities/${m[1]}`);
    if (existing?.opportunity?.pipelineId !== cfg.pipelineId) throw err;
    await deps.ghlFetch('PUT', `/opportunities/${m[1]}`, { pipelineStageId: cfg.stages[stage], status: 'open', name });
    return m[1];
  }
}

/** The action-executor entry point. */
export async function executeSyncConfirmationOpportunity(action, _context = {}, deps = defaultDeps()) {
  const contactId = action?.target_id;
  if (!contactId) throw new Error('sync_confirmation_opportunity: target_id (GHL contact id) is required');
  const payload = action.action_payload || {};
  let lpLeadId = payload.lp_lead_id || null;
  let lpChangedAt = payload.lp_changed_at || null;
  if (action.event_id) {
    const { data: evt } = await deps.supabase.from('system_events')
      .select('lp_lead_id, entity_id, entity_type, created_at').eq('id', action.event_id).maybeSingle();
    if (evt) {
      lpLeadId = lpLeadId || evt.lp_lead_id || (evt.entity_type === 'lead' ? evt.entity_id : null);
      lpChangedAt = lpChangedAt || evt.created_at || null;
    }
  }
  const result = await syncConfirmationCard({
    contactId, lpLeadId, lpChangedAt: lpChangedAt || action.created_at || null,
    timeBased: false, source: payload.source || 'rule', deps,
  });
  if (payload.disposition_code && result.lp_lead_id && result.outcome !== 'skip') {
    result.rule_disposition = payload.disposition_code;
  }
  return { action: 'sync_confirmation_opportunity', ...result };
}
