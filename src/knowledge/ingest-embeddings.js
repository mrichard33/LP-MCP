/**
 * KB Ingestion — src/knowledge/ingest-embeddings.js
 *
 * Ingests source-document text into the kb_embeddings table for vector
 * search. Chunks → embeds → inserts → logs to kb_embeddings_ingestion_log.
 *
 * Idempotent: pass `replace: true` to soft-delete existing chunks for a
 * source_doc before ingesting new ones.
 *
 * Source document conventions (recommend):
 *   - 'antifragile_v3'             — Antifragile Sales System spec
 *   - 'dotcom_secrets'             — Dotcom Secrets relevant chapters
 *   - 'technique_T01_relevance'    — Per-technique docs
 *   - 'product_spec_pgt_winguard'  — Per-product spec sheets
 *   - 'training_call_2026_02_14'   — Transcribed training calls
 *   - 'objection_w90_branch_price' — W9.0 step content exports
 *
 * Use raw text input. PDF / DOCX parsing is the caller's responsibility
 * (use pdf-parse, mammoth, etc. upstream).
 *
 * v1.0 — Initial implementation.
 */

import supabase from '../supabase.js';
import { embedBatch, chunkText, estimateTokens } from './openai-embeddings.js';

const DEFAULT_TARGET_TOKENS = 500;
const DEFAULT_OVERLAP_TOKENS = 50;
const INSERT_BATCH_SIZE = 100;

// ═══════════════════════════════════════════════════════════════════
// CORE INGESTION
// ═══════════════════════════════════════════════════════════════════

/**
 * Ingest a document into kb_embeddings.
 *
 * @param {Object} params
 * @param {string} params.text — Full document text
 * @param {string} params.source_doc — Identifier (e.g. 'antifragile_v3')
 * @param {string} [params.source_doc_version] — For re-ingest tracking
 * @param {string} [params.source_section] — Section/chapter label applied to all chunks
 * @param {Object} [params.metadata] — JSONB metadata applied to all chunks (e.g. {story_arc: 'SA1'})
 * @param {boolean} [params.replace=false] — Soft-delete existing chunks for this source_doc first
 * @param {number} [params.targetTokens=500]
 * @param {number} [params.overlapTokens=50]
 * @param {string} [params.ingestedBy='manual'] — 'manual' | 'cron' | 'claude'
 * @returns {Promise<{chunks_added, chunks_replaced, total_tokens, embed_cost_usd, duration_ms}>}
 */
export async function ingestDocument(params) {
  const {
    text,
    source_doc,
    source_doc_version = null,
    source_section = null,
    metadata = {},
    replace = false,
    targetTokens = DEFAULT_TARGET_TOKENS,
    overlapTokens = DEFAULT_OVERLAP_TOKENS,
    ingestedBy = 'manual',
  } = params;

  if (!text || typeof text !== 'string') {
    throw new Error('ingestDocument requires non-empty text');
  }
  if (!source_doc || typeof source_doc !== 'string') {
    throw new Error('ingestDocument requires source_doc identifier');
  }

  const t0 = Date.now();
  let chunksReplaced = 0;

  // Step 1: Optional replace — soft-delete existing chunks
  if (replace) {
    const { count, error: delError } = await supabase
      .from('kb_embeddings')
      .update({ active: false })
      .eq('source_doc', source_doc)
      .eq('active', true)
      .select('id', { count: 'exact', head: true });
    if (delError) {
      console.warn(`[KBIngest] soft-delete failed for ${source_doc}: ${delError.message}`);
    } else {
      chunksReplaced = count || 0;
      console.log(`[KBIngest] Soft-deleted ${chunksReplaced} prior chunks for ${source_doc}`);
    }
  }

  // Step 2: Chunk the text
  const chunks = chunkText(text, { targetTokens, overlapTokens });
  if (chunks.length === 0) {
    await logIngestion({
      source_doc,
      source_version: source_doc_version,
      chunks_added: 0,
      chunks_skipped: 0,
      chunks_replaced: chunksReplaced,
      total_tokens: 0,
      embed_cost_usd: 0,
      ingested_by: ingestedBy,
      status: 'success',
      duration_ms: Date.now() - t0,
    });
    return { chunks_added: 0, chunks_replaced: chunksReplaced, total_tokens: 0, embed_cost_usd: 0, duration_ms: Date.now() - t0 };
  }

  console.log(`[KBIngest] ${source_doc}: ${chunks.length} chunks (~${estimateTokens(text)} tokens)`);

  // Step 3: Embed all chunks (batched)
  let embedResult;
  try {
    embedResult = await embedBatch(chunks);
  } catch (err) {
    await logIngestion({
      source_doc,
      source_version: source_doc_version,
      chunks_added: 0,
      chunks_skipped: chunks.length,
      chunks_replaced: chunksReplaced,
      total_tokens: 0,
      embed_cost_usd: 0,
      ingested_by: ingestedBy,
      status: 'failed',
      error_message: err.message,
      duration_ms: Date.now() - t0,
    });
    throw err;
  }

  // Step 4: Build rows
  const rows = chunks.map((chunkText, idx) => ({
    chunk_text: chunkText,
    chunk_token_count: estimateTokens(chunkText),
    embedding: embedResult.embeddings[idx],
    source_doc,
    source_doc_version,
    source_section,
    source_page: null,
    metadata: metadata && Object.keys(metadata).length > 0 ? metadata : {},
    active: true,
  }));

  // Step 5: Insert in batches
  let chunksAdded = 0;
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
    const { error } = await supabase.from('kb_embeddings').insert(batch);
    if (error) {
      console.error(`[KBIngest] Insert batch ${i}-${i + batch.length} failed: ${error.message}`);
      await logIngestion({
        source_doc,
        source_version: source_doc_version,
        chunks_added: chunksAdded,
        chunks_skipped: chunks.length - chunksAdded,
        chunks_replaced: chunksReplaced,
        total_tokens: embedResult.tokens,
        embed_cost_usd: embedResult.cost_usd,
        ingested_by: ingestedBy,
        status: 'partial',
        error_message: error.message,
        duration_ms: Date.now() - t0,
      });
      throw new Error(`KB insert failed at batch ${i}: ${error.message}`);
    }
    chunksAdded += batch.length;
  }

  // Step 6: Log success
  const duration = Date.now() - t0;
  await logIngestion({
    source_doc,
    source_version: source_doc_version,
    chunks_added: chunksAdded,
    chunks_skipped: 0,
    chunks_replaced: chunksReplaced,
    total_tokens: embedResult.tokens,
    embed_cost_usd: embedResult.cost_usd,
    ingested_by: ingestedBy,
    status: 'success',
    duration_ms: duration,
  });

  console.log(`[KBIngest] ✅ ${source_doc}: ${chunksAdded} chunks added (${embedResult.tokens} tokens, $${embedResult.cost_usd.toFixed(6)}, ${duration}ms)`);

  return {
    chunks_added: chunksAdded,
    chunks_replaced: chunksReplaced,
    total_tokens: embedResult.tokens,
    embed_cost_usd: embedResult.cost_usd,
    duration_ms: duration,
  };
}

