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
 * v1.1 — listSourceDocs paginates to avoid 1000-row Supabase default
 *        cap (which silently undercounted sources after first ingest).
 *        Also uses a dedicated COUNT-per-source query when chunk
 *        totals exceed the row sample, for accuracy without scanning
 *        every row.
 * v1.0 — Initial implementation.
 */

import supabase from '../supabase.js';
import { embedBatch, chunkText, estimateTokens } from './openai-embeddings.js';
import { denyAll } from '../auth.js';

const DEFAULT_TARGET_TOKENS = 500;
const DEFAULT_OVERLAP_TOKENS = 50;
const INSERT_BATCH_SIZE = 100;
const LIST_PAGE_SIZE = 1000;
const LIST_MAX_PAGES = 50; // hard ceiling — 50K rows max in summary

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
    // Get accurate count first (head:true select doesn't combine with update)
    const { count: priorCount } = await supabase
      .from('kb_embeddings')
      .select('id', { count: 'exact', head: true })
      .eq('source_doc', source_doc)
      .eq('active', true);

    const { error: delError } = await supabase
      .from('kb_embeddings')
      .update({ active: false })
      .eq('source_doc', source_doc)
      .eq('active', true);

    if (delError) {
      console.warn(`[KBIngest] soft-delete failed for ${source_doc}: ${delError.message}`);
    } else {
      chunksReplaced = priorCount || 0;
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

  // Count first (for accurate return value)
  const { count: priorCount } = await supabase
    .from('kb_embeddings')
    .select('id', { count: 'exact', head: true })
    .eq('source_doc', source_doc)
    .eq('active', true);

  const { error } = await supabase
    .from('kb_embeddings')
    .update({ active: false })
    .eq('source_doc', source_doc)
    .eq('active', true);

  if (error) throw new Error(`clearSourceDoc failed: ${error.message}`);
  return { source_doc, chunks_deactivated: priorCount || 0 };
}

/**
 * v1.1: List known source docs with accurate chunk counts.
 *
 * Uses a two-stage approach:
 *   1. Get distinct source_doc list via paginated scan of source_doc only
 *   2. For each source_doc, do a COUNT(*) query (cheap — uses index)
 *
 * This avoids the prior 1000-row Supabase default cap that silently
 * undercounted sources once the table grew past 1K active chunks.
 */
