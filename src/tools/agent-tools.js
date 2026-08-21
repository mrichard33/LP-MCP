import { z } from 'zod';
import supabase from '../supabase.js';

/**
 * resolveRequiresApproval — queue-time enforcement for Five9 admin writes.
 * Pure, exported for offline tests (scripts/test-agent-action-approval.js).
 *
 * 2026-08-13 Phase G. Until now this was documentation only: the
 * create_agent_action action_type description said Five9 writes "MUST be
 * queued with requires_approval: true", and the sole enforcement was
 * executeFive9Write refusing at EXECUTION time — by which point the row had
 * been claimed, flipped to 'executing', and burned a retry, three times,
 * before failing. Coercing here means a bypassed row never enters the queue
 * armed in the first place.
 *
 * Prefix-matched on purpose: a future five9_* op is covered the day it is
 * added, without anyone remembering to extend a list. That is exactly the
 * kind of list that goes stale — the executor's own FIVE9_WRITE_OPS map is
 * the authority on which ops exist, and this does not try to duplicate it.
 */
export function resolveRequiresApproval(actionType, requested) {
  const isFive9Write = String(actionType || '').startsWith('five9_');
  return {
    isFive9Write,
    requiresApproval: isFive9Write ? true : (requested || false),
    coerced: isFive9Write && requested !== true,
  };
}

