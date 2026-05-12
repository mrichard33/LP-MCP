#!/usr/bin/env node
/**
 * Backfill Eligibility States — scripts/backfill-agentic-lead-states.js
 *
 * One-shot population of agentic_lead_states for every contact that has
 * at least one LP lead record. Runs Phase 1 classification (suppression
 * states + UNCLASSIFIED fallback).
 *
 * Usage:
 *   node scripts/backfill-agentic-lead-states.js [--limit=N] [--dry-run] [--contact-id=<id>]
 *
 *   --limit=N         Cap the number of contacts processed (default: no cap)
 *   --dry-run         Classify but do NOT write to the database
 *   --contact-id=<id> Classify just one contact (skips the scan)
 *
 * Scope (Phase 1)
 * ───────────────
 * Targets contacts in the `lp_leads` Supabase mirror with non-null
 * ghl_contact_id. That's the highest-priority cohort — every business-
 * relevant lead has an LP record. GHL-only contacts (e.g., chatbot
 * leads that never reached LP) are out of scope for Phase 1 backfill;
 * the reactive event loop will classify them on first behavioral event.
 *
 * Execution model
 * ───────────────
 * Sequential. GHL API rate limits make parallelism risky for ~thousands
 * of contacts. At ~1s/contact (network-bound on context build), 1000
 * contacts ≈ 17 minutes. Acceptable for a one-shot backfill.
 *
 * Restart-safe: re-running is idempotent. upsertCurrentState handles
 * the conflict by overwriting; transition rows are only appended on
 * actual state change (so re-running on the same data produces zero
 * new transitions).
 *
 * Output
 * ──────
 * Per-100-contact progress log + final summary by state. Errors are
 * captured per-contact and surfaced at the end with contact_id +
 * error_message so they can be retried individually.
 */

import supabase from '../src/supabase.js';
import { classifyLeadState } from '../src/agentic/lead-state/classifier.js';
import { STATES } from '../src/agentic/lead-state/states.js';

const args = process.argv.slice(2);
const opt = {
  limit:     parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '0', 10),
  dryRun:    args.includes('--dry-run'),
  contactId: (args.find(a => a.startsWith('--contact-id=')) || '').split('=')[1] || null,
};

const TRIGGER_SOURCE = 'backfill';

async function fetchContactIds() {
  // Distinct contact_ids from lp_leads where we have a GHL mapping.
  // Order by most-recently synced first — newer leads get classified
  // first, which is what we want if the run is interrupted partway.
  const PAGE = 1000;
  const all = new Set();
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('lp_leads')
      .select('ghl_contact_id, synced_at')
      .not('ghl_contact_id', 'is', null)
      .order('synced_at', { ascending: false })
      .range(from, from + PAGE - 1);

    if (error) throw new Error(`lp_leads scan failed at offset ${from}: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data) {
      if (row.ghl_contact_id) all.add(row.ghl_contact_id);
    }

    if (data.length < PAGE) break;
    from += PAGE;
  }
  return Array.from(all);
}

async function classifyOne(contactId) {
  if (opt.dryRun) {
    // In dry-run mode, just build context + run suppression in memory.
    // We can't easily replicate the persistence-skip without a flag on
    // classifyLeadState, so re-implement the shallow path here.
    const { buildLeadContext } = await import('../src/context-builder.js');
    const { classifySuppression } = await import('../src/agentic/lead-state/shapes/suppression.js');
    const ctx = await buildLeadContext(contactId, { skipCache: true });
    const supp = classifySuppression(ctx);
    return {
      contact_id: contactId,
      state: supp?.state || STATES.UNCLASSIFIED,
      confidence: supp?.confidence ?? 1.00,
      state_changed: null,  // unknown without DB read
      dry_run: true,
    };
  }
  return classifyLeadState(contactId, { triggerSource: TRIGGER_SOURCE });
}

function summarize(results) {
  const counts = {};
  const errors = [];
  let changed = 0;
  let total   = 0;
  for (const r of results) {
    total++;
    if (r.state === 'ERROR' || r.error) {
      errors.push(r);
      continue;
    }
    counts[r.state] = (counts[r.state] || 0) + 1;
    if (r.state_changed) changed++;
  }
  return { total, counts, changed, errors };
}

(async () => {
  if (!supabase) {
    console.error('Supabase not configured. Set SUPABASE_URL + SUPABASE_KEY env vars.');
    process.exit(2);
  }

  console.log('\n========================================');
  console.log('Backfill agentic_lead_states (Phase 1)');
  console.log('  Mode:        ', opt.dryRun ? 'DRY RUN (no writes)' : 'LIVE WRITES');
  console.log('  Limit:       ', opt.limit > 0 ? opt.limit : '(no cap)');
  console.log('  Contact ID:  ', opt.contactId || '(scanning lp_leads)');
  console.log('  Trigger src: ', TRIGGER_SOURCE);
  console.log('========================================\n');

  // Decide the contact list
  let contactIds;
  if (opt.contactId) {
    contactIds = [opt.contactId];
  } else {
    console.log('Scanning lp_leads for distinct ghl_contact_id values...');
    contactIds = await fetchContactIds();
    console.log(`Found ${contactIds.length} distinct contacts with LP records\n`);
    if (opt.limit > 0 && contactIds.length > opt.limit) {
      contactIds = contactIds.slice(0, opt.limit);
      console.log(`Capped to first ${opt.limit} per --limit flag\n`);
    }
  }

  if (contactIds.length === 0) {
    console.log('Nothing to classify.\n');
    process.exit(0);
  }

  const startedAt = Date.now();
  const results = [];

  for (let i = 0; i < contactIds.length; i++) {
    const id = contactIds[i];
    try {
      const r = await classifyOne(id);
      results.push(r);
    } catch (err) {
      results.push({
        contact_id: id,
        state: 'ERROR',
        error: err.message?.slice(0, 200) || 'unknown',
      });
    }

    if ((i + 1) % 100 === 0 || i === contactIds.length - 1) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      const rate = ((i + 1) / parseFloat(elapsed)).toFixed(2);
      console.log(`  ${i + 1}/${contactIds.length} classified  (${elapsed}s, ${rate}/s)`);
    }
  }

  // Summary
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const s = summarize(results);

  console.log('\n========================================');
  console.log('Backfill complete');
  console.log(`  Elapsed:        ${elapsed}s`);
  console.log(`  Total:          ${s.total}`);
  console.log(`  State changes:  ${s.changed}`);
  console.log(`  Errors:         ${s.errors.length}`);
  console.log('\n  Distribution:');
  for (const [state, count] of Object.entries(s.counts).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / s.total) * 100).toFixed(1);
    console.log(`    ${state.padEnd(28)} ${String(count).padStart(6)}  (${pct}%)`);
  }
  if (s.errors.length > 0) {
    console.log('\n  First 10 errors:');
    for (const e of s.errors.slice(0, 10)) {
      console.log(`    ${e.contact_id}: ${e.error}`);
    }
  }
  console.log('========================================\n');

  process.exit(s.errors.length > 0 ? 1 : 0);
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(2);
});