/**
 * Soft-delete all chunks for a source_doc. Useful before re-ingesting.
 */
export async function clearSourceDoc(source_doc) {
  if (!source_doc) throw new Error('clearSourceDoc requires source_doc');
  const { error, count } = await supabase
    .from('kb_embeddings')
    .update({ active: false })
    .eq('source_doc', source_doc)
    .eq('active', true)
    .select('id', { count: 'exact', head: true });
  if (error) throw new Error(`clearSourceDoc failed: ${error.message}`);
  return { source_doc, chunks_deactivated: count || 0 };
}

/**
 * Health: list known source docs with chunk counts.
 */
export async function listSourceDocs() {
  const { data, error } = await supabase
    .from('kb_embeddings')
    .select('source_doc, source_doc_version, ingested_at')
    .eq('active', true);
  if (error) throw new Error(`listSourceDocs failed: ${error.message}`);

  // Aggregate in memory
  const summary = {};
  for (const row of (data || [])) {
    if (!summary[row.source_doc]) {
      summary[row.source_doc] = {
        source_doc: row.source_doc,
        source_doc_version: row.source_doc_version,
        chunks: 0,
        latest_ingested_at: row.ingested_at,
      };
    }
    summary[row.source_doc].chunks++;
    if (new Date(row.ingested_at) > new Date(summary[row.source_doc].latest_ingested_at)) {
      summary[row.source_doc].latest_ingested_at = row.ingested_at;
    }
  }
  return Object.values(summary).sort((a, b) => b.chunks - a.chunks);
}

// ═══════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════

async function logIngestion(entry) {
  try {
    await supabase.from('kb_embeddings_ingestion_log').insert(entry);
  } catch (err) {
    console.warn(`[KBIngest] Log insert failed: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESS ROUTES
// ═══════════════════════════════════════════════════════════════════

export function registerKbIngestionRoutes(app) {
  /**
   * Ingest text into the KB.
   * Auth: MCP_AUTH_TOKEN required (apply via existing middleware).
   *
   * Body: { text, source_doc, source_doc_version?, source_section?,
   *         metadata?, replace?, targetTokens?, overlapTokens? }
   */
  app.post('/n8n/kb/ingest', async (req, res) => {
    try {
      const body = req.body || {};
      const result = await ingestDocument({
        text: body.text,
        source_doc: body.source_doc,
        source_doc_version: body.source_doc_version,
        source_section: body.source_section,
        metadata: body.metadata,
        replace: body.replace === true,
        targetTokens: body.targetTokens,
        overlapTokens: body.overlapTokens,
        ingestedBy: body.ingested_by || 'api',
      });
      res.json(result);
    } catch (err) {
      console.error('[KBIngest] /ingest error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/n8n/kb/clear-source', async (req, res) => {
    try {
      const sourceDoc = req.body?.source_doc || req.query?.source_doc;
      if (!sourceDoc) return res.status(400).json({ error: 'source_doc required' });
      const result = await clearSourceDoc(sourceDoc);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/n8n/kb/sources', async (_req, res) => {
    try {
      const list = await listSourceDocs();
      res.json({ count: list.length, sources: list });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
