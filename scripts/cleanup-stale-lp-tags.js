#!/usr/bin/env node
// scripts/cleanup-stale-lp-tags.js — take lp-day15-handoff and lp-demo-completed
// off contacts an OLD LP lead tagged. DRY RUN BY DEFAULT.
//
// 2026-10-11 — Frances Overton (wkUjSVicxP6918ll9nHc) filled in the calculator
// (LP lead 582736). LP sync linked her nine older leads to the contact: Day 15
// fired from leads 15+ days old, and a 2024 OPPFDN made her lp-demo-completed,
// which blocked the calculator's CALL NOW and routed her to O.0. The code fix
// (src/sync-triggers.js, demoInCurrentCycle in src/demo-truth.js) stops new
// cases; this pass cleans the contacts already tagged.
//
//   lp-day15-handoff  — removed when the contact's current LP lead is under 15
//                       days old.
//   lp-demo-completed — removed when the current lead's demo_completed is false,
//                       the current sales cycle has no demo (demoInCurrentCycle:
//                       field sync would re-stamp it otherwise), and the contact
//                       carries none of PROTECTED_TAGS.
//   LISTED only       — the current lead is a calculator lead, estimator-completed
//                       is on the contact and fast-track:estimate-calc-applied is
//                       not (a CALL NOW the old tag blocked). Nothing is fired.
//
// It only ever REMOVES these two tags, on any contact (stop-bot / DNC contacts
// included: removing a wrong routing tag is all it does to them). A contact with
// no LP lead linked is left alone. --live re-reads every contact from GHL right
// before writing and skips one whose tags changed.
//
// Usage:
//   node scripts/cleanup-stale-lp-tags.js            # dry run (default)
//   node scripts/cleanup-stale-lp-tags.js --live     # apply
//
// Needs SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (LP), HL_SUPABASE_URL /
// HL_SUPABASE_SERVICE_ROLE_KEY (the HL contacts cache), and GHL_API_KEY for --live.

import { pathToFileURL } from 'node:url';
import { pickCurrentLead } from '../src/current-lead.js';
import { demoInCurrentCycle } from '../src/demo-truth.js';

export const DAY15_TAG = 'lp-day15-handoff';
export const DEMO_TAG = 'lp-demo-completed';
// The handoff's list, plus stage:customer-onboarding: measured 2026-09-30
// (scripts/backfill-demo-truth.js) it is, with deal-won, the customer marker GHL
// actually uses.
export const PROTECTED_TAGS = Object.freeze([
  'stage:post-appointment', 'customer', 'lp-sale', 'p2:active', 'deal-won', 'stage:customer-onboarding',
]);
export const DNC_TAGS = Object.freeze(['stop-bot', 'dnc', 'stage:dnc']);
export const DAY15_MIN_AGE_DAYS = 15;
export const LP_CHUNK = 100;
export const PACE_MS = 500;

const DAY_MS = 86400000;
const norm = (t) => (typeof t === 'string' ? t.trim().toLowerCase() : '');
const hasTag = (tags, tag) => (tags || []).some((t) => norm(t) === tag);

export function isCalculatorLead(lead) {
  return /calculator/i.test(`${lead?.ghl_intent_bucket || ''} ${lead?.ghl_entry_tag || ''} ${lead?.lead_source_detail || ''}`);
}

/**
 * Pure. contacts — [{ ghl_contact_id, name, tags }] from the HL cache.
 * leadsByContact — Map<ghl_contact_id, lp_leads rows>.
 * Returns { removals: [{ contact_id, name, tag, reason, lead_id, lead_date }], callNow: [...], skipped }.
 */
