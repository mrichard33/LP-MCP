/**
 * The rehash ownership gate and the 15-minute pause, wired to the world —
 * src/services/rehash-gate-io.js (Mark, 2026-10-21)
 *
 * The rules are pure (src/agentic/rehash-owned.js, rehash-pause.js,
 * conversation-complete.js); this module does the reads and returns one
 * verdict per send. Every read goes through `deps`, so the send handler, the
 * live chat and the tests share one path.
 *
 * Reads, cheapest first, and only for a rehash contact:
 *   - the contact's tags (the caller's live read) and the newest LP lead
 *     (lp_leads, fetchCurrentLead) decide whether the contact is in rehash;
 *   - the GHL appointments (fetchRecentAndUpcomingAppointments) for a Rehash
 *     Call;
 *   - the manual outbound messages (manualOutbounds, HL-MCP's
 *     contact.outbound_message) and our last send (agent_actions);
 *   - only when a pause fires: the GHL thread and, if the words decide
 *     nothing, one small model call.
 * A failed read is never "owned" and never "paused": the bot sends, exactly
 * as the human-takeover read fails open.
 */
import supabaseDefault from '../supabase.js';
import { isRehashContact } from '../agentic/rehash.js';
import { isInRehash, rehashRoutingMode, rehashTeamUserIds } from '../agentic/rehash-state.js';
import { lpSold } from '../agentic/post-demo-owner.js';
import { isPostDemoLead } from '../agentic/post-demo-lead.js';
import {
  rehashOwned, rehashOwnedMode, ownedDecision, REHASH_OWNED_SKIP_REASON,
} from '../agentic/rehash-owned.js';
import {
  rehashPauseMode, rehashPauseMinutes, rehashPauseMaxRestarts, manualReadSinceMs, pauseDecision, pauseOutcome,
  REHASH_PAUSE_REASON, REHASH_HANDED_OFF_REASON, CONVERSATION_COMPLETE_REASON,
} from '../agentic/rehash-pause.js';
import {
  conversationComplete, readModelVerdict, COMPLETION_SYSTEM, completionPrompt,
} from '../agentic/conversation-complete.js';
import { manualOutbounds, readOurSends } from './human-takeover-io.js';
import { rehashOwnedAnswerMode } from '../agentic/rehash-owned-answer.js';
import { classifyOwnedQuestion } from './rehash-owned-answer-io.js';

const NOT_A_CONVERSATION = new Set(['workflow', 'bulk_actions', 'campaign']);

async function defaults() {
  const [{ fetchCurrentLead }, { fetchRecentAndUpcomingAppointments }, { rehashCalendarId }, { fetchRecentMessages }, { callLLMJson }, { emitEvent }] = await Promise.all([
    import('../current-lead.js'),
    import('../knowledge/contact-appointments.js'),
    import('../knowledge/booking-calendar-router.js'),
    import('../agentic/reply-sender.js'),
    import('../llm-client.js'),
    import('../event-emitter.js'),
  ]);
  return { fetchCurrentLead, fetchRecentAndUpcomingAppointments, rehashCalendarId, fetchRecentMessages, callLLMJson, emitEvent };
}

/** The newest completed bot send to the contact (ms), or null. Throws on a read error. */
export async function lastBotSendMs(contactId, { supabase = supabaseDefault, excludeActionId = null } = {}) {
  const q = supabase.from('agent_actions').select('id, executed_at, created_at')
    .eq('action_type', 'send_message').eq('target_id', contactId).eq('status', 'completed')
    .order('created_at', { ascending: false }).limit(2);
  const { data, error } = await q;
  if (error) throw new Error(`agent_actions: ${error.message}`);
  const row = (data || []).find((r) => excludeActionId == null || String(r.id) !== String(excludeActionId));
  const ms = Date.parse(row?.executed_at || row?.created_at || '');
  return Number.isFinite(ms) ? ms : null;
}

