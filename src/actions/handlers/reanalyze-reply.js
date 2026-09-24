/**
 * reanalyze_reply handler — src/actions/handlers/reanalyze-reply.js
 *
 * 2026-09-21 — the missed-reply self-heal.
 *
 * WHY THIS EXISTS: when the message analyzer fails, nothing routes. No exit
 * rule fires, no DNC rule fires, no reply is sent — and the workflows that
 * were already running keep running. Mayra (qM5QYwn5ISZ8DQOgFJpX) texted "no
 * longer interested" on 9/18; the analyzer returned ai.analysis_failed twice,
 * so S5.2 emailed her on 9/19, texted on 9/20, and Five9 kept dialing.
 *
 * The self-heal RE-RUNS THE ANALYSIS FIRST rather than replying. That matters:
 * a successful re-analysis emits ai.analysis_completed, and the normal rules —
 * exits, DNC, not-interested — own the outcome exactly as they would have. A
 * generic recovery reply is the fallback for when re-analysis does not change
 * anything, never the first move.
 *
 * action_payload:
 *   source_event_id — the ghl.reply_received row to re-analyze (required)
 *
 * ONE ATTEMPT, DELIBERATELY. The analyzer already failed on this message at
 * least once; a handler that retried would spend the LLM budget re-failing on
 * whatever made it fail, while the recovery rules behind it wait. A skip is
 * reported honestly so the executor does not retry either.
 */

import supabase from '../../supabase.js';
import { analyzeMessage } from '../../message-analyzer.js';

export async function executeReanalyzeReply(action, context = {}, deps = {}) {
  const db = deps.supabase || supabase;
  const analyze = deps.analyzeMessage || analyzeMessage;
  const payload = action.action_payload || {};

  // 2026-09-24 — rule AGENTIC_REPLY_SLA_REANALYZE carries the literal string
  // "{{source_event_id}}" (the decision engine does not render payload
  // templates), which is truthy, so the ?? never reached the event payload
  // that holds the real id. Every self-heal re-analysis failed 4/4 on
  // "could not read event {{source_event_id}}" while the operator alert said
  // "The self-heal re-ran the analysis". An unrendered placeholder is absent.
  const usable = (v) => (v != null && !/\{\{.*\}\}/.test(String(v)) ? v : null);
  const sourceEventId = usable(payload.source_event_id) ?? usable(context.source_event_id) ?? null;
  if (!sourceEventId) throw new Error('reanalyze_reply requires action_payload.source_event_id');

  // Read the ORIGINAL reply, not the watchdog's copy of it. The watchdog caps
  // message_text at 1000 chars for payload hygiene; the analyzer should see
  // exactly what the person sent.
  const { data: evt, error } = await db
    .from('system_events')
    .select('id, event_type, ghl_contact_id, payload')
    .eq('id', sourceEventId)
    .maybeSingle();
  if (error) throw new Error(`reanalyze_reply could not read event ${sourceEventId}: ${error.message}`);
  if (!evt) return { skipped: true, reason: 'source_event_not_found', source_event_id: sourceEventId };

  const contactId = evt.ghl_contact_id || action.target_id || null;
  const messageText = evt.payload?.message_text || null;
  if (!contactId) return { skipped: true, reason: 'source_event_has_no_contact', source_event_id: sourceEventId };
  if (!messageText) return { skipped: true, reason: 'source_event_has_no_message_text', source_event_id: sourceEventId };

  // Passing evt.id as the analyzer's eventId is what links a second failure
  // back to this reply (ai.analysis_failed carries source_event_id) — the
  // HTTP path passes null there and that is why the 9/18 failures were hard
  // to trace to a message.
  const result = await analyze(
    contactId,
    messageText,
    evt.id,
    evt.payload?.channel || null,
    evt.payload?.message_id || null,
  );

  // analyzeMessage returns null on a genuine failure or a rate limit. That is
  // NOT an error here: the recovery and opt-out rules behind this one are the
  // whole point, and throwing would leave the action retrying instead.
  if (result === null) {
    return { reanalyzed: false, reason: 'analysis_failed_again', source_event_id: evt.id, contact_id: contactId };
  }
  if (result?.skipped) {
    // terminal_suppression / stop_bot / recently_analyzed — the analyzer
    // deliberately declined. Reported as a skip so nothing retries it.
    return { skipped: true, reason: `analyzer_${result.reason || 'skipped'}`, source_event_id: evt.id, contact_id: contactId };
  }

  return {
    reanalyzed: true,
    source_event_id: evt.id,
    contact_id: contactId,
    buyer_stage: result?.buyer_stage ?? null,
    recommended_action: result?.recommended_action ?? null,
  };
}
