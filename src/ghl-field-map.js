// ─── GHL Custom Field Mapping — src/ghl-field-map.js ──────────────
//
// Maps LP Supabase fields → GHL custom field IDs.
// ALL FIELD IDS CONFIRMED via HL MCP cache — March 24, 2026
//
// IMPORTANT: Only fields with a valid GHL field ID will be synced.
// Fields with null transform are skipped (set by entry workflows, not sync).

const GHL_FIELD_MAP = {
  // ─── IDENTITY ───────────────────────────────────────────────────
  lp_prospect_id: {
    ghlFieldId: 'ZRQAVrzhtzApzLlHmT87',
    label: 'LP Prospect ID',
    transform: (lead) => lead.lp_prospect_id || null,
  },
  lp_lead_id: {
    ghlFieldId: 'yII9akTft1RKOG0Ri4Q9', // Repurposing "LP Last Appointment ID" → LP Lead ID
    label: 'LP Last Appointment ID',
    transform: (lead) => lead.lp_lead_id || null,
  },

  // ─── DISPOSITION & STATUS ───────────────────────────────────────
  disposition_code: {
    ghlFieldId: 'URWTGtobi9a9Y7gwGxC8',
    label: 'LP Disposition',
    transform: (lead) => lead.disposition_code || null,
  },
  disposition_label: {
    ghlFieldId: 'Ey7J495CZic1WYRSBO7c',
    label: 'LP Disposition Label',
    transform: (lead) => lead.disposition_label || null,
  },

  // ─── REP & PROMOTER ────────────────────────────────────────────
  rep_name: {
    ghlFieldId: 'ML9jAe1P5eq1uSwYTV3o',
    label: 'LP Rep Name',
    transform: (lead) => lead.rep_name || null,
  },
  best_lead_sales_rep: {
    ghlFieldId: 'UuiuAOP3FNF92QIMghva',
    label: 'LP Best Lead Sales Rep',
    transform: (lead) => lead.rep_name || null, // Same source, different field for legacy compat
  },
  promoter_name: {
    ghlFieldId: '5TqwYJPONzmWS1UIfM3A',
    label: 'LP Promoter Name',
    transform: (lead) => lead.promoter_name || null,
  },
  promoter_legacy: {
    ghlFieldId: '57gPw256Sw4GsoPpANQr',
    label: 'Promoter',
    transform: (lead) => lead.promoter_name || null, // Legacy field, same data
  },

  // ─── APPOINTMENT & DEMO ────────────────────────────────────────
  appointment_date: {
    ghlFieldId: 'GL1rM4cnXBETsBkqxkZw',
    label: 'LP Appointment Date',
    transform: (lead) => {
      if (!lead.appointment_date) return null;
      return new Date(lead.appointment_date).toLocaleDateString('en-US');
    },
  },
  total_appointments: {
    ghlFieldId: 'nWDA6dvUmLZQA02v7LNi',
    label: 'LP Total Appointments',
    transform: (lead) => lead.appointment_set ? '1' : '0',
  },
  demo_completed: {
    ghlFieldId: 'j84cNc7Rk6BkiYdZwuOO',
    label: 'LP Demo Completed',
    transform: (lead) => lead.demo_completed ? 'Yes' : 'No',
  },
  ever_sat: {
    ghlFieldId: 'UiNAyILf7qq6fkgJFNxU',
    label: 'LP Ever Sat',
    transform: (lead) => lead.demo_completed ? 'Yes' : 'No',
  },

  // ─── SALE & VALUE ──────────────────────────────────────────────
  closed_won: {
    ghlFieldId: 'kOm9Lj3JqVgMGvW9n10N',
    label: 'LP Closed Won',
    transform: (lead) => lead.closed_won ? 'Yes' : 'No',
  },
  ever_sold: {
    ghlFieldId: 'nncbjuo9GIzfaHeydDuh',
    label: 'LP Ever Sold',
    transform: (lead) => lead.closed_won ? 'Yes' : 'No',
  },
  job_value: {
    ghlFieldId: 'CuZs8wl5TdO8oGnbGq6q',
    label: 'LP Job Value',
    transform: (lead) => {
      if (!lead.job_value) return null;
      return parseFloat(lead.job_value).toFixed(2);
    },
  },
  gross_sale_amount: {
    ghlFieldId: 'YWhoVixgPtvEDzSXcMpJ',
    label: 'LP Gross Sale Amount',
    transform: (lead) => {
      if (!lead.job_value) return null;
      return parseFloat(lead.job_value).toFixed(2);
    },
  },

  // ─── SOURCE ────────────────────────────────────────────────────
  lead_source: {
    ghlFieldId: 'IvSDubMH0FmZmlCDy5C2',
    label: 'LP Source',
    transform: (lead) => lead.lead_source || null,
  },
  lead_source_detail: {
    ghlFieldId: 'o8h88WeFST8euBUq3Av6',
    label: 'LP Subsource',
    transform: (lead) => lead.lead_source_detail || null,
  },

  // ─── ENGAGEMENT ────────────────────────────────────────────────
  call_count: {
    ghlFieldId: 'H88ytdcOjRbL26YR6YmM',
    label: 'LP Call Count',
    transform: (lead) => lead.call_count != null ? String(lead.call_count) : '0',
  },
  last_contact_date: {
    ghlFieldId: '6wVFsNmhO44BbAFycdQz',
    label: 'LP Last Contact Date',
    transform: (lead) => {
      if (!lead.last_contact_date) return null;
      return new Date(lead.last_contact_date).toLocaleDateString('en-US');
    },
  },

  // ─── SYNC METADATA ─────────────────────────────────────────────
  lp_last_synced: {
    ghlFieldId: 'NmvZHScugBDOD2elYH1g',
    label: 'LP Last Synced',
    transform: () => {
      const now = new Date();
      return now.toLocaleString('en-US', { timeZone: 'America/New_York' });
    },
  },

  // ─── SKIP DURING SYNC (set by GHL entry workflows) ─────────────
  lp_source_id: {
    ghlFieldId: 'k6j4IBh5IejPooSCsj49',
    label: 'LP Source ID',
    transform: null,
  },
  pro_id: {
    ghlFieldId: 'BbUJ6RrdTjjEqqRA8JVx',
    label: 'Pro ID',
    transform: null,
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
