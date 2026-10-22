// ─── Partner Five9 sweep — src/jobs/partner-five9-sweep.js ──────────────────
//
// Handoff 2026-10-22 (Builds 1 and 2). The owner sync (src/partners/owner-sync.js)
// sees a contact only when an LP lead in a partner branch changes. A 1 Leg lead GHL
// hands to Ross (S5.2 v2 "I. 1 Leg") sits on its ORIGINAL market's lead (ORL, …), so
// the sync never reads it, and Lead Perfection's own Five9 export puts the numbers back
// on the Reece lists at 6 AM ET every day. This pass, every 30 minutes:
//   1. collects the contacts that may be partner-owned: our open assignments, every
//      contact in partner_owner_log (60 days), every contact we took off Five9 and have
//      not released, every contact our tag snapshot (contact_tag_snapshot) shows with a
//      partner's GHL tag (phone-team: the trigger, the user 2026-10-22), and HL-mirror
//      contacts carrying that tag or the S5.2 1 Leg branch's sent:s5.2-1leg-* tags
//      (updated in 45 days);
//   2. reads each contact live (owner and tags; the mirror holds no owner column);
//   3. the partner tag or a partner owner → ensurePartnerFive9Removal (once per removal day and mode, so the
//      first pass after each 6 AM load removes them again), plus the "set by GHL" card
//      when no assignment of ours explains it; not a partner any more after a removal
//      of ours → releasePartnerFive9;
//   4. reads back the enforce rows that ran (settleRecentGroups): what came off, and
//      one ⚠️ card for a group that failed.
// A contact read as not partner-owned is not read again for 6 hours (GHL budget). Off
// with the partner sync off, or with PARTNER_FIVE9_REMOVAL_MODE=off (the cards too: the
// owner sync still posts its own). The on-demand run, dry run by default, is
// POST /n8n/admin/partner-owner/five9-sweep (src/partners/routes.js).
// 2026-10-22 (Mark, Build 3): the same pass runs the RFED integrity guard
// (src/partners/rfed-integrity.js) on every contact whose live OWNER is a partner:
// Ross owns it in GHL ⇒ its newest LP lead must be RFED with the original's Source,
// Sub-Source and Promoter. A card, never a fix. The scheduled pass needs the Five9 mode
// on; { integrityOnly } (POST /n8n/admin/partner-owner/rfed-integrity) runs the guard
// alone, whatever that mode, and skips the Five9 work.

import { runJob } from '../job-runner.js';
import { partnerSyncConfig, postGhlSetCard } from '../partners/owner-sync.js';
import { loadPartnerMap } from '../partners/owner-resolver.js';
import {
  partnerFive9Mode, ensurePartnerFive9Removal, releasePartnerFive9, settleRecentGroups, partnerFor,
} from '../partners/five9-removal.js';
import { rfedIntegrityMode, checkPartnerContact } from '../partners/rfed-integrity.js';

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
  for (const tag of [...new Set(map.map((r) => String(r.ghl_tag || '').trim().toLowerCase()).filter(Boolean))]) {
    try {
      const { data, error } = await d.supabase.from('contact_tag_snapshot').select('ghl_contact_id').contains('tags', [tag]).limit(2000);
      if (error) throw new Error(error.message);
      for (const r of data || []) add(r.ghl_contact_id, 'tag_snapshot');
    } catch (err) { errors.push(`contact_tag_snapshot: ${err.message}`); }
  }
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
 * opts: { dryRun, integrityOnly } — a dry run reads and reports; it claims, queues, posts and releases
 * nothing. integrityOnly runs only the RFED integrity guard (no Five9 removal, release or GHL-set card).
 */
