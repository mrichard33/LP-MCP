// ─── GHL Custom Field Mapping — src/ghl-field-map.js ──────────────
//
// Maps LP Supabase fields → GHL custom field IDs.
// ALL FIELD IDS CONFIRMED via HL MCP cache — March 24, 2026
//
// v5 — May 12, 2026
// - FIX: Adds canonical "LP Lead ID" write (GmAVmW6V9sekD7pVONKr).
//   Previously the `lp_lead_id` entry routed solely to
//   yII9akTft1RKOG0Ri4Q9 ("LP Last Appointment ID"), leaving the
//   canonical LP Lead ID field GHL-side empty. That broke
//   lp-appointment-sync.js resolver Step 1, which reads the canonical
//   field — every booking fell through Steps 0/2/3/4 and frequently
//   triggered the `lp-sync-failed` tag → I.LP-FAIL workflow alerts.
//   See: I.LP-FAIL (cca1f069) firing email+SMS to dispatch/Edwin/Trudy/Jazmine.
// - Existing yII9akTft1RKOG0Ri4Q9 write preserved under
//   `lp_last_appointment_id` key — any downstream consumer of that
//   field keeps getting the same value it always did.
//
// v4 — March 24, 2026
// - Works with MERGED lead objects from ghl-field-sync.js v3
// - Status fields (rep, promoter, source) pass empty strings to CLEAR
//   stale GHL values when newest lead has null
// - "Ever" fields (demo, closed won) use aggregated data across ALL leads
// - Total appointments = COUNT of leads with appointment set (via _total_appointments)
// - Appointment date/time = from the lead with the MOST RECENT appointment
// - Job value = MAX across all leads
// - Appointment time uses UTC extraction (LP stores local time as UTC)
// - DO NOT touch GHL-owned fields: Last Appointment Start Date/Time

