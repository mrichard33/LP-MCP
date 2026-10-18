-- 20261018200100_bot_message_context_plan_step.sql
--
-- WHAT: bot_message_context.plan_step (text) and question_allowed (boolean), top-level columns written for every
--       reply row by both bots (SMS send path and the live-chat fast lane).
-- WHY: Phase 1 item 4 (2026-10-18). "A no after our close" was decided by a regex over our own last text, which the
--      model words differently each time, so the second no was missed (bot gate, 2026-10-18 12:55, run 1). The
--      planner now reads the PREVIOUS reply's recorded plan_step for the contact; a no after post_demo_close,
--      door_open or post_demo_stop counts whatever our wording was. question_allowed is the plan's verdict on
--      whether that reply could ask anything.
-- NOT: no backfill (older rows stay NULL; the planner then reads the thread as before).
-- ROLLBACK: the columns are additive; the writer drops them and retries when absent (fingerprint-core.js).

alter table public.bot_message_context add column if not exists plan_step text;
alter table public.bot_message_context add column if not exists question_allowed boolean;
-- The planner's read (the contact's newest sent reply) uses the existing idx_bmc_contact.