export async function listSourceDocs() {
  // Stage 1: collect distinct source_doc values via pagination
  const distinctSources = new Map(); // source_doc → { source_doc_version, latest_ingested_at }
  let from = 0;
  let pages = 0;

  while (pages < LIST_MAX_PAGES) {
    const { data, error } = await supabase
      .from('kb_embeddings')
      .select('source_doc, source_doc_version, ingested_at')
      .eq('active', true)
      .order('id', { ascending: true })
      .range(from, from + LIST_PAGE_SIZE - 1);

    if (error) throw new Error(`listSourceDocs page ${pages} failed: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data) {
      const existing = distinctSources.get(row.source_doc);
      if (!existing) {
        distinctSources.set(row.source_doc, {
          source_doc_version: row.source_doc_version,
          latest_ingested_at: row.ingested_at,
        });
      } else if (row.ingested_at && row.ingested_at > existing.latest_ingested_at) {
        existing.latest_ingested_at = row.ingested_at;
        existing.source_doc_version = row.source_doc_version || existing.source_doc_version;
      }
    }

    if (data.length < LIST_PAGE_SIZE) break; // last page
    from += LIST_PAGE_SIZE;
    pages++;
  }

  // Stage 2: accurate COUNT(*) per distinct source_doc
  const summary = [];
  for (const [source_doc, meta] of distinctSources.entries()) {
    const { count, error: countError } = await supabase
      .from('kb_embeddings')
      .select('id', { count: 'exact', head: true })
      .eq('source_doc', source_doc)
      .eq('active', true);

    if (countError) {
      console.warn(`[KBIngest] count failed for ${source_doc}: ${countError.message}`);
      continue;
    }

    summary.push({
      source_doc,
      source_doc_version: meta.source_doc_version,
      chunks: count || 0,
      latest_ingested_at: meta.latest_ingested_at,
    });
  }

  return summary.sort((a, b) => b.chunks - a.chunks);
}

// ═══════════════════════════════════════════════════════════════════
// RE-EMBED IN PLACE (2026-09-23)
// ═══════════════════════════════════════════════════════════════════

export const REEMBED_MAX_CHUNKS = 200;

/**
 * Re-embed existing chunks whose text was corrected in place.
 *
 * WHY THIS EXISTS: the canon fix of 2026-09-23 corrects text inside docs that
 * have no source file in this repo (reece_canonical_kb, reece_content_playbook
 * and others were ingested from outside it), and inside docs whose live copy
 * is NEWER than the repo copy. Re-ingesting would mean reassembling a doc
 * from overlapping chunks, or rolling a doc back to an older file. So the
 * text is corrected by SQL, row by row, and this refreshes the vectors of
 * exactly those rows — the chunk boundaries, ids and metadata stay put.
 *
 * Only ACTIVE rows are touched; an id that is missing or inactive is
 * reported, never resurrected.
 *
 * @param {{ chunkIds: number[] }} params
 * @param {{ supabase?: object, embedBatch?: Function }} [deps]
 */
export async function reembedChunks({ chunkIds }, deps = {}) {
  const db = deps.supabase || supabase;
  const embedFn = deps.embedBatch || embedBatch;

  const ids = [...new Set((chunkIds || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw new Error('chunk_ids must be a non-empty array of integer ids');
  if (ids.length > REEMBED_MAX_CHUNKS) throw new Error(`at most ${REEMBED_MAX_CHUNKS} chunk_ids per call`);

  const { data, error } = await db
    .from('kb_embeddings')
    .select('id, chunk_text')
    .in('id', ids)
    .eq('active', true);
  if (error) throw new Error(`kb_embeddings read failed: ${error.message}`);

  const rows = (data || []).filter(r => typeof r.chunk_text === 'string' && r.chunk_text.trim());
  const found = new Set(rows.map(r => r.id));
  const missing = ids.filter(id => !found.has(id));
  if (!rows.length) return { requested: ids.length, updated: 0, missing, failed: [] };

  const { embeddings, tokens, cost_usd } = await embedFn(rows.map(r => r.chunk_text));
  if (!Array.isArray(embeddings) || embeddings.length !== rows.length) {
    throw new Error(`embedding count mismatch: ${embeddings?.length} for ${rows.length} chunks`);
  }

  let updated = 0;
  const failed = [];
  for (let i = 0; i < rows.length; i += 1) {
    const { error: upErr } = await db
      .from('kb_embeddings')
      .update({ embedding: embeddings[i], chunk_token_count: estimateTokens(rows[i].chunk_text) })
      .eq('id', rows[i].id);
    if (upErr) failed.push({ id: rows[i].id, error: upErr.message });
    else updated += 1;
  }
  console.log(`[KBIngest] reembed: ${updated}/${rows.length} chunks, missing=${missing.length}, tokens=${tokens}`);
  return { requested: ids.length, updated, missing, failed, tokens, cost_usd };
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

export function registerKbIngestionRoutes(app, authenticate = denyAll) {
  /**
   * Re-embed corrected rows NOW instead of waiting for the next deploy or the
   * 6-hour FAQ sweep. AUTHENTICATED (the standard operator auth passed in by
   * src/index.js): it spends OpenAI budget and rewrites vectors, so unlike the
   * older /n8n/kb/* routes above it is never open. Registered without an auth
   * middleware it refuses everything (denyAll) rather than going open.
   *
   * Body: { chunk_ids?: number[], faqs?: true } — at least one of the two.
   *   chunk_ids → reembedChunks() on those active kb_embeddings rows
   *   faqs      → embedFaqsSweep(): every active kb_faqs row whose text hash
   *               changed, including new rows with no embedding yet
   */
  app.post('/n8n/kb/reembed', authenticate, async (req, res) => {
    try {
      const body = req.body || {};
      const wantChunks = Array.isArray(body.chunk_ids) && body.chunk_ids.length > 0;
      const wantFaqs = body.faqs === true;
      if (!wantChunks && !wantFaqs) {
        return res.status(400).json({ error: 'pass chunk_ids (array) and/or faqs: true' });
      }
      const out = {};
      if (wantChunks) out.chunks = await reembedChunks({ chunkIds: body.chunk_ids });
      if (wantFaqs) {
        const { embedFaqsSweep } = await import('./tier1-semantic.js');
        out.faqs = await embedFaqsSweep('manual');
      }
      res.json(out);
    } catch (err) {
      console.error('[KBIngest] /reembed error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * Ingest text into the KB.
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
      const totalChunks = list.reduce((sum, s) => sum + (s.chunks || 0), 0);
      res.json({ count: list.length, total_chunks: totalChunks, sources: list });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * FAQ threshold probe — READ-ONLY, and the reason this exists.
   *
   * 2026-09-22. Calibrating KB_FAQ_MIN_SIMILARITY meant texting the live bot
   * one question at a time and reading the audit table afterwards: 6 of an
   * 18-question set landed in a whole afternoon, each one a real SMS to a real
   * conversation. There was no way to ask "what would this question score?"
   * without sending it.
   *
   * Always queries at threshold 0 and returns the true similarity for every
   * candidate, so a miss is legible ("0.378, just under the floor") instead of
   * an empty result. `would_match` is computed in JS against the CURRENT floor
   * rather than pushed into the RPC, which is what makes a floor change
   * testable before it is deployed.
   *
   * Sends nothing, writes nothing, logs no audit row — it cannot disturb a
   * conversation or contaminate the kb_vector_queries sample it is used to
   * interpret.
   *
   *   GET /n8n/kb/faq-probe?q=How+many+days+will+you+be+at+my+house
   *   GET /n8n/kb/faq-probe?q=...&threshold=0.35&channel=sms&limit=5
   */
  app.get('/n8n/kb/faq-probe', async (req, res) => {
    try {
      const q = String(req.query?.q || '').trim();
      if (!q) return res.status(400).json({ error: 'q required' });

      const channel = String(req.query?.channel || 'sms');
      const limit = Math.min(parseInt(req.query?.limit || '5', 10) || 5, 20);
      const floor = req.query?.threshold !== undefined
        ? parseFloat(req.query.threshold)
        : parseFloat(process.env.KB_FAQ_MIN_SIMILARITY || '0.40');

      const { embed } = await import('./openai-embeddings.js');
      const { matchFaqsSemantic } = await import('./tier1-semantic.js');

      const started = Date.now();
      const queryEmbedding = await embed(q);
      const rows = await matchFaqsSemantic(queryEmbedding, channel, limit, 0);

      const candidates = (rows || []).map(r => ({
        faq_id: r.id ?? r.faq_id ?? null,
        question_pattern: r.question_pattern,
        similarity: Math.round((r.similarity ?? 0) * 1000) / 1000,
        would_match: (r.similarity ?? 0) >= floor,
      }));

      res.json({
        query: q,
        channel,
        threshold: floor,
        top_similarity: candidates[0]?.similarity ?? null,
        match_count: candidates.filter(c => c.would_match).length,
        matched: candidates.filter(c => c.would_match).map(c => c.question_pattern),
        candidates,
        latency_ms: Date.now() - started,
      });
    } catch (err) {
      console.error('[KBIngest] /faq-probe error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}
