// ─── GHL Notes Sync — src/ghl-notes-sync.js ──────────────────────
//
// v4 — April 6, 2026
// Pushes LP notes to GHL contact records as internal notes.
// Each LP note is pushed once, tracked by ghl_note_pushed flag.
//
// NOTE ORDERING: Notes are pushed OLDEST FIRST (ascending by created_at_lp).
// This means the newest notes get added last and appear at the TOP in GHL's
// notes UI (which shows most recently added first).
//
// Date handling: LP stores dates as local time but Supabase has them
// as UTC. We use getUTC*() methods to extract the date/time as-is.
// Notes without a date (string-wrapped notes) omit the date line.
//
// v4: Added pushLeadNotesImmediately() for real-time note push on
// disposition changes. Exported formatNoteForGHL and formatLPDate.

import supabase from './supabase.js';
import { addGHLNote } from './ghl.js';

// ─── Terminal failure state (sql/050) ────────────────────────────────────────
//
// 2026-07-28: one orphan contact id (Y21mrJPUGYGKIWFptVpu, LP lead 562172) made
// pushNotesToGHL report "0 pushed, 3 failed" on every 90s cycle forever — the
// rows were never marked, so they were re-selected indefinitely and blocked the
// backlog behind them. Rows are now retired two ways:
//
//   result === 'not_found'  → terminal immediately, ghl_contact_id NULLed, and
//                             counted as SKIPPED (the contact is gone; this is
//                             not a failure anyone can act on).
//   any other falsy result  → attempts++, terminal at MAX_NOTE_PUSH_ATTEMPTS.
//                             General poison-pill backstop: it must stop ANY
//                             undeliverable note, not just this failure mode.
const MAX_NOTE_PUSH_ATTEMPTS = 5;

/**
 * Record a failed push. Returns 'terminal' when the row will never be selected
 * again, 'retry' otherwise.
 */
async function markNoteOutcome(noteId, result, attempts) {
  if (result === 'not_found') {
    await supabase.from('lp_notes').update({
      ghl_note_push_terminal: true,
      ghl_note_push_error: 'contact_not_found',
      ghl_contact_id: null,
    }).eq('id', noteId);
    return 'terminal';
  }

  const next = (attempts || 0) + 1;
  const terminal = next >= MAX_NOTE_PUSH_ATTEMPTS;
  // This column is the forensic trail, so it must never read as a bare
  // stringified falsy value. addGHLNote returns null for "disabled / empty
  // body / transient failure" and false is not in its contract at all — but
  // String(false) would silently write "false", which tells a future reader
  // nothing. Map every falsy shape to a named reason.
  let reason;
  if (result === false) reason = 'push_rejected';
  else if (result == null) reason = 'push_failed';
  else reason = String(result);
  await supabase.from('lp_notes').update({
    ghl_note_push_attempts: next,
    ghl_note_push_error: reason.slice(0, 500),
    ghl_note_push_terminal: terminal,
  }).eq('id', noteId);
  return terminal ? 'terminal' : 'retry';
}

/**
 * Format an LP date for display. Uses UTC extraction because LP stores
 * local time but Supabase treats it as UTC.
 */
export function formatLPDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;

  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const year = d.getUTCFullYear();

  let hours = d.getUTCHours();
  const minutes = d.getUTCMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  const minStr = minutes.toString().padStart(2, '0');

  return `${month}/${day}/${year} ${hours}:${minStr} ${ampm}`;
}

/**
 * Format an LP note for GHL display.
 * Includes metadata header so reps know the source.
 * Omits date line when no LP date is available (string-wrapped notes).
 */
export function formatNoteForGHL(note) {
  const parts = [];

  parts.push('📋 LP Note');

  const meta = [];
  if (note.created_by_rep_name) meta.push(`By: ${note.created_by_rep_name}`);
  if (note.note_category) meta.push(`Category: ${note.note_category}`);
  if (note.note_type && note.note_type !== 'standard') meta.push(`Type: ${note.note_type}`);

  const formattedDate = formatLPDate(note.created_at_lp);
  if (formattedDate) meta.push(`Date: ${formattedDate}`);

  if (meta.length > 0) parts.push(meta.join(' | '));

  if (note.note_body) {
    parts.push('');
    parts.push(note.note_body);
  }

  if (note.lp_lead_id) {
    parts.push('');
    parts.push(`LP Lead: ${note.lp_lead_id}`);
  }

  return parts.join('\n');
}

