/**
 * Bot Review — fingerprint writer — src/bot-feedback/fingerprint.js
 *
 * v1.0 — 2026-09-11. BOT REVIEW PHASE 0.
 *   PROBLEM: see fingerprint-core.js. This file is the I/O half.
 *   FIX: recordMessageContext() writes one bot_message_context row per reply,
 *   skip or nurture send; markSent() stamps sent_at once the send lands.
 *
 * NOTHING HERE MAY BLOCK, DELAY OR ALTER A LIVE SEND (handoff §1.7).
 * Every export is fire-and-forget:
 *   - the promise is never awaited by a call site on the send path
 *   - an internal 200ms timeout caps how long the write can hold a socket
 *   - every failure is caught and logged; nothing throws outward
 *   - a missing relation (sql/103 not applied yet) logs ONCE per process
 *
 * Idempotency: bot_message_context has UNIQUE (message_type, message_ref), so
 * a retried action upserts onto its own row instead of duplicating. Retries
 * carry a fresher snapshot, so the upsert overwrites (the last generation is
 * the one that was sent).
 */

import supabase from '../supabase.js';
import {
  buildContextRow,
  getFingerprintMode,
  isMissingRelation,
} from './fingerprint-core.js';

/** Hard cap on how long a fingerprint write may take. Handoff §5.1. */
const WRITE_TIMEOUT_MS = Number(process.env.BOT_FINGERPRINT_TIMEOUT_MS || 200);

/** Log the missing-relation warning once per process, not once per send. */
let missingRelationLogged = false;
function noteMissingRelation(where) {
  if (missingRelationLogged) return;
  missingRelationLogged = true;
  console.warn(
    `[BotFingerprint] bot_message_context is absent (${where}) — apply sql/103_bot_feedback_core.sql ` +
    'in the LP Supabase SQL editor. Fingerprinting is skipped until then; sends are unaffected.',
  );
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Write one fingerprint row. Fire-and-forget: call it WITHOUT await on any
 * path that leads to a send.
 *
 * @param {object} input  see fingerprint-core.buildContextRow
 * @returns {Promise<{ok: boolean, id?: number, reason?: string}>} never rejects
 */
export async function recordMessageContext(input) {
  if (getFingerprintMode() === 'off') return { ok: false, reason: 'mode_off' };
  if (!supabase) return { ok: false, reason: 'no_supabase' };

  const row = buildContextRow(input);
  if (!row) return { ok: false, reason: 'unusable_input' };

  try {
    const { data, error } = await withTimeout(
      supabase
        .from('bot_message_context')
        .upsert(row, { onConflict: 'message_type,message_ref' })
        .select('id')
        .single(),
      WRITE_TIMEOUT_MS,
      'bot_message_context upsert',
    );

    if (error) {
      if (isMissingRelation(error)) {
        noteMissingRelation('insert');
        return { ok: false, reason: 'missing_relation' };
      }
      console.warn(`[BotFingerprint] ${row.message_type} ${row.message_ref} write failed: ${error.message}`);
      return { ok: false, reason: error.message };
    }

    return { ok: true, id: data?.id ?? null };
  } catch (err) {
    console.warn(`[BotFingerprint] ${row.message_type} ${row.message_ref} threw: ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

/**
 * Stamp sent_at on an existing fingerprint once the send lands. Second
 * best-effort write (handoff §5.1) — also fire-and-forget.
 */
export async function markSent(messageType, messageRef, sentAt = new Date().toISOString()) {
  if (getFingerprintMode() === 'off') return { ok: false, reason: 'mode_off' };
  if (!supabase || !messageRef) return { ok: false, reason: 'unusable_input' };

  try {
    const { error } = await withTimeout(
      supabase
        .from('bot_message_context')
        .update({ sent_at: sentAt })
        .eq('message_type', messageType)
        .eq('message_ref', String(messageRef)),
      WRITE_TIMEOUT_MS,
      'bot_message_context sent_at',
    );
    if (error) {
      if (isMissingRelation(error)) { noteMissingRelation('sent_at'); return { ok: false, reason: 'missing_relation' }; }
      console.warn(`[BotFingerprint] sent_at ${messageType} ${messageRef} failed: ${error.message}`);
      return { ok: false, reason: error.message };
    }
    return { ok: true };
  } catch (err) {
    console.warn(`[BotFingerprint] sent_at ${messageType} ${messageRef} threw: ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

/**
 * The one call the send path makes. Detached on purpose: it returns
 * immediately and the write settles on its own microtask, so no send can be
 * delayed by it even if Supabase is slow and the 200ms race is the thing that
 * resolves.
 */
export function recordMessageContextDetached(input) {
  try {
    recordMessageContext(input).catch(() => {});
  } catch (err) {
    console.warn(`[BotFingerprint] detached record threw synchronously: ${err.message}`);
  }
}

/** Detached sent_at stamp. Same contract as above. */
export function markSentDetached(messageType, messageRef, sentAt) {
  try {
    markSent(messageType, messageRef, sentAt).catch(() => {});
  } catch (err) {
    console.warn(`[BotFingerprint] detached sent_at threw synchronously: ${err.message}`);
  }
}

export default {
  recordMessageContext,
  recordMessageContextDetached,
  markSent,
  markSentDetached,
};
