/**
 * guide-name-io — src/services/guide-name-io.js
 *
 * The I/O behind ensureGuideName (src/agentic/guide-name.js): read the GHL
 * contact's first name, write one (only ever called when none is on file),
 * and read the recent thread from our own records (inbound replies in
 * system_events, our sent bodies in agent_actions — GHL's thread lags).
 */

import supabase from '../supabase.js';
import { getGHLContact, updateGHLContactStandardFields } from '../ghl.js';

export const guideNameDeps = {
  async getContact(contactId) {
    const c = await getGHLContact(contactId);
    return c ? { firstName: c.firstName || c.first_name || null } : null;
  },
  async writeFirstName(contactId, name) {
    return (await updateGHLContactStandardFields(contactId, { firstName: name })) === true;
  },
  async readThread(contactId, { hours = 24 } = {}) {
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    const [{ data: ins }, { data: outs }] = await Promise.all([
      supabase.from('system_events').select('created_at, payload').eq('ghl_contact_id', contactId)
        .eq('event_type', 'ghl.reply_received').gte('created_at', since).order('created_at', { ascending: true }).limit(30),
      supabase.from('agent_actions').select('created_at, execution_result').eq('target_id', contactId)
        .eq('action_type', 'send_message').eq('status', 'completed').gte('created_at', since).order('created_at', { ascending: true }).limit(30),
    ]);
    const turns = [
      ...(ins || []).map(r => ({ at: r.created_at, direction: 'inbound', text: String(r.payload?.message_text || '') })),
      ...(outs || []).map(r => ({ at: r.created_at, direction: 'outbound', text: String(r.execution_result?.sent_body || '') })),
    ].filter(t => t.text);
    return turns.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  },
};
