#!/usr/bin/env node
/**
 * Backfill S1.3 Workflow Membership + Suppression — scripts/backfill-s13-membership.js
 *
 * One-shot seed of the live visibility tables introduced in migration 024 so
 * v_s13_cohort_report returns the current S1.3 cohort immediately, instead of
 * waiting for the workflow-projection sweep to accumulate live webhook events.
 *
 * Usage:
 *   node scripts/backfill-s13-membership.js [--dry-run]
 *
 *   --dry-run   Compute + report what would be written, but write nothing.
 *
 * What it seeds
 * ─────────────
 *  1. workflow_membership — one open row per contact currently tagged
 *     `active-s1.3` in contact_tag_snapshot (canonical_code='S1.3',
 *     entry_reason from agentic_reengagement_candidates.segment when known).
 *  2. contact_suppression — opt_out/dnc for the known dnc-sms / stage:dnc
 *     taggees, plus no_contact_method for the three audited dead-channel
 *     contacts (Tim / Cheryl / Sharron).
 *
 * Restart-safe: every write is an idempotent upsert against the table's UNIQUE
 * constraint, so re-running produces no duplicates. workflow_membership uses a
 * fixed entry_at per contact (now-truncated to the script start) so re-runs
 * collapse onto the same (contact, workflow, entry_at) key.
 *
 * v1.0 — 2026-06-17 (S1.3 audit remediation).
 */
import supabase from '../src/supabase.js';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

// Resolve the S1.3 workflow id (mirror lookup → env override → known default).
// Default matches enroll.js (the published S1.3 inbound_webhook workflow).
const WORKFLOW_FALLBACK = process.env.S1_3_WORKFLOW_ID || '32fa691b-2422-4727-83c9-1174801974e9';
const CANONICAL_CODE = 'S1.3';
const COHORT_TAG = 'active-s1.3';
const DNC_TAGS = ['dnc-sms', 'stage:dnc', 'dnc-email', 'dnc-canvass'];

// The three audited dead-channel contacts (failed sends, no live alternate).
const NO_CONTACT_METHOD_IDS = [
  'jeyufTZGl1XmckKgAgTV', // Tim Truong
  'HUDyHTtbepkVehv3hu7r', // Cheryl Whatins
  'ESBvQYUknDaNdkZQ2hMQ', // Sharron Hughes
];

async function resolveWorkflowId() {
  const { data } = await supabase
    .from('workflow_canonical_map')
    .select('workflow_id')
    .eq('canonical_code', CANONICAL_CODE)
    .limit(1);
  const id = data?.[0]?.workflow_id;
  if (id) return id;
  console.warn(`[Backfill] '${CANONICAL_CODE}' not in workflow_canonical_map — using workflow_id='${WORKFLOW_FALLBACK}' (set S1_3_WORKFLOW_ID to override). Report keys on canonical_code, so this is cosmetic.`);
  return WORKFLOW_FALLBACK;
}

/** All ghl_contact_ids whose tag snapshot contains any of `tagList`. */
async function contactsWithAnyTag(tagList) {
  const { data, error } = await supabase
    .from('contact_tag_snapshot')
    .select('ghl_contact_id, tags')
    .overlaps('tags', tagList);
  if (error) throw new Error(`contact_tag_snapshot read failed: ${error.message}`);
  return (data || []).filter(r => r.ghl_contact_id);
}

async function fetchSegments(contactIds) {
  const map = new Map();
  for (let i = 0; i < contactIds.length; i += 150) {
    const chunk = contactIds.slice(i, i + 150);
    const { data } = await supabase
      .from('agentic_reengagement_candidates')
      .select('contact_id, segment')
      .in('contact_id', chunk);
    for (const r of data || []) map.set(r.contact_id, r.segment);
  }
  return map;
}

async function main() {
  if (!supabase) {
    console.error('Supabase not configured. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(2);
  }
  const entryAt = new Date().toISOString();
  const workflowId = await resolveWorkflowId();

  // ── 1. workflow_membership for the active-s1.3 cohort ──
  const cohort = await contactsWithAnyTag([COHORT_TAG]);
  const segMap = await fetchSegments(cohort.map(c => c.ghl_contact_id));
  console.log(`[Backfill] cohort: ${cohort.length} contacts tagged '${COHORT_TAG}'`);

  let membershipWrites = 0;
  for (const c of cohort) {
    const row = {
      ghl_contact_id: c.ghl_contact_id,
      workflow_id: workflowId,
      canonical_code: CANONICAL_CODE,
      entry_at: entryAt,
      entry_reason: segMap.get(c.ghl_contact_id) || 'active-s1.3 tag (backfill)',
      wait_status: 'none',
      is_active: true,
      updated_at: new Date().toISOString(),
    };
    if (DRY_RUN) { membershipWrites++; continue; }
    const { error } = await supabase
      .from('workflow_membership')
      .upsert(row, { onConflict: 'ghl_contact_id,workflow_id,entry_at' });
    if (error && error.code !== '23505') {
      console.error(`  membership upsert failed for ${c.ghl_contact_id}: ${error.message}`);
    } else membershipWrites++;
  }
  console.log(`[Backfill] workflow_membership ${DRY_RUN ? 'would write' : 'wrote'}: ${membershipWrites}`);

  // ── 2a. contact_suppression for dnc / opt-out taggees ──
  const dncTaggees = await contactsWithAnyTag(DNC_TAGS);
  console.log(`[Backfill] dnc/opt-out taggees: ${dncTaggees.length}`);
  let suppressionWrites = 0;
  for (const c of dncTaggees) {
    const hasHardDnc = (c.tags || []).some(t => String(t).toLowerCase().startsWith('dnc') || String(t).toLowerCase() === 'stage:dnc');
    const reason = hasHardDnc ? 'dnc' : 'opt_out';
    if (DRY_RUN) { suppressionWrites++; continue; }
    const { error } = await supabase.from('contact_suppression').upsert({
      ghl_contact_id: c.ghl_contact_id,
      channel: 'all',
      reason,
      source_system: 'ghl',
      detail: { backfill: true, tags: c.tags || [] },
      active: true,
    }, { onConflict: 'ghl_contact_id,channel,reason' });
    if (error && error.code !== '23505') {
      console.error(`  suppression upsert failed for ${c.ghl_contact_id}: ${error.message}`);
    } else suppressionWrites++;
  }

  // ── 2b. no_contact_method for the three audited dead-channel contacts ──
  for (const id of NO_CONTACT_METHOD_IDS) {
    if (DRY_RUN) { suppressionWrites++; continue; }
    const { error } = await supabase.from('contact_suppression').upsert({
      ghl_contact_id: id,
      channel: 'all',
      reason: 'no_contact_method',
      source_system: 'agentic',
      detail: { backfill: true, audit: '2026-06-17 dead-channel' },
      active: true,
    }, { onConflict: 'ghl_contact_id,channel,reason' });
    if (error && error.code !== '23505') {
      console.error(`  no_contact_method upsert failed for ${id}: ${error.message}`);
    } else suppressionWrites++;
  }
  console.log(`[Backfill] contact_suppression ${DRY_RUN ? 'would write' : 'wrote'}: ${suppressionWrites}`);

  console.log(`\n[Backfill] complete${DRY_RUN ? ' (DRY RUN — nothing written)' : ''}.`);
  process.exit(0);
}

main().catch(err => { console.error('[Backfill] fatal:', err.message); process.exit(1); });
