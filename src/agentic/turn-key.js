// ─── The turn key — src/agentic/turn-key.js ─────────────────────────────────
//
// WHY (Phase 1, architecture review 2026-10-17, cause 4)
//   Four Decision Engine rules can answer one SMS (106, 161, 228, 373) and a
//   rule-written send (DQ_*, SERVICE_AREA_EXIT) can re-fire with no new inbound.
//   Teresa (wfLR6b1NLFOKXORAAFB9, 2026-10-18 06:44) got a second DQ reply with
//   no new text; Shawn (2026-10-15) and Paul (2026-10-17) got two replies to one
//   text. The turn lock (turn-lock.js) lets exactly one path answer an inbound,
//   and this is the name of that inbound: its GHL message id when there is one,
//   else a hash of its text read the way the duplicate_inbound_text check reads
//   it (#1357), so "\\n\\n" and a real newline are the same message.
//
// ONE normaliser (normalizeInbound) for both: missed-inbound.js re-exports it as
// normalizeText, which burst-yield.js and the inbound sweep use.
//
// PURE. No I/O.

import { createHash } from 'node:crypto';

/**
 * An inbound's text for comparison: literal "\n" / "\r" / "\t" escapes (single
 * or doubled) and non-breaking spaces read as spaces, whitespace collapsed,
 * trimmed, lowercased. Pure.
 */
export function normalizeInbound(text) {
  return String(text ?? '')
    .replace(/\\\\[nrt]|\\[nrt]/g, ' ')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

/** sha256 hex of the normalised text, prefixed so it never looks like a message id; null for empty text. Pure. */
export function textTurnKey(text) {
  const n = normalizeInbound(text);
  if (!n) return null;
  return `txt:${createHash('sha256').update(n, 'utf8').digest('hex')}`;
}

/** A GHL message id as a turn key, or null. Pure. */
export function messageTurnKey(messageId) {
  const id = String(messageId ?? '').trim();
  return id ? `msg:${id}` : null;
}

/**
 * The turn key for an inbound: the message id when there is one, else the
 * text hash, else null (the caller then claims the LAST inbound). Pure.
 * @param {{ messageId?: string|null, text?: string|null }} inbound
 */
export function turnKeyFor({ messageId = null, text = null } = {}) {
  return messageTurnKey(messageId) || textTurnKey(text);
}

export default { normalizeInbound, textTurnKey, messageTurnKey, turnKeyFor };
