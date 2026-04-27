// ─── IME Webhook Handlers — src/ime/webhook-handler.js ───────────
//
// Express route handlers for /ime/* endpoints.
//   POST /ime/dispatch                            ← from GHL W-IME-IN
//   POST /ime/work-orders/:id/refetch             ← on CUSTOMER_INFORMATION_CHANGE
//   POST /ime/work-orders/:id/appointment         ← APPT booked
//   PUT  /ime/work-orders/:id/appointment         ← APPT rescheduled
//   POST /ime/work-orders/:id/install             ← install scheduled
//   POST /ime/work-orders/:id/close               ← pre-sale close
//   POST /ime/work-orders/:id/cancel              ← post-sale cancel
//   POST /ime/work-orders/:id/complete            ← install complete
//
// All routes require Bearer MCP_AUTH_TOKEN. Dispatch persists every event
// (append-only) before doing any side-effect work, so the audit log is
// reliable even if downstream calls fail.

import supabase from '../supabase.js';
import { sendGroupMeMessage } from '../groupme.js';
import * as workOrders from './work-orders.js';
import { enrichWorkOrder } from './enrich-worker.js';

const AFFILIATE_ID = parseInt(process.env.IME_AFFILIATE_ID || '17050371', 10);
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

export function requireAuth(req, res, next) {
  if (!MCP_AUTH_TOKEN) return next();
  const header = req.headers.authorization || '';
  const token = header.replace(/^Bearer\s+/i, '');
  if (token !== MCP_AUTH_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// Outbound guard (v1.6 §6) — verify the WO is IME-originated before pushing to IME.
// Prevents Reece's non-Sam's-Club leads (HRR, Estimate Calculator, Chatbot,
// Canvassing, Referral, etc.) from being sent to IME if a future GHL workflow
// misfires. Stashes the row on req.imeWorkOrder for handlers that want it.
export async function requireIMELead(req, res, next) {
  const woId = parseInt(req.params.id, 10);
  if (!woId || Number.isNaN(woId)) {
    return res.status(400).json({ error: 'missing or invalid wo_id' });
  }

  const { data: row, error } = await supabase
    .from('ime_work_orders')
    .select('ime_work_order_id, ghl_contact_id, ime_enrichment_status')
    .eq('ime_work_order_id', woId)
    .maybeSingle();

  if (error || !row) {
    console.warn(`[ime] [guard] outbound blocked: WO ${woId} not in ime_work_orders (not an IME-originated lead)`);
    return res.status(404).json({
      error: 'not_an_ime_lead',
      message: `WO ${woId} not found in ime_work_orders. Outbound IME calls are only permitted for leads originated via IME.`,
    });
  }

  req.imeWorkOrder = row;
  next();
}

// POST /ime/dispatch — called by GHL W-IME-IN Custom Webhook OUT
export async function dispatch(req, res) {
  const body = req.body || {};
  const { wo_id, affiliate_id, event_type, status, doc_type, changed_date } = body;

  if (!wo_id || !event_type) {
    return res.status(400).json({ error: 'missing wo_id or event_type' });
  }
  if (parseInt(affiliate_id, 10) !== AFFILIATE_ID) {
    console.warn(`[ime] [dispatch] wrong affiliate_id ${affiliate_id} for WO ${wo_id}`);
    return res.status(400).json({ error: 'affiliate_id mismatch' });
  }

  const woIdNum = parseInt(wo_id, 10);

  // 1. Persist event (always, before any processing)
  const { data: eventRow, error: insertErr } = await supabase
    .from('ime_webhook_events')
    .insert({
      ime_work_order_id: woIdNum,
      affiliate_id:      parseInt(affiliate_id, 10),
      event_type,
      status:            status || null,
      doc_type:          doc_type || null,
      changed_date:      changed_date || null,
      raw_payload:       body,
    })
    .select('id')
    .single();

  if (insertErr) {
    console.error(`[ime] [dispatch] event insert failed for WO ${woIdNum}: ${insertErr.message}`);
  }

  // 2. Update or create ime_work_orders row
  const updates = {
    ime_work_order_id: woIdNum,
    ime_affiliate_id:  parseInt(affiliate_id, 10),
    last_webhook_at:   new Date().toISOString(),
  };
  if (event_type === 'STATUS_CHANGED' && status) {
    updates.ime_status = status;
  }
  await supabase.from('ime_work_orders').upsert(updates, { onConflict: 'ime_work_order_id' });

  // 3. Trigger enrichment on first APPOINTMENT_PENDING
  if (event_type === 'STATUS_CHANGED' && status === 'APPOINTMENT_PENDING') {
    const { data: existing } = await supabase
      .from('ime_work_orders')
      .select('ime_enrichment_status')
      .eq('ime_work_order_id', woIdNum)
      .maybeSingle();

    const enrichmentStatus = existing?.ime_enrichment_status;
    if (!enrichmentStatus || enrichmentStatus === 'pending' || enrichmentStatus === 'failed') {
      // Fire-and-forget — don't block the webhook response
      setImmediate(() => {
        enrichWorkOrder(woIdNum).catch((err) => {
          console.error(`[ime] [dispatch] async enrichment failed for WO ${woIdNum}: ${err.message}`);
        });
      });
    }
  }

  // 4. Mark this event row processed
  if (eventRow?.id) {
    await supabase
      .from('ime_webhook_events')
      .update({ processed: true, processed_at: new Date().toISOString() })
      .eq('id', eventRow.id);
  }

  res.json({ ok: true, wo_id: woIdNum, event_type });
}

// POST /ime/work-orders/:id/refetch — on CUSTOMER_INFORMATION_CHANGE
export async function refetch(req, res) {
  const woId = parseInt(req.params.id, 10);
  setImmediate(() => {
    enrichWorkOrder(woId).catch((err) => {
      console.error(`[ime] [refetch] failed for WO ${woId}: ${err.message}`);
    });
  });
  res.json({ ok: true, wo_id: woId, action: 'refetch_queued' });
}

async function recordOutbound(woId) {
  await supabase
    .from('ime_work_orders')
    .update({ last_outbound_at: new Date().toISOString() })
    .eq('ime_work_order_id', woId);
}

// POST /ime/work-orders/:id/appointment
export async function pushAppointment(req, res) {
  const woId = parseInt(req.params.id, 10);
  const { date } = req.body || {};
  if (!date) return res.status(400).json({ error: 'missing date' });
  try {
    const ok = await workOrders.scheduleAppointment(woId, date);
    await recordOutbound(woId);
    res.json({ ok, wo_id: woId });
  } catch (err) {
    await sendGroupMeMessage(`[ime] appointment push failed for WO ${woId}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

// PUT /ime/work-orders/:id/appointment — reschedule
export async function pushReschedule(req, res) {
  const woId = parseInt(req.params.id, 10);
  const { date } = req.body || {};
  if (!date) return res.status(400).json({ error: 'missing date' });
  try {
    const ok = await workOrders.rescheduleAppointment(woId, date);
    await recordOutbound(woId);
    res.json({ ok, wo_id: woId });
  } catch (err) {
    await sendGroupMeMessage(`[ime] reschedule failed for WO ${woId}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

// POST /ime/work-orders/:id/install
export async function pushInstall(req, res) {
  const woId = parseInt(req.params.id, 10);
  const { date, estimatedCompletionDate } = req.body || {};
  if (!date) return res.status(400).json({ error: 'missing date' });
  try {
    const ok = await workOrders.scheduleInstall(woId, date, estimatedCompletionDate);
    await recordOutbound(woId);
    res.json({ ok, wo_id: woId });
  } catch (err) {
    await sendGroupMeMessage(`[ime] install schedule failed for WO ${woId}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

// POST /ime/work-orders/:id/close — pre-sale close
export async function pushClose(req, res) {
  const woId = parseInt(req.params.id, 10);
  try {
    const ok = await workOrders.closeWorkOrder(woId);
    await recordOutbound(woId);
    res.json({ ok, wo_id: woId });
  } catch (err) {
    await sendGroupMeMessage(`[ime] close failed for WO ${woId}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

// POST /ime/work-orders/:id/cancel — post-sale cancel
export async function pushCancel(req, res) {
  const woId = parseInt(req.params.id, 10);
  try {
    const ok = await workOrders.cancelWorkOrder(woId);
    await recordOutbound(woId);
    res.json({ ok, wo_id: woId });
  } catch (err) {
    await sendGroupMeMessage(`[ime] cancel failed for WO ${woId}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

// POST /ime/work-orders/:id/complete
export async function pushComplete(req, res) {
  const woId = parseInt(req.params.id, 10);
  try {
    const ok = await workOrders.completeWorkOrder(woId);
    await recordOutbound(woId);
    res.json({ ok, wo_id: woId });
  } catch (err) {
    await sendGroupMeMessage(`[ime] complete failed for WO ${woId}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}
