#!/usr/bin/env node
/**
 * Bulk remediation — pull pre-dispositioned LP-inbound leads out of cold
 * indoctrination.  scripts/remediate-indoctrination-decontam.mjs
 *
 * ════════════════════════════════════════════════════════════════════
 * STAGED — DO NOT RUN until the full fix is live:
 *   1. Change 1 deployed (synthetic lp.disposition_changed backfill in
 *      src/sync-leads.js) so lp_leads.disposition_code is reliably populated.
 *   2. Change 2 rule BACKSTOP_E0_OTHER_BOOKED_LEAD validated and flipped to
 *      requires_approval=false (so re-contamination is auto-corrected and this
 *      one-time sweep won't be undone by fresh inbound).
 *   3. Change 3 applied by Mark: the E.0 Master Router "other → E.5" branch
 *      excludes appointment-stage leads (the GHL-native source guard).
 * Running before 1–3 are live risks contacts being re-contaminated on their
 * next inbound/sync pass.
 * ════════════════════════════════════════════════════════════════════
 *
 * WHAT IT DOES
 *   Detects contacts carrying stage:indoctrination / active-s2.2 whose
 *   canonical LP disposition (or appointment status) says they are actually
 *   booked / post-appointment, then ENQUEUES corrective agent_actions
 *   (batch_id=MIGRATION_indoctrination_decontam, priority lane 200) so the
 *   existing executor performs them — that path already throttles GHL writes
 *   via ghl-rate-limiter (see the lp_last_synced overload incident; we do NOT
 *   hammer the GHL API directly from here).  Per contact:
 *     - remove_from_workflow <active indoctrination wf> (resolved from the
 *       contact's active-s#.# tag via workflow_registry canonical_code)
 *     - remove_from_workflow E.5 (0c7b2137…) when active-e.5 is present
 *     - remove_tag {tags:[stage:indoctrination, <active-s#.# indoctrination tags>]}
 *     - emit_event lp.disposition_changed (re-assert → LP_DISP_* re-routes)
 *   Each action carries a rollback_payload (add_to_workflow / add_tag) and the
 *   before-state is logged for manual rollback.
 *
 *   NEVER mass-PUTs contacts / never uses update_contact (PUT wipes tags — see
 *   Kristen Nichols 2026-05-19).  Tag mutations are remove_tag only.
 *
 * USAGE
 *   node scripts/remediate-indoctrination-decontam.mjs            # DRY RUN (default)
 *   node scripts/remediate-indoctrination-decontam.mjs --execute  # enqueue actions
 *   node scripts/remediate-indoctrination-decontam.mjs --execute --limit 10
 *
 * ENV (already set on the LP MCP service)
 *   HL_SUPABASE_URL, HL_SUPABASE_SERVICE_ROLE_KEY  — read-only detection
 *   (LP Supabase comes from ../src/supabase.js for the agent_actions insert)
 *
 * v1.0 — 2026-06-17 (indoctrination misrouting remediation).
 */
import { createClient } from '@supabase/supabase-js';
import lpSupabase from '../src/supabase.js';
import { resolveWorkflowIdByCanonicalCode } from '../src/tools/admin/hl-fallback.js';

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : null;
})();

const BATCH_ID = 'MIGRATION_indoctrination_decontam';
const PRIORITY_LANE = 200;
const DISP_FIELD = 'URWTGtobi9a9Y7gwGxC8';   // LP Disposition (canonical)
const APPT_FIELD  = 'jHFRKGGsYJJFRbWwthkG';   // appointment status
const E5_WORKFLOW_ID = '0c7b2137-76fd-46d9-9f9b-75d095d3d769';
const BOOKED_DISPOSITIONS = ['OPPFDN','Set','Cnf','NS','CXL','CS','1Leg','Sold','SOLD','FDNS','NOC','Verif','UnCon','No Demo'];

// Indoctrination active-tag → canonical_code. Any active-s2.* tag is an
// indoctrination SOS membership; map the tag to its canonical code so we can
// resolve the right workflow_id (don't assume only S2.2).
function activeTagToCanonical(tag) {
  // active-s2.2 → S2.2 ; active-e.5 → E.5
  const m = /^active-([a-z]+)\.?(\d+)?$/i.exec(tag);
  if (!m) return null;
  return tag.replace(/^active-/i, '').toUpperCase();
}

// ─── HL Supabase (read-only detection) ───────────────────────────
let _hl = null;
function hl() {
  if (_hl) return _hl;
  const url = process.env.HL_SUPABASE_URL;
  const key = process.env.HL_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Set HL_SUPABASE_URL + HL_SUPABASE_SERVICE_ROLE_KEY.');
  _hl = createClient(url, key);
  return _hl;
}
async function hlSelect(sql) {
  const wrapped = `SELECT json_agg(t) FROM (${sql}) t`;
  const { data, error } = await hl().rpc('run_sql', { query_text: wrapped });
  if (error) throw new Error(`HL detection query failed: ${error.message}`);
  // run_sql returns json; unwrap the single json_agg column.
  if (Array.isArray(data) && data.length === 1 && data[0] && typeof data[0] === 'object') {
    const k = Object.keys(data[0])[0];
    return data[0][k] || [];
  }
  return data || [];
}

