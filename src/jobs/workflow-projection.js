/**
 * Workflow Projection Sweep — src/jobs/workflow-projection.js
 *
 * Projects the GHL workflow-telemetry events that the events-router lands in
 * `system_events` into the live, queryable visibility tables:
 *
 *   system_events (ghl.workflow_started | wait_entered | wait_timeout |
 *                  message_failed | opt_out | dnc_updated |
 *                  workflow_exit | workflow_completed)
 *        │
 *        ├─▶ workflow_membership   (one open row per contact+workflow; closed on exit)
 *        ├─▶ message_delivery      (per-message failure ledger)
 *        └─▶ contact_suppression   (no_contact_method / opt_out / dnc)
 *
 * agentic_lead_states.workflow_history (jsonb) remains the historical record;
 * these tables are the live projection the cohort report (v_s13_cohort_report)
 * reads. The matching GHL webhook nodes that POST to /events/* are a separate
 * manual build guide — this sweep only READS system_events and WRITES the
 * projection tables.
 *
 * REPLAY-SAFE
 * ───────────
 *   Each consumed system_events row is stamped processed=true,
 *   processed_by='workflow-projection' (the codebase's sweep idiom — see
 *   message-analyzer.js / decision-engine.js). Re-runs skip stamped rows.
 *   Membership is find-or-insert (no entry_at-conflict upserts); suppression
 *   and the per-message ledger dedupe on their own UNIQUE constraints.
 *
 * ENDPOINTS / SCHEDULE
 * ────────────────────
 *   POST /n8n/workflow-projection/run  { dry_run?, limit? } — manual trigger
 *   GET  /n8n/workflow-projection/status                    — last-run summary
 *   startWorkflowProjectionLoop()                           — in-process loop
 *     env: WORKFLOW_PROJECTION_ENABLED      (default 'true')
 *          WORKFLOW_PROJECTION_INTERVAL_MS  (default 120000 = 2 min)
 *          WORKFLOW_PROJECTION_BATCH        (default 500 events/tick)
 *
 * v1.0 — 2026-06-17 (S1.3 audit remediation).
 */
import supabase from '../supabase.js';
import { runJob } from '../job-runner.js';

const PROJECTION_INTERVAL_MS = Number(process.env.WORKFLOW_PROJECTION_INTERVAL_MS) || 120000; // 2 min
const DEFAULT_BATCH = Number(process.env.WORKFLOW_PROJECTION_BATCH) || 500;
const PROCESSED_BY = 'workflow-projection';

// Known canonical-code overrides for workflow ids absent from the
// workflow_canonical_map mirror (S1.3 is not mirrored). Default matches
// enroll.js / the published S1.3 inbound_webhook workflow.
const S1_3_WORKFLOW_ID = process.env.S1_3_WORKFLOW_ID || '32fa691b-2422-4727-83c9-1174801974e9';
const CANONICAL_OVERRIDES = new Map([[S1_3_WORKFLOW_ID, 'S1.3']]);

// The ghl.* telemetry types this sweep consumes (must match events-router EVENT_TYPE_MAP).
const PROJECTED_EVENT_TYPES = [
  'ghl.workflow_started',
  'ghl.wait_entered',
  'ghl.wait_timeout',
  'ghl.message_failed',
  'ghl.opt_out',
  'ghl.dnc_updated',
  'ghl.workflow_exit',
  'ghl.workflow_completed',
];

let lastRunSummary = null;

