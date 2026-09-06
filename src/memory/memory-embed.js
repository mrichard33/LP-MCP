/**
 * Memory Embed — src/memory/memory-embed.js
 *
 * Loads the claude_* memory rows, skips the ones whose content_hash is already
 * in claude_memory_embeddings, embeds the rest in batches through
 * src/knowledge/openai-embeddings.js, and upserts. Used by
 * scripts/embed-memory.js now and by the priority #8 nightly job later.
 *
 * Writes ONLY to claude_memory_embeddings. Never touches the source tables.
 *
 * v1.0 — 2026-09-06. Initial.
 */
import supabase from '../supabase.js';
import { embedBatch, estimateTokens } from '../knowledge/openai-embeddings.js';
import { SOURCES, toEmbeddingRow } from './memory-text.js';

const PAGE = 1000;
const EMBED_BATCH = 100;

async function loadAll(kind, opts = {}) {
  const src = SOURCES[kind];
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(src.table).select(src.select).order('id', { ascending: true }).range(from, from + PAGE - 1);
    q = src.filter(q);
    if (opts.since) q = q.gte(src.date, opts.since);
    const { data, error } = await q;
    if (error) throw new Error(`${src.table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
    if (opts.limit && out.length >= opts.limit) break;
  }
  return opts.limit ? out.slice(0, opts.limit) : out;
}

async function loadExistingHashes(table) {
  const map = new Map();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('claude_memory_embeddings')
      .select('source_id, content_hash')
      .eq('source_table', table)
      .order('source_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`claude_memory_embeddings: ${error.message}`);
    for (const r of data || []) map.set(r.source_id, r.content_hash);
    if (!data || data.length < PAGE) break;
  }
  return map;
}

/**
 * Plan the embed run for one kind: which rows are new/changed, and the cost.
 * Read-only. Used by the dry run and by execute.
 */
export async function planKind(kind, opts = {}) {
  if (!SOURCES[kind]) throw new Error(`unknown kind ${kind}`);
  if (!supabase) throw new Error('Supabase client not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  const rows = await loadAll(kind, opts);
  const existing = opts.force ? new Map() : await loadExistingHashes(SOURCES[kind].table);
  const shaped = rows.map((r) => toEmbeddingRow(kind, r));
  const todo = shaped.filter((r) => existing.get(r.source_id) !== r.content_hash);
  const tokens = todo.reduce((n, r) => n + estimateTokens(r.embedded_text), 0);
  return {
    kind, total: shaped.length, unchanged: shaped.length - todo.length, todo,
    est_tokens: tokens, est_cost_usd: (tokens / 1_000_000) * 0.02,
  };
}

/** Embed + upsert the rows from planKind(). Returns counts and real cost.
 *  opts.log(msg) and opts.onProgress({kind, written, todo, tokens, cost_usd}) are optional. */
export async function executePlan(plan, opts = {}) {
  const log = opts.log || (() => {});
  let written = 0; let tokens = 0; let cost = 0;
  for (let i = 0; i < plan.todo.length; i += EMBED_BATCH) {
    const batch = plan.todo.slice(i, i + EMBED_BATCH);
    const result = await embedBatch(batch.map((r) => r.embedded_text));
    if (result.embeddings.length !== batch.length) {
      throw new Error(`embedBatch returned ${result.embeddings.length} vectors for ${batch.length} inputs`);
    }
    const upsertRows = batch.map((r, j) => ({
      ...r,
      embedding: result.embeddings[j],
      token_count: estimateTokens(r.embedded_text),
      embedded_at: new Date().toISOString(),
    }));
    const { error } = await supabase
      .from('claude_memory_embeddings')
      .upsert(upsertRows, { onConflict: 'source_table,source_id' });
    if (error) throw new Error(`upsert ${plan.kind} batch at ${i}: ${error.message}`);
    written += batch.length; tokens += result.tokens; cost += result.cost_usd;
    log(`[MemoryEmbed] ${plan.kind}: ${written}/${plan.todo.length} written (${tokens} tokens, $${cost.toFixed(4)})`);
    if (typeof opts.onProgress === 'function') opts.onProgress({ kind: plan.kind, written, todo: plan.todo.length, tokens, cost_usd: cost });
  }
  return { kind: plan.kind, written, tokens, cost_usd: cost };
}
