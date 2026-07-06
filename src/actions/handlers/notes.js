/**
 * add_note handler — src/actions/handlers/notes.js
 *
 * 2026-07-06 (Bot 2/3/4 consolidation, Sentinel §7 handoff quality bar):
 * writes a note to the GHL contact record. Primary use: the one-paragraph
 * escalation context summary — who the contact is, what they want, what's
 * been said, and what the human should do next — so no rep ever has to
 * scroll the thread to get oriented.
 *
 * action_payload:
 *   note                     — literal note text (required unless
 *                              include_context_summary is true)
 *   next_step                — optional "what the human should do next" line
 *   include_context_summary  — true → append who/what/said/next assembled
 *                              from the source event's analyzer payload
 *
 * Both modes compose when note + include_context_summary are both present.
 * Fail behavior: throws on GHL write failure so the executor retries; all
 * context assembly is fail-soft (missing pieces are simply omitted).
 */

import { ghlFetch } from '../helpers.js';
import { getContactCached } from '../contact-cache.js';
import supabase from '../../supabase.js';

async function fetchEventPayload(action) {
  if (!action?.event_id) return null;
  try {
    const { data } = await supabase
      .from('system_events')
      .select('payload')
      .eq('id', action.event_id)
      .maybeSingle();
    return data?.payload || null;
  } catch {
    return null;
  }
}

export async function executeAddNote(action, context = {}) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};
  if (!contactId) throw new Error('add_note: missing target_id');
  if (!payload.note && !payload.include_context_summary) {
    throw new Error('add_note: payload needs note and/or include_context_summary');
  }

  const parts = [];
  if (payload.note) parts.push(String(payload.note));

  if (payload.include_context_summary) {
    let name = null;
    try {
      const contact = await getContactCached(contactId, context?._contactCache);
      name = contact?.name || [contact?.firstName, contact?.lastName].filter(Boolean).join(' ') || null;
    } catch { /* name omitted */ }
    const evt = await fetchEventPayload(action);
    const summary = [];
    summary.push(`WHO: ${name || `contact ${contactId}`}`);
    if (evt?.recommended_action || evt?.escalation_category) {
      summary.push(`WHAT THEY WANT: ${[evt?.recommended_action, evt?.escalation_category].filter(Boolean).join(' / ')}`);
    }
    if (evt?.message_text) summary.push(`THEY SAID: "${String(evt.message_text).slice(0, 300)}"`);
    if (evt?.reasoning) summary.push(`ANALYZER: ${String(evt.reasoning).slice(0, 300)}`);
    if (evt?.objection_type) summary.push(`OBJECTION: ${evt.objection_type}`);
    if (payload.next_step) summary.push(`NEXT STEP: ${String(payload.next_step)}`);
    parts.push(summary.join(' · '));
  }

  const body = parts.join('\n').slice(0, 4000);
  await ghlFetch('POST', `/contacts/${contactId}/notes`, { body });
  console.log(`[ActionExecutor] ✅ add_note for ${contactId} (${body.length} chars, rule=${action.rule_applied || 'manual'})`);
  return { action: 'note_added', contact_id: contactId, note_length: body.length };
}
