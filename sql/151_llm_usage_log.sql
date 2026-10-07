-- ============================================================================
-- 151_llm_usage_log.sql — Per-call LLM usage ledger
-- ============================================================================
-- One row per callLLM() in src/llm-client.js, success or failure. Append-only.
-- Written fire-and-forget by src/llm-usage.js (LLM_USAGE_LOG_MODE=off is the
-- rollback). Read by the Reece Dashboard overview "AI usage" section.
--
-- cost_usd is NULL when no rate is configured for the model (LLM_PRICE_TABLE_JSON)
-- — never guessed. Tokens are always recorded.
--
-- Mirrored in STARTUP_MIRRORS (src/admin/startup-mirrors.js). Safe to re-run.
-- EXECUTION: Supabase dashboard SQL editor, LP MCP instance. One execution.
--
-- Rollback: DROP VIEW IF EXISTS v_llm_usage_daily; DROP TABLE IF EXISTS llm_usage_log;
-- ============================================================================

CREATE TABLE IF NOT EXISTS llm_usage_log (
  id                 bigserial PRIMARY KEY,
  called_at          timestamptz NOT NULL DEFAULT now(),
  fn                 text        NOT NULL,
  group_name         text,
  provider           text        NOT NULL,
  model              text        NOT NULL,
  input_tokens       integer,
  output_tokens      integer,
  cache_read_tokens  integer,
  cache_write_tokens integer,
  cost_usd           numeric(12,6),
  latency_ms         integer,
  ok                 boolean     NOT NULL DEFAULT true,
  error              text
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_log_called_at
  ON llm_usage_log (called_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_usage_log_fn_called
  ON llm_usage_log (fn, called_at DESC);

CREATE OR REPLACE VIEW v_llm_usage_daily AS
SELECT
  (called_at AT TIME ZONE 'America/New_York')::date AS day_et,
  fn,
  provider,
  model,
  count(*)                                   AS calls,
  count(*) FILTER (WHERE NOT ok)             AS errors,
  coalesce(sum(input_tokens), 0)             AS input_tokens,
  coalesce(sum(output_tokens), 0)            AS output_tokens,
  coalesce(sum(cache_read_tokens), 0)        AS cache_read_tokens,
  coalesce(sum(cache_write_tokens), 0)       AS cache_write_tokens,
  sum(cost_usd)                              AS cost_usd,
  count(*) FILTER (WHERE cost_usd IS NULL)   AS unpriced_calls,
  round(avg(latency_ms))                     AS avg_latency_ms
FROM llm_usage_log
GROUP BY 1, 2, 3, 4;
