// ─── Partner fast poll — src/jobs/partner-fast-poll.js ───────────────────────
//
// Mark, 2026-10-19: a partner lead's GHL owner must follow LP within ~2 minutes.
// LP sends no webhooks in practice and the incremental sync runs every 15 minutes,
// so this lane asks LP for leads changed since its own cursor every PARTNER_POLL_MS
// (default 90 s) and runs processProspect — whose partner hook (src/sync-leads.js →
// src/partners/owner-sync.js) makes the decision — ONLY for prospects with a lead
// that is or was in a partner branch:
//   - LP's brn_id is a branch in partner_owner_map (a lead new to RFED, or moved in);
//   - or the stored lp_leads row for that lead id is in one (a lead moved OUT).
// GetLead has no branch filter (src/lp-client.js), so the filter is local.
//
// Each tick also retries, without LP, the leads whose last decision is `failed`
// (5+ minutes ago) or `no_ghl_contact` (the contact may have been linked since);
// otherwise those would wait for LP to touch the lead again.
//
// The cursor (partner_owner_cursor, true UTC) is the end of the last window read in
// full; each window starts 2 minutes before it. LP reads its window in Eastern wall
// clock, both bounds timestamped (see the v6.15 note in src/sync-engine.js). A tick
// still running skips the next; pages sleep RATE_LIMIT_SLEEP_MS (LP watches for
// excessive use). Off with PARTNER_SYNC_ENABLED=false, with PARTNER_GO_LIVE_AT
// unset, or with no active mapping.

import { runJob } from '../job-runner.js';
import { RATE_LIMIT_SLEEP_MS, sleep, extractArray, getField } from '../sync-utils.js';
import { partnerSyncConfig, syncPartnerOwner } from '../partners/owner-sync.js';
import { partnerBranches, allPartnerBranches } from '../partners/owner-resolver.js';
import { createPageWalker } from '../lp-paging.js';

export const JOB_ID = 'partner-fast-poll';
export const CURSOR_ID = 'partner_fast_poll';
const OVERLAP_MS = 2 * 60 * 1000;
const FIRST_WINDOW_MS = 10 * 60 * 1000;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const RETRY_FAILED_AFTER_MS = 5 * 60 * 1000;
const RETRY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const RETRY_CAP = 25;

export function pollIntervalMs(env = process.env) {
  const n = parseInt(env.PARTNER_POLL_MS || '90000', 10);
  return Number.isFinite(n) && n >= 30_000 ? n : 90_000;
}

/** ET wall clock "YYYY-MM-DD HH:mm:ss" (LP reads its windows in Eastern). */
export function etTimestamp(d) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  return `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}`;
}

const branchOf = (lead) => {
  const raw = getField(lead, 'brn_id', 'BrnId', 'BrnID');
  return raw == null ? '' : String(raw).trim().toUpperCase();
};
const leadIdOf = (lead) => String(getField(lead, 'id', 'lds_id', 'LeadID') ?? '');

/** Pure: does this prospect have a lead that is, or (per the stored rows) was, in a partner branch? */
export function prospectIsPartnerRelevant(prospect, { branches, storedBranchByLead }) {
  const leads = getField(prospect, 'leads', 'Leads') || [];
  return leads.some((l) => branches.has(branchOf(l))
    || branches.has(String(storedBranchByLead.get(leadIdOf(l)) || '').trim().toUpperCase()));
}

async function readCursor(db) {
  const { data, error } = await db.from('partner_owner_cursor').select('last_changed_at').eq('id', CURSOR_ID).maybeSingle();
  if (error) throw new Error(`partner_owner_cursor read failed: ${error.message}`);
  return data?.last_changed_at ? Date.parse(data.last_changed_at) : null;
}

