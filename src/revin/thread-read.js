/**
 * Read a contact's Revin turns for the bot — src/revin/thread-read.js (2026-10-19)
 *
 * The one read both history loaders use (context-builder for SMS, the live
 * chat lane). Returns [] without touching the database when
 * BOT_INCLUDE_REVIN_THREAD is off. Last 20 Revin texts from the last 14 days,
 * from contact_thread_v. Revin's text is outside text: every body goes through
 * cleanInboundForModel, and the read is screened once (guardrail_decisions
 * surface 'revin_thread', in the background, never awaited, never blocking).
 * Never throws: a failed read is [] and a log line.
 */
import supabaseDefault from '../supabase.js';
import { cleanInboundForModel } from '../security/untrusted-text.js';
import { guardInBackground } from '../security/injection-guard.js';
import { revinThreadEnabled, toRevinTurn, REVIN_THREAD_MAX_TURNS, REVIN_THREAD_MAX_DAYS } from './thread.js';

export async function readRevinTurns(contactId, { env = process.env, deps = {}, nowMs = Date.now() } = {}) {
  if (!contactId || !revinThreadEnabled(env)) return [];
  const supabase = deps.supabase || supabaseDefault;
  const guard = deps.guardInBackground || guardInBackground;
  try {
    const since = new Date(nowMs - REVIN_THREAD_MAX_DAYS * 86_400_000).toISOString();
    const { data, error } = await supabase.from('contact_thread_v')
      .select('direction, body, sent_at, channel')
      .eq('ghl_contact_id', contactId)
      .eq('source', 'revin')
      .in('direction', ['inbound', 'outbound'])
      .gte('sent_at', since)
      .order('sent_at', { ascending: false })
      .limit(REVIN_THREAD_MAX_TURNS);
    if (error) throw new Error(error.message);
    const turns = [];
    let removed = 0;
    for (const row of (data || []).reverse()) {
      if (row.channel === 'call_event') continue; // context for people, never a text turn
      const clean = cleanInboundForModel(row.body ?? '', env);
      const turn = toRevinTurn({ ...row, body: clean.text });
      if (!turn) continue;
      removed += clean.removedCount || 0;
      turns.push(turn);
    }
    // One screening row per read, not per turn: up to 20 turns ride every reply.
    if (turns.length) guard({ surface: 'revin_thread', text: turns.map((t) => t.text).join('\n'), removedCount: removed, sourceRef: contactId });
    return turns;
  } catch (err) {
    console.warn(`[Revin] thread read failed for ${contactId}: ${err.message}`);
    return [];
  }
}
