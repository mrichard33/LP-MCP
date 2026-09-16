#!/usr/bin/env node
/**
 * One-off attribution repair — scripts/backfill-source-attribution.js
 *
 * 2026-09-16 (issue #949). `source:unknown` destroyed correct paid-vendor
 * attribution on ~2,389 contacts over 45 days — modernize, lead-gurus,
 * myhomepros, homebuddy, contractor-appointments, mvp-marketing, angi,
 * radio-simpletext and more.
 *
 * TWO producers did it, and this script must read BOTH:
 *   1. the routing-tags path — system_events ghl.routing_tags_ensured,
 *      step_results[].result.removed_conflicting  (~710 contacts);
 *   2. the ENTRY_HYGIENE_AT_CREATION_* rules — agent_actions rows running
 *      remove_tag {prefix: "source:"}             (~1,705 contacts).
 *
 * The first version of this script read only (1), because (2) was not yet
 * known to exist. A --write run would have repaired under a third of the
 * damage and reported success. Both readers are now wired in; do not remove
 * either.
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

import { pathToFileURL } from 'node:url';

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

/**
 * Tags that are recorded as removed but carry no vendor attribution, so
 * restoring one is pointless at best.
 *
 *   source:internet  the generic parent — true of thousands of leads, names
 *                    no vendor.
 *   source:unknown   the FALLBACK itself. It shows up in the removal record
 *                    whenever a later actor cleared it — e.g. contact
 *                    RuUeUK82fcV5MYv4q5AU, where the routing-tags path wrote
 *                    source:unknown and the hygiene rule then wiped it. Without
 *                    this entry the script would "restore" the very tag this
 *                    whole exercise exists to stop writing. Caught by checking
 *                    the planner against real rows, not by the unit tests.
 */
/**
 * Credentials this script cannot run without. SUPABASE_* reach the LP database;
 * GHL_API_KEY is used for the live per-contact read and the restore write.
 */
export const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GHL_API_KEY'];

const NON_RESTORABLE = new Set(['source:internet', 'source:unknown']);

/**
 * Pick the tag that carries the most attribution. `source:internet-homebuddy`
 * beats `source:internet`: when one candidate extends another, the longer one
 * is strictly more specific. Otherwise fall back to the longest.
 */