async function saveCursor(db, ms, nowMs) {
  const { error } = await db.from('partner_owner_cursor')
    .upsert({ id: CURSOR_ID, last_changed_at: new Date(ms).toISOString(), updated_at: new Date(nowMs).toISOString() }, { onConflict: 'id' });
  if (error) throw new Error(`partner_owner_cursor write failed: ${error.message}`);
}

async function storedBranches(db, leadIds) {
  const out = new Map();
  const ids = [...new Set(leadIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db.from('lp_leads').select('lp_lead_id, lp_branch_id').in('lp_lead_id', ids.slice(i, i + 200));
    if (error) throw new Error(`lp_leads branch read failed: ${error.message}`);
    for (const r of data || []) out.set(String(r.lp_lead_id), r.lp_branch_id);
  }
  return out;
}

/** Leads whose last decision is failed (5+ min ago) or no_ghl_contact, in the last 3 days. */
async function pendingRetries(db, nowMs) {
  const { data, error } = await db.from('partner_owner_log')
    .select('lp_lead_id, reason, created_at')
    .gte('created_at', new Date(nowMs - RETRY_WINDOW_MS).toISOString())
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) throw new Error(`partner_owner_log read failed: ${error.message}`);
  const latest = new Map();
  for (const r of data || []) if (!latest.has(String(r.lp_lead_id))) latest.set(String(r.lp_lead_id), r);
  return [...latest.values()].filter((r) => r.reason === 'no_ghl_contact'
    || (r.reason === 'failed' && nowMs - Date.parse(r.created_at) >= RETRY_FAILED_AFTER_MS))
    .slice(0, RETRY_CAP);
}

/**
 * One tick. deps: { supabase, getLeadData, processProspect, syncPartnerOwner, env, now, log, sleep }
 * Returns { ok, ...counts } for job_runs.detail.
 */
