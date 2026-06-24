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
import { getGHLContact } from '../ghl.js';
import {
  resolveConversationId,
  getConversationMessages,
  getApptStateFromLeadEvents,
  getRecentAppointmentEvents,
  getRecentInboundFromCache,
} from './hl-read.js';
import { summarizeConversation } from './summarizer.js';
import { writeLpNote } from './lp-write.js';
import { classifyMatch, resolveOrCreateLpLead } from './resolve-or-create.js';

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
async function markDone(id, throughIso, noteId, incrementNote, claimedRow, leadAction = null) {
  const nowIso = new Date().toISOString();
  await supabase
    .from('ghl_conversation_pending')
    .update({
      status: 'done',
      summarized_through_at: throughIso,
      last_lp_note_id: noteId || claimedRow.last_lp_note_id || null,
      notes_written: (claimedRow.notes_written || 0) + (incrementNote ? 1 : 0),
      claimed_at: null,
      last_error: null,
      lead_action: leadAction,
      lead_action_at: leadAction ? nowIso : null,
      updated_at: nowIso,
    })
    .eq('id', id);
}

// Maps a read-only classifyMatch() outcome to a shadow-log label.
function classifyLabel(cls) {
  switch (cls?.outcome) {
    case 'resolved': return 'resolved';
    case 'match_single': return `would_link:${cls.prospectId}`;
    case 'ambiguous': return `would_ambiguous:${(cls.candidates || []).join('|')}`;
    case 'lp_unavailable': return 'lp_unavailable';
    case 'no_match': return 'would_create';
    default: return 'unknown';
  }
}

// Defer a row that has no LP prospect yet (lead created/ambiguous/unavailable).
// Leaves it pending for a later sweep; alerts at most once per outcome; gives up
// (→ failed) once attempts reach MAX_ATTEMPTS so permanently-stuck rows (e.g. an
// un-creatable lead missing its address) stop looping.
async function deferLead(id, claimedRow, attempts, outcome, detail) {
  const failed = attempts >= MAX_ATTEMPTS;
  const nowIso = new Date().toISOString();
  await supabase
    .from('ghl_conversation_pending')
    .update({
      status: failed ? 'failed' : 'pending',
      claimed_at: null,
      last_error: outcome,
      lead_action: outcome,
      lead_action_at: nowIso,
      updated_at: nowIso,
    })
    .eq('id', id);

  // created_deferred / lp_unavailable self-resolve, so they only alert if they
  // exhaust retries. ambiguous / missing-fields alert once (deduped on the
  // prior last_error), and anything alerts on final give-up.
  const alertable = outcome === 'ambiguous_deferred' || outcome === 'missing_fields_deferred';
  const firstTimeForOutcome = claimedRow.last_error !== outcome;
  if (failed || (alertable && firstTimeForOutcome)) {
    const verb = failed ? `gave up after ${attempts} attempts` : 'deferred';
    sendGroupMeMessage(
      `⚠️ GHL→LP lead ${verb} · row=${id} · contact=${claimedRow.ghl_contact_id} · ${outcome}` +
        (detail ? ` · ${detail}` : ''),
      { flushNow: true }
    ).catch((e) => console.warn(`[GHLNote] defer alert send failed: ${e.message}`));
  }
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
      console.log(`[GHLNote] process(${id}) no-inbound-text → done (no note)`);
      await markDone(id, throughIso, null, false, claimed);
      return;
    }

    const throughDate = windowed[windowed.length - 1].sentAt;
    const throughIso = throughDate.toISOString();
    const dedupeKey = `${claimed.ghl_conversation_id}:${throughDate.getTime()}`;

    // Gather signals + appointment state (independent of LP resolution).
    const [signals, apptState] = await Promise.all([
      gatherSignals(claimed.ghl_contact_id),
      getApptStateFromLeadEvents(claimed.ghl_contact_id),
    ]);

    // Fetch the GHL contact once — phone/email feed resolve/search, and the
    // create handler reuses it. Null is tolerated downstream.
    let ghlContact = null;
    try {
      ghlContact = await getGHLContact(claimed.ghl_contact_id);
    } catch (err) {
      console.warn(`[GHLNote] GHL contact fetch failed for ${claimed.ghl_contact_id}: ${err.message}`);
    }

    // Resolve the LP prospect to attach the note to. If none is already linked,
    // search → link an existing match → or create a new lead (live only).
    let prospectId = null;
    let ldsId = null;
    let leadAction = null;

    if (MODE === 'shadow') {
      // Read-only: classify what we WOULD do; never touch the CRM.
      try {
        const cls = await classifyMatch({ ghlContactId: claimed.ghl_contact_id, ghlContact });
        leadAction = classifyLabel(cls);
        if (cls.outcome === 'resolved') {
          prospectId = cls.prospectId;
          ldsId = cls.ldsId || null;
        }
      } catch (err) {
        leadAction = 'classify_error';
        console.warn(`[GHLNote] shadow classify failed for ${claimed.ghl_contact_id}: ${err.message}`);
      }
    } else {
      // MODE === 'live' — resolve / link / create.
      const roc = await resolveOrCreateLpLead({
        ghlContactId: claimed.ghl_contact_id,
        ghlContact,
      });
      leadAction = roc.outcome;
      if ((roc.outcome === 'resolved' || roc.outcome === 'linked') && roc.prospectId) {
        prospectId = roc.prospectId;
        ldsId = roc.ldsId || null;
      } else {
        // No prospect yet (created / ambiguous / unavailable / error) — defer
        // for a later sweep; alert at most once per outcome; fail at MAX_ATTEMPTS.
        console.log(`[GHLNote] process(${id}) deferred — outcome=${roc.outcome} contact=${claimed.ghl_contact_id}`);
        await deferLead(id, claimed, attempts, roc.outcome, roc.detail);
        return;
      }
    }

    // Summarize (shadow always; live only once a prospect exists).
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
        lead_action: leadAction,
      });
      await persistLead(id, ldsId);
      await markDone(id, throughIso, null, true, claimed, leadAction);
      console.log(`[GHLNote] process(${id}) shadow — msgs=${windowed.length} important=${important} lead_action=${leadAction}`);
      return;
    }

    // MODE === 'live' — at-most-once guard per conversation-session.
    const { data: guard } = await supabase
      .from('ghl_note_dedupe')
      .upsert(
        { dedupe_key: dedupeKey, ghl_conversation_id: claimed.ghl_conversation_id },
        { onConflict: 'dedupe_key', ignoreDuplicates: true }
      )
      .select();
    if (!guard || guard.length === 0) {
      // This session's note already written — mark done, no duplicate.
      console.log(`[GHLNote] process(${id}) dedupe hit — note already written this session`);
      await persistLead(id, ldsId);
      await markDone(id, throughIso, null, false, claimed, leadAction);
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
    await markDone(id, throughIso, lpNoteId, true, claimed, leadAction);
    console.log(`[GHLNote] process(${id}) live — note written lp_note_id=${lpNoteId} important=${important} prospect=${prospectId}`);
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
  const t0 = Date.now();
  let processed = 0;
  let errors = 0;
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
      console.error(`[GHLNote:sweep] query failed: ${error.message}`);
      return;
    }
    if (!rows?.length) {
      console.log(`[GHLNote:sweep] 0 due rows (${Date.now() - t0}ms)`);
      return;
    }
    for (const r of rows) {
      // Sequential to respect the GHL rate limiter and LP circuit breaker.
      try {
        await processRow(r.id);
        processed++;
      } catch (e) {
        errors++;
        console.error(`[GHLNote:sweep] process ${r.id} failed: ${e.message}`);
      }
    }
  } finally {
    sweepRunning = false;
    if (processed > 0 || errors > 0) {
      console.log(`[GHLNote:sweep] done: ${processed} processed, ${errors} errors (${Date.now() - t0}ms)`);
    }
  }
}