export function registerAgentTools(server) {

  // ───────────────────────────────────────────────────
  // Tool: emit_event
  // ───────────────────────────────────────────────────
  server.tool(
    'emit_event',
    'Write a system event to the event bus. Used by n8n webhooks, cron jobs, and Claude to log state changes across GHL, LP, and internal systems.',
    {
      event_type: z.string().describe('Event type (e.g. "contact.tag_added", "lp.disposition_changed", "appointment.booked")'),
      source: z.string().describe('Source system: "ghl", "lp", "n8n", "claude", "manual", "cron"'),
      entity_type: z.string().describe('Entity type: "contact", "opportunity", "lead", "workflow", "appointment"'),
      entity_id: z.string().describe('Primary ID of the entity in its source system'),
      event_subtype: z.string().optional().describe('Optional refinement (e.g. "objection:price", "appt:window-estimate")'),
      ghl_contact_id: z.string().optional().describe('GHL contact ID if known'),
      lp_lead_id: z.string().optional().describe('LP Lead ID if known'),
      lp_prospect_id: z.string().optional().describe('LP Prospect ID if known'),
      payload: z.string().optional().describe('JSON string of full event data from source'),
      previous_state: z.string().optional().describe('JSON string of state before the change'),
      new_state: z.string().optional().describe('JSON string of state after the change'),
      priority: z.string().optional().describe('Priority: "critical", "high", "normal", or "low" (default: normal)'),
      idempotency_key: z.string().optional().describe('Dedup key to prevent duplicate events'),
      event_timestamp: z.string().optional().describe('ISO timestamp of when event actually occurred'),
    },
    async (params) => {
      try {
        const { data, error } = await supabase
          .from('system_events')
          .insert({
            event_type: params.event_type,
            event_subtype: params.event_subtype || null,
            source: params.source,
            entity_type: params.entity_type,
            entity_id: params.entity_id,
            ghl_contact_id: params.ghl_contact_id || null,
            lp_lead_id: params.lp_lead_id || null,
            lp_prospect_id: params.lp_prospect_id || null,
            payload: params.payload ? JSON.parse(params.payload) : {},
            previous_state: params.previous_state ? JSON.parse(params.previous_state) : null,
            new_state: params.new_state ? JSON.parse(params.new_state) : null,
            priority: params.priority || 'normal',
            idempotency_key: params.idempotency_key || null,
            event_timestamp: params.event_timestamp || new Date().toISOString(),
          })
          .select('id, event_type, entity_id, priority, created_at')
          .single();

        if (error) {
          if (error.code === '23505' && params.idempotency_key) {
            return { content: [{ type: 'text', text: JSON.stringify({ status: 'duplicate', idempotency_key: params.idempotency_key }) }] };
          }
          return { content: [{ type: 'text', text: `Error creating event: ${error.message}` }] };
        }

        return { content: [{ type: 'text', text: JSON.stringify({ status: 'created', event_id: data.id, event_type: data.event_type, entity_id: data.entity_id, priority: data.priority, created_at: data.created_at }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Exception: ${err.message}` }] };
      }
    }
  );

  // ───────────────────────────────────────────────────
  // Tool: get_pending_events
  // ───────────────────────────────────────────────────
  server.tool(
    'get_pending_events',
    'Get unprocessed system events, ordered by priority then time. The decision engine entry point.',
    {
      limit: z.number().optional().describe('Max events to return (default 20)'),
      event_type: z.string().optional().describe('Filter by event type'),
      source: z.string().optional().describe('Filter by source system'),
      priority: z.string().optional().describe('Filter by priority: critical, high, normal, low'),
    },
    async (params) => {
      let query = supabase
        .from('system_events')
        .select('id, event_type, event_subtype, source, entity_type, entity_id, ghl_contact_id, lp_lead_id, lp_prospect_id, payload, previous_state, new_state, priority, event_timestamp, created_at')
        .eq('processed', false)
        .order('priority', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true })
        .limit(params.limit || 20);

      if (params.event_type) query = query.eq('event_type', params.event_type);
      if (params.source) query = query.eq('source', params.source);
      if (params.priority) query = query.eq('priority', params.priority);

      const { data, error } = await query;
      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      return { content: [{ type: 'text', text: JSON.stringify({ count: data.length, events: data }, null, 2) }] };
    }
  );

  // ───────────────────────────────────────────────────
  // Tool: mark_event_processed
  // ───────────────────────────────────────────────────
  server.tool(
    'mark_event_processed',
    'Mark system event(s) as processed after the decision engine has handled them.',
    {
      event_ids: z.string().describe('Comma-separated event IDs to mark processed (e.g. "1,2,3")'),
      processed_by: z.string().describe('Who processed it: "agent", "claude", "ryan", "n8n"'),
      action_taken: z.string().optional().describe('Brief description of action taken'),
    },
    async (params) => {
      const ids = params.event_ids.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
      const { data, error } = await supabase
        .from('system_events')
        .update({ processed: true, processed_by: params.processed_by, processed_at: new Date().toISOString(), action_taken: params.action_taken || null })
        .in('id', ids)
        .select('id');

      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'updated', count: data.length, event_ids: ids }) }] };
    }
  );

  // ───────────────────────────────────────────────────
  // Tool: create_agent_action
  // ───────────────────────────────────────────────────
  // 2026-05-07 — added optional `priority` (sql/020 priority lanes).
  // When omitted, the BEFORE INSERT trigger assigns a lane based on
  // action_type and rule_applied. Pass an explicit value only when
  // overriding the default lane.
  //
  // 2026-05-19 — action_type description hardened: removed `update_contact`
  // from the suggested types list. The LP MCP executor (src/actions/index.js
  // ACTION_HANDLERS) has no `update_contact` handler, and the underlying
  // HL MCP path historically wiped tags via PUT (Kristen Nichols incident).
  // Use add_tag/remove_tag/set_stage for tag mutations and
  // update_custom_fields for field updates.
  server.tool(
    'create_agent_action',
    'Queue an agent action for execution. Actions can auto-execute or require human approval.',
    {
      event_id: z.number().describe('ID of the triggering system event'),
      action_type: z.string().describe('Action type. Common: add_tag, remove_tag, set_stage, update_custom_fields, update_contact_email, move_opportunity, update_opportunity, add_to_workflow, remove_from_workflow, send_message, create_task, send_notification, book_appointment, reschedule_appointment, cancel_appointment, emit_event, layer3_dispatch. Five9 admin writes (five9_start_campaign, five9_stop_campaign, five9_reset_campaign, five9_set_outbound_campaign, five9_add_records_to_list, five9_delete_record_from_list, five9_async_delete_records_from_list, five9_add_numbers_to_dnc, five9_user_skill_add, five9_user_skill_modify, five9_user_skill_remove, five9_create_campaign_profile, five9_modify_campaign_profile, and the Phase G config surface: five9_create_ivr_script, five9_modify_ivr_script, five9_create_inbound_campaign, five9_set_default_ivr_schedule, five9_add_dnis_to_campaign, five9_remove_dnis_from_campaign, five9_create_prompt_tts, and the Phase H user-profile surface: five9_modify_user_profile_skills, five9_modify_user_profile_user_list, five9_create_user_profile, five9_modify_user_profile) MUST be queued with requires_approval: true and only execute when FIVE9_WRITES_ENABLED is set. Any action_type starting with five9_ is COERCED to requires_approval: true at queue time regardless of what you pass, so a five9 write always waits for approve_action. DNC is ADD-ONLY: five9_add_numbers_to_dnc exists, and there is deliberately NO removal op — five9_remove_numbers_from_dnc was deleted on 2026-08-21 and now fails as an unknown action type. Reece does not take numbers off DNC, so do not look for an override or a reason string that would allow it; there is none. five9_reset_campaign requires action_payload.confirm_token (restate the campaign name verbatim) and REFUSES a campaign that is currently RUNNING — resetCampaign clears dispositions and list positions for the whole campaign, making every record re-dialable at once, so stop the campaign first and queue the reset and the restart as separate approved actions. USER PROFILES: a profile is shared — "Level 1 Setter Profile" carries five agents at once — so prefer the NARROW patches. five9_modify_user_profile_skills takes {profile_name, add_skills[], remove_skills[]} and five9_modify_user_profile_user_list takes {profile_name, add_users[], remove_users[]}; both need at least one non-empty list, both refuse an unknown profile_name, and neither can touch a role grant. Use them to onboard a setter or adjust skill routing. The FULL-OBJECT pair is higher risk: five9_modify_user_profile REPLACES the entire userProfile struct, so it takes {profile_name, changes:{...}, confirm_token} and read-modify-writes internally — anything you do not name in changes is carried forward, but the op cannot be used to "patch" a nested field you have not read first. five9_create_user_profile takes {profile_name, profile:{...}, confirm_token}. Both require confirm_token restating the profile name verbatim (modify checks it against Five9\'s own spelling of the live profile, including case). GUARDRAIL 12: any changes.roles (or, on create, any submitted roles block) that populates admin or supervisor is REFUSED unless the payload carries BOTH compliance_override: true AND a written legal_basis string of at least 20 characters, which is persisted verbatim to the audit event — a profile granting admin hands it to every user carrying it, and the Five9 Admin API has no audit trail of its own, so that event is the only record the grant will ever have. Dropping a role, or carrying an existing grant forward untouched, is not gated. five9_modify_ivr_script requires action_payload.confirm_token (restate the script name verbatim) and refuses a script live on more than one RUNNING campaign without compliance_override: true. five9_remove_dnis_from_campaign requires confirm_token (restate the campaign name) because removing a DNIS dead-ends a live number. five9_add_dnis_to_campaign REFUSES any number currently assigned to a different campaign without compliance_override: true — reassigning a live number silently re-routes a marketing line and breaks its attribution. five9_create_inbound_campaign requires action_payload.script_name (an existing IVR script): Five9 refuses to create an inbound campaign with a null defaultIvrSchedule, so the script attaches at creation — five9_set_default_ivr_schedule is for RE-POINTING an existing campaign, not for the initial attach. five9_async_delete_records_from_list is BULK deletion: it additionally requires action_payload.confirm_token (restate list_name verbatim) and action_payload.expected_record_count, and refuses above FIVE9_MAX_LIST_DELETE or >50% of the list without compliance_override: true. Do NOT use update_contact — unimplemented in the executor and historically wiped tags via PUT. See LP MCP src/actions/index.js ACTION_HANDLERS for the full registry.'),
      target_system: z.string().describe('Target: ghl, lp, n8n, groupme, notion'),
      target_entity: z.string().describe('Entity type: contact, opportunity, workflow, task'),
      target_id: z.string().describe('ID of entity being acted on'),
      action_payload: z.string().describe('JSON string of action params'),
      rollback_payload: z.string().optional().describe('JSON string of undo params'),
      reasoning: z.string().optional().describe('Why this action is being taken'),
      confidence: z.number().optional().describe('Agent confidence 0.0-1.0'),
      rule_applied: z.string().optional().describe('Rule key that triggered this'),
      requires_approval: z.boolean().optional().describe('Whether human must approve (default false)'),
      batch_id: z.string().optional().describe('Group related actions'),
      sequence_order: z.number().optional().describe('Order within batch (default 0)'),
      priority: z.number().int().optional().describe('Pull-queue priority lane (lower = higher priority). Omit to let the DB trigger pick a lane based on action_type/rule_applied. Default lanes: 10=customer-facing send_message/send_notification, 15=layer3_dispatch, 20=AGENTIC_* routing tags, 50=state updates, 100=default, 200=BULK_*/MIGRATION_* batch work. Override only when you need to.'),
    },
    async (params) => {
      try {
        const { requiresApproval, coerced: approvalCoerced } =
          resolveRequiresApproval(params.action_type, params.requires_approval);
        const status = requiresApproval ? 'pending_approval' : 'pending';
        const insertRow = {
          event_id: params.event_id,
          action_type: params.action_type,
          target_system: params.target_system,
          target_entity: params.target_entity,
          target_id: params.target_id,
          action_payload: JSON.parse(params.action_payload),
          rollback_payload: params.rollback_payload ? JSON.parse(params.rollback_payload) : null,
          reasoning: params.reasoning || null,
          confidence: params.confidence || null,
          rule_applied: params.rule_applied || null,
          status,
          requires_approval: requiresApproval,
          batch_id: params.batch_id || null,
          sequence_order: params.sequence_order || 0,
        };
        // priority is only set when caller provides it. Omitting the key
        // (vs. setting null) lets the BEFORE INSERT trigger fill the
        // default lane.
        if (params.priority !== undefined && params.priority !== null) {
          insertRow.priority = params.priority;
        }
        const { data, error } = await supabase
          .from('agent_actions')
          .insert(insertRow)
          .select('id, action_type, status, target_id, priority, created_at')
          .single();

        if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'queued', action_id: data.id, action_type: data.action_type, action_status: data.status, target_id: data.target_id, priority: data.priority, requires_approval: requiresApproval, ...(approvalCoerced ? { approval_coerced: true, note: 'Five9 admin writes are always queued requires_approval:true — this action is waiting on approve_action.' } : {}) }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Exception: ${err.message}` }] };
      }
    }
  );

  // ───────────────────────────────────────────────────
  // Tool: get_pending_actions
  // ───────────────────────────────────────────────────
  server.tool(
    'get_pending_actions',
    'Get agent actions that are pending execution or awaiting approval.',
    {
      status: z.string().optional().describe('Filter: pending, pending_approval, approved, executing'),
      limit: z.number().optional().describe('Max results (default 20)'),
    },
    async (params) => {
      let query = supabase
        .from('agent_actions')
        .select('id, event_id, action_type, target_system, target_entity, target_id, action_payload, reasoning, confidence, rule_applied, status, requires_approval, batch_id, sequence_order, priority, created_at')
        .order('priority', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true })
        .limit(params.limit || 20);

      if (params.status) {
        query = query.eq('status', params.status);
      } else {
        // 'approved' included in default scope so legacy stuck rows from
        // pre-2026-04-28 (when this tool wrote that status by mistake) are
        // visible in dashboards. The reaper sweeps them on each heartbeat;
        // they should never accumulate going forward.
        query = query.in('status', ['pending', 'pending_approval', 'approved']);
      }

      const { data, error } = await query;
      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      return { content: [{ type: 'text', text: JSON.stringify({ count: data.length, actions: data }, null, 2) }] };
    }
  );

  // ───────────────────────────────────────────────────
  // Tool: approve_action
  // ───────────────────────────────────────────────────
  // BUG FIX 2026-04-28 — was setting status='approved' on approval, which
  // is an orphan state the executor never reads (only picks up 'pending').
  // Created 56 silently-orphaned actions across the system. Now writes
  // status='pending' to match the GroupMe webhook flow in groupme.js.
  // Reaper still sweeps any 'approved' rows defensively for legacy data
  // and any other code paths that might produce that status.
  server.tool(
    'approve_action',
    'Approve or reject an agent action that requires human approval. Approved actions are queued for executor pickup; rejected actions are marked rejected with optional reason.',
    {
      action_id: z.number().describe('ID of the action to approve/reject'),
      decision: z.string().describe('Either "approve" or "reject"'),
      approved_by: z.string().optional().describe('Who approved (default: ryan)'),
      rejection_reason: z.string().optional().describe('Reason for rejection'),
    },
    async (params) => {
      const isApprove = params.decision === 'approve';
      const updates = isApprove
        ? {
            // 'pending' (NOT 'approved') so the executor's
            //   .eq('status', 'pending')
            // pickup query matches. Mirrors groupme.js:handleGroupMeCallback.
            status: 'pending',
            approved_by: params.approved_by || 'ryan',
            approved_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }
        : {
            status: 'rejected',
            approved_by: params.approved_by || 'ryan',
            approved_at: new Date().toISOString(),
            rejection_reason: params.rejection_reason || null,
            updated_at: new Date().toISOString(),
          };

      const { data, error } = await supabase
        .from('agent_actions')
        .update(updates)
        .eq('id', params.action_id)
        .eq('status', 'pending_approval')
        .select('id, action_type, status, target_id')
        .single();

      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      if (!data) return { content: [{ type: 'text', text: `Action ${params.action_id} not found or not pending_approval.` }] };
      return { content: [{ type: 'text', text: JSON.stringify({ decision: isApprove ? 'approved' : 'rejected', action_id: data.id, action_type: data.action_type, target_id: data.target_id, queued_status: data.status }, null, 2) }] };
    }
  );

  // ───────────────────────────────────────────────────
  // Tool: complete_action
  // ───────────────────────────────────────────────────
  server.tool(
    'complete_action',
    'Mark an agent action as completed or failed after execution attempt.',
    {
      action_id: z.number().describe('ID of the action'),
      status: z.string().describe('Either "completed" or "failed"'),
      execution_result: z.string().optional().describe('JSON string of response from target system'),
      error_message: z.string().optional().describe('Error details if failed'),
    },
    async (params) => {
      const updates = {
        status: params.status,
        executed_at: new Date().toISOString(),
        execution_result: params.execution_result ? JSON.parse(params.execution_result) : null,
        error_message: params.error_message || null,
      };

      if (params.status === 'failed') {
        const { data: current } = await supabase.from('agent_actions').select('retry_count, max_retries').eq('id', params.action_id).single();
        if (current && current.retry_count < current.max_retries) {
          updates.status = 'pending';
          updates.retry_count = current.retry_count + 1;
        }
      }

      const { data, error } = await supabase.from('agent_actions').update(updates).eq('id', params.action_id).select('id, action_type, status, retry_count, executed_at').single();
      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      return { content: [{ type: 'text', text: JSON.stringify({ action_id: data.id, action_type: data.action_type, final_status: data.status, retry_count: data.retry_count, executed_at: data.executed_at }, null, 2) }] };
    }
  );

  // ───────────────────────────────────────────────────
  // Tool: get_event_history
  // ───────────────────────────────────────────────────
  server.tool(
    'get_event_history',
    'Get system event history for a specific entity. Useful for understanding what happened to a contact or lead.',
    {
      ghl_contact_id: z.string().optional().describe('Filter by GHL contact ID'),
      lp_lead_id: z.string().optional().describe('Filter by LP Lead ID'),
      entity_id: z.string().optional().describe('Filter by generic entity ID'),
      event_type: z.string().optional().describe('Filter by event type'),
      limit: z.number().optional().describe('Max results (default 50)'),
      since: z.string().optional().describe('ISO date — only events after this'),
    },
    async (params) => {
      let query = supabase.from('system_events')
        .select('id, event_type, event_subtype, source, entity_type, entity_id, ghl_contact_id, lp_lead_id, payload, new_state, processed, action_taken, priority, event_timestamp, created_at')
        .order('created_at', { ascending: false }).limit(params.limit || 50);

      if (params.ghl_contact_id) query = query.eq('ghl_contact_id', params.ghl_contact_id);
      if (params.lp_lead_id) query = query.eq('lp_lead_id', params.lp_lead_id);
      if (params.entity_id) query = query.eq('entity_id', params.entity_id);
      if (params.event_type) query = query.eq('event_type', params.event_type);
      if (params.since) query = query.gte('created_at', params.since);

      const { data, error } = await query;
      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      return { content: [{ type: 'text', text: JSON.stringify({ count: data.length, events: data }, null, 2) }] };
    }
  );

  // ───────────────────────────────────────────────────
  // Tool: get_action_history
  // ───────────────────────────────────────────────────
  server.tool(
    'get_action_history',
    'Get agent action history. Useful for auditing what the agent has done.',
    {
      target_id: z.string().optional().describe('Filter by target entity ID'),
      action_type: z.string().optional().describe('Filter by action type'),
      status: z.string().optional().describe('Filter by status'),
      limit: z.number().optional().describe('Max results (default 50)'),
      since: z.string().optional().describe('ISO date — only actions after this'),
    },
    async (params) => {
      let query = supabase.from('agent_actions')
        .select('id, event_id, action_type, target_system, target_entity, target_id, action_payload, reasoning, confidence, rule_applied, status, requires_approval, approved_by, executed_at, execution_result, error_message, retry_count, priority, created_at')
        .order('created_at', { ascending: false }).limit(params.limit || 50);

      if (params.target_id) query = query.eq('target_id', params.target_id);
      if (params.action_type) query = query.eq('action_type', params.action_type);
      if (params.status) query = query.eq('status', params.status);
      if (params.since) query = query.gte('created_at', params.since);

      const { data, error } = await query;
      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      return { content: [{ type: 'text', text: JSON.stringify({ count: data.length, actions: data }, null, 2) }] };
    }
  );

  // ───────────────────────────────────────────────────
  // Tool: agent_dashboard
  // ───────────────────────────────────────────────────
  server.tool(
    'agent_dashboard',
    'Get a quick overview of the agentic system: pending events, pending actions, recent activity, and health.',
    {},
    async () => {
      try {
        const { data: pendingEvents } = await supabase.from('system_events').select('priority').eq('processed', false);
        const eventCounts = { critical: 0, high: 0, normal: 0, low: 0, total: 0 };
        (pendingEvents || []).forEach(e => {
          eventCounts[e.priority] = (eventCounts[e.priority] || 0) + 1;
          eventCounts.total++;
        });

        const { data: pendingActions } = await supabase.from('agent_actions').select('status').in('status', ['pending', 'pending_approval', 'approved', 'executing']);
        const actionCounts = { pending: 0, pending_approval: 0, approved: 0, executing: 0 };
        (pendingActions || []).forEach(a => { actionCounts[a.status] = (actionCounts[a.status] || 0) + 1; });

        const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { count: eventsLast24h } = await supabase.from('system_events').select('id', { count: 'exact', head: true }).gte('created_at', since24h);
        const { count: actionsCompleted24h } = await supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'completed').gte('executed_at', since24h);
        const { count: actionsFailed24h } = await supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'failed').gte('created_at', since24h);

        return { content: [{ type: 'text', text: JSON.stringify({ pending_events: eventCounts, pending_actions: actionCounts, last_24h: { events_received: eventsLast24h || 0, actions_completed: actionsCompleted24h || 0, actions_failed: actionsFailed24h || 0 } }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Dashboard error: ${err.message}` }] };
      }
    }
  );

}