const DETECTION_SQL = `
  WITH c AS (
    SELECT ghl_contact_id, tags,
      (SELECT cf->>'value' FROM jsonb_array_elements(custom_fields) cf WHERE cf->>'id'='${DISP_FIELD}') AS disp_canon,
      (SELECT cf->>'value' FROM jsonb_array_elements(custom_fields) cf WHERE cf->>'id'='${APPT_FIELD}') AS appt_status
    FROM contacts
    WHERE deleted_at IS NULL AND tags && ARRAY['stage:indoctrination','active-s2.2'])
  SELECT ghl_contact_id, tags, disp_canon, appt_status FROM c
  WHERE appt_status ILIKE '%showed%'
     OR disp_canon IN (${BOOKED_DISPOSITIONS.map(d => `'${d}'`).join(',')})
`;

async function enqueueAction({ contactId, type, targetSystem, payload, rollback, seq, reason }) {
  if (!EXECUTE) return { dry: true };
  const { error } = await lpSupabase.from('agent_actions').insert({
    event_id: null,
    action_type: type,
    target_system: targetSystem,
    target_entity: 'contact',
    target_id: contactId,
    action_payload: payload,
    rollback_payload: rollback || null,
    reasoning: reason,
    confidence: 1.0,
    rule_applied: BATCH_ID,
    status: 'pending',
    requires_approval: false,
    priority: PRIORITY_LANE,
    batch_id: BATCH_ID,
    sequence_order: seq,
  });
  if (error) throw new Error(`enqueue ${type} for ${contactId} failed: ${error.message}`);
  return { enqueued: true };
}

async function main() {
  console.log(`\n[Decontam] mode=${EXECUTE ? 'EXECUTE (enqueue)' : 'DRY RUN'}${LIMIT ? ` limit=${LIMIT}` : ''}`);
  let rows = await hlSelect(DETECTION_SQL);
  console.log(`[Decontam] detection matched ${rows.length} contact(s).`);
  if (LIMIT) rows = rows.slice(0, LIMIT);

  let enqueued = 0;
  for (const r of rows) {
    const contactId = r.ghl_contact_id;
    const tags = r.tags || [];
    const indoctrTags = tags.filter(t => /^active-s\d/i.test(t));   // active-s2.2, active-s2.1, …
    const hasE5 = tags.includes('active-e.5');
    const removeTags = ['stage:indoctrination', ...indoctrTags];

    // Resolve indoctrination workflow ids from the active-s#.# tags.
    const wfTargets = [];
    for (const t of indoctrTags) {
      const canonical = activeTagToCanonical(t);
      let wfId = null;
      try { wfId = canonical ? await resolveWorkflowIdByCanonicalCode(canonical) : null; } catch { /* logged below */ }
      wfTargets.push({ canonical, wfId, tag: t });
    }

    console.log(`\n[Decontam] ${contactId} disp=${r.disp_canon || '∅'} appt=${r.appt_status || '∅'}`);
    console.log(`           BEFORE tags: ${JSON.stringify(tags)}`);
    console.log(`           remove workflows: ${JSON.stringify(wfTargets)}${hasE5 ? ' + E.5' : ''}`);
    console.log(`           remove tags: ${JSON.stringify(removeTags)}`);

    let seq = 0;
    for (const wf of wfTargets) {
      if (!wf.wfId) { console.warn(`           ! no workflow_id for ${wf.canonical} — skipping wf removal`); continue; }
      await enqueueAction({
        contactId, type: 'remove_from_workflow', targetSystem: 'ghl', seq: seq++,
        payload: { workflow_id: wf.wfId, canonical_code: wf.canonical },
        rollback: { workflow_id: wf.wfId, canonical_code: wf.canonical }, // re-add via add_to_workflow if needed
        reason: `${BATCH_ID}: remove booked lead from ${wf.canonical} indoctrination`,
      });
    }
    if (hasE5) {
      await enqueueAction({
        contactId, type: 'remove_from_workflow', targetSystem: 'ghl', seq: seq++,
        payload: { workflow_id: E5_WORKFLOW_ID, canonical_code: 'E.5' },
        rollback: { workflow_id: E5_WORKFLOW_ID, canonical_code: 'E.5' },
        reason: `${BATCH_ID}: remove booked lead from E.5 bridge`,
      });
    }
    await enqueueAction({
      contactId, type: 'remove_tag', targetSystem: 'ghl', seq: seq++,
      payload: { tags: removeTags },
      rollback: { tags: removeTags },   // add_tag to restore if a removal was wrong
      reason: `${BATCH_ID}: strip indoctrination stage/active tags`,
    });
    await enqueueAction({
      contactId, type: 'emit_event', targetSystem: 'lp', seq: seq++,
      payload: { event_type: 'lp.disposition_changed', priority: 'high',
                 payload: { synthetic: true, reason: 'migration_decontam_reassert', disposition_code: r.disp_canon } },
      reason: `${BATCH_ID}: re-assert route via LP_DISP_*`,
    });
    enqueued++;
  }

  console.log(`\n[Decontam] ${EXECUTE ? `enqueued remediation for ${enqueued} contact(s) (batch ${BATCH_ID})` : `DRY RUN — would remediate ${rows.length} contact(s). Re-run with --execute.`}`);
  console.log('[Decontam] Reminder: monitor agent_actions for batch progress; re-run detection count afterward (expect → 0 and staying there).\n');
}

main().then(() => process.exit(0)).catch(err => { console.error('[Decontam] FATAL:', err.message); process.exit(1); });
