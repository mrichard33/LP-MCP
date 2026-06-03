/**
 * Note-Change Analyzer — src/agentic/lead-state/note-change-analyzer.js
 *
 * Point 2, Part B. The bounded invoker that closes the gap where a rep
 * logs a note/call but the lead never replies to a message — so the
 * customer-message analyzer (analyzeMessage, fires only on
 * ghl.reply_received) never runs, and the note's relationship-stage signal
 * never reaches the classifier.
 *
 * What it does, per run (bounded):
 *   1. Find contacts whose newest note/call (lp_notes.synced_at /
 *      lp_call_logs.synced_at) is NEWER than their last note analysis
 *      (lead_intelligence.last_note_analysis_at). Change-detected — mirrors
 *      the sweep's lp_leads.synced_at approach (point 1), so we only touch
 *      contacts with genuinely new note activity.
 *   2. OPTION-B GATE: skip contacts being worked on the REACTIVE path —
 *      i.e. a customer inbound reply within QUIET_DAYS. Those are handled
 *      live by analyzeMessage; re-reading their notes here is redundant and
 *      could fight the live conversation. We act only on quiet/dormant
 *      contacts, which is exactly the gap.
 *   3. Pull the contact's notes/calls, run note-intelligence
 *      (analyzeNotesForContact) — writes intelligence fields ONLY, emits
 *      nothing (no customer-send risk) — then classifyLeadState so the
 *      fresh note signal flows into the S4.5 eligibility / suppression
 *      decision immediately.
 *
 * Ships DARK behind NOTE_CHANGE_ANALYZER_ENABLED (default false), like the
 * sweep. The admin route runs regardless of the timer flag for controlled
 * testing.
 *
 * Cost: note-intelligence makes one LLM call per processed contact. Bounded
 * by NOTE_CHANGE_BATCH per run and the shared analyzer budget. Change-
 * detection keeps the working set tiny (only new-note contacts).
 *
 * v0.1.0 — 2026-06-03. Point 2 Part B.
 */

import supabase from '../../supabase.js';
import { analyzeNotesForContact } from './note-intelligence.js';
import { classifyLeadState } from './classifier.js';

// ── Config (env-overridable) ────────────────────────────────────────
const ENABLED        = process.env.NOTE_CHANGE_ANALYZER_ENABLED === 'true';
const INTERVAL_MS    = Number(process.env.NOTE_CHANGE_INTERVAL_MS || 6 * 60 * 60 * 1000); // 6h
const BATCH          = Number(process.env.NOTE_CHANGE_BATCH || 20);
const LOOKBACK_HOURS = Number(process.env.NOTE_CHANGE_LOOKBACK_HOURS || 72);
// Option-B gate: a customer inbound reply within this many days means the
// contact is on the reactive path — skip note-driven analysis for them.
const QUIET_DAYS     = Number(process.env.NOTE_CHANGE_QUIET_DAYS || 7);
const MAX_SCAN       = Number(process.env.NOTE_CHANGE_MAX_SCAN || 2000);
const BOOT_DELAY_MS  = Number(process.env.NOTE_CHANGE_BOOT_DELAY_MS || 9 * 60 * 1000); // 9m, offset from sweep's 8m

let running = false;

/**
 * Collect candidate contacts with note/call activity newer than their last
 * note analysis. Returns Map(ghl_contact_id → { lpLeadIds:Set, newestSynced }).
 *
 * Strategy: scan lp_notes + lp_call_logs by synced_at desc within the
 * lookback window, group by ghl_contact_id, capture the lp_lead_ids and the
 * newest synced_at. The last_note_analysis_at freshness comparison happens
 * after, against lead_intelligence, so a contact whose newest note predates
 * its last analysis is dropped.
 */
