/**
 * mode-registry.js — every `*_MODE` switch in LP-MCP, in one list (Fix 2, 2026-10-12).
 *
 * Data plus two pure helpers, no imports, like job-registry.js. registerModes()
 * (src/mode-registry-sync.js) upserts it into `feature_modes` at boot with each
 * flag's CURRENT value, and the dashboard's /modes page reads that table.
 *
 * WHY. On 2026-10-12 LP-MCP read 91 `*_MODE` flags and about half defaulted to
 * shadow. Nothing recorded when a flag went into shadow, what evidence would
 * justify live, or who decides, and nothing showed a flag's live value
 * (get_railway_env_vars hides values; job_registry covers 20 of them). Features
 * sat in shadow for weeks where nobody could see them.
 *
 * This list changes NO flag. A flip is still a Railway variable set by a person;
 * the database records it (feature_mode_changes) the next time the service boots.
 *
 * Adding a flag: `scripts/test-mode-registry.js` scans src/ for every `env.<NAME>_MODE` read and
 * fails until the flag has an entry here (and fails on an entry whose flag is
 * gone). Fill every field honestly:
 *   - default    the value the code uses when the variable is unset
 *   - live / shadow / off   which values mean which state; `otherwise` is the
 *                state of any value not listed (only for flags whose code
 *                treats "anything but X" one way)
 *   - kind       'enum' (off/shadow/live style), 'boolean', or 'choice' (a
 *                setting with no shadow stage, e.g. which Five9 list mode)
 *   - since      the first commit that read the flag
 *   - decider    whose ruling the flip needs (Mark, or the user)
 *   - evidence   where shadow results can be read: system_events types, a
 *                table, or a job's job_runs.detail. Empty = logs only.
 *   - goLive     the test for switching it on, from a ruling. If no ruling
 *                says, write NEEDS_RULING; never invent one.
 */

export const NEEDS_RULING = 'not set: needs a ruling';
export const LIVE_BY_DEFAULT = 'already live by default';

function m(name, group, kind, values, def, states, extra) {
  return Object.freeze({
    name,
    group,
    kind,
    values: Object.freeze(values),
    default: def,
    live: Object.freeze(states.live || []),
    shadow: Object.freeze(states.shadow || []),
    off: Object.freeze(states.off || []),
    otherwise: states.otherwise || null,
    defaultFrom: extra.defaultFrom || null,
    since: extra.since,
    decider: extra.decider || 'Mark',
    evidence: Object.freeze(extra.evidence || {}),
    goLive: extra.goLive || NEEDS_RULING,
    note: extra.note,
  });
}

// Shorthands for the common value sets.
const OSL = ['off', 'shadow', 'live'];
const OSL_S = { live: ['live'], shadow: ['shadow'], off: ['off'] };
const OSE = ['off', 'shadow', 'enforce'];
const OSE_S = { live: ['enforce'], shadow: ['shadow'], off: ['off'] };
const OL = ['off', 'live'];
const OL_S = { live: ['live'], off: ['off'] };
const job = (id) => ({ job: id });
const FIVE9_CALL_NOW = ['NONE', 'NEW_CRM_ONLY', 'NEW_LIST_ONLY', 'ANY'];

