/**
 * Nurture Writeback — src/nurture/nurture-writeback.js
 *
 * Two-phase write to GHL custom fields.
 *
 *   Phase 1: drafts + meta + wait window
 *   Phase 2: generation_id + confidence + gate (ai_msg_send_ready=Yes)
 *
 * The gate is the LAST field written so any reader of the GHL contact
 * sees either (a) nothing-new yet, (b) drafts but gate=No (do not send),
 * or (c) all fields including gate=Yes (safe to send). Partial states
 * between phase 1 and phase 2 leave the gate as-is (typically No from
 * the workflow's reset step), so the GHL workflow's wait+exit logic
 * catches it.
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
 *   GHL workflow Step 1 is now the sole owner; orchestrator reads only.
 *
 * v1.3 — 2026-05-11. Gate value format fixed. ai_msg_send_ready and
 *   ai_sms_send_ready are configured in GHL as single-select fields
 *   with options "Yes"/"No" (not text fields with "true"/"false").
 *   The GHL workflow's wait-for-condition step checks `== "Yes"` and
 *   the reset step writes "No". Previously this module wrote "true"/
 *   "false", which on a select-type field either fails silently or
 *   stores an invalid value — meaning the orchestrator's gate-flip
 *   never matched the workflow's wait condition, and live-mode sends
 *   would always time out at 24h into the stuck-alert path. Shadow
 *   mode masked this because the human approver writes the proper
 *   "Yes" value manually via GroupMe approval.
 *
 * v1.4 — 2026-05-12. P.S. SECTION SUPPORT. Add ai_email_ps_draft
 *   (vrAbErigvAzLCU9jj7kT) to FIELD_IDS and to phase-1 writes.
 *
 *   Per the S4.5 v2 workflow change today, the email step now branches
 *   on `{{contact.ai_email_ps_draft}}` having a value — Template A
 *   (with P.S. block) is used when populated, Template B (no P.S.)
 *   when empty. So this module ALWAYS writes the ps_draft field even
 *   when the LLM didn't emit one — writes an empty string in that
 *   case, which clears any stale draft from a previous cycle and
 *   triggers the workflow's "no-PS" branch. Without this active
 *   clear, a previous cycle's P.S. would persist into the next cycle's
 *   email and the "Has Value" check would route to Template A even
 *   when the new content lacks a P.S. — same class of stale-draft bug
 *   that the workflow's "Clear Previous Email Details" step exists
 *   to prevent.
 *
 * v1.5 — 2026-05-12. clearGhlDraftFields() helper. The GHL workflow's
 *   "Clear Past Email Fields" step (step 23 of f99fba97) was confirmed
 *   to silently no-op on long-text fields: actionType=clear_field_data
 *   with empty-string value doesn't actually clear AI Email Body Draft
 *   or AI Msg Meta Json. Result: after a successful send, the workflow
 *   advances to the next sequence position but the body/meta from the
 *   PREVIOUS cycle remain populated on the contact. If the next cycle's
 *   orchestrator call suppresses (failed_generation, suppressed_low_conf,
 *   etc.) and the gate then flips for any reason, the workflow's empty-
 *   body guard sees populated body → sends the STALE email a second time.
 *
 *   Verified failure mode 2026-05-12: Mark Test (y4dvOxtWW12xGrBavCUt)
 *   pos 4 email sent twice — once at 23:08:13 (intended) and again at
 *   ~23:14:52 (duplicate, with pos 5 attempted in between as failed_
 *   generation, leaving pos 4 content intact). The engagement endpoint
 *   correctly rejected the duplicate event_sent with applied=false
 *   reason=ghl_sent_at_already_set, but the GHL send had already fired.
 *
 *   Fix: orchestrator (and only orchestrator) owns clearing the GHL
 *   draft fields. Called on suppress paths to ensure stale content
 *   from any previous successful send is wiped before the workflow
 *   advances. Uses direct GHL API PATCH (PUT here, same shape as
 *   writeBackToGHL) which has been verified to actually clear long-
 *   text fields with empty-string values.
 *
 *   NOT called on awaiting_approval / soft_pass paths — those preserve
 *   the drafts for human review (design intent).
 *
 * v1.6 — 2026-06-04. DYNAMIC TIMING. calculateNextWaitHours() now reads
 *   the generator's `output.next_wait_hours` instead of returning a flat
 *   168. S1.1 v2 re-engagement prompt rows are the first to emit it; the
 *   value drives the GHL "Wait" step via ai_msg_next_wait_hours so the
 *   agentic layer can shorten cadence for warm contacts and lengthen it
 *   for cold ones. Backward compatible: prompts that don't emit the field
 *   (e.g. S4.5) still get 168. See the function doc-comment for the band
 *   and terminal-touch rules.
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
//
// ai_email_ps_draft (vrAbErigvAzLCU9jj7kT) added 2026-05-12 for the
// P.S. branching feature — see v1.4 changelog above.
export const FIELD_IDS = {
  ai_email_subject_draft:    'hmmFUscWqxH1On6WPCP3',
  ai_email_preheader_draft:  'C8mSMxWqXGr1HvxrImyx', // pre-existing, reused
  ai_email_body_draft:       'WP3BnkdAsINf13CCYGbr',
  ai_email_ps_draft:         'vrAbErigvAzLCU9jj7kT', // v1.4 PS branching
  ai_sms_body_draft:         'xr0EkxRCshI6tlm4dpvO',
  ai_msg_meta_json:          '2KB3bkyJ92DGExsFiIIJ',
  ai_msg_next_wait_hours:    'h6OyxuBTv7w7ieub1P9y',
  ai_msg_generation_id:      'sxmZVqEc1KCgpauUbTAt',
  ai_msg_confidence:         'vo7aZJT2J1ozVv3cux0T',
  ai_msg_send_ready:         'PMq1AzXFX3nudZgNFxbw', // Yes/No select
  ai_sms_send_ready:         'kIOFapo85KNwpq95Qhl7', // Yes/No select
  ai_msg_sequence_position:  'apoe5TFnilPriJmIzvbo', // WORKFLOW-OWNED — not written here
};

// Gate values must match GHL select-field option labels exactly.
// The S4.5 v2 workflow's wait-for-condition step checks `== "Yes"`
// and the reset step writes "No".
const GATE_FLIPPED = 'Yes';

// v1.5 — fields cleared by clearGhlDraftFields(). Kept as a named
// constant so the contract is auditable from one place.
//
// We DO NOT clear: ai_msg_send_ready, ai_sms_send_ready (gate fields
// are workflow-owned and the workflow has its own Reset Send Gate
// step), ai_msg_sequence_position (workflow-owned), ai_msg_next_wait_hours
// (cadence info that should persist), ai_sms_body_draft (we currently
// only nurture via email — leaving this populated is safe).
const CLEAR_FIELDS = [
  'ai_email_subject_draft',
  'ai_email_preheader_draft',
  'ai_email_body_draft',
  'ai_email_ps_draft',
  'ai_msg_meta_json',
  'ai_msg_generation_id',
];

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
 * Decide the next-wait window in hours.
 *
 * v1.6 — 2026-06-04. DYNAMIC TIMING. The message generator can now emit
 *   an integer `next_wait_hours` in its JSON output (S1.1 v2 prompt rows
 *   are the first to do so). When present, it drives the GHL "Wait" step
 *   via the ai_msg_next_wait_hours field instead of a flat constant.
 *
 *   Rules:
 *     - LLM omits it (e.g. S4.5 rows, which have no next_wait_hours in
 *       their output_schema)   -> DEFAULT_NEXT_WAIT_HOURS (168, the prior
 *                                 flat behavior — backward compatible).
 *     - LLM returns 0 or less   -> 0. Terminal touch (e.g. S1.1 T5); the
 *                                 workflow completes and never waits again.
 *     - LLM returns 1..23       -> clamped UP to MIN_NEXT_WAIT_HOURS (24h floor).
 *     - LLM returns >240        -> clamped DOWN to MAX_NEXT_WAIT_HOURS (240h ceiling).
 *     - Anything non-numeric    -> DEFAULT_NEXT_WAIT_HOURS.
 *
 *   The band protects against a bad generation setting an absurd cadence
 *   (2h spam or a multi-week wait). Baselines and the intended band live
 *   in the prompt rows; this function only enforces sanity + the terminal
 *   case so a malformed value can never escape into the workflow.
 *
 * @param {object} [output] — LLM-generated content; may carry next_wait_hours.
 */
