/**
 * Bot Review — outcomes sync job — src/bot-feedback/outcomes.js
 *
 * v1.0 — 2026-09-11. BOT REVIEW PHASE 0.
 *   syncOutcomes() runs every 30 min (n8n → POST /api/bot-feedback/jobs/outcomes)
 *   and fills bot_outcomes for every fingerprinted send in the last 8 days that
 *   is not yet final. Rules live in outcomes-core.js; this file is the I/O.
 *
 * CROSS-DB (handoff §1.3): LP rows are fetched from the LP client, HL rows from
 * a separate HL client. They are matched in code — never joined, never mixed in
 * one query. The HL client helper mirrors services/link-corroboration.js.
 *
 * Degrades on everything: no HL credentials, a stale cache, or sql/103 not yet
 * applied all produce a clean skip with a logged reason, never a throw. This
 * job is off the send path entirely, so nothing here can delay a reply.
 */

import { createClient } from '@supabase/supabase-js';
import supabase from '../supabase.js';
import { isMissingRelation } from './fingerprint-core.js';
import {
  FRESHNESS_MAX_AGE_MS,
  SCAN_LOOKBACK_MS,
  computeOutcome,
  isSourceFresh,
} from './outcomes-core.js';

/** How many fingerprints one run will reconcile. Keeps a 30-min tick bounded. */
const BATCH_LIMIT = Number(process.env.BOT_OUTCOMES_BATCH_LIMIT || 500);

// ─── HL cache client (read-only; separate Supabase, never joined to LP) ─────
let hlClient = null;
let hlClientMissing = false;
function hlSupabase() {
  if (hlClient) return hlClient;
  if (hlClientMissing) return null;
  const url = process.env.HL_SUPABASE_URL;
  const key = process.env.HL_SUPABASE_SERVICE_ROLE_KEY || process.env.HL_SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    hlClientMissing = true;
    console.warn('[BotOutcomes] HL_SUPABASE_URL / HL_SUPABASE_SERVICE_ROLE_KEY unset — outcomes cannot be computed.');
    return null;
  }
  hlClient = createClient(url, key);
  return hlClient;
}

/**
 * HL sync freshness for the two entities outcomes depend on. Read FIRST
 * (handoff §5.1): if messages or appointments are >2h stale, nothing computed
 * this run may be finalized.
 */
export async function readHlFreshness(hl, now = Date.now()) {
  const { data, error } = await hl
    .from('sync_state')
    .select('entity_name, last_synced_at')
    .in('entity_name', ['messages', 'appointments']);

  if (error) return { fresh: false, ages: {}, error: error.message };

  const ages = {};
  for (const row of data ?? []) ages[row.entity_name] = row.last_synced_at;
  const haveBoth = ages.messages != null && ages.appointments != null;

  return {
    fresh: haveBoth && isSourceFresh(ages, now, FRESHNESS_MAX_AGE_MS),
    ages,
    error: null,
  };
}

/**
 * Reconcile outcomes for recently sent bot messages.
 *
 * @returns {Promise<object>} a summary — never throws
 */