export const MODES = Object.freeze([
  // ── Bot replies and conversations ────────────────────────────────────────
  m('SEND_GATE_MODE', 'bot', 'enum', ['shadow', 'live'], 'shadow', { live: ['live'], shadow: ['shadow'] }, {
    since: '2026-10-07',
    evidence: { events: ['send_gate.would_block', 'send_gate.would_allow', 'send_gate.would_hard_stop'] },
    goLive: 'send_gate.would_block shows only contacts the gate classes say we may not message (CLAUDE.md "One send gate")',
    note: 'One answer to "may we message this contact?" for every sender; live lets it block sends.',
  }),
  m('NEPQ_BACKBONE_MODE', 'bot', 'enum', OSL, 'off', OSL_S, {
    since: '2026-10-02',
    goLive: 'run_bot_eval does not read WORSE THAN LAST RUN with the planner live',
    note: 'Plans one NEPQ move per turn for both bots and enforces it on the reply.',
  }),
  m('NEPQ_LAYER_MODE', 'bot', 'boolean', ['on', 'off'], 'on', { off: ['off'], otherwise: 'live' }, {
    since: '2026-08-31', goLive: LIVE_BY_DEFAULT,
    note: 'The NEPQ questioning block in the reply prompt; "off" removes it.',
  }),
  m('PROMPT_NEPQ_CLEANUP_MODE', 'bot', 'enum', OL, 'off', OL_S, {
    since: '2026-10-10',
    note: 'Removes the old NEPQ prompt lines the planner now owns.',
  }),
  m('SMS_LENGTH_GUARD_MODE', 'bot', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-10-10',
    note: 'Holds an SMS reply to the length limit.',
  }),
  m('CONTEXT_ACTIVITY_FILTER_MODE', 'bot', 'enum', OL, 'off', OL_S, {
    since: '2026-10-06',
    note: 'Drops automated activity from the thread the reply writer reads.',
  }),
  m('NAMED_STORM_MODE', 'bot', 'boolean', ['true', 'false'], 'false', { live: ['true'], otherwise: 'off' }, {
    since: '2026-07-06',
    note: 'Storm-season wording in replies while a named storm is active.',
  }),
  m('POST_DEMO_PLANNER_MODE', 'bot', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-10-09',
    goLive: '[PostDemo] shadow plans read right on real post-demo threads (Mark, 2026-10-09)',
    note: 'Plans replies to post-demo leads as post-demo (defer, acknowledge, competitor signed).',
  }),
  m('REHASH_CALL_SLOTS_MODE', 'bot', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-10-09', decider: 'the user',
    goLive: '[RehashSlots] shadow offers name times open on the Rehash Call calendar; needs POST_DEMO_PLANNER_MODE=live first',
    note: 'Offers and books Rehash Call times from the calendar.',
  }),
  m('REHASH_ROUTING_MODE', 'bot', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-10-09', decider: 'the user',
    evidence: { events: ['rehash.would_tag', 'rehash.would_release', 'rehash.would_reroute_callback'], job: 'rehash-tag-sweep' },
    goLive: 'rehash.would_* events name only OPPFDN leads inside the 30-day window',
    note: 'Puts post-demo leads in the rehash stage and routes their calls to the rehash team.',
  }),
  m('LEAD_STAGE_MODE', 'bot', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-10-12', decider: 'Mark',
    evidence: { table: 'lead_conversation_stage' },
    goLive: 'run_bot_eval with lead_stage_mode=live is not worse than the shadow baseline, AND easy_yes books, renter gets no slots, competitor gets slots, stop_sms passes (handoff 2026-10-12)',
    note: 'One stored NEPQ conversation stage per lead; live lets the planner and prompt read it (the qualifying gate, one bridge, the easy yes).',
  }),
  m('PROMISED_CALLBACK_MODE', 'bot', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-10-07',
    evidence: { table: 'promised_callbacks', job: 'promised-callback-sweep' },
    goLive: 'promised_callbacks rows are real promises, and Mark approves the "still owes you that call" line',
    note: 'Every call the bot promises becomes an owned task; an expired one posts to #contact-center.',
  }),
  m('CONVERSATION_PAUSE_MODE', 'bot', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-10-08', decider: 'the user', evidence: job('pause-workflow-sweep'),
    goLive: 'POST /n8n/pause-workflow/sweep {"dryRun":true} lists only contacts quiet 24h with no open promised call',
    note: 'Releases a pause-workflow tag we added after 24 quiet hours.',
  }),
  m('OPENER_HOLD_MODE', 'bot', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-10-11',
    note: 'Holds the no-reply follow-up after a bare chat opener.',
  }),
  m('LP_NOTE_DQ_MODE', 'bot', 'enum', OSL, 'live', OSL_S, {
    since: '2026-10-07', goLive: LIVE_BY_DEFAULT,
    note: 'A team note in LP that says we cannot run the lead stops the bot.',
  }),
  m('SCOPE_DQ_MODE', 'bot', 'enum', OSL, 'live', OSL_S, {
    since: '2026-10-13', goLive: LIVE_BY_DEFAULT,
    note: 'A commercial property or a rental unit: a note on the LP prospect and one #contact-center card asking a person to set ND (LP\'s API cannot).',
  }),
  m('LP_PHONE_GUARD_MODE', 'bot', 'enum', OSE, 'enforce', OSE_S, {
    since: '2026-08-18', goLive: LIVE_BY_DEFAULT,
    note: 'Checks the phone number before the bot sends.',
  }),
  m('LIVE_CHAT_FAST_LANE_MODE', 'bot', 'enum', OSL, 'off', OSL_S, {
    since: '2026-09-26', evidence: { events: ['agentic.live_chat_shadow_model'] },
    note: 'Answers website live chat in one fast pass.',
  }),
  m('LIVE_CHAT_KB_INTENT_MODE', 'bot', 'enum', OL, 'off', OL_S, {
    since: '2026-10-06',
    note: 'Lets the live chat use the knowledge base intent match.',
  }),
  m('LIVE_CHAT_LARGE_JOB_ALERT_MODE', 'bot', 'enum', ['once', 'summary', 'off'], 'once', { live: ['once', 'summary'], off: ['off'] }, {
    since: '2026-10-15', decider: 'Mark', goLive: LIVE_BY_DEFAULT,
    evidence: { events: ['agentic.live_chat_large_job'] },
    note: 'Large-job card in live chat: once per contact, or only on the chat summary card.',
  }),
  m('LIVE_CHAT_SUMMARY_MODE', 'bot', 'enum', OSL, 'off', OSL_S, {
    since: '2026-10-15', decider: 'Mark',
    evidence: { table: 'live_chat_summaries' },
    goLive: 'After a day in shadow, the summaries match the real chats (handoff, 2026-10-15).',
    note: 'One Slack summary card per live chat once it goes quiet.',
  }),
  m('LIVE_CHAT_MISSED_SWEEP_MODE', 'bot', 'enum', ['off', 'on'], 'on', { live: ['on'], off: ['off'] }, {
    since: '2026-10-01', goLive: LIVE_BY_DEFAULT,
    note: 'Finds live-chat messages that got no reply and answers them.',
  }),
  m('MISSED_INBOUND_SWEEP_MODE', 'bot', 'enum', OSL, 'live', OSL_S, {
    since: '2026-10-15', decider: 'the user', goLive: LIVE_BY_DEFAULT,
    evidence: { events: ['agentic.missed_inbound_redriven'] },
    note: 'Answers an inbound text or email GHL never sent to the reply webhook.',
  }),
  m('REPLY_SLA_WATCHDOG_MODE', 'bot', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-09-02',
    note: 'Flags a text with no reply after 3 minutes.',
  }),
  m('NURTURE_SHADOW_MODE', 'bot', 'boolean', ['true', 'false'], 'false', { shadow: ['true'], otherwise: 'live' }, {
    since: '2026-05-11', goLive: LIVE_BY_DEFAULT,
    note: 'When true, nurture drafts wait for approval instead of sending.',
  }),
  m('BOT_FINGERPRINT_MODE', 'bot', 'enum', ['off', 'on'], 'on', { live: ['on'], off: ['off'] }, {
    since: '2026-09-11', goLive: LIVE_BY_DEFAULT,
    note: 'Records what each bot message was built from, for Bot Review.',
  }),
  m('S1_3_SUPPRESSION_GATE_MODE', 'bot', 'enum', ['enforce', 'shadow'], 'enforce', { live: ['enforce'], shadow: ['shadow'] }, {
    since: '2026-06-17', goLive: LIVE_BY_DEFAULT,
    note: 'Keeps suppressed contacts out of the S1.3 lead selection.',
  }),

  // ── Knowledge base ──────────────────────────────────────────────────────
  m('KB_FAQ_SEMANTIC_MODE', 'knowledge', 'enum', OSL, 'off', OSL_S, {
    since: '2026-09-03', goLive: 'live in production (CLAUDE.md "The FAQ corpus"); rollback is shadow',
    note: 'Semantic FAQ match for the reply writer.',
  }),
  m('KB_VECTOR_MODE', 'knowledge', 'enum', OSL, 'off', OSL_S, {
    since: '2026-09-03',
    note: 'Tier 2 vector search over the knowledge base.',
  }),
  m('KB_EXEMPLAR_MODE', 'knowledge', 'enum', OSL, 'off', OSL_S, {
    since: '2026-09-03',
    // tier = 'kb_exemplars'; a bot-gate run logs mode sim_<mode>, never shadow.
    evidence: { table: 'kb_vector_queries' },
    note: 'Adds past winning replies as examples.',
  }),
  m('KB_CALL_MOMENTS_MODE', 'knowledge', 'enum', OSL, 'off', OSL_S, {
    since: '2026-09-03',
    note: 'Adds objection moments mined from call transcripts.',
  }),
  m('KB_CUSTOMER_SCOPE_MODE', 'knowledge', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-10-06',
    note: 'Limits vector search to customer-safe knowledge.',
  }),

  // ── Lead intake ─────────────────────────────────────────────────────────
  m('AP_INTAKE_MODE', 'intake', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-09-19',
    note: 'ActiveProspect lead intake hop.',
  }),
  m('CANVASSING_INTAKE_MODE', 'intake', 'enum', ['shadow', 'live'], 'shadow', { live: ['live'], shadow: ['shadow'] }, {
    since: '2026-07-24',
    note: 'Canvassing contact intake (replaces GHL I.CC).',
  }),
  m('CANVASS_BACKSTOP_MODE', 'intake', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-09-28', evidence: job('canvass-lead-backstop'),
    note: 'Re-drives canvass leads GHL never delivered.',
  }),
  m('CHAT_LP_INTAKE_MODE', 'intake', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-09-28', evidence: job('chat-lead-intake'),
    note: 'Sends chat leads to LP.',
  }),
  m('INTAKE_JOURNAL_MODE', 'intake', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-09-11',
    note: 'Write-ahead log of every lead-carrying request.',
  }),
  m('INBOUND_CAPTURE_MODE', 'intake', 'enum', ['off', 'shadow', 'approval', 'live'], 'shadow', { live: ['approval', 'live'], shadow: ['shadow'], off: ['off'] }, {
    since: '2026-09-27', evidence: job('inbound-caller-capture'),
    note: 'Captures inbound callers as leads.',
  }),
  m('MISSED_CALLER_RECOVERY_MODE', 'intake', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-09-24', evidence: job('missed-caller-recovery'),
    note: 'Recovers paid callers who were missed.',
  }),

  // ── Lead Perfection writes and sync ─────────────────────────────────────
  m('LP_ADDLEAD_PROXY_MODE', 'lp', 'enum', ['shadow', 'validate', 'passthrough'], 'shadow', { live: ['validate'], shadow: ['shadow'], off: ['passthrough'] }, {
    since: '2026-07-24',
    note: 'Validates GHL addlead calls before LP; validate refuses bad ones.',
  }),
  m('LP_ADDLEAD_NOTES_MODE', 'lp', 'enum', ['off', 'shadow', 'augment', 'live'], 'shadow', { live: ['augment', 'live'], shadow: ['shadow'], off: ['off'] }, {
    since: '2026-08-03',
    note: 'Adds notes to leads sent through the addlead proxy.',
  }),
  m('LP_ATTRIBUTION_FALLBACK_MODE', 'lp', 'enum', OSL, 'live', OSL_S, {
    since: '2026-08-18', goLive: LIVE_BY_DEFAULT,
    note: 'Fills a missing source on addlead from the fallback.',
  }),
  m('LP_ADDRESS_GATE_MODE', 'lp', 'enum', OSE, 'shadow', OSE_S, {
    since: '2026-08-18',
    note: 'Refuses an LP lead push with no usable address.',
  }),
  m('LP_REP_BRIEF_MODE', 'lp', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-10-05', decider: 'the user',
    goLive: '"[LP-PROXY] REP BRIEF SHADOW" briefs pass checkRepBrief and read right (node scripts/render-rep-brief.js)',
    note: 'Writes the 2-3 sentence rep brief as the LP note.',
  }),
  m('LP_APPT_GUARD_MODE', 'lp', 'enum', OSE, 'shadow', OSE_S, {
    since: '2026-09-13',
    evidence: { events: ['lp.appointment_refused'] },
    note: 'Refuses to mark a contact synced when LP refused the appointment (read fixed 2026-10-12).',
  }),
  m('LP_INBOUND_DEFER_MODE', 'lp', 'enum', ['off', 'shadow', 'on'], 'shadow', { live: ['on'], shadow: ['shadow'], off: ['off'] }, {
    since: '2026-09-12',
    note: 'Holds an appointment while LP has an unimported inbound row.',
  }),
  m('LP_CREATE_EXISTING_LEAD_GUARD_MODE', 'lp', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-09-28',
    note: 'Stops create_lp_lead making a duplicate of an existing LP lead.',
  }),
  m('LP_CALC_LEAD_GUARD_MODE', 'lp', 'enum', OSL, 'live', OSL_S, {
    since: '2026-10-08', goLive: LIVE_BY_DEFAULT,
    note: 'The same duplicate guard for calculator leads.',
  }),
  m('LP_POST_ISSUE_NEW_LEAD_MODE', 'lp', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-10-09', evidence: { events: ['lp.post_issue_rebook'] },
    goLive: 'lp.post_issue_rebook shadow events pick the right lead or a correct new lead (call-center manual pp. 22-24)',
    note: 'An issued LP lead never takes another appointment; a new lead does.',
  }),
  m('LP_STALE_LEAD_REFRESH_MODE', 'lp', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-10-07', evidence: job('lp-stale-lead-refresh'),
    note: 'Refreshes open LP leads the sync missed.',
  }),
  m('LP_IDENTITY_FILL_MODE', 'lp', 'enum', OSL, 'live', OSL_S, {
    since: '2026-10-11', evidence: job('lp-identity-fill-sweep'), goLive: LIVE_BY_DEFAULT,
    note: 'Fills an empty GHL name/email/address from LP.',
  }),
  m('LP_JOB_PARENT_HEAL_MODE', 'lp', 'enum', OSL, 'off', OSL_S, {
    since: '2026-09-03',
    note: 'Pulls in a missing LP lead so its job can sync.',
  }),
  m('LP_LEAD_CONTENT_DIFF_MODE', 'lp', 'enum', OSE, 'shadow', OSE_S, {
    since: '2026-09-18',
    note: 'Skips lp_leads writes whose content did not change.',
  }),
  m('LP_LINK_CORROBORATION_MODE', 'lp', 'enum', ['observe', 'enforce'], 'observe', { live: ['enforce'], shadow: ['observe'] }, {
    since: '2026-07-23',
    note: 'Requires a second signal before linking an LP lead to a GHL contact.',
  }),
  m('LP_NOTE_EDIT_MODE', 'lp', 'enum', OSE, 'off', OSE_S, {
    since: '2026-09-18',
    note: 'Syncs edits to LP notes.',
  }),
  m('LP_BACKSTOP_NOTIFY_MODE', 'lp', 'choice', ['exception', 'all', 'off'], 'exception', {}, {
    since: '2026-07-31', goLive: 'a setting, not a rollout',
    note: 'Which LP backstop results post a notice.',
  }),
  m('LP_REQUEUE_MODE', 'lp', 'choice', ['five9', 'lp_leadadd'], 'five9', {}, {
    since: '2026-09-04', goLive: 'a setting, not a rollout',
    note: 'Where a callback re-queue goes: Five9 or an LP lead add.',
  }),
  m('SYNC_HASH_GATE_MODE', 'lp', 'enum', OSE, 'shadow', OSE_S, {
    since: '2026-08-18',
    note: 'Skips sync writes whose hash did not change.',
  }),
  m('SYNC_WINDOW_MODE', 'lp', 'choice', ['timestamp', 'date'], 'timestamp', {}, {
    since: '2026-08-18', goLive: 'a setting, not a rollout',
    note: 'How the LP sync picks its window.',
  }),
  m('CURRENT_APPT_FIELDS_SYNC_MODE', 'lp', 'enum', OL, 'off', OL_S, {
    since: '2026-10-05',
    note: 'Writes the current appointment fields to GHL.',
  }),
  m('DEMO_TAG_SYNC_MODE', 'lp', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-09-30',
    note: 'Syncs demo tags from LP to GHL.',
  }),
  m('GHL_NOTE_MODE', 'lp', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-06-24', evidence: { table: 'ghl_note_shadow_log' },
    note: 'Turns GHL inbound messages into LP notes.',
  }),

  // ── Sales, P2 and backstops ─────────────────────────────────────────────
  m('SALE_P2_BACKSTOP_MODE', 'sales', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-10-03', evidence: job('sale-p2-backstop'),
    goLive: 'sale_p2_backstop_run (dry run) lists only the writes the CLAUDE.md rules allow',
    note: 'Every LP sale gets a P2 card even when LP\'s webhook does not arrive.',
  }),
  m('SALE_CONTACT_BACKSTOP_MODE', 'sales', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-10-04', evidence: job('sale-contact-backstop'),
    goLive: 'sale_contact_backstop_run (dry run) finds or creates only real customer contacts',
    note: 'A sale with no GHL contact gets one.',
  }),
  m('P2_TERMINAL_CREATE_GUARD_MODE', 'sales', 'enum', OSE, 'shadow', OSE_S, {
    since: '2026-09-21',
    note: 'Stops a second P2 card for a finished job.',
  }),
  m('MILESTONE_STALE_FIRE_MODE', 'sales', 'enum', OSE, 'shadow', OSE_S, {
    since: '2026-09-21',
    note: 'Stops a milestone message firing for a stale job.',
  }),
  m('PAYROLL_ENGINE_MODE', 'sales', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-09-26', evidence: job('payroll-engine'),
    note: 'Builds the payroll run and its Slack approval card.',
  }),

  // ── Dialer (Five9) ──────────────────────────────────────────────────────
  m('NEW_LEAD_DIAL_BACKSTOP_MODE', 'dialer', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-10-05', decider: 'the user', evidence: job('new-lead-dial-backstop'),
    goLive: 'job_runs.detail.by_reason puts each lead on the list the 2026-10-06 ruling names',
    note: 'Pushes every imported, never-called LP lead to a Five9 list.',
  }),
  m('AFTER_ASAP_RETRY_MODE', 'dialer', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-10-14', decider: 'the user', evidence: job('after-asap-retry'),
    goLive: 'job_runs.detail.decisions show would_push only for leads with no follow-up call and no After DIAL ASAP record',
    note: 'Puts no-contact DIAL ASAP / Simpletext leads on After DIAL ASAP where the Five9 connector missed them.',
  }),
  m('FIVE9_JOURNEY_SYNC_MODE', 'dialer', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-10-15', decider: 'the user', evidence: { table: 'five9_call_journey_runs', job: 'five9-call-journey-sync' },
    goLive: '2-3 shadow runs in five9_call_journey_runs with status ok, rows_returned > 0 and rows_rejected = 0 (the user\'s Call Journey handoff, 2026-10-15)',
    note: 'Pulls the Five9 "Call Journey" report every 15 min into five9_call_journey (shadow: pull + parse + log, no rows).',
  }),
  m('CANCEL_RESET_ROUTING_MODE', 'dialer', 'enum', OSL, 'live', OSL_S, {
    since: '2026-10-15', decider: 'the user', evidence: job('cancel-reset-routing'),
    goLive: 'ruled live by the user on 2026-10-15: every cancelled lead goes to Resets-Hot',
    note: 'Adds cancelled LP leads (CXL / CCC) that no Reset campaign has called to Five9 "Resets-Hot".',
  }),
  m('BOOKED_DIAL_ROUTING_MODE', 'dialer', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-10-06', evidence: { table: 'booked_dial_routing_log', job: 'booked-dial-routing' },
    goLive: 'booked_dial_routing_log decisions follow decision #2669 (add first, remove second)',
    note: 'Moves booked leads off the setter lists onto Confirmation.',
  }),
  m('INBOUND_CHECKOUT_WATCH_MODE', 'dialer', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-10-06', evidence: job('inbound-checkout-watch'),
    note: 'Cards #contact-center for LP inquiries waiting past their line.',
  }),
  m('FIVE9_CALLBACK_CALL_NOW_MODE', 'dialer', 'choice', FIVE9_CALL_NOW, 'ANY', {}, {
    since: '2026-09-04', goLive: 'a setting, not a rollout',
    note: 'Five9 call-now mode for bot callback pushes.',
  }),
  m('AFTER_ASAP_RETRY_CALL_NOW_MODE', 'dialer', 'choice', FIVE9_CALL_NOW, 'NONE', {}, {
    since: '2026-10-14', goLive: 'a setting, not a rollout',
    note: 'Five9 call-now mode for the After DIAL ASAP retry backstop (NONE: the campaign dials on its own schedule).',
  }),
  m('NEW_LEAD_BACKSTOP_CALL_NOW_MODE', 'dialer', 'choice', FIVE9_CALL_NOW, 'ANY', {}, {
    since: '2026-10-05', defaultFrom: 'FIVE9_CALLBACK_CALL_NOW_MODE', goLive: 'a setting, not a rollout',
    note: 'Five9 call-now mode for the new-lead backstop (falls back to the callback setting).',
  }),
  m('CAPACITY_RANKER_MODE', 'dialer', 'enum', ['shadow', 'live'], 'shadow', { live: ['live'], shadow: ['shadow'] }, {
    since: '2026-09-03',
    note: 'Ranks next-day capacity for the dialer.',
  }),
  m('DNC_REENTRY_SWEEP_MODE', 'dialer', 'enum', OSL, 'live', OSL_S, {
    since: '2026-10-01', evidence: job('dnc-reentry-sweep'), goLive: LIVE_BY_DEFAULT,
    note: 'Asks for review when a new lead arrives for a blocked number.',
  }),
  m('CONSENT_MODEL_MODE', 'dialer', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-09-28',
    note: 'The consent tables; shadow means nothing gates a send on them yet.',
  }),

  // ── Lead leaks and alerts ───────────────────────────────────────────────
  // 2026-10-15 — System Health Phase 1 (docs/system-health.md).
  m('DIALER_SLA_MODE', 'dialer', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-10-15', evidence: { table: 'health_results', job: 'dialer-sla-check' },
    goLive: 'Mark, handoff 2026-10-14: 5 business days of v_health_check_latest with no false red, then flip',
    note: 'Dialer SLA checks (list membership, first dial, stalled lists, dial rate, 3-in-24, never-again). Writes health_results only.',
  }),
  m('APPT_PIPELINE_MODE', 'lp', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-10-15', evidence: { table: 'health_results', job: 'appointment-pipeline-check' },
    goLive: 'Mark, handoff 2026-10-14: 5 business days of v_health_check_latest with no false red, then flip',
    note: 'Appointment pipeline checks (inbound queue age, issued by 20:15, unassigned, capacity, ...). Writes health_results only.',
  }),
  m('INCIDENT_NOTIFIER_MODE', 'alerts', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-10-15', evidence: { table: 'incidents', job: 'incident-notifier' },
    goLive: 'Mark, handoff 2026-10-14: after HEALTH_CHECKS / DIALER_SLA / APPT_PIPELINE are live; one card per incident, edited in place',
    note: 'Opens incidents from live-mode checks and mapped legacy alerts; shadow writes incidents and logs the card, sends nothing.',
  }),
  m('HEALTH_RETENTION_MODE', 'alerts', 'enum', ['off', 'dry_run', 'live'], 'dry_run', { live: ['live'], shadow: ['dry_run'], off: ['off'] }, {
    since: '2026-10-15', evidence: { job: 'health-retention' },
    goLive: 'Mark, handoff 2026-10-14: after a dry_run whose counts match expectations in job_runs.detail',
    note: 'Rolls health_results older than 30 days into health_results_daily, then deletes; n8n log 14d; synthetic 30d; lead_leak_daily 90d after summarizing.',
  }),
  // 2026-10-15 — System Health Phase 0 (docs/system-health.md).
  m('HEALTH_CHECKS_MODE', 'alerts', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-10-15', evidence: { table: 'health_results', job: 'health-checks' },
    goLive: 'Mark, handoff 2026-10-14: 5 business days of v_health_check_latest with no false red, then flip',
    note: 'Evaluates the health_checks owned by the health-checks job every 5 min and writes health_results. Posts nothing.',
  }),
  m('LEAD_LEAK_MONITOR_MODE', 'alerts', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-09-26', evidence: job('lead-leak-monitor'),
    note: 'Finds leads that leaked between systems.',
  }),
  m('LEAD_LEAK_ALERT_MODE', 'alerts', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-09-26', evidence: job('lead-uncalled-check'),
    note: 'Alerts on uncalled leads.',
  }),
  m('LEAD_LEAK_CLEANUP_MODE', 'alerts', 'enum', ['off', 'dry_run', 'live'], 'dry_run', { live: ['live'], shadow: ['dry_run'], off: ['off'] }, {
    since: '2026-09-28',
    note: 'Cleans up the leaks the monitor finds.',
  }),
  m('GHL_SHARED_BUDGET_MODE', 'alerts', 'enum', ['off', 'shadow'], 'off', { shadow: ['shadow'], off: ['off'] }, {
    since: '2026-09-14',
    note: 'Counts GHL requests into a shared per-minute budget.',
  }),
  m('DECISION_ENGINE_HEARTBEAT_PRIMARY_MODE', 'alerts', 'boolean', ['true', 'false'], 'true', { off: ['false'], otherwise: 'live' }, {
    since: '2026-06-05', goLive: LIVE_BY_DEFAULT,
    note: 'The heartbeat drives the Decision Engine; "false" restores the old failover.',
  }),
  m('TAG_SWEEP_MODE', 'alerts', 'enum', ['report', 'apply'], 'report', { live: ['apply'], shadow: ['report'] }, {
    since: '2026-09-22',
    goLive: 'rule by rule through TAG_SWEEP_APPLY_RULES (R7 already applies)',
    note: 'The nightly tag hygiene sweep.',
  }),
  m('CALL_INTEL_MODE', 'alerts', 'enum', ['shadow', 'live'], 'shadow', { live: ['live'], shadow: ['shadow'] }, {
    since: '2026-08-19',
    note: 'Call Intelligence analysis of call transcripts.',
  }),

  // ── Security ────────────────────────────────────────────────────────────
  m('AUTH_ENFORCE_MODE', 'security', 'enum', ['log', 'enforce'], 'log', { live: ['enforce'], shadow: ['log'] }, {
    since: '2026-10-06', evidence: { events: ['security.auth_would_reject'] },
    goLive: 'security.auth_would_reject shows only callers that should be refused',
    note: 'The shared secret check on every webhook and operator route.',
  }),
  m('SQL_TOOL_MODE', 'security', 'enum', ['readwrite', 'shadow', 'readonly'], 'readwrite', { live: ['readonly'], shadow: ['shadow'], off: ['readwrite'] }, {
    since: '2026-10-07', evidence: { table: 'tool_audit_log' },
    goLive: 'shadow, then read the would_deny rows, then SQL_WRITE_TOOL_ENABLED=true, then readonly (CLAUDE.md)',
    note: 'Makes the MCP SQL tool read-only; writes go through the audited write tool.',
  }),
  m('INFRA_TOOLS_MODE', 'security', 'enum', ['open', 'shadow', 'operator'], 'open', { live: ['operator'], shadow: ['shadow'], off: ['open'] }, {
    since: '2026-10-07', evidence: { table: 'tool_audit_log' },
    note: 'Railway and http_request MCP tools answer only to the operator token.',
  }),
  m('HTTP_EGRESS_MODE', 'security', 'enum', OSE, 'shadow', OSE_S, {
    since: '2026-10-07', evidence: { table: 'tool_audit_log' },
    note: 'Default-deny outbound HTTP for the http_request tool.',
  }),
  m('INJECTION_GUARD_MODE', 'security', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-10-07', evidence: { table: 'guardrail_decisions' },
    goLive: 'Mark\'s ruling plus a run_bot_eval before any customer chat surface is blocked',
    note: 'Screens every inbound text for prompt injection.',
  }),
  m('INBOUND_SANITIZE_MODE', 'security', 'enum', OL, 'live', OL_S, {
    since: '2026-10-06', goLive: LIVE_BY_DEFAULT,
    note: 'Cleans an inbound message before any model reads it.',
  }),
  m('TOOL_AUDIT_LOG_MODE', 'security', 'enum', OL, 'live', OL_S, {
    since: '2026-10-07', goLive: LIVE_BY_DEFAULT,
    note: 'Append-only log of privileged MCP tool calls.',
  }),
  m('LLM_USAGE_LOG_MODE', 'security', 'enum', OL, 'live', OL_S, {
    since: '2026-10-07', goLive: LIVE_BY_DEFAULT,
    note: 'Append-only ledger of every model call.',
  }),

  // ── Memory ──────────────────────────────────────────────────────────────
  m('MEMORY_GUARD_MODE', 'memory', 'enum', OSL, 'shadow', OSL_S, {
    since: '2026-09-08',
    note: 'Checks memory checkpoints before they are saved.',
  }),
  m('MEMORY_AUTOCLOSE_MODE', 'memory', 'enum', OSL, 'off', OSL_S, {
    since: '2026-09-06',
    note: 'The nightly job closes stale pending items.',
  }),
  m('MEMORY_RECOMMEND_MODE', 'memory', 'enum', OSL, 'off', OSL_S, {
    since: '2026-09-11',
    note: 'Adds a recommendation to each ruling card.',
  }),
  m('MEMORY_VECTOR_MODE', 'memory', 'enum', OSL, 'off', OSL_S, {
    since: '2026-09-06',
    note: 'Vector search over memory.',
  }),
  m('OMI_INGEST_MODE', 'memory', 'enum', OSL, 'off', OSL_S, {
    since: '2026-09-11',
    note: 'Turns an Omi conversation into memory proposals.',
  }),
  m('OMI_PULL_MODE', 'memory', 'enum', OSL, 'off', OSL_S, {
    since: '2026-09-14', evidence: job('omi-pull'),
    note: 'Pulls Mark\'s Omi conversations on a schedule (live acts as shadow unless OMI_INGEST_MODE=live).',
  }),
]);

/**
 * The value the code acts on: the variable, trimmed, or the code's default.
 * Compared case-insensitively; returned as written so the dashboard shows it.
 */
export function resolveMode(entry, env = {}) {
  const raw = env[entry.name];
  if (raw != null && String(raw).trim() !== '') return String(raw).trim();
  if (entry.defaultFrom) {
    const via = env[entry.defaultFrom];
    if (via != null && String(via).trim() !== '') return String(via).trim();
  }
  return entry.default;
}

/**
 * live | shadow | off | choice | other. "other" is a value the code does not
 * know (a typo in Railway), which the page shows rather than guesses.
 */
export function stateOf(entry, value) {
  if (entry.kind === 'choice') return 'choice';
  const v = String(value ?? '').trim().toLowerCase();
  const has = (list) => list.some((x) => x.toLowerCase() === v);
  if (has(entry.off)) return 'off';
  if (has(entry.shadow)) return 'shadow';
  if (has(entry.live)) return 'live';
  return entry.otherwise || 'other';
}

export const MODE_NAMES = Object.freeze(MODES.map((e) => e.name));
