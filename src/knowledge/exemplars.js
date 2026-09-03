/**
 * Exemplars — runtime — src/knowledge/exemplars.js
 *
 * Builds and serves the past-win exemplar corpus (kb-retriever.js v1.11).
 *
 *   buildExemplarsSweep()  HL Supabase (messages, appointments) → LP kb_exemplars.
 *                          Pairs each inbound lead message with the first
 *                          outbound reply within 24 h, labels the outcome from
 *                          appointments added within KB_EXEMPLAR_OUTCOME_WINDOW_DAYS,
 *                          scrubs PII, embeds the LEAD side, relabels 'pending'.
 *   matchExemplars()       match_kb_exemplars RPC (sql/078).
 *   runExemplarTier()      per-turn retrieval used by buildKbPack; never throws,
 *                          never blocks past KB_VECTOR_TIMEOUT_MS; logs to
 *                          kb_vector_queries tier='kb_exemplars'.
 *   startExemplarSweep()   boot+60s, then every KB_EXEMPLAR_SWEEP_INTERVAL_MS.
 *
 * The two Supabase projects cannot be joined in SQL (see src/admin/hl-client.js),
 * so the sweep fetches from HL and joins in JS.
 *
 * v1.0 — 2026-09-03. Initial.
 */

import supabase from '../supabase.js';
import { hlRunSQL, esc } from '../admin/hl-client.js';
import { embedBatch } from './openai-embeddings.js';
import { hashText } from './tier1-semantic-core.js';
import { logKbQuery } from './tier1-semantic.js';
import {
  CHANNEL_BY_GHL_TYPE,
  normalizeBody,
  isUsableReply,
  isUsableInbound,
  scrubPii,
  dropTemplatedReplies,
  labelOutcome,
  withTimeout,
} from './exemplars-core.js';

const KB_EXEMPLAR_MIN_SIMILARITY      = parseFloat(process.env.KB_EXEMPLAR_MIN_SIMILARITY || '0.45');
const KB_EXEMPLAR_MATCH_COUNT         = parseInt(process.env.KB_EXEMPLAR_MATCH_COUNT || '2', 10);
const KB_EXEMPLAR_OUTCOME_WINDOW_DAYS = parseInt(process.env.KB_EXEMPLAR_OUTCOME_WINDOW_DAYS || '14', 10);
const KB_EXEMPLAR_BACKFILL_DAYS       = parseInt(process.env.KB_EXEMPLAR_BACKFILL_DAYS || '120', 10);
const KB_EXEMPLAR_SWEEP_INTERVAL_MS   = parseInt(process.env.KB_EXEMPLAR_SWEEP_INTERVAL_MS || '21600000', 10);
const KB_VECTOR_TIMEOUT_MS            = parseInt(process.env.KB_VECTOR_TIMEOUT_MS || '1500', 10);
const EMBED_BATCH = 200;

// ── Retrieval ──────────────────────────────────────────────────────

export async function matchExemplars(queryEmbedding, { limit = KB_EXEMPLAR_MATCH_COUNT, threshold = KB_EXEMPLAR_MIN_SIMILARITY, wonOnly = true } = {}) {
  if (!queryEmbedding || !Array.isArray(queryEmbedding.embedding)) return [];
  const { data, error } = await supabase.rpc('match_kb_exemplars', {
    query_embedding: queryEmbedding.embedding,
    p_channel: null,
    p_won_only: wonOnly,
    match_threshold: threshold,
    match_count: limit,
  });
  if (error) throw new Error(`match_kb_exemplars: ${error.message}`);
  return data || [];
}

/**
 * Per-turn tier. Mirrors runVectorTier in kb-retriever.js: never throws,
 * time-boxed, one audit row. Returns [] on any failure.
 */
export async function runExemplarTier(messageText, pack, mode, getQueryEmbedding) {
  const started = Date.now();
  let rows = [];
  let error = null;
  try {
    rows = await withTimeout(
      (async () => matchExemplars(await getQueryEmbedding()))(),
      KB_VECTOR_TIMEOUT_MS,
      'kb exemplars',
    );
  } catch (err) {
    error = err.message;
  }
  const latency = Date.now() - started;
  const top = typeof rows[0]?.similarity === 'number' ? rows[0].similarity : null;
  console.log(
    `[Exemplars] ${mode}: intent=${pack.intent_class} matches=${rows.length}` +
    ` top_sim=${top === null ? 'n/a' : top.toFixed(3)} latency=${latency}ms` +
    (error ? ` error=${error}` : ''),
  );
  logKbQuery({
    tier: 'kb_exemplars',
    intent_class: pack.intent_class,
    mode,
    query_text: String(messageText).slice(0, 500),
    match_count: rows.length,
    keyword_match_count: null,
    top_similarity: top,
    sources: rows.map((r) => ({
      exemplar_id: r.id,
      outcome: r.outcome,
      channel: r.channel,
      reply_source: r.reply_source,
      similarity: r.similarity,
    })),
    latency_ms: latency,
    error,
  });
  return rows;
}