const DEFAULT_NEXT_WAIT_HOURS = 168;
const MIN_NEXT_WAIT_HOURS = 24;
const MAX_NEXT_WAIT_HOURS = 240;

function calculateNextWaitHours(output = {}) {
  const n = Number(output && output.next_wait_hours);
  if (!Number.isFinite(n)) return DEFAULT_NEXT_WAIT_HOURS; // LLM didn't emit one
  if (n <= 0) return 0; // terminal touch — workflow completes, no further wait
  return Math.min(MAX_NEXT_WAIT_HOURS, Math.max(MIN_NEXT_WAIT_HOURS, Math.round(n)));
}

/**
 * Phase 1 fields: drafts + meta + wait window.
 *
 * ai_msg_sequence_position is intentionally NOT written here — the GHL
 * workflow owns that field. See v1.2 changelog at the top of this file.
 *
 * ai_email_ps_draft is ALWAYS written, even when empty. The S4.5 v2
 * workflow branches on it having a value; clearing it actively ensures
 * the workflow picks the right template on each cycle. See v1.4
 * changelog at the top of this file.
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

  // v1.4 — P.S. draft is always written. Empty string when the LLM
  // didn't emit a P.S., which both clears stale content and tells the
  // workflow to use Template B (no-PS variant).
  fields.push({
    id: FIELD_IDS.ai_email_ps_draft,
    field_value: output.ps_text ? String(output.ps_text) : '',
  });
  usedKeys.push('ai_email_ps_draft');

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
      has_ps: !!output.ps_text,
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
  const nextWaitHours = calculateNextWaitHours(output);
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
    { id: FIELD_IDS.ai_msg_send_ready, field_value: GATE_FLIPPED },
  ];
  if (output.sms_body) {
    phase2Fields.push({ id: FIELD_IDS.ai_sms_send_ready, field_value: GATE_FLIPPED });
  }

  await ghlUpdate(contactId, phase2Fields);

  const seqLog = opts.sequence_position !== undefined ? ` seq=${opts.sequence_position}` : '';
  const psLog = output.ps_text ? ' ps=yes' : ' ps=no';
  console.log(`[NurtureWriteback] ok contact=${contactId} gen=${generationId}${seqLog}${psLog} ` +
    `fields_written=${phase1Fields.length + phase2Fields.length} gate=${GATE_FLIPPED} next_wait_h=${nextWaitHours}`);
}

/**
 * Shadow-mode variant. Writes phase 1 only (drafts + meta + wait).
 * Leaves ai_msg_send_ready unwritten so the GHL workflow never advances
 * to send. Mark approves each one manually before the gate is flipped.
 */
