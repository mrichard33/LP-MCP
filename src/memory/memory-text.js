/**
 * Memory Text — src/memory/memory-text.js
 *
 * Pure helpers shared by the backfill and the nightly job (priority #8):
 * what text each memory row turns into, how PII is stripped before it leaves
 * the database, and the content hash that lets re-runs skip unchanged rows.
 * Only node:crypto is imported so scripts/test-memory-gate.js can load it
 * without env.
 *
 * v1.0 — 2026-09-06. Initial.
 */
import { createHash } from 'node:crypto';

export const SESSION_TEXT_CAP = 6000;

// US phone numbers in any common layout; emails. UUIDs, 8-char UUID prefixes,
// canonical codes (S4.5) and issue ids (#724) are deliberately untouched — they
// are the exact tokens retrieval needs. Lookarounds, not \b: a country code
// glued to the area code must be consumable. The leading class also rejects a
// decimal point and the trailing class a unit letter, so telemetry such as
// "cost=$0.000035 4365ms" (session 200) is not read as a phone number.
const PHONE_RE = /(?<![\d.])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![\dA-Za-z])/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function stripPii(text) {
  if (!text) return '';
  return String(text).replace(EMAIL_RE, '[email]').replace(PHONE_RE, '[phone]');
}

/**
 * Whitespace-delimited word count. Deliberately naive: the callers use it as a
 * substance FLOOR ("is there enough here to be a task?"), not as linguistics.
 * Added 2026-09-16 for the Omi action-item floor — "Fix it" is not a to-do
 * anyone can act on a week later, "Call Shana to obtain the information needed
 * for Meta business account access" is.
 */
export function wordCount(text) {
  const t = String(text || '').trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

function joinLines(...parts) {
  return parts.filter((p) => p && String(p).trim()).join('\n');
}

/**
 * Build the text to embed for one row. `kind` is decision | issue | session |
 * pending; `row` is the source row (column names as in the claude_* tables).
 */
export function memoryText(kind, row) {
  if (!row) return '';
  switch (kind) {
    case 'decision':
      return joinLines(
        `Decision (${row.category || 'uncategorized'}, ${row.area || 'general'}): ${row.decision || ''}`,
        row.rationale ? `Rationale: ${row.rationale}` : '',
        (row.workflow_code || row.workflow_name) ? `Workflow: ${row.workflow_code || row.workflow_name}` : '',
      );
    case 'issue':
      return joinLines(
        `Issue (${row.severity || 'unrated'}, ${row.category || 'uncategorized'}, ${row.area || 'general'}): ${row.description || ''}`,
        row.impact ? `Impact: ${row.impact}` : '',
        (row.workflow_code || row.workflow_name) ? `Workflow: ${row.workflow_code || row.workflow_name}` : '',
      );
    case 'session':
      return joinLines(
        `Session ${row.session_date || ''} (${row.area || 'general'}): ${row.session_title || ''}`,
        row.phase_focus ? `Focus: ${row.phase_focus}` : '',
        String(row.raw_summary || '').slice(0, SESSION_TEXT_CAP),
      );
    case 'pending':
      return joinLines(
        `Pending ${row.kind || 'item'} (${row.item_type || 'untyped'}, ${row.area || 'general'}): ${row.description || ''}`,
        row.ref ? `Ref: ${row.ref}` : '',
      );
    default:
      throw new Error(`memoryText: unknown kind ${kind}`);
  }
}

/** Hash covers text + status + area so a status flip or re-area re-embeds the row. */
export function contentHash(embeddedText, status, area) {
  return createHash('sha256')
    .update(`${embeddedText}\u0000${status || ''}\u0000${area || ''}`)
    .digest('hex');
}

export const SOURCES = Object.freeze({
  decision: {
    table: 'claude_decision_log',
    select: 'id, decision_date, category, decision, rationale, workflow_code, workflow_name, area, origin, status',
    date: 'decision_date', status: 'status', origin: 'origin', severity: null,
    filter: (q) => q.neq('status', 'duplicate'),
  },
  issue: {
    table: 'claude_known_issues',
    select: 'id, reported_date, severity, category, description, impact, workflow_code, workflow_name, area, origin, status',
    date: 'reported_date', status: 'status', origin: 'origin', severity: 'severity',
    filter: (q) => q.neq('status', 'duplicate'),
  },
  session: {
    table: 'claude_session_logs',
    select: 'id, session_date, session_title, phase_focus, raw_summary, area, log_origin',
    date: 'session_date', status: null, origin: 'log_origin', severity: null,
    filter: (q) => q,
  },
  pending: {
    table: 'claude_pending_items',
    select: 'id, session_date, kind, item_type, description, ref, area, origin, status',
    date: 'session_date', status: 'status', origin: 'origin', severity: null,
    filter: (q) => q,
  },
});

/** Shape one source row into the claude_memory_embeddings row (minus embedding). */
export function toEmbeddingRow(kind, row) {
  const src = SOURCES[kind];
  const text = stripPii(memoryText(kind, row));
  const status = src.status ? (row[src.status] ?? null) : null;
  const area = row.area ?? null;
  return {
    source_table: src.table,
    source_id: row.id,
    content_hash: contentHash(text, status, area),
    embedded_text: text,
    area,
    origin: src.origin ? (row[src.origin] ?? null) : null,
    status,
    severity: src.severity ? (row[src.severity] ?? null) : null,
    category: row.category ?? null,
    row_date: row[src.date] ?? null,
  };
}
