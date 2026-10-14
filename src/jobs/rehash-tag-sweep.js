// ─── Rehash tag sweep — src/jobs/rehash-tag-sweep.js ─────────────────────────
//
// Every 15 minutes (the rules live in src/agentic/rehash-state.js):
//   TAG      a contact whose CURRENT LP lead (src/current-lead.js) went OPPFDN
//            with a demo inside the window gets the `rehash` tag and an open
//            rehash_stage row (the lead and the demo date). No 14-day F.0
//            window: Monica (581695, demo 10/7) never got active-f.0 and was
//            handled as a sales lead.
//   RELEASE  a contact whose stage ended (a newer lead, the lead left OPPFDN,
//            or 30 days since the demo) loses `rehash`, its rehash_stage row is
//            closed (ended_at, end_reason), and — when its GHL owner is a rehash
//            team member — a release_rehash_owner row (the user, 2026-10-09).
//
// No date or id ever goes into a GHL tag (Mark, 2026-10-14): the lead id, the
// demo date and the finished-lead history live in rehash_stage. Until then
// they were the tags rehash-lead:<lds>, rehash-since:<date>, rehash-done:<lds>.
//
// Every tag write is an agent_actions row (add_tag / remove_tag /
// release_rehash_owner, rule REHASH_TAG_SWEEP), so it is audited and runs
// through the executor's gates. The rehash_stage write follows ONLY a queue
// insert that succeeded, so the row never says more than the tags will. A
// rehash_stage write that fails after the queue is healed by the next pass
// (an open row with no tag is a self-heal; a tag with no row is adopted). A read
// that fails is "could not tell": that contact (or, for the stage read, the
// whole pass) is left for the next pass.
//
// REHASH_ROUTING_MODE: off stops the job; shadow decides and records
// `rehash.would_tag` / `rehash.would_release` events only; live queues the rows.
//
// GHL reads (2026-10-13): a pass read every contact live from GHL, ~47 per
// pass, 4,500 a day, and 1 pass in 4 failed on 429s (16 of LP-MCP's 65 in a
// day, #1248's per-caller counts). Almost every answer is "none". The pass now
// decides first from contact_tag_snapshot (it matched 527 of 537 open rehash
// tags on 2026-10-13) and reads GHL live only when that says act, when the
// contact is not in the snapshot, or when this contact has not been read live
// for LIVE_RECHECK_MS. Every write is still decided from a LIVE read (the
// stale-webhook rule, 2026-09-30): a snapshot mismatch costs one extra read,
// never a wrong write. A snapshot that cannot be read means all live, as before.
//
// deps (all optional, for tests): { supabase, getContact, readSnapshotTags, liveReadAt, emitEvent, env, now, log }

import { runJob } from '../job-runner.js';
import { pickCurrentLead } from '../current-lead.js';
import {
  decideRehash, rehashRoutingMode, rehashDays, rehashTeamUserIds, stageFromRows,
} from '../agentic/rehash-state.js';

export const JOB_ID = 'rehash-tag-sweep';
export const RULE_KEY = 'REHASH_TAG_SWEEP';
export const STAGE_TABLE = 'rehash_stage';
const INTERVAL_MS = 15 * 60 * 1000;
const MAX_CONTACTS = 60;
const DAY_MS = 86_400_000;
export const LIVE_RECHECK_MS = DAY_MS;
const LIVE_READ_AT = new Map(); // contactId -> ms of the last live GHL read (in-process)

async function withDefaults(deps) {
  const d = { ...deps };
  d.env ||= process.env;
  d.now ||= Date.now;
  d.log ||= console.log;
  if (!d.supabase) d.supabase = (await import('../supabase.js')).default;
  if (!d.getContact) {
    const { ghlFetch } = await import('../actions/helpers.js');
    d.getContact = async (id) => (await ghlFetch('GET', `/contacts/${id}`))?.contact || null;
  }
  if (!d.emitEvent) d.emitEvent = (await import('../event-emitter.js')).emitEvent;
  d.readSnapshotTags ||= (ids) => readSnapshotTags(d.supabase, ids);
  d.liveReadAt ||= LIVE_READ_AT;
  return d;
}

/** contactId -> tags from contact_tag_snapshot. Null when the read failed (then every contact is read live). */
async function readSnapshotTags(supabase, ids) {
  if (!ids.length) return new Map();
  try {
    const { data, error } = await supabase.from('contact_tag_snapshot')
      .select('ghl_contact_id, tags').in('ghl_contact_id', ids);
    if (error) return null;
    const map = new Map();
    for (const r of data || []) if (r?.ghl_contact_id && Array.isArray(r.tags)) map.set(r.ghl_contact_id, r.tags);
    return map;
  } catch {
    return null;
  }
}

/**
 * Pure. Can this contact's GHL read be skipped this pass? Only when the
 * snapshot answer is "nothing to do" and a live read confirmed the contact
 * within LIVE_RECHECK_MS. Anything to act on is always read live first.
 */