// ── Payload field extraction (mirrors events-router normalization) ───────────
function readPayload(payload = {}) {
  const cd = (payload.customData || payload.custom_data || payload.customValues || {}) || {};
  const pick = (...keys) => {
    for (const k of keys) {
      if (payload[k] != null && payload[k] !== '') return payload[k];
      if (cd[k] != null && cd[k] !== '') return cd[k];
    }
    return null;
  };
  return {
    contactId: pick('contact_id', 'contactId'),
    workflowId: pick('workflow_id', 'workflowId'),
    canonicalCode: pick('canonical_code', 'canonicalCode'),
    channel: pick('channel'),
    messageId: pick('message_id', 'messageId', 'ghl_message_id'),
    errorCode: pick('error_code', 'errorCode'),
    errorDetail: pick('error_detail', 'errorDetail', 'error', 'reason'),
    node: pick('current_node', 'node', 'node_name', 'step_name'),
    reason: pick('reason', 'exit_reason', 'exitReason'),
    entryReason: pick('entry_reason', 'entryReason', 'segment', 'bucket'),
    occurredAt: pick('occurred_at', 'occurredAt', 'timestamp'),
  };
}

// ── Canonical-code resolution (workflow_id → canonical_code) ─────────────────
// Prefers an explicit payload canonical_code (the GHL node should send it),
// then the workflow_canonical_map mirror. Cached per run.
async function buildCanonicalReverseMap() {
  const map = new Map(CANONICAL_OVERRIDES); // overrides first; mirror does not clobber
  const { data } = await supabase
    .from('workflow_canonical_map')
    .select('workflow_id, canonical_code');
  for (const r of data || []) if (r.workflow_id && !map.has(r.workflow_id)) map.set(r.workflow_id, r.canonical_code);
  return map;
}

// ── Membership helpers (find-or-insert; UNIQUE is contact+workflow+entry_at) ─
async function findOpenMembership(contactId, workflowId) {
  let q = supabase
    .from('workflow_membership')
    .select('id, ghl_contact_id, workflow_id, canonical_code')
    .eq('ghl_contact_id', contactId)
    .eq('is_active', true)
    .order('entry_at', { ascending: false })
    .limit(1);
  if (workflowId) q = q.eq('workflow_id', workflowId);
  const { data } = await q;
  return data?.[0] || null;
}

/** Suppress no_contact_method only when the contact has no OTHER live channel. */
async function hasNoAlternateChannel(contactId, failedChannel) {
  const { data } = await supabase
    .from('lp_leads')
    .select('phone, email')
    .eq('ghl_contact_id', contactId)
    .limit(1);
  const row = data?.[0];
  if (!row) return false; // no lead row → don't guess
  const hasPhone = !!row.phone;
  const hasEmail = !!row.email && /@/.test(String(row.email));
  if (failedChannel === 'sms' || failedChannel === 'call') return !hasEmail;
  if (failedChannel === 'email') return !hasPhone;
  return false; // unknown channel → be conservative, do not suppress
}

async function upsertSuppression({ contactId, channel, reason, detail = {} }) {
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from('contact_suppression')
    .upsert({
      ghl_contact_id: contactId,
      channel: channel || 'all',
      reason,
      source_system: 'ghl',
      detail,
      active: true,
      set_at: nowIso,
      updated_at: nowIso,
    }, { onConflict: 'ghl_contact_id,channel,reason' });
  if (error) throw new Error(`contact_suppression upsert failed: ${error.message}`);
}

