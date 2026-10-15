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
VALUES ('agent.action_failures', 'agent', 'ai_agents', 'Agent actions failing', 'Are actions failing after retries?', 'P2', 'every 15 min', NULL, 35, '>= 5 in 1h', '>= 20, or any five9_* / create_lp_lead failure', '{"fail":20,"warn":5,"fail_any_types":["five9_add_records_to_list","five9_delete_record_from_list","create_lp_lead"]}'::jsonb, 'shadow', 'health-checks', NULL, 'A failed Five9 push is a lead not dialed', true)
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
VALUES ('agent.approval_backlog', 'agent', 'ai_agents', 'Approvals waiting', 'Is a human approval waiting too long?', 'P3', 'hourly', NULL, 130, '> 4h in business hours', '> 24h', '{"fail_h":24,"source":"agent_approval_queue","warn_h":4}'::jsonb, 'shadow', 'health-checks', NULL, 'Proposed fixes stall', true)
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
VALUES ('agent.bot_reply_sla', 'agent', 'ai_agents', 'Chatbot reply SLA', 'Is the chatbot answering inside SLA?', 'P2', 'existing', NULL, 35, 'existing', 'existing', '{"source":"reply-sla-watchdog"}'::jsonb, 'shadow', 'health-checks', NULL, 'Leads waiting on the bot', true)
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
VALUES ('agent.executor_heartbeat', 'agent', 'ai_agents', 'Executor heartbeat', 'Are the decision engine and executor alive?', 'P1', 'every min', NULL, 5, '> 3 min', '> 6 min', '{"source":"/n8n/decision-engine/heartbeat-status","fail_min":6,"warn_min":3}'::jsonb, 'shadow', 'health-checks', NULL, 'No agent action executes', true)
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
VALUES ('agent.guardrail_blocks', 'agent', 'ai_agents', 'Guardrail blocks spiking', 'Are guardrail/validation blocks far above normal?', 'P2', 'hourly', NULL, 130, '> 2x trailing 7-day hourly median', '> 5x', '{"fail_x":5,"source":"guardrail_decisions, validation_log","warn_x":2}'::jsonb, 'shadow', 'health-checks', NULL, 'An agent is misbehaving or being attacked', true)
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
VALUES ('agent.llm_cost', 'agent', 'ai_agents', 'Daily AI spend', 'Is daily LLM spend inside budget?', 'P3', 'hourly', NULL, 130, '> 80% of LLM_DAILY_BUDGET_USD', '> 100%', '{"source":"v_llm_usage_daily","fail_pct":100,"warn_pct":80}'::jsonb, 'shadow', 'health-checks', NULL, 'Runaway loop', true)
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
VALUES ('agent.queue_depth', 'agent', 'ai_agents', 'Pending actions aging', 'Are pending agent_actions aging or piling up?', 'P2', 'every 5 min', NULL, 12, '> 15 min / > 50 pending', '> 45 min / > 200 pending', '{"fail_count":200,"warn_count":50,"fail_age_min":45,"warn_age_min":15}'::jsonb, 'shadow', 'health-checks', NULL, 'Routing decisions arrive late', true)
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
VALUES ('appt.capacity_over', 'appointment', 'lead_perfection', 'Appointments vs rep availability', 'Do next-day appointments exceed rep availability per market and block?', 'P2', '19:30 ET', NULL, 1500, 'Over >= 1', 'Over >= 3 in one market', '{"fail":3,"warn":1,"source":"lp_capacity_slots"}'::jsonb, 'shadow', 'appointment-pipeline-check', NULL, 'Overbooked = NIS', true)
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
VALUES ('appt.conf_attempt_coverage', 'appointment', 'five9', 'Confirmation dial coverage', 'Did every Set/Verif appointment for tomorrow get at least one Conf-campaign dial today?', 'P2', 'hourly 10-19 ET', '10:00-19:00 ET', 130, 'any uncalled at 17:00', 'any uncalled at 19:00', '{"fail_at_et":"19:00","warn_at_et":"17:00","conf_campaigns":["Conf - Next Day","Conf - 2nd Day"]}'::jsonb, 'shadow', 'appointment-pipeline-check', NULL, 'Replaces the manual CNF Summary Sheet tally', true)
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
VALUES ('appt.duplicate_prospects', 'appointment', 'lead_perfection', 'Duplicate prospects merged', 'Are duplicate prospects splitting leads?', 'P3', 'daily', NULL, 1500, '>= 5 open', '>= 20', '{"fail":20,"warn":5,"source":"v_appt_prospect_dupes"}'::jsonb, 'shadow', 'appointment-pipeline-check', NULL, 'Split history, double dialing', true)
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
VALUES ('appt.inbound_queue_age', 'appointment', 'lead_perfection', 'LP inbound queue age', 'Is the oldest unchecked-out inbound lead waiting too long?', 'P1', 'every 5 min', '08:00-20:00 ET', 12, 'oldest > 20 min or > 10 waiting', 'oldest > 45 min or > 25 waiting', '{"source":"lp_inbound_queue","fail_count":25,"warn_count":10,"fail_age_min":45,"warn_age_min":20}'::jsonb, 'shadow', 'appointment-pipeline-check', NULL, 'A lead in the queue is on no dial list', true)
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
VALUES ('appt.invalid_time_or_block', 'appointment', 'lead_perfection', 'Appointment time rules', 'Does any appointment violate the time blocks or a market''s sales-meeting morning?', 'P3', 'hourly', NULL, 130, 'any violation', 'any violation set by the chatbot or an automation (P2)', '{"blocks":{"evening":[17,18,19],"morning":[9,10,11],"afternoon":[13,14,15]},"no_morning":{"Mon":["SAR"],"Thu":["ORL","LAKE","JAX","BOCA","FTLAU"],"Tue":["FTMYR","JAX"],"Wed":["STPET"]},"never_hours":[12,16],"confirm_with_dispatch":true}'::jsonb, 'shadow', 'appointment-pipeline-check', NULL, 'Bot-booked appointments nobody can run', true)
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
VALUES ('appt.issue_by_2000', 'appointment', 'lead_perfection', 'Next-day CNF appointments issued by 20:15', 'Is every next-day confirmed appointment in Issued status (reps cannot see it otherwise)?', 'P1', '20:15 and 20:45 ET', NULL, 1500, 'any un-issued at 20:15', 'any un-issued at 20:45, or >= 3 at 20:15', '{"check_times_et":["20:15","20:45"],"fail_count_first":3}'::jsonb, 'shadow', 'appointment-pipeline-check', NULL, 'Rep never sees tomorrow''s appointment', true)
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
VALUES ('appt.issued_no_result', 'appointment', 'lead_perfection', 'Issued appointments get a result', 'Are issued appointments left without a disposition?', 'P2', 'daily 09:00 ET', NULL, 1500, '>= 5', '>= 15, or any > 72h', '{"fail":15,"warn":5,"fail_age_h":72}'::jsonb, 'shadow', 'appointment-pipeline-check', NULL, 'Unknown outcomes distort set/sit/close reporting', true)
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
VALUES ('appt.rep_not_acknowledged', 'appointment', 'lead_perfection', 'Reps acknowledged today''s appointments', 'Has every rep viewed/acknowledged today''s issued appointments?', 'P2', '07:30 and 08:30 ET', NULL, 1500, 'any unviewed at 07:30', 'any unviewed at 08:30', '{"needs":"Presentation status field (Gaps #14)"}'::jsonb, 'shadow', 'appointment-pipeline-check', NULL, 'Unviewed appointment = NoHome risk', true)
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
VALUES ('appt.required_fields', 'appointment', 'lead_perfection', 'Set appointments carry required fields', 'Do set appointments have Products/Qty and Rank/Appt Type?', 'P3', 'daily', NULL, 1500, '>= 5/day', '>= 15/day', '{"fail":15,"warn":5,"needs":"field names (Gaps #14)"}'::jsonb, 'shadow', 'appointment-pipeline-check', NULL, 'Dispatch cannot route blind', true)
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
VALUES ('appt.reschedule_on_issued_lead', 'appointment', 'lead_perfection', 'No reschedule inside an issued lead', 'Was an appointment rescheduled inside a lead already Issued/Run?', 'P3', 'daily', NULL, 1500, '>= 1/day', '>= 3/day', '{"fail":3,"warn":1}'::jsonb, 'shadow', 'appointment-pipeline-check', NULL, 'Breaks source/sub-source mirroring and rep stats', true)
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
VALUES ('appt.set_not_confirmed', 'appointment', 'lead_perfection', 'Tomorrow''s appointments confirmed', 'What share of tomorrow''s appointments is still Set after the 7 PM summary?', 'P2', '19:15 ET', NULL, 1500, '> 15% still Set', '> 30%, or any Set with no Conf dial today', '{"fail_pct":30,"warn_pct":15}'::jsonb, 'shadow', 'appointment-pipeline-check', NULL, 'Unconfirmed appointments no-show', true)
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
VALUES ('appt.unassigned_next_day', 'appointment', 'lead_perfection', 'Next-day CNF appointments have a rep', 'Does every next-day confirmed appointment have a sales rep?', 'P1', '19:30 and 20:15 ET', NULL, 1500, 'any unassigned at 19:30', 'any unassigned at 20:15', '{"check_times_et":["19:30","20:15"]}'::jsonb, 'shadow', 'appointment-pipeline-check', NULL, 'Unrouted appointment = NIS', true)
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
VALUES ('dialer.campaign_running', 'dialer', 'five9', 'Expected campaigns are RUNNING', 'Is every campaign in the expected-running set RUNNING during dialing hours?', 'P1', 'every 5 min', '08:00-20:00 ET', 12, '-', 'NOT_RUNNING sustained 10 min; UNREADABLE = unknown', '{"expected":["DIAL ASAP","After DIAL ASAP","Callback Request","Conf - Next Day","Conf - 2nd Day","Data - Hot Leads less than 7","Data - Warm Leads less than 30","Data - Leads more than 30","Rehash - New","Rehash","Rehash - Very Old","Resets-Hot","Reset-Warm","Simpletext outbound","Previous Customer"],"sustain_ms":600000}'::jsonb, 'shadow', 'health-checks', NULL, 'DIAL ASAP stopped = no new lead is dialed', true)
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
VALUES ('dialer.cap_3_in_24', 'dialer', 'five9', '3 dials per phone per 24h', 'Is any phone being dialed more than 3 times in a rolling 24h?', 'P2', 'hourly', NULL, 130, 'any phone at 4', 'any phone >= 5, or >= 10 phones at 4', '{"cap":3,"fail_at":5,"warn_at":4,"fail_phones_at_warn":10}'::jsonb, 'shadow', 'dialer-sla-check', NULL, 'Compliance and customer experience; Dana''s profile filters enforce it', true)
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
VALUES ('dialer.config_drift', 'dialer', 'five9', 'Five9 config unchanged', 'Did a campaign profile, filter, or list attachment change since the last approved snapshot?', 'P3', 'daily 04:10 ET', NULL, 1500, 'any change', 'change on DIAL ASAP V2 or After DIAL ASAP V2 profile (P2)', '{"source":"five9_config_changes","p2_profiles":["DIAL ASAP V2","After DIAL ASAP V2"]}'::jsonb, 'shadow', 'five9-config-snapshot', NULL, 'Unreviewed cadence change', true)
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
VALUES ('dialer.connector_after_asap', 'dialer', 'five9', 'No-contact DIAL ASAP leads reach After DIAL ASAP', 'Did the Five9 connector move no-contact leads to After DIAL ASAP?', 'P2', 'every 15 min', NULL, 35, '>= 3 missed per pass', '>= 10 missed or any > 2h', '{"fail":10,"warn":3,"fail_age_h":2}'::jsonb, 'shadow', 'after-asap-retry', NULL, 'Attempts 2 and 3 never happen', true)
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
VALUES ('dialer.dial_rate_drop', 'dialer', 'five9', 'Dials per campaign per hour', 'Is this hour''s dial volume normal for this weekday-hour?', 'P2', 'hourly', '08:00-20:00 ET', 130, '< 60% of 4-week median', '< 30% or 0 for 60 min', '{"fail_pct":30,"warn_pct":60,"baseline_weeks":4,"requires_running_and_agents":true}'::jsonb, 'shadow', 'dialer-sla-check', NULL, 'Silent capacity loss', true)
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
VALUES ('dialer.first_dial_sla', 'dialer', 'five9', 'First dial inside SLA', 'Did DIAL ASAP leads get their first dial within 15 min (Callback inside its window)?', 'P1', 'every 15 min', '08:00-20:00 ET', 35, 'p50 > 10 min', 'any lead > 30 min, or >= 3 > 15 min', '{"fail_any_min":30,"warn_p50_min":10,"dial_asap_sla_min":15,"fail_count_over_sla":3}'::jsonb, 'shadow', 'dialer-sla-check', NULL, 'Speed to lead drives set rate', true)
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
VALUES ('dialer.list_membership_sla', 'dialer', 'five9', 'Lead on its expected list inside SLA', 'Is each new lead on the list its routing intent says, inside the SLA?', 'P1', 'every 15 min', '08:00-20:00 ET', 35, '>= 1 lead late', '>= 3 late, or any lead > 2x SLA', '{"chunk":500,"sla_min":{"DIAL ASAP":5,"After DIAL ASAP":30,"Callback Request":5},"conf_rule":"Conf - 2nd Day by 08:00 ET two days before; Conf - Next Day by 08:00 ET the day before","lookup_cap":300}'::jsonb, 'shadow', 'dialer-sla-check', NULL, 'Wrong list = wrong cadence = missed first call', true)
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
VALUES ('dialer.list_stalled', 'dialer', 'five9', 'List with records not being worked', 'Is a list with records and ready agents going undialed?', 'P1', 'every 15 min', '08:00-20:00 ET', 35, 'no dial in 30 min', 'no dial in 60 min', '{"fail_min":60,"warn_min":30,"start_after":"08:00 ET (lists repopulate 06:00)","requires_agents_ready":true}'::jsonb, 'shadow', 'dialer-sla-check', NULL, 'A stalled DIAL ASAP list is every new lead waiting', true)
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
VALUES ('dialer.never_again', 'dialer', 'five9', 'ND / No Demo / DNC never dialed again', 'Is any ND, No Demo, or DNC lead on a dial list?', 'P2', 'daily 07:30 ET', NULL, 1500, '>= 1', '>= 3', '{"fail":3,"warn":1,"never_dispositions":["ND","No Demo"]}'::jsonb, 'shadow', 'dialer-sla-check', NULL, 'Decided 2026-10-07; a breach is a complaint risk', true)
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
VALUES ('dialer.silence', 'dialer', 'five9', 'Five9 producing events', 'Is Five9 producing any events at all?', 'P1', 'hourly', NULL, 130, 'existing watchdog thresholds', 'existing watchdog thresholds', '{"source":"five9-silence-watchdog"}'::jsonb, 'shadow', 'five9-silence-watchdog', NULL, 'Whole dialer dark', true)
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
VALUES ('dialer.unmapped_last', 'dialer', 'five9', 'Unmapped queue dialed last', 'Is the Unmapped queue being dialed while mapped lists still have records?', 'P3', 'hourly', '08:00-20:00 ET', 130, 'any unmapped dial while a mapped list > 0', 'sustained 1h', '{"unmapped_list":"Data - Warm Unmapped"}'::jsonb, 'shadow', 'dialer-sla-check', NULL, 'Agents working the wrong leads', true)
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
VALUES ('ghl.dead_triggers', 'workflow', 'ghl', 'Draft workflows with live triggers', 'Any new draft workflow with a live trigger or a cross-workflow duplicate trigger?', 'P3', 'daily', NULL, 1500, 'any new', '-', '{"source":"detect_dead_workflows, find_duplicate_triggers (cross-workflow only)"}'::jsonb, 'shadow', 'health-checks', NULL, 'Contacts enrolled in drafts', true)
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
VALUES ('ghl.rate_limiter', 'workflow', 'ghl', 'HL MCP GHL limiter healthy', 'Is the GHL rate limiter healthy?', 'P2', 'every min', NULL, 5, 'tokens < 20% for 10 min', 'unhealthy sustained 10 min', '{"source":"/n8n/rate-limiter/stats","sustain_ms":600000}'::jsonb, 'shadow', 'health-checks', NULL, 'Every GHL write queues', true)
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
VALUES ('ghl.rule_targets', 'workflow', 'ghl', 'Agent rules target published workflows', 'Does every enabled agent rule point at a published GHL workflow?', 'P3', 'daily', NULL, 1500, 'any unpublished', 'any missing', '{"source":"rule_target_checks"}'::jsonb, 'shadow', 'rule-target-check', NULL, 'Rule fires into nothing', true)
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
VALUES ('ghl.webhook_liveness', 'workflow', 'webhooks', 'GHL webhooks delivering', 'Are GHL workflow webhooks still arriving at expected volume?', 'P2', 'hourly', '08:00-20:00 ET', 130, '< 50% of expected for 2h', '0 in 2h during 08-20 ET', '{"source":"lead_events / ghl_workflow_webhooks","warn_pct":50,"fail_zero_h":2,"baseline_weeks":4}'::jsonb, 'shadow', 'health-checks', NULL, 'Intake path dark', true)
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
VALUES ('jobs.failed', 'workflow', 'railway', 'LP-MCP jobs failing', 'Is any registered job failing repeatedly?', 'P2', 'every 5 min', NULL, 12, '1 fail in last 3 runs', '3 consecutive fails, or a P1 job never run / stale > 2x cadence', '{"note":"promised-callback-sweep 163 fails/7d and rehash-tag-sweep 83/7d must be fixed or excluded before live (Gaps #11)","source":"v_job_status","fail_consecutive":3}'::jsonb, 'shadow', 'health-checks', NULL, 'Silent automation loss', true)
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
VALUES ('jobs.silent', 'workflow', 'railway', 'LP-MCP jobs silent', 'Is any enabled job silent past 2x its cadence?', 'P2', 'every 5 min', NULL, 12, '2x cadence', '4x cadence', '{"fail_x":4,"source":"v_job_status","warn_x":2}'::jsonb, 'shadow', 'health-checks', NULL, 'The failure mode that caused the 47h outage', true)
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
VALUES ('lead.booked_without_lp', 'lead', 'lead_perfection', 'Appointments set with no LP record', 'Is any GHL appointment set without an LP lead behind it?', 'P1', 'hourly', NULL, 130, '>= 1 in 24h', '>= 3 in 24h', '{"fail":3,"warn":1,"source":"get_identity_health.appt_set_without_lp_record"}'::jsonb, 'shadow', 'health-checks', NULL, 'A booked appointment LP cannot dispatch is a no-show', true)
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
VALUES ('lead.canvass_to_lp', 'lead', 'lead_perfection', 'Canvass leads delivered', 'Did every canvass form lead reach LP and the dialer?', 'P1', 'every 15 min', NULL, 35, '1 undelivered > 30 min', '>= 2 undelivered or any > 2h', '{"fail_wait_min":120,"warn_wait_min":30}'::jsonb, 'shadow', 'canvass-lead-backstop', NULL, 'Canvassers are paid per lead; a dropped lead is a wasted door', true)
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
VALUES ('lead.chat_to_lp', 'lead', 'lead_perfection', 'Chat leads sent to LP', 'Are chatbot / chat-widget leads reaching LP?', 'P1', 'every 15 min', NULL, 35, 'any would_send in shadow', 'any failed send in live', '{"source":"chat-lead-intake job detail"}'::jsonb, 'shadow', 'chat-lead-intake', NULL, '18/day were missing in Sep', true)
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
VALUES ('lead.first_call_p90', 'lead', 'five9', 'Time to first call (p90, yesterday)', 'Were yesterday''s leads dialed fast?', 'P2', 'daily 08:10 ET', NULL, 1500, 'p90 > 120 min', 'p90 > 240 min or never_called > 3% of expected', '{"source":"lead_call_speed_daily","fail_p90_min":240,"warn_p90_min":120,"fail_never_called_pct":3}'::jsonb, 'shadow', 'lead-leak-monitor', NULL, 'Slow first call lowers set rate on every source', true)
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
VALUES ('lead.in_inbound_queue', 'lead', 'lead_perfection', 'Leads still in LP inbound queue at leak time', 'How many leaked leads were simply never checked out of the LP inbound queue?', 'P1', 'daily 08:10 ET', NULL, 1500, '>= 3', '>= 10', '{"reason":"in_inbound_queue","source":"lead_leak_daily","fail_leads":10,"warn_leads":3}'::jsonb, 'shadow', 'lead-leak-monitor', NULL, 'Human intake bottleneck, not an automation gap', true)
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
VALUES ('lead.intake_gap', 'lead', 'lead_perfection', 'GHL contacts that never became an LP lead', 'Did every GHL contact with a lead source reach LP within 60 min?', 'P1', 'hourly', '08:00-20:00 ET', 130, '>= 1 in last 2h', '>= 3 in last 2h', '{"fail":3,"warn":1,"source":"lead_intake_gap_daily","window_h":2}'::jsonb, 'shadow', 'health-checks', NULL, 'A contact that never reaches LP is never dialed', true)
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
VALUES ('lead.not_in_five9', 'lead', 'five9', 'Leads Five9 has no record of', 'How many leads in the window never reached Five9 at all (after inbound checkout)?', 'P1', 'daily 08:10 ET', NULL, 1500, '> 5 leads/day', '> 10 leads/day or est_value > $25k', '{"reason":"not_in_five9","source":"lead_leak_daily","fail_leads":10,"fail_value":25000,"warn_leads":5}'::jsonb, 'shadow', 'lead-leak-monitor', NULL, 'Oct 14: 42 leads, $94k classified here; to be split from in_inbound_queue', true)
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
VALUES ('lead.routing_failure', 'lead', 'five9', 'Routing or automation failures', 'How many leads leaked because routing or an automation failed?', 'P1', 'daily 08:10 ET', NULL, 1500, '>= 1', '>= 3', '{"reasons":["routing_or_automation_failure","on_list_not_dialed"],"fail_leads":3,"warn_leads":1}'::jsonb, 'shadow', 'lead-leak-monitor', NULL, 'Oct 14: 6 leads, $8.8k', true)
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
VALUES ('lead.uncalled_live', 'lead', 'five9', 'Leads waiting with no Five9 call', 'Does every LP lead created in the last 24h (phone, not DNC, not Set/Sale) have at least one Five9 dial?', 'P1', 'hourly 08-20 ET', '08:00-20:00 ET', 130, 'any lead waiting > 30 min', 'any lead waiting > 60 min, or 3+ leads > 30 min', '{"source":"lead-speed-alerts.js","fail_wait_min":60,"warn_wait_min":30,"fail_count_over_warn":3}'::jsonb, 'shadow', 'lead-uncalled-check', NULL, 'A lead nobody called today is a lead a competitor calls; est_value from close rate x avg job value', true)
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
VALUES ('n8n.cron_silence', 'workflow', 'n8n', 'Scheduled n8n workflows ran', 'Did every active cron-triggered workflow run inside 2x its interval?', 'P2', 'every 15 min', NULL, 35, '> 2x interval', '> 4x interval', '{"fail_x":4,"warn_x":2,"interval_from":"workflow JSON in GitHub mrichard33/n8n"}'::jsonb, 'shadow', 'n8n-execution-poller', NULL, 'LP report ingest, LF daily, VDR weekly silently stop', true)
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
VALUES ('n8n.errors', 'workflow', 'n8n', 'n8n error executions', 'Are active n8n workflows erroring?', 'P2', 'every 5 min', NULL, 12, '>= 2 errors/workflow/hour', '>= 5, or any error on an intake workflow', '{"source":"n8n_execution_log","fail_per_wf_h":5,"warn_per_wf_h":2,"intake_prefixes":["I.","OPS.DNC-LIFT","05 LF","06 VDR"]}'::jsonb, 'shadow', 'n8n-execution-poller', NULL, 'Oct 14: 10 errors in 3h, 7 on 06 VDR', true)
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
VALUES ('n8n.reachable', 'workflow', 'n8n', 'n8n /healthz', 'Does n8n answer /healthz?', 'P2', 'every 5 min', NULL, 12, '1 miss', '2 consecutive misses', '{"fail_consecutive":2}'::jsonb, 'shadow', 'health-checks', NULL, 'All orchestration down', true)
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
VALUES ('svc.dashboard', 'service', 'railway', 'Dashboard serving', 'Does /overview return 200?', 'P2', 'every 5 min', NULL, 12, '> 3s', '2 misses', '{"url":"https://dashboard.getreecewindows.com/overview","fail_consecutive":2}'::jsonb, 'shadow', 'health-checks', NULL, 'Command center dark', true)
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
VALUES ('svc.five9_api', 'service', 'five9', 'Five9 API reachable', 'Does the Five9 Admin API answer?', 'P1', 'every 5 min', NULL, 12, '1 miss', '2 consecutive misses', '{"source":"/health/integrations","fail_consecutive":2}'::jsonb, 'shadow', 'health-checks', NULL, 'Dialer blind', true)
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
VALUES ('svc.hl_mcp', 'service', 'railway', 'HL MCP up', 'Does HL MCP answer and is its latest deploy SUCCESS?', 'P1', 'every 5 min', NULL, 12, 'latency > 3s or deploy in progress > 10 min', 'unreachable 2 probes, or deploy FAILED/CRASHED', '{"alert_24_7":true,"warn_latency_ms":3000,"fail_consecutive":2}'::jsonb, 'shadow', 'health-checks', NULL, 'GHL hands down', true)
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
VALUES ('svc.lp_api', 'service', 'lead_perfection', 'Lead Perfection API reachable', 'Does the LP API answer?', 'P1', 'every 5 min', NULL, 12, '1 miss', '2 consecutive misses', '{"source":"/health/integrations","fail_consecutive":2}'::jsonb, 'shadow', 'health-checks', NULL, 'No new leads, no sync', true)
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
VALUES ('svc.lp_mcp', 'service', 'railway', 'LP MCP up', 'Does LP MCP answer and is its latest deploy SUCCESS?', 'P1', 'every 5 min', NULL, 12, 'latency > 3s or deploy in progress > 10 min', 'unreachable 2 probes, or deploy FAILED/CRASHED', '{"alert_24_7":true,"warn_latency_ms":3000,"fail_consecutive":2}'::jsonb, 'shadow', 'health-checks', NULL, 'Brain down: every job and backstop stops', true)
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
VALUES ('svc.railway_restarts', 'service', 'railway', 'Service restarts', 'Is a service restarting repeatedly?', 'P2', 'every 15 min', NULL, 35, '>= 2 in 1h', '>= 4 in 1h', '{"fail":4,"warn":2,"services":["LP-MCP","HL-MCP","n8n","Reece Dashboard"]}'::jsonb, 'shadow', 'health-checks', NULL, 'Crash loop', true)
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
VALUES ('svc.slack', 'service', 'webhooks', 'Slack reachable', 'Does Slack accept a post?', 'P2', 'every 5 min', NULL, 12, '1 miss', '2 consecutive misses', '{"source":"/health/integrations","fail_consecutive":2}'::jsonb, 'shadow', 'health-checks', NULL, 'Alerts silently lost', true)
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
VALUES ('svc.supabase_hl', 'service', 'supabase', 'HL Supabase healthy', 'Does a read work and are disk/CPU below limits?', 'P2', 'every 5 min', NULL, 12, 'CPU > 70% 15 min', 'read fails, or disk > 90%', '{"project":"jtlngmcrtqncimtjjzlz","warn_cpu_pct":70,"fail_disk_pct":90}'::jsonb, 'shadow', 'health-checks', NULL, 'GHL cache down', true)
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
VALUES ('svc.supabase_lp', 'service', 'supabase', 'LP Supabase healthy', 'Does a read work and are disk/CPU below limits?', 'P1', 'every 5 min', NULL, 12, 'CPU > 70% 15 min', 'read fails, or disk > 90%', '{"project":"rcjcgjlqzepicbwhnnjl","warn_cpu_pct":70,"fail_disk_pct":90}'::jsonb, 'shadow', 'health-checks', NULL, 'Memory down', true)
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
VALUES ('syn.chatbot_reply', 'synthetic', 'ai_agents', 'Canary: chatbot reply', 'Does the bot reply to a scripted message inside SLA?', 'P2', 'offline hourly; live 2x/day', NULL, 130, '-', 'no reply inside SLA or wrong shape', '{"offline_scripts":3,"live_runs_per_day":2}'::jsonb, 'shadow', 'synthetic-canary', NULL, 'Bot down or regressed', true)
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
VALUES ('syn.ghl_webhook_roundtrip', 'synthetic', 'webhooks', 'Canary: GHL webhook round trip', 'Does a tag on a standing synthetic contact reach LP-MCP within 2 min?', 'P2', 'every 30 min', NULL, 65, '-', 'nonce not seen in 2 min', '{"workflow":"ZZ.CANARY","budget_min":2}'::jsonb, 'shadow', 'synthetic-canary', NULL, 'GHL engine + webhook + ingress', true)
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
VALUES ('syn.lead_to_lp', 'synthetic', 'lead_perfection', 'Canary: GHL contact -> LP lead', 'Does a synthetic contact become an LP lead within 10 min?', 'P1', '08:30 and 13:30 ET', '08:00-20:00 ET', 1500, '-', 'any step failed or > 10 min', '{"needs":"Gaps #3-5","budget_min":10,"identities":30,"lp_footprint_per_day":2}'::jsonb, 'shadow', 'synthetic-canary', NULL, 'Proves the intake pipe without a real lead', true)
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
VALUES ('syn.lp_api_read', 'synthetic', 'lead_perfection', 'Canary: LP API read', 'Does the LP API return a known lead?', 'P1', 'every 15 min', NULL, 35, '1 miss', '2 consecutive misses', '{"fail_consecutive":2}'::jsonb, 'shadow', 'synthetic-canary', NULL, 'LP auth expiry before the sync notices', true)
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
VALUES ('syn.lp_to_five9_list', 'synthetic', 'five9', 'Canary: LP lead -> DIAL ASAP list', 'Does the synthetic lead land on DIAL ASAP within 5 min and get removed before any dial?', 'P1', 'with syn.lead_to_lp', '08:00-20:00 ET', 1500, '-', 'not on list in 5 min, or not removed in 60s', '{"budget_min":5,"remove_within_s":60}'::jsonb, 'shadow', 'synthetic-canary', NULL, 'Proves LP -> Five9 routing', true)
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
VALUES ('syn.n8n_roundtrip', 'synthetic', 'n8n', 'Canary: n8n round trip', 'Does an n8n webhook workflow write back within 2 min?', 'P2', 'every 30 min', NULL, 65, '-', 'not seen in 2 min', '{"workflow":"OPS.CANARY","budget_min":2}'::jsonb, 'shadow', 'synthetic-canary', NULL, 'n8n -> LP-MCP auth and networking', true)
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
VALUES ('syn.slack_delivery', 'synthetic', 'webhooks', 'Canary: Slack delivery', 'Does a post to #ops-canary read back within 30 s?', 'P2', 'every 30 min', NULL, 65, '-', 'not read back in 30 s', '{"channel":"#ops-canary (to create)","budget_s":30}'::jsonb, 'shadow', 'synthetic-canary', NULL, 'Quiet vs broken Slack', true)
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
VALUES ('sync.appt_parity', 'sync', 'ghl', 'LP / GHL appointment parity', 'Do LP and GHL appointment fields agree?', 'P2', 'every 30 min', NULL, 65, 'new gaps >= 5', '>= 20', '{"fail":20,"note":"issue #2361","warn":5,"min_age_min":15}'::jsonb, 'shadow', 'health-checks', NULL, 'Reps and bot act on the wrong time', true)
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
VALUES ('sync.five9_key_pct', 'sync', 'five9', 'Five9 events carry an LP key', 'What share of Five9 events carries lp_rec_key?', 'P2', 'daily', NULL, 1500, '< 90%', '< 85%', '{"fail_pct":85,"warn_pct":90}'::jsonb, 'shadow', 'health-checks', NULL, 'Call truth cannot be joined to leads', true)
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
VALUES ('sync.hl_cache_fresh', 'sync', 'ghl', 'HL cache fresh per entity', 'Is the GHL cache in HL Supabase current?', 'P2', 'every 5 min', NULL, 12, 'any entity > 30 min', 'contacts or opportunities > 2h, or failure_rate_24h > 5%', '{"source":"HL MCP get_sync_health","fail_min":120,"warn_min":30,"fail_rate_pct":5}'::jsonb, 'shadow', 'health-checks', NULL, 'GHL-side checks go blind', true)
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
VALUES ('sync.lp_errors', 'sync', 'lead_perfection', 'Unresolved LP sync errors', 'Are LP sync errors piling up?', 'P2', 'every 15 min', NULL, 35, '> 5 new in 1h', '> 20, or any > 24h old', '{"source":"lp_sync_errors resolved=false","fail_age_h":24,"fail_total":20,"warn_new_1h":5}'::jsonb, 'shadow', 'health-checks', NULL, 'Leads not mirrored are invisible to every monitor', true)
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
VALUES ('sync.lp_ghl_link_pct', 'sync', 'ghl', 'New LP leads linked to GHL', 'What share of the last 30 days of LP leads is linked to a GHL contact?', 'P2', 'daily', NULL, 1500, '< 98%', '< 95%', '{"source":"get_identity_health","fail_pct":95,"warn_pct":98}'::jsonb, 'shadow', 'link-leak-monitor', NULL, 'Unlinked leads get no nurture and no bot', true)
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
VALUES ('sync.lp_leads_fresh', 'sync', 'supabase', 'LP lead mirror fresh', 'Is the LP -> Supabase lead mirror current?', 'P2', 'every 5 min', '08:00-20:00 ET', 12, '> 20 min since newest lp_leads.updated_at', '> 45 min, or last sync failed twice', '{"source":"lp_leads.updated_at_lp, lp_sync_log","fail_min":45,"warn_min":20,"fail_consecutive":2}'::jsonb, 'shadow', 'health-checks', NULL, 'Every check downstream reads stale data', true)
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
VALUES ('sync.lp_reports', 'sync', 'lead_perfection', 'LP scheduled reports arrived', 'Did reports 133 Jobs By Status, 134 Jobs by Milestone Date, 135 Lead Disposition Detail 2, 136 Mktg Sub-Source Cost Analysis 2, 137 Sales Efficiency By Mode arrive and parse?', 'P2', 'every 5 min from 07:30 ET', NULL, 12, 'missing after 08:30 ET', 'missing after 10:00 ET or parse quarantine', '{"reports":{"133":"Jobs By Status","134":"Jobs by Milestone Date","135":"Lead Disposition Detail 2","136":"Mktg Sub-Source Cost Analysis 2","137":"Sales Efficiency By Mode"},"fail_at_et":"10:00","warn_at_et":"08:30"}'::jsonb, 'shadow', 'lp-report-watchdog', NULL, 'Scorecard day missing', true)
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
VALUES ('sync.retired_code', 'sync', 'lead_perfection', 'Retired disposition codes in use', 'Is NIS2 or another retired code appearing on new leads?', 'P3', 'daily', NULL, 1500, '>= 1', '>= 5', '{"fail":5,"warn":1,"retired":["NIS2"]}'::jsonb, 'shadow', 'lead-leak-monitor', NULL, 'Leak classification silently wrong', true)
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
VALUES ('sync.stale_set_leads', 'sync', 'lead_perfection', 'Set leads past their appointment', 'How many Set leads have an appointment > 24h in the past with no result?', 'P2', 'nightly', NULL, 1500, '>= 10', '>= 40', '{"fail":40,"warn":10}'::jsonb, 'shadow', 'lp-stale-lead-refresh', NULL, 'Scorecard overstates sets', true)
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

-- Verify (expect 73 and 4):
-- SELECT count(*) FROM health_checks; SELECT count(*) FROM escalation_policy;