export function planCleanup(contacts, leadsByContact, nowMs = Date.now()) {
  const removals = [];
  const callNow = [];
  const skipped = { noLpLead: 0 };
  for (const c of contacts) {
    const leads = (leadsByContact.get(c.ghl_contact_id) || []).filter((l) => !l.lp_deleted_at);
    const current = pickCurrentLead(leads);
    if (!current) { skipped.noLpLead += 1; continue; }
    const row = (tag, reason) => ({
      contact_id: c.ghl_contact_id, name: c.name || '', tag, reason,
      lead_id: String(current.lp_lead_id), lead_date: String(current.created_at_lp || '').slice(0, 10),
      dnc: DNC_TAGS.some((t) => hasTag(c.tags, t)),
    });
    const ageDays = current.created_at_lp ? (nowMs - Date.parse(current.created_at_lp)) / DAY_MS : null;

    if (hasTag(c.tags, DAY15_TAG) && ageDays !== null && ageDays < DAY15_MIN_AGE_DAYS) {
      removals.push(row(DAY15_TAG, `current lead is ${ageDays.toFixed(1)} days old`));
    }
    const demoTagged = hasTag(c.tags, DEMO_TAG);
    if (demoTagged && current.demo_completed !== true && !demoInCurrentCycle(leads)
        && !PROTECTED_TAGS.some((p) => hasTag(c.tags, p))) {
      removals.push(row(DEMO_TAG, 'no demo in the current sales cycle'));
    }
    if (isCalculatorLead(current) && hasTag(c.tags, 'estimator-completed')
        && !hasTag(c.tags, 'fast-track:estimate-calc-applied')) {
      callNow.push(row('(none)', 'calculator lead: estimator-completed without fast-track:estimate-calc-applied'));
    }
  }
  const byId = (a, b) => a.contact_id.localeCompare(b.contact_id) || a.tag.localeCompare(b.tag);
  return { removals: removals.sort(byId), callNow: callNow.sort(byId), skipped };
}

export function formatTable(rows) {
  const head = ['contact id', 'name', 'tag removed', 'reason', 'newest lead', 'lead date'];
  const body = rows.map((r) => [r.contact_id, r.name + (r.dnc ? ' (DNC)' : ''), r.tag, r.reason, r.lead_id, r.lead_date]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => String(b[i]).length)));
  const line = (cells) => cells.map((v, i) => String(v).padEnd(widths[i])).join(' | ');
  return [line(head), widths.map((w) => '-'.repeat(w)).join('-+-'), ...body.map(line)].join('\n');
}

// Exported 2026-10-11 so the MCP tool stale_lp_tags_cleanup_run
// (src/tools/maintenance-tools.js) runs this exact code, not a second copy.
export async function defaultDeps() {
  const [{ default: supabase }, { hlRunSQL }, { ghlFetch }, tags] = await Promise.all([
    import('../src/supabase.js'),
    import('../src/admin/hl-client.js'),
    import('../src/actions/helpers.js'),
    import('../src/actions/handlers/tags.js'),
  ]);
  return {
    supabase, hlRunSQL, ghlFetch,
    executeRemoveTag: tags.executeRemoveTag,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: console.log,
  };
}

async function loadTaggedContacts(deps) {
  const rows = await deps.hlRunSQL(
    `SELECT ghl_contact_id, trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')) AS name, tags
       FROM contacts
      WHERE deleted_at IS NULL AND ghl_contact_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM unnest(tags) t WHERE lower(t) IN ('${DAY15_TAG}', '${DEMO_TAG}'))`,
  );
  return (rows || []).map((r) => ({ ghl_contact_id: r.ghl_contact_id, name: r.name, tags: r.tags || [] }));
}