export async function writeDraftsOnly(contactId, output, generationId, confidence, opts = {}) {
  const nextWaitHours = calculateNextWaitHours(output);
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
  const psLog = output.ps_text ? ' ps=yes' : ' ps=no';
  console.log(`[NurtureWriteback] shadow contact=${contactId} gen=${generationId}${seqLog}${psLog} fields_written=${fields.length} next_wait_h=${nextWaitHours} (gate NOT flipped)`);
}

/**
 * Clear the GHL draft fields on a contact. Used by the orchestrator on
 * suppress paths (suppressed_low_conf, suppressed_overlap, suppressed_
 * interrupt, failed_generation) to ensure that any stale draft content
 * from a previous successful send is wiped before the GHL workflow
 * advances to the next sequence position.
 *
 * Background: the GHL workflow's "Clear Past Email Fields" step
 * (step 23 of f99fba97) was confirmed to silently no-op on long-text
 * fields when actionType=clear_field_data is used with empty-string
 * values. Direct API PUT with empty strings DOES clear those fields —
 * verified live on Mark Test 2026-05-12. So we own the clear here.
 *
 * NOT called on awaiting_approval / soft_pass paths — those preserve
 * drafts for human review. NOT called on the success path either —
 * writeBackToGHL is overwriting all of these fields with fresh content
 * in that case anyway.
 *
 * Idempotent. Safe to call on a contact whose fields are already empty;
 * the GHL API will just record a no-op update.
 *
 * @param {string} contactId
 * @param {string} reason  — suppress reason, for log only
 */
export async function clearGhlDraftFields(contactId, reason = 'suppress') {
  if (!contactId) {
    throw new Error('clearGhlDraftFields: contactId required');
  }
  assertFieldIdsConfigured(CLEAR_FIELDS);

  // Confidence is a numeric field — clear by writing 0, which the
  // decoder treats as "no score yet."
  const fields = CLEAR_FIELDS.map(k => ({ id: FIELD_IDS[k], field_value: '' }));
  fields.push({ id: FIELD_IDS.ai_msg_confidence, field_value: 0 });

  try {
    await ghlUpdate(contactId, fields);
    console.log(`[NurtureWriteback] cleared drafts contact=${contactId} reason=${reason} fields=${fields.length}`);
  } catch (err) {
    // Never fail the parent orchestrator over a clear failure — log
    // and continue. The clear is defense-in-depth; absence of clear
    // doesn't break correctness, only re-exposes the stale-draft risk
    // on the next cycle.
    console.warn(`[NurtureWriteback] clear failed contact=${contactId} reason=${reason}: ${err.message}`);
  }
}

// Exported for tests.
export const _internal = {
  CLEAR_FIELDS,
  buildPhase1Fields,
  calculateNextWaitHours,
};
