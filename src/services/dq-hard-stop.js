/**
 * Hard DQ stop — src/services/dq-hard-stop.js
 *
 * 2026-10-07 — a disqualified lead gets stop-bot and leaves the workflows
 * (Mark's handoff, "Decisions already made"). Enforced in code, not only in
 * the rule template (AI OS CANON.STD.019, P.001).
 *
 * WHY: SERVICE_AREA_EXIT (agent_rules 311) sends the goodbye, then adds
 * out-of-area + suppress-outbound, moves the P3 card and ends the handoff. It
 * never added stop-bot or took the contact out of a workflow, and GHL
 * workflow 6cd679ff (agentic.handoff_started) re-adds agentic-active. Jessup
 * (LmBvkJUNrqZ9HoVNuovP, 2026-10-05) got an AI reply and an S5.2 text after
 * his exit. The hard-DQ rules (276 mobile home, 313 lanai, 352/353 height)
 * have the same gap.
 *
 * HOW: when the executor completes an add_tag of a trigger tag (out-of-area,
 * dq-out-of-area, hard-disqualified) it calls scheduleDqHardStop. That queues
 * ONE `dq_hard_stop` action 60 seconds out (not_before_seconds) — after the
 * rest of the rule's own actions, because stop-bot blocks every gated
 * mutation and the P3 move and handoff end in the same template must still
 * land. executeDqHardStop then adds stop-bot, removes agentic-active and
 * queues remove_from_workflow (executeRemoveFromWorkflow; exempt from the
 * mutation gate as a de-escalation) for every active S5.x / S4.5 / W-series
 * workflow the contact's active-* tags name.
 *
 * Idempotent per contact (AI OS CANON.STD.014): the claim key is
 * dq-hard-stop:<contact>; a dq_hard_stop row for the contact that is pending,
 * executing or completed in the last 30 days means none is queued again, and
 * the action itself only adds what is missing and removes what is present.
 *
 * Behind SEND_GATE_MODE: shadow records a `send_gate.would_hard_stop` event
 * and writes nothing; live queues the action. The action re-checks the mode
 * when it runs, so flipping back to shadow stops any queued row.
 *
 * All I/O through `deps` (supabase, ghlFetch, executeAddTag, executeRemoveTag,
 * emitEvent) so the behaviour unit-tests without a live service.
 */

import { sendGateMode } from './may-message.js';
import { lpNoteDqMode } from '../agentic/lp-note-dq.js';
import { botOffTag } from '../consent/stop-bot-origin.js';

// 2026-10-07 (Nicholas Ferraioli): a team note in LP that says we cannot run
// the lead (lp-note-dq.js) stops the bot the same way. It carries no trigger
// tag, and it is behind its own switch, LP_NOTE_DQ_MODE, not SEND_GATE_MODE:
// the user's ruling that day is that stop-bot turns the bot off.
export const LP_NOTE_DQ_TRIGGER = 'lp_note_dq';
function liveFor(trigger, env) {
  return trigger === LP_NOTE_DQ_TRIGGER ? lpNoteDqMode(env) === 'live' : sendGateMode(env) === 'live';
}

export const DQ_HARD_STOP_ACTION = 'dq_hard_stop';
export const DQ_HARD_STOP_RULE = 'DQ_HARD_STOP';
export const DQ_TRIGGER_TAGS = Object.freeze(['out-of-area', 'dq-out-of-area', 'hard-disqualified']);
const TRIGGER_SET = new Set(DQ_TRIGGER_TAGS);
const CLAIM_WINDOW_DAYS = 30;
const DELAY_SECONDS = 60;

// active-s5, active-s5.2, active-s4.5, active-w1, active-w8.0 — the sending
// sequences a disqualified lead must leave. Not E.*, P.*, F.* or C.*: those
// carry the intake, pipeline and customer records, not drip messages.
const LEAVE_RX = /^active-(s5(?:\.\d+)?|s4\.5|w\d+(?:\.\d+)?)$/i;

export function isDqTriggerTag(tag) {
  return TRIGGER_SET.has(String(tag || '').trim().toLowerCase());
}

