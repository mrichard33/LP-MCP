#!/usr/bin/env node
/**
 * Cleanup — duplicate S5.2 Appointment-Rescue enrollments
 * scripts/cleanup-duplicate-s52-enrollments.mjs
 *
 * Backfill remediation for the duplicate-enrollment incident: two views of one
 * cancellation (the LP disposition path and the GHL cancel webhook) both
 * enrolled contacts into the S5.2 v2 Appointment Rescue workflow, with nothing
 * deduping across them — 290 contacts enrolled >1× in 30 days (365 excess),
 * each a duplicate rescue message. Tasks 1 & 2 stop the bleeding going forward;
 * this cleans up the contacts already affected.
 *
 * DRY-RUN BY DEFAULT. Pass --execute to perform writes. --execute is
 * approval-gated: Mark runs the dry-run and approves before any --execute.
 *
 * Population (destination-UUID basis): contacts with >1 COMPLETED add_to_workflow
 * whose resolved target is S5.2 v2 (0a6a1349-...) in the last 30 days. Robust to
 * the LP path recording rule_applied='STATE_ENROLLMENT'.
 *
 * Per contact it reports: active stage:* tags, appt-status-adjacent tags, live
 * S5.2 enrollment (active-s5.2), LP disposition (best-effort), and whether a
 * live future appointment exists.
 *
 * Incoherence (flagged in BOTH modes):
 *   A) enrolled in S5.2 while a LIVE FUTURE appointment exists
 *   B) more than one stage:* tag
 *
 * --execute remediates ONLY (A): remove_from_workflow S5.2 + remove active-s5.2.
 * (B) is REPORT-ONLY — stage precedence is a registry-level semantic not defined
 * here and must not be inferred by an ad-hoc script; it is deferred to a separate
 * PR with an explicit precedence list.
 *
 * Writes run in bounded batches of 25 with a checkpoint pause after batch 1, and
 * pre-state is captured for every write to a JSON report file.
 *
 * Usage:
 *   node scripts/cleanup-duplicate-s52-enrollments.mjs            # dry-run
 *   node scripts/cleanup-duplicate-s52-enrollments.mjs --execute  # remediate (pauses after batch 1)
 *   node scripts/cleanup-duplicate-s52-enrollments.mjs --execute --no-pause  # skip the checkpoint (non-TTY)
 */

import fs from 'node:fs';
import readline from 'node:readline';
import supabase from '../src/supabase.js';
import { ghlFetch } from '../src/actions/helpers.js';
import { workflowIdentity } from '../src/services/enrollment-dedup.js';

// ── Config ───────────────────────────────────────────────────────────
const S52_WORKFLOW_ID = '0a6a1349-0b44-429b-91e1-4c5be264cd9f'; // locked S5.2 v2
const S52_CANONICAL = 'S5.2';
const S52_ACTIVE_TAG = 'active-s5.2';
const LOOKBACK_DAYS = 30;
const BATCH_SIZE = 25;
const PAGE_SIZE = 1000;
const LIVE_APPT_STATUSES = new Set(['new', 'confirmed']);

const EXECUTE = process.argv.includes('--execute');
const NO_PAUSE = process.argv.includes('--no-pause');

const S52_IDENTITIES = new Set([S52_WORKFLOW_ID, `code:${S52_CANONICAL}`]);
const isS52 = (payload) => S52_IDENTITIES.has(workflowIdentity(payload));

// ── Helpers ──────────────────────────────────────────────────────────
function confirm(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test((ans || '').trim()));
    });
  });
}

/** All completed S5.2 add_to_workflow actions in the lookback window, paginated. */
async function fetchS52Enrollments() {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('agent_actions')
      .select('id, target_id, action_payload, rule_applied, created_at')
      .eq('action_type', 'add_to_workflow')
      .eq('status', 'completed')
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`agent_actions read failed: ${error.message}`);
    const page = (data || []).filter((r) => isS52(r.action_payload));
    rows.push(...page);
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