export function canSkipLiveRead({ snapshotDecision, lastLiveMs, nowMs, recheckMs = LIVE_RECHECK_MS }) {
  if (!snapshotDecision || snapshotDecision.action !== 'none') return false;
  return Number.isFinite(lastLiveMs) && nowMs - lastLiveMs < recheckMs;
}

/** Contacts to look at: recent OPPFDN demos, plus every contact with an open rehash_stage row. */
async function readCandidates(d, nowMs) {
  const since = new Date(nowMs - (rehashDays(d.env) + 2) * DAY_MS).toISOString().slice(0, 10);
  const { data: demos, error: e1 } = await d.supabase.from('lp_leads')
    .select('ghl_contact_id')
    .eq('disposition_code', 'OPPFDN')
    .gte('appointment_date', since)
    .not('ghl_contact_id', 'is', null)
    .limit(1000);
  if (e1) throw new Error(`OPPFDN read: ${e1.message}`);
  const { data: open, error: e2 } = await d.supabase.from(STAGE_TABLE)
    .select('ghl_contact_id')
    .is('ended_at', null)
    .limit(5000);
  if (e2) throw new Error(`rehash_stage read: ${e2.message}`);
  const ids = new Set((demos || []).map((r) => r.ghl_contact_id));
  for (const r of open || []) if (r?.ghl_contact_id) ids.add(r.ghl_contact_id);
  return [...ids];
}

/** contactId -> { open, doneLeadIds } for the pass. Throws when the read fails (the pass then decides nothing). */
async function readStages(d, ids) {
  const byContact = new Map();
  if (!ids.length) return byContact;
  const { data, error } = await d.supabase.from(STAGE_TABLE)
    .select('ghl_contact_id, lp_lead_id, demo_date, started_at, ended_at')
    .in('ghl_contact_id', ids)
    .limit(5000);
  if (error) throw new Error(`rehash_stage read: ${error.message}`);
  const rows = new Map();
  for (const r of data || []) {
    if (!r?.ghl_contact_id) continue;
    if (!rows.has(r.ghl_contact_id)) rows.set(r.ghl_contact_id, []);
    rows.get(r.ghl_contact_id).push(r);
  }
  for (const id of ids) byContact.set(id, stageFromRows(rows.get(id)));
  return byContact;
}

/**
 * Write the decision's rehash_stage change. Returns an error string or null.
 *   stageStart  insert an open row
 *   stageEnd    close the open row for that lead; with none open, record the
 *               finished lead as an ended row (the old rehash-done:<lds>)
 */
export async function writeStage(supabase, contactId, dec, nowIso) {
  if (dec.stageStart) {
    const { error } = await supabase.from(STAGE_TABLE).insert({
      ghl_contact_id: contactId,
      lp_lead_id: String(dec.stageStart.lp_lead_id),
      demo_date: dec.stageStart.demo_date || null,
    });
    if (error) return `stage start ${error.message}`;
  }
  if (dec.stageEnd) {
    const lead = String(dec.stageEnd.lp_lead_id);
    const { data, error } = await supabase.from(STAGE_TABLE)
      .update({ ended_at: nowIso, end_reason: dec.stageEnd.reason })
      .eq('ghl_contact_id', contactId)
      .eq('lp_lead_id', lead)
      .is('ended_at', null)
      .select('id');
    if (error) return `stage end ${error.message}`;
    if (!data || data.length === 0) {
      const ins = await supabase.from(STAGE_TABLE).insert({
        ghl_contact_id: contactId, lp_lead_id: lead, demo_date: null,
        started_at: nowIso, ended_at: nowIso, end_reason: dec.stageEnd.reason,
      });
      // 23505: the lead already has an ended row. That is the history we wanted.
      if (ins.error && ins.error.code !== '23505') return `stage end ${ins.error.message}`;
    }
  }
  return null;
}

async function readLeads(d, contactId) {
  const { data, error } = await d.supabase.from('lp_leads')
    .select('lp_lead_id, disposition_code, appointment_date, appointment_set, created_at_lp, updated_at_lp')
    .eq('ghl_contact_id', contactId)
    .is('lp_deleted_at', null)
    .limit(50);
  if (error) throw new Error(error.message);
  return data || [];
}

function actionRow(contactId, actionType, payload, reasoning) {
  return {
    event_id: null,
    action_type: actionType,
    target_system: 'ghl',
    target_entity: 'contact',
    target_id: contactId,
    action_payload: payload,
    reasoning,
    rule_applied: RULE_KEY,
    confidence: 1.0,
    status: 'pending',
    requires_approval: false,
    priority: 60,
  };
}

/**
 * The contacts this pass reads. With more candidates than MAX_CONTACTS the
 * window rotates each pass, so every contact is reached within a few passes
 * instead of the same first 60 forever. Pure.
 */
export function passSlice(ids, nowMs, max = MAX_CONTACTS) {
  if (ids.length <= max) return ids;
  const start = (Math.floor(nowMs / INTERVAL_MS) * max) % ids.length;
  return [...ids.slice(start), ...ids.slice(0, start)].slice(0, max);
}

