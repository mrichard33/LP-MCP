/**
 * Call Moments — runtime — src/knowledge/ci-moments.js
 *
 *   runCiMomentsSweep()     eligible CI calls (transcribed + summarized, not yet
 *                           extracted) → one JSON extraction each via
 *                           llm-client fn 'ci_moments' → ci_moments rows →
 *                           homeowner side embedded.
 *   matchCiMoments()        match_ci_moments RPC (sql/079).
 *   runCallMomentsTier()    per-turn retrieval for buildKbPack. Never throws,
 *                           time-boxed, one audit row tier='ci_moments'.
 *   startCiMomentsSweep()   boot+90s, then every KB_CI_MOMENTS_SWEEP_INTERVAL_MS.
 *
 * Deliberately does NOT import tier1-semantic.js (that module imports
 * matchCiMoments from here for the objection classifier) — the audit insert is
 * local to avoid a module cycle.
 *
 * v1.0 — 2026-09-03. Initial.
 */

import supabase from '../supabase.js';
import { runSQL } from '../admin/supabase-admin.js';
import { callLLMJson } from '../llm-client.js';
import { embedBatch } from './openai-embeddings.js';
import { hashText } from './tier1-semantic-core.js';
import {
  PROMPT_VERSION,
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionUser,
  validateMoments,
  isEligibleCall,
  callWon,
  getKbCallMomentsMode,
} from './ci-moments-core.js';

const KB_CALL_MOMENTS_MIN_SIMILARITY   = parseFloat(process.env.KB_CALL_MOMENTS_MIN_SIMILARITY || '0.45');
const KB_CALL_MOMENTS_MATCH_COUNT      = parseInt(process.env.KB_CALL_MOMENTS_MATCH_COUNT || '2', 10);
const KB_CI_MOMENTS_BATCH              = parseInt(process.env.KB_CI_MOMENTS_BATCH || '40', 10);
const KB_CI_MOMENTS_SWEEP_INTERVAL_MS  = parseInt(process.env.KB_CI_MOMENTS_SWEEP_INTERVAL_MS || '900000', 10); // 15 min
const KB_CI_MOMENTS_MIN_TRANSCRIPT_CHARS = parseInt(process.env.KB_CI_MOMENTS_MIN_TRANSCRIPT_CHARS || '400', 10);
const KB_CI_MOMENTS_MAX_ATTEMPTS       = 3;
const KB_VECTOR_TIMEOUT_MS             = parseInt(process.env.KB_VECTOR_TIMEOUT_MS || '1500', 10);

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── Retrieval ──────────────────────────────────────────────────────

export async function matchCiMoments(queryEmbedding, { kind = null, wonOnly = true, limit = KB_CALL_MOMENTS_MATCH_COUNT, threshold = KB_CALL_MOMENTS_MIN_SIMILARITY } = {}) {
  if (!queryEmbedding || !Array.isArray(queryEmbedding.embedding)) return [];
  const { data, error } = await supabase.rpc('match_ci_moments', {
    query_embedding: queryEmbedding.embedding,
    p_kind: kind,
    p_won_only: wonOnly,
    match_threshold: threshold,
    match_count: limit,
  });
  if (error) throw new Error(`match_ci_moments: ${error.message}`);
  return data || [];
}

function logMomentQuery(row) {
  try {
    supabase.from('kb_vector_queries').insert(row)
      .then(({ error }) => { if (error) console.warn('[CiMoments] kb_vector_queries insert failed:', error.message); })
      .catch(() => {});
  } catch { /* best-effort */ }
}

export async function runCallMomentsTier(messageText, pack, mode, getQueryEmbedding) {
  const started = Date.now();
  let rows = [];
  let error = null;
  try {
    rows = await withTimeout(
      (async () => matchCiMoments(await getQueryEmbedding()))(),
      KB_VECTOR_TIMEOUT_MS,
      'ci moments',
    );
  } catch (err) {
    error = err.message;
  }
  const latency = Date.now() - started;
  const top = typeof rows[0]?.similarity === 'number' ? rows[0].similarity : null;
  console.log(
    `[CiMoments] ${mode}: intent=${pack.intent_class} matches=${rows.length}` +
    ` top_sim=${top === null ? 'n/a' : top.toFixed(3)} latency=${latency}ms` + (error ? ` error=${error}` : ''),
  );
  logMomentQuery({
    tier: 'ci_moments',
    intent_class: pack.intent_class,
    mode,
    query_text: String(messageText).slice(0, 500),
    match_count: rows.length,
    keyword_match_count: null,
    top_similarity: top,
    sources: rows.map((r) => ({ moment_id: r.id, kind: r.kind, objection_type: r.objection_type, call_won: r.call_won, resolved: r.resolved, similarity: r.similarity })),
    latency_ms: latency,
    error,
  });
  return rows;
}

// ── Extraction sweep ───────────────────────────────────────────────