/**
 * Push unpushed LP notes to GHL contact records.
 *
 * CRITICAL: Notes are sorted OLDEST FIRST (ascending by created_at_lp).
 * This ensures the newest notes get added last and appear at the TOP
 * in GHL's notes UI.
 *
 * Notes with null dates (string-wrapped notes with no LP metadata) are
 * pushed LAST (after all dated notes).
 */
export async function pushNotesToGHL({ batchSize = 50, delayMs = 300, maxNotes = 200 } = {}) {
  const stats = { total: 0, pushed: 0, skipped: 0, failed: 0 };
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  let offset = 0;
  let totalProcessed = 0;

  while (totalProcessed < maxNotes) {
    const { data: notes, error } = await supabase
      .from('lp_notes')
      .select('id, lp_note_id, lp_lead_id, ghl_contact_id, note_body, note_type, note_category, created_by_rep_name, created_at_lp, ghl_note_push_attempts')
      .not('ghl_contact_id', 'is', null)
      .eq('ghl_note_pushed', false)
      .eq('ghl_note_push_terminal', false)
      // Echo-loop guard: never push a note that originated in GHL back to GHL.
      .neq('note_origin', 'ghl_ai_brief')
      .not('note_body', 'is', null)
      // OLDEST FIRST — so newest notes are added last and appear at top in GHL
      .order('created_at_lp', { ascending: true, nullsFirst: false })
      .range(offset, offset + batchSize - 1);

    if (error) {
      console.error('[NoteSync] Query failed:', error.message);
      if (error.message.includes('ghl_note_push_terminal') || error.message.includes('ghl_note_push_attempts')) {
        console.error('[NoteSync] Note-push terminal columns do not exist — run migration sql/050_note_push_terminal.sql');
      } else if (error.message.includes('ghl_note_pushed')) {
        console.error('[NoteSync] Column ghl_note_pushed does not exist — run migration sql/005_add_ghl_note_pushed.sql');
      }
      break;
    }
    if (!notes || notes.length === 0) break;

    for (const note of notes) {
      stats.total++;
      totalProcessed++;

      if (!note.note_body || note.note_body.trim().length < 3) {
        stats.skipped++;
        await supabase.from('lp_notes')
          .update({ ghl_note_pushed: true })
          .eq('id', note.id);
        continue;
      }

      const formattedBody = formatNoteForGHL(note);
      const result = await addGHLNote(note.ghl_contact_id, formattedBody);

      // 'not_found' is a TRUTHY string — it must be tested before `if (result)`
      // or a dead contact would be marked delivered.
      if (result === 'not_found') {
        stats.skipped++;
        await markNoteOutcome(note.id, result, note.ghl_note_push_attempts);
        console.warn(`[NoteSync] Note ${note.lp_note_id} terminal — contact ${note.ghl_contact_id} not found; link cleared`);
      } else if (result) {
        stats.pushed++;
        await supabase.from('lp_notes')
          .update({ ghl_note_pushed: true })
          .eq('id', note.id);
        await sleep(delayMs);
      } else {
        stats.failed++;
        const outcome = await markNoteOutcome(note.id, result, note.ghl_note_push_attempts);
        if (outcome === 'terminal') {
          console.warn(`[NoteSync] Note ${note.lp_note_id} terminal after ${MAX_NOTE_PUSH_ATTEMPTS} failed attempts — giving up`);
        }
      }

      if (totalProcessed >= maxNotes) break;
    }

    if (notes.length < batchSize) break;
    offset += batchSize;
  }

  if (stats.pushed > 0 || stats.failed > 0) {
    console.log(`[NoteSync] Complete: ${stats.pushed} pushed, ${stats.skipped} skipped, ${stats.failed} failed`);
  }
  return stats;
}