const GHL_FIELD_MAP = {
  // ─── IDENTITY ───────────────────────────────────────────────────
  lp_prospect_id: {
    ghlFieldId: 'ZRQAVrzhtzApzLlHmT87',
    label: 'LP Prospect ID',
    transform: (lead) => lead.lp_prospect_id || null,
  },
  // v5 FIX: Canonical "LP Lead ID" field per system prompt master
  // reference + ghl-field-decoder.js. This is what
  // lp-appointment-sync.js resolver Step 1 reads
  // (LP_LEAD_ID_FIELD = 'GmAVmW6V9sekD7pVONKr'). Without it populated,
  // the resolver falls through to lognumber-dependent steps and often
  // tags `lp-sync-failed`, firing the I.LP-FAIL handler workflow.
  lp_lead_id: {
    ghlFieldId: 'GmAVmW6V9sekD7pVONKr',
    label: 'LP Lead ID',
    transform: (lead) => lead.lp_lead_id || null,
  },
  // Separate GHL field "LP Last Appointment ID". Previously this slot
  // was (mistakenly) mapped under the `lp_lead_id` key. Kept here under
  // its own key so any existing consumer of yII9akTft1RKOG0Ri4Q9 still
  // receives the newest-lead ID. The value written is identical to
  // lp_lead_id above — both come from the newest LP lead per
  // buildMergedLead() in ghl-field-sync.js.
  lp_last_appointment_id: {
    ghlFieldId: 'yII9akTft1RKOG0Ri4Q9',
    label: 'LP Last Appointment ID',
    transform: (lead) => lead.lp_lead_id || null,
  },

  // ─── DISPOSITION & STATUS ───────────────────────────────────────
  // These come from the NEWEST lead. Empty string = clear the GHL value.
  disposition_code: {
    ghlFieldId: 'URWTGtobi9a9Y7gwGxC8',
    label: 'LP Disposition',
    transform: (lead) => lead.disposition_code ?? '',
  },
  disposition_label: {
    ghlFieldId: 'Ey7J495CZic1WYRSBO7c',
    label: 'LP Disposition Label',
    transform: (lead) => lead.disposition_label ?? '',
  },

  // ─── REP & PROMOTER ────────────────────────────────────────────
  // From NEWEST lead. Empty string clears stale GHL value if newest has null.
  rep_name: {
    ghlFieldId: 'ML9jAe1P5eq1uSwYTV3o',
    label: 'LP Rep Name',
    transform: (lead) => lead.rep_name ?? '',
  },
  promoter_name: {
    ghlFieldId: '5TqwYJPONzmWS1UIfM3A',
    label: 'LP Promoter Name',
    transform: (lead) => lead.promoter_name ?? '',
  },

  // ─── APPOINTMENT ───────────────────────────────────────────────
  // From the lead with the MOST RECENT appointment_date (not necessarily newest lead).
  // DO NOT write to GHL-owned fields:
  //   - Last Appointment Start Date (x8KO5o89WPLfC7ivia3A)
  //   - Last Appointment Start Time (U67epWMNqjbf0SHAllEZ)
  appointment_date: {
    ghlFieldId: 'GL1rM4cnXBETsBkqxkZw',
    label: 'LP Appointment Date',
    transform: (lead) => {
      if (!lead.appointment_date) return '';
      const d = new Date(lead.appointment_date);
      if (isNaN(d.getTime())) return '';
      // LP stores local time as UTC — extract directly
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
      if (!lead.appointment_date) return '';
      const d = new Date(lead.appointment_date);
      if (isNaN(d.getTime())) return '';
      // LP stores local time as UTC — extract directly, no timezone conversion
      let hours = d.getUTCHours();
      const minutes = d.getUTCMinutes();
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12 || 12;
      const minStr = minutes.toString().padStart(2, '0');
      return `${hours}:${minStr} ${ampm}`;
    },
  },
  total_appointments: {
    ghlFieldId: 'nWDA6dvUmLZQA02v7LNi',
    label: 'LP Total Appointments',
    // _total_appointments is set by buildMergedLead() = COUNT of leads with appt set
    transform: (lead) => String(lead._total_appointments ?? (lead.appointment_set ? 1 : 0)),
  },

  // ─── DEMO & SALE — AGGREGATED across ALL leads ─────────────────
  // "Ever" fields: true if ANY lead for this contact has the flag.
  // The merged lead object pre-computes these across all leads.
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

  // ─── VALUE — MAX across all leads ──────────────────────────────
  job_value: {
    ghlFieldId: 'CuZs8wl5TdO8oGnbGq6q',
    label: 'LP Job Value',
    transform: (lead) => {
      if (!lead.job_value) return '';
      return parseFloat(lead.job_value).toFixed(2);
    },
  },
  gross_sale_amount: {
    ghlFieldId: 'YWhoVixgPtvEDzSXcMpJ',
    label: 'LP Gross Sale Amount',
    transform: (lead) => {
      if (!lead.job_value) return '';
      return parseFloat(lead.job_value).toFixed(2);
    },
  },

  // ─── SOURCE — from NEWEST lead ─────────────────────────────────
  lead_source: {
    ghlFieldId: 'IvSDubMH0FmZmlCDy5C2',
    label: 'LP Source',
    transform: (lead) => lead.lead_source ?? '',
  },
  lead_source_detail: {
    ghlFieldId: 'o8h88WeFST8euBUq3Av6',
    label: 'LP Subsource',
    transform: (lead) => lead.lead_source_detail ?? '',
  },

  // ─── ENGAGEMENT — prospect-level, shared across leads ──────────
  call_count: {
    ghlFieldId: 'H88ytdcOjRbL26YR6YmM',
    label: 'LP Call Count',
    transform: (lead) => lead.call_count != null ? String(lead.call_count) : '0',
  },
  last_contact_date: {
    ghlFieldId: '6wVFsNmhO44BbAFycdQz',
    label: 'LP Last Contact Date',
    transform: (lead) => {
      if (!lead.last_contact_date) return '';
      const d = new Date(lead.last_contact_date);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleDateString('en-US');
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
 * Includes ALL fields with non-null values — empty strings ARE included
 * so that stale GHL values get cleared when the newest LP lead has null.
 *
 * @param {Object} lead - Merged lead object from buildMergedLead() or lp_leads row
 * @returns {Array} GHL customFields array: [{ id, field_value }, ...]
 */
export function buildGHLFieldPayload(lead) {
  const fields = [];
  for (const [key, config] of Object.entries(GHL_FIELD_MAP)) {
    if (!config.ghlFieldId || config.ghlFieldId === PLACEHOLDER) continue;
    if (!config.transform) continue;

    const value = config.transform(lead);
    // Skip null/undefined but KEEP empty strings (they clear GHL values)
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
 */
export function computeFieldHash(fields) {
  if (!fields || fields.length === 0) return '';
  const sorted = [...fields].sort((a, b) => a.id.localeCompare(b.id));
  return sorted.map(f => `${f.id}=${f.field_value}`).join('|');
}

/**
 * Get count of configured (non-placeholder) fields.
 */
export function getConfiguredFieldCount() {
  let total = 0;
  let configured = 0;
  for (const [key, config] of Object.entries(GHL_FIELD_MAP)) {
    if (!config.transform) continue;
    total++;
    if (config.ghlFieldId && config.ghlFieldId !== PLACEHOLDER) configured++;
  }
  return { total, configured };
}

export default GHL_FIELD_MAP;
