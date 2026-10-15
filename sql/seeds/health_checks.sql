-- health_checks + escalation_policy seed (generated; do not hand-edit)
--
-- Exported from the LP database 2026-10-15 by scripts/export-health-checks.js --sql.
-- The DATABASE is the source of truth for the registry; this file is its
-- history and lets a fresh database be rebuilt. Re-running it against prod
-- is a no-op: every row is written with the values it already holds.
--
-- health_checks: ON CONFLICT (check_id) DO UPDATE (every column but created_at).
-- escalation_policy: ON CONFLICT DO NOTHING (Mark sets escalate_to.to in the DB).

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('agent.action_failures', 'agent', 'ai_agents', 'Automatic actions failing', 'Are the system''s automatic actions failing even after retries?', 'P2', 'every 15 min', NULL, 35, '5 or more fail in an hour', '20 or more fail in an hour, or any lead fails to reach Five9 or Lead Perfection', '{"fail":20,"warn":5,"fail_any_types":["five9_add_records_to_list","five9_delete_record_from_list","create_lp_lead"]}'::jsonb, 'shadow', 'health-checks', NULL, 'A lead that never reaches Five9 never gets called.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('agent.approval_backlog', 'agent', 'ai_agents', 'Approvals waiting', 'Is something waiting too long for a person to approve it?', 'P3', 'hourly', NULL, 130, 'Waiting more than 4 business hours', 'Waiting more than a day', '{"fail_h":24,"source":"agent_approval_queue","warn_h":4}'::jsonb, 'shadow', 'health-checks', NULL, 'Fixes and changes sit unapproved.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('agent.bot_reply_sla', 'agent', 'ai_agents', 'Chatbot answering on time', 'Is the chatbot answering customer texts quickly?', 'P2', 'existing', NULL, 35, 'Not used', 'Any customer text waits longer than the reply limit', '{"source":"reply-sla-watchdog"}'::jsonb, 'shadow', 'health-checks', NULL, 'Leads wait on the bot and go cold.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('agent.executor_heartbeat', 'agent', 'ai_agents', 'Automation worker running', 'Is the worker that carries out automatic actions running?', 'P1', 'every min', NULL, 5, 'It hasn''t run for 3 minutes while work is waiting', 'It hasn''t run for 6 minutes while work is waiting', '{"source":"/n8n/decision-engine/heartbeat-status","fail_min":6,"warn_min":3}'::jsonb, 'shadow', 'health-checks', NULL, 'Nothing automatic gets done.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('agent.guardrail_blocks', 'agent', 'ai_agents', 'Safety filter blocks', 'Is the safety filter blocking far more messages than normal?', 'P2', 'hourly', NULL, 130, 'More than 2 times a normal hour', 'More than 5 times a normal hour', '{"fail_x":5,"source":"guardrail_decisions, validation_log","warn_x":2}'::jsonb, 'shadow', 'health-checks', NULL, 'The bot may be misbehaving or someone may be trying to trick it.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('agent.llm_cost', 'agent', 'ai_agents', 'Daily AI spend', 'Is today''s AI spending within budget?', 'P3', 'hourly', NULL, 130, 'Over 80% of the daily budget', 'Over the daily budget', '{"source":"v_llm_usage_daily","fail_pct":100,"warn_pct":80}'::jsonb, 'shadow', 'health-checks', NULL, 'A runaway process can spend a lot quickly.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('agent.queue_depth', 'agent', 'ai_agents', 'Automatic actions waiting', 'Are automatic actions piling up or waiting too long?', 'P2', 'every 5 min', NULL, 12, 'Oldest waits more than 15 minutes, or more than 50 are waiting', 'Oldest waits more than 45 minutes, or more than 200 are waiting', '{"fail_count":200,"warn_count":50,"fail_age_min":45,"warn_age_min":15}'::jsonb, 'shadow', 'health-checks', NULL, 'Leads get routed late.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('appt.capacity_over', 'appointment', 'lead_perfection', 'Enough reps for tomorrow', 'Does each office have enough reps for tomorrow''s appointments in each time block?', 'P2', '19:30 ET', NULL, 1500, '1 more appointment than reps in a block', '3 or more too many in one office block', '{"fail":3,"warn":1,"source":"lp_capacity_slots"}'::jsonb, 'shadow', 'appointment-pipeline-check', NULL, 'Overbooked appointments go unrun.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('appt.conf_attempt_coverage', 'appointment', 'five9', 'Confirmation calls made', 'Did every unconfirmed appointment for tomorrow get at least one confirmation call today?', 'P2', 'hourly 10-19 ET', '10:00-19:00 ET', 130, 'Any not called by 5:00 PM', 'Any not called by 7:00 PM', '{"fail_at_et":"19:00","warn_at_et":"17:00","conf_campaigns":["Conf - Next Day","Conf - 2nd Day"]}'::jsonb, 'shadow', 'appointment-pipeline-check', NULL, 'Replaces the hand count on the confirmation summary sheet.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('appt.duplicate_prospects', 'appointment', 'lead_perfection', 'Customers entered twice', 'Is any customer with an upcoming appointment entered twice in Lead Perfection?', 'P3', 'daily', NULL, 1500, '5 or more', '20 or more', '{"fail":20,"warn":5,"source":"v_appt_prospect_dupes"}'::jsonb, 'shadow', 'appointment-pipeline-check', NULL, 'History gets split and the customer may be called twice.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('appt.inbound_queue_age', 'appointment', 'lead_perfection', 'New inquiries waiting in Lead Perfection', 'Are new inquiries waiting too long in Lead Perfection to be turned into leads?', 'P1', 'every 5 min', '08:00-20:00 ET', 12, 'The oldest has waited 20 office minutes, or more than 10 are waiting', 'The oldest has waited 45 office minutes, or more than 25 are waiting', '{"source":"lp_inbound_queue","fail_count":25,"warn_count":10,"fail_age_min":45,"warn_age_min":20}'::jsonb, 'shadow', 'appointment-pipeline-check', NULL, 'An inquiry still waiting is on no calling list.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('appt.invalid_time_or_block', 'appointment', 'lead_perfection', 'Appointment times we don''t book', 'Is any appointment this week booked at a time we don''t run (noon, 4 PM, or a sales-meeting morning)?', 'P3', 'hourly', NULL, 130, 'Any appointment at a time we don''t book', 'Any booked by the chatbot or an automation (once dispatch confirms the rules)', '{"blocks":{"evening":[17,18,19],"morning":[9,10,11],"afternoon":[13,14,15]},"no_morning":{"Mon":["SAR"],"Thu":["ORL","LAKE","JAX","BOCA","FTLAU"],"Tue":["FTMYR","JAX"],"Wed":["STPET"]},"never_hours":[12,16],"confirm_with_dispatch":true}'::jsonb, 'shadow', 'appointment-pipeline-check', NULL, 'An appointment nobody can run.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('appt.issue_by_2000', 'appointment', 'lead_perfection', 'Tomorrow''s appointments issued by 8:15 PM', 'Has every confirmed appointment for tomorrow been issued to a rep (reps can''t see it otherwise)?', 'P1', '20:15 and 20:45 ET', NULL, 1500, 'Any not issued at 8:15 PM', 'Any not issued at 8:45 PM, or 3 or more at 8:15 PM', '{"check_times_et":["20:15","20:45"],"fail_count_first":3}'::jsonb, 'shadow', 'appointment-pipeline-check', NULL, 'The rep never sees tomorrow''s appointment.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('appt.issued_no_result', 'appointment', 'lead_perfection', 'Issued appointments have a result', 'Does every issued appointment from before yesterday have a result entered?', 'P2', 'daily 09:00 ET', NULL, 1500, '5 or more without a result', '15 or more, or any older than 3 days', '{"fail":15,"warn":5,"fail_age_h":72}'::jsonb, 'shadow', 'appointment-pipeline-check', NULL, 'Missing results make the set, sit and close numbers wrong.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('appt.rep_not_acknowledged', 'appointment', 'lead_perfection', 'Reps saw today''s appointments', 'Has every rep viewed today''s appointments? (Lead Perfection doesn''t share this yet.)', 'P2', '07:30 and 08:30 ET', NULL, 1500, 'Any not viewed at 7:30 AM', 'Any not viewed at 8:30 AM', '{"needs":"Presentation status field (Gaps #14)"}'::jsonb, 'shadow', 'appointment-pipeline-check', NULL, 'An unviewed appointment risks a no-show.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('appt.required_fields', 'appointment', 'lead_perfection', 'Appointments have the required details', 'Does every appointment set in the last day have its product, quantity and appointment type?', 'P3', 'daily', NULL, 1500, '5 or more missing details in a day', '15 or more in a day', '{"fail":15,"warn":5,"needs":"field names (Gaps #14)"}'::jsonb, 'shadow', 'appointment-pipeline-check', NULL, 'Dispatch can''t route an appointment without them.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('appt.reschedule_on_issued_lead', 'appointment', 'lead_perfection', 'No new appointment on an issued lead', 'Was a new appointment booked on a lead whose appointment was already issued?', 'P3', 'daily', NULL, 1500, '1 or more in a day', '3 or more in a day', '{"fail":3,"warn":1}'::jsonb, 'shadow', 'appointment-pipeline-check', NULL, 'It breaks lead-source tracking and rep stats.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('appt.set_not_confirmed', 'appointment', 'lead_perfection', 'Tomorrow''s appointments confirmed', 'How many of tomorrow''s appointments were still not confirmed at 7:15 PM?', 'P2', '19:15 ET', NULL, 1500, 'More than 15% not confirmed', 'More than 30% not confirmed', '{"fail_pct":30,"warn_pct":15}'::jsonb, 'shadow', 'appointment-pipeline-check', NULL, 'Unconfirmed appointments are more likely to be no-shows.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('appt.unassigned_next_day', 'appointment', 'lead_perfection', 'Tomorrow''s appointments have a rep', 'Does every confirmed appointment for tomorrow have a sales rep?', 'P1', '19:30 and 20:15 ET', NULL, 1500, 'Any without a rep at 7:30 PM', 'Any without a rep at 8:15 PM', '{"check_times_et":["19:30","20:15"]}'::jsonb, 'shadow', 'appointment-pipeline-check', NULL, 'An appointment with no rep goes unrun.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('ci.recording_archive', 'sync', 'supabase', 'Call recordings reachable', 'Can the system reach the call recordings to analyze calls?', 'P3', 'existing', NULL, 1500, 'Not used', 'The recordings can''t be reached', '{"source":"alert_conditions ci:recording_archive_unreachable (src/ci/worker.js)"}'::jsonb, 'shadow', NULL, NULL, 'Phone calls aren''t analyzed while the recordings can''t be reached.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('dialer.campaign_running', 'dialer', 'five9', 'Calling campaigns running', 'Is every calling campaign that should be running actually running during calling hours?', 'P1', 'every 5 min', '08:00-20:00 ET', 12, 'Not used', 'A campaign has been stopped for 10 minutes', '{"expected":["DIAL ASAP","After DIAL ASAP","Callback Request","Conf - Next Day","Conf - 2nd Day","Data - Hot Leads less than 7","Data - Warm Leads less than 30","Data - Leads more than 30","Rehash - New","Rehash","Rehash - Very Old","Resets-Hot","Reset-Warm","Simpletext outbound","Previous Customer"],"sustain_ms":600000}'::jsonb, 'shadow', 'health-checks', NULL, 'If DIAL ASAP stops, no new lead gets called.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('dialer.cap_3_in_24', 'dialer', 'five9', 'No phone called more than 3 times a day', 'Is any phone number being called more than 3 times in 24 hours?', 'P2', 'hourly', NULL, 130, 'Any number called 4 times', 'Any number called 5 or more times, or 10 or more numbers called 4 times', '{"cap":3,"fail_at":5,"warn_at":4,"fail_phones_at_warn":10}'::jsonb, 'shadow', 'dialer-sla-check', NULL, 'Customer experience and calling rules.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('dialer.config_drift', 'dialer', 'five9', 'Five9 settings unchanged', 'Did any Five9 campaign, filter or list setting change since yesterday?', 'P3', 'daily 04:10 ET', NULL, 1500, 'Any change', 'A change to the DIAL ASAP or After DIAL ASAP settings', '{"source":"five9_config_changes","p2_profiles":["DIAL ASAP V2","After DIAL ASAP V2"]}'::jsonb, 'shadow', 'five9-config-snapshot', NULL, 'An unreviewed change alters who gets called and when.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('dialer.connector_after_asap', 'dialer', 'five9', 'Unreached leads move to the follow-up list', 'Do unreached DIAL ASAP leads move to the After DIAL ASAP follow-up list on their own?', 'P2', 'every 15 min', NULL, 35, '3 or more missed in one pass', '10 or more missed, or any waiting more than 2 hours', '{"fail":10,"warn":3,"fail_age_h":2}'::jsonb, 'shadow', 'after-asap-retry', NULL, 'Second and third call attempts never happen.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('dialer.dial_rate_drop', 'dialer', 'five9', 'Dialing pace', 'Are campaigns dialing at their normal pace for this time of day?', 'P2', 'hourly', '08:00-20:00 ET', 130, 'Below 60% of normal', 'Below 30% of normal, or no dials for an hour', '{"fail_pct":30,"warn_pct":60,"baseline_weeks":4,"requires_running_and_agents":true}'::jsonb, 'shadow', 'dialer-sla-check', NULL, 'Calling capacity quietly drops.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('dialer.first_dial_sla', 'dialer', 'five9', 'New leads called within 15 minutes', 'Did new DIAL ASAP leads get their first call within 15 minutes?', 'P1', 'every 15 min', '08:00-20:00 ET', 35, 'Half of them took more than 10 minutes', 'Any lead waited more than 30 minutes, or 3 or more waited more than 15', '{"fail_any_min":30,"warn_p50_min":10,"dial_asap_sla_min":15,"fail_count_over_sla":3}'::jsonb, 'shadow', 'dialer-sla-check', NULL, 'Calling fast is what books appointments.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('dialer.list_membership_sla', 'dialer', 'five9', 'Leads on the right calling list', 'Is each new lead on the Five9 calling list it should be on, in time?', 'P1', 'every 15 min', '08:00-20:00 ET', 35, '1 lead late', '3 or more late, or any very late', '{"chunk":500,"sla_min":{"DIAL ASAP":5,"After DIAL ASAP":30,"Callback Request":5},"conf_rule":"Conf - 2nd Day by 08:00 ET two days before; Conf - Next Day by 08:00 ET the day before","lookup_cap":300}'::jsonb, 'shadow', 'dialer-sla-check', NULL, 'The wrong list means the wrong call schedule and a missed first call.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('dialer.list_stalled', 'dialer', 'five9', 'Calling lists being worked', 'Is a calling list with leads waiting going undialed while agents are ready?', 'P1', 'every 15 min', '08:00-20:00 ET', 35, 'No dial in 30 minutes', 'No dial in 60 minutes', '{"fail_min":60,"warn_min":30,"start_after":"08:00 ET (lists repopulate 06:00)","requires_agents_ready":true}'::jsonb, 'shadow', 'dialer-sla-check', NULL, 'A stalled DIAL ASAP list means every new lead is waiting.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('dialer.never_again', 'dialer', 'five9', '"No Demo" and Do Not Call leads not called again', 'Is any lead marked No Demo, ND or Do Not Call still being called?', 'P2', 'daily 07:30 ET', NULL, 1500, '1 or more', '3 or more', '{"fail":3,"warn":1,"never_dispositions":["ND","No Demo"]}'::jsonb, 'shadow', 'dialer-sla-check', NULL, 'Calling them is a complaint risk (ruled 2026-10-07).', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('dialer.silence', 'dialer', 'five9', 'Five9 sending call activity', 'Is Five9 sending any call activity at all?', 'P1', 'hourly', NULL, 130, 'Quiet for longer than usual', 'Quiet for much longer than usual', '{"source":"five9-silence-watchdog"}'::jsonb, 'shadow', 'five9-silence-watchdog', NULL, 'The whole dialer may be down.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('dialer.unmapped_last', 'dialer', 'five9', 'Unmapped leads called last', 'Are unmapped leads being called while the regular lists still have leads? (Can''t be measured yet.)', 'P3', 'hourly', '08:00-20:00 ET', 130, 'Any unmapped call while a regular list has leads', 'For an hour', '{"unmapped_list":"Data - Warm Unmapped"}'::jsonb, 'shadow', 'dialer-sla-check', NULL, 'Agents call the wrong leads.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('ghl.dead_triggers', 'workflow', 'ghl', 'GHL workflows starting correctly', 'Can an unpublished GHL workflow still start, or does one trigger start several workflows?', 'P3', 'daily', NULL, 1500, 'Any new case', 'Not used', '{"source":"detect_dead_workflows, find_duplicate_triggers (cross-workflow only)"}'::jsonb, 'shadow', 'health-checks', NULL, 'Contacts end up in unfinished or duplicate workflows.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('ghl.rate_limiter', 'workflow', 'ghl', 'Within GHL''s request limit', 'Are we staying within GHL''s limit on requests?', 'P2', 'every min', NULL, 5, 'Close to the limit for 10 minutes', 'Over the limit for 10 minutes', '{"source":"/n8n/rate-limiter/stats","sustain_ms":600000}'::jsonb, 'shadow', 'health-checks', NULL, 'Every update to GHL is delayed.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('ghl.rule_targets', 'workflow', 'ghl', 'Automation rules reach live workflows', 'Does every automation rule send contacts to a published GHL workflow?', 'P3', 'daily', NULL, 1500, 'Any rule points at an unpublished workflow', 'Any rule points at a workflow that doesn''t exist', '{"source":"rule_target_checks"}'::jsonb, 'shadow', 'rule-target-check', NULL, 'The rule fires and nothing happens.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('ghl.webhook_liveness', 'workflow', 'webhooks', 'GHL sending updates', 'Are updates from GHL still arriving at the usual volume?', 'P2', 'hourly', '08:00-20:00 ET', 130, 'Under half the usual for 2 hours', 'None for 2 hours during the day', '{"source":"lead_events / ghl_workflow_webhooks","warn_pct":50,"fail_zero_h":2,"baseline_weeks":4}'::jsonb, 'shadow', 'health-checks', NULL, 'New leads from GHL stop arriving.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('jobs.failed', 'workflow', 'railway', 'Background jobs failing', 'Is any background job failing again and again?', 'P2', 'every 5 min', NULL, 12, '1 failure in its last 3 runs', '3 failures in a row', '{"note":"promised-callback-sweep 163 fails/7d and rehash-tag-sweep 83/7d must be fixed or excluded before live (Gaps #11)","source":"v_job_status","fail_consecutive":3}'::jsonb, 'shadow', 'health-checks', NULL, 'Automations silently stop.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('jobs.silent', 'workflow', 'railway', 'Background jobs running on time', 'Has any background job stopped running on its schedule?', 'P2', 'every 5 min', NULL, 12, 'Quiet for twice its normal gap', 'Quiet for four times its normal gap', '{"fail_x":4,"source":"v_job_status","warn_x":2}'::jsonb, 'shadow', 'health-checks', NULL, 'This is how the 47-hour outage went unnoticed.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('lead.booked_without_lp', 'lead', 'lead_perfection', 'Appointments with no lead in Lead Perfection', 'Was any appointment booked on a call for someone with no lead in Lead Perfection?', 'P1', 'hourly', NULL, 130, '1 or more in a day', '3 or more in a day', '{"fail":3,"warn":1,"source":"get_identity_health.appt_set_without_lp_record"}'::jsonb, 'shadow', 'health-checks', NULL, 'Lead Perfection can''t dispatch it, so it becomes a no-show.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('lead.canvass_to_lp', 'lead', 'lead_perfection', 'Canvass leads delivered', 'Did every canvass lead reach Lead Perfection and the dialer?', 'P1', 'every 15 min', NULL, 35, '1 not delivered after 30 minutes', '2 or more not delivered, or any after 2 hours', '{"fail_wait_min":120,"warn_wait_min":30}'::jsonb, 'shadow', 'canvass-lead-backstop', NULL, 'Canvassers are paid per lead; a dropped lead is a wasted door.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('lead.chat_to_lp', 'lead', 'lead_perfection', 'Chat leads delivered', 'Are chatbot and website chat leads reaching Lead Perfection?', 'P1', 'every 15 min', NULL, 35, 'Any lead would have been missed', 'Any lead failed to send', '{"source":"chat-lead-intake job detail"}'::jsonb, 'shadow', 'chat-lead-intake', NULL, '18 a day were missing in September.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('lead.first_call_p90', 'lead', 'five9', 'How fast new leads were called yesterday', 'How long did it take to call 9 in 10 of yesterday''s new leads?', 'P2', 'daily 08:10 ET', NULL, 1500, 'More than 2 hours', 'More than 4 hours, or more than 3% never called', '{"source":"lead_call_speed_daily","fail_p90_min":240,"warn_p90_min":120,"fail_never_called_pct":3}'::jsonb, 'shadow', 'lead-leak-monitor', NULL, 'A slow first call lowers the booking rate for every source.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('lead.in_inbound_queue', 'lead', 'lead_perfection', 'Leads stuck waiting in Lead Perfection', 'How many lost leads were simply never turned into leads in Lead Perfection?', 'P1', 'daily 08:10 ET', NULL, 1500, '3 or more', '10 or more', '{"reason":"in_inbound_queue","source":"lead_leak_daily","fail_leads":10,"warn_leads":3}'::jsonb, 'shadow', 'lead-leak-monitor', NULL, 'A people bottleneck, not an automation problem.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('lead.intake_gap', 'lead', 'lead_perfection', 'GHL contacts that never became a lead', 'Did every new GHL contact reach Lead Perfection within an hour? (Coming later.)', 'P1', 'hourly', '08:00-20:00 ET', 130, '1 or more in 2 hours', '3 or more in 2 hours', '{"fail":3,"warn":1,"source":"lead_intake_gap_daily","window_h":2}'::jsonb, 'shadow', 'health-checks', NULL, 'A contact that never reaches Lead Perfection is never called.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('lead.not_in_five9', 'lead', 'five9', 'Leads that never reached Five9', 'How many leads never reached Five9 at all?', 'P1', 'daily 08:10 ET', NULL, 1500, 'More than 5 in a day', 'More than 10 in a day, or worth more than $25,000', '{"reason":"not_in_five9","source":"lead_leak_daily","fail_leads":10,"fail_value":25000,"warn_leads":5}'::jsonb, 'shadow', 'lead-leak-monitor', NULL, 'On Oct 14, 42 leads worth $94,000 landed here.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('lead.routing_failure', 'lead', 'five9', 'Leads lost to routing problems', 'How many leads were lost because routing or an automation failed?', 'P1', 'daily 08:10 ET', NULL, 1500, '1 or more', '3 or more', '{"reasons":["routing_or_automation_failure","on_list_not_dialed"],"fail_leads":3,"warn_leads":1}'::jsonb, 'shadow', 'lead-leak-monitor', NULL, 'On Oct 14, 6 leads worth $8,800.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('lead.uncalled_live', 'lead', 'five9', 'Leads waiting for a first call', 'Has every new lead from the last day had at least one call?', 'P1', 'hourly 08-20 ET', '08:00-20:00 ET', 130, 'Any lead waiting more than 30 minutes', 'Any lead waiting more than an hour, or 3 or more waiting more than 30 minutes', '{"source":"lead-speed-alerts.js","fail_wait_min":60,"warn_wait_min":30,"fail_count_over_warn":3}'::jsonb, 'shadow', 'lead-uncalled-check', NULL, 'A lead nobody called today is a lead a competitor calls.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('n8n.cron_silence', 'workflow', 'n8n', 'Scheduled n8n workflows ran', 'Did every scheduled n8n workflow run on time? (Coming later.)', 'P2', 'every 15 min', NULL, 35, 'Late by twice its schedule', 'Late by four times its schedule', '{"fail_x":4,"warn_x":2,"interval_from":"workflow JSON in GitHub mrichard33/n8n"}'::jsonb, 'shadow', 'n8n-execution-poller', NULL, 'Report imports and weekly reports silently stop.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('n8n.errors', 'workflow', 'n8n', 'n8n workflow errors', 'Are n8n workflows failing? (Coming later.)', 'P2', 'every 5 min', NULL, 12, '2 or more errors per workflow in an hour', '5 or more, or any error on a lead intake workflow', '{"source":"n8n_execution_log","fail_per_wf_h":5,"warn_per_wf_h":2,"intake_prefixes":["I.","OPS.DNC-LIFT","05 LF","06 VDR"]}'::jsonb, 'shadow', 'n8n-execution-poller', NULL, 'On Oct 14 there were 10 errors in 3 hours.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('n8n.reachable', 'workflow', 'n8n', 'n8n up', 'Is n8n answering?', 'P2', 'every 5 min', NULL, 12, 'Missed once', 'Missed twice in a row', '{"fail_consecutive":2}'::jsonb, 'shadow', 'health-checks', NULL, 'All n8n automations stop.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('svc.dashboard', 'service', 'railway', 'Dashboard up', 'Is the dashboard loading?', 'P2', 'every 5 min', NULL, 12, 'Slow (over 3 seconds)', 'Not loading twice in a row', '{"url":"https://dashboard.getreecewindows.com/overview","fail_consecutive":2}'::jsonb, 'shadow', 'health-checks', NULL, 'No one can see the command center.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('svc.five9_api', 'service', 'five9', 'Five9 connected', 'Can we connect to Five9?', 'P1', 'every 5 min', NULL, 12, 'Missed once', 'Missed twice in a row', '{"source":"/health/integrations","fail_consecutive":2}'::jsonb, 'shadow', 'health-checks', NULL, 'We can''t see or manage the dialer.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('svc.hl_mcp', 'service', 'railway', 'HL-MCP up', 'Is HL-MCP (our GHL connection) running?', 'P1', 'every 5 min', NULL, 12, 'Slow, or its latest update failed', 'Not answering twice in a row, or Railway shows it down', '{"alert_24_7":true,"warn_latency_ms":3000,"fail_consecutive":2}'::jsonb, 'shadow', 'health-checks', NULL, 'Nothing can update GHL.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('svc.lp_api', 'service', 'lead_perfection', 'Lead Perfection connected', 'Can we connect to Lead Perfection?', 'P1', 'every 5 min', NULL, 12, 'Missed once', 'Missed twice in a row', '{"source":"/health/integrations","fail_consecutive":2}'::jsonb, 'shadow', 'health-checks', NULL, 'No new leads and no updates from Lead Perfection.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('svc.lp_mcp', 'service', 'railway', 'LP-MCP up', 'Is LP-MCP (the main system) running?', 'P1', 'every 5 min', NULL, 12, 'Its latest update failed; the previous version is still running', 'Down', '{"alert_24_7":true,"warn_latency_ms":3000,"fail_consecutive":2}'::jsonb, 'shadow', 'health-checks', NULL, 'Every job and safety net stops.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('svc.railway_restarts', 'service', 'railway', 'Services running on Railway', 'Are LP-MCP, HL-MCP, n8n and the dashboard running normally on Railway?', 'P2', 'every 15 min', NULL, 35, 'Restarted 4 or more times in an hour, a failed update, or a service we can''t see', 'A service is down', '{"fail":4,"warn":2,"services":["LP-MCP","HL-MCP","n8n","Reece Dashboard"]}'::jsonb, 'shadow', 'health-checks', NULL, 'A service is down or stuck restarting.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('svc.slack', 'service', 'webhooks', 'Slack connected', 'Can we post to Slack?', 'P2', 'every 5 min', NULL, 12, 'Missed once', 'Missed twice in a row', '{"source":"/health/integrations","fail_consecutive":2}'::jsonb, 'shadow', 'health-checks', NULL, 'Alerts are silently lost.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('svc.supabase_hl', 'service', 'supabase', 'GHL copy database up', 'Is the database that holds our copy of GHL answering?', 'P2', 'every 5 min', NULL, 12, 'Under heavy load', 'Not answering', '{"project":"jtlngmcrtqncimtjjzlz","warn_cpu_pct":70,"fail_disk_pct":90}'::jsonb, 'shadow', 'health-checks', NULL, 'Checks that read GHL data go blind.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('svc.supabase_lp', 'service', 'supabase', 'Main database up', 'Is the main database answering?', 'P1', 'every 5 min', NULL, 12, 'Under heavy load', 'Not answering', '{"project":"rcjcgjlqzepicbwhnnjl","warn_cpu_pct":70,"fail_disk_pct":90}'::jsonb, 'shadow', 'health-checks', NULL, 'Everything that stores or reads data stops.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('syn.chatbot_reply', 'synthetic', 'ai_agents', 'Test run: chatbot reply', 'Does the chatbot answer a test message on time? (Coming later.)', 'P2', 'offline hourly; live 2x/day', NULL, 130, 'Not used', 'No reply in time, or a wrong reply', '{"offline_scripts":3,"live_runs_per_day":2}'::jsonb, 'shadow', 'synthetic-canary', NULL, 'The bot is down or broken.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('syn.ghl_webhook_roundtrip', 'synthetic', 'webhooks', 'Test run: GHL to us', 'Does a test update in GHL reach us within 2 minutes? (Coming later.)', 'P2', 'every 30 min', NULL, 65, 'Not used', 'Not seen within 2 minutes', '{"workflow":"ZZ.CANARY","budget_min":2}'::jsonb, 'shadow', 'synthetic-canary', NULL, 'GHL updates aren''t reaching us.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('syn.lead_to_lp', 'synthetic', 'lead_perfection', 'Test run: new lead to Lead Perfection', 'Does a test contact become a Lead Perfection lead within 10 minutes? (Coming later.)', 'P1', '08:30 and 13:30 ET', '08:00-20:00 ET', 1500, 'Not used', 'Any step fails or takes over 10 minutes', '{"needs":"Gaps #3-5","budget_min":10,"identities":30,"lp_footprint_per_day":2}'::jsonb, 'shadow', 'synthetic-canary', NULL, 'Proves the lead intake works without a real lead.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('syn.lp_api_read', 'synthetic', 'lead_perfection', 'Test run: Lead Perfection read', 'Does Lead Perfection return a known test lead? (Coming later.)', 'P1', 'every 15 min', NULL, 35, 'Missed once', 'Missed twice in a row', '{"fail_consecutive":2}'::jsonb, 'shadow', 'synthetic-canary', NULL, 'Catches an expired Lead Perfection login early.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('syn.lp_to_five9_list', 'synthetic', 'five9', 'Test run: lead to the DIAL ASAP list', 'Does the test lead reach the DIAL ASAP list within 5 minutes and get removed before any call? (Coming later.)', 'P1', 'with syn.lead_to_lp', '08:00-20:00 ET', 1500, 'Not used', 'Not on the list within 5 minutes, or not removed within a minute', '{"budget_min":5,"remove_within_s":60}'::jsonb, 'shadow', 'synthetic-canary', NULL, 'Proves leads get from Lead Perfection to Five9.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('syn.n8n_roundtrip', 'synthetic', 'n8n', 'Test run: n8n round trip', 'Does a test n8n workflow answer within 2 minutes? (Coming later.)', 'P2', 'every 30 min', NULL, 65, 'Not used', 'No answer within 2 minutes', '{"workflow":"OPS.CANARY","budget_min":2}'::jsonb, 'shadow', 'synthetic-canary', NULL, 'n8n can''t reach the main system.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('syn.slack_delivery', 'synthetic', 'webhooks', 'Test run: Slack delivery', 'Does a test Slack post arrive within 30 seconds? (Coming later.)', 'P2', 'every 30 min', NULL, 65, 'Not used', 'Not seen within 30 seconds', '{"channel":"#ops-canary (to create)","budget_s":30}'::jsonb, 'shadow', 'synthetic-canary', NULL, 'Tells a quiet Slack from a broken one.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('sync.appt_parity', 'sync', 'ghl', 'Appointments match in Lead Perfection and GHL', 'Do appointment times agree in Lead Perfection and GHL?', 'P2', 'every 30 min', NULL, 65, '5 or more new differences', '20 or more differences', '{"fail":20,"note":"issue #2361","warn":5,"min_age_min":15}'::jsonb, 'shadow', 'health-checks', NULL, 'Reps and the bot act on the wrong time.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('sync.five9_key_pct', 'sync', 'five9', 'Five9 calls tied to leads', 'What share of Five9 call records are tied to a Lead Perfection lead?', 'P2', 'daily', NULL, 1500, 'Under 90%', 'Under 85%', '{"fail_pct":85,"warn_pct":90}'::jsonb, 'shadow', 'health-checks', NULL, 'Calls can''t be matched to leads.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('sync.hl_cache_fresh', 'sync', 'ghl', 'Our copy of GHL is current', 'Is our copy of GHL data up to date?', 'P2', 'every 5 min', NULL, 12, 'Any part more than 30 minutes behind', 'Contacts or opportunities more than 2 hours behind, or more than 5% of refreshes failing', '{"source":"HL MCP get_sync_health","fail_min":120,"warn_min":30,"fail_rate_pct":5}'::jsonb, 'shadow', 'health-checks', NULL, 'Checks that read GHL data go blind.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('sync.lp_errors', 'sync', 'lead_perfection', 'Lead Perfection sync errors', 'Are new errors piling up when copying data from Lead Perfection?', 'P2', 'every 15 min', NULL, 35, 'Any new error today, or old errors still open', '10 or more new errors today, or more than 5 in the last hour', '{"source":"lp_sync_errors resolved=false","fail_age_h":24,"fail_total":20,"warn_new_1h":5}'::jsonb, 'shadow', 'health-checks', NULL, 'Leads that aren''t copied are invisible to every check.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('sync.lp_ghl_link_pct', 'sync', 'ghl', 'New leads linked to GHL', 'Is every new Lead Perfection lead linked to its GHL contact?', 'P2', 'daily', NULL, 1500, 'Some unlinked', 'Many unlinked', '{"source":"get_identity_health","fail_pct":95,"warn_pct":98}'::jsonb, 'shadow', 'link-leak-monitor', NULL, 'Unlinked leads get no follow-up messages and no chatbot.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('sync.lp_leads_fresh', 'sync', 'supabase', 'Lead Perfection leads copied recently', 'Are leads being copied from Lead Perfection on time?', 'P2', 'every 5 min', '08:00-20:00 ET', 12, 'Not copied for 20 minutes', 'Not copied for 45 minutes, or the last two tries failed', '{"source":"lp_leads.updated_at_lp, lp_sync_log","fail_min":45,"warn_min":20,"fail_consecutive":2}'::jsonb, 'shadow', 'health-checks', NULL, 'Every check reads old data.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('sync.lp_reports', 'sync', 'lead_perfection', 'Lead Perfection reports arrived', 'Did the daily Lead Perfection reports arrive (133 Jobs By Status, 134 Jobs by Milestone Date, 135 Lead Disposition Detail 2, 136 Mktg Sub-Source Cost Analysis 2, 137 Sales Efficiency By Mode)?', 'P2', 'every 5 min from 07:30 ET', NULL, 12, 'Missing after 8:30 AM', 'Missing after 10:00 AM, or could not be read', '{"reports":{"133":"Jobs By Status","134":"Jobs by Milestone Date","135":"Lead Disposition Detail 2","136":"Mktg Sub-Source Cost Analysis 2","137":"Sales Efficiency By Mode"},"fail_at_et":"10:00","warn_at_et":"08:30"}'::jsonb, 'shadow', 'lp-report-watchdog', NULL, 'The scorecard is missing a day.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('sync.retired_code', 'sync', 'lead_perfection', 'Old result codes not used', 'Is an old, retired result code (like NIS2) showing up on new leads?', 'P3', 'daily', NULL, 1500, '1 or more', '5 or more', '{"fail":5,"warn":1,"retired":["NIS2"]}'::jsonb, 'shadow', 'lead-leak-monitor', NULL, 'Lost-lead reports quietly go wrong.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO health_checks (check_id, family, system, label, question, severity, cadence, active_window, stale_after_min, warn_rule, fail_rule, config, mode, owner_job_id, runbook, business_impact, enabled)
VALUES ('sync.stale_set_leads', 'sync', 'lead_perfection', 'Appointments with no result', 'How many appointments from the last 14 days have passed with no result in Lead Perfection?', 'P2', 'nightly', NULL, 1500, '10 or more', '40 or more', '{"fail":40,"warn":10}'::jsonb, 'shadow', 'lp-stale-lead-refresh', NULL, 'The scorecard counts appointments that may not have happened.', true)
ON CONFLICT (check_id) DO UPDATE SET
  family = EXCLUDED.family,
  system = EXCLUDED.system,
  label = EXCLUDED.label,
  question = EXCLUDED.question,
  severity = EXCLUDED.severity,
  cadence = EXCLUDED.cadence,
  active_window = EXCLUDED.active_window,
  stale_after_min = EXCLUDED.stale_after_min,
  warn_rule = EXCLUDED.warn_rule,
  fail_rule = EXCLUDED.fail_rule,
  config = EXCLUDED.config,
  mode = EXCLUDED.mode,
  owner_job_id = EXCLUDED.owner_job_id,
  runbook = EXCLUDED.runbook,
  business_impact = EXCLUDED.business_impact,
  enabled = EXCLUDED.enabled,
  updated_at = CASE WHEN (health_checks.family, health_checks.system, health_checks.label, health_checks.question, health_checks.severity, health_checks.cadence, health_checks.active_window, health_checks.stale_after_min, health_checks.warn_rule, health_checks.fail_rule, health_checks.config, health_checks.mode, health_checks.owner_job_id, health_checks.runbook, health_checks.business_impact, health_checks.enabled) IS DISTINCT FROM (EXCLUDED.family, EXCLUDED.system, EXCLUDED.label, EXCLUDED.question, EXCLUDED.severity, EXCLUDED.cadence, EXCLUDED.active_window, EXCLUDED.stale_after_min, EXCLUDED.warn_rule, EXCLUDED.fail_rule, EXCLUDED.config, EXCLUDED.mode, EXCLUDED.owner_job_id, EXCLUDED.runbook, EXCLUDED.business_impact, EXCLUDED.enabled) THEN now() ELSE health_checks.updated_at END;

INSERT INTO escalation_policy (severity, ack_within_min, remind_every_min, escalate_to, channels)
VALUES ('P1', 30, 30, '[{"to":null,"via":"slack_dm","after_min":30},{"to":null,"via":"slack_dm","note":"SMS target TBD","after_min":60}]'::jsonb, '{"primary":"ops","contact_center":"C0C6BNY30TB"}'::jsonb)
ON CONFLICT (severity) DO NOTHING;

INSERT INTO escalation_policy (severity, ack_within_min, remind_every_min, escalate_to, channels)
VALUES ('P2', 240, 120, '[{"to":null,"via":"slack_dm","after_min":240,"business_hours_only":true}]'::jsonb, '{"primary":"ops"}'::jsonb)
ON CONFLICT (severity) DO NOTHING;

INSERT INTO escalation_policy (severity, ack_within_min, remind_every_min, escalate_to, channels)
VALUES ('P3', NULL, NULL, '[]'::jsonb, '{"digest":true,"primary":"ops"}'::jsonb)
ON CONFLICT (severity) DO NOTHING;

INSERT INTO escalation_policy (severity, ack_within_min, remind_every_min, escalate_to, channels)
VALUES ('P4', NULL, NULL, '[]'::jsonb, '{"dashboard_only":true}'::jsonb)
ON CONFLICT (severity) DO NOTHING;

-- Verify (expect 74 and 4):
-- SELECT count(*) FROM health_checks; SELECT count(*) FROM escalation_policy;
