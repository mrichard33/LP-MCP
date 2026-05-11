// ─── GHL Custom Field Decoder — src/ghl-field-decoder.js ──────────
//
// v1.0 (2026-05-01) — Reverse mapping (GHL field ID → human name) for
//   decoding raw GHL contact responses into readable form.
//
//   Used by get_decoded_contact tool. GHL returns custom fields as
//   arrays of { id: "<opaque>", value: "<value>" } with no labels.
//   This decoder turns each opaque ID into a human-readable name +
//   category so investigators don't have to keep a paper field map.
//
//   Sources reconciled:
//     - System prompt's curated field table (most authoritative for
//       fields actively used in routing)
//     - src/ghl-field-map.js (canonical for LP→GHL sync fields)
//     - reece-contact-intelligence skill field_decoder.md (broadest
//       coverage including AI / chatbot / canvassing / source fields)
//
//   Where these sources conflict, ghl-field-map.js wins for sync
//   fields and the system prompt wins for routing fields. Conflicts
//   are noted in the `notes` field of the entry.
//
//   When GHL field IDs change (e.g. field deleted + recreated), this
//   table needs updating. Suspected drift can be confirmed by opening
//   the field in GHL Settings → Custom Fields and comparing IDs.
//
// v1.1 (2026-05-11) — Adds 'nurture' category with the 11 fields used by
//   the outbound nurture message engine (src/nurture/*). IDs captured
//   from the GHL UI when Mark created the fields.
//
// v1.2 (2026-05-11) — Adds 12th nurture field: Nurture Enrollment Reason
//   (5MmqueQgbVELUl8CpaMR). Persists the inbound webhook's enrollment_reason
//   on the contact via a workflow step (not by the orchestrator).
//
// v1.3 (2026-05-11) — Cross-referenced HL MCP custom_fields cache and
//   corrected C8mSMxWqXGr1HvxrImyx display name: GHL actually named it
//   "AI Email Preview Draft" with field_key contact.ai_email_preview_draft.
//   This was previously labeled "AI Email Preheader Draft" in this decoder,
//   which never matched the actual GHL UI label or merge tag. The field
//   stores the short blurb that appears in inbox preview panes — same
//   thing email convention calls a preheader, but GHL calls preview.
//   Behavior unchanged (orchestrator writes by ID); only the display
//   label and the merge-tag string consumers should use are corrected.