export async function runPartnerFastPoll(deps = {}) {
  const env = deps.env || process.env;
  const now = deps.now || Date.now;
  const log = deps.log || console.log;
  const started = now();
  const cfg = partnerSyncConfig(env);
  if (!cfg.enabled) return { ok: true, skipped: cfg.reason };

  const db = deps.supabase || (await import('../supabase.js')).default;
  const getLeadData = deps.getLeadData || (await import('../lp-client.js')).getLeadData;
  const processProspect = deps.processProspect || (await import('../sync-leads.js')).processProspect;
  const syncOwner = deps.syncPartnerOwner || syncPartnerOwner;
  const pause = deps.sleep || sleep;

  const branches = await partnerBranches({ supabase: db, now });
  if (!branches.size) return { ok: true, skipped: 'no_active_mappings' };
  const anyBranches = await allPartnerBranches({ supabase: db, now });

  const counts = { prospects_seen: 0, leads_seen: 0, prospects_processed: 0, lp_api_calls: 0, retries: 0, changes: 0, errors: 0 };
  const errors = [];

  // ── 1. LP changes since the cursor ──
  const cursor = await readCursor(db);
  const windowEnd = now();
  const windowStart = (cursor ?? windowEnd - FIRST_WINDOW_MS) - OVERLAP_MS;
  const startdate = etTimestamp(new Date(windowStart));
  const enddate = etTimestamp(new Date(windowEnd));
  let complete = true;
  // The shared walker (src/lp-paging.js) proves LP's StartIndex addressing and only
  // an empty page (confirmed by a one-row probe) ends the window.
  const walker = createPageWalker({
    fetch: ({ PageSize, StartIndex }) => getLeadData({ startdate, enddate, PageSize, StartIndex }).then(extractArray),
    pageSize: PAGE_SIZE,
    idOf: (r) => r?.cst_id ?? r?.id ?? null,
    label: '[PartnerFastPoll]',
    onFetch: async () => {
      if (counts.lp_api_calls > 0) await pause(RATE_LIMIT_SLEEP_MS);
      counts.lp_api_calls++;
    },
  });
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) { complete = false; break; }
    let items;
    try {
      const res = await walker.next();
      if (res.done) break;
      items = res.items;
    } catch (err) {
      complete = false;
      errors.push(`LP page ${page}: ${err.message}`);
      break;
    }
    counts.prospects_seen += items.length;
    const allLeads = items.flatMap((p) => getField(p, 'leads', 'Leads') || []);
    counts.leads_seen += allLeads.length;
    const stored = await storedBranches(db, allLeads.map(leadIdOf));
    for (const prospect of items) {
      if (!prospectIsPartnerRelevant(prospect, { branches: anyBranches, storedBranchByLead: stored })) continue;
      try {
        await processProspect(prospect);
        counts.prospects_processed++;
      } catch (err) {
        counts.errors++;
        errors.push(`prospect ${prospect?.cst_id}: ${err.message}`);
      }
    }
  }
  // Only a window read in full moves the cursor: a cut-off one is re-read next tick.
  if (complete) await saveCursor(db, windowEnd, now());

  // ── 2. Retries that need no LP call ──
  try {
    const pending = await pendingRetries(db, now());
    if (pending.length) {
      const { data: rows, error } = await db.from('lp_leads')
        .select('lp_lead_id, lp_prospect_id, lp_branch_id, rep_name, ghl_contact_id, created_at_lp, updated_at_lp')
        .in('lp_lead_id', pending.map((p) => String(p.lp_lead_id)));
      if (error) throw new Error(error.message);
      for (const row of rows || []) {
        if (!row.ghl_contact_id) continue; // still no contact: nothing to try
        counts.retries++;
        const res = await syncOwner(row, {});
        if (['assigned', 'reassigned', 'returned'].includes(res?.reason)) counts.changes++;
      }
    }
  } catch (err) {
    errors.push(`retries: ${err.message}`);
  }

  // Changes made by the processed prospects are counted from the log.
  try {
    const { data } = await db.from('partner_owner_log').select('reason')
      .gte('created_at', new Date(started).toISOString())
      .in('reason', ['assigned', 'reassigned', 'returned']);
    counts.changes = Math.max(counts.changes, (data || []).length);
  } catch { /* the count is informational */ }

  const durationMs = now() - started;
  log(`[PartnerFastPoll] ${counts.prospects_seen} prospect(s) / ${counts.leads_seen} lead(s) checked, ` +
    `${counts.prospects_processed} partner prospect(s) processed, ${counts.retries} retr${counts.retries === 1 ? 'y' : 'ies'}, ` +
    `${counts.changes} owner change(s), ${counts.lp_api_calls} LP call(s), ${durationMs}ms${errors.length ? `, ${errors.length} error(s)` : ''}`);
  return { ok: errors.length === 0, ...counts, window_complete: complete, duration_ms: durationMs, errors: errors.slice(0, 10) };
}

let timer = null;
let running = false;
export const tickState = { lastTickAt: null, lastResult: null };

export async function runPartnerFastPollTick() {
  const { value } = await runJob(JOB_ID, () => runPartnerFastPoll());
  tickState.lastTickAt = new Date().toISOString();
  tickState.lastResult = value || null;
  return value;
}

export function startPartnerFastPollScheduler(env = process.env) {
  if (timer) return timer;
  const cfg = partnerSyncConfig(env);
  if (!cfg.enabled) {
    console.log(`[PartnerFastPoll] scheduler not started (${cfg.reason === 'disabled' ? 'PARTNER_SYNC_ENABLED=false' : 'PARTNER_GO_LIVE_AT unset'})`);
    return null;
  }
  const every = pollIntervalMs(env);
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runPartnerFastPollTick();
    } catch (err) {
      console.error(`[PartnerFastPoll] tick threw: ${err.message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, every);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[PartnerFastPoll] scheduler started — every ${Math.round(every / 1000)}s, go-live ${new Date(cfg.goLiveMs).toISOString()}`);
  return timer;
}

export function stopPartnerFastPollScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
