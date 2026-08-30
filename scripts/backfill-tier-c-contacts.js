#!/usr/bin/env node
/**
 * TIER C — create GHL contacts for the 2026-08-13..19 stranded leads.
 * scripts/backfill-tier-c-contacts.js
 *
 * Usage:
 *   node scripts/backfill-tier-c-contacts.js                  # DRY RUN (default)
 *   node scripts/backfill-tier-c-contacts.js --execute        # WRITES TO GHL
 *   node scripts/backfill-tier-c-contacts.js --limit=25       # small live pilot
 *   node scripts/backfill-tier-c-contacts.js --since=2026-08-13 --until=2026-08-20
 *
 * Writing is OPT-IN. This is the only tier that writes to GHL, and a contact
 * created in error can text a real homeowner about an inquiry they made weeks
 * ago. `--execute` is deliberately not the default and there is no short flag.
 *
 * ─── This is a thin driver, not a new creation job ──────────────────────────
 * All the work is done by runLpIntakeBackstop in
 * src/services/lp-contact-backstop.js, which already implements exactly this
 * operation and has been in production since 2026-07-26:
 *
 *   - searches GHL by phone FIRST and links on a hit, creating only on a miss
 *     (~10-15 of this cohort already have a contact — those are links, not
 *     creates, and must not be duplicated);
 *   - sets tags INLINE in the POST /contacts/ body, which is the only way a
 *     tag lands before the contact_created trigger fires;
 *   - recovers from GHL's server-side dedupe (400) by re-searching and linking;
 *   - dedupes by normalized phone within the run (16 in-cohort dupes);
 *   - stamps the LP lead/prospect id custom fields and writes lp_leads.
 *
 * Writing a second creation path would duplicate all of that and diverge from
 * it. This script only chooses the window, the posture, and the pacing.
 *
 * ─── Why this cohort cannot get a speed-to-lead text ────────────────────────
 * Two independent guards, either sufficient (shouldSuppressOutbound):
 *
 *   1. `suppressOutbound: true` below — the documented BACKLOG posture: backlog
 *      leads land suppressed for rep review (owner decision, 2026-07-26).
 *   2. The freshness belt: every lead in this window is 11-17 days old, far
 *      past DEFAULT_INTAKE_FRESH_HOURS (24), so each one suppresses on age
 *      alone with reason `stale_NNNh` even if the posture were dropped.
 *
 * Suppression applies ONLY on create. A matched EXISTING contact is never given
 * `suppress-outbound` — it may be mid-conversation, and silencing a live thread
 * to fix an attribution gap is not a trade this makes.
 *
 * Verified 2026-08-29 — of every tag this run applies (`lp-backstop-created`,
 * `lp-linked`, `stage:new-lead`, `entry:*`, `active-entry:*`, `source:*`,
 * `suppress-outbound`), exactly ONE published GHL workflow triggers on any of
 * them: **U.STG Stage Normalizer** on `stage:new-lead`. Its 169 actions are
 * only if_else / remove_contact_tag / goto — pure stage-tag hygiene, no
 * messaging, no add_to_workflow, no webhook. So the tags are inert here.
 *
 * ─── WHAT IS NOT HANDLED HERE — READ BEFORE --execute ───────────────────────
 * The two UNCONDITIONAL `contact_created` workflows must be suppressed in the
 * GHL UI first. They fire on contact creation regardless of tags, so no code in
 * this repo can stop them:
 *
 *   I.AC All Contacts Created  (fba00be6-88c9-423b-8db7-ccaa53705180)
 *     43 actions: webhook "Send Data to Agentic System", "Add to Workflow: Zip
 *     Code Provided", Notion create/update, two AI extraction steps, and
 *     "Add Tag: contact:delete" on its no-email branch.
 *   I.C-NN Contact Normalizer  (7413fff9-b1b1-48c5-bb23-b65385db6f09)
 *     webhook "Trigger Contact Created n8n", drip 100/15min, and
 *     "Add Tags: no-contact-method, contact:delete" on timeout.
 *
 * See docs/ghl-link-backfill-tiers.md. Mark applies those; this script cannot.
 *
 * ─── Pacing ─────────────────────────────────────────────────────────────────
 * Every GHL call goes through the shared token bucket in
 * src/ghl-rate-limiter.js, whose default GHL_RATE_REFILL_PER_MIN=40 is already
 * stricter than the brief's 50/min ceiling. ~1,100 contacts ≈ 28 minutes. Do
 * not raise the limit for this run.
 */

import { pathToFileURL } from 'node:url';
import {
  runLpIntakeBackstop,
  DEFAULT_INTAKE_FRESH_HOURS,
  MAX_INTAKE_LOOKBACK_HOURS,
} from '../src/services/lp-contact-backstop.js';