async function closeMembership(contactId, workflowId, exitReason, occurredAt) {
  const open = await findOpenMembership(contactId, workflowId);
  if (!open) return;
  const { error } = await supabase
    .from('workflow_membership')
    .update({
      is_active: false,
      exit_reason: exitReason || null,
      exit_at: occurredAt || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', open.id);
  if (error) throw new Error(`workflow_membership close failed: ${error.message}`);
}

// ── Per-event projection ─────────────────────────────────────────────────────
async function projectEvent(event, canonicalMap, dryRun) {
  const f = readPayload(event.payload || {});
  const contactId = f.contactId || event.ghl_contact_id;
  if (!contactId) return { skipped: 'no_contact' };
  const workflowId = f.workflowId || null;
  const occurredAt = event.event_timestamp || event.created_at || new Date().toISOString();
  const canonicalCode = f.canonicalCode
    || (workflowId ? canonicalMap.get(workflowId) || null : null);

  if (dryRun) return { would_project: event.event_type };

  switch (event.event_type) {
    case 'ghl.workflow_started': {
      const open = await findOpenMembership(contactId, workflowId);
      if (open) return { membership: 'already_open' };
      const { error } = await supabase
        .from('workflow_membership')
        .insert({
          ghl_contact_id: contactId,
          workflow_id: workflowId || 'unknown',
          canonical_code: canonicalCode,
          entry_at: occurredAt,
          entry_reason: f.entryReason || null,
          wait_status: 'none',
          is_active: true,
          updated_at: new Date().toISOString(),
        });
      if (error && error.code !== '23505') throw new Error(`workflow_membership insert failed: ${error.message}`);
      return { membership: 'opened' };
    }

    case 'ghl.wait_entered':
    case 'ghl.wait_timeout': {
      const open = await findOpenMembership(contactId, workflowId);
      if (!open) return { membership: 'none_to_update' };
      const { error } = await supabase
        .from('workflow_membership')
        .update({
          current_node: f.node || open.current_node || null,
          wait_status: event.event_type === 'ghl.wait_timeout' ? 'timed_out' : 'waiting',
          updated_at: new Date().toISOString(),
        })
        .eq('id', open.id);
      if (error) throw new Error(`workflow_membership wait update failed: ${error.message}`);
      return { membership: 'wait_updated' };
    }

    case 'ghl.message_failed': {
      const channel = f.channel || null;
      const { error: mdErr } = await supabase
        .from('message_delivery')
        .upsert({
          ghl_contact_id: contactId,
          ghl_message_id: f.messageId || null,
          channel,
          status: 'failed',
          error_code: f.errorCode || null,
          error_detail: f.errorDetail || null,
          workflow_id: workflowId,
          occurred_at: occurredAt,
        }, { onConflict: 'ghl_message_id,status', ignoreDuplicates: true });
      if (mdErr && mdErr.code !== '23505') throw new Error(`message_delivery insert failed: ${mdErr.message}`);
      // Mirror onto the open membership row.
      const open = await findOpenMembership(contactId, workflowId);
      if (open) {
        await supabase.from('workflow_membership')
          .update({ last_message_status: 'failed', updated_at: new Date().toISOString() })
          .eq('id', open.id);
      }
      // Suppress only when there is no alternate live channel.
      if (await hasNoAlternateChannel(contactId, channel)) {
        await upsertSuppression({
          contactId, channel: channel || 'all', reason: 'no_contact_method',
          detail: { source_event_id: event.id, error_code: f.errorCode || null },
        });
      }
      return { message: 'failed_recorded' };
    }

    case 'ghl.opt_out': {
      await upsertSuppression({ contactId, channel: f.channel || 'all', reason: 'opt_out',
        detail: { source_event_id: event.id } });
      await closeMembership(contactId, workflowId, 'opt_out', occurredAt);
      return { suppression: 'opt_out' };
    }

    case 'ghl.dnc_updated': {
      await upsertSuppression({ contactId, channel: f.channel || 'all', reason: 'dnc',
        detail: { source_event_id: event.id } });
      await closeMembership(contactId, workflowId, 'opt_out', occurredAt);
      return { suppression: 'dnc' };
    }

    case 'ghl.workflow_exit':
    case 'ghl.workflow_completed': {
      const exitReason = f.reason
        || (event.event_type === 'ghl.workflow_completed' ? 'completed' : 'manual');
      await closeMembership(contactId, workflowId, exitReason, occurredAt);
      return { membership: 'closed', exit_reason: exitReason };
    }

    default:
      return { skipped: 'unhandled_type' };
  }
}

// ── Main sweep ───────────────────────────────────────────────────────────────
export async function runWorkflowProjection({ limit = DEFAULT_BATCH, dryRun = false } = {}) {
  const startedAt = Date.now();
  if (!supabase) return { success: false, error: 'supabase_unavailable' };

  const { data: events, error } = await supabase
    .from('system_events')
    .select('id, event_type, event_subtype, ghl_contact_id, payload, event_timestamp, created_at')
    .eq('processed', false)
    .in('event_type', PROJECTED_EVENT_TYPES)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) return { success: false, error: `system_events scan failed: ${error.message}` };
  if (!events?.length) {
    return { success: true, scanned: 0, projected: 0, dry_run: dryRun, elapsed_ms: Date.now() - startedAt };
  }

  const canonicalMap = await buildCanonicalReverseMap();
  const outcomes = {};
  let projected = 0, failed = 0;

  for (const event of events) {
    try {
      const r = await projectEvent(event, canonicalMap, dryRun);
      const key = Object.values(r)[0];
      outcomes[`${event.event_type}:${key}`] = (outcomes[`${event.event_type}:${key}`] || 0) + 1;
      projected++;
      if (!dryRun) {
        await supabase.from('system_events')
          .update({ processed: true, processed_by: PROCESSED_BY, processed_at: new Date().toISOString() })
          .eq('id', event.id);
      }
    } catch (err) {
      failed++;
      console.error(`[WorkflowProjection] event ${event.id} (${event.event_type}) failed:`, err.message);
      // Leave processed=false so the next tick retries.
    }
  }

  const summary = {
    success: failed === 0,
    scanned: events.length,
    projected,
    failed,
    outcomes,
    dry_run: dryRun,
    elapsed_ms: Date.now() - startedAt,
  };
  lastRunSummary = { ...summary, ranAt: new Date().toISOString() };
  return summary;
}

export function startWorkflowProjectionLoop() {
  if (String(process.env.WORKFLOW_PROJECTION_ENABLED || 'true').toLowerCase() === 'false') {
    console.log('[WorkflowProjection] loop disabled via WORKFLOW_PROJECTION_ENABLED=false');
    return null;
  }
  const tick = async () => {
    try {
      const { value: result } = await runJob('workflow-projection', () => runWorkflowProjection());
      if (result && !result.success) console.warn('[WorkflowProjection] tick reported failures:', result.failed);
    } catch (err) {
      console.error('[WorkflowProjection] tick threw:', err.message);
    }
  };
  setTimeout(tick, 30000); // first run 30s after boot
  const handle = setInterval(tick, PROJECTION_INTERVAL_MS);
  if (typeof handle.unref === 'function') handle.unref();
  console.log(`[WorkflowProjection] loop started — every ${Math.round(PROJECTION_INTERVAL_MS / 60000)}min (first run in 30s)`);
  return handle;
}

export function registerWorkflowProjectionRoutes(app) {
  app.post('/n8n/workflow-projection/run', async (req, res) => {
    try {
      const result = await runWorkflowProjection({
        limit: parseInt(req.body?.limit, 10) || undefined,
        dryRun: req.body?.dry_run === true,
      });
      res.json(result);
    } catch (err) {
      console.error('[WorkflowProjection] /run error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/n8n/workflow-projection/status', async (req, res) => {
    try {
      const { count: pending } = await supabase
        .from('system_events')
        .select('id', { count: 'exact', head: true })
        .eq('processed', false)
        .in('event_type', PROJECTED_EVENT_TYPES);
      res.json({
        success: true,
        pending_events: pending || 0,
        last_loop_run: lastRunSummary,
        config: {
          interval_ms: PROJECTION_INTERVAL_MS,
          batch: DEFAULT_BATCH,
          loop_enabled: String(process.env.WORKFLOW_PROJECTION_ENABLED || 'true').toLowerCase() !== 'false',
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('[WorkflowProjection] Routes registered: POST /n8n/workflow-projection/run | GET /n8n/workflow-projection/status');
}
