/**
 * lead-facts — src/agentic/lead-facts.js
 *
 * 2026-10-07 (Nicholas Ferraioli, GHL I5x7zltORikAxdEJ6nyD). The analyzer
 * read his cancel note; the reply writer, in the same thread, asked "Before
 * your visit, is there anything…" after the cancel and said "we serve
 * Clearwater (33756)" when the property on file is 33711. The two prompts
 * shared one context but the writer had no cancel reason, no LP property ZIP
 * (LP_LEAD_COLUMNS never selected it) and five truncated notes.
 *
 * One structured object both prompts render the same way (AI OS
 * CANON.FAIL.002, context drift): the appointment's real status, every LP
 * note newest first, the property on file, and whether a note says we
 * cannot run the lead. Pure and dependency-free.
 */

import { detectNoteDq, REQUIREMENT_SIGNALS } from './lp-note-dq.js';
import { isPostDemoLead } from './post-demo-lead.js';

const CANCEL_NOTE_RX = /\b(?:cxl|ccc|cancel+(?:ed|led|ing|ation)?)\b/i;
const NOTE_CHAR_BUDGET = 6000;

/**
 * @param {{lp?: object|null, lpLead?: object|null, lead?: object|null}} input
 *   lp      context.lp (effective appointment state, notes newest first)
 *   lpLead  the lp_leads row (address/city/zip)
 *   lead    context.lead (GHL address fields)
 */
export function buildLeadFacts({ lp = null, lpLead = null, lead = null } = {}) {
  const notes = (Array.isArray(lp?.notes) ? lp.notes : []).map(n => ({
    text: String(n?.text || '').trim(),
    by: n?.entered_by || '',
    date: n?.date || '',
  })).filter(n => n.text);

  let status = 'none';
  if (lp?.appointment_cancelled) status = 'cancelled';
  else if (lp?.appointment_set) status = 'set';
  const cancelNote = status === 'cancelled' ? (notes.find(n => CANCEL_NOTE_RX.test(n.text)) || null) : null;

  const lpZip = String(lpLead?.zip || '').trim().slice(0, 5);
  const property = lpZip
    ? { address: lpLead?.address || null, city: lpLead?.city || null, zip: lpZip, source: 'lp' }
    : (lead?.postal_code
      ? { address: lead?.address1 || null, city: lead?.city || null, zip: String(lead.postal_code).trim().slice(0, 5), source: 'ghl' }
      : null);

  // A lead past its demo already meets the requirements (the user,
  // 2026-10-13): a note that only says rental, commercial or below the minimum
  // is not a DQ for them. Out of area, a housing program and the rest still are.
  const pastDemo = isPostDemoLead({ lp, tags: lead?.current_tags || [], stageTag: lead?.current_stage_tag || null });
  const dq = detectNoteDq(notes, { skip: pastDemo ? REQUIREMENT_SIGNALS : [] });
  return {
    appointment: {
      status,
      date: status === 'cancelled' ? (lp?.last_appointment_date || null) : (lp?.appointment_date || null),
      lp_disposition: lp?.disposition || null,
      cancel_note: cancelNote ? cancelNote.text : null,
    },
    notes,
    property,
    note_dq: dq.dq ? { signal: dq.signal, text: dq.text } : null,
  };
}

/**
 * The LEAD FACTS prompt block (both the reply writer and the analyzer). Every
 * note in full, newest first, inside one character budget. Pure.
 */
export function renderLeadFacts(facts) {
  if (!facts) return [];
  const a = facts.appointment || {};
  const out = ['', '=== LEAD FACTS (verified from LP and GHL; these override anything else in this prompt) ==='];
  if (a.status === 'cancelled') {
    out.push(`Appointment: CANCELLED${a.date ? ` (was ${a.date})` : ''}${a.lp_disposition ? `, LP disposition ${a.lp_disposition}` : ''}. There is NO upcoming visit. Never mention "your visit" or "your appointment" as if it is still happening.`);
    if (a.cancel_note) out.push(`Cancel reason (LP note): ${a.cancel_note}`);
  } else if (a.status === 'set') {
    out.push(`Appointment: set${a.date ? ` for ${a.date}` : ''}${a.lp_disposition ? `, LP disposition ${a.lp_disposition}` : ''}.`);
  } else {
    out.push(`Appointment: none on file${a.lp_disposition ? ` (LP disposition ${a.lp_disposition})` : ''}.`);
  }
  if (facts.property?.zip) {
    const where = [facts.property.address, facts.property.city].filter(Boolean).join(', ');
    out.push(`Property on file (${facts.property.source.toUpperCase()}): ${where ? `${where} ` : ''}${facts.property.zip}. Use this ZIP for service-area answers; never name a different one.`);
  }
  if (facts.note_dq) {
    out.push(`A team note says we cannot run this lead (${facts.note_dq.signal}). Do NOT book, offer times or confirm anything. A team member will call them.`);
  }
  if (facts.notes?.length) {
    out.push('LP REP/SYSTEM NOTES, newest first, full text (read these carefully — they are ground truth):');
    let used = 0;
    for (const n of facts.notes) {
      const line = `- ${n.date ? `${String(n.date).slice(0, 16)} ` : ''}${n.by ? `[${n.by}] ` : ''}${n.text}`;
      if (used + line.length > NOTE_CHAR_BUDGET) break;
      used += line.length;
      out.push(line);
    }
  }
  return out;
}
