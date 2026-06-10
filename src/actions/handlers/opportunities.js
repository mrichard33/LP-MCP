/**
 * Opportunity Handlers — src/actions/handlers/opportunities.js
 *
 * move_opportunity (v3.0): Find opp by contact+pipeline, PUT pipelineStageId.
 *   Auto-creates opp if none exists. Forward-only guard (v4.0) prevents
 *   backward pipeline movement.
 *
 *   v4.3 (2026-05-06): allow_backward payload flag bypasses the guard for
 *   intentional backward moves (remediation, cold-cancellation rerouting).
 *
 * update_opportunity (v4.1): PUT monetaryValue, source, lostReasonId, status,
 *   name. Optionally also updates contact source and custom fields.
 *   Used for P2 value/source enrichment and loss intelligence.
 *
 * ROUTE-TO-P3 CONTRACT (2026-06-10): any rule or dispatch row whose
 * move_opportunity targets P3 as a LOSS outcome must, in the same action
 * batch, (a) set the "Intended Loss Reason" custom field
 * (I9CbRV0dKMfwaSlge9uU) to a valid picklist option and (b) add the
 * mark-p1-lost tag — the L.0 P1 Loss Marker workflow (248d42f0) triggers on
 * that tag and branches on the field to close the P1 opp lost. The contract
 * lives in config, not here: this handler must NOT auto-stamp it, because
 * legitimate non-loss P3 moves (Reactivation Queue, deferred monetization)
 * route through the same action_type.
 *
 * Extracted from action-executor.js v4.2 refactor.
 */

import { ghlFetch, isLPLeadId } from '../helpers.js';
import { PIPELINE_IDS, STAGE_MAP, GHL_LOCATION_ID } from '../constants.js';
import { checkForwardOnly } from '../../pipeline-guard.js';
import { updateGHLContactFields } from '../../ghl.js';

export async function executeMoveOpportunity(action) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};
  const { pipeline, stage, status } = payload;
  const allowBackward = payload.allow_backward === true;
  if (!contactId || !pipeline || !stage) throw new Error('Missing contactId, pipeline, or stage');
  const pipelineId = PIPELINE_IDS[pipeline];
  if (!pipelineId) throw new Error(`Unknown pipeline: ${pipeline}`);
  const stageId = STAGE_MAP[stage];
  if (!stageId) throw new Error(`Unknown stage: "${stage}" — fix the agent_rule`);

  const searchRes = await ghlFetch('GET', `/opportunities/search?location_id=${GHL_LOCATION_ID}&contact_id=${contactId}&pipeline_id=${pipelineId}`);
  const opps = searchRes?.opportunities || [];
  if (opps.length > 0) {
    // v4.0: Forward-only guard — prevent backward pipeline movement
    // v4.3: allow_backward: true in payload bypasses the guard for intentional
    //       backward moves (remediation, cold-cancellation rerouting, etc.)
    const guard = checkForwardOnly(opps[0].pipelineStageId, stageId);
    if (!guard.allowed && !allowBackward) {
      console.log(`[ActionExecutor] ⏭️ Forward-only: ${pipeline} opp at pos ${guard.currentPos}, target pos ${guard.targetPos} — ${guard.reason}`);
      return {
        action: 'skipped_forward_only',
        opportunity_id: opps[0].id,
        pipeline,
        current_position: guard.currentPos,
        target_position: guard.targetPos,
        target_stage: stage,
        reason: guard.reason,
      };
    }
    if (!guard.allowed && allowBackward) {
      console.log(`[ActionExecutor] ⚠️ Backward move ALLOWED via allow_backward: ${pipeline} opp at pos ${guard.currentPos}, target pos ${guard.targetPos} — ${guard.reason}`);
    }
    await ghlFetch('PUT', `/opportunities/${opps[0].id}`, { pipelineStageId: stageId, status: status || 'open' });
    return {
      action: 'updated',
      opportunity_id: opps[0].id,
      pipeline,
      stage,
      status,
      backward_override: !guard.allowed && allowBackward,
    };
  } else {
    const contactRes = await ghlFetch('GET', `/contacts/${contactId}`);
    const name = contactRes?.contact?.name || contactRes?.contact?.firstName || 'Unknown';
    const newOpp = await ghlFetch('POST', '/opportunities/', {
      pipelineId,
      pipelineStageId: stageId,
      locationId: GHL_LOCATION_ID,
      contactId,
      name,
      status: status || 'open',
    });
    return { action: 'created', opportunity_id: newOpp?.opportunity?.id, pipeline, stage, status };
  }
}

