/**
 * Nurture Writeback — src/nurture/nurture-writeback.js
 *
 * Two-phase write to GHL custom fields.
 *
 *   Phase 1: drafts + meta + wait window
 *   Phase 2: generation_id + confidence + gate (ai_msg_send_ready=true)
 *
 * The gate is the LAST field written so any reader of the GHL contact
 * sees either (a) nothing-new yet, (b) drafts but gate=false (do not
 * send), or (c) all fields including gate=true (safe to send). Partial
 * states between phase 1 and phase 2 leave the gate false, so the GHL
 * workflow's wait+exit logic catches it.
 *
 * Shadow-mode helper: writeDraftsOnly() performs phase 1 only and is
 * called from the orchestrator when NURTURE_SHADOW_MODE=true. The gate
 * stays unwritten so the GHL workflow never sends.
 *
 * v1.1 — 2026-05-11. FIELD_IDS configured with real values from the GHL
 *   UI. 10 net-new fields + 1 reused (ai_email_preheader_draft —
 *   C8mSMxWqXGr1HvxrImyx existed prior and is shared with other email
 *   workflows, so writes here will be visible there too). Mirror entries
 *   added to src/ghl-field-decoder.js under the new 'nurture' category.
 *
 * v1.2 — 2026-05-11. Single-writer ownership for ai_msg_sequence_position.
 *   Previously the writeback wrote this field in phase 1; the GHL workflow's
 *   Step 1 also writes it from the inbound webhook payload. Two writers
 *   for the same field invites stale-write races during retries and makes
 *   debugging ambiguous. Per architecture review, the workflow is now the
 *   sole owner: it writes the position from the canonical payload value
 *   immediately on entry, and the orchestrator reads only.
 *
 *   The function still ACCEPTS opts.sequence_position so the orchestrator
 *   doesn't need to change. The value is used for logging context and for
 *   the agentic_messages.sequence_position column write (handled in the
 *   orchestrator, not here). It just isn't written to the GHL contact field
 *   anymore.
 */

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_BASE = 'https://services.leadconnectorhq.com';

// FIELD IDS — populated 2026-05-11 from GHL UI.
// ai_email_preheader_draft (C8mSMxWqXGr1HvxrImyx) is a PRE-EXISTING field
// reused for nurture rather than created fresh. Writes here will be
// visible to any other workflow reading the same field — currently no
// known cross-readers, but worth knowing if behavior surfaces elsewhere.
//
// ai_msg_sequence_position is owned by the GHL workflow (Step 1 of the
// S4.5 v2 shell writes it from the inbound webhook payload). This module
// no longer writes it; the entry is kept here for reference only.
export const FIELD_IDS = {
  ai_email_subject_draft:    'hmmFUscWqxH1On6WPCP3',
  ai_email_preheader_draft:  'C8mSMxWqXGr1HvxrImyx', // pre-existing, reused
  ai_email_body_draft:       'WP3BnkdAsINf13CCYGbr',
  ai_sms_body_draft:         'xr0EkxRCshI6tlm4dpvO',
  ai_msg_meta_json:          '2KB3bkyJ92DGExsFiIIJ',
  ai_msg_next_wait_hours:    'h6OyxuBTv7w7ieub1P9y',
  ai_msg_generation_id:      'sxmZVqEc1KCgpauUbTAt',
  ai_msg_confidence:         'vo7aZJT2J1ozVv3cux0T',
  ai_msg_send_ready:         'PMq1AzXFX3nudZgNFxbw',
  ai_sms_send_ready:         'kIOFapo85KNwpq95Qhl7',
  ai_msg_sequence_position:  'apoe5TFnilPriJmIzvbo', // WORKFLOW-OWNED — not written here
};

function assertFieldIdsConfigured(usedKeys) {
  const missing = usedKeys.filter(k => !FIELD_IDS[k] || FIELD_IDS[k] === 'FILL_ME_IN');
  if (missing.length > 0) {
    throw new Error(`GHL FIELD_IDS not configured for: ${missing.join(', ')}`);
  }
}

