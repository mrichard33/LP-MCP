/**
 * Custom-Field Handlers — src/actions/handlers/custom-fields.js
 *
 * update_custom_fields: PUT /contacts/{id} with customFields array.
 *
 * update_contact_email (v9.0 Email Enrichment): Set the CORE email field
 *   on a GHL contact from LP data. Pre-checks that GHL doesn't already
 *   have a better email (score >= 75) before overwriting. Logs every
 *   attempt to email_enrichment_log.
 *
 * Extracted from action-executor.js v4.2 refactor.
 */

import supabase from '../../supabase.js';
import { updateGHLContactFields, updateGHLContactEmail, getGHLContact, addGHLNote } from '../../ghl.js';
import { interpolatePayload } from '../helpers.js';

export async function executeUpdateCustomFields(action) {
  const contactId = action.target_id;
  const fields = action.action_payload?.fields;
  if (!contactId) throw new Error('Missing contactId');
  if (!fields || !Array.isArray(fields) || fields.length === 0) throw new Error('Missing or empty fields array');
  const result = await updateGHLContactFields(contactId, fields);
  if (result === 'not_found') throw new Error(`GHL contact ${contactId} not found (deleted?)`);
  if (!result) throw new Error('GHL custom field update failed');
  console.log(`[ActionExecutor] ✅ Custom fields updated for ${contactId}: ${fields.length} fields`);
  return { action: 'custom_fields_updated', contact_id: contactId, field_count: fields.length, fields: fields.map(f => f.id) };
}

export async function executeUpdateContactEmail(action, context) {
  const contactId = action.target_id;
  if (!contactId) throw new Error('Missing contactId');

  const payload = interpolatePayload(action.action_payload, context);
  const newEmail = payload.email || context.candidate_email;
  const confidence = Number(payload.confidence_score || context.confidence_score || 0);
  const scoringReasons = context.scoring_reasons || [];
  const sourceLeadId = payload.source_lead_id || context.source_lead_id || null;
  const lpProspectId = payload.lp_prospect_id || context.lp_prospect_id || null;

  if (!newEmail) throw new Error('Missing email in payload');

  let oldEmail = null;
  try {
    const ghlContact = await getGHLContact(contactId);
    if (ghlContact?.email) {
      oldEmail = ghlContact.email;
      const { scoreEmail } = await import('../../email-scorer.js');
      const currentScore = scoreEmail(ghlContact.email);
      if (currentScore.score >= 75) {
        console.log(`[ActionExecutor] Email enrichment skipped for ${contactId}: GHL already has good email "${ghlContact.email}" (score: ${currentScore.score})`);
        try {
          await supabase.from('email_enrichment_log').insert({
            ghl_contact_id: contactId,
            lp_prospect_id: lpProspectId,
            old_email: oldEmail,
            new_email: newEmail,
            confidence_score: confidence,
            scoring_reasons: scoringReasons,
            source_lead_id: sourceLeadId,
            action_taken: 'skipped_ghl_has_good_email',
          });
        } catch {}
        return {
          action: 'email_enrichment_skipped',
          contact_id: contactId,
          reason: 'ghl_has_good_email',
          existing_email: ghlContact.email,
          existing_score: currentScore.score,
        };
      }
    }
  } catch (err) {
    console.warn(`[ActionExecutor] GHL pre-check failed for ${contactId}: ${err.message} — proceeding with update`);
  }

  const result = await updateGHLContactEmail(contactId, newEmail);
  if (result === 'not_found') throw new Error(`GHL contact ${contactId} not found`);
  if (!result) throw new Error('GHL email update failed');

  await addGHLNote(contactId,
    `[EMAIL ENRICHMENT] Email updated from LP data\n` +
    `New: ${newEmail}\n` +
    `Confidence: ${confidence}/100\n` +
    `Source Lead: ${sourceLeadId || 'N/A'}\n` +
    `Reasons: ${scoringReasons.join(', ')}`
  ).catch(() => {});

  try {
    await supabase.from('email_enrichment_log').insert({
      ghl_contact_id: contactId,
      lp_prospect_id: lpProspectId,
      old_email: oldEmail,
      new_email: newEmail,
      confidence_score: confidence,
      scoring_reasons: scoringReasons,
      source_lead_id: sourceLeadId,
      action_taken: 'updated',
    });
  } catch (logErr) {
    console.warn(`[ActionExecutor] Email enrichment log failed: ${logErr.message}`);
  }

  console.log(`[ActionExecutor] ✅ Email enriched for ${contactId}: ${newEmail} (confidence: ${confidence})`);
  return {
    action: 'email_enriched',
    contact_id: contactId,
    new_email: newEmail,
    old_email: oldEmail,
    confidence_score: confidence,
  };
}
