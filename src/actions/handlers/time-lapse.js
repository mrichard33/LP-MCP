/**
 * Time-Lapse Handler — src/actions/handlers/time-lapse.js
 *
 * calculate_time_lapse_tier (v4.0): Read LP Last Contact field, compute
 * days since, bucket into warm/cool/cold tier, apply tag. Used by W5.2
 * Appointment Rescue to segment leads by freshness before picking the
 * right messaging cadence.
 *
 * Returns a _context object with calculated_tier and days_since_last_contact
 * which the executor injects into subsequent actions in the same batch
 * (so downstream send_message actions can template the tier label).
 *
 * Extracted from action-executor.js v4.2 refactor.
 */

import { ghlFetch } from '../helpers.js';
import { getGHLContact } from '../../ghl.js';

export async function executeCalculateTimeLapseTier(action) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};
  const { source_field_id, tier_thresholds, fallback_tag, fallback_strategy } = payload;

  if (!contactId) throw new Error('Missing contactId');
  if (!source_field_id) throw new Error('Missing source_field_id in payload');

  let fieldValue = null;
  const contact = await getGHLContact(contactId);
  if (contact?.customFields) {
    const field = contact.customFields.find(f => f.id === source_field_id);
    fieldValue = field?.value ?? null;
  }

  let daysSince = null;
  let tierTag = fallback_tag || 'time-lapse:cold';
  let dateMs = null;

  if (fieldValue) {
    if (typeof fieldValue === 'number' && fieldValue > 0) {
      dateMs = fieldValue;
    } else if (typeof fieldValue === 'string') {
      const parsed = new Date(fieldValue);
      if (!isNaN(parsed.getTime())) {
        dateMs = parsed.getTime();
      }
    }
  }

  if (!dateMs && fallback_strategy === 'contact_creation_date' && contact?.dateAdded) {
    const created = new Date(contact.dateAdded);
    if (!isNaN(created.getTime())) {
      dateMs = created.getTime();
      console.log(`[ActionExecutor] [TIER] Using contact creation date for ${contactId}: ${contact.dateAdded}`);
    }
  }

  if (dateMs) {
    daysSince = Math.floor((Date.now() - dateMs) / 86400000);
    if (daysSince < 0) daysSince = 0;

    if (tier_thresholds) {
      if (daysSince <= (tier_thresholds.warm?.max_days ?? 90)) {
        tierTag = tier_thresholds.warm?.tag || 'time-lapse:warm';
      } else if (daysSince <= (tier_thresholds.cool?.max_days ?? 365)) {
        tierTag = tier_thresholds.cool?.tag || 'time-lapse:cool';
      } else {
        tierTag = tier_thresholds.cold?.tag || 'time-lapse:cold';
      }
    }
  } else {
    console.log(`[ActionExecutor] [TIER] No valid date for ${contactId}, using fallback: ${tierTag}`);
  }

  await ghlFetch('POST', `/contacts/${contactId}/tags`, { tags: [tierTag] });
  console.log(`[ActionExecutor] [TIER] ${contactId}: ${daysSince ?? '?'} days → ${tierTag}`);

  return {
    action: 'time_lapse_tier_calculated',
    contact_id: contactId,
    tier: tierTag,
    days_since: daysSince,
    field_value: fieldValue,
    _context: {
      calculated_tier: tierTag.replace('time-lapse:', '').toUpperCase(),
      days_since_last_contact: daysSince !== null ? daysSince : 'unknown',
    },
  };
}
