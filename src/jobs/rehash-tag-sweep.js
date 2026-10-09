// ─── Rehash tag sweep — src/jobs/rehash-tag-sweep.js ─────────────────────────
//
// Every 15 minutes (the rules live in src/agentic/rehash-state.js):
//   TAG      a contact whose CURRENT LP lead (src/current-lead.js) went OPPFDN
//            with a demo inside the window gets rehash + rehash-lead:<lds> +
//            rehash-since:<demo date>. No 14-day F.0 window: Monica (581695,
//            demo 10/7) never got active-f.0 and was handled as a sales lead.
//   RELEASE  a tagged contact whose stage ended (a newer lead, the lead left
//            OPPFDN, or 30 days since the demo) loses the three tags, gets
//            rehash-done:<lds>, and — when its GHL owner is a rehash team member
//            — a release_rehash_owner row (the user, 2026-10-09).
//
// Every write is an agent_actions row (add_tag / remove_tag /
// release_rehash_owner, rule REHASH_TAG_SWEEP), so it is audited and runs
// through the executor's gates. A read that fails is "could not tell": that
// contact is left for the next pass.
//
// REHASH_ROUTING_MODE: off stops the job; shadow decides and records
// `rehash.would_tag` / `rehash.would_release` events only; live queues the rows.
//
// deps (all optional, for tests): { supabase, getContact, emitEvent, env, now, log }

import { runJob } from '../job-runner.js';
import { pickCurrentLead } from '../current-lead.js';
import {
  decideRehash, rehashRoutingMode, rehashDays, rehashTeamUserIds, REHASH_TAG,
} from '../agentic/rehash-state.js';

export const JOB_ID = 'rehash-tag-sweep';
export const RULE_KEY = 'REHASH_TAG_SWEEP';
const INTERVAL_MS = 15 * 60 * 1000;
const MAX_CONTACTS = 60;
const DAY_MS = 86_400_000;

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
  return d;
}

/** Contacts to look at: recent OPPFDN demos, plus every contact we tagged and have not released. */
async function readCandidates(d, nowMs) {
  const since = new Date(nowMs - (rehashDays(d.env) + 2) * DAY_MS).toISOString().slice(0, 10);
  const { data: demos, error: e1 } = await d.supabase.from('lp_leads')
    .select('ghl_contact_id')
    .eq('disposition_code', 'OPPFDN')
    .gte('appointment_date', since)
    .not('ghl_contact_id', 'is', null)
    .limit(1000);
  if (e1) throw new Error(`OPPFDN read: ${e1.message}`);
  const { data: tagged, error: e2 } = await d.supabase.from('agent_actions')
    .select('target_id, action_type, created_at')
    .eq('rule_applied', RULE_KEY)
    .in('action_type', ['add_tag', 'remove_tag'])
    .contains('action_payload', { tag: REHASH_TAG })
    .gte('created_at', new Date(nowMs - 120 * DAY_MS).toISOString())
    .order('created_at', { ascending: true })
    .limit(5000);
  if (e2) throw new Error(`rehash tag history read: ${e2.message}`);
  const open = new Map();
  for (const r of tagged || []) open.set(r.target_id, r.action_type === 'add_tag');
  const ids = new Set((demos || []).map((r) => r.ghl_contact_id));
  for (const [id, isOpen] of open) if (isOpen) ids.add(id);
  return [...ids];
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

  for (const contactId of passSlice(ids, nowMs)) {
    let dec;
    try {
      const [leads, contact] = await Promise.all([readLeads(d, contactId), d.getContact(contactId)]);
      if (!contact) { counts.unreadable++; continue; }
      dec = decideRehash({
        tags: contact.tags || [], currentLead: pickCurrentLead(leads), owner: contact.assignedTo || null,
        rehashTeam: team, nowMs, env: d.env,
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
      payload: { contact_id: contactId, reason: dec.reason, add: dec.add || [], remove: dec.remove || [], unassign: !!dec.unassign, mode },
    }).catch(() => {});

    if (mode !== 'live') {
      await evt(dec.action === 'tag' ? 'rehash.would_tag' : 'rehash.would_release');
      continue;
    }
    const rows = rowsFor(contactId, dec);
    const { error } = await d.supabase.from('agent_actions').insert(rows);
    if (error) { errors.push(`${contactId}: queue ${error.message}`); continue; }
    counts.queued_rows += rows.length;
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