async function loadLeads(deps, contactIds) {
  if (!deps.supabase) throw new Error('LP Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  const byContact = new Map();
  for (let i = 0; i < contactIds.length; i += LP_CHUNK) {
    const chunk = contactIds.slice(i, i + LP_CHUNK);
    const { data, error } = await deps.supabase.from('lp_leads')
      .select('lp_lead_id, ghl_contact_id, disposition_code, closed_won, demo_completed, appointment_date, demo_date, created_at_lp, updated_at_lp, lp_deleted_at, ghl_intent_bucket, ghl_entry_tag, lead_source_detail, appts:raw_lp_data->appointments')
      .in('ghl_contact_id', chunk)
      .limit(5000);
    if (error) throw new Error(`lp_leads read failed: ${error.message}`);
    for (const row of data || []) {
      if (!byContact.has(row.ghl_contact_id)) byContact.set(row.ghl_contact_id, []);
      byContact.get(row.ghl_contact_id).push(row);
    }
  }
  return byContact;
}

async function liveTags(deps, contactId) {
  try {
    const res = await deps.ghlFetch('GET', `/contacts/${contactId}`);
    return res?.contact ? (res.contact.tags || []) : null;
  } catch { return null; }
}

export async function run(argv, deps) {
  const live = argv.includes('--live');
  const nowMs = deps.nowMs ?? Date.now();
  const contacts = await loadTaggedContacts(deps);
  const leadsByContact = await loadLeads(deps, contacts.map((c) => c.ghl_contact_id));
  const plan = planCleanup(contacts, leadsByContact, nowMs);

  const count = (tag) => plan.removals.filter((r) => r.tag === tag).length;
  deps.log(`[stale-lp-tags] ${contacts.length} contacts carry ${DAY15_TAG} or ${DEMO_TAG}; ${plan.skipped.noLpLead} have no LP lead linked (left alone)`);
  deps.log(`[stale-lp-tags] REMOVE ${DAY15_TAG}: ${count(DAY15_TAG)}   REMOVE ${DEMO_TAG}: ${count(DEMO_TAG)}   contacts: ${new Set(plan.removals.map((r) => r.contact_id)).size}\n`);
  deps.log(plan.removals.length ? formatTable(plan.removals) : '(nothing to remove)');
  deps.log(`\n[stale-lp-tags] calculator leads whose CALL NOW never ran (listed only, nothing fired): ${plan.callNow.length}`);
  if (plan.callNow.length) deps.log(formatTable(plan.callNow));

  // 2026-10-11: --max=N caps the live writes in one pass (the MCP tool passes
  // it so a large backlog cannot outrun a tool call at PACE_MS a write). The
  // rest are reported as `remaining`; the next pass re-plans from live data.
  const maxArg = argv.find((a) => a.startsWith('--max='));
  const max = maxArg ? Math.max(1, Number.parseInt(maxArg.slice(6), 10) || 0) : Infinity;
  const result = {
    ok: true, live, removals: plan.removals.length, callNow: plan.callNow.length,
    plan: { removals: plan.removals, callNow: plan.callNow, skipped: plan.skipped },
    written: { removed: 0, skipped: 0, failed: 0 }, remaining: 0,
  };
  if (!live) {
    deps.log('\nDRY RUN — nothing written. Apply with: node scripts/cleanup-stale-lp-tags.js --live');
    return result;
  }

  const batch = plan.removals.slice(0, max);
  result.remaining = plan.removals.length - batch.length;
  for (let i = 0; i < batch.length; i += 1) {
    const r = batch[i];
    if (i > 0) await deps.sleep(PACE_MS);
    const tags = await liveTags(deps, r.contact_id);
    if (tags === null) { result.written.skipped += 1; deps.log(`  skip ${r.contact_id}: live contact unreadable`); continue; }
    if (!hasTag(tags, r.tag)) { result.written.skipped += 1; deps.log(`  skip ${r.contact_id}: ${r.tag} already gone`); continue; }
    if (r.tag === DEMO_TAG && PROTECTED_TAGS.some((p) => hasTag(tags, p))) {
      result.written.skipped += 1; deps.log(`  skip ${r.contact_id}: now carries a protected tag`); continue;
    }
    try {
      await deps.executeRemoveTag({ target_id: r.contact_id, action_payload: { tag: r.tag } });
      result.written.removed += 1;
      deps.log(`  removed ${r.tag} from ${r.contact_id} (${r.reason})`);
    } catch (err) {
      result.written.failed += 1;
      deps.log(`  FAILED ${r.contact_id} ${r.tag}: ${err.message}`);
    }
  }
  deps.log(`\n[stale-lp-tags] LIVE: removed ${result.written.removed}, skipped ${result.written.skipped}, failed ${result.written.failed}${result.remaining ? `, ${result.remaining} left for the next pass` : ''}`);
  result.ok = result.written.failed === 0;
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  run(process.argv.slice(2), await defaultDeps())
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch((err) => { console.error(`[stale-lp-tags] FAILED: ${err.message}`); process.exit(1); });
}
