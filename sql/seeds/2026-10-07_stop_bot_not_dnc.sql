-- 2026-10-07 — stop-bot is the bot-off switch, not a DNC (the user, 2026-10-07: "stop-bot
-- should not have anything to do with dnc. This tag is intended to stop all bot
-- communication").
--
-- Four DNC rules treated a contact carrying ONLY stop-bot as do-not-call:
--   368 DNC contact completed the estimate calculator again → lift DNC, E.2 v2
--   369 E.0 re-entry with a fresh submission → lift DNC, re-route through E.0
--   387 Manual DNC-lift request tag → Slack approval card
--   388 DNC re-entry not covered by the auto-lift → Slack approval card
-- So a rep take-over, a hard DQ (dq_hard_stop) or a "can't run" LP note (src/agentic/lp-note-dq.js)
-- could produce a DNC-lift card, or a lift that turned the bot back on. Each rule keeps every DNC
-- tag; only 'stop-bot' leaves the has_any_tag trigger. The templates are unchanged: a lift still
-- removes a stop-bot that an LP DNC (rule 14) added.
--
-- Ships with the code that moves stop-bot out of DNC_FAMILY_TAGS (src/consent/consent-store.js)
-- and into mayMessage's own BOT_STOP class (src/services/may-message.js). Apply AFTER the deploy.

-- Expect 4.
WITH u AS (
  UPDATE agent_rules SET
    context_conditions = jsonb_set(
      context_conditions, '{has_any_tag}',
      (SELECT jsonb_agg(t) FROM jsonb_array_elements(context_conditions->'has_any_tag') t WHERE t <> '"stop-bot"'::jsonb)),
    version = coalesce(version,1) + 1, updated_at = now(),
    notes = coalesce(notes,'') || E'\n2026-10-07: stop-bot removed from has_any_tag — it turns the bot off, it is not a DNC (the user).'
  WHERE id IN (368, 369, 387, 388)
    AND context_conditions->'has_any_tag' ? 'stop-bot'
  RETURNING 1)
SELECT count(*) FROM u;

-- Then reload: POST https://lp-mcp-production.up.railway.app/n8n/decision-engine/reload-rules

-- ROLLBACK (puts 'stop-bot' back at the end of each list):
-- UPDATE agent_rules SET context_conditions = jsonb_set(context_conditions, '{has_any_tag}',
--   (context_conditions->'has_any_tag') || '["stop-bot"]'::jsonb), updated_at = now()
--   WHERE id IN (368, 369, 387, 388) AND NOT (context_conditions->'has_any_tag' ? 'stop-bot');