/** The agent_actions rows for one decision. Pure. */
export function rowsFor(contactId, dec) {
  const why = `Rehash (the user, 2026-10-09): ${dec.reason}.`;
  const rows = [];
  for (const tag of dec.remove || []) rows.push(actionRow(contactId, 'remove_tag', { tag }, why));
  for (const tag of dec.add || []) rows.push(actionRow(contactId, 'add_tag', { tag }, why));
  if (dec.unassign) rows.push(actionRow(contactId, 'release_rehash_owner', {}, `${why} The rehash rep stops owning the contact.`));
  return rows;
}

export async function runRehashTagSweep(deps = {}) {
  const d = await withDefaults(deps);
  const mode = rehashRoutingMode(d.env);
  if (mode === 'off') return { skipped: true, reason: 'REHASH_ROUTING_MODE=off', mode };
  const nowMs = d.now();
  const team = rehashTeamUserIds(d.env);
  const counts = { tag: 0, release: 0, none: 0, unreadable: 0, queued_rows: 0 };
  const errors = [];

  let ids;
  try {
    ids = await readCandidates(d, nowMs);
  } catch (err) {
    return { ok: false, mode, counts, errors: [err.message], insufficient_evidence: true };
  }

  const slice = passSlice(ids, nowMs);
  let stages;
  try {
    stages = await readStages(d, slice);
  } catch (err) {
    return { ok: false, mode, candidates: ids.length, counts, errors: [err.message], insufficient_evidence: true };
  }
  const snapshot = await d.readSnapshotTags(slice);
  counts.live_reads = 0;
  counts.live_reads_skipped = 0;

  for (const contactId of slice) {
    let dec;
    try {
      const leads = await readLeads(d, contactId);
      const currentLead = pickCurrentLead(leads);
      const stage = stages.get(contactId);
      const snapTags = snapshot?.get(contactId);
      if (snapTags) {
        const snapshotDecision = decideRehash({ tags: snapTags, currentLead, owner: null, rehashTeam: team, stage, nowMs, env: d.env });
        if (canSkipLiveRead({ snapshotDecision, lastLiveMs: d.liveReadAt.get(contactId), nowMs })) {
          counts.live_reads_skipped++;
          counts.none++;
          continue;
        }
      }
      const contact = await d.getContact(contactId);
      counts.live_reads++;
      if (!contact) { counts.unreadable++; continue; }
      d.liveReadAt.set(contactId, nowMs);
      dec = decideRehash({
        tags: contact.tags || [], currentLead, owner: contact.assignedTo || null,
        rehashTeam: team, stage, nowMs, env: d.env,
      });
    } catch (err) {
      counts.unreadable++;
      errors.push(`${contactId}: ${err.message}`);
      continue;
    }
    counts[dec.action] = (counts[dec.action] || 0) + 1;
    if (dec.action === 'none') continue;

    const evt = (type) => d.emitEvent({
      event_type: type, source: JOB_ID, entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
      priority: 'low', bypass_filter: true,
      payload: {
        contact_id: contactId, reason: dec.reason, add: dec.add || [], remove: dec.remove || [], unassign: !!dec.unassign,
        stage_start: dec.stageStart || null, stage_end: dec.stageEnd || null, mode,
      },
    }).catch(() => {});

    if (mode !== 'live') {
      await evt(dec.action === 'tag' ? 'rehash.would_tag' : 'rehash.would_release');
      continue;
    }
    const rows = rowsFor(contactId, dec);
    if (rows.length) {
      const { error } = await d.supabase.from('agent_actions').insert(rows);
      // The queue failed: rehash_stage is not touched, so the next pass decides again.
      if (error) { errors.push(`${contactId}: queue ${error.message}`); continue; }
      counts.queued_rows += rows.length;
    }
    const stageErr = await writeStage(d.supabase, contactId, dec, new Date(nowMs).toISOString());
    if (stageErr) errors.push(`${contactId}: ${stageErr}`);
    else if (dec.stageStart || dec.stageEnd) counts.stage_rows = (counts.stage_rows || 0) + 1;
    await evt(dec.action === 'tag' ? 'rehash.tagged' : 'rehash.released');
    d.log(`[RehashSweep] ${contactId}: ${dec.action} (${dec.reason}) — ${rows.length} row(s)`);
  }

  return { ok: errors.length === 0, mode, candidates: ids.length, counts, errors: errors.slice(0, 20) };
}

let timer = null;
let running = false;

export async function runRehashTagTick() {
  const { value: res } = await runJob(JOB_ID, () => runRehashTagSweep());
  if (res && res.ok === false) console.warn(`[RehashSweep] pass finished with errors: ${(res.errors || []).slice(0, 5).join('; ')}`);
}

export function startRehashTagScheduler(env = process.env) {
  if (timer) return timer;
  if (rehashRoutingMode(env) === 'off') {
    console.log('[RehashSweep] scheduler not started (REHASH_ROUTING_MODE=off)');
    return null;
  }
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runRehashTagTick();
    } catch (err) {
      console.error(`[RehashSweep] pass threw: ${err.message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[RehashSweep] scheduler started — ${rehashRoutingMode(env)}, every 15m`);
  return timer;
}

export function stopRehashTagScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
