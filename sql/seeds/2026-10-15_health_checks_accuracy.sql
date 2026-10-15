-- Health checks: the words for the rules changed in the 2026-10-15 accuracy
-- review (the user: "make the System Health Dashboard accurate, easy to
-- understand, and focused on issues that actually require immediate attention").
--
-- WHAT: label / question / warn_rule / fail_rule text for 7 checks whose rule
-- changed in code the same day (src/health/dialer-sla.js,
-- src/health/watchdog-results.js, src/health/appointment-pipeline.js), and
-- appt.issue_by_2000's now-unused config key fail_count_first.
-- NOT: cadence, active_window, severity, mode, owner_job_id.
--
-- The block raises (and changes nothing) unless exactly 7 checks are updated.
-- Verify:
--   SELECT fail_rule FROM health_checks WHERE check_id = 'appt.issue_by_2000';  -- Any still not issued at 8:45 PM

DO $acc$
DECLARE n int;
BEGIN
  UPDATE health_checks h
     SET label = w.label, question = w.question, warn_rule = w.warn_rule,
         fail_rule = w.fail_rule, updated_at = now()
    FROM (VALUES
    ('appt.issue_by_2000', 'Tomorrow''s appointments issued by 8:15 PM', 'Has every confirmed appointment for tomorrow been issued to a rep by 8:15 PM?', 'Any not issued at 8:15 PM', 'Any still not issued at 8:45 PM'),
    ('dialer.list_stalled', 'Agents available and calling lists worked', 'During call-center hours, are agents logged in, and is every calling list with leads waiting being dialed?', 'No agent working, or a list with leads not dialed in 30 minutes', 'No agent working and no call for 30 minutes, or a list with leads not dialed in 60 minutes'),
    ('dialer.first_dial_sla', 'New leads called within 15 minutes', 'Is each new lead called within 15 minutes of arriving (call-center hours only)?', 'Half of them took more than 10 minutes', 'Any lead waited more than 30 minutes, or 3 or more waited more than 15'),
    ('dialer.never_again', '"No Demo" and Do Not Call leads not called again', 'Was a "No Demo" or Do Not Call lead called again after it was marked? (The Reset campaigns call No Demo leads on purpose and are listed separately.)', '1 lead called again', '3 or more called again, or any Do Not Call lead'),
    ('lead.uncalled_live', 'Leads waiting for a first call', 'Is any new lead still waiting for its first call, or waiting on a second call after one try?', 'A lead waiting more than 30 minutes, or a lead called once with no second call', 'A lead waiting more than an hour for a first call, or 3 or more waiting more than 30 minutes'),
    ('lead.not_in_five9', 'Leads that never reached Five9', 'Did any lead from the last 2 days never reach Five9? Older ones still open are listed for cleanup.', 'More than 5 new, or older ones still open', 'More than 10 new, or new ones worth more than $25,000'),
    ('lead.routing_failure', 'Leads lost to routing problems', 'Did a lead from the last 2 days get lost to a routing or automation problem? Older ones still open are listed for cleanup.', '1 new, or older ones still open', '3 or more new')
    ) AS w(check_id, label, question, warn_rule, fail_rule)
   WHERE h.check_id = w.check_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 7 THEN RAISE EXCEPTION 'expected 7 checks, updated %', n; END IF;
  UPDATE health_checks SET config = config - 'fail_count_first', updated_at = now() WHERE check_id = 'appt.issue_by_2000';
END
$acc$;