const ELIGIBLE_SQL = `
  SELECT c.id AS call_id, c.direction, c.campaign, c.duration_seconds, c.agent_username, c.team, c.call_start,
         t.id AS transcript_id, t.transcript_text,
         s.outcome, (s.output->'quality'->>'transcript_intelligible')::boolean AS transcript_intelligible,
         COALESCE(x.attempts, 0) AS attempts
  FROM ci_calls c
  JOIN ci_transcripts t ON t.call_id = c.id
  JOIN ci_summaries s ON s.call_id = c.id AND s.is_current = true
  LEFT JOIN ci_moment_extractions x ON x.call_id = c.id
  WHERE (x.call_id IS NULL OR (x.status = 'failed' AND x.attempts < ${KB_CI_MOMENTS_MAX_ATTEMPTS}))
    AND s.outcome NOT IN ('no_meaningful_contact', 'wrong_number', 'dnc_request')
    AND LENGTH(COALESCE(t.transcript_text, '')) >= ${KB_CI_MOMENTS_MIN_TRANSCRIPT_CHARS}
  ORDER BY c.call_start DESC
  LIMIT ${KB_CI_MOMENTS_BATCH}`;

async function extractOne(row) {
  const { data, model, usage } = await callLLMJson({
    fn: 'ci_moments',
    system: EXTRACTION_SYSTEM_PROMPT,
    user: buildExtractionUser(row.transcript_text, { campaign: row.campaign, outcome: row.outcome, duration_seconds: row.duration_seconds }),
    maxTokens: 1200,
    temperature: 0,
  });
  const moments = validateMoments(data);
  const won = callWon(row.outcome);
  const rows = moments.map((m, i) => ({
    call_id: row.call_id,
    transcript_id: row.transcript_id,
    moment_index: i,
    kind: m.kind,
    objection_type: m.objection_type,
    customer_said: m.customer_said,
    agent_said: m.agent_said,
    resolved: m.resolved,
    confidence: m.confidence,
    call_outcome: row.outcome,
    call_won: won,
    agent_username: row.agent_username,
    team: row.team,
    campaign: row.campaign,
    call_start: row.call_start,
    extractor_model: model,
    prompt_version: PROMPT_VERSION,
  }));
  if (rows.length > 0) {
    const { error } = await supabase.from('ci_moments').upsert(rows, { onConflict: 'call_id,moment_index' });
    if (error) throw new Error(`ci_moments upsert: ${error.message}`);
  }
  return { moments: rows.length, model, usage };
}

async function recordExtraction(callId, patch) {
  const { error } = await supabase.from('ci_moment_extractions').upsert(
    { call_id: callId, ...patch, updated_at: new Date().toISOString() },
    { onConflict: 'call_id' },
  );
  if (error) console.warn('[CiMoments] ci_moment_extractions upsert failed:', error.message);
}

export async function runCiMomentsSweep(reason = 'interval') {
  const started = Date.now();
  const summary = { reason, candidates: 0, extracted: 0, skipped: 0, failed: 0, moments: 0, embedded: 0, error: null };
  try {
    const candidates = await runSQL(ELIGIBLE_SQL);
    summary.candidates = Array.isArray(candidates) ? candidates.length : 0;
    for (const row of candidates || []) {
      if (!isEligibleCall(row, KB_CI_MOMENTS_MIN_TRANSCRIPT_CHARS)) {
        await recordExtraction(row.call_id, { status: 'skipped', attempts: (row.attempts || 0) + 1, moments: 0, error: 'ineligible', model: null, prompt_version: PROMPT_VERSION });
        summary.skipped++;
        continue;
      }
      try {
        const r = await extractOne(row);
        await recordExtraction(row.call_id, { status: 'done', attempts: (row.attempts || 0) + 1, moments: r.moments, error: null, model: r.model, prompt_version: PROMPT_VERSION });
        summary.extracted++;
        summary.moments += r.moments;
      } catch (err) {
        await recordExtraction(row.call_id, { status: 'failed', attempts: (row.attempts || 0) + 1, moments: 0, error: String(err.message).slice(0, 500), model: null, prompt_version: PROMPT_VERSION });
        summary.failed++;
      }
    }

    // Embed the homeowner side of anything not yet embedded.
    const { data: toEmbed } = await supabase
      .from('ci_moments').select('id, customer_said').is('embedding', null).eq('active', true).limit(500);
    for (let i = 0; i < (toEmbed || []).length; i += 200) {
      const batch = toEmbed.slice(i, i + 200);
      const { embeddings } = await embedBatch(batch.map((r) => r.customer_said));
      for (let j = 0; j < batch.length; j++) {
        const { error } = await supabase.from('ci_moments')
          .update({ embedding: embeddings[j], embedding_hash: hashText(batch[j].customer_said) })
          .eq('id', batch[j].id);
        if (!error) summary.embedded++;
      }
    }
  } catch (err) {
    summary.error = err.message;
  }
  console.log(`[CiMoments] sweep(${reason}) ${Date.now() - started}ms`, JSON.stringify(summary));
  return summary;
}

export function startCiMomentsSweep() {
  if (getKbCallMomentsMode() === 'off') {
    console.log('[CiMoments] sweep disabled (KB_CALL_MOMENTS_MODE=off)');
    return null;
  }
  const first = setTimeout(() => { runCiMomentsSweep('boot'); }, 90_000);
  if (typeof first.unref === 'function') first.unref();
  const interval = setInterval(() => { runCiMomentsSweep('interval'); }, KB_CI_MOMENTS_SWEEP_INTERVAL_MS);
  if (typeof interval.unref === 'function') interval.unref();
  console.log(`[CiMoments] sweep scheduled: boot+90s, then every ${KB_CI_MOMENTS_SWEEP_INTERVAL_MS}ms, batch ${KB_CI_MOMENTS_BATCH}`);
  return interval;
}
