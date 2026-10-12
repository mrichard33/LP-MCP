#!/usr/bin/env node
/**
 * Setup the marketing Storage buckets — scripts/setup-marketing-buckets.js
 *
 * Two PRIVATE Supabase Storage buckets for the marketing cost ledger (sql/158):
 *   marketing-invoices  the original invoice files, <yyyy>/<mm>/<sha>.<ext>
 *   marketing-reports   the Brad-format XLSX files, <yyyy-mm>/<market>.xlsx
 * Both are read through 7-day signed URLs only. Same shape and the same LP-
 * instance guard as scripts/setup-ci-audio-bucket.js (the 2026-08-20 incident:
 * a bucket created in the wrong instance).
 *
 * Usage:
 *   node scripts/setup-marketing-buckets.js             # dry-run: report only
 *   node scripts/setup-marketing-buckets.js --execute   # create what is missing
 */

import supabase from '../src/supabase.js';

export const MARKETING_INVOICES_BUCKET = 'marketing-invoices';
export const MARKETING_REPORTS_BUCKET = 'marketing-reports';

const EXECUTE = process.argv.includes('--execute');

async function assertLpInstance() {
  const host = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).host : '(unset)';
  const { error } = await supabase.from('lp_leads').select('id').limit(1);
  if (error) {
    console.error(`Refusing to proceed: SUPABASE_URL points at ${host}, which does not look like the LP MCP instance (lp_leads: ${error.message}).`);
    process.exit(1);
  }
  console.log(`Target instance OK (${host}, lp_leads reachable).`);
}

/** Create one private bucket if missing. Never mutates an existing one. Returns true when it is usable. */
export async function ensurePrivateBucket(name, { client = supabase, execute = EXECUTE, log = console.log } = {}) {
  const { data: existing, error: getErr } = await client.storage.getBucket(name);
  if (existing) {
    if (existing.public) {
      console.error(`Bucket '${name}' EXISTS BUT IS PUBLIC — invoices must never be publicly reachable. Make it private in the dashboard.`);
      return false;
    }
    log(`Bucket '${name}' already exists and is private.`);
    return true;
  }
  if (getErr && !/not.*found/i.test(getErr.message || '')) {
    console.error(`getBucket('${name}') failed:`, getErr.message);
    return false;
  }
  if (!execute) {
    log(`DRY-RUN: would create PRIVATE bucket '${name}'. Re-run with --execute.`);
    return false;
  }
  const { error: createErr } = await client.storage.createBucket(name, { public: false });
  if (createErr) {
    console.error(`createBucket('${name}') failed:`, createErr.message);
    return false;
  }
  const { data: verify } = await client.storage.getBucket(name);
  if (!verify || verify.public) {
    console.error(`Bucket '${name}' was created but reads as ${verify ? 'PUBLIC' : 'missing'} — fix in the dashboard now.`);
    return false;
  }
  log(`Created private bucket '${name}'. Verified public=false.`);
  return true;
}

async function main() {
  if (!supabase) {
    console.error('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing).');
    process.exit(1);
  }
  await assertLpInstance();
  let ok = true;
  for (const name of [MARKETING_INVOICES_BUCKET, MARKETING_REPORTS_BUCKET]) {
    ok = (await ensurePrivateBucket(name)) && ok;
  }
  if (!ok && EXECUTE) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('setup-marketing-buckets failed:', err.message);
    process.exit(1);
  });
}