export function claimKeyFor(contactId) {
  return `dq-hard-stop:${contactId}`;
}

/** Canonical workflow codes to leave, read from the contact's active-* tags. */
export function workflowCodesToLeave(tags) {
  const out = [];
  for (const raw of Array.isArray(tags) ? tags : []) {
    const m = String(raw || '').trim().toLowerCase().match(LEAVE_RX);
    if (m) {
      const code = m[1].toUpperCase();
      if (!out.includes(code)) out.push(code);
    }
  }
  return out;
}

/** Pure plan over the contact's current tags. */
export function planDqHardStop(tags, { trigger = null } = {}) {
  const t = (Array.isArray(tags) ? tags : []).map(x => String(x || '').trim().toLowerCase());
  // 2026-10-08: with its reason tag, so a later DNC lift keeps stop-bot
  // (src/consent/stop-bot-origin.js).
  const reason = botOffTag(trigger === LP_NOTE_DQ_TRIGGER ? 'lp-note' : 'dq');
  return {
    addTags: [...(t.includes('stop-bot') ? [] : ['stop-bot']), ...(t.includes(reason) ? [] : [reason])],
    removeTags: t.includes('agentic-active') ? ['agentic-active'] : [],
    leaveWorkflows: workflowCodesToLeave(t),
  };
}

/**
 * Called after an add_tag of a trigger tag completed. Never throws.
 * @returns {Promise<{scheduled: boolean, reason: string, action_id?: number}>}
 */
export async function scheduleDqHardStop({ contactId, tag = null, trigger = null, sourceActionId = null, rule = null }, deps = {}) {
  if (!contactId || (trigger !== LP_NOTE_DQ_TRIGGER && !isDqTriggerTag(tag))) return { scheduled: false, reason: 'not_a_trigger' };
  const mode = liveFor(trigger, deps.env || process.env) ? 'live' : 'shadow';
  const log = deps.log || console.log;
  if (trigger === LP_NOTE_DQ_TRIGGER) tag = tag || LP_NOTE_DQ_TRIGGER;
  try {
    if (mode !== 'live') {
      log(`[DqHardStop] shadow: ${contactId} got ${tag} (${rule || 'rule?'}) — live would add stop-bot and leave the workflows`);
      await deps.emitEvent?.({
        event_type: 'send_gate.would_hard_stop',
        source: 'send_gate',
        entity_type: 'contact',
        entity_id: String(contactId),
        ghl_contact_id: contactId,
        priority: 'low',
        bypass_filter: true,
        payload: { trigger_tag: tag, rule, source_action_id: sourceActionId, mode },
        idempotency_key: `send_gate_would_hard_stop_${contactId}`,
      });
      return { scheduled: false, reason: 'shadow' };
    }
    const since = new Date((deps.now ? deps.now() : Date.now()) - CLAIM_WINDOW_DAYS * 86400000).toISOString();
    const { data: prior, error: priorErr } = await deps.supabase
      .from('agent_actions')
      .select('id, status')
      .eq('action_type', DQ_HARD_STOP_ACTION)
      .eq('target_id', contactId)
      .in('status', ['pending', 'executing', 'completed'])
      .gte('created_at', since)
      .limit(1);
    if (priorErr) {
      // Cannot tell whether one is queued. Queue anyway: the action only adds
      // what is missing, so a second row costs a read, never a second effect.
      (deps.warn || console.warn)(`[DqHardStop] claim read failed for ${contactId}: ${priorErr.message} — queueing (the action is idempotent)`);
    } else if (Array.isArray(prior) && prior.length) {
      return { scheduled: false, reason: 'already_claimed', action_id: prior[0].id };
    }
    const { data: row, error } = await deps.supabase.from('agent_actions').insert({
      action_type: DQ_HARD_STOP_ACTION,
      target_system: 'ghl',
      target_entity: 'contact',
      target_id: contactId,
      action_payload: { claim_key: claimKeyFor(contactId), trigger_tag: tag, ...(trigger ? { trigger } : {}), source_rule: rule, source_action_id: sourceActionId, not_before_seconds: DELAY_SECONDS },
      reasoning: `Hard DQ stop: ${tag} landed (${rule || 'unknown rule'}) — add stop-bot, remove agentic-active, leave S5.x / S4.5 / W-series workflows`,
      rule_applied: DQ_HARD_STOP_RULE,
      status: 'pending',
      requires_approval: false,
      priority: 20,
    }).select('id').maybeSingle();
    if (error) throw new Error(error.message);
    log(`[DqHardStop] queued #${row?.id ?? '?'} for ${contactId} (${tag}, ${rule || 'rule?'})`);
    return { scheduled: true, reason: 'queued', action_id: row?.id ?? null };
  } catch (err) {
    (deps.warn || console.warn)(`[DqHardStop] could not schedule for ${contactId}: ${err?.message || err}`);
    return { scheduled: false, reason: 'error' };
  }
}

