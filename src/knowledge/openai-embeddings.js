/**
 * OpenAI Embeddings Client — src/knowledge/openai-embeddings.js
 *
 * Thin wrapper around OpenAI /v1/embeddings for text-embedding-3-small.
 * Used by:
 *   - src/knowledge/vector-search.js (query embeddings at request time)
 *   - src/knowledge/ingest-embeddings.js (document ingestion, cron/manual)
 *
 * Why a wrapper:
 *   - Centralized retry + timeout policy
 *   - Cost tracking (logs usage per call)
 *   - Batch endpoint support (up to 2048 inputs per request)
 *   - Dimension parameter pinned to 1536 to match kb_embeddings schema
 *
 * Cost reference (2026):
 *   text-embedding-3-small: $0.02 per 1M input tokens
 *   Average chunk ~500 tokens → ~$0.00001 per chunk
 *   A query = 1 chunk = ~$0.00001 per response generation
 *
 * v1.0 — Initial implementation.
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
const DIMENSIONS = parseInt(process.env.OPENAI_EMBEDDING_DIMENSIONS || '1536', 10);
const TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

const ENDPOINT = 'https://api.openai.com/v1/embeddings';

// ═══════════════════════════════════════════════════════════════════
// INTERNAL: HTTP call with exponential backoff
// ═══════════════════════════════════════════════════════════════════

async function callOpenAI(inputArray) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');
  if (!Array.isArray(inputArray) || inputArray.length === 0) {
    throw new Error('callOpenAI requires non-empty input array');
  }

  let lastError = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          input: inputArray,
          dimensions: DIMENSIONS,
          encoding_format: 'float',
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (res.status === 429 || res.status >= 500) {
        // Retryable: rate limit or server error
        const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
        const backoff = retryAfter > 0
          ? retryAfter * 1000
          : BASE_BACKOFF_MS * Math.pow(2, attempt);
        console.warn(`[OpenAIEmbeddings] HTTP ${res.status}, retry in ${backoff}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, backoff));
        lastError = new Error(`OpenAI HTTP ${res.status}`);
        continue;
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`OpenAI embeddings ${res.status}: ${errText.slice(0, 300)}`);
      }

      const data = await res.json();
      if (!data?.data || !Array.isArray(data.data)) {
        throw new Error('OpenAI response missing data array');
      }

      // Return embeddings in input order (data is already ordered by index)
      const embeddings = data.data
        .sort((a, b) => a.index - b.index)
        .map(d => d.embedding);

      const tokensUsed = data.usage?.total_tokens || 0;
      return {
        embeddings,
        tokens: tokensUsed,
        cost_usd: (tokensUsed / 1_000_000) * 0.02,
        model: data.model || MODEL,
      };
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
        console.warn(`[OpenAIEmbeddings] Timeout, retry in ${backoff}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, backoff));
        lastError = err;
        continue;
      }
      // Non-retryable error
      throw err;
    }
  }

  throw lastError || new Error('OpenAI embeddings: max retries exceeded');
}

// ═══════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════

/**
 * Embed a single string. Returns the 1536-dim vector.
 *
 * @param {string} text — Input to embed (trimmed, non-empty)
 * @returns {Promise<{embedding: number[], tokens: number, cost_usd: number}>}
 */
export async function embed(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('embed() requires non-empty string');
  }
  const trimmed = text.trim();
  if (!trimmed) throw new Error('embed() input is empty after trim');

  const result = await callOpenAI([trimmed]);
  return {
    embedding: result.embeddings[0],
    tokens: result.tokens,
    cost_usd: result.cost_usd,
  };
}

/**
 * Embed a batch of strings. Up to 2048 per request (OpenAI limit).
 * For larger batches, this function chunks automatically.
 *
 * @param {string[]} texts — Inputs to embed
 * @returns {Promise<{embeddings: number[][], tokens: number, cost_usd: number}>}
 */