/**
 * v4.1: Update opportunity details that move_opportunity doesn't handle.
 * Supports: monetaryValue, source, lostReasonId, status, name.
 *
 * Payload options:
 *   opportunity_id         — direct opp ID (fastest, skips search)
 *   pipeline               — "P1"/"P2"/"P3" (used with contactId to find opp)
 *   monetaryValue          — numeric sale amount
 *   source                 — opportunity source string
 *   lostReasonId           — GHL native lost reason ID
 *   status                 — open/won/lost/abandoned
 *   contact_source         — if provided, also updates the GHL contact's source field
 *   contact_custom_fields  — [{id, field_value}] to update on the contact
 */
export async function executeUpdateOpportunity(action) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};

  let oppId = payload.opportunity_id;

  // If no direct opp ID, search by contact + pipeline
  if (!oppId) {
    const pipeline = payload.pipeline;
    if (!contactId || !pipeline) throw new Error('Missing opportunity_id or contactId+pipeline');
    const pipelineId = PIPELINE_IDS[pipeline];
    if (!pipelineId) throw new Error(`Unknown pipeline: ${pipeline}`);

    const searchRes = await ghlFetch('GET', `/opportunities/search?location_id=${GHL_LOCATION_ID}&contact_id=${contactId}&pipeline_id=${pipelineId}`);
    const opps = searchRes?.opportunities || [];
    if (opps.length === 0) throw new Error(`No ${pipeline} opportunity found for contact ${contactId}`);
    oppId = opps[0].id;
  }

  // Build the update body — only include fields that are provided
  const updateBody = {};
  if (payload.monetaryValue !== undefined && payload.monetaryValue !== null) {
    updateBody.monetaryValue = Number(payload.monetaryValue);
  }
  if (payload.source) updateBody.source = payload.source;
  if (payload.lostReasonId) updateBody.lostReasonId = payload.lostReasonId;
  if (payload.status) updateBody.status = payload.status;
  if (payload.name) updateBody.name = payload.name;

  if (Object.keys(updateBody).length === 0 && !payload.contact_source && !payload.contact_custom_fields) {
    return { action: 'skipped_no_fields', opportunity_id: oppId, contact_id: contactId };
  }

  // Update the opportunity
  if (Object.keys(updateBody).length > 0) {
    await ghlFetch('PUT', `/opportunities/${oppId}`, updateBody);
    console.log(`[ActionExecutor] ✅ update_opportunity: opp ${oppId} updated — ${Object.keys(updateBody).join(', ')}`);
  }

  // Optionally update contact source (core field, not custom field)
  if (payload.contact_source && contactId && !isLPLeadId(contactId)) {
    await ghlFetch('PUT', `/contacts/${contactId}`, { source: payload.contact_source });
    console.log(`[ActionExecutor] ✅ update_opportunity: contact ${contactId} source → "${payload.contact_source}"`);
  }

  // Optionally update contact custom fields (e.g., LP Gross Sale Amount)
  if (payload.contact_custom_fields && Array.isArray(payload.contact_custom_fields) && contactId && !isLPLeadId(contactId)) {
    await updateGHLContactFields(contactId, payload.contact_custom_fields);
    console.log(`[ActionExecutor] ✅ update_opportunity: contact ${contactId} custom fields updated — ${payload.contact_custom_fields.length} fields`);
  }

  return {
    action: 'opportunity_updated',
    opportunity_id: oppId,
    contact_id: contactId,
    fields_updated: Object.keys(updateBody),
    contact_source_updated: !!payload.contact_source,
    contact_custom_fields_updated: payload.contact_custom_fields?.length || 0,
  };
}