/** Contacts with >1 completed S5.2 enrollment → Map(target_id → rows[]). */
function groupDuplicates(rows) {
  const byContact = new Map();
  for (const r of rows) {
    if (!r.target_id) continue;
    if (!byContact.has(r.target_id)) byContact.set(r.target_id, []);
    byContact.get(r.target_id).push(r);
  }
  return new Map([...byContact].filter(([, v]) => v.length > 1));
}

async function fetchContactState(contactId) {
  // Tags.
  let tags = null;
  try {
    const res = await ghlFetch('GET', `/contacts/${contactId}`);
    tags = res?.contact?.tags || [];
  } catch (err) {
    console.warn(`  ! tag read failed for ${contactId}: ${err.message}`);
  }
  // Appointments (raw; keep status + startTime to judge live-future).
  let appts = null;
  try {
    const data = await ghlFetch('GET', `/contacts/${contactId}/appointments`);
    const events = Array.isArray(data?.events) ? data.events
      : Array.isArray(data?.appointments) ? data.appointments : [];
    appts = events.map((e) => ({
      id: e.id || null,
      status: String(e.appointmentStatus || e.status || '').toLowerCase(),
      startTime: e.startTime || e.start_time || null,
    }));
  } catch (err) {
    console.warn(`  ! appointment read failed for ${contactId}: ${err.message}`);
  }
  // LP disposition — best-effort; schema varies, so failures are non-fatal.
  let lpDisposition = null;
  try {
    const { data } = await supabase
      .from('lp_leads')
      .select('disposition')
      .eq('ghl_contact_id', contactId)
      .limit(1)
      .maybeSingle();
    lpDisposition = data?.disposition ?? null;
  } catch { /* best-effort */ }

  const tagList = Array.isArray(tags) ? tags : [];
  const stageTags = tagList.filter((t) => /^stage:/i.test(String(t)));
  const apptTags = tagList.filter((t) => /^(appt-status|appointment)/i.test(String(t)));
  const enrolledS52 = tagList.some((t) => String(t).toLowerCase() === S52_ACTIVE_TAG);
  const now = Date.now();
  const liveFutureAppt = Array.isArray(appts) && appts.some((a) =>
    LIVE_APPT_STATUSES.has(a.status) && a.startTime && new Date(a.startTime).getTime() > now);

  return {
    tags: tagList, stageTags, apptTags, enrolledS52, lpDisposition,
    appointments: appts, liveFutureAppt,
    // Incoherence.
    incoherent_s52_with_live_appt: enrolledS52 && liveFutureAppt,
    incoherent_multi_stage: stageTags.length > 1,
  };
}