export async function embedBatch(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new Error('embedBatch() requires non-empty array');
  }

  const cleaned = texts
    .map(t => (typeof t === 'string' ? t.trim() : ''))
    .filter(t => t.length > 0);

  if (cleaned.length === 0) {
    throw new Error('embedBatch() all inputs empty after trim');
  }

  const BATCH_SIZE = 2048;
  const allEmbeddings = [];
  let totalTokens = 0;
  let totalCost = 0;

  for (let i = 0; i < cleaned.length; i += BATCH_SIZE) {
    const batch = cleaned.slice(i, i + BATCH_SIZE);
    const result = await callOpenAI(batch);
    allEmbeddings.push(...result.embeddings);
    totalTokens += result.tokens;
    totalCost += result.cost_usd;
  }

  return {
    embeddings: allEmbeddings,
    tokens: totalTokens,
    cost_usd: totalCost,
  };
}

/**
 * Cosine similarity between two embedding vectors.
 * Useful for de-duping or local re-ranking.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} cosine similarity in [-1, 1]
 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    throw new Error('cosineSimilarity: vectors must be same-length arrays');
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Crude token estimator. Real tokenizer would require js-tiktoken.
 * Use for chunking heuristics only — actual cost reported by API.
 *
 * Rule of thumb: 1 token ~= 4 characters in English text.
 *
 * @param {string} text
 * @returns {number} approximate token count
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Chunk a long document into ~targetTokens-sized pieces split on paragraph
 * or sentence boundaries. Returns array of chunk strings.
 *
 * Avoids breaking mid-sentence. Falls back to hard-split for runaway text.
 *
 * @param {string} text — full document
 * @param {Object} opts
 * @param {number} opts.targetTokens — target per chunk (default 500)
 * @param {number} opts.overlapTokens — overlap between chunks (default 50)
 * @returns {string[]}
 */
export function chunkText(text, opts = {}) {
  const targetTokens = opts.targetTokens || 500;
  const overlapTokens = opts.overlapTokens || 50;
  const targetChars = targetTokens * 4;
  const overlapChars = overlapTokens * 4;

  if (!text || typeof text !== 'string') return [];
  const cleaned = text.replace(/\r\n/g, '\n').trim();
  if (!cleaned) return [];
  if (cleaned.length <= targetChars) return [cleaned];

  // Try paragraph split first
  const paragraphs = cleaned.split(/\n{2,}/);
  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    if ((current.length + para.length + 2) <= targetChars) {
      current = current ? `${current}\n\n${para}` : para;
    } else {
      if (current) chunks.push(current);
      // If paragraph itself exceeds target, split by sentence
      if (para.length > targetChars) {
        const sentences = para.split(/(?<=[.!?])\s+/);
        let sentChunk = '';
        for (const s of sentences) {
          if ((sentChunk.length + s.length + 1) <= targetChars) {
            sentChunk = sentChunk ? `${sentChunk} ${s}` : s;
          } else {
            if (sentChunk) chunks.push(sentChunk);
            // Final fallback: hard split
            if (s.length > targetChars) {
              for (let i = 0; i < s.length; i += targetChars) {
                chunks.push(s.slice(i, i + targetChars));
              }
              sentChunk = '';
            } else {
              sentChunk = s;
            }
          }
        }
        if (sentChunk) chunks.push(sentChunk);
        current = '';
      } else {
        current = para;
      }
    }
  }
  if (current) chunks.push(current);

  // Apply overlap (re-prefix each chunk after the first with last N chars of prior)
  if (overlapChars > 0 && chunks.length > 1) {
    const overlapped = [chunks[0]];
    for (let i = 1; i < chunks.length; i++) {
      const tail = chunks[i - 1].slice(-overlapChars);
      overlapped.push(`${tail} ${chunks[i]}`.trim());
    }
    return overlapped;
  }

  return chunks;
}

/**
 * Health check — verifies OpenAI connectivity. Use in startup probes.
 */
export async function healthCheck() {
  if (!OPENAI_API_KEY) return { ok: false, error: 'OPENAI_API_KEY not configured' };
  try {
    const result = await embed('healthcheck');
    return {
      ok: true,
      model: MODEL,
      dimensions: result.embedding.length,
      tokens_used: result.tokens,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
