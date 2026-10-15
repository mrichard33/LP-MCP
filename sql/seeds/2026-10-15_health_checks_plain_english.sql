-- Health checks in plain English (2026-10-15, the user, after the first look
-- at /system-health: "P1", "20:45 ET", "p90", "SLA" and "parity" meant nothing
-- to the people the board is for).
--
-- WHAT: rewrites the words people read on each check: label, question,
-- warn_rule ("Turns yellow when"), fail_rule ("Turns red when") and
-- business_impact. Times are Eastern on a 12-hour clock.
-- NOT: cadence and active_window. Code reads those ("08:00-20:00 ET", "every 5
-- min"), so they stay as they are and the dashboard shows them as 12-hour time.
-- config, severity, mode and owner_job_id are untouched too: nothing about
-- WHEN a check turns yellow or red changes here.
--
-- Also renames the two incidents opened from old alerts on 2026-10-15 (their
-- titles were set once, at open).
--
-- Applied through the MCP on 2026-10-15; sql/seeds/health_checks.sql is the
-- re-export afterwards. The block raises (and changes nothing) unless exactly
-- 74 checks are updated. Verify:
--   SELECT count(*) FROM health_checks WHERE label = 'Automatic actions failing';  -- 1

DO $plain$
DECLARE n int;
BEGIN
  UPDATE health_checks h
     SET label = w.label, question = w.question, warn_rule = w.warn_rule,
         fail_rule = w.fail_rule, business_impact = w.business_impact, updated_at = now()
    FROM (VALUES
    ('agent.action_failures', 'Automatic actions failing', 'Are the system''s automatic actions failing even after retries?', '5 or more fail in an hour', '20 or more fail in an hour, or any lead fails to reach Five9 or Lead Perfection', 'A lead that never reaches Five9 never gets called.'),
    ('agent.approval_backlog', 'Approvals waiting', 'Is something waiting too long for a person to approve it?', 'Waiting more than 4 business hours', 'Waiting more than a day', 'Fixes and changes sit unapproved.'),
    ('agent.bot_reply_sla', 'Chatbot answering on time', 'Is the chatbot answering customer texts quickly?', 'Not used', 'Any customer text waits longer than the reply limit', 'Leads wait on the bot and go cold.'),
    ('agent.executor_heartbeat', 'Automation worker running', 'Is the worker that carries out automatic actions running?', 'It hasn''t run for 3 minutes while work is waiting', 'It hasn''t run for 6 minutes while work is waiting', 'Nothing automatic gets done.'),
    ('agent.guardrail_blocks', 'Safety filter blocks', 'Is the safety filter blocking far more messages than normal?', 'More than 2 times a normal hour', 'More than 5 times a normal hour', 'The bot may be misbehaving or someone may be trying to trick it.'),
    ('agent.llm_cost', 'Daily AI spend', 'Is today''s AI spending within budget?', 'Over 80% of the daily budget', 'Over the daily budget', 'A runaway process can spend a lot quickly.'),
    ('agent.queue_depth', 'Automatic actions waiting', 'Are automatic actions piling up or waiting too long?', 'Oldest waits more than 15 minutes, or more than 50 are waiting', 'Oldest waits more than 45 minutes, or more than 200 are waiting', 'Leads get routed late.'),
    ('appt.capacity_over', 'Enough reps for tomorrow', 'Does each office have enough reps for tomorrow''s appointments in each time block?', '1 more appointment than reps in a block', '3 or more too many in one office block', 'Overbooked appointments go unrun.'),
    ('appt.conf_attempt_coverage', 'Confirmation calls made', 'Did every unconfirmed appointment for tomorrow get at least one confirmation call today?', 'Any not called by 5:00 PM', 'Any not called by 7:00 PM', 'Replaces the hand count on the confirmation summary sheet.'),
    ('appt.duplicate_prospects', 'Customers entered twice', 'Is any customer with an upcoming appointment entered twice in Lead Perfection?', '5 or more', '20 or more', 'History gets split and the customer may be called twice.'),
    ('appt.inbound_queue_age', 'New inquiries waiting in Lead Perfection', 'Are new inquiries waiting too long in Lead Perfection to be turned into leads?', 'The oldest has waited 20 office minutes, or more than 10 are waiting', 'The oldest has waited 45 office minutes, or more than 25 are waiting', 'An inquiry still waiting is on no calling list.'),
    ('appt.invalid_time_or_block', 'Appointment times we don''t book', 'Is any appointment this week booked at a time we don''t run (noon, 4 PM, or a sales-meeting morning)?', 'Any appointment at a time we don''t book', 'Any booked by the chatbot or an automation (once dispatch confirms the rules)', 'An appointment nobody can run.'),
    ('appt.issue_by_2000', 'Tomorrow''s appointments issued by 8:15 PM', 'Has every confirmed appointment for tomorrow been issued to a rep (reps can''t see it otherwise)?', 'Any not issued at 8:15 PM', 'Any not issued at 8:45 PM, or 3 or more at 8:15 PM', 'The rep never sees tomorrow''s appointment.'),
    ('appt.issued_no_result', 'Issued appointments have a result', 'Does every issued appointment from before yesterday have a result entered?', '5 or more without a result', '15 or more, or any older than 3 days', 'Missing results make the set, sit and close numbers wrong.'),
    ('appt.rep_not_acknowledged', 'Reps saw today''s appointments', 'Has every rep viewed today''s appointments? (Lead Perfection doesn''t share this yet.)', 'Any not viewed at 7:30 AM', 'Any not viewed at 8:30 AM', 'An unviewed appointment risks a no-show.'),
    ('appt.required_fields', 'Appointments have the required details', 'Does every appointment set in the last day have its product, quantity and appointment type?', '5 or more missing details in a day', '15 or more in a day', 'Dispatch can''t route an appointment without them.'),
    ('appt.reschedule_on_issued_lead', 'No new appointment on an issued lead', 'Was a new appointment booked on a lead whose appointment was already issued?', '1 or more in a day', '3 or more in a day', 'It breaks lead-source tracking and rep stats.'),
    ('appt.set_not_confirmed', 'Tomorrow''s appointments confirmed', 'How many of tomorrow''s appointments were still not confirmed at 7:15 PM?', 'More than 15% not confirmed', 'More than 30% not confirmed', 'Unconfirmed appointments are more likely to be no-shows.'),
    ('appt.unassigned_next_day', 'Tomorrow''s appointments have a rep', 'Does every confirmed appointment for tomorrow have a sales rep?', 'Any without a rep at 7:30 PM', 'Any without a rep at 8:15 PM', 'An appointment with no rep goes unrun.'),
    ('ci.recording_archive', 'Call recordings reachable', 'Can the system reach the call recordings to analyze calls?', 'Not used', 'The recordings can''t be reached', 'Phone calls aren''t analyzed while the recordings can''t be reached.'),
    ('dialer.campaign_running', 'Calling campaigns running', 'Is every calling campaign that should be running actually running during calling hours?', 'Not used', 'A campaign has been stopped for 10 minutes', 'If DIAL ASAP stops, no new lead gets called.'),
    ('dialer.cap_3_in_24', 'No phone called more than 3 times a day', 'Is any phone number being called more than 3 times in 24 hours?', 'Any number called 4 times', 'Any number called 5 or more times, or 10 or more numbers called 4 times', 'Customer experience and calling rules.'),
    ('dialer.config_drift', 'Five9 settings unchanged', 'Did any Five9 campaign, filter or list setting change since yesterday?', 'Any change', 'A change to the DIAL ASAP or After DIAL ASAP settings', 'An unreviewed change alters who gets called and when.'),
    ('dialer.connector_after_asap', 'Unreached leads move to the follow-up list', 'Do unreached DIAL ASAP leads move to the After DIAL ASAP follow-up list on their own?', '3 or more missed in one pass', '10 or more missed, or any waiting more than 2 hours', 'Second and third call attempts never happen.'),
    ('dialer.dial_rate_drop', 'Dialing pace', 'Are campaigns dialing at their normal pace for this time of day?', 'Below 60% of normal', 'Below 30% of normal, or no dials for an hour', 'Calling capacity quietly drops.'),
    ('dialer.first_dial_sla', 'New leads called within 15 minutes', 'Did new DIAL ASAP leads get their first call within 15 minutes?', 'Half of them took more than 10 minutes', 'Any lead waited more than 30 minutes, or 3 or more waited more than 15', 'Calling fast is what books appointments.'),
    ('dialer.list_membership_sla', 'Leads on the right calling list', 'Is each new lead on the Five9 calling list it should be on, in time?', '1 lead late', '3 or more late, or any very late', 'The wrong list means the wrong call schedule and a missed first call.'),
    ('dialer.list_stalled', 'Calling lists being worked', 'Is a calling list with leads waiting going undialed while agents are ready?', 'No dial in 30 minutes', 'No dial in 60 minutes', 'A stalled DIAL ASAP list means every new lead is waiting.'),
    ('dialer.never_again', '"No Demo" and Do Not Call leads not called again', 'Is any lead marked No Demo, ND or Do Not Call still being called?', '1 or more', '3 or more', 'Calling them is a complaint risk (ruled 2026-10-07).'),
    ('dialer.silence', 'Five9 sending call activity', 'Is Five9 sending any call activity at all?', 'Quiet for longer than usual', 'Quiet for much longer than usual', 'The whole dialer may be down.'),
    ('dialer.unmapped_last', 'Unmapped leads called last', 'Are unmapped leads being called while the regular lists still have leads? (Can''t be measured yet.)', 'Any unmapped call while a regular list has leads', 'For an hour', 'Agents call the wrong leads.'),
    ('ghl.dead_triggers', 'GHL workflows starting correctly', 'Can an unpublished GHL workflow still start, or does one trigger start several workflows?', 'Any new case', 'Not used', 'Contacts end up in unfinished or duplicate workflows.'),
    ('ghl.rate_limiter', 'Within GHL''s request limit', 'Are we staying within GHL''s limit on requests?', 'Close to the limit for 10 minutes', 'Over the limit for 10 minutes', 'Every update to GHL is delayed.'),
    ('ghl.rule_targets', 'Automation rules reach live workflows', 'Does every automation rule send contacts to a published GHL workflow?', 'Any rule points at an unpublished workflow', 'Any rule points at a workflow that doesn''t exist', 'The rule fires and nothing happens.'),
    ('ghl.webhook_liveness', 'GHL sending updates', 'Are updates from GHL still arriving at the usual volume?', 'Under half the usual for 2 hours', 'None for 2 hours during the day', 'New leads from GHL stop arriving.'),
    ('jobs.failed', 'Background jobs failing', 'Is any background job failing again and again?', '1 failure in its last 3 runs', '3 failures in a row', 'Automations silently stop.'),
    ('jobs.silent', 'Background jobs running on time', 'Has any background job stopped running on its schedule?', 'Quiet for twice its normal gap', 'Quiet for four times its normal gap', 'This is how the 47-hour outage went unnoticed.'),
    ('lead.booked_without_lp', 'Appointments with no lead in Lead Perfection', 'Was any appointment booked on a call for someone with no lead in Lead Perfection?', '1 or more in a day', '3 or more in a day', 'Lead Perfection can''t dispatch it, so it becomes a no-show.'),
    ('lead.canvass_to_lp', 'Canvass leads delivered', 'Did every canvass lead reach Lead Perfection and the dialer?', '1 not delivered after 30 minutes', '2 or more not delivered, or any after 2 hours', 'Canvassers are paid per lead; a dropped lead is a wasted door.'),
    ('lead.chat_to_lp', 'Chat leads delivered', 'Are chatbot and website chat leads reaching Lead Perfection?', 'Any lead would have been missed', 'Any lead failed to send', '18 a day were missing in September.'),
    ('lead.first_call_p90', 'How fast new leads were called yesterday', 'How long did it take to call 9 in 10 of yesterday''s new leads?', 'More than 2 hours', 'More than 4 hours, or more than 3% never called', 'A slow first call lowers the booking rate for every source.'),
    ('lead.in_inbound_queue', 'Leads stuck waiting in Lead Perfection', 'How many lost leads were simply never turned into leads in Lead Perfection?', '3 or more', '10 or more', 'A people bottleneck, not an automation problem.'),
    ('lead.intake_gap', 'GHL contacts that never became a lead', 'Did every new GHL contact reach Lead Perfection within an hour? (Coming later.)', '1 or more in 2 hours', '3 or more in 2 hours', 'A contact that never reaches Lead Perfection is never called.'),
    ('lead.not_in_five9', 'Leads that never reached Five9', 'How many leads never reached Five9 at all?', 'More than 5 in a day', 'More than 10 in a day, or worth more than $25,000', 'On Oct 14, 42 leads worth $94,000 landed here.'),
    ('lead.routing_failure', 'Leads lost to routing problems', 'How many leads were lost because routing or an automation failed?', '1 or more', '3 or more', 'On Oct 14, 6 leads worth $8,800.'),
    ('lead.uncalled_live', 'Leads waiting for a first call', 'Has every new lead from the last day had at least one call?', 'Any lead waiting more than 30 minutes', 'Any lead waiting more than an hour, or 3 or more waiting more than 30 minutes', 'A lead nobody called today is a lead a competitor calls.'),
    ('n8n.cron_silence', 'Scheduled n8n workflows ran', 'Did every scheduled n8n workflow run on time? (Coming later.)', 'Late by twice its schedule', 'Late by four times its schedule', 'Report imports and weekly reports silently stop.'),
    ('n8n.errors', 'n8n workflow errors', 'Are n8n workflows failing? (Coming later.)', '2 or more errors per workflow in an hour', '5 or more, or any error on a lead intake workflow', 'On Oct 14 there were 10 errors in 3 hours.'),
    ('n8n.reachable', 'n8n up', 'Is n8n answering?', 'Missed once', 'Missed twice in a row', 'All n8n automations stop.'),
    ('svc.dashboard', 'Dashboard up', 'Is the dashboard loading?', 'Slow (over 3 seconds)', 'Not loading twice in a row', 'No one can see the command center.'),
    ('svc.five9_api', 'Five9 connected', 'Can we connect to Five9?', 'Missed once', 'Missed twice in a row', 'We can''t see or manage the dialer.'),
    ('svc.hl_mcp', 'HL-MCP up', 'Is HL-MCP (our GHL connection) running?', 'Slow, or its latest update failed', 'Not answering twice in a row, or Railway shows it down', 'Nothing can update GHL.'),
    ('svc.lp_api', 'Lead Perfection connected', 'Can we connect to Lead Perfection?', 'Missed once', 'Missed twice in a row', 'No new leads and no updates from Lead Perfection.'),
    ('svc.lp_mcp', 'LP-MCP up', 'Is LP-MCP (the main system) running?', 'Its latest update failed; the previous version is still running', 'Down', 'Every job and safety net stops.'),
    ('svc.railway_restarts', 'Services running on Railway', 'Are LP-MCP, HL-MCP, n8n and the dashboard running normally on Railway?', 'Restarted 4 or more times in an hour, a failed update, or a service we can''t see', 'A service is down', 'A service is down or stuck restarting.'),
    ('svc.slack', 'Slack connected', 'Can we post to Slack?', 'Missed once', 'Missed twice in a row', 'Alerts are silently lost.'),
    ('svc.supabase_hl', 'GHL copy database up', 'Is the database that holds our copy of GHL answering?', 'Under heavy load', 'Not answering', 'Checks that read GHL data go blind.'),
    ('svc.supabase_lp', 'Main database up', 'Is the main database answering?', 'Under heavy load', 'Not answering', 'Everything that stores or reads data stops.'),
    ('syn.chatbot_reply', 'Test run: chatbot reply', 'Does the chatbot answer a test message on time? (Coming later.)', 'Not used', 'No reply in time, or a wrong reply', 'The bot is down or broken.'),
    ('syn.ghl_webhook_roundtrip', 'Test run: GHL to us', 'Does a test update in GHL reach us within 2 minutes? (Coming later.)', 'Not used', 'Not seen within 2 minutes', 'GHL updates aren''t reaching us.'),
    ('syn.lead_to_lp', 'Test run: new lead to Lead Perfection', 'Does a test contact become a Lead Perfection lead within 10 minutes? (Coming later.)', 'Not used', 'Any step fails or takes over 10 minutes', 'Proves the lead intake works without a real lead.'),
    ('syn.lp_api_read', 'Test run: Lead Perfection read', 'Does Lead Perfection return a known test lead? (Coming later.)', 'Missed once', 'Missed twice in a row', 'Catches an expired Lead Perfection login early.'),
    ('syn.lp_to_five9_list', 'Test run: lead to the DIAL ASAP list', 'Does the test lead reach the DIAL ASAP list within 5 minutes and get removed before any call? (Coming later.)', 'Not used', 'Not on the list within 5 minutes, or not removed within a minute', 'Proves leads get from Lead Perfection to Five9.'),
    ('syn.n8n_roundtrip', 'Test run: n8n round trip', 'Does a test n8n workflow answer within 2 minutes? (Coming later.)', 'Not used', 'No answer within 2 minutes', 'n8n can''t reach the main system.'),
    ('syn.slack_delivery', 'Test run: Slack delivery', 'Does a test Slack post arrive within 30 seconds? (Coming later.)', 'Not used', 'Not seen within 30 seconds', 'Tells a quiet Slack from a broken one.'),
    ('sync.appt_parity', 'Appointments match in Lead Perfection and GHL', 'Do appointment times agree in Lead Perfection and GHL?', '5 or more new differences', '20 or more differences', 'Reps and the bot act on the wrong time.'),
    ('sync.five9_key_pct', 'Five9 calls tied to leads', 'What share of Five9 call records are tied to a Lead Perfection lead?', 'Under 90%', 'Under 85%', 'Calls can''t be matched to leads.'),
    ('sync.hl_cache_fresh', 'Our copy of GHL is current', 'Is our copy of GHL data up to date?', 'Any part more than 30 minutes behind', 'Contacts or opportunities more than 2 hours behind, or more than 5% of refreshes failing', 'Checks that read GHL data go blind.'),
    ('sync.lp_errors', 'Lead Perfection sync errors', 'Are new errors piling up when copying data from Lead Perfection?', 'Any new error today, or old errors still open', '10 or more new errors today, or more than 5 in the last hour', 'Leads that aren''t copied are invisible to every check.'),
    ('sync.lp_ghl_link_pct', 'New leads linked to GHL', 'Is every new Lead Perfection lead linked to its GHL contact?', 'Some unlinked', 'Many unlinked', 'Unlinked leads get no follow-up messages and no chatbot.'),
    ('sync.lp_leads_fresh', 'Lead Perfection leads copied recently', 'Are leads being copied from Lead Perfection on time?', 'Not copied for 20 minutes', 'Not copied for 45 minutes, or the last two tries failed', 'Every check reads old data.'),
    ('sync.lp_reports', 'Lead Perfection reports arrived', 'Did the daily Lead Perfection reports arrive (133 Jobs By Status, 134 Jobs by Milestone Date, 135 Lead Disposition Detail 2, 136 Mktg Sub-Source Cost Analysis 2, 137 Sales Efficiency By Mode)?', 'Missing after 8:30 AM', 'Missing after 10:00 AM, or could not be read', 'The scorecard is missing a day.'),
    ('sync.retired_code', 'Old result codes not used', 'Is an old, retired result code (like NIS2) showing up on new leads?', '1 or more', '5 or more', 'Lost-lead reports quietly go wrong.'),
    ('sync.stale_set_leads', 'Appointments with no result', 'How many appointments from the last 14 days have passed with no result in Lead Perfection?', '10 or more', '40 or more', 'The scorecard counts appointments that may not have happened.')
    ) AS w(check_id, label, question, warn_rule, fail_rule, business_impact)
   WHERE h.check_id = w.check_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 74 THEN RAISE EXCEPTION 'expected 74 checks updated, got %', n; END IF;

  UPDATE incidents SET
    title = CASE fingerprint
      WHEN 'sync.appt_parity:drift_ghl_closed_lp_active' THEN 'Appointments closed in GHL but still open in Lead Perfection'
      WHEN 'ci.recording_archive' THEN 'Can''t reach the call recordings' END,
    summary = CASE fingerprint
      WHEN 'ci.recording_archive' THEN 'The call recordings can''t be reached, so phone calls aren''t being analyzed.'
      ELSE summary END
   WHERE fingerprint IN ('sync.appt_parity:drift_ghl_closed_lp_active', 'ci.recording_archive')
     AND data->>'source' = 'legacy';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 2 THEN RAISE EXCEPTION 'expected at most 2 incidents renamed, got %', n; END IF;
END
$plain$;