/** True when one of OUR sends (not this row) completed after the boundary. */
export async function weAnsweredSince(contactId, sinceMs, { supabase = supabaseDefault, excludeActionId = null } = {}) {
  const { data, error } = await supabase.from('agent_actions').select('id, executed_at, created_at')
    .eq('action_type', 'send_message').eq('target_id', contactId).eq('status', 'completed')
    .gte('created_at', new Date(sinceMs).toISOString()).limit(5);
  if (error) throw new Error(`agent_actions: ${error.message}`);
  return (data || []).some((r) => excludeActionId == null || String(r.id) !== String(excludeActionId));
}

/** The GHL thread as { direction, text, manual, at }, oldest first; a person's message is `manual`. */
export async function readPauseThread(contactId, { teamUserIds, supabase = supabaseDefault, fetchRecentMessages, excludeActionId = null } = {}) {
  const { messages } = await fetchRecentMessages(contactId);
  const ours = await readOurSends(contactId, new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(), { supabase, excludeActionId });
  const team = teamUserIds instanceof Set ? teamUserIds : new Set(teamUserIds || []);
  return (messages || [])
    .filter((m) => m && typeof m.body === 'string' && m.body.trim() && /^(inbound|outbound)$/i.test(String(m.direction || '')))
    .map((m) => {
      const direction = String(m.direction).toLowerCase();
      const ours_ = ours.ids.has(String(m.id || '')) || NOT_A_CONVERSATION.has(String(m.source || '').toLowerCase());
      return { direction, text: m.body, at: m.dateAdded || null, manual: direction === 'outbound' && !ours_ && team.has(String(m.userId || '')) };
    })
    .sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
}

/**
 * Is this contact in the gate's scope? true | false | null (could not tell).
 * The reply writer's test (response-generator.js: the rehash tag, active-f.0
 * or the rehash line, else the OPPFDN lead in its 30-day window) plus any
 * contact tagged past its demo; a SOLD current lead never is.
 */
export function inRehash({ tags, fromNumber, currentLead, env = process.env, nowMs = Date.now() }) {
  if (currentLead && lpSold(currentLead)) return false;
  if (isRehashContact({ tags: tags || [], fromNumber, env })) return true;
  // 2026-10-21 (Jim Anderson): no rehash tag, and his NEWEST lead was already
  // Issue / Cnf for the next morning, so "OPPFDN in the 30-day window" read
  // false; the reply writer, reading an older synced row, still wrote to him
  // as rehash. A contact past its demo (lp-demo-completed, stage:post-
  // appointment) is in scope too, so the visit John set is what ends the bot.
  if (isPostDemoLead({ tags: tags || [] })) return true;
  if (rehashRoutingMode(env) === 'off') return false;
  if (currentLead === undefined) return tags ? false : null;
  return isInRehash({ tags: tags || [], currentLead, nowMs, env });
}

/**
 * One verdict for one send to a contact.
 * @param {{ contactId, actionId?, channel?, tags?: string[]|null, fromNumber?, inboundAt?: string|null,
 *           proactive?: boolean, priorPause?: object|null, nowMs?: number, env?,
 *           inboundText?: string|null, answerable?: boolean }} a
 *   answerable: this send is an AI-written reply to the lead's own inbound
 *   (`inboundText`), so an owned lead's direct question may be answered.
 * @returns {Promise<{ verdict: 'send'|'skip'|'hold', reason?, retryAt?, pause?, shadow?: object,
 *                     rehash?: boolean, owned?: object, firedPause?: object,
 *                     answerOnly?: { kind: 'question'|'change_request', reason: string, by: string } }>}
 */
export async function runRehashGate(a = {}, deps = {}) {
  const out = await runRehashGateInner(a, deps);
  // 2026-10-23: an owned lead's direct question goes out only when the pause
  // (below the ownership check) also said send.
  if (out?.answerOnlyPending) {
    const { answerOnlyPending, ...rest } = out;
    return rest.verdict === 'send' ? { ...rest, answerOnly: answerOnlyPending } : rest;
  }
  return out;
}

