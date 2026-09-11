#!/usr/bin/env node
/**
 * Strip stale enrollment tags — scripts/backfill-stale-active-tags.mjs
 *
 * Cleans up after the remove_from_workflow bug fixed in
 * src/actions/handlers/workflows.js v2.1 (2026-09-11): every agentic removal
 * issued DELETE /contacts/{id}/workflow/{wfId} and left the
 * active-<canonical_code> tag behind. The contact is out of the workflow, still
 * labeled as in it, and blocked from re-entry by the v2.0 add_to_workflow
 * idempotency guard, which reads exactly that tag.
 *
 * Reference case: Alfredo Fontan (GHL VKMKhd8JQ4wsp3zMn8Lt) removed from E.2 by
 * actions 447848 / 447879 / 447891 on 2026-09-11, still carrying active-e.2.
 * Rule 305 removed 30 contacts from E.2 and S2.1 since 2026-06-25.
 *
 * ════════════════════════════════════════════════════════════════════
 * RUN THE CODE FIX FIRST. If the v2.1 handler is not deployed, this sweep
 * strips tags that the next agentic removal will immediately plant again.
 * ════════════════════════════════════════════════════════════════════
 *
 * WHAT IT DOES
 *   For each canonical code in scope (default E.2 and S2.1 — the codes rule 305
 *   removed):
 *     1. Reads LP agent_actions for every COMPLETED remove_from_workflow that
 *        targeted that workflow.
 *     2. Drops any contact whose most recent COMPLETED add_to_workflow for the
 *        same workflow is NEWER than the removal — they were legitimately put
 *        back and the tag is correct.
 *     3. Drops any contact with an HL workflow_executions row for that workflow
 *        started after the removal (a second, independent re-entry signal).
 *     4. Reads the contact LIVE from GHL and drops it if the active-<code> tag
 *        is no longer there.
 *     5. Removes the tag with DELETE /contacts/{id}/tags (additive contract —
 *        never PUT, which wipes the whole tag array) and mirrors the removal
 *        into contact_tag_snapshot so suppression reads converge immediately.
 *
 * THE ENROLLMENT CROSS-CHECK, HONESTLY
 *   The GHL v2 API exposes no "which workflows is this contact in" read, so
 *   there is no such thing as a direct live-enrollment check. Steps 2-4 are the
 *   substitute: the LP action ledger is the authority for every agentic
 *   enrollment and removal (it is the only thing that writes these tags), HL's
 *   execution log is a second opinion, and the live GHL tag read makes the
 *   strip a no-op for anyone already clean. A contact is only touched when the
 *   newest recorded event for that workflow is a REMOVAL. Anything ambiguous is
 *   skipped and printed, never stripped.
 *
 * USAGE
 *   node scripts/backfill-stale-active-tags.mjs                  # DRY RUN (default)
 *   node scripts/backfill-stale-active-tags.mjs --codes E.2,S2.1,S4.1
 *   node scripts/backfill-stale-active-tags.mjs --since 2026-06-25
 *   node scripts/backfill-stale-active-tags.mjs --limit 10
 *   node scripts/backfill-stale-active-tags.mjs --execute        # after review
 *
 * ENV (already set on the LP MCP service)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY        — LP action ledger + snapshot
 *   HL_SUPABASE_URL, HL_SUPABASE_SERVICE_ROLE_KEY  — workflow_registry lookups
 *   GHL_API_KEY                                    — live contact read + tag DELETE
 *
 * v1.0 — 2026-09-11 (remove_from_workflow enrollment-tag remediation).
 */

import lpSupabase from '../src/supabase.js';
import { ghlFetch } from '../src/actions/helpers.js';
import { applyTagsToSnapshot } from '../src/services/tag-snapshot.js';
import { resolveWorkflowIdByCanonicalCode, hlRunSQL, esc } from '../src/tools/admin/hl-fallback.js';