async function collectChangedNoteContacts() {
  const cutoffIso = new Date(Date.now() - LOOKBACK_HOURS * 3600000).toISOString();
  const byContact = new Map();

  async function scan(table, dateCol) {
    const PAGE = 1000;
    let from = 0, scanned = 0;
    while (scanned < MAX_SCAN) {
      const { data, error } = await supabase
        .from(table)
        .select(`ghl_contact_id, lp_lead_id, synced_at`)
        .gte('synced_at', cutoffIso)
        .not('ghl_contact_id', 'is', null)
        .order('synced_at', { ascending: false })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`${table} scan failed at ${from}: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const r of data) {
        scanned++;
        const id = r.ghl_contact_id;
        if (!id) continue;
        let entry = byContact.get(id);
        if (!entry) { entry = { lpLeadIds: new Set(), newestSynced: r.synced_at }; byContact.set(id, entry); }
        if (r.lp_lead_id) entry.lpLeadIds.add(r.lp_lead_id);
        if (r.synced_at && r.synced_at > entry.newestSynced) entry.newestSynced = r.synced_at;
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }

  await scan('lp_notes');
  await scan('lp_call_logs');
  return byContact;
}

/** Fetch notes (shaped for note-intelligence) for a set of lp_lead_ids. */
async function fetchNotes(lpLeadIds) {
  if (!lpLeadIds.length) return [];
  const { data, error } = await supabase
    .from('lp_notes')
    .select('note_body, note_category, created_by_rep_name, created_at_lp')
    .in('lp_lead_id', lpLeadIds)
    .not('note_body', 'is', null)
    .order('created_at_lp', { ascending: false })
    .limit(8);
  if (error || !data) return [];
  return data
    .map(n => ({ text: (n.note_body || '').trim(), category: n.note_category || 'General', entered_by: n.created_by_rep_name || '', date: n.created_at_lp || '' }))
    .filter(n => n.text.length > 0);
}

/** Fetch recent call results (shaped for note-intelligence) for lp_lead_ids. */
async function fetchCalls(lpLeadIds) {
  if (!lpLeadIds.length) return [];
  const { data, error } = await supabase
    .from('lp_call_logs')
    .select('call_result, call_direction, rep_name, call_date')
    .in('lp_lead_id', lpLeadIds)
    .order('call_date', { ascending: false })
    .limit(5);
  if (error || !data) return [];
  return data.map(c => ({ result: c.call_result || '', type: c.call_direction || '', agent: c.rep_name || '', date: c.call_date || '' }));
}

/** Most recent disposition_code for the contact (from lp_leads). */
async function fetchDisposition(ghlContactId) {
  const { data } = await supabase
    .from('lp_leads')
    .select('disposition_code, synced_at')
    .eq('ghl_contact_id', ghlContactId)
    .order('synced_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.disposition_code || null;
}

/**
 * lead_intelligence freshness + Option-B reply gate for a contact.
 * Returns { lastNoteAnalysisAt, lastReplyAt, analysisCount, existing } or
 * null on error (caller fails safe = process it).
 */
async function fetchIntel(ghlContactId) {
  const { data, error } = await supabase
    .from('lead_intelligence')
    .select('last_note_analysis_at, last_reply_at, analysis_count')
    .eq('ghl_contact_id', ghlContactId)
    .maybeSingle();
  if (error) return null;
  return data || {};
}

export async function runNoteChangeAnalysis({ limit = BATCH } = {}) {
  if (running) return { success: true, skipped: true, reason: 'already_running' };
  running = true;
  const startedAt = Date.now();

  try {
    const candidates = await collectChangedNoteContacts();
    const quietCutoffMs = Date.now() - QUIET_DAYS * 86400000;

    let processed = 0, analyzed = 0, classified = 0, errors = 0;
    let skippedFreshAnalysis = 0, skippedReactive = 0, skippedNoText = 0;
    const errorSample = [];

    for (const [ghlContactId, entry] of candidates) {
      if (processed >= limit) break;

      try {
        const intel = await fetchIntel(ghlContactId);

        // Change-detection: skip if we already analyzed notes AT/AFTER the
        // newest note/call synced time.
        const lastNoteAt = intel?.last_note_analysis_at ? new Date(intel.last_note_analysis_at).getTime() : 0;
        const newestMs = entry.newestSynced ? new Date(entry.newestSynced).getTime() : 0;
        if (lastNoteAt >= newestMs && lastNoteAt > 0) { skippedFreshAnalysis++; continue; }

        // OPTION-B GATE: skip contacts on the reactive path (replied recently).
        const lastReplyMs = intel?.last_reply_at ? new Date(intel.last_reply_at).getTime() : 0;
        if (lastReplyMs >= quietCutoffMs && lastReplyMs > 0) { skippedReactive++; continue; }

        const lpLeadIds = Array.from(entry.lpLeadIds);
        const [notes, calls, lpDisposition] = await Promise.all([
          fetchNotes(lpLeadIds),
          fetchCalls(lpLeadIds),
          fetchDisposition(ghlContactId),
        ]);
        if (!notes.length && !calls.length) { skippedNoText++; continue; }

        processed++;
        const analysis = await analyzeNotesForContact(ghlContactId, { lpDisposition, notes, calls }, intel);
        if (analysis) {
          analyzed++;
          // Re-classify so the fresh note signal flows into eligibility now.
          await classifyLeadState(ghlContactId, { triggerSource: 'note_change' });
          classified++;
        }
      } catch (err) {
        errors++;
        if (errorSample.length < 10) errorSample.push({ contact_id: ghlContactId, error: (err.message || 'unknown').slice(0, 200) });
      }
    }

    const elapsed_ms = Date.now() - startedAt;
    const summary = {
      success: true,
      candidates: candidates.size,
      processed, analyzed, classified, errors,
      skipped: { fresh_analysis: skippedFreshAnalysis, reactive_recent_reply: skippedReactive, no_note_text: skippedNoText },
      error_sample: errorSample,
      enabled: ENABLED,
      elapsed_ms,
    };
    console.log(
      `[NoteChangeAnalyzer] done: ${analyzed} analyzed / ${classified} reclassified of ${processed} processed ` +
      `(candidates ${candidates.size}; skipped fresh ${skippedFreshAnalysis}, reactive ${skippedReactive}, no-text ${skippedNoText}), ` +
      `errors ${errors} (${elapsed_ms}ms)`
    );
    return summary;
  } finally {
    running = false;
  }
}

// ── Express route ───────────────────────────────────────────────────

export function registerNoteChangeAnalyzerRoutes(app) {
  // POST /admin/lead-state/note-change  { limit? } — runs regardless of timer flag.
  app.post('/admin/lead-state/note-change', async (req, res) => {
    try {
      const limit = parseInt(req.body?.limit, 10) || BATCH;
      const result = await runNoteChangeAnalysis({ limit });
      res.json(result);
    } catch (err) {
      console.error('[NoteChangeAnalyzer] route error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/admin/lead-state/note-change/config', (req, res) => {
    res.json({
      enabled: ENABLED,
      interval_ms: INTERVAL_MS,
      batch: BATCH,
      lookback_hours: LOOKBACK_HOURS,
      quiet_days: QUIET_DAYS,
      max_scan: MAX_SCAN,
    });
  });

  console.log('[NoteChangeAnalyzer] Registered: POST /admin/lead-state/note-change | GET /admin/lead-state/note-change/config');
}

// ── Scheduler ───────────────────────────────────────────────────────

export function startNoteChangeAnalyzerScheduler() {
  if (!ENABLED) {
    console.log('[NoteChangeAnalyzer] scheduler DISABLED (set NOTE_CHANGE_ANALYZER_ENABLED=true to enable). Manual route still available.');
    return;
  }
  console.log(`[NoteChangeAnalyzer] scheduler ENABLED — first run in ${Math.round(BOOT_DELAY_MS / 60000)}m, then every ${Math.round(INTERVAL_MS / 3600000)}h`);
  setTimeout(() => {
    runNoteChangeAnalysis().catch(e => console.error('[NoteChangeAnalyzer] initial run:', e.message));
    setInterval(() => {
      runNoteChangeAnalysis().catch(e => console.error('[NoteChangeAnalyzer] scheduled run:', e.message));
    }, INTERVAL_MS);
  }, BOOT_DELAY_MS);
}