const GHL_FIELD_DECODER = {

  // ─── IDENTITY / CROSS-SYSTEM IDS ────────────────────────────────
  'ZRQAVrzhtzApzLlHmT87': { name: 'LP Prospect ID',          category: 'identity', notes: 'Stable person-level LP ID. Use for cross-system lookups.' },
  'GmAVmW6V9sekD7pVONKr': { name: 'LP Lead ID',              category: 'identity', notes: 'Opportunity-level LP ID. May contain inbound queue ID until resolved.' },
  '3YMxheIlPyhACB8zyc3W': { name: 'LP Inbound Lead ID',      category: 'identity', notes: 'Returned by LP addlead — in1_id, NOT the real lds_id.' },
  'BbUJ6RrdTjjEqqRA8JVx': { name: 'Pro ID / LP Lead ID',     category: 'identity', notes: 'CONFLICT: ghl-field-map.js calls this "Pro ID"; intelligence skill calls it "LP Lead ID". Verify in GHL UI before relying on it.' },
  '69vctRrUluWZDZ605wgM': { name: 'LP Lead ID (alt)',        category: 'identity', notes: 'Possibly legacy/deprecated alias.' },
  '7Stmj4lgCuDPv6zmfWVU': { name: 'External UUID',           category: 'identity' },
  'yII9akTft1RKOG0Ri4Q9': { name: 'LP Last Appointment ID',  category: 'identity', notes: 'Per ghl-field-map.js v4.' },

  // ─── DISPOSITION / STATUS ───────────────────────────────────────
  'ZZCpHTthFMaVc3g5vMAS': { name: 'LP Lead Status',          category: 'status', notes: 'System-prompt label. May be the LP Disposition field.' },
  'URWTGtobi9a9Y7gwGxC8': { name: 'LP Disposition',          category: 'status', notes: 'Per ghl-field-map.js v4 (canonical for sync).' },
  'JZrfqPkpa8KyeEYTYGv1': { name: 'LP Disposition (alt)',    category: 'status', notes: 'Per intelligence skill field_decoder.md.' },
  'Ey7J495CZic1WYRSBO7c': { name: 'LP Disposition Label',    category: 'status' },
  '2lrRmCPQG6eXnfw7s91J': { name: 'P1 Current Stage',        category: 'status' },

  // ─── REP / OWNERSHIP ───────────────────────────────────────────
  'lPCvCXOQEQFXtuHekAq8': { name: 'Assigned Rep Name',       category: 'rep' },
  'ML9jAe1P5eq1uSwYTV3o': { name: 'LP Rep Name',             category: 'rep' },
  '5TqwYJPONzmWS1UIfM3A': { name: 'LP Promoter Name',        category: 'rep' },
  '7YkTgCb9IXsoQWDsP50E': { name: 'Assigned To (User ID)',   category: 'rep' },

  // ─── APPOINTMENT ────────────────────────────────────────────────
  'jHFRKGGsYJJFRbWwthkG': { name: 'Appointment Status',      category: 'appointment' },
  'GL1rM4cnXBETsBkqxkZw': { name: 'LP Appointment Date',     category: 'appointment' },
  'iRuo2towFCpyKnnIUtLH': { name: 'LP Appointment Time',     category: 'appointment' },
  'nWDA6dvUmLZQA02v7LNi': { name: 'LP Total Appointments',   category: 'appointment', notes: 'Also "Door Count (alt)" in skill — verify which.' },
  'sKFUjCKYgCdD0KQiQGo2': { name: 'Lead/Appointment Date',   category: 'appointment' },
  '7lpRWFDM8DZbLd3viHEG': { name: 'Preferred Estimate Time', category: 'appointment' },

  // ─── PROJECT SCOPE ──────────────────────────────────────────────
  'h9FJTUbmUHIuD6JKmpXv': { name: 'Window Count',            category: 'project' },
  'j7l1KWmDgoJqy7SINjQs': { name: 'Door Count',              category: 'project' },
  'YWhoVixgPtvEDzSXcMpJ': { name: 'Window Count (alt) / Gross Sale Amount', category: 'project', notes: 'CONFLICT: skill says Window Count alt; ghl-field-map.js says Gross Sale Amount. Verify.' },
  'L0mb4tIiSBYYLn5fyprZ': { name: 'Spouse/Partner Name',     category: 'project' },
  '3vQsf4lNxL0LrDpgHY9Q': { name: 'Language',                category: 'project' },
  'jv6c5Lie982duxVX5TNv': { name: 'Preferred Contact Method', category: 'project' },

  // ─── DEMO / SALE ────────────────────────────────────────────────
  'j84cNc7Rk6BkiYdZwuOO': { name: 'LP Demo Completed',       category: 'demo_sale' },
  'UiNAyILf7qq6fkgJFNxU': { name: 'Has Email / LP Ever Sat', category: 'demo_sale', notes: 'CONFLICT: skill says Has Email; ghl-field-map.js says LP Ever Sat. Verify.' },
  'kOm9Lj3JqVgMGvW9n10N': { name: 'LP Closed Won',           category: 'demo_sale' },
  'nncbjuo9GIzfaHeydDuh': { name: 'LP Ever Sold',            category: 'demo_sale' },
  'CuZs8wl5TdO8oGnbGq6q': { name: 'LP Job Value',            category: 'demo_sale' },

  // ─── LOSS / PIPELINE ────────────────────────────────────────────
  'I9CbRV0dKMfwaSlge9uU': { name: 'Loss Reason',             category: 'loss' },
  'b9gVHuya8iMnJxW4q6Um': { name: 'GHL-Attributed (opp)',    category: 'loss' },
  'm86JGp47yteVL0FV7MFW': { name: 'Lost Type (opp)',         category: 'loss' },

  // ─── SOURCE / ATTRIBUTION ──────────────────────────────────────
  'IvSDubMH0FmZmlCDy5C2': { name: 'LP Source',               category: 'source' },
  'o8h88WeFST8euBUq3Av6': { name: 'LP Subsource',            category: 'source' },
  'VJ8JhmawlFD7nL4RU1Qz': { name: 'Source Detail',           category: 'source' },
  'exgLkUOPIZgjAt13FY8e': { name: 'Source Display Name',     category: 'source' },
  'XEsW248cvpceYSCcOSlq': { name: 'Source Category',         category: 'source' },
  'lq7mqCLZRXOjsiwd79f8': { name: 'Source Subcategory',      category: 'source' },
  's5bn6zjp99xopAQ5XzfZ': { name: 'Source Widget',           category: 'source' },
  'SjkhgmZ1dQVYKr1islZu': { name: 'First Source Category',   category: 'source' },
  '7Vda0K4fV1pgv536QbnA': { name: 'First Source Subcategory', category: 'source' },
  'OG40TXRFB8pnHmRxKW0T': { name: 'First Source Detail',     category: 'source' },
  'VzT4gnmdqmoAblLugjEu': { name: 'First Source Widget',     category: 'source' },

  // ─── ENGAGEMENT / RECENCY ──────────────────────────────────────
  '6wVFsNmhO44BbAFycdQz': { name: 'LP Last Contact',         category: 'engagement' },
  'H88ytdcOjRbL26YR6YmM': { name: 'LP Call Count',           category: 'engagement' },
  'eAS3mkf8rdo3mMOP9k5f': { name: 'Lead Score',              category: 'engagement' },
  'ru2iZjqzvSEH4zl8iRs2': { name: 'Engagement Counter',      category: 'engagement' },

  // ─── AI-GENERATED INTELLIGENCE ─────────────────────────────────
  'Iv7r6m0LNCmCeDYt8U8L': { name: 'AI Contact Summary',      category: 'ai' },
  'dDFaBRpRn2aHVZTboUeB': { name: 'AI Short Summary',        category: 'ai' },
  'hveTpGaEGu37Rq4skTgx': { name: 'AI Contact Summary (alt)', category: 'ai', notes: 'Seen in live data 2026-05-01; may be a newer version of Iv7r6m0...' },
  'd813yiRjmSLjRzSKRB7a': { name: 'Emotional Arc',           category: 'ai' },
  'MP4kHjcOvwYvPSr2QmPi': { name: 'Last Sentiment',          category: 'ai' },
  'zrghbp0ZLrOyTWc9x6Ai': { name: 'Trust Level Score',       category: 'ai' },
  'yU8H6nzSs0A6RaGfvARI': { name: 'Pain Point',              category: 'ai' },
  'gWxwXv69jWTRg4RN3D91': { name: 'Pain Point Category',     category: 'ai' },
  'jhtIXVo1LuAL6SV7sCbd': { name: 'Decision Timeline',       category: 'ai' },
  'e3C4mkJNYfcbFEgPyHkB': { name: 'Booking Urgency',         category: 'ai' },
  'xFk3tq1TDUYaPXhd0WEl': { name: 'Objection Type',          category: 'ai' },
  'X2t7jeEnsJC6LQPCq4Ij': { name: 'Pain Driver',             category: 'ai', notes: 'Inferred from Jeanne live data — Insurance/Financial/Storm/etc.' },
  'NmvZHScugBDOD2elYH1g': { name: 'Summary Generated Date / LP Last Synced', category: 'ai' },

  // ─── NURTURE (S4.5 Outbound Message Engine) ────────────────────
  // 12 fields used by src/nurture/* — drafts, gates, metadata for the
  // outbound nurture pipeline. Populated 2026-05-11. All display names
  // and field_keys cross-checked against HL MCP custom_fields cache
  // (synced 14:00 ET 2026-05-11) except 5MmqueQgbVELUl8CpaMR which
  // was created after the sync.
  //
  // C8mSMxWqXGr1HvxrImyx (preview/preheader): GHL named this "AI Email
  // Preview Draft" with field_key contact.ai_email_preview_draft. Email
  // convention calls this the preheader; GHL calls it preview. Same
  // function, just different label. Anyone authoring a Send Email step
  // needs the merge tag {{contact.ai_email_preview_draft}} — the
  // {{contact.ai_email_preheader_draft}} form has never existed.
  //
  // PMq1AzXFX3nudZgNFxbw and kIOFapo85KNwpq95Qhl7 (the two gates) are
  // GHL RADIO fields with Yes/No options — not free-text. See
  // nurture-writeback.js v1.3 for the orchestrator-side fix.
  'hmmFUscWqxH1On6WPCP3': { name: 'AI Email Subject Draft',       category: 'nurture', notes: 'GHL key: contact.ai_email_subject_draft. Written by nurture orchestrator phase 1.' },
  'C8mSMxWqXGr1HvxrImyx': { name: 'AI Email Preview Draft',       category: 'nurture', notes: 'GHL key: contact.ai_email_preview_draft. Holds the short blurb that appears in inbox preview panes (preheader text by email convention).' },
  'WP3BnkdAsINf13CCYGbr': { name: 'AI Email Body Draft',          category: 'nurture', notes: 'GHL key: contact.ai_email_body_draft. HTML body. Phase 1 write.' },
  'xr0EkxRCshI6tlm4dpvO': { name: 'AI SMS Body Draft',            category: 'nurture', notes: 'GHL key: contact.ai_sms_body_draft. Phase 1 write when prompt emits SMS.' },
  '2KB3bkyJ92DGExsFiIIJ': { name: 'AI Msg Meta Json',             category: 'nurture', notes: 'GHL key: contact.ai_msg_meta_json. JSON: story_arc_used, formula_used, techniques_used, primary_belief_shift.' },
  'h6OyxuBTv7w7ieub1P9y': { name: 'AI Msg Next Wait Hours',       category: 'nurture', notes: 'GHL key: contact.ai_msg_next_wait_hours. Hours until next nurture cycle. v1 default 168 (7 days).' },
  'sxmZVqEc1KCgpauUbTAt': { name: 'AI Msg Generation ID',         category: 'nurture', notes: 'GHL key: contact.ai_msg_generation_id. Joins to agentic_messages.generation_id for audit.' },
  'vo7aZJT2J1ozVv3cux0T': { name: 'AI Msg Confidence',            category: 'nurture', notes: 'GHL key: contact.ai_msg_confidence. Pass B judge overall score, 0-1, 3 decimals.' },
  'PMq1AzXFX3nudZgNFxbw': { name: 'AI Msg Send Ready',            category: 'nurture', notes: 'GHL key: contact.ai_msg_send_ready. RADIO field — accepts "Yes"/"No" only. EMAIL GATE. GHL workflow waits on this; orchestrator flips to "Yes" on phase 2.' },
  'kIOFapo85KNwpq95Qhl7': { name: 'AI SMS Send Ready',            category: 'nurture', notes: 'GHL key: contact.ai_sms_send_ready. RADIO field — accepts "Yes"/"No" only. SMS GATE. Phase 2 — only set when SMS body emitted.' },
  'apoe5TFnilPriJmIzvbo': { name: 'AI Msg Sequence Position',     category: 'nurture', notes: 'GHL key: contact.ai_msg_sequence_position. Cycle counter 1-12 for S4.5 calendar. Written by GHL workflow Step 1 from webhook payload (sole owner — see nurture-writeback.js v1.2).' },
  '5MmqueQgbVELUl8CpaMR': { name: 'Nurture Enrollment Reason',    category: 'nurture', notes: 'GHL key: TBD — not yet in HL MCP cache. Likely contact.nurture_enrollment_reason based on display-name pattern. Why this contact was enrolled this cycle (engaged_no_book, rotation_continue, manual, re_engagement). Written by GHL workflow Step 1b from inbound webhook payload.' },

  // ─── CHATBOT-SPECIFIC ──────────────────────────────────────────
  'KsMdYWa9GmtLinA05jZW': { name: 'Chatbot Exit Point',      category: 'chatbot' },
  'RF710H9k39oLl9TsQIy4': { name: 'Chat Transcript',         category: 'chatbot' },
  'Kcrw1NNzk45vm4KWHqfH': { name: 'Handoff Notes',           category: 'chatbot' },
  'TwLcwbT7R4kldtIG6cwl': { name: 'Handoff Timestamp',       category: 'chatbot' },
  'uBH20Hs14SFFI2VSAFXw': { name: 'Handoff Reason',          category: 'chatbot' },
  'C0fujuMgIcvyxWKplPmD': { name: 'Call Timestamp',          category: 'chatbot' },

  // ─── DQ / GATE OUTCOMES ────────────────────────────────────────
  'JGGG47GLbo6bu7cnmPWm': { name: 'Loss Reason Category',    category: 'dq', notes: 'Inferred from Jeanne live data — "Price", "OutOfArea", etc.' },
  'SB3GnioJxR8OgRiqLmF3': { name: 'Booked Flag (boolean)',   category: 'dq', notes: 'Inferred from Jeanne — true/false flag.' },
  'z0MV6mXi0w9WwdCOFThh': { name: 'DQ Code',                 category: 'dq', notes: 'Inferred from Jeanne — OUT_OF_AREA, etc.' },

  // ─── CANVASSING ────────────────────────────────────────────────
  '57gPw256Sw4GsoPpANQr': { name: 'Canvasser Name',          category: 'canvassing' },
  'KcXVXLmMdwca7O4QJ5lZ': { name: 'Canvassing Notes',        category: 'canvassing' },

  // ─── MISC / NUMERIC REFS ───────────────────────────────────────
  'k6j4IBh5IejPooSCsj49': { name: 'LP Source ID / Numeric Ref', category: 'misc' },
};

