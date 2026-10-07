/**
 * llm-usage — append-only ledger of every model call (2026-10-07).
 *
 * WHY. The 2026-09-23 IT security review asked for per-transaction usage and
 * cost visibility beyond the provider spend caps (AI OS CANON.STD.025,
 * CANON.SEC.012). src/llm-client.js already returns `usage` on every call;
 * nothing stored it, so cost was invisible until the invoice.
 *
 * WHAT. recordLlmUsage() writes one llm_usage_log row per callLLM() —
 * success or failure — fire-and-forget. It never throws and never delays
 * the model response. LLM_USAGE_LOG_MODE=off (default live) is the rollback.
 *
 * COST. cost_usd is computed only when LLM_PRICE_TABLE_JSON names the model;
 * otherwise NULL. Rates are per 1M tokens. No rate is ever guessed in code —
 * the provider dashboards are the source of truth for pricing. Example:
 *   LLM_PRICE_TABLE_JSON={"claude-sonnet-4-6":{"in":3,"out":15,"cache_read":0.3,"cache_write":3.75},
 *                         "gpt-5.4-mini":{"in":0.25,"out":2}}
 * Lookup is exact model id first, then longest key prefix match.
 */

import supabase from './supabase.js';

const TABLE = 'llm_usage_log';

export function llmUsageMode(env = process.env) {
  return String(env.LLM_USAGE_LOG_MODE || '').trim().toLowerCase() === 'off' ? 'off' : 'live';
}

let _priceCache = { raw: undefined, table: {} };

/** Parsed LLM_PRICE_TABLE_JSON; {} on unset or malformed (logged once). */
export function priceTable(env = process.env) {
  const raw = env.LLM_PRICE_TABLE_JSON;
  if (raw === _priceCache.raw) return _priceCache.table;
  let table = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') table = parsed;
    } catch (err) {
      console.warn(`[LLMUsage] LLM_PRICE_TABLE_JSON is not valid JSON — costs will be NULL: ${err.message}`);
    }
  }
  _priceCache = { raw, table };
  return table;
}

/** Rate entry for a model: exact id, else longest prefix. null if none. */
export function rateFor(model, table = priceTable()) {
  const id = String(model || '');
  if (!id) return null;
  if (table[id]) return table[id];
  let best = null;
  for (const key of Object.keys(table)) {
    if (id.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? table[best] : null;
}

/** USD for one call, or null when the model has no rate. Pure. */
export function computeCostUsd({ model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }, table = priceTable()) {
  const r = rateFor(model, table);
  if (!r) return null;
  const per = (n, rate) => (Number.isFinite(n) && Number.isFinite(rate) ? (n * rate) / 1_000_000 : 0);
  const cost =
    per(inputTokens, r.in) +
    per(outputTokens, r.out) +
    per(cacheReadTokens, r.cache_read ?? 0) +
    per(cacheWriteTokens, r.cache_write ?? 0);
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/**
 * Normalize a provider usage object to the four counters.
 * Anthropic: input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens
 * OpenAI:    prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens
 */
export function normalizeUsage(provider, usage) {
  const u = usage || {};
  const n = (v) => (Number.isFinite(v) ? v : null);
  if (provider === 'openai') {
    return {
      inputTokens: n(u.prompt_tokens),
      outputTokens: n(u.completion_tokens),
      cacheReadTokens: n(u.prompt_tokens_details?.cached_tokens),
      cacheWriteTokens: null,
    };
  }
  return {
    inputTokens: n(u.input_tokens),
    outputTokens: n(u.output_tokens),
    cacheReadTokens: n(u.cache_read_input_tokens),
    cacheWriteTokens: n(u.cache_creation_input_tokens),
  };
}

let _clientOverride = null;
/** TESTS ONLY. */
export function __setLlmUsageClientForTests(client) { _clientOverride = client; }

/**
 * Record one call. Fire-and-forget; never throws; never awaited by callLLM.
 * Returns the row it attempted (for tests), or null when off/unavailable.
 */
export function recordLlmUsage({ fn, group, provider, model, usage, latencyMs, ok = true, error = null }, env = process.env) {
  try {
    if (llmUsageMode(env) === 'off') return null;
    const client = _clientOverride ?? supabase;
    if (!client) return null;
    const t = normalizeUsage(provider, usage);
    const row = {
      fn: String(fn || 'unknown'),
      group_name: group ?? null,
      provider: String(provider || 'unknown'),
      model: String(model || 'unknown'),
      input_tokens: t.inputTokens,
      output_tokens: t.outputTokens,
      cache_read_tokens: t.cacheReadTokens,
      cache_write_tokens: t.cacheWriteTokens,
      cost_usd: computeCostUsd({ model, ...t }, priceTable(env)),
      latency_ms: Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
      ok: !!ok,
      error: error ? String(error).slice(0, 500) : null,
    };
    Promise.resolve(client.from(TABLE).insert(row)).then(
      ({ error: e } = {}) => { if (e) console.warn(`[LLMUsage] insert failed (ignored): ${e.message}`); },
      (err) => console.warn(`[LLMUsage] insert threw (ignored): ${err.message}`),
    );
    return row;
  } catch (err) {
    console.warn(`[LLMUsage] record threw (ignored): ${err.message}`);
    return null;
  }
}

export default { recordLlmUsage, computeCostUsd, normalizeUsage, rateFor, priceTable, llmUsageMode };
