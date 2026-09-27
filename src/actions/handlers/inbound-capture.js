/**
 * capture_inbound_caller — src/actions/handlers/inbound-capture.js
 *
 * 2026-09-27. The approval half of Inbound Caller Capture
 * (src/jobs/inbound-caller-capture.js). In INBOUND_CAPTURE_MODE=approval the
 * hourly pass queues one of these per caller with requires_approval=true;
 * approving it runs captureCaller() — the SAME function live mode calls, so
 * there is one capture path and, under it, one LP creation path (workflow
 * 8e30ff37 via enrollLpLeadCreation).
 *
 * captureCaller re-checks the caller with fresh reads first. An approval can
 * land hours after the card went out, and by then the caller may have texted
 * STOP or reached LP on their own; either one turns this into a clean skip.
 *
 * Deliberately NOT in the escalation sweep's SAFE_ACTION_TYPES: creating an LP
 * lead leads to a dial, so an unanswered card never auto-runs.
 */

import supabase from '../../supabase.js';
import { captureCaller, TABLE } from '../../jobs/inbound-caller-capture.js';

export async function executeCaptureInboundCaller(action, { deps = {} } = {}) {
  const p = action?.action_payload || {};
  if (!p.caller_phone || !p.call_at) {
    return { skipped: true, reason: 'payload has no caller_phone / call_at' };
  }

  const res = await captureCaller(p, { deps });

  // Record the outcome on the row the pass claimed. Best-effort: the row is
  // already approval_queued, which no later pass will re-queue either way.
  const db = deps.supabase || supabase;
  try {
    await db.from(TABLE)
      .update({ action_taken: res.action_taken, label: res.label || p.label, ghl_contact_id: res.ghl_contact_id || p.ghl_contact_id || null })
      .eq('caller_phone', p.caller_phone)
      .eq('call_at', p.call_at);
  } catch (err) {
    console.warn(`[InboundCapture] action ${action?.id}: could not record ${res.action_taken} on ${TABLE}: ${err.message}`);
  }

  if (res.action_taken === 'failed') throw new Error(`capture failed: ${res.detail}`);
  if (res.action_taken === 'not_a_candidate') {
    return { skipped: true, reason: `no longer a capture candidate: ${res.label} (${res.detail})` };
  }
  return { success: true, action: res.action_taken, ghl_contact_id: res.ghl_contact_id, detail: res.detail };
}
