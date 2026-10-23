/**
 * The rep's internal note on a Rehash Call, wired to the world —
 * src/services/rehash-call-note-io.js (Mark, 2026-10-23; Kim Turko review)
 *
 * Runs fire-and-forget after executeBookAppointment read the Rehash Call back.
 * Reads the SMS thread, the newest LP lead with a demo (rep on the visit, demo
 * date), the Siro visit summary when there is one, and the contact's tags; one
 * model call fills the facts; the note goes on the APPOINTMENT as a note
 * (POST /calendars/appointments/{id}/notes, API version 2021-04-15). If GHL
 * refuses that, it goes on the contact, named for the appointment. Never the
 * appointment description (the lead sees that). Never throws.
 *
 * REHASH_CALL_NOTES_MODE: live writes, shadow logs the note text only, off
 * does nothing (the caller does not even import this).
 */
import {
  buildRehashCallNote, NOTE_SYSTEM, notePrompt, readNoteFields, contactNoteFallback,
} from '../appointments/rehash-call-note.js';

const NOTES_API_VERSION = '2021-04-15';

async function defaults() {
  const [{ callLLMJson }, { ghlFetch }, { addGHLNote }, { fetchRecentMessages }, { getContactCached }, supabaseMod, siroRead, siroFacts] = await Promise.all([
    import('../llm-client.js'),
    import('../actions/helpers.js'),
    import('../ghl.js'),
    import('../agentic/reply-sender.js'),
    import('../actions/contact-cache.js'),
    import('../supabase.js'),
    import('../siro/context-read.js'),
    import('../siro/presentation-facts.js'),
  ]);
  const supabase = supabaseMod.default;
  return {
    callLLMJson,
    postAppointmentNote: (appointmentId, body) => ghlFetch('POST', `/calendars/appointments/${appointmentId}/notes`, { body }, { version: NOTES_API_VERSION }),
    addContactNote: (contactId, body) => addGHLNote(contactId, body, { dedupe: true }),
    readThread: async (contactId) => {
      const { messages } = await fetchRecentMessages(contactId);
      return (messages || [])
        .filter((m) => m && typeof m.body === 'string' && m.body.trim() && /^(inbound|outbound)$/i.test(String(m.direction || '')))
        .map((m) => ({ direction: String(m.direction).toLowerCase(), text: m.body, at: m.dateAdded || null }))
        .sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))
        .slice(-30);
    },
    getContact: (contactId) => getContactCached(contactId, null, { maxWaitMs: 2000 }),
    // The newest LP lead that had a demo: the rep on the visit and its date.
    readDemoLead: async (contactId) => {
      if (!supabase) return null;
      const { data, error } = await supabase.from('lp_leads')
        .select('lp_lead_id, lp_prospect_id, rep_name, demo_date, created_at_lp')
        .eq('ghl_contact_id', contactId).not('demo_date', 'is', null)
        .order('demo_date', { ascending: false }).limit(1);
      if (error) throw new Error(error.message);
      return data?.[0] || null;
    },
    readVisit: async ({ contactId, lead }) => {
      const rows = await siroRead.readSiroRows({ supabase, contactId, leadIds: lead?.lp_lead_id ? [lead.lp_lead_id] : [], prospectId: lead?.lp_prospect_id || null });
      return siroFacts.buildPresentationFacts(rows);
    },
  };
}

/**
 * @param {{ contactId: string, appointmentId: string, startTime: string, mode?: 'live'|'shadow' }} a
 * @returns {Promise<{ written: 'appointment_note'|'contact_note'|'shadow'|'none', note?: string, error?: string }>}
 */
export async function writeRehashCallNote({ contactId, appointmentId, startTime, mode = 'live' } = {}, deps = {}) {
  const d = { ...(await defaults()), ...deps };
  const log = d.log || console.log;
  const read = async (fn, fallback) => { try { return await fn(); } catch (err) { log(`[RehashCallNote] ${contactId}: a read failed (${String(err?.message || err).slice(0, 100)}) — left out`); return fallback; } };
  try {
    const [thread, contact, lead] = await Promise.all([
      read(() => d.readThread(contactId), []),
      read(() => d.getContact(contactId), null),
      read(() => d.readDemoLead(contactId), null),
    ]);
    const visit = await read(() => d.readVisit({ contactId, lead }), null);
    const contactName = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ') || null;
    let fields = {};
    try {
      const out = await d.callLLMJson({
        fn: 'rehash_call_note', system: NOTE_SYSTEM,
        user: notePrompt({ thread, contactName, tags: contact?.tags || [], visit }), maxTokens: 500,
      });
      fields = readNoteFields(out?.data);
    } catch (err) {
      log(`[RehashCallNote] ${contactId}: summary model failed (${String(err?.message || err).slice(0, 100)}) — the note keeps the lines code knows`);
    }
    const note = buildRehashCallNote({
      startTime, repOnVisit: lead?.rep_name || visit?.rep_name || null, demoDate: lead?.demo_date || null, fields,
    });
    if (mode === 'shadow') {
      log(`[RehashCallNote] shadow: ${contactId} appt ${appointmentId} — live would add the note:\n${note}`);
      return { written: 'shadow', note };
    }
    try {
      await d.postAppointmentNote(appointmentId, note);
      log(`[RehashCallNote] ✅ ${contactId}: internal note on appointment ${appointmentId} (${note.length} chars)`);
      return { written: 'appointment_note', note };
    } catch (err) {
      log(`[RehashCallNote] ${contactId}: appointment note refused (${String(err?.message || err).slice(0, 120)}) — adding it to the contact`);
      await d.addContactNote(contactId, contactNoteFallback(note, { appointmentId, startTime }));
      return { written: 'contact_note', note, error: String(err?.message || err).slice(0, 200) };
    }
  } catch (err) {
    log(`[RehashCallNote] ${contactId}: no note (${String(err?.message || err).slice(0, 120)})`);
    return { written: 'none', error: String(err?.message || err).slice(0, 200) };
  }
}
