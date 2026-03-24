// ─── GHL Custom Field Mapping — src/ghl-field-map.js ──────────────
//
// Maps LP Supabase fields → GHL custom field IDs.
// ALL FIELD IDS CONFIRMED via HL MCP cache — March 24, 2026
//
// v3 — March 24, 2026
// - Removed best_lead_sales_rep (duplicate of rep_name)
// - Removed promoter_legacy (duplicate of promoter_name)
// - Added lp_appointment_time (new GHL field iRuo2towFCpyKnnIUtLH)
// - DO NOT touch GHL-owned fields: Last Appointment Start Date/Time
// - Fixed appointment time timezone: LP stores local time, no conversion needed
//
// IMPORTANT: Only fields with a valid GHL field ID will be synced.
// Fields with null transform are skipped (set by entry workflows, not sync).
//
// CRITICAL: The sync engine must select ONLY the newest lead per GHL
// contact when a prospect has multiple leads. See ghl-field-sync.js.

const GHL_FIELD_MAP = {
  // ─── IDENTITY ───────────────────────────────────────────────────
  lp_prospect_id: {
    ghlFieldId: 'ZRQAVrzhtzApzLlHmT87',
    label: 'LP Prospect ID',
    transform: (lead) => lead.lp_prospect_id || null,
  },
  lp_lead_id: {
    ghlFieldId: 'yII9akTft1RKOG0Ri4Q9',
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
  // NOTE: best_lead_sales_rep REMOVED — was duplicate of rep_name
  // NOTE: promoter_legacy REMOVED — was duplicate of promoter_name
  rep_name: {
    ghlFieldId: 'ML9jAe1P5eq1uSwYTV3o',
    label: 'LP Rep Name',
    transform: (lead) => lead.rep_name || null,
  },
  promoter_name: {
    ghlFieldId: '5TqwYJPONzmWS1UIfM3A',
    label: 'LP Promoter Name',
    transform: (lead) => lead.promoter_name || null,
  },

  // ─── APPOINTMENT & DEMO ────────────────────────────────────────
  // NOTE: We write to LP-owned appointment fields ONLY.
  // DO NOT write to GHL-owned fields:
  //   - Last Appointment Start Date (x8KO5o89WPLfC7ivia3A)
  //   - Last Appointment Start Time (U67epWMNqjbf0SHAllEZ)
  // Those are managed by GHL workflows, not LP sync.
  appointment_date: {
    ghlFieldId: 'GL1rM4cnXBETsBkqxkZw',
    label: 'LP Appointment Date',
    transform: (lead) => {
      if (!lead.appointment_date) return null;
      // LP stores local time — Supabase treats it as UTC but it's actually local.
      // Extract date components directly from the UTC representation (which IS local).
      const d = new Date(lead.appointment_date);
      const month = d.getUTCMonth() + 1;
      const day = d.getUTCDate();
      const year = d.getUTCFullYear();
      return `${month}/${day}/${year}`;
    },
  },
  appointment_time: {
    ghlFieldId: 'iRuo2towFCpyKnnIUtLH',
    label: 'LP Appointment Time',
    transform: (lead) => {
      if (!lead.appointment_date) return null;
      // LP stores local time — Supabase has it as UTC but it's actually local.
      // DO NOT convert timezone — just extract hours/minutes from UTC representation.
      const d = new Date(lead.appointment_date);
      let hours = d.getUTCHours();
      const minutes = d.getUTCMinutes();
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12 || 12; // Convert 0 → 12 for 12 AM
      const minStr = minutes.toString().padStart(2, '0');
      return `${hours}:${minStr} ${ampm}`;
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
