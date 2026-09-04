-- ═══════════════════════════════════════════════════════════════════
-- Durable alert state — 2026-09-04
--
-- Makes operational alerts EDGE-TRIGGERED. Before this, every watchdog kept
-- its "already announced" memory in a process-local JS variable and suppressed
-- by elapsed time, so a cooldown that lapsed while the condition was STILL bad
-- re-announced it, and any restart wiped the memory entirely. Measured over
-- 18h on 2026-09-03/04: the GHL limiter alert fired 11x, the capacity watchdog
-- 4x in 90min, agentic-silence 4x in 90min, LP report #134 6x — each of them
-- ONE ongoing condition, re-announcing.
--
-- This is NOT a second copy of groupme_notification_marks. That table hashes
-- the message TEXT and is the last-line backstop for byte-identical cards.
-- These alert bodies embed live counters ("queue: 3 | tokens: 16/50",
-- "answerable replies: 5", "is UNREADABLE" vs "is NOT_RUNNING"), so the hash
-- differs on every sweep and never matches. This table keys on CONDITION
-- IDENTITY instead. The two compose: identity first, content hash underneath.
--
-- THE INVARIANT: a row exists if and only if the condition is currently
-- announced. Open by INSERT, recover by DELETE. Both are single statements, so
-- the PRIMARY KEY serializes concurrent sweeps and multiple replicas — whoever's
-- write lands is the one that sends. Same doctrine as the v1.5 approval claim
-- and the v1.8 dedup claim.
--
--   alert_key        condition identity, NOT message text, and carrying no live
--                    value — no counts, no state strings, no timestamps.
--                    'capacity_ranker:campaign_not_running:Data - Hot Leads'
--                    stays ONE key whether Five9 reports UNREADABLE,
--                    NOT_RUNNING or STOPPING. That rule alone is what turns
--                    the capacity watchdog's 4x-in-90min into one alert.
--   state            'firing' = already announced, stay silent. 'cleared' =
--                    resolved. Rows are KEPT on clearing rather than deleted,
--                    so the second healthy sweep is a cheap no-op instead of a
--                    second recovery card, and the history stays queryable.
--   first_seen_at    when this incident started. Drives "was firing 1h 42m".
--   last_seen_at     last sweep that observed it — liveness, not suppression.
--   last_notified_at when a card last went out. The reminder CAS predicate.
--   cleared_at       when it resolved; drives the 30-day prune of cleared rows.
--   notify_count     cards sent for this incident. notify_count = 0 at clear
--                    time means nobody ever saw the alert, so no recovery card
--                    is sent — this is what keeps first deploy and kill-switch
--                    toggles quiet. notify_count > 1 on a key with no reminder
--                    configured is the regression signal for this change.
--   detail           last reason string, for reading the table by eye. Never
--                    matched on.
--
-- On ANY error src/alert-state.js returns 'fallback' and the caller uses the
-- in-process cooldown it already had — so a missing or unhappy table degrades
-- to exactly today's behavior, never to silence and never to a storm.
-- Killable without a redeploy via ALERT_STATE_ENABLED=false.
--
-- CLEARED rows are pruned opportunistically at 30 days by src/alert-state.js
-- (once per process-hour, never blocking a decision). A FIRING row is never
-- pruned — dropping one would re-announce a live incident, which is the very
-- bug this table exists to fix.
--
-- DDL runs in the Supabase dashboard SQL editor, not through MCP. Apply this
-- BEFORE merging — src/index.js runMigrations mirrors it so a fresh deploy
-- self-heals, but the fallback contract means a missing table degrades
-- silently to the old cooldown behavior rather than erroring.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS alert_conditions (
  alert_key        text PRIMARY KEY,
  state            text NOT NULL DEFAULT 'firing',
  label            text,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_notified_at timestamptz,
  cleared_at       timestamptz,
  notify_count     integer NOT NULL DEFAULT 0,
  detail           text
);

CREATE INDEX IF NOT EXISTS idx_alert_conditions_state
  ON alert_conditions (state, last_seen_at DESC);

COMMENT ON TABLE alert_conditions IS
  'Durable edge-trigger state for operational alerts (src/alert-state.js). One row per condition, keyed on condition IDENTITY rather than message text; state=firing means already announced, so an ongoing condition alerts once instead of once per sweep, across restarts and replicas. Distinct from groupme_notification_marks, which dedups exact card text for 60 minutes. Firing fails open onto the emitter in-process cooldown; clearing fails closed. Killable via ALERT_STATE_ENABLED=false.';

-- Verification, after the first deploy. Every live incident should show
-- notify_count = 1; notify_count > 1 on a key with no reminder is a regression.
--   SELECT alert_key, state, notify_count, first_seen_at, last_notified_at
--     FROM alert_conditions ORDER BY last_seen_at DESC;
--
-- ROLLBACK: DROP TABLE alert_conditions;
--   Safe. src/alert-state.js degrades a missing table to the pre-2026-09-04
--   in-process cooldowns rather than erroring or going silent.