// ─── args ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
function opt(name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
// Default scope: exactly the codes rule 305 removed. --codes widens it.
const CODES = opt('--codes', 'E.2,S2.1').split(',').map((c) => c.trim()).filter(Boolean);
const SINCE = opt('--since', '2026-06-25');
const LIMIT = opt('--limit') ? parseInt(opt('--limit'), 10) : null;

const activeTagFor = (code) => `active-${String(code).trim().toLowerCase()}`;

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

// ─── LP ledger reads ──────────────────────────────────────────────

/**
 * Every COMPLETED action of `type` that targeted `workflowId`, newest first.
 * Matching on the payload's workflow_id is what makes this work for rule 305,
 * whose payloads carry a UUID and no canonical_code.
 */
async function ledgerActions(type, workflowId, code) {
  const { data, error } = await lpSupabase
    .from('agent_actions')
    .select('id, target_id, executed_at, created_at, rule_applied, action_payload')
    .eq('action_type', type)
    .eq('status', 'completed')
    .gte('created_at', `${SINCE}T00:00:00Z`)
    .or(`action_payload->>workflow_id.eq.${workflowId},action_payload->>canonical_code.eq.${code}`)
    .order('created_at', { ascending: false })
    .limit(5000);
  if (error) throw new Error(`agent_actions read failed (${type}): ${error.message}`);
  return data || [];
}

/** HL execution log: latest start for this contact + workflow, or null. */
async function lastExecutionStart(contactId, workflowId) {
  try {
    const rows = await hlRunSQL(
      `SELECT started_at FROM workflow_executions ` +
      `WHERE ghl_contact_id = '${esc(contactId)}' AND ghl_workflow_id = '${esc(workflowId)}' ` +
      `ORDER BY started_at DESC LIMIT 1`,
    );
    const started = Array.isArray(rows) ? rows[0]?.started_at : rows?.started_at;
    return started ? Date.parse(started) : null;
  } catch (err) {
    // Second opinion only. Unreadable → treated as "no re-entry signal"; the
    // LP ledger and the live GHL tag read still gate the strip.
    console.warn(`   ⚠️  HL execution lookup failed for ${contactId}: ${err.message}`);
    return null;
  }
}

// ─── per-code sweep ───────────────────────────────────────────────

async function sweepCode(code) {
  const tag = activeTagFor(code);
  const workflowId = await resolveWorkflowIdByCanonicalCode(code);
  if (!workflowId) {
    console.log(`\n⏭️  ${code}: no workflow_id in the HL registry — skipping.`);
    return { stripped: [], skipped: [] };
  }

  console.log(`\n━━━ ${code} → ${workflowId}  (tag: ${tag}) ━━━`);

  const removals = await ledgerActions('remove_from_workflow', workflowId, code);
  const additions = await ledgerActions('add_to_workflow', workflowId, code);

  // Newest removal and newest addition per contact.
  const newestBy = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const ms = Date.parse(r.executed_at || r.created_at);
      if (!Number.isFinite(ms)) continue;
      const prev = m.get(r.target_id);
      if (!prev || ms > prev.ms) m.set(r.target_id, { ms, row: r });
    }
    return m;
  };
  const lastRemoval = newestBy(removals);
  const lastAddition = newestBy(additions);

  console.log(`   ${removals.length} completed removals across ${lastRemoval.size} contacts since ${SINCE}`);

  const stripped = [];
  const skipped = [];
  let processed = 0;

  for (const [contactId, { ms: removedMs, row }] of lastRemoval) {
    if (LIMIT && processed >= LIMIT) break;
    processed++;

    // 2. Re-enrolled through the agentic layer after the removal?
    const added = lastAddition.get(contactId);
    if (added && added.ms > removedMs) {
      skipped.push({ contactId, reason: 'add_to_workflow after removal' });
      continue;
    }

    // 3. Independent re-entry signal from HL's execution log.
    const execMs = await lastExecutionStart(contactId, workflowId);
    if (execMs && execMs > removedMs) {
      skipped.push({ contactId, reason: 'workflow execution started after removal' });
      continue;
    }

    // 4. Live GHL read — is the stale tag actually still there?
    let contact;
    try {
      contact = await ghlFetch('GET', `/contacts/${contactId}`);
    } catch (err) {
      skipped.push({ contactId, reason: `GHL read failed: ${err.message}` });
      continue;
    }
    const c = contact?.contact || contact || {};
    const tags = c.tags || [];
    if (!tags.includes(tag)) {
      skipped.push({ contactId, reason: 'tag already gone' });
      continue;
    }

    const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.contactName || '(no name)';
    const removedAt = new Date(removedMs).toISOString();
    console.log(
      `   ${EXECUTE ? '🏷️ ' : '🔍'} ${contactId}  ${name.padEnd(28)}  ${tag}  ` +
      `removed ${removedAt} (action ${row.id}, rule ${row.rule_applied || '?'})`,
    );

    if (EXECUTE) {
      try {
        // Additive contract: explicit-tag DELETE only. NEVER PUT — GHL treats
        // PUT as a full-array replace and wipes every other tag.
        await ghlFetch('DELETE', `/contacts/${contactId}/tags`, { tags: [tag] });
        await applyTagsToSnapshot(contactId, { remove: [tag] });
      } catch (err) {
        skipped.push({ contactId, reason: `strip failed: ${err.message}` });
        console.error(`      ❌ strip failed: ${err.message}`);
        continue;
      }
    }
    stripped.push({ contactId, name, tag, removedAt, actionId: row.id });
  }

  console.log(`   → ${stripped.length} ${EXECUTE ? 'stripped' : 'would be stripped'}, ${skipped.length} skipped`);
  for (const s of skipped) console.log(`      · ${s.contactId}: ${s.reason}`);
  return { stripped, skipped };
}

// ─── main ─────────────────────────────────────────────────────────

async function main() {
  if (!lpSupabase) fail('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  if (!process.env.GHL_API_KEY) fail('Set GHL_API_KEY.');
  if (!process.env.HL_SUPABASE_URL || !process.env.HL_SUPABASE_SERVICE_ROLE_KEY) {
    fail('Set HL_SUPABASE_URL and HL_SUPABASE_SERVICE_ROLE_KEY (workflow_registry lookups).');
  }

  console.log(EXECUTE ? '⚠️  EXECUTE MODE — tags will be removed in GHL' : '🔍 DRY RUN — nothing will be changed');
  console.log(`   codes: ${CODES.join(', ')}   since: ${SINCE}${LIMIT ? `   limit: ${LIMIT}/code` : ''}`);

  let total = 0;
  for (const code of CODES) {
    const { stripped } = await sweepCode(code);
    total += stripped.length;
  }

  console.log(`\n═══ ${total} contact${total === 1 ? '' : 's'} ${EXECUTE ? 'stripped' : 'would be stripped'} ═══`);
  if (!EXECUTE && total > 0) {
    console.log('Review the list above, then re-run with --execute.');
  }
}

main().catch((err) => fail(err.stack || err.message));
