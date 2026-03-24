// ─── GHL Notes Sync — src/ghl-notes-sync.js ──────────────────────
//
// v3 — March 24, 2026
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

import supabase from './supabase.js';
import { addGHLNote } from './ghl.js';

/**
 * Format an LP date for display. Uses UTC extraction because LP stores
 * local time but Supabase treats it as UTC.
 */
function formatLPDate(dateStr) {
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
function formatNoteForGHL(note) {
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
      .select('id, lp_note_id, lp_lead_id, ghl_contact_id, note_body, note_type, note_category, created_by_rep_name, created_at_lp')
      .not('ghl_contact_id', 'is', null)
      .eq('ghl_note_pushed', false)
      .not('note_body', 'is', null)
      // OLDEST FIRST — so newest notes are added last and appear at top in GHL
      .order('created_at_lp', { ascending: true, nullsFirst: false })
      .range(offset, offset + batchSize - 1);

    if (error) {
      console.error('[NoteSync] Query failed:', error.message);
      if (error.message.includes('ghl_note_pushed')) {
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

      if (result) {
        stats.pushed++;
        await supabase.from('lp_notes')
          .update({ ghl_note_pushed: true })
          .eq('id', note.id);
      } else {
        stats.failed++;
      }

      if (result) await sleep(delayMs);
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
 * Count unpushed notes for monitoring.
 */
export async function countUnpushedNotes() {
  try {
    const { count, error } = await supabase
      .from('lp_notes')
      .select('id', { count: 'exact', head: true })
      .not('ghl_contact_id', 'is', null)
      .eq('ghl_note_pushed', false)
      .not('note_body', 'is', null);
    if (error) return -1;
    return count || 0;
  } catch {
    return -1;
  }
}
