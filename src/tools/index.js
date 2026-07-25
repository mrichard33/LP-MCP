import { registerLeadTools } from './lead-tools.js';
import { registerPipelineTools } from './pipeline-tools.js';
import { registerSourceTools } from './source-tools.js';
import { registerJobTools } from './job-tools.js';
import { registerSyncTools } from './sync-tools.js';
import { registerTriggerTools } from './trigger-tools.js';
import { registerAgentTools } from './agent-tools.js';
import { registerIntelTools } from './intel-tools.js';
import { registerRescissionTools } from './rescission-tools.js';
import { registerLPAppointmentTools } from './lp-appointment-tools.js';
import { registerDriftTools } from './drift-tools.js';
import { registerCapacityTools } from './capacity-tools.js';
import { registerAdminTools } from './admin/index.js';
import { registerFive9Tools } from './five9-tools.js';

export function registerAllTools(server) {
  // LP data tools (16)
  registerLeadTools(server);
  registerPipelineTools(server);
  registerSourceTools(server);
  registerJobTools(server);
  registerSyncTools(server);
  registerTriggerTools(server);
  // Agentic system tools (10) — v6.0
  registerAgentTools(server);
  // Intelligence / diagnostic tools (3) — v6.1 (2026-05-01)
  //   check_service_area, get_decoded_contact, get_contact_timeline
  registerIntelTools(server);
  // Rescission rescue tools (3) — v6.6 (2026-05-06)
  //   compute_rescission_deadline, detect_signing_date, list_federal_holidays
  registerRescissionTools(server);
  // LP appointment write/verify tools (3) — v6.7 (2026-06-04)
  //   set_lp_appointment (confirm-gated), force_lp_lead_creation (confirm-gated),
  //   check_lp_inbound (read-only). Expose existing webhook-only LP appointment
  //   logic to the MCP so ops sweeps can act on un-synced appointments.
  registerLPAppointmentTools(server);
  // Drift detection tool (1) — backs the dashboard Issues-page "drift" tile.
  //   get_drift_candidates (read-only; GHL-closed but LP-active cross-reference)
  registerDriftTools(server);
  // Capacity diagnostics (1) — 2026-07-25
  //   get_capacity_vs_ghl (read-only; LP per-band rep availability vs GHL
  //   calendar bookings — the slot_id dimension /board/capacity sums away.
  //   UNKNOWN means the market has not filed availability yet, NOT zero
  //   capacity; those rows must never be used to gate a booking.)
  registerCapacityTools(server);
  // Infrastructure admin tools (17) — v5.1
  registerAdminTools(server);
  // Five9 admin READ tools (12) — v6.8 Phase A (2026-07-03) + Phase B (2026-07-21)
  //   campaigns/state/configs/profiles/lists/dispositions/skills/users/DNC/reports
  //   (all read-only Admin SOAP; writes execute only via the approve_action gate —
  //   see src/five9/admin-writes.js)
  registerFive9Tools(server);
}
