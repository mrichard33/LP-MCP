// ─── IME Enrichment Pipeline — src/ime/enrich-worker.js ──────────
//
// On STATUS_CHANGED → APPOINTMENT_PENDING (first APPT request from IME):
//   1. Fetch full WO from IME GET /WorkOrders/{id}
//   2. Find the GHL contact stub created by W-IME-IN
//   3. Update GHL contact custom fields (ime_enrichment_status='enriched', etc.)
//   4. Tag flip: add ime-enriched, remove ime-stub-pending-enrichment (v1.6)
//   5. POST to LP /api/Leads/AddLead, capture in1_id, write back to GHL
//   6. Persist Supabase ime_work_orders row with full state
//
// Failures at step 4 are partial successes — we still leave GHL enriched and
// mark the row 'failed' so the retry-cron can pick it up.

import supabase from '../supabase.js';
import { sendGroupMeMessage } from '../groupme.js';
import {
  getGHLContact,
  updateGHLContactFields,
  searchGHLContact,
  applyGHLTag,
  removeGHLTags,
} from '../ghl.js';
import { getWorkOrder } from './work-orders.js';
import { addLeadFromIME } from './lp-bridge.js';

const AFFILIATE_ID = parseInt(process.env.IME_AFFILIATE_ID || '17050371', 10);

// Custom field IDs (verified against existing src/context-builder.js + lp-appointment-sync.js).
// The IME-specific field IDs come from the GHL Settings → Custom Fields config and
// are documented in the integration spec §4. Mark to confirm before first prod run.
const FIELD_IDS = {
  ime_work_order_id:        'MP61oHvUnEOAmfenoIla',
  ime_affiliate_id:         null,   // TODO: confirm field ID after Step 4 fix in workflow
  ime_status:               '42MqYWZt1mdmf3GUbNMT',
  ime_status_changed_at:    'GBIL3LoUJhIGP5XYbu0l',
  ime_enrichment_status:    '74j0tw0cZ2qF9v91N6t8',
  ime_doc_last_signed_type: 'EjgkTdMnBDiwLfs1sVlE',
  ime_service_claim_status: 'oZkXDA6f7K1C7RPLlxk9',
  lp_inbound_lead_id:       '3YMxheIlPyhACB8zyc3W',
  lp_prospect_id:           'ZRQAVrzhtzApzLlHmT87',
  lp_lead_id:               'GmAVmW6V9sekD7pVONKr',
};

const stubEmailFor = (woId) => `ime-wo-${woId}@noreply.reecewindows.com`;

async function findGhlContactByWorkOrderId(woId) {
  // Stub created by W-IME-IN uses a deterministic email so we can find it back.
  // If GHL Search Contacts API supports custom-field lookup in the future,
  // prefer that over email match.
  const stub = stubEmailFor(woId);
  const contact = await searchGHLContact({ email: stub });
  if (contact) return contact;

  // Fall back to direct GET if the upstream stored the GHL contact ID in Supabase.
  const { data: row } = await supabase
    .from('ime_work_orders')
    .select('ghl_contact_id')
    .eq('ime_work_order_id', woId)
    .maybeSingle();
  if (row?.ghl_contact_id) {
    return await getGHLContact(row.ghl_contact_id);
  }
  return null;
}

async function markEnrichmentFailed(woId, reason) {
  await supabase.from('ime_work_orders').upsert(
    {
      ime_work_order_id: woId,
      ime_affiliate_id:  AFFILIATE_ID,
      ime_enrichment_status: 'failed',
      last_error: reason?.slice(0, 1000) || null,
    },
    { onConflict: 'ime_work_order_id' }
  );
}

