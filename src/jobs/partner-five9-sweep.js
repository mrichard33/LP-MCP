// ─── Partner Five9 sweep — src/jobs/partner-five9-sweep.js ──────────────────
//
// Handoff 2026-10-22 (Builds 1 and 2). The owner sync (src/partners/owner-sync.js)
// sees a contact only when an LP lead in a partner branch changes. A 1 Leg lead GHL
// hands to Ross (S5.2 v2 "I. 1 Leg") sits on its ORIGINAL market's lead (ORL, …), so
// the sync never reads it, and Lead Perfection's own Five9 export puts the numbers back
// on the Reece lists at 6 AM ET every day. This pass, every 30 minutes:
//   1. collects the contacts that may be partner-owned: our open assignments, every
//      contact in partner_owner_log (60 days), every contact we took off Five9 and have
//      not released, and HL-mirror contacts carrying a partner's GHL tag (phone-team) or
//      the S5.2 1 Leg branch's sent:s5.2-1leg-* tags (updated in 45 days);
//   2. reads each contact's LIVE GHL owner (the mirror holds no owner column);
//   3. partner owner → ensurePartnerFive9Removal (once per removal day and mode, so the
//      first pass after each 6 AM load removes them again), plus the "set by GHL" card
//      when no assignment of ours explains it; not a partner any more after a removal
//      of ours → releasePartnerFive9;
//   4. reads back the enforce rows that ran (settleRecentGroups): what came off, and
//      one ⚠️ card for a group that failed.
// A contact read as not partner-owned is not read again for 6 hours (GHL budget). Off
// with the partner sync off, or with PARTNER_FIVE9_REMOVAL_MODE=off (the cards too: the
// owner sync still posts its own). The on-demand run, dry run by default, is
// POST /n8n/admin/partner-owner/five9-sweep (src/partners/routes.js).

import { runJob } from '../job-runner.js';
import { partnerSyncConfig, postGhlSetCard } from '../partners/owner-sync.js';
import { loadPartnerMap } from '../partners/owner-resolver.js';
import {
  partnerFive9Mode, ensurePartnerFive9Removal, releasePartnerFive9, settleRecentGroups, latestRow,
} from '../partners/five9-removal.js';

export const JOB_ID = 'partner-five9-sweep';
const INTERVAL_MS = 30 * 60 * 1000;
const LOG_DAYS = 60;
const MIRROR_DAYS = 45;
const MAX_READS = 150;
const NOT_PARTNER_MEMO_MS = 6 * 60 * 60 * 1000;
export const ONE_LEG_TAG_PREFIX = 'sent:s5.2-1leg-';

const notPartnerMemo = new Map(); // contactId → ms last read as not partner-owned
export function __resetForTests() { notPartnerMemo.clear(); }