async function ghlUpdate(contactId, customFields) {
  if (!GHL_API_KEY) {
    throw new Error('GHL_API_KEY not configured');
  }
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Version': '2021-07-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ customFields }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`GHL update failed ${res.status}: ${errText.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Decide the next-wait window in hours. v1 is a flat 7 days for cool/
 * cold leads. Future versions can lean on context.intelligence (emotional
 * state, lead score velocity) to shorten cadence for warmer leads.
 */
function calculateNextWaitHours() {
  return 168;
}

/**
 * Phase 1 fields: drafts + meta + wait window.
 *
 * ai_msg_sequence_position is intentionally NOT written here — the GHL
 * workflow owns that field. See v1.2 changelog at the top of this file.
 */
function buildPhase1Fields(output, nextWaitHours) {
  const fields = [];
  const usedKeys = [];

  if (output.subject) {
    fields.push({ id: FIELD_IDS.ai_email_subject_draft, field_value: String(output.subject) });
    usedKeys.push('ai_email_subject_draft');
  }
  if (output.preheader) {
    fields.push({ id: FIELD_IDS.ai_email_preheader_draft, field_value: String(output.preheader) });
    usedKeys.push('ai_email_preheader_draft');
  }
  if (output.body_html) {
    fields.push({ id: FIELD_IDS.ai_email_body_draft, field_value: String(output.body_html) });
    usedKeys.push('ai_email_body_draft');
  }
  if (output.sms_body) {
    fields.push({ id: FIELD_IDS.ai_sms_body_draft, field_value: String(output.sms_body) });
    usedKeys.push('ai_sms_body_draft');
  }

  fields.push({
    id: FIELD_IDS.ai_msg_meta_json,
    field_value: JSON.stringify({
      story_arc_used: output.story_arc_used || null,
      formula_used: output.formula_used || null,
      techniques_used: output.techniques_used || null,
      primary_belief_shift: output.primary_belief_shift || null,
    }),
  });
  usedKeys.push('ai_msg_meta_json');

  fields.push({ id: FIELD_IDS.ai_msg_next_wait_hours, field_value: String(nextWaitHours) });
  usedKeys.push('ai_msg_next_wait_hours');

  return { fields, usedKeys };
}

/**
 * Full two-phase writeback.
 *
 * @param {string} contactId
 * @param {object} output       — LLM-generated content
 * @param {string} generationId
 * @param {number} confidence   — overall score, 0-1
 * @param {object} [opts]       — { sequence_position } (accepted for
 *                                logging context but no longer written
 *                                to the GHL contact field — see v1.2)
 */
export async function writeBackToGHL(contactId, output, generationId, confidence, opts = {}) {
  const nextWaitHours = calculateNextWaitHours();
  const { fields: phase1Fields, usedKeys: phase1Keys } =
    buildPhase1Fields(output, nextWaitHours);

  assertFieldIdsConfigured(phase1Keys);
  await ghlUpdate(contactId, phase1Fields);

  const phase2Keys = ['ai_msg_generation_id', 'ai_msg_confidence', 'ai_msg_send_ready'];
  if (output.sms_body) phase2Keys.push('ai_sms_send_ready');
  assertFieldIdsConfigured(phase2Keys);

  const phase2Fields = [
    { id: FIELD_IDS.ai_msg_generation_id, field_value: String(generationId) },
    { id: FIELD_IDS.ai_msg_confidence, field_value: String(Number(confidence || 0).toFixed(3)) },
    { id: FIELD_IDS.ai_msg_send_ready, field_value: 'true' },
  ];
  if (output.sms_body) {
    phase2Fields.push({ id: FIELD_IDS.ai_sms_send_ready, field_value: 'true' });
  }

  await ghlUpdate(contactId, phase2Fields);

  const seqLog = opts.sequence_position !== undefined ? ` seq=${opts.sequence_position}` : '';
  console.log(`[NurtureWriteback] ok contact=${contactId} gen=${generationId}${seqLog} ` +
    `fields_written=${phase1Fields.length + phase2Fields.length}`);
}

/**
 * Shadow-mode variant. Writes phase 1 only (drafts + meta + wait).
 * Leaves ai_msg_send_ready unwritten so the GHL workflow never advances
 * to send. Mark approves each one manually before the gate is flipped.
 */
export async function writeDraftsOnly(contactId, output, generationId, confidence, opts = {}) {
  const nextWaitHours = calculateNextWaitHours();
  const { fields, usedKeys } = buildPhase1Fields(output, nextWaitHours);

  // Stash generation_id + confidence in phase-1 so reviewers can match
  // the GHL contact back to the agentic_messages row, but DO NOT flip
  // the gate.
  const auditKeys = ['ai_msg_generation_id', 'ai_msg_confidence'];
  assertFieldIdsConfigured([...usedKeys, ...auditKeys]);
  fields.push({ id: FIELD_IDS.ai_msg_generation_id, field_value: String(generationId) });
  fields.push({ id: FIELD_IDS.ai_msg_confidence, field_value: String(Number(confidence || 0).toFixed(3)) });

  await ghlUpdate(contactId, fields);

  const seqLog = opts.sequence_position !== undefined ? ` seq=${opts.sequence_position}` : '';
  console.log(`[NurtureWriteback] shadow contact=${contactId} gen=${generationId}${seqLog} fields_written=${fields.length} (gate NOT flipped)`);
}
