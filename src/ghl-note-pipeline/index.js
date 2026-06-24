// ─── GHL Inbound → LP Note pipeline — src/ghl-note-pipeline/index.js
//
// Receiver + debounced worker + reconciliation for turning GoHighLevel
// inbound conversations into ONE clean, facts-only note per conversation
// session in Lead Perfection, for the call center.
//
//   POST /ghl/inbound-message   fast receiver (≤~1s), defers heavy work
//   startGhlNoteSweep()         debounce timer → process due rows
//   startGhlNoteReconciliation() belt-and-suspenders for dropped webhooks
//   process(id)                 claim → live-read → summarize → write/shadow
//
// Modes (GHL_NOTE_MODE): off (kill switch) | shadow (log only) | live (write).
// GHL-only; fully independent of Revin. Never logs the webhook token or creds.

import supabase from '../supabase.js';
import { sendGroupMeMessage } from '../groupme.js';
import { resolveLPLeadId } from '../lp-appointment-sync.js';
import {
  resolveConversationId,
  getConversationMessages,
  getApptStateFromLeadEvents,
  getRecentAppointmentEvents,
  getRecentInboundFromCache,
} from './hl-read.js';
import { summarizeConversation } from './summarizer.js';
import { writeLpNote } from './lp-write.js';

// ─── Config ──────────────────────────────────────────────────────
const MODE = (process.env.GHL_NOTE_MODE || 'shadow').toLowerCase(); // off | shadow | live
const WEBHOOK_TOKEN = process.env.WEBHOOK_GHL_INBOUND_TOKEN;
const DEBOUNCE_MIN = parseInt(process.env.GHL_NOTE_DEBOUNCE_MIN || '30', 10);
const SWEEP_SEC = parseInt(process.env.GHL_NOTE_SWEEP_SEC || '90', 10);
const RECON_MIN = parseInt(process.env.GHL_NOTE_RECON_MIN || '30', 10);
const STALE_CLAIM_MIN = parseInt(process.env.GHL_NOTE_STALE_CLAIM_MIN || '15', 10);
const MAX_ATTEMPTS = parseInt(process.env.GHL_NOTE_MAX_ATTEMPTS || '5', 10);

function parseTypeSet(envVal, fallback) {
  return new Set(
    String(envVal || fallback)
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n))
  );
}
const TEXT_TYPES = parseTypeSet(process.env.GHL_NOTE_TEXT_TYPES, '2,3,5,11,18,29');
const DROP_TYPES = parseTypeSet(process.env.GHL_NOTE_DROP_TYPES, '1,45');

// ─── Terminal pre-check (cheap, permissive — authoritative filtering
//     happens at process time via the live read) ──────────────────
function terminalPrecheck(body) {
  const t = String(body || '').toLowerCase();
  if (/\b(stop|unsubscribe|remove me)\b/.test(t)) return 'opt_out';
  if (/\b(call me|call now)\b/.test(t)) return 'callback_request';
  if (/\bcancel\b/.test(t)) return 'cancel';
  return null;
}

function nowNyText() {
  try {
    return new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York',
      dateStyle: 'short',
      timeStyle: 'short',
    });
  } catch {
    return new Date().toISOString();
  }
}

function cutoffIso(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
}