export async function runPartnerFive9Sweep(deps = {}, { dryRun = false, integrityOnly = false } = {}) {
  const env = deps.env || process.env;
  const now = deps.now || Date.now;
  const log = deps.log || console.log;
  const cfg = partnerSyncConfig(env);
  const mode = partnerFive9Mode(env);
  const integrityMode = rfedIntegrityMode(env);
  if (!cfg.enabled && !dryRun) return { ok: true, skipped: cfg.reason };
  // The scheduled pass belongs to the Five9 mode (job-registry mirrors that gate);
  // PARTNER_FIVE9_REMOVAL_MODE=off stops the scheduled guard too. integrityOnly is
  // the on-demand guard run, whatever the Five9 mode.
  if (mode === 'off' && !dryRun && !integrityOnly) return { ok: true, skipped: 'mode_off' };
  const doFive9 = !integrityOnly && (mode !== 'off' || dryRun);
  const doIntegrity = integrityMode !== 'off';
  if (!doFive9 && !doIntegrity) return { ok: true, skipped: 'integrity_mode_off' };
  const d = { ...deps, env, now, log };
  if (!d.supabase) d.supabase = (await import('../supabase.js')).default;
  if (!d.ghlFetch) d.ghlFetch = (await import('../actions/helpers.js')).ghlFetch;
  if (!d.hlRunSQL) d.hlRunSQL = (await import('../admin/hl-client.js')).hlRunSQL;
  if (doIntegrity && !d.postToSlack) d.postToSlack = (await import('../slack.js')).postToSlack;
  if (doIntegrity && !d.alertPosted) d.alertPosted = await import('../alert-posted.js');
  const fdeps = { ...d };

  const map = await loadPartnerMap(d);
  const partnerIds = new Set(map.map((r) => String(r.ghl_user_id || '')).filter(Boolean));
  if (!partnerIds.size) return { ok: true, skipped: 'no_mappings' };
  const nameOf = (id) => map.find((r) => String(r.ghl_user_id) === String(id))?.partner_name || null;
  const nowMs = now();
  const { candidates, errors } = await candidateIds(d, map, nowMs);
  const counts = { candidates: candidates.length, read: 0, partner_owned: 0, memo_skipped: 0, removals: {}, released: 0, ghl_set_cards: 0, read_errors: 0, integrity: {}, integrity_cards: 0 };
  const integrityHits = [];
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
    const hit = partnerFor(contact, map);
    if (!hit) {
      notPartnerMemo.set(c.id, nowMs);
      if (c.source === 'removed' && doFive9) {
        const r = await releasePartnerFive9({ contactId: c.id, contact, partnerRows: map, trigger: 'sweep_not_partner', dryRun, deps: fdeps });
        if (r.outcome === 'released' || r.outcome === 'would_release') counts.released++;
        contacts.push({ contact_id: c.id, owner: owner || null, five9: r.outcome });
      }
      continue;
    }
    notPartnerMemo.delete(c.id);
    counts.partner_owned++;
    const partnerName = hit.row.partner_name || nameOf(owner);
    // Build 3: only a partner OWNER is checked (a tag alone is not ownership).
    if (doIntegrity && partnerIds.has(owner)) {
      let g;
      try {
        g = await checkPartnerContact({ contactId: c.id, contact, map, dryRun, deps: fdeps });
      } catch (err) {
        g = { outcome: 'unknown', why: `threw: ${err.message}` };
      }
      counts.integrity[g.outcome] = (counts.integrity[g.outcome] || 0) + 1;
      if (g.posted) counts.integrity_cards++;
      if (g.outcome === 'mismatch' || g.outcome === 'unknown') {
        integrityHits.push({ contact_id: c.id, partner: partnerName, outcome: g.outcome, mismatches: g.mismatches || null, why: g.why || null, posted: !!g.posted });
      }
    }
    if (!doFive9) continue;
    let card = null;
    // The "set by GHL" card is about the OWNER: a tag alone (GHL has not reassigned yet) posts none.
    if (!dryRun && partnerIds.has(owner)) {
      const { data: assignment } = await d.supabase.from('partner_owner_assignments').select('ghl_user_id')
        .eq('ghl_contact_id', c.id).is('released_at', null).maybeSingle();
      if (!assignment || String(assignment.ghl_user_id) !== owner) {
        card = await postGhlSetCard({ contact, lead: await newestLead(d, c.id), partnerName, partnerUserId: owner, deps: fdeps });
        if (card?.posted) counts.ghl_set_cards++;
      }
    }
    const r = await ensurePartnerFive9Removal({
      contactId: c.id, contact, partnerRows: map, partnerName, trigger: 'sweep', dryRun, deps: fdeps,
    });
    counts.removals[r.outcome] = (counts.removals[r.outcome] || 0) + 1;
    if (r.error && errors.length < 10) errors.push(`five9 ${c.id}: ${r.error}`);
    contacts.push({
      contact_id: c.id, source: c.source, partner: partnerName, via: hit.via, five9: r.outcome,
      ...(r.lists ? { would_leave: r.lists, phones: r.phones } : {}), ...(card?.posted ? { ghl_set_card: true } : {}),
    });
  }
  let settled = null;
  if (doFive9 && !dryRun && mode === 'enforce') {
    try { settled = await settleRecentGroups({ deps: fdeps }); } catch (err) { errors.push(`settle: ${err.message}`); }
  }
  log(`[PartnerFive9Sweep] ${dryRun ? 'DRY RUN ' : ''}${doFive9 ? mode : 'five9 skipped'}: ${counts.candidates} candidate(s), ${counts.read} read, ${counts.partner_owned} partner-owned, removals ${JSON.stringify(counts.removals)}, ${counts.released} released; integrity (${integrityMode}) ${JSON.stringify(counts.integrity)}${errors.length ? `, ${errors.length} error(s)` : ''}`);
  return {
    ok: errors.length === 0, mode, integrity_mode: integrityMode, dry_run: dryRun, ...counts, settled,
    contacts: contacts.slice(0, 200), integrity_hits: integrityHits.slice(0, 200), errors: errors.slice(0, 10),
  };
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
  console.log(`[PartnerFive9Sweep] scheduler started — five9 ${partnerFive9Mode(env)}, rfed integrity ${rfedIntegrityMode(env)}, every 30m`);
  return timer;
}

export function stopPartnerFive9SweepScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
