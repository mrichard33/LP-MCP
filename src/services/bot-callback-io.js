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
    // 2026-10-16: a post-demo lead's call goes to the rehash team, through the
    // same routing the requeue's rehash branch uses (src/notifications/rehash-call.js).
    // Live only, like the requeue's branch (REHASH_ROUTING_MODE).
    routeRehash: async ({ contactId, inbound }) => {
      const { rehashRoutingMode } = await import('../agentic/rehash-state.js');
      if (rehashRoutingMode() !== 'live') return { rehash_card: 'none', reason: `rehash_routing_${rehashRoutingMode()}` };
      const [{ routeRehashReply }, who] = await Promise.all([
        import('../notifications/rehash-call.js'),
        resolveHandoffIdentityLive(contactId).catch(() => null),
      ]);
      const firstName = String(who?.name || '').trim().split(/\s+/)[0] || null;
      return routeRehashReply({ contactId, text: inbound, contact: { firstName, phone: who?.phone || null } });
    },
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

/**
 * The contact's market #canvass channel plus the canvass rollup (2026-10-03:
 * a do-not-knock card goes to the canvass team). Same market resolver as the
 * service card: it returns the market CODE, which slack_market_slugs is keyed on.
 */
export async function canvassChannelsFor(contactId) {
  const [{ resolveServiceMarketForContact }, { resolveSlackChannels }] = await Promise.all([
    import('../actions/service-card.js'), import('../slack.js'),
  ]);
  const market = await resolveServiceMarketForContact(contactId, null, null).catch(() => null);
  return resolveSlackChannels('canvass', { market: market || undefined });
}

/**
 * Who a hand-off card names (2026-10-16, Linda Darnell: "Contact: name not given
 * yet", no phone, no prospect). The same reads the GroupMe "AGENTIC MESSAGE SENT"
 * card uses: resolveContactInfo (GHL, then lp_leads) and the LP prospect from the
 * lp_leads row it already read, else resolveLPProspectId (the GHL field from the
 * snapshot; LP live only when a lead id is known but its prospect is not).
 * Capped so a slow read never holds the card; null on any failure.
 */
export const IDENTITY_LOOKUP_CAP_MS = 8000;
export async function resolveHandoffIdentityLive(contactId) {
  const read = (async () => {
    const { resolveContactInfo, resolveLPProspectId } = await import('../actions/resolvers.js');
    const info = await resolveContactInfo(contactId).catch(() => null);
    let prospectId = info?.lpLead?.lp_prospect_id ? String(info.lpLead.lp_prospect_id) : null;
    if (!prospectId) {
      const pid = await resolveLPProspectId(contactId, { ghlContact: info?.ghlContact || null }).catch(() => null);
      prospectId = /^\d+$/.test(String(pid || '').trim()) ? String(pid).trim() : null;
    }
    return { name: info?.name || null, phone: info?.phone || null, prospectId };
  })();
  let timer;
  const cap = new Promise((resolve) => { timer = setTimeout(() => resolve(null), IDENTITY_LOOKUP_CAP_MS); timer.unref?.(); });
  try { return await Promise.race([read, cap]); } finally { clearTimeout(timer); }
}

/** Production deps for routeNepqHandoff (src/agentic/nepq-handoff.js), shared by both bots. */
export function nepqHandoffDeps({ applyTags, addNote }) {
  return {
    applyTags, addNote, emitEvent,
    resolveIdentity: resolveHandoffIdentityLive,
    post: (text, channelId) => import('../slack.js').then(({ postToSlack }) => postToSlack(text, channelId)),
    opsAlert: (text) => import('../alert-state.js').then(({ sendAlertMessage }) => sendAlertMessage(text, { channel: 'ops' })),
    serviceChannels: serviceChannelsFor,
    canvassChannels: canvassChannelsFor,
    // One card per contact per reason per day (2026-10-07).
    filterNew: (args) => import('../alert-posted.js').then(({ filterNew }) => filterNew(args)),
    recordPosted: (args) => import('../alert-posted.js').then(({ recordPosted }) => recordPosted(args)),
  };
}