async function runRehashGateInner(a = {}, deps = {}) {
  const env = a.env || process.env;
  const nowMs = a.nowMs || Date.now();
  const ownedMode = rehashOwnedMode(env);
  const pauseMode = rehashPauseMode(env);
  if (ownedMode === 'off' && (pauseMode === 'off' || a.ownedOnly)) return { verdict: 'send' };
  const contactId = a.contactId;
  if (!contactId) return { verdict: 'send' };
  const d = { ...(await defaults()), ...deps };
  const supabase = d.supabase || supabaseDefault;
  const log = d.log || console.log;
  const emit = (event_type, payload, key) => Promise.resolve(d.emitEvent({
    event_type, source: 'rehash_gate', entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
    priority: 'low', bypass_filter: true, payload: { contact_id: contactId, action_id: a.actionId ?? null, ...payload },
    idempotency_key: key,
  })).catch(() => {});

  let currentLead;
  try { currentLead = await d.fetchCurrentLead(contactId, supabase); } catch { currentLead = undefined; }
  const rehash = inRehash({ tags: a.tags ?? null, fromNumber: a.fromNumber || null, currentLead, env, nowMs });
  if (rehash !== true) return { verdict: 'send', rehash };
  const shadow = {};
  let answerOnlyPending = null;

  // ── A. John owns the lead ───────────────────────────────────────
  if (ownedMode !== 'off') {
    const calId = d.rehashCalendarId(env);
    let appointments = null;
    if (calId) { try { appointments = await d.fetchRecentAndUpcomingAppointments(contactId, { pastHours: 0 }); } catch { appointments = null; } }
    const owned = rehashOwned({ tags: a.tags || [], appointments, currentLead, rehashCalendarId: calId, nowMs });
    const decision = ownedDecision({ mode: ownedMode, owned });
    if (decision !== 'send') {
      const payload = { reason: owned.reason, detail: owned.detail || null, message_id: a.messageId || null, channel: a.channel || null };
      if (decision === 'skip') {
        // 2026-10-23 (Mark, Kim Turko review): nothing proactive, but the lead's
        // own direct question gets a short answer, and a move or cancel request
        // gets one line for John (src/agentic/rehash-owned-answer.js).
        const answerMode = rehashOwnedAnswerMode(env);
        if (answerMode !== 'off' && a.answerable && !a.proactive && String(a.inboundText || '').trim()) {
          const cls = await (d.classifyOwnedQuestion || classifyOwnedQuestion)(a.inboundText);
          if (cls.kind === 'question' || cls.kind === 'change_request') {
            if (answerMode === 'live') {
              log(`[RehashOwned] 💬 ${contactId} action ${a.actionId}: owned (${owned.reason}) — answer only (${cls.kind}, ${cls.reason})`);
              emit('rehash.owned_answer_only', { ...payload, kind: cls.kind, classified_by: cls.by, classify_reason: cls.reason }, `rehash_owned_answer_only_${a.actionId ?? contactId}`);
              answerOnlyPending = { kind: cls.kind, reason: cls.reason, by: cls.by };
            } else {
              log(`[RehashOwned] shadow: ${contactId} action ${a.actionId}: owned — live would answer only (${cls.kind}); nothing sent`);
              payload.would_answer_only = cls.kind;
            }
          } else {
            payload.not_answered = cls.reason;
          }
        }
        if (!answerOnlyPending) {
          log(`[RehashOwned] ⏭️ ${contactId} action ${a.actionId}: owned (${owned.reason}) — no bot message`);
          emit('rehash.owned_skip', payload, `rehash_owned_skip_${a.actionId ?? contactId}`);
          return { verdict: 'skip', reason: REHASH_OWNED_SKIP_REASON, rehash, owned };
        }
      } else {
        log(`[RehashOwned] shadow: ${contactId} action ${a.actionId}: owned (${owned.reason}); live would send nothing`);
        emit('rehash.owned_would_skip', payload, `rehash_owned_would_skip_${a.actionId ?? contactId}`);
        shadow.rehash_owned_would_skip = { reason: owned.reason };
      }
    }
  }

  // ── B. A rehash rep's manual message pauses the bot ─────────────
  // (Not on the live chat, `ownedOnly`: a chat turn cannot be held 15 minutes.)
  if (pauseMode !== 'off' && !a.ownedOnly) {
    const minutes = rehashPauseMinutes(env);
    const teamUserIds = [...rehashTeamUserIds(env)];
    const prior = a.priorPause || null;
    let lastBot;
    try { lastBot = await lastBotSendMs(contactId, { supabase, excludeActionId: a.actionId ?? null }); } catch { lastBot = undefined; }
    if (lastBot !== undefined) {
      const sinceMs = prior?.since_ms ?? manualReadSinceMs({ lastBotSendMs: lastBot, nowMs, minutes });
      const manuals = await (d.manualOutbounds || manualOutbounds)(contactId, new Date(sinceMs).toISOString(), { supabase, excludeActionId: a.actionId ?? null, env });
      if (manuals !== undefined) {
        const inboundMs = Date.parse(a.inboundAt || '');
        const decision = pauseDecision({
          manuals, teamUserIds, inboundMs: Number.isFinite(inboundMs) ? inboundMs : null, nowMs, minutes,
          maxRestarts: rehashPauseMaxRestarts(env), prior,
        });
        const outcome = pauseOutcome({ mode: pauseMode, decision, proactive: !!a.proactive });
        const pause = decision.action === 'none' ? null : {
          since_ms: sinceMs, anchor_ms: decision.anchorMs, restarts: decision.restarts || 0,
          started_at: prior?.started_at || new Date(nowMs).toISOString(),
        };
        const evPayload = { anchor_ts: pause ? new Date(pause.anchor_ms).toISOString() : null, restarts: pause?.restarts ?? 0 };
        if (outcome === 'would_hold' || outcome === 'would_skip') {
          log(`[RehashPause] shadow: ${contactId} action ${a.actionId}: a rehash rep's manual message → live would ${decision.action === 'hold' ? `hold until ${new Date(decision.retryAtMs).toISOString()}` : decision.action}`);
          emit('rehash.pause_would_hold', { ...evPayload, decision: decision.action }, `rehash_pause_would_${a.actionId ?? contactId}`);
          shadow.rehash_pause_would_hold = { decision: decision.action, anchor_ms: pause?.anchor_ms ?? null };
        } else if (outcome === 'hold') {
          const retryAt = new Date(decision.retryAtMs).toISOString();
          const first = !prior;
          log(`[RehashPause] ⏸️ ${contactId} action ${a.actionId}: ${first ? 'paused' : decision.restarted ? 'restarted' : 'still paused'} until ${retryAt} (a rehash rep's manual message at ${decision.manualAt || 'n/a'})`);
          if (first) emit('rehash.pause_started', { ...evPayload, outcome: 'hold' }, `rehash_pause_started_${a.actionId ?? contactId}`);
          else if (decision.restarted) emit('rehash.pause_restarted', { ...evPayload, outcome: 'hold' }, `rehash_pause_restarted_${a.actionId ?? contactId}_${pause.restarts}`);
          return { verdict: 'hold', reason: REHASH_PAUSE_REASON, retryAt, pause, rehash };
        } else if (outcome === 'skip') {
          const reason = decision.action === 'handed_off' ? REHASH_HANDED_OFF_REASON : REHASH_PAUSE_REASON;
          log(`[RehashPause] ⏭️ ${contactId} action ${a.actionId}: ${reason}${a.proactive ? ' (nothing proactive while paused)' : ''}`);
          if (prior) emit('rehash.pause_fired', { ...evPayload, outcome: reason, reason }, `rehash_pause_fired_${a.actionId ?? contactId}`);
          return { verdict: 'skip', reason, rehash, pause };
        } else if (outcome === 'fire') {
          const fired = await firePause({ a, d, supabase, log, emit, contactId, teamUserIds, pause, evPayload, shadow, rehash,
            answeredSinceMs: Number.isFinite(inboundMs) ? inboundMs : Date.parse(pause.started_at) });
          return answerOnlyPending ? { ...fired, answerOnlyPending } : fired;
        }
      }
    }
  }
  return { verdict: 'send', rehash, ...(Object.keys(shadow).length ? { shadow } : {}), ...(answerOnlyPending ? { answerOnlyPending } : {}) };
}

