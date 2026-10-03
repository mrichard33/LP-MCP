/**
 * bot-callback-io — src/services/bot-callback-io.js
 *
 * The production side of fileBotCallback (src/agentic/bot-callback.js): the
 * once-a-day read, the claim event, the lp_callback_requeue row (run now, so
 * the Five9 result is on the #contact-center card), and the NEPQ hand-off
 * with the production Slack, tag and note writers. Both bots use this one
 * object, so the two paths cannot drift.
 */

import supabase from '../supabase.js';
import { emitEvent } from '../event-emitter.js';
import { routeNepqHandoff } from '../agentic/nepq-handoff.js';
import { BOT_CALLBACK_RULE } from '../agentic/bot-callback.js';

/**
 * @param {{ applyTags(id, tags), addNote(id, note) }} writers — the caller's
 *   own GHL tag and note writers (the SMS handler and the live chat each have
 *   theirs already).
 */
export function botCallbackDeps({ applyTags, addNote }) {
  return {
    alreadyFiled: async (_contactId, key) => {
      if (!supabase) return false;
      const { data } = await supabase.from('system_events').select('id').eq('idempotency_key', key).maybeSingle();
      return !!data;
    },
    claim: (contactId, key, payload) => emitEvent({
      event_type: 'agentic.bot_callback', source: 'nepq_backbone', entity_type: 'contact', entity_id: contactId,
      ghl_contact_id: contactId, priority: 'high', bypass_filter: true, idempotency_key: key, payload,
    }),
    queueRequeue: async (contactId, notes) => {
      if (!supabase) throw new Error('supabase client not configured');
      const { data, error } = await supabase.from('agent_actions').insert({
        action_type: 'lp_callback_requeue', target_system: 'lp', target_entity: 'contact', target_id: contactId,
        rule_applied: BOT_CALLBACK_RULE, status: 'executing', requires_approval: false, max_retries: 1,
        reasoning: 'A bot reply promised the lead a phone call: Five9 Callback Request list (Mark, 2026-10-03)',
        action_payload: { notes, requested_fulfillment: 'phone_call', source: 'bot_callback' },
      }).select('id').single();
      if (error || data?.id == null) throw new Error(error?.message || 'insert returned no id');
      const { executeActionById } = await import('../actions/index.js');
      return executeActionById(data.id);
    },
    routeHandoff: (args) => routeNepqHandoff(args, nepqHandoffDeps({ applyTags, addNote })),
  };
}

/** The contact's market #service channel(s); #contact-center when no market resolves. */
export async function serviceChannelsFor(contactId) {
  const [{ resolveServiceMarketForContact }, { resolveSlackChannels }] = await Promise.all([
    import('../actions/service-card.js'), import('../slack.js'),
  ]);
  const market = await resolveServiceMarketForContact(contactId, null, null).catch(() => null);
  return resolveSlackChannels('service', { market: market || undefined });
}

/** Production deps for routeNepqHandoff (src/agentic/nepq-handoff.js), shared by both bots. */
export function nepqHandoffDeps({ applyTags, addNote }) {
  return {
    applyTags, addNote, emitEvent,
    post: (text, channelId) => import('../slack.js').then(({ postToSlack }) => postToSlack(text, channelId)),
    opsAlert: (text) => import('../alert-state.js').then(({ sendAlertMessage }) => sendAlertMessage(text, { channel: 'ops' })),
    serviceChannels: serviceChannelsFor,
  };
}
