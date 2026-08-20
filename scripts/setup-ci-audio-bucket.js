#!/usr/bin/env node
/**
 * Setup ci-audio Storage bucket — scripts/setup-ci-audio-bucket.js
 *
 * One-shot creation of the PRIVATE Supabase Storage bucket that holds Call
 * Intelligence audio between recording fetch and post-transcription purge
 * (CI_AUDIO_RETENTION_DAYS). Private, service-role only — recordings must
 * never be publicly reachable. Bucket creation is deliberately not part of
 * sql/061 (Storage is not SQL); this script is the setup step named in that
 * file's AFTER RUNNING note.
 *
 * Usage:
 *   node scripts/setup-ci-audio-bucket.js             # dry-run: report only
 *   node scripts/setup-ci-audio-bucket.js --execute   # actually create
 *
 * Pre-conditions:
 *   - SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set (LP MCP instance)
 *
 * Idempotency: checks getBucket('ci-audio') first. If the bucket already
 * exists and is private, reports and exits 0. If it exists but is PUBLIC,
 * exits 1 loudly — fixing visibility is a deliberate dashboard action, not
 * something this script mutates. Safe to re-run.
 */

import supabase from '../src/supabase.js';

// The bucket name is a code constant, matching the 'lp-reports' precedent
// (src/jobs/lp-csv-ingest.js) — an env-var bucket name would let one typo
// silently split audio across two buckets. PR 2's recordings.js imports this.
export const CI_AUDIO_BUCKET = 'ci-audio';

const EXECUTE = process.argv.includes('--execute');

async function main() {
  if (!supabase) {
    console.error('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing).');
    process.exit(1);
  }

  const { data: existing, error: getErr } = await supabase.storage.getBucket(CI_AUDIO_BUCKET);
  if (existing) {
    if (existing.public) {
      console.error(`Bucket '${CI_AUDIO_BUCKET}' EXISTS BUT IS PUBLIC — call recordings must never be publicly reachable.`);
      console.error('Fix visibility in the Supabase dashboard (Storage → ci-audio → make private). This script will not mutate an existing bucket.');
      process.exit(1);
    }
    console.log(`Bucket '${CI_AUDIO_BUCKET}' already exists and is private. Nothing to do.`);
    return;
  }
  // getBucket errors with "not found" when absent; any other error is real.
  if (getErr && !/not.*found/i.test(getErr.message || '')) {
    console.error(`getBucket('${CI_AUDIO_BUCKET}') failed:`, getErr.message);
    process.exit(1);
  }

  if (!EXECUTE) {
    console.log(`DRY-RUN: would create PRIVATE bucket '${CI_AUDIO_BUCKET}' (public: false, service-role access only).`);
    console.log('Re-run with --execute to create it.');
    return;
  }

  const { error: createErr } = await supabase.storage.createBucket(CI_AUDIO_BUCKET, { public: false });
  if (createErr) {
    console.error(`createBucket('${CI_AUDIO_BUCKET}') failed:`, createErr.message);
    process.exit(1);
  }

  // Verify what was actually created — a bucket that came back public would
  // mean recordings are one signed-URL mistake from exposure.
  const { data: verify, error: verifyErr } = await supabase.storage.getBucket(CI_AUDIO_BUCKET);
  if (verifyErr || !verify) {
    console.error(`Created but could not verify bucket '${CI_AUDIO_BUCKET}':`, verifyErr?.message || 'no bucket returned');
    process.exit(1);
  }
  if (verify.public) {
    console.error(`Bucket '${CI_AUDIO_BUCKET}' was created PUBLIC — make it private in the dashboard immediately.`);
    process.exit(1);
  }
  console.log(`Created private bucket '${CI_AUDIO_BUCKET}'. Verified public=false.`);
}

// Only run as a script — PR 2's recordings.js imports CI_AUDIO_BUCKET.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('setup-ci-audio-bucket failed:', err.message);
    process.exit(1);
  });
}