const esc = (v) => String(v).replace(/'/g, "''");

/** Pure: the HL-mirror candidate query for the partner tags. */
export function buildMirrorSql(tags, nowMs = Date.now()) {
  const since = new Date(nowMs - MIRROR_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const tagList = (tags || []).filter(Boolean).map((t) => `'${esc(t)}'`).join(', ');
  const tagClause = tagList ? `t IN (${tagList}) OR ` : '';
  return `SELECT DISTINCT c.ghl_contact_id FROM contacts c, unnest(c.tags) t
WHERE c.deleted_at IS NULL AND (${tagClause}t LIKE '${esc(ONE_LEG_TAG_PREFIX)}%')
  AND (c.date_updated >= '${since}' OR ${tagList ? `t IN (${tagList})` : 'false'})
LIMIT 500`;
}

async function candidateIds(d, map, nowMs) {
  const ordered = [];
  const add = (id, source) => { if (id && !ordered.some((c) => c.id === id)) ordered.push({ id: String(id), source }); };
  const errors = [];
  // Removed and not released first: those are the ones a return must catch.
  try {
    const { data, error } = await d.supabase.from('partner_five9_removals').select('ghl_contact_id, action, created_at')
      .gte('created_at', new Date(nowMs - LOG_DAYS * 864e5).toISOString()).order('created_at', { ascending: false }).limit(2000);
    if (error) throw new Error(error.message);
    const latest = new Map();
    for (const r of data || []) if (!latest.has(r.ghl_contact_id)) latest.set(r.ghl_contact_id, r.action);
    for (const [id, action] of latest) if (action === 'remove') add(id, 'removed');
  } catch (err) { errors.push(`partner_five9_removals: ${err.message}`); }
  try {
    const { data, error } = await d.supabase.from('partner_owner_assignments').select('ghl_contact_id').is('released_at', null).limit(2000);
    if (error) throw new Error(error.message);
    for (const r of data || []) add(r.ghl_contact_id, 'assignment');
  } catch (err) { errors.push(`partner_owner_assignments: ${err.message}`); }
  try {
    const { data, error } = await d.supabase.from('partner_owner_log').select('ghl_contact_id')
      .gte('created_at', new Date(nowMs - LOG_DAYS * 864e5).toISOString()).not('ghl_contact_id', 'is', null).limit(2000);
    if (error) throw new Error(error.message);
    for (const r of data || []) add(r.ghl_contact_id, 'owner_log');
  } catch (err) { errors.push(`partner_owner_log: ${err.message}`); }
  try {
    const rows = await d.hlRunSQL(buildMirrorSql(map.map((r) => r.ghl_tag), nowMs));
    for (const r of rows || []) add(r.ghl_contact_id, 'hl_mirror');
  } catch (err) { errors.push(`hl mirror: ${err.message}`); }
  return { candidates: ordered, errors };
}

async function newestLead(d, contactId) {
  const { data } = await d.supabase.from('lp_leads')
    .select('lp_lead_id, lp_prospect_id, lp_branch_id, rep_name, ghl_contact_id, created_at_lp')
    .eq('ghl_contact_id', String(contactId)).is('lp_deleted_at', null)
    .order('created_at_lp', { ascending: false }).limit(1);
  return data?.[0] || null;
}

/**
 * One pass. deps: { supabase, ghlFetch, hlRunSQL, getListsInfo, postToSlack, alertPosted, env, now, log }
 * opts: { dryRun } — a dry run reads and reports; it claims, queues, posts and releases nothing.
 */
export async function runPartnerFive9Sweep(deps = {}, { dryRun = false } = {}) {
  const env = deps.env || process.env;
  const now = deps.now || Date.now;
  const log = deps.log || console.log;
  const cfg = partnerSyncConfig(env);
  const mode = partnerFive9Mode(env);
  if (!cfg.enabled && !dryRun) return { ok: true, skipped: cfg.reason };
  if (mode === 'off' && !dryRun) return { ok: true, skipped: 'mode_off' };
  const d = { ...deps, env, now, log };
  if (!d.supabase) d.supabase = (await import('../supabase.js')).default;
  if (!d.ghlFetch) d.ghlFetch = (await import('../actions/helpers.js')).ghlFetch;
  if (!d.hlRunSQL) d.hlRunSQL = (await import('../admin/hl-client.js')).hlRunSQL;
  const fdeps = { ...d };

  const map = await loadPartnerMap(d);
  const partnerIds = new Set(map.map((r) => String(r.ghl_user_id || '')).filter(Boolean));
  if (!partnerIds.size) return { ok: true, skipped: 'no_mappings' };
  const nameOf = (id) => map.find((r) => String(r.ghl_user_id) === String(id))?.partner_name || null;
  const nowMs = now();
  const { candidates, errors } = await candidateIds(d, map, nowMs);
  const counts = { candidates: candidates.length, read: 0, partner_owned: 0, memo_skipped: 0, removals: {}, released: 0, ghl_set_cards: 0, read_errors: 0 };
  const contacts = [];
  for (const c of candidates) {
    const memo = notPartnerMemo.get(c.id);
    if (c.source !== 'removed' && memo && nowMs - memo < NOT_PARTNER_MEMO_MS) { counts.memo_skipped++; continue; }
    if (counts.read >= MAX_READS) break;
    let contact;
    try {
      counts.read++;
      contact = (await d.ghlFetch('GET', `/contacts/${c.id}`))?.contact;
      if (!contact) throw new Error('not found in GHL');
    } catch (err) {
      counts.read_errors++;
      if (errors.length < 10) errors.push(`contact ${c.id}: ${err.message}`);
      continue; // could not tell: nothing removed, nothing released
    }
    const owner = String(contact.assignedTo || '');
    if (!partnerIds.has(owner)) {
      notPartnerMemo.set(c.id, nowMs);
      if (c.source === 'removed') {
        const r = await releasePartnerFive9({ contactId: c.id, trigger: 'sweep_not_partner', dryRun, deps: fdeps });
        if (r.outcome === 'released' || r.outcome === 'would_release') counts.released++;
        contacts.push({ contact_id: c.id, owner: owner || null, five9: r.outcome });
      }
      continue;
    }
    notPartnerMemo.delete(c.id);
    counts.partner_owned++;
    const partnerName = nameOf(owner);
    let card = null;
    if (!dryRun) {
      const { data: assignment } = await d.supabase.from('partner_owner_assignments').select('ghl_user_id')
        .eq('ghl_contact_id', c.id).is('released_at', null).maybeSingle();
      if (!assignment || String(assignment.ghl_user_id) !== owner) {
        card = await postGhlSetCard({ contact, lead: await newestLead(d, c.id), partnerName, partnerUserId: owner, deps: fdeps });
        if (card?.posted) counts.ghl_set_cards++;
      }
    }
    const r = await ensurePartnerFive9Removal({
      contactId: c.id, contact, partnerUserIds: partnerIds, partnerName, trigger: 'sweep', dryRun, deps: fdeps,
    });
    counts.removals[r.outcome] = (counts.removals[r.outcome] || 0) + 1;
    if (r.error && errors.length < 10) errors.push(`five9 ${c.id}: ${r.error}`);
    contacts.push({
      contact_id: c.id, source: c.source, partner: partnerName, five9: r.outcome,
      ...(r.lists ? { would_leave: r.lists, phones: r.phones } : {}), ...(card?.posted ? { ghl_set_card: true } : {}),
    });
  }
  let settled = null;
  if (!dryRun && mode === 'enforce') {
    try { settled = await settleRecentGroups({ deps: fdeps }); } catch (err) { errors.push(`settle: ${err.message}`); }
  }
  log(`[PartnerFive9Sweep] ${dryRun ? 'DRY RUN ' : ''}${mode}: ${counts.candidates} candidate(s), ${counts.read} read, ${counts.partner_owned} partner-owned, removals ${JSON.stringify(counts.removals)}, ${counts.released} released${errors.length ? `, ${errors.length} error(s)` : ''}`);
  return { ok: errors.length === 0, mode, dry_run: dryRun, ...counts, settled, contacts: contacts.slice(0, 200), errors: errors.slice(0, 10) };
}

let timer = null;
let running = false;

export async function runPartnerFive9SweepTick(opts = {}) {
  const { value } = await runJob(JOB_ID, () => runPartnerFive9Sweep({}, opts));
  return value;
}

export function startPartnerFive9SweepScheduler(env = process.env) {
  if (timer) return timer;
  const cfg = partnerSyncConfig(env);
  if (!cfg.enabled || partnerFive9Mode(env) === 'off') {
    console.log(`[PartnerFive9Sweep] scheduler not started (${!cfg.enabled ? `partner sync ${cfg.reason}` : 'PARTNER_FIVE9_REMOVAL_MODE=off'})`);
    return null;
  }
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runPartnerFive9SweepTick();
    } catch (err) {
      console.error(`[PartnerFive9Sweep] pass threw: ${err.message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[PartnerFive9Sweep] scheduler started — mode ${partnerFive9Mode(env)}, every 30m`);
  return timer;
}

export function stopPartnerFive9SweepScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