/** Remediation (A): remove from S5.2 + remove active-s5.2. Pre-state captured by caller. */
async function remediate(contactId) {
  await ghlFetch('DELETE', `/contacts/${contactId}/workflow/${S52_WORKFLOW_ID}`);
  await ghlFetch('DELETE', `/contacts/${contactId}/tags`, { tags: [S52_ACTIVE_TAG] });
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  if (!supabase) {
    console.error('No Supabase client (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY unset). Aborting.');
    process.exit(1);
  }
  console.log(`\n═══ Duplicate S5.2 enrollment cleanup — ${EXECUTE ? 'EXECUTE' : 'DRY-RUN'} ═══`);
  console.log(`Window: last ${LOOKBACK_DAYS} days · S5.2 workflow ${S52_WORKFLOW_ID}\n`);

  const rows = await fetchS52Enrollments();
  const dupes = groupDuplicates(rows);
  const excess = [...dupes.values()].reduce((n, v) => n + (v.length - 1), 0);
  console.log(`Total completed S5.2 enrollments (30d): ${rows.length}`);
  console.log(`Contacts enrolled >1× (baseline ~290): ${dupes.size}`);
  console.log(`Excess enrollments (baseline ~365): ${excess}\n`);

  // Gather state for each duplicate-enrolled contact.
  const report = [];
  let idx = 0;
  for (const [contactId, contactRows] of dupes) {
    idx += 1;
    const state = await fetchContactState(contactId);
    report.push({ contactId, enrollment_count: contactRows.length, ...state });
    const flags = [
      state.incoherent_s52_with_live_appt ? 'S5.2+LIVE_APPT' : null,
      state.incoherent_multi_stage ? `MULTI_STAGE(${state.stageTags.length})` : null,
    ].filter(Boolean);
    console.log(
      `[${idx}/${dupes.size}] ${contactId} · enrollments=${contactRows.length} · `
      + `stage=[${state.stageTags.join(',') || '-'}] · s5.2-active=${state.enrolledS52} · `
      + `live-appt=${state.liveFutureAppt} · disp=${state.lpDisposition ?? '?'}`
      + (flags.length ? ` · ⚠ ${flags.join(' ')}` : ''),
    );
  }

  const remediable = report.filter((r) => r.incoherent_s52_with_live_appt);
  const multiStageOnly = report.filter((r) => r.incoherent_multi_stage && !r.incoherent_s52_with_live_appt);
  console.log(`\n── Incoherent-state summary ──`);
  console.log(`Remediable (S5.2 while live future appointment): ${remediable.length}`);
  console.log(`Multi stage:* tags (REPORT-ONLY, deferred): ${multiStageOnly.length}`);

  // Persist the full pre-state report for audit (both modes).
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = `cleanup-s52-prestate-${stamp}.json`;
  fs.writeFileSync(reportPath, JSON.stringify({ mode: EXECUTE ? 'execute' : 'dry-run', generated_at: new Date().toISOString(), baseline: { contacts: dupes.size, excess }, remediable_count: remediable.length, report }, null, 2));
  console.log(`\nPre-state report written: ${reportPath}`);

  if (!EXECUTE) {
    console.log('\nDRY-RUN complete — no writes performed. Re-run with --execute (after approval) to remediate.\n');
    return;
  }
  if (remediable.length === 0) {
    console.log('\nNothing to remediate.\n');
    return;
  }

  // ── Execute: bounded batches of 25, checkpoint pause after batch 1 ──
  const batches = [];
  for (let i = 0; i < remediable.length; i += BATCH_SIZE) batches.push(remediable.slice(i, i + BATCH_SIZE));
  const writes = [];
  for (let b = 0; b < batches.length; b += 1) {
    console.log(`\n── Batch ${b + 1}/${batches.length} (${batches[b].length} contacts) ──`);
    for (const r of batches[b]) {
      const preState = { contactId: r.contactId, tags: r.tags, appointments: r.appointments, enrolledS52: r.enrolledS52, at: new Date().toISOString() };
      try {
        await remediate(r.contactId);
        writes.push({ ...preState, result: 'removed_from_s5.2' });
        console.log(`  ✓ ${r.contactId} removed from S5.2 + ${S52_ACTIVE_TAG} dropped`);
      } catch (err) {
        writes.push({ ...preState, result: 'error', error: err.message });
        console.warn(`  ✗ ${r.contactId} remediation failed: ${err.message}`);
      }
    }
    // Persist writes-so-far after each batch.
    fs.writeFileSync(`cleanup-s52-writes-${stamp}.json`, JSON.stringify(writes, null, 2));

    // Checkpoint pause after batch 1.
    if (b === 0 && batches.length > 1) {
      if (NO_PAUSE) {
        console.log('\n[checkpoint] Batch 1 done; --no-pause set → continuing.');
      } else {
        const go = await confirm(`\n[checkpoint] Batch 1 complete (${batches[0].length} contacts). Review the output above.\nContinue with the remaining ${remediable.length - batches[0].length} contacts? [y/N] `);
        if (!go) {
          console.log('Halting after batch 1 at operator request. Re-run with --execute --no-pause to finish, or --execute to resume with the checkpoint.\n');
          return;
        }
      }
    }
  }
  console.log(`\nEXECUTE complete — ${writes.filter((w) => w.result === 'removed_from_s5.2').length} remediated, writes log: cleanup-s52-writes-${stamp}.json\n`);
}

main().catch((err) => {
  console.error(`Fatal: ${err.stack || err.message}`);
  process.exit(1);
});