// ─── Webhook receiver ────────────────────────────────────────────
export function registerGhlInboundRoutes(app) {
  app.post('/ghl/inbound-message', async (req, res) => {
    // 1. Auth — never log the token.
    if (!WEBHOOK_TOKEN || req.headers['x-webhook-token'] !== WEBHOOK_TOKEN) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    try {
      const body = req.body || {};
      const ghlContactId = body.ghl_contact_id;
      if (!ghlContactId) return res.status(200).json({ ignored: 'no_contact' });

      // 2. Resolve conversation id (payload → live lookup).
      let convId = body.ghl_conversation_id || null;
      if (!convId) {
        try {
          convId = await resolveConversationId(ghlContactId);
        } catch (err) {
          console.warn(`[GHLNote] conv resolve failed for ${ghlContactId}: ${err.message}`);
        }
      }
      if (!convId) return res.status(200).json({ ignored: 'no_conversation' });

      // 3. Cheap terminal pre-check.
      const reason = terminalPrecheck(body.message_body);

      // 4. Atomic conditional upsert (§4.5 semantics, via RPC).
      const { data: id, error } = await supabase.rpc('ghl_note_upsert_pending', {
        p_conv: convId,
        p_contact: ghlContactId,
        p_body: body.message_body || null,
        p_terminal: !!reason,
        p_reason: reason,
      });
      if (error) {
        console.error(`[GHLNote] upsert_pending failed: ${error.message}`);
        return res.status(200).json({ ok: false, error: 'enqueue_failed' });
      }

      // 5. Terminal rows skip the debounce — kick the processor best-effort.
      if (reason && id) {
        processRow(id).catch((e) => console.error(`[GHLNote] terminal kick failed: ${e.message}`));
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error(`[GHLNote] inbound handler error: ${err.message}`);
      // Still 200 so GHL does not retry-storm; the reconciler will catch it.
      return res.status(200).json({ ok: false });
    }
  });

  console.log(`[GHLNote] route registered: POST /ghl/inbound-message (mode=${MODE})`);
}

// ─── Signal gathering ────────────────────────────────────────────
async function gatherSignals(ghlContactId) {
  const signals = {
    intent_tier: null,
    objection_type: null,
    emotional_state: null,
    note_signal_summary: null,
    engagement: null,
  };

  try {
    const { data } = await supabase
      .from('lead_intelligence')
      .select('intent_tier, objection_type, emotional_state, note_signal_summary, rep_briefing, ai_reasoning')
      .eq('ghl_contact_id', ghlContactId)
      .maybeSingle();
    if (data) {
      signals.intent_tier = data.intent_tier || null;
      signals.objection_type = data.objection_type || null;
      signals.emotional_state = data.emotional_state || null;
      signals.note_signal_summary = data.note_signal_summary || data.rep_briefing || data.ai_reasoning || null;
    }
  } catch (err) {
    console.warn(`[GHLNote] lead_intelligence read failed for ${ghlContactId}: ${err.message}`);
  }

  try {
    const { data } = await supabase
      .from('engagement_summary')
      .select('*')
      .eq('ghl_contact_id', ghlContactId)
      .maybeSingle();
    if (data) {
      signals.engagement = {
        emails_opened: data.emails_opened ?? null,
        links_clicked: data.links_clicked ?? null,
        replies_count: data.replies_count ?? null,
        vsl_watched: data.vsl_watched ?? null,
        last_activity: data.last_activity || data.last_engagement_at || null,
      };
    }
  } catch (err) {
    console.warn(`[GHLNote] engagement_summary read failed for ${ghlContactId}: ${err.message}`);
  }

  return signals;
}

// ─── Mark helpers ────────────────────────────────────────────────
async function markDone(id, throughIso, noteId, incrementNote, claimedRow) {
  await supabase
    .from('ghl_conversation_pending')
    .update({
      status: 'done',
      summarized_through_at: throughIso,
      last_lp_note_id: noteId || claimedRow.last_lp_note_id || null,
      notes_written: (claimedRow.notes_written || 0) + (incrementNote ? 1 : 0),
      claimed_at: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
}

async function markError(id, attempts, message) {
  const failed = attempts >= MAX_ATTEMPTS;
  await supabase
    .from('ghl_conversation_pending')
    .update({
      status: failed ? 'failed' : 'pending',
      last_error: String(message || '').slice(0, 500),
      claimed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (failed) {
    sendGroupMeMessage(
      `⚠️ GHL→LP note FAILED after ${attempts} attempts · row=${id} · ${String(message).slice(0, 160)}`,
      { flushNow: true }
    ).catch((e) => console.warn(`[GHLNote] failure alert send failed: ${e.message}`));
  }
}

// ─── Processor ───────────────────────────────────────────────────
export async function processRow(id) {
  // Fetch the candidate row.
  const { data: row, error: fetchErr } = await supabase
    .from('ghl_conversation_pending')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (fetchErr || !row || row.status !== 'pending') return;

  // Atomic claim — single UPDATE...WHERE status='pending' wins exactly once.
  const claimedAt = new Date().toISOString();
  const { data: claimed, error: claimErr } = await supabase
    .from('ghl_conversation_pending')
    .update({
      status: 'processing',
      claimed_at: claimedAt,
      attempts: (row.attempts || 0) + 1,
      updated_at: claimedAt,
    })
    .eq('id', id)
    .eq('status', 'pending')
    .select()
    .maybeSingle();
  if (claimErr || !claimed) return; // lost the race

  const attempts = claimed.attempts;

  try {
    if (MODE === 'off') {
      // Kill switch — release the row, do nothing.
      await supabase
        .from('ghl_conversation_pending')
        .update({ status: 'pending', claimed_at: null, updated_at: new Date().toISOString() })
        .eq('id', id);
      return;
    }

    // Live-read the conversation messages (authoritative numeric types).
    const allMessages = await getConversationMessages(claimed.ghl_conversation_id);

    // Channel filter: allowlist wins, droplist excluded.
    const textMessages = allMessages.filter(
      (m) => TEXT_TYPES.has(m.type) && !DROP_TYPES.has(m.type)
    );

    // Window: strictly after the last summarized session boundary.
    const startCutoff = claimed.session_start_at ? new Date(claimed.session_start_at) : null;
    const windowed = textMessages.filter((m) => !startCutoff || m.sentAt > startCutoff);

    const latestOverall = allMessages.length ? allMessages[allMessages.length - 1].sentAt : null;
    const hasInbound = windowed.some(
      (m) => m.direction === 'inbound' && String(m.body || '').trim()
    );

    // No new inbound text (e.g. only a reaction) → done with NO note.
    if (!hasInbound) {
      const throughIso = (latestOverall || new Date()).toISOString();
      await markDone(id, throughIso, null, false, claimed);
      return;
    }

    const throughDate = windowed[windowed.length - 1].sentAt;
    const throughIso = throughDate.toISOString();
    const dedupeKey = `${claimed.ghl_conversation_id}:${throughDate.getTime()}`;

    // Resolve LP prospect + gather signals + appointment state.
    let prospectId = null;
    let ldsId = null;
    try {
      const resolved = await resolveLPLeadId(claimed.ghl_contact_id, {}, { fast: true });
      prospectId = resolved?.prospectId || null;
      ldsId = resolved?.ldsId || null;
    } catch (err) {
      console.warn(`[GHLNote] LP resolve failed for ${claimed.ghl_contact_id}: ${err.message}`);
    }

    const [signals, apptState] = await Promise.all([
      gatherSignals(claimed.ghl_contact_id),
      getApptStateFromLeadEvents(claimed.ghl_contact_id),
    ]);

    // Summarize.
    const { note, important } = await summarizeConversation({
      messages: windowed,
      signals,
      apptState,
      nowText: nowNyText(),
    });

    const channelTypes = [...new Set(windowed.map((m) => m.type))];

    // ── Mode branch ──
    if (MODE === 'shadow') {
      await supabase.from('ghl_note_shadow_log').insert({
        ghl_conversation_id: claimed.ghl_conversation_id,
        ghl_contact_id: claimed.ghl_contact_id,
        lp_lead_id: ldsId,
        would_be_note: note,
        important,
        channel_types: channelTypes,
        message_count: windowed.length,
      });
      await persistLead(id, ldsId);
      await markDone(id, throughIso, null, true, claimed);
      return;
    }

    // MODE === 'live'
    if (!prospectId) {
      // Cannot attach without a prospect — record and stop (no retry storm).
      await markDone(id, throughIso, null, false, claimed);
      await supabase
        .from('ghl_conversation_pending')
        .update({ last_error: 'no_lp_prospect_resolved' })
        .eq('id', id);
      return;
    }

    // At-most-once guard per conversation-session.
    const { data: guard } = await supabase
      .from('ghl_note_dedupe')
      .upsert(
        { dedupe_key: dedupeKey, ghl_conversation_id: claimed.ghl_conversation_id },
        { onConflict: 'dedupe_key', ignoreDuplicates: true }
      )
      .select();
    if (!guard || guard.length === 0) {
      // This session's note already written — mark done, no duplicate.
      await persistLead(id, ldsId);
      await markDone(id, throughIso, null, false, claimed);
      return;
    }

    // Write the LP note.
    const lpNoteId = await writeLpNote(prospectId, note, important);

    await supabase
      .from('ghl_note_dedupe')
      .update({ lp_note_id: lpNoteId })
      .eq('dedupe_key', dedupeKey);

    await supabase.from('ghl_note_log').insert({
      ghl_conversation_id: claimed.ghl_conversation_id,
      ghl_contact_id: claimed.ghl_contact_id,
      lp_lead_id: ldsId,
      lp_note_id: lpNoteId,
      important,
      note_preview: note.slice(0, 280),
    });

    await persistLead(id, ldsId);
    await markDone(id, throughIso, lpNoteId, true, claimed);
  } catch (err) {
    console.error(`[GHLNote] process(${id}) error: ${err.message}`);
    await markError(id, attempts, err.message).catch(() => {});
  }
}

async function persistLead(id, ldsId) {
  if (!ldsId) return;
  await supabase
    .from('ghl_conversation_pending')
    .update({ lp_lead_id: ldsId })
    .eq('id', id)
    .then(() => {}, () => {});
}

// ─── Debounce sweep ──────────────────────────────────────────────
let sweepRunning = false;
async function runSweep() {
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    const cutoff = cutoffIso(DEBOUNCE_MIN);
    const { data: rows, error } = await supabase
      .from('ghl_conversation_pending')
      .select('id, terminal, last_inbound_at')
      .eq('status', 'pending')
      .or(`terminal.eq.true,last_inbound_at.lt.${cutoff}`)
      .order('terminal', { ascending: false })
      .order('last_inbound_at', { ascending: true })
      .limit(25);
    if (error) {
      console.error(`[GHLNote] sweep query failed: ${error.message}`);
      return;
    }
    if (!rows?.length) return;
    for (const r of rows) {
      // Sequential to respect the GHL rate limiter and LP circuit breaker.
      await processRow(r.id).catch((e) => console.error(`[GHLNote] process ${r.id} failed: ${e.message}`));
    }
  } finally {
    sweepRunning = false;
  }
}

export function startGhlNoteSweep() {
  if (MODE === 'off') {
    console.log('[GHLNote] sweep disabled (GHL_NOTE_MODE=off)');
    return;
  }
  const tick = () => runSweep().catch((e) => console.error(`[GHLNote] sweep tick error: ${e.message}`));
  setTimeout(tick, 30 * 1000);
  setInterval(tick, SWEEP_SEC * 1000);
  console.log(`[GHLNote] sweep started — debounce ${DEBOUNCE_MIN}m, interval ${SWEEP_SEC}s`);
}

// ─── Reconciliation ──────────────────────────────────────────────
let reconRunning = false;
async function runReconciliation() {
  if (reconRunning) return;
  reconRunning = true;
  try {
    // A) Reclaim stale claims.
    const staleCutoff = cutoffIso(STALE_CLAIM_MIN);
    await supabase
      .from('ghl_conversation_pending')
      .update({ status: 'pending', claimed_at: null, last_error: 'stale_claim_reclaimed', updated_at: new Date().toISOString() })
      .eq('status', 'processing')
      .lt('claimed_at', staleCutoff)
      .then(() => {}, (e) => console.warn(`[GHLNote] reclaim failed: ${e.message}`));

    // B) Enqueue dropped webhooks from the HL messages cache (~2h lookback).
    try {
      const cache = await getRecentInboundFromCache(cutoffIso(120));
      for (const [convId, info] of cache) {
        const { data: existing } = await supabase
          .from('ghl_conversation_pending')
          .select('id, status, summarized_through_at')
          .eq('ghl_conversation_id', convId)
          .maybeSingle();
        const missing = !existing;
        const doneButStale =
          existing &&
          existing.status === 'done' &&
          existing.summarized_through_at &&
          new Date(existing.summarized_through_at) < info.last_inbound_at;
        if (missing || doneButStale) {
          await supabase.rpc('ghl_note_upsert_pending', {
            p_conv: convId,
            p_contact: info.ghl_contact_id,
            p_body: info.last_message_body || null,
            p_terminal: false,
            p_reason: null,
          });
        }
      }
    } catch (err) {
      console.warn(`[GHLNote] dropped-webhook reconcile failed: ${err.message}`);
    }

    // C) Terminal appointment events.
    try {
      const events = await getRecentAppointmentEvents(cutoffIso(RECON_MIN));
      for (const ev of events) {
        if (!ev.contact_id) continue;
        const reason = ev.event_type === 'appointment_cancelled' ? 'appointment_cancelled' : 'appointment_booked';
        await supabase
          .from('ghl_conversation_pending')
          .update({ terminal: true, terminal_reason: reason, updated_at: new Date().toISOString() })
          .eq('ghl_contact_id', ev.contact_id)
          .in('status', ['pending', 'processing'])
          .then(() => {}, () => {});
      }
    } catch (err) {
      console.warn(`[GHLNote] appt-event reconcile failed: ${err.message}`);
    }
  } finally {
    reconRunning = false;
  }
}

export function startGhlNoteReconciliation() {
  if (MODE === 'off') {
    console.log('[GHLNote] reconciliation disabled (GHL_NOTE_MODE=off)');
    return;
  }
  const tick = () => runReconciliation().catch((e) => console.error(`[GHLNote] recon tick error: ${e.message}`));
  setTimeout(tick, 120 * 1000);
  setInterval(tick, RECON_MIN * 60 * 1000);
  console.log(`[GHLNote] reconciliation started — interval ${RECON_MIN}m, stale-claim ${STALE_CLAIM_MIN}m`);
}