// ── Corpus sweep ───────────────────────────────────────────────────

function pairSql(sinceIso) {
  // First outbound within 24 h of the inbound = the reply. Last outbound in the
  // 7 days before = what we had said (context only, not embedded).
  return `
    SELECT COALESCE(i.ghl_message_id, i.id::text) AS inbound_message_id,
           i.ghl_contact_id, i.type, i.body AS inbound_text, i.sent_at AS inbound_sent_at,
           r.body AS reply_text, r.sent_at AS reply_sent_at,
           p.body AS prior_outbound
    FROM messages i
    JOIN LATERAL (
      SELECT o.body, o.sent_at FROM messages o
      WHERE o.ghl_contact_id = i.ghl_contact_id AND o.direction = 'outbound' AND o.deleted_at IS NULL
        AND o.type IN ('2','3','29')
        AND o.sent_at > i.sent_at AND o.sent_at <= i.sent_at + interval '24 hours'
        AND LENGTH(COALESCE(o.body, '')) BETWEEN 20 AND 900
      ORDER BY o.sent_at ASC LIMIT 1
    ) r ON true
    LEFT JOIN LATERAL (
      SELECT o.body FROM messages o
      WHERE o.ghl_contact_id = i.ghl_contact_id AND o.direction = 'outbound' AND o.deleted_at IS NULL
        AND o.type IN ('2','3','29')
        AND o.sent_at < i.sent_at AND o.sent_at >= i.sent_at - interval '7 days'
      ORDER BY o.sent_at DESC LIMIT 1
    ) p ON true
    WHERE i.direction = 'inbound' AND i.deleted_at IS NULL AND i.type IN ('2','3','29')
      AND i.sent_at >= '${esc(sinceIso)}'
      AND LENGTH(COALESCE(i.body, '')) BETWEEN 8 AND 1500
    ORDER BY i.sent_at ASC
    LIMIT 5000`;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function fetchAppointmentsByContact(contactIds) {
  const byContact = new Map();
  for (const ids of chunk([...new Set(contactIds)], 200)) {
    const list = ids.map((id) => `'${esc(id)}'`).join(',');
    const rows = await hlRunSQL(`
      SELECT ghl_contact_id, status, raw_json->>'dateAdded' AS date_added
      FROM appointments WHERE deleted_at IS NULL AND ghl_contact_id IN (${list})`);
    for (const r of rows) {
      if (!byContact.has(r.ghl_contact_id)) byContact.set(r.ghl_contact_id, []);
      byContact.get(r.ghl_contact_id).push(r);
    }
  }
  return byContact;
}

/** Best-effort: a reply whose body matches a scored agentic message for the same contact is 'bot'. */
async function fetchBotBodies(contactIds) {
  const keys = new Set();
  for (const ids of chunk([...new Set(contactIds)], 200)) {
    const { data, error } = await supabase
      .from('message_scores')
      .select('contact_id, message_text')
      .in('contact_id', ids);
    if (error) { console.warn('[Exemplars] message_scores read failed (attribution → other):', error.message); return keys; }
    for (const r of data || []) keys.add(`${r.contact_id}|${normalizeBody(r.message_text)}`);
  }
  return keys;
}

export async function buildExemplarsSweep(reason = 'interval') {
  const started = Date.now();
  const summary = { reason, fetched: 0, usable: 0, inserted: 0, relabeled: 0, embedded: 0, error: null };
  try {
    // 1. Window: re-read the last 2 days so late replies get paired; first run backfills.
    const { data: maxRow, error: maxErr } = await supabase
      .from('kb_exemplars').select('inbound_sent_at').order('inbound_sent_at', { ascending: false }).limit(1);
    if (maxErr) throw new Error(`kb_exemplars read failed (sql/078 applied?): ${maxErr.message}`);
    const since = maxRow?.[0]?.inbound_sent_at
      ? new Date(new Date(maxRow[0].inbound_sent_at).getTime() - 2 * 86_400_000)
      : new Date(Date.now() - KB_EXEMPLAR_BACKFILL_DAYS * 86_400_000);

    // 2. Pairs from HL.
    const raw = await hlRunSQL(pairSql(since.toISOString()));
    summary.fetched = raw.length;
    let pairs = raw.filter((p) => isUsableInbound(p.inbound_text) && isUsableReply(p.reply_text) && CHANNEL_BY_GHL_TYPE[p.type]);
    pairs = dropTemplatedReplies(pairs, 3);
    summary.usable = pairs.length;

    // 3. Skip what we already hold.
    const { data: existing } = await supabase
      .from('kb_exemplars').select('inbound_message_id').gte('inbound_sent_at', since.toISOString());
    const have = new Set((existing || []).map((r) => r.inbound_message_id));
    pairs = pairs.filter((p) => !have.has(p.inbound_message_id));

    if (pairs.length > 0) {
      const contacts = pairs.map((p) => p.ghl_contact_id);
      const [apptsByContact, botKeys] = await Promise.all([fetchAppointmentsByContact(contacts), fetchBotBodies(contacts)]);
      const now = new Date();
      const rows = pairs.map((p) => {
        const { outcome, outcome_at } = labelOutcome(apptsByContact.get(p.ghl_contact_id) || [], p.inbound_sent_at, now, KB_EXEMPLAR_OUTCOME_WINDOW_DAYS);
        return {
          inbound_message_id: p.inbound_message_id,
          ghl_contact_id: p.ghl_contact_id,
          channel: CHANNEL_BY_GHL_TYPE[p.type],
          prior_outbound: p.prior_outbound ? scrubPii(p.prior_outbound).slice(0, 400) : null,
          inbound_text: scrubPii(p.inbound_text),
          reply_text: scrubPii(p.reply_text),
          reply_source: botKeys.has(`${p.ghl_contact_id}|${normalizeBody(p.reply_text)}`) ? 'bot' : 'other',
          inbound_sent_at: p.inbound_sent_at,
          reply_sent_at: p.reply_sent_at,
          outcome,
          outcome_at,
        };
      });
      for (const batch of chunk(rows, 500)) {
        const { error } = await supabase.from('kb_exemplars').upsert(batch, { onConflict: 'inbound_message_id', ignoreDuplicates: true });
        if (error) console.warn('[Exemplars] upsert failed:', error.message);
        else summary.inserted += batch.length;
      }
    }

    // 4. Relabel rows whose outcome window was still open.
    const { data: pending } = await supabase
      .from('kb_exemplars').select('id, ghl_contact_id, inbound_sent_at').eq('outcome', 'pending').limit(2000);
    if (pending && pending.length > 0) {
      const apptsByContact = await fetchAppointmentsByContact(pending.map((r) => r.ghl_contact_id));
      const now = new Date();
      for (const r of pending) {
        const next = labelOutcome(apptsByContact.get(r.ghl_contact_id) || [], r.inbound_sent_at, now, KB_EXEMPLAR_OUTCOME_WINDOW_DAYS);
        if (next.outcome === 'pending') continue;
        const { error } = await supabase.from('kb_exemplars')
          .update({ outcome: next.outcome, outcome_at: next.outcome_at, updated_at: new Date().toISOString() }).eq('id', r.id);
        if (!error) summary.relabeled++;
      }
    }

    // 5. Embed the lead side of anything not yet embedded (hash guards re-embeds).
    const { data: toEmbed } = await supabase
      .from('kb_exemplars').select('id, inbound_text, embedding_hash').is('embedding', null).eq('active', true).limit(1000);
    for (const batch of chunk(toEmbed || [], EMBED_BATCH)) {
      const { embeddings } = await embedBatch(batch.map((r) => r.inbound_text));
      for (let i = 0; i < batch.length; i++) {
        const { error } = await supabase.from('kb_exemplars')
          .update({ embedding: embeddings[i], embedding_hash: hashText(batch[i].inbound_text), updated_at: new Date().toISOString() })
          .eq('id', batch[i].id);
        if (!error) summary.embedded++;
      }
    }
  } catch (err) {
    summary.error = err.message;
  }
  console.log(`[Exemplars] sweep(${reason}) ${Date.now() - started}ms`, JSON.stringify(summary));
  return summary;
}

export function startExemplarSweep(getMode) {
  const mode = typeof getMode === 'function' ? getMode() : String(process.env.KB_EXEMPLAR_MODE || 'off').toLowerCase().trim();
  if (mode === 'off' || !['shadow', 'live'].includes(mode)) {
    console.log('[Exemplars] sweep disabled (KB_EXEMPLAR_MODE=off)');
    return null;
  }
  const first = setTimeout(() => { buildExemplarsSweep('boot'); }, 60_000);
  if (typeof first.unref === 'function') first.unref();
  const interval = setInterval(() => { buildExemplarsSweep('interval'); }, KB_EXEMPLAR_SWEEP_INTERVAL_MS);
  if (typeof interval.unref === 'function') interval.unref();
  console.log(`[Exemplars] sweep scheduled: boot+60s, then every ${KB_EXEMPLAR_SWEEP_INTERVAL_MS}ms`);
  return interval;
}
