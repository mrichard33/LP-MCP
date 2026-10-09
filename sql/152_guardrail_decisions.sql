-- ============================================================================
-- 152_guardrail_decisions.sql — Guardrail decision record (CANON.EVT.009)
-- ============================================================================
-- One row per injection-guard check (src/security/injection-guard.js): which
-- surface, what the classifier said, what was done. Append-only.
--
-- PRIVACY: never the text. text_sha256 lets a reviewer match a row to a
-- stored message without copying customer content into a new table.
--
-- Mirrored in STARTUP_MIRRORS (src/admin/startup-mirrors.js). Safe to re-run.
-- EXECUTION: Supabase dashboard SQL editor, LP MCP instance. One execution.
-- Rollback: DROP VIEW IF EXISTS v_guardrail_daily; DROP TABLE IF EXISTS guardrail_decisions;
-- ============================================================================

CREATE TABLE IF NOT EXISTS guardrail_decisions (
  id               bigserial PRIMARY KEY,
  decided_at       timestamptz NOT NULL DEFAULT now(),
  surface          text        NOT NULL,
  mode             text        NOT NULL,
  verdict          text        NOT NULL,
  score            numeric(4,2) NOT NULL DEFAULT 0,
  signals          text[]      NOT NULL DEFAULT '{}',
  layer            text        NOT NULL,
  action           text        NOT NULL,
  classifier_error text,
  removed_chars    integer     NOT NULL DEFAULT 0,
  text_sha256      text,
  text_chars       integer,
  source_ref       text,
  latency_ms       integer
);

CREATE INDEX IF NOT EXISTS idx_guardrail_decisions_decided_at
  ON guardrail_decisions (decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_guardrail_decisions_flagged
  ON guardrail_decisions (decided_at DESC) WHERE verdict <> 'clean';

CREATE OR REPLACE VIEW v_guardrail_daily AS
SELECT
  (decided_at AT TIME ZONE 'America/New_York')::date AS day_et,
  surface,
  verdict,
  action,
  count(*)                                  AS checks,
  round(avg(latency_ms))::int               AS avg_latency_ms,
  count(*) FILTER (WHERE classifier_error IS NOT NULL) AS classifier_errors
FROM guardrail_decisions
GROUP BY 1, 2, 3, 4;