// The briefed window. Deliberately hard-coded as the default: "DO NOT create
// contacts for anything older without a separate explicit decision from Mark."
export const TIER_C_SINCE = '2026-08-13';
export const TIER_C_UNTIL = '2026-08-20'; // exclusive

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const strArg = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const numArg = (n, d) => {
  const v = parseInt(strArg(n, ''), 10);
  return Number.isFinite(v) && v >= 0 ? v : d;
};

/**
 * Convert an absolute window start into the lookbackHours the intake scan
 * takes, rounding UP so the boundary day is fully included. Exported for test.
 */
export function lookbackHoursFor(sinceIso, nowMs = Date.now()) {
  const t = Date.parse(sinceIso);
  if (!Number.isFinite(t)) throw new Error(`--since is not a valid date: ${sinceIso}`);
  const hours = Math.ceil((nowMs - t) / 3600000);
  if (hours <= 0) throw new Error(`--since is in the future: ${sinceIso}`);
  if (hours > MAX_INTAKE_LOOKBACK_HOURS) {
    throw new Error(
      `--since=${sinceIso} needs a ${hours}h lookback but the scan ceiling is `
      + `${MAX_INTAKE_LOOKBACK_HOURS}h. Widening that ceiling for a backfill is a `
      + `separate decision — it is what stops a backlog run reaching into 2024.`,
    );
  }
  return hours;
}

async function main() {
  const execute = has('execute');
  const since = strArg('since', TIER_C_SINCE);
  const until = strArg('until', TIER_C_UNTIL);
  const limit = numArg('limit', 0);
  const maxPerRun = numArg('max-per-run', 2000);

  const lookbackHours = lookbackHoursFor(since);

  console.log('─'.repeat(74));
  console.log(`TIER C — GHL contact creation   [${execute ? 'LIVE — WRITES TO GHL' : 'DRY RUN'}]`);
  console.log('─'.repeat(74));
  console.log(`  window        : ${since} .. ${until} (exclusive)`);
  console.log(`  lookback      : ${lookbackHours}h  (ceiling ${MAX_INTAKE_LOOKBACK_HOURS}h)`);
  console.log(`  posture       : suppressOutbound=true (backlog)`);
  console.log(`  fresh belt    : ${DEFAULT_INTAKE_FRESH_HOURS}h — every lead here is far past it`);
  console.log(`  cap           : maxPerRun=${maxPerRun}${limit ? `, limit=${limit}` : ''}`);

  if (execute) {
    console.log('\n  !! LIVE. Confirm I.AC and I.C-NN are suppressed in the GHL UI first.');
    console.log('     They fire on contact creation regardless of tags; nothing here stops them.\n');
  }

  const summary = await runLpIntakeBackstop({
    dryRun: !execute,
    lookbackHours,
    untilIso: new Date(until).toISOString(),
    maxPerRun,
    limit,
    // Belt AND braces: the age belt would suppress this cohort anyway, but the
    // posture makes the intent explicit and survives a re-run against a window
    // that has since become "fresh".
    suppressOutbound: true,
    freshHours: DEFAULT_INTAKE_FRESH_HOURS,
  });

  console.log('\nResult:');
  console.log(`  scanned rows      : ${summary.scanned_rows}`);
  console.log(`  eligible          : ${summary.eligible}`);
  console.log(`  processed         : ${summary.processed}`);
  console.log(`  suppressed        : ${summary.suppressed}`);
  console.log(`  deferred (capped) : ${summary.deferred_capped}`);
  console.log(`  counts            : ${JSON.stringify(summary.counts)}`);
  console.log(`  errors            : ${summary.error_count} (rate ${(summary.error_rate * 100).toFixed(1)}%)`);

  if (summary.error_count > 0) {
    console.log('\n  error sample:');
    for (const e of summary.error_sample) console.log(`    ${JSON.stringify(e)}`);
  }

  // The invariant that matters: nothing may be created un-suppressed. A CREATE
  // that is not suppressed is a contact eligible for outbound — exactly what
  // this tier must never produce.
  const created = Number(summary.counts?.created || 0);
  if (created > 0 && Number(summary.suppressed) < created) {
    console.error(
      `\n  FAIL: ${created} created but only ${summary.suppressed} suppressed. `
      + 'Every CREATE in this window must be suppressed — investigate before re-running.',
    );
    process.exitCode = 1;
  } else {
    console.log(`\n  PASS: every create suppressed (${summary.suppressed} suppressed / ${created} created)`);
  }

  console.log(execute
    ? '\nLive run complete. Now: spot-check contacts in GHL, confirm no speed-to-lead\nenrolment, then re-run scripts/backfill-ghl-link-propagate.js to push the new\nlinks down to jobs/milestones.'
    : '\nDry run — nothing written. Re-run with --execute once I.AC and I.C-NN are suppressed.');
}

const isEntryPoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
}
