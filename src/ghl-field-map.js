// ─── GHL Custom Field Mapping — src/ghl-field-map.js ──────────────
//
// Maps LP Supabase fields → GHL custom field IDs.
// Ryan: Replace each 'FILL_IN_GHL_FIELD_ID' with the actual GHL custom field ID.
//
// To find field IDs in GHL:
//   Settings → Custom Fields → Click the field → Copy the field key from the URL
//   or use the GHL API: GET /locations/{locationId}/customFields
//
// IMPORTANT: Only fields with a valid GHL field ID will be synced.
// Fields with 'FILL_IN_GHL_FIELD_ID' are skipped automatically.

const GHL_FIELD_MAP = {
  // ─── Fields that already exist in GHL ───────────────────────────
  lp_prospect_id: {
    ghlFieldId: 'ZRQAVrzhtzApzLlHmT87',
    label: 'LP Prospect ID',
    transform: (lead) => lead.lp_prospect_id || null,
  },
  lp_source_id: {
    ghlFieldId: 'k6j4IBh5IejPooSCsj49',
    label: 'LP Source ID',
    // This maps srs_id — already set by entry workflows, skip during sync
    transform: null,
  },
  pro_id: {
    ghlFieldId: 'BbUJ6RrdTjjEqqRA8JVx',
    label: 'Pro ID',
    // Already set by entry workflows, skip during sync
    transform: null,
  },

  // ─── New fields — FILL IN GHL FIELD IDS ─────────────────────────
  lp_lead_id: {
    ghlFieldId: 'FILL_IN_GHL_FIELD_ID',
    label: 'LP Lead ID',
    transform: (lead) => lead.lp_lead_id || null,
  },
  disposition_code: {
    ghlFieldId: 'FILL_IN_GHL_FIELD_ID',
    label: 'LP Disposition',
    transform: (lead) => lead.disposition_code || null,
  },
  disposition_label: {
    ghlFieldId: 'FILL_IN_GHL_FIELD_ID',
    label: 'LP Disposition Label',
    transform: (lead) => lead.disposition_label || null,
  },
  rep_name: {
    ghlFieldId: 'FILL_IN_GHL_FIELD_ID',
    label: 'LP Rep Name',
    transform: (lead) => lead.rep_name || null,
  },
  appointment_set: {
    ghlFieldId: 'FILL_IN_GHL_FIELD_ID',
    label: 'LP Appointment Set',
    transform: (lead) => lead.appointment_set ? 'Yes' : 'No',
  },
  appointment_date: {
    ghlFieldId: 'FILL_IN_GHL_FIELD_ID',
    label: 'LP Appointment Date',
    transform: (lead) => {
      if (!lead.appointment_date) return null;
      return new Date(lead.appointment_date).toLocaleDateString('en-US');
    },
  },
  demo_completed: {
    ghlFieldId: 'FILL_IN_GHL_FIELD_ID',
    label: 'LP Demo Completed',
    transform: (lead) => lead.demo_completed ? 'Yes' : 'No',
  },
  closed_won: {
    ghlFieldId: 'FILL_IN_GHL_FIELD_ID',
    label: 'LP Closed Won',
    transform: (lead) => lead.closed_won ? 'Yes' : 'No',
  },
  job_value: {
    ghlFieldId: 'FILL_IN_GHL_FIELD_ID',
    label: 'LP Job Value',
    transform: (lead) => {
      if (!lead.job_value) return null;
      return parseFloat(lead.job_value).toFixed(2);
    },
  },
  lead_source: {
    ghlFieldId: 'FILL_IN_GHL_FIELD_ID',
    label: 'LP Source',
    transform: (lead) => lead.lead_source || null,
  },
  lead_source_detail: {
    ghlFieldId: 'FILL_IN_GHL_FIELD_ID',
    label: 'LP Subsource',
    transform: (lead) => lead.lead_source_detail || null,
  },
  call_count: {
    ghlFieldId: 'FILL_IN_GHL_FIELD_ID',
    label: 'LP Call Count',
    transform: (lead) => lead.call_count != null ? String(lead.call_count) : '0',
  },
  last_contact_date: {
    ghlFieldId: 'FILL_IN_GHL_FIELD_ID',
    label: 'LP Last Contact Date',
    transform: (lead) => {
      if (!lead.last_contact_date) return null;
      return new Date(lead.last_contact_date).toLocaleDateString('en-US');
    },
  },
  promoter_name: {
    ghlFieldId: 'FILL_IN_GHL_FIELD_ID',
    label: 'LP Promoter Name',
    transform: (lead) => lead.promoter_name || null,
  },
};

// ─── Helper Functions ─────────────────────────────────────────────

const PLACEHOLDER = 'FILL_IN_GHL_FIELD_ID';

/**
 * Build the customFields array for a GHL contact update.
 * Only includes fields with valid (non-placeholder) GHL field IDs
 * and non-null transformed values.
 *
 * @param {Object} lead - Row from lp_leads table
 * @returns {Array} GHL customFields array: [{ id, field_value }, ...]
 */
export function buildGHLFieldPayload(lead) {
  const fields = [];
  for (const [key, config] of Object.entries(GHL_FIELD_MAP)) {
    // Skip fields without a GHL mapping or transform
    if (!config.ghlFieldId || config.ghlFieldId === PLACEHOLDER) continue;
    if (!config.transform) continue;

    const value = config.transform(lead);
    if (value === null || value === undefined) continue;

    fields.push({
      id: config.ghlFieldId,
      field_value: String(value),
    });
  }
  return fields;
}

/**
 * Compute a simple hash of the field payload for change detection.
 * Returns a string that changes when any field value changes.
 *
 * @param {Array} fields - Output of buildGHLFieldPayload()
 * @returns {string} Hash string for comparison
 */
export function computeFieldHash(fields) {
  if (!fields || fields.length === 0) return '';
  // Sort by field ID for consistent ordering, then join
  const sorted = [...fields].sort((a, b) => a.id.localeCompare(b.id));
  return sorted.map(f => `${f.id}=${f.field_value}`).join('|');
}

/**
 * Get count of configured (non-placeholder) fields.
 * Used for logging on startup.
 */
export function getConfiguredFieldCount() {
  let total = 0;
  let configured = 0;
  for (const [key, config] of Object.entries(GHL_FIELD_MAP)) {
    if (!config.transform) continue; // Skip null transforms
    total++;
    if (config.ghlFieldId && config.ghlFieldId !== PLACEHOLDER) configured++;
  }
  return { total, configured };
}

export default GHL_FIELD_MAP;