export async function syncOutcomes({ now = Date.now(), limit = BATCH_LIMIT } = {}) {
  const startedAt = new Date(now).toISOString();
  if (!supabase) return { ok: false, reason: 'no_lp_supabase', started_at: startedAt };

  const hl = hlSupabase();
  if (!hl) return { ok: false, reason: 'no_hl_supabase', started_at: startedAt };

  // 1. Freshness first — it decides whether anything may be finalized.
  const freshness = await readHlFreshness(hl, now);
  if (freshness.error) {
    console.warn(`[BotOutcomes] HL sync_state unreadable: ${freshness.error}`);
  }
  if (!freshness.fresh) {
    console.warn(
      `[BotOutcomes] HL cache is stale or unknown (messages=${freshness.ages.messages ?? 'n/a'}, ` +
      `appointments=${freshness.ages.appointments ?? 'n/a'}) — computing anyway, nothing will be finalized.`,
    );
  }

  // 2. Candidate sends: fingerprinted, actually sent, inside the 8-day window.
  const since = new Date(now - SCAN_LOOKBACK_MS).toISOString();
  const { data: contexts, error: ctxError } = await supabase
    .from('bot_message_context')
    .select('message_type, message_ref, ghl_contact_id, sent_at')
    .not('sent_at', 'is', null)
    .gte('sent_at', since)
    .order('sent_at', { ascending: true })
    .limit(limit);

  if (ctxError) {
    if (isMissingRelation(ctxError)) {
      console.warn('[BotOutcomes] bot_message_context absent — apply sql/103_bot_feedback_core.sql. Skipping.');
      return { ok: false, reason: 'missing_relation', started_at: startedAt };
    }
    console.error(`[BotOutcomes] context read failed: ${ctxError.message}`);
    return { ok: false, reason: ctxError.message, started_at: startedAt };
  }

  if (!contexts?.length) {
    return { ok: true, scanned: 0, written: 0, finalized: 0, source_fresh: freshness.fresh, started_at: startedAt };
  }

  // 3. Drop the ones already settled — a final row is never recomputed.
  const { data: existing, error: outError } = await supabase
    .from('bot_outcomes')
    .select('message_type, message_ref, final')
    .gte('sent_at', since);

  if (outError && !isMissingRelation(outError)) {
    console.error(`[BotOutcomes] bot_outcomes read failed: ${outError.message}`);
    return { ok: false, reason: outError.message, started_at: startedAt };
  }
  if (outError) {
    console.warn('[BotOutcomes] bot_outcomes absent — apply sql/103_bot_feedback_core.sql. Skipping.');
    return { ok: false, reason: 'missing_relation', started_at: startedAt };
  }

  const finalKeys = new Set((existing ?? []).filter((r) => r.final).map((r) => `${r.message_type}::${r.message_ref}`));
  const pending = contexts.filter((c) => !finalKeys.has(`${c.message_type}::${c.message_ref}`));
  if (!pending.length) {
    return { ok: true, scanned: contexts.length, written: 0, finalized: 0, source_fresh: freshness.fresh, started_at: startedAt };
  }

  // 4. One HL read per entity for the whole batch, then match in code.
  const contactIds = [...new Set(pending.map((c) => c.ghl_contact_id).filter(Boolean))];
  if (!contactIds.length) {
    return { ok: true, scanned: contexts.length, written: 0, finalized: 0, source_fresh: freshness.fresh, started_at: startedAt };
  }

  const earliest = new Date(Math.min(...pending.map((c) => Date.parse(c.sent_at)))).toISOString();

  const [msgRes, apptRes, contactRes] = await Promise.all([
    hl.from('messages')
      .select('ghl_contact_id, direction, body, sent_at, created_at')
      .in('ghl_contact_id', contactIds)
      .eq('direction', 'inbound')
      .gte('created_at', earliest)
      .is('deleted_at', null),
    hl.from('appointments')
      .select('ghl_contact_id, raw_json, created_at, deleted_at')
      .in('ghl_contact_id', contactIds)
      .gte('created_at', earliest)
      .is('deleted_at', null),
    hl.from('contacts')
      .select('ghl_contact_id, tags, date_updated, updated_at, synced_at')
      .in('ghl_contact_id', contactIds)
      .is('deleted_at', null),
  ]);

  for (const [label, res] of [['messages', msgRes], ['appointments', apptRes], ['contacts', contactRes]]) {
    if (res.error) {
      console.error(`[BotOutcomes] HL ${label} read failed: ${res.error.message}`);
      return { ok: false, reason: `hl_${label}: ${res.error.message}`, started_at: startedAt };
    }
  }

  const byContact = (rows) => {
    const map = new Map();
    for (const r of rows ?? []) {
      const k = r.ghl_contact_id;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    return map;
  };
  const messagesBy = byContact(msgRes.data);
  const apptsBy = byContact(apptRes.data);
  const contactBy = new Map((contactRes.data ?? []).map((c) => [c.ghl_contact_id, c]));

  // 5. Compute + upsert.
  const rows = [];
  for (const ctx of pending) {
    const row = computeOutcome({
      context: ctx,
      messages: messagesBy.get(ctx.ghl_contact_id) ?? [],
      appointments: apptsBy.get(ctx.ghl_contact_id) ?? [],
      contact: contactBy.get(ctx.ghl_contact_id) ?? null,
      sourceFresh: freshness.fresh,
      now,
    });
    if (row) rows.push(row);
  }

  let written = 0;
  const finalized = rows.filter((r) => r.final).length;
  if (rows.length) {
    const { error: upsertError } = await supabase
      .from('bot_outcomes')
      .upsert(rows, { onConflict: 'message_type,message_ref' });
    if (upsertError) {
      console.error(`[BotOutcomes] upsert failed: ${upsertError.message}`);
      return { ok: false, reason: upsertError.message, started_at: startedAt };
    }
    written = rows.length;
  }

  const summary = {
    ok: true,
    scanned: contexts.length,
    pending: pending.length,
    written,
    finalized,
    source_fresh: freshness.fresh,
    hl_last_synced: freshness.ages,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
  console.log(
    `[BotOutcomes] scanned=${summary.scanned} pending=${summary.pending} written=${written} ` +
    `finalized=${finalized} source_fresh=${freshness.fresh}`,
  );
  return summary;
}

export default { syncOutcomes, readHlFreshness };
