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
 * Field IDs MUST be provided by Mark after he creates them in the GHL
 * UI. Until then, this file uses 'FILL_ME_IN' placeholders that must
 * be replaced before deploy. ghl-field-decoder.js should also gain a
 * 'nurture' category for the new fields.
 *
 * Shadow-mode helper: writeDraftsOnly() performs phase 1 only and is
 * called from the orchestrator when NURTURE_SHADOW_MODE=true. The gate
 * stays unwritten so the GHL workflow never sends.
 */

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_BASE = 'https://services.leadconnectorhq.com';

// FIELD IDS — replace 'FILL_ME_IN' with the real IDs from the GHL UI
// before enabling this in production. The orchestrator will throw on
// the first phase-1 call if these are still placeholders.
export const FIELD_IDS = {
  ai_email_subject_draft:    'FILL_ME_IN',
  ai_email_preheader_draft:  'FILL_ME_IN',
  ai_email_body_draft:       'FILL_ME_IN',
  ai_sms_body_draft:         'FILL_ME_IN',
  ai_msg_meta_json:          'FILL_ME_IN',
  ai_msg_next_wait_hours:    'FILL_ME_IN',
  ai_msg_generation_id:      'FILL_ME_IN',
  ai_msg_confidence:         'FILL_ME_IN',
  ai_msg_send_ready:         'FILL_ME_IN',
  ai_sms_send_ready:         'FILL_ME_IN',
  ai_msg_sequence_position:  'FILL_ME_IN',
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

function buildPhase1Fields(output, nextWaitHours, sequencePosition) {
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

  if (sequencePosition !== undefined && sequencePosition !== null) {
    fields.push({ id: FIELD_IDS.ai_msg_sequence_position, field_value: String(sequencePosition) });
    usedKeys.push('ai_msg_sequence_position');
  }

  return { fields, usedKeys };
}

/**
 * Full two-phase writeback.
 *
 * @param {string} contactId
 * @param {object} output       — LLM-generated content
 * @param {string} generationId
 * @param {number} confidence   — overall score, 0-1
 * @param {object} [opts]       — { sequence_position }
 */
export async function writeBackToGHL(contactId, output, generationId, confidence, opts = {}) {
  const nextWaitHours = calculateNextWaitHours();
  const { fields: phase1Fields, usedKeys: phase1Keys } =
    buildPhase1Fields(output, nextWaitHours, opts.sequence_position);

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

  console.log(`[NurtureWriteback] ok contact=${contactId} gen=${generationId} ` +
    `fields_written=${phase1Fields.length + phase2Fields.length}`);
}

/**
 * Shadow-mode variant. Writes phase 1 only (drafts + meta + wait).
 * Leaves ai_msg_send_ready unwritten so the GHL workflow never advances
 * to send. Mark approves each one manually before the gate is flipped.
 */
export async function writeDraftsOnly(contactId, output, generationId, confidence, opts = {}) {
  const nextWaitHours = calculateNextWaitHours();
  const { fields, usedKeys } = buildPhase1Fields(output, nextWaitHours, opts.sequence_position);

  // Stash generation_id + confidence in phase-1 so reviewers can match
  // the GHL contact back to the agentic_messages row, but DO NOT flip
  // the gate.
  const auditKeys = ['ai_msg_generation_id', 'ai_msg_confidence'];
  assertFieldIdsConfigured([...usedKeys, ...auditKeys]);
  fields.push({ id: FIELD_IDS.ai_msg_generation_id, field_value: String(generationId) });
  fields.push({ id: FIELD_IDS.ai_msg_confidence, field_value: String(Number(confidence || 0).toFixed(3)) });

  await ghlUpdate(contactId, fields);

  console.log(`[NurtureWriteback] shadow contact=${contactId} gen=${generationId} fields_written=${fields.length} (gate NOT flipped)`);
}