/**
 * The dq_hard_stop action handler.
 * deps: { ghlFetch, executeAddTag, executeRemoveTag, resolveWorkflowId, supabase, env, log }
 */
export async function executeDqHardStop(action, context = {}, deps = {}) {
  const contactId = action.target_id;
  if (!contactId) throw new Error('dq_hard_stop: missing target_id');
  const trigger = action.action_payload?.trigger || null;
  if (!liveFor(trigger, deps.env || process.env)) {
    return { skipped: true, action: 'dq_hard_stop_skipped', reason: trigger === LP_NOTE_DQ_TRIGGER ? 'lp_note_dq_not_live' : 'send_gate_not_live', contact_id: contactId };
  }
  const res = await deps.ghlFetch('GET', `/contacts/${contactId}`);
  const tags = res?.contact?.tags || res?.tags || [];
  const plan = planDqHardStop(tags, { trigger });
  const rule = action.rule_applied || DQ_HARD_STOP_RULE;

  for (const tag of plan.addTags) {
    await deps.executeAddTag({ target_id: contactId, action_payload: { tag }, rule_applied: rule }, context);
  }
  if (plan.removeTags.length) {
    await deps.executeRemoveTag({ target_id: contactId, action_payload: { tags: plan.removeTags }, rule_applied: rule }, context);
  }
  // Resolve each code to its workflow first. The HL registry knows S4.5 and
  // S5.x but no W-series code (checked 2026-10-07), and a remove_from_workflow
  // with neither id nor a resolvable code throws. Anything unresolved goes out
  // through the existing "Remove All Marketing" route (remove_all) once.
  const queued = [];
  const unresolved = [];
  const queue = async (payload, label) => {
    const { data, error } = await deps.supabase.from('agent_actions').insert({
      action_type: 'remove_from_workflow',
      target_system: 'ghl',
      target_entity: 'contact',
      target_id: contactId,
      action_payload: { ...payload, claim_key: `${claimKeyFor(contactId)}:${label}` },
      reasoning: `Hard DQ stop: a disqualified lead leaves ${label}`,
      rule_applied: rule,
      status: 'pending',
      requires_approval: false,
      priority: 20,
    }).select('id').maybeSingle();
    if (error) (deps.warn || console.warn)(`[DqHardStop] remove_from_workflow ${label} not queued for ${contactId}: ${error.message}`);
    else queued.push({ code: label, action_id: data?.id ?? null });
  };
  for (const code of plan.leaveWorkflows) {
    let workflowId = null;
    try { workflowId = await deps.resolveWorkflowId?.(code); } catch { workflowId = null; }
    if (workflowId) await queue({ workflow_id: workflowId, canonical_code: code }, code);
    else unresolved.push(code);
  }
  if (unresolved.length) await queue({ remove_all: true }, 'remove-all-marketing');
  (deps.log || console.log)(`[DqHardStop] ${contactId}: added [${plan.addTags.join(', ')}] removed [${plan.removeTags.join(', ')}] leaving [${plan.leaveWorkflows.join(', ')}]`);
  return {
    action: 'dq_hard_stop_done',
    contact_id: contactId,
    added_tags: plan.addTags,
    removed_tags: plan.removeTags,
    workflows_queued: queued,
    workflows_unresolved: unresolved,
  };
}