/** The pause ran out with no newer team message: read the thread once. */
async function firePause({ a, d, supabase, log, emit, contactId, teamUserIds, pause, evPayload, shadow, rehash, answeredSinceMs }) {
  const done = (outcome, reason, extra = {}) => {
    emit('rehash.pause_fired', { ...evPayload, outcome, reason, ...extra }, `rehash_pause_fired_${a.actionId ?? contactId}`);
    return outcome;
  };
  // Another reply of ours went out meanwhile (a second row for the same turn).
  try {
    if (Number.isFinite(answeredSinceMs) && await weAnsweredSince(contactId, answeredSinceMs, { supabase, excludeActionId: a.actionId ?? null })) {
      done('already_answered', 'already_answered');
      return { verdict: 'skip', reason: 'already_answered', rehash, pause };
    }
  } catch { /* unreadable: go on to the thread */ }
  let thread = null;
  try { thread = await readPauseThread(contactId, { teamUserIds, supabase, fetchRecentMessages: d.fetchRecentMessages, excludeActionId: a.actionId ?? null }); } catch { thread = null; }
  if (!thread) {
    log(`[RehashPause] ▶️ ${contactId} action ${a.actionId}: pause over, thread unreadable — replying (open)`);
    done('open', 'thread_unreadable');
    return { verdict: 'send', rehash, firedPause: { outcome: 'open', reason: 'thread_unreadable' }, ...(Object.keys(shadow).length ? { shadow } : {}) };
  }
  let verdict = conversationComplete({ thread });
  let ambiguous = false;
  if (verdict.ambiguous) {
    ambiguous = true;
    try {
      const out = await d.callLLMJson({ fn: 'conversation_complete', system: COMPLETION_SYSTEM, user: completionPrompt(thread), maxTokens: 200 });
      verdict = { ...readModelVerdict(out?.data), ambiguous: true };
    } catch {
      verdict = { complete: false, reason: 'completion_ambiguous', ambiguous: true };
    }
  }
  if (verdict.complete) {
    log(`[RehashPause] ✅ ${contactId} action ${a.actionId}: pause over, conversation complete (${verdict.reason}) — no send`);
    done(CONVERSATION_COMPLETE_REASON, verdict.reason, ambiguous ? { completion_ambiguous: true } : {});
    return { verdict: 'skip', reason: CONVERSATION_COMPLETE_REASON, rehash, pause, completion: verdict };
  }
  log(`[RehashPause] ▶️ ${contactId} action ${a.actionId}: pause over, conversation open (${verdict.reason}) — replying`);
  done('open', verdict.reason, ambiguous ? { completion_ambiguous: true } : {});
  return { verdict: 'send', rehash, firedPause: { outcome: 'open', reason: verdict.reason, completion_ambiguous: ambiguous }, ...(Object.keys(shadow).length ? { shadow } : {}) };
}

/**
 * Does John own this rehash contact? The ownership read alone, for callers
 * that post or record rather than send (the #contact-rehash cards, the
 * promised-callback sweep). { owned: true|false|null, reason? }. Never throws.
 */
export async function readRehashOwnership(contactId, { tags = null } = {}, deps = {}) {
  try {
    const d = { ...(await defaults()), ...deps };
    const supabase = d.supabase || supabaseDefault;
    let t = tags;
    if (!Array.isArray(t)) {
      const getContact = d.getContact || (async (id) => (await import('../actions/contact-cache.js')).getContactCached(id, null, { maxWaitMs: 2000 }));
      const c = await getContact(contactId).catch(() => null);
      t = Array.isArray(c?.tags) ? c.tags : null;
    }
    let currentLead;
    try { currentLead = await d.fetchCurrentLead(contactId, supabase); } catch { currentLead = undefined; }
    const calId = d.rehashCalendarId(process.env);
    let appointments = null;
    if (calId) { try { appointments = await d.fetchRecentAndUpcomingAppointments(contactId, { pastHours: 0 }); } catch { appointments = null; } }
    return rehashOwned({ tags: t || [], appointments, currentLead, rehashCalendarId: calId });
  } catch {
    return { owned: null };
  }
}
