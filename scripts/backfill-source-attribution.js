#!/usr/bin/env node
/**
 * One-off attribution repair — scripts/backfill-source-attribution.js
 *
 * 2026-09-16 (issue #949). Before `source:` was registered in
 * NAMESPACE_FALLBACK_VALUES, `source:unknown` evicted correct paid-vendor tags
 * from 707 contacts in 30 days — source:internet-modernize 434 times,
 * my-home-pros 147, homebuddy 84, plus angi, lead-gurus and mvp-marketing.
 *
 * The removals are recoverable: every one was recorded in
 * system_events.payload.step_results[].result.removed_conflicting alongside the
 * contact id. This script reads them back and re-applies the vendor tag.
 *
 * ORDER MATTERS. Run this only AFTER the fix is deployed. Without it, restoring
 * a tag just means the next routing-tags run on that contact evicts it again —
 * and with it, the restore is a plain `specific -> fallback` SWAP that the
 * existing exclusivity logic performs itself, so there is no bespoke write path
 * here at all. executeAddTag does the work; this script only decides WHO.
 *
 * SAFETY
 * ──────
 * - DRY RUN BY DEFAULT. Pass --write to actually apply.
 * - A contact is skipped unless it currently carries `source:unknown` AND no
 *   other `source:*`. Anything else means something already corrected it, and
 *   a "restore" would be the clobber this script exists to undo.
 * - The live GHL read is the authority, not contact_tag_snapshot: the snapshot
 *   lags the GHL tag webhook by seconds to minutes, and deciding a write from a
 *   stale read is how the original bug looked from the inside.
 * - Exactly ONE tag is restored per contact, the most specific one. Restoring
 *   both `source:internet` and `source:internet-homebuddy` would recreate the
 *   double-tag state that is itself a separate defect (see #949).
 * - Writes go through ghlFetch, so they are governed by the token bucket, and
 *   are paced so 700 contacts do not arrive as a burst.
 *
 * Usage:
 *   node scripts/backfill-source-attribution.js                 # dry run
 *   node scripts/backfill-source-attribution.js --write         # apply
 *   node scripts/backfill-source-attribution.js --days 45       # wider window
 *   node scripts/backfill-source-attribution.js --limit 25 --write
 */

import supabaseDefault from '../src/supabase.js';
import { executeAddTag } from '../src/actions/handlers/tags.js';
import { getContactCached } from '../src/actions/contact-cache.js';

const WRITE = process.argv.includes('--write');
const argOf = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? dflt : Number(process.argv[i + 1]);
};
const DAYS = argOf('--days', 30);
const LIMIT = argOf('--limit', Infinity);
const PACE_MS = argOf('--pace-ms', 250);

/** The generic parent. Recorded as removed, but not worth restoring on its own. */
const GENERIC = 'source:internet';

/**
 * Pick the tag that carries the most attribution. `source:internet-homebuddy`
 * beats `source:internet`: when one candidate extends another, the longer one
 * is strictly more specific. Otherwise fall back to the longest.
 */
export function mostSpecific(tags) {
  const real = [...new Set(tags)].filter((t) => t && t !== GENERIC);
  if (real.length === 0) return null;
  return real.sort((a, b) => b.length - a.length)[0];
}

/**
 * Should this contact be repaired, given its CURRENT tags?
 * Pure, so the decision is testable without GHL.
 */
export function repairVerdict(currentTags) {
  if (!Array.isArray(currentTags)) return { repair: false, reason: 'unreadable' };
  const sourceTags = currentTags.filter((t) => typeof t === 'string' && t.startsWith('source:'));
  if (!sourceTags.includes('source:unknown')) {
    return { repair: false, reason: 'no_longer_unknown' };
  }
  if (sourceTags.some((t) => t !== 'source:unknown')) {
    return { repair: false, reason: 'already_has_specific' };
  }
  return { repair: true, reason: 'eligible' };
}

/** Walk the recorded events and build contact -> tag-to-restore. */
export function planFromEvents(rows) {
  const byContact = new Map();
  for (const row of rows || []) {
    const contactId = row.ghl_contact_id;
    if (!contactId) continue;
    let payload = row.payload;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { continue; }
    }
    for (const step of payload?.step_results || []) {
      const result = step?.result;
      if (result?.tag_applied !== 'source:unknown') continue;
      const removed = result.removed_conflicting || [];
      if (removed.length === 0) continue;
      const prior = byContact.get(contactId) || [];
      byContact.set(contactId, prior.concat(removed));
    }
  }
  const plan = [];
  for (const [contactId, removed] of byContact) {
    const tag = mostSpecific(removed);
    if (tag) plan.push({ contactId, tag, removed: [...new Set(removed)] });
  }
  return plan;
}

async function main(deps = {}) {
  const supabase = deps.supabase || supabaseDefault;
  const readContact = deps.readContact || ((id) => getContactCached(id, undefined, { maxWaitMs: 5000 }));
  const addTag = deps.addTag || executeAddTag;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  const since = new Date(Date.now() - DAYS * 86400000).toISOString();
  console.log(`[backfill] ${WRITE ? 'WRITE' : 'DRY RUN'} — events since ${since}`);

  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('system_events')
      .select('ghl_contact_id, payload')
      .eq('event_type', 'ghl.routing_tags_ensured')
      .gt('created_at', since)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`system_events read failed: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  console.log(`[backfill] scanned ${rows.length} routing-tag events`);

  const plan = planFromEvents(rows).slice(0, LIMIT);
  console.log(`[backfill] ${plan.length} contact(s) lost a specific vendor tag\n`);

  const tally = { restored: 0, would_restore: 0, no_longer_unknown: 0, already_has_specific: 0, unreadable: 0, failed: 0 };

  for (const { contactId, tag, removed } of plan) {
    let currentTags = null;
    try {
      currentTags = (await readContact(contactId))?.tags || [];
    } catch (err) {
      console.error(`  ✗ ${contactId} read failed: ${err.message}`);
      tally.unreadable++;
      continue;
    }

    const { repair, reason } = repairVerdict(currentTags);
    if (!repair) {
      tally[reason]++;
      console.log(`  – ${contactId} skip (${reason})`);
      continue;
    }

    if (!WRITE) {
      tally.would_restore++;
      console.log(`  → ${contactId} would restore ${tag}  (lost: ${removed.join(', ')})`);
      continue;
    }

    try {
      // With the fix deployed this is specific -> fallback: exclusivity removes
      // source:unknown and adds the vendor tag. No special-casing here.
      await addTag({ target_id: contactId, action_payload: { tag } });
      tally.restored++;
      console.log(`  ✓ ${contactId} restored ${tag}`);
    } catch (err) {
      tally.failed++;
      console.error(`  ✗ ${contactId} write failed: ${err.message}`);
    }
    await sleep(PACE_MS);
  }

  console.log(`\n[backfill] ${JSON.stringify(tally)}`);
  if (!WRITE) console.log('[backfill] dry run — re-run with --write to apply');
  return tally;
}

// Only run when invoked directly, so the helpers above stay importable by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

export { main };