/**
 * REAL-TIME NOTE PUSH — Push all unpushed notes for a specific lead immediately.
 * 
 * Called by sync-leads.js after a disposition change is detected.
 * This eliminates the 30-60 min delay for time-sensitive notes
 * (cancellations, rescheduling, rep notes entered just before disp change).
 *
 * Only pushes notes that have a ghl_contact_id and haven't been pushed yet.
 * 
 * @param {string} lpLeadId - LP lead ID
 * @param {string} ghlContactId - GHL contact ID to push notes to
 * @returns {Object} { pushed, skipped, failed }
 */
export async function pushLeadNotesImmediately(lpLeadId, ghlContactId) {
  if (!lpLeadId || !ghlContactId) return { pushed: 0, skipped: 0, failed: 0 };

  const stats = { pushed: 0, skipped: 0, failed: 0 };

  try {
    const { data: notes, error } = await supabase
      .from('lp_notes')
      .select('id, lp_note_id, lp_lead_id, ghl_contact_id, note_body, note_type, note_category, created_by_rep_name, created_at_lp, ghl_note_push_attempts, ghl_note_push_terminal')
      .eq('lp_lead_id', lpLeadId)
      .eq('ghl_note_pushed', false)
      .eq('ghl_note_push_terminal', false)
      // Echo-loop guard: never push a note that originated in GHL back to GHL.
      .neq('note_origin', 'ghl_ai_brief')
      .not('note_body', 'is', null)
      .order('created_at_lp', { ascending: true, nullsFirst: false });

    if (error) {
      console.error(`[NoteSync] Real-time query failed for lead ${lpLeadId}:`, error.message);
      return stats;
    }
    if (!notes || notes.length === 0) return stats;

    for (const note of notes) {
      // Belt-and-braces: the select already excludes terminal rows, but the
      // fallback below would silently retarget a row whose ghl_contact_id was
      // NULLed by a terminal not-found mark at the caller's id — re-pushing to
      // a contact this note was never linked to. Skip them outright.
      if (note.ghl_note_push_terminal) continue;

      if (!note.note_body || note.note_body.trim().length < 3) {
        stats.skipped++;
        await supabase.from('lp_notes').update({ ghl_note_pushed: true }).eq('id', note.id);
        continue;
      }

      // Use ghlContactId param (may be more current than what's on the note row)
      const targetContactId = note.ghl_contact_id || ghlContactId;
      const formattedBody = formatNoteForGHL(note);
      const result = await addGHLNote(targetContactId, formattedBody);

      // 'not_found' is truthy — test the sentinel before `if (result)`.
      if (result === 'not_found') {
        stats.skipped++;
        await markNoteOutcome(note.id, result, note.ghl_note_push_attempts);
        console.warn(`[NoteSync] Note ${note.lp_note_id} terminal — contact ${targetContactId} not found; link cleared`);
      } else if (result) {
        stats.pushed++;
        await supabase.from('lp_notes')
          .update({ ghl_note_pushed: true, ghl_contact_id: targetContactId })
          .eq('id', note.id);
      } else {
        stats.failed++;
        const outcome = await markNoteOutcome(note.id, result, note.ghl_note_push_attempts);
        if (outcome === 'terminal') {
          console.warn(`[NoteSync] Note ${note.lp_note_id} terminal after ${MAX_NOTE_PUSH_ATTEMPTS} failed attempts — giving up`);
        }
      }
    }

    if (stats.pushed > 0) {
      console.log(`[NoteSync] Real-time push for lead ${lpLeadId}: ${stats.pushed} notes → GHL ${ghlContactId}`);
    }
  } catch (err) {
    console.error(`[NoteSync] Real-time push error for lead ${lpLeadId}:`, err.message);
  }

  return stats;
}

/**
 * Count unpushed notes for monitoring. Excludes terminal rows — they will never
 * be pushed, so counting them would report a backlog that can never drain.
 */
export async function countUnpushedNotes() {
  try {
    const { count, error } = await supabase
      .from('lp_notes')
      .select('id', { count: 'exact', head: true })
      .not('ghl_contact_id', 'is', null)
      .eq('ghl_note_pushed', false)
      .eq('ghl_note_push_terminal', false)
      // Echo-loop guard: never push a note that originated in GHL back to GHL.
      .neq('note_origin', 'ghl_ai_brief')
      .not('note_body', 'is', null);
    if (error) return -1;
    return count || 0;
  } catch {
    return -1;
  }
}