/**
 * Decode a single GHL custom field { id, value } into a readable shape.
 * Returns { id, name, category, value, notes? } — `name` falls back to
 * "Unknown field" when the ID isn't in the table (which signals a new
 * or recently created field that hasn't been added to the decoder yet).
 */
export function decodeField(field) {
  const entry = GHL_FIELD_DECODER[field.id];
  if (!entry) {
    return {
      id: field.id,
      name: 'Unknown field',
      category: 'unknown',
      value: field.value,
      notes: 'Not in decoder table — may be a newly created field. Add to src/ghl-field-decoder.js.',
    };
  }
  return {
    id: field.id,
    name: entry.name,
    category: entry.category,
    value: field.value,
    ...(entry.notes ? { notes: entry.notes } : {}),
  };
}

/**
 * Decode a full customFields array into a grouped, readable structure:
 *   {
 *     identity:    [{ name, value, ... }, ...],
 *     status:      [...],
 *     appointment: [...],
 *     ai:          [...],
 *     nurture:     [...],
 *     unknown:     [...],
 *     ...
 *   }
 * Empty categories are omitted from the output.
 */
export function decodeFields(customFields) {
  if (!Array.isArray(customFields)) return {};
  const grouped = {};
  for (const field of customFields) {
    const decoded = decodeField(field);
    if (!grouped[decoded.category]) grouped[decoded.category] = [];
    grouped[decoded.category].push({
      name: decoded.name,
      value: decoded.value,
      id: decoded.id,
      ...(decoded.notes ? { notes: decoded.notes } : {}),
    });
  }
  return grouped;
}

/**
 * Look up a single field by human name. Useful when you have a known
 * field name and want its ID for a write operation.
 */
export function findFieldByName(name) {
  for (const [id, entry] of Object.entries(GHL_FIELD_DECODER)) {
    if (entry.name.toLowerCase() === name.toLowerCase()) {
      return { id, ...entry };
    }
  }
  return null;
}

export default GHL_FIELD_DECODER;