export async function enrichWorkOrder(woId) {
  console.log(`[ime] [enrich] starting WO ${woId}`);

  // 1. Fetch full WO from IME
  let woData;
  try {
    woData = await getWorkOrder(woId);
  } catch (err) {
    console.error(`[ime] [enrich] IME GET failed for WO ${woId}: ${err.message}`);
    await markEnrichmentFailed(woId, `IME GET: ${err.message}`);
    throw err;
  }

  // 2. Find existing GHL contact (created by W-IME-IN stub)
  const contact = await findGhlContactByWorkOrderId(woId);
  if (!contact) {
    const msg = `GHL contact not found for WO ${woId} (W-IME-IN may have failed)`;
    console.error(`[ime] [enrich] ${msg}`);
    await markEnrichmentFailed(woId, msg);
    throw new Error(msg);
  }

  const customer = woData?.customer || {};
  const address  = woData?.jobAddress || customer.address || {};

  // 3. Update GHL contact custom fields with enrichment_status='enriched'.
  // Note: updateGHLContactFields PUTs only customFields (does NOT touch tags),
  // so it is safe to call without re-sending the contact's tag list.
  const enrichmentFields = [
    { id: FIELD_IDS.ime_enrichment_status, value: 'enriched' },
  ];
  if (woData?.status) {
    enrichmentFields.push({ id: FIELD_IDS.ime_status, value: woData.status });
  }
  await updateGHLContactFields(contact.id, enrichmentFields);
  console.log(`[ime] [enrich] GHL contact ${contact.id} marked enriched`);

  // 4. Tag flip — Railway owns this in v1.6 (was synchronous in W-IME-IN before).
  // Adds ime-enriched, removes ime-stub-pending-enrichment. Non-fatal: a failure
  // here doesn't block the LP addlead, since the GHL fields are already updated
  // and the retry cron will re-attempt the whole pipeline if anything else fails.
  try {
    await applyGHLTag(contact.id, 'ime-enriched');
    await removeGHLTags(contact.id, ['ime-stub-pending-enrichment']);
    console.log(`[ime] [enrich] tag flip complete for contact ${contact.id}`);
  } catch (err) {
    console.warn(`[ime] [enrich] tag flip failed for ${contact.id} (non-fatal): ${err.message}`);
  }

  // 5. POST to LP addlead
  let lpResponse = null;
  let lpInboundId = null;
  try {
    lpResponse = await addLeadFromIME(woData, woId);
    lpInboundId = lpResponse?.in1_id
      || lpResponse?.InboundLeadId
      || lpResponse?.id
      || null;
    console.log(`[ime] [enrich] LP addlead returned in1_id=${lpInboundId}`);

    if (lpInboundId) {
      await updateGHLContactFields(contact.id, [
        { id: FIELD_IDS.lp_inbound_lead_id, value: String(lpInboundId) },
      ]);
    }
  } catch (err) {
    console.error(`[ime] [enrich] LP addlead failed for WO ${woId}: ${err.message}`);
    await sendGroupMeMessage(`[ime] LP addlead failed for WO ${woId}\n${err.message}`);
    await markEnrichmentFailed(woId, `LP addlead: ${err.message}`);
    return { ghlContactId: contact.id, lpInboundLeadId: null, partial: true };
  }

  // 6. Persist Supabase row
  await supabase.from('ime_work_orders').upsert(
    {
      ime_work_order_id:    woId,
      ime_affiliate_id:     AFFILIATE_ID,
      ime_status:           woData?.status || null,
      partner_id:           woData?.partnerId ?? null,
      subcategory_id:       woData?.subcategoryId ?? null,
      business_model_id:    woData?.businessModelId ?? null,
      lp_inbound_lead_id:   lpInboundId ? String(lpInboundId) : null,
      ghl_contact_id:       contact.id,
      customer_payload:     customer,
      job_address:          address,
      ime_enrichment_status: 'enriched',
      last_outbound_at:     new Date().toISOString(),
      last_error:           null,
    },
    { onConflict: 'ime_work_order_id' }
  );

  console.log(`[ime] [enrich] WO ${woId} fully enriched`);
  return { ghlContactId: contact.id, lpInboundLeadId: lpInboundId, partial: false };
}