export function startGhlNoteSweep() {
  if (MODE === 'off') {
    console.log('[GHLNote:sweep] disabled (GHL_NOTE_MODE=off)');
    return;
  }
  const tick = () => runSweep().catch((e) => console.error(`[GHLNote:sweep] tick error: ${e.message}`));
  setTimeout(tick, 30 * 1000);
  setInterval(tick, SWEEP_SEC * 1000);
  console.log(`[GHLNote:sweep] started — mode=${MODE} debounce=${DEBOUNCE_MIN}m interval=${SWEEP_SEC}s`);
}

// ─── Reconciliation ──────────────────────────────────────────────
let reconRunning = false;
async function runReconciliation() {
  if (reconRunning) return;
  reconRunning = true;
  const t0 = Date.now();
  let reclaimed = 0;
  let enqueued = 0;
  let terminalMarked = 0;
  try {
    // A) Reclaim stale claims.
    const staleCutoff = cutoffIso(STALE_CLAIM_MIN);
    const { count: reclaimCount } = await supabase
      .from('ghl_conversation_pending')
      .update({ status: 'pending', claimed_at: null, last_error: 'stale_claim_reclaimed', updated_at: new Date().toISOString() })
      .eq('status', 'processing')
      .lt('claimed_at', staleCutoff)
      .select('id', { count: 'exact', head: true })
      .then(
        (res) => res,
        (e) => { console.warn(`[GHLNote:recon] reclaim failed: ${e.message}`); return { count: 0 }; }
      );
    reclaimed = reclaimCount || 0;

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
          enqueued++;
        }
      }
    } catch (err) {
      console.warn(`[GHLNote:recon] dropped-webhook reconcile failed: ${err.message}`);
    }

    // C) Terminal appointment events.
    try {
      const events = await getRecentAppointmentEvents(cutoffIso(RECON_MIN));
      for (const ev of events) {
        if (!ev.contact_id) continue;
        const reason = ev.event_type === 'appointment_cancelled' ? 'appointment_cancelled' : 'appointment_booked';
        const { count } = await supabase
          .from('ghl_conversation_pending')
          .update({ terminal: true, terminal_reason: reason, updated_at: new Date().toISOString() })
          .eq('ghl_contact_id', ev.contact_id)
          .in('status', ['pending', 'processing'])
          .select('id', { count: 'exact', head: true })
          .then((res) => res, () => ({ count: 0 }));
        terminalMarked += count || 0;
      }
    } catch (err) {
      console.warn(`[GHLNote:recon] appt-event reconcile failed: ${err.message}`);
    }

    console.log(
      `[GHLNote:recon] done: reclaimed=${reclaimed} enqueued=${enqueued} terminal_marked=${terminalMarked} (${Date.now() - t0}ms)`
    );
  } finally {
    reconRunning = false;
  }
}

export function startGhlNoteReconciliation() {
  if (MODE === 'off') {
    console.log('[GHLNote:recon] disabled (GHL_NOTE_MODE=off)');
    return;
  }
  const tick = () => runReconciliation().catch((e) => console.error(`[GHLNote:recon] tick error: ${e.message}`));
  setTimeout(tick, 120 * 1000);
  setInterval(tick, RECON_MIN * 60 * 1000);
  console.log(`[GHLNote:recon] started — interval=${RECON_MIN}m stale-claim=${STALE_CLAIM_MIN}m`);
}