export function mostSpecific(tags) {
  const real = [...new Set(tags)].filter((t) => t && !NON_RESTORABLE.has(t));
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

/** Parse a jsonb column that may arrive as an object or as text. */
function asJson(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

/**
 * Losses recorded by the ROUTING-TAGS path — system_events
 * ghl.routing_tags_ensured, step_results[].result.removed_conflicting.
 * Returns [contactId, removedTag] pairs.
 */
export function lossesFromEvents(rows) {
  const out = [];
  for (const row of rows || []) {
    const contactId = row.ghl_contact_id;
    if (!contactId) continue;
    const payload = asJson(row.payload);
    for (const step of payload?.step_results || []) {
      const result = step?.result;
      if (result?.tag_applied !== 'source:unknown') continue;
      for (const tag of result.removed_conflicting || []) out.push([contactId, tag]);
    }
  }
  return out;
}

/**
 * Losses recorded by the AGENT-RULE path — agent_actions rows where
 * ENTRY_HYGIENE_AT_CREATION_* ran `remove_tag {prefix: "source:"}`.
 *
 * 2026-09-16 — this reader did not exist in the first version of the script,
 * and its absence was the whole defect: the rules turned out to be the LARGER
 * producer (1,705 contacts vs 710 via routing-tags, 2,349 in union), so a
 * --write run would have repaired 30% and looked finished. The dry run caught
 * it only because the totals were compared against the measurement query.
 *
 * executeRemoveTag reports a single removal as `tag_removed` (string) and a
 * batch as `tags` (array) — both shapes occur in the real data.
 */
export function lossesFromActions(rows) {
  const out = [];
  for (const row of rows || []) {
    const contactId = row.target_id;
    if (!contactId) continue;
    const result = asJson(row.execution_result);
    if (!result) continue;
    const removed = Array.isArray(result.tags)
      ? result.tags
      : (result.tag_removed ? [result.tag_removed] : []);
    for (const tag of removed) {
      if (typeof tag === 'string' && tag.startsWith('source:')) out.push([contactId, tag]);
    }
  }
  return out;
}

/**
 * Fold every recorded loss into one entry per contact, carrying the single
 * most specific tag. Both producers are merged BEFORE choosing, so a contact
 * hit by each does not get two plan rows or the weaker of the two tags.
 */
export function buildPlan(...lossLists) {
  const byContact = new Map();
  for (const list of lossLists) {
    for (const [contactId, tag] of list || []) {
      const prior = byContact.get(contactId) || [];
      prior.push(tag);
      byContact.set(contactId, prior);
    }
  }
  const plan = [];
  for (const [contactId, removed] of byContact) {
    const tag = mostSpecific(removed);
    if (tag) plan.push({ contactId, tag, removed: [...new Set(removed)] });
  }
  return plan;
}

/** The three rules whose source: wipe destroyed attribution (issue #949). */
export const WIPE_RULES = [
  'ENTRY_HYGIENE_AT_CREATION_OTHER',
  'ENTRY_HYGIENE_AT_CREATION_FALLBACK',
  'ENTRY_HYGIENE_AT_CREATION_UNKNOWN',
];

async function main(deps = {}) {
  const supabase = deps.supabase || supabaseDefault;
  const readContact = deps.readContact || ((id) => getContactCached(id, undefined, { maxWaitMs: 5000 }));
  const addTag = deps.addTag || executeAddTag;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  // Preflight. Nothing in the import chain loads dotenv, so these must come from
  // the shell. Without it a missing variable surfaces as
  // "TypeError: Cannot read properties of null (reading 'from')" several frames
  // deep, which tells the operator nothing about what to set.
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`[backfill] missing required environment variable(s): ${missing.join(', ')}`);
    console.error('[backfill] these are NOT read from a .env file — set them in the shell, or run via `railway run`.');
    throw new Error(`missing env: ${missing.join(', ')}`);
  }

  const since = new Date(Date.now() - DAYS * 86400000).toISOString();
  console.log(`[backfill] ${WRITE ? 'WRITE' : 'DRY RUN'} — events since ${since} (--days ${DAYS})`);

  // Page through a table, since Supabase caps a single response.
  const PAGE = 1000;
  async function fetchAll(label, build) {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await build().range(from, from + PAGE - 1);
      if (error) throw new Error(`${label} read failed: ${error.message}`);
      rows.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
    return rows;
  }

  // BOTH producers. The routing-tags path and the ENTRY_HYGIENE_AT_CREATION_*
  // rules each destroyed attribution, and the rules were the larger of the two
  // — reading only the first covers about 30% of the damage.
  const eventRows = await fetchAll('system_events', () => supabase
    .from('system_events')
    .select('ghl_contact_id, payload')
    .eq('event_type', 'ghl.routing_tags_ensured')
    .gt('created_at', since));

  const actionRows = await fetchAll('agent_actions', () => supabase
    .from('agent_actions')
    .select('target_id, execution_result')
    .eq('action_type', 'remove_tag')
    .in('rule_applied', WIPE_RULES)
    .gt('created_at', since));

  const fromEvents = lossesFromEvents(eventRows);
  const fromActions = lossesFromActions(actionRows);
  console.log(
    `[backfill] scanned ${eventRows.length} routing-tag events (${fromEvents.length} losses) ` +
    `and ${actionRows.length} rule remove_tag actions (${fromActions.length} losses)`
  );

  const plan = buildPlan(fromEvents, fromActions).slice(0, LIMIT);
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
//
// 2026-09-16 — pathToFileURL, NOT `file://${process.argv[1]}`. On Windows argv[1]
// is a backslash path, so the string form produces
//   file://C:\Users\mark\LP-MCP\scripts\backfill-source-attribution.js
// against an import.meta.url of
//   file:///C:/Users/mark/LP-MCP/scripts/backfill-source-attribution.js
// which never matches — main() silently never runs and the process exits 0 with
// no output, indistinguishable from a clean run that found nothing. That is the
// worst failure mode a repair script can have. It matched on Linux, which is why
// it survived review. pathToFileURL is in Node core and handles drive letters,
// backslashes and spaces (a repo path with a space broke the old form too).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

export { main };
