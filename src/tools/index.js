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
import { registerMemoryTools } from './memory-tools.js';
import { registerSalesBoardTools } from './sales-board-tools.js';
import { withSanitizedResults } from '../text-sanitize.js';

export function registerAllTools(rawServer) {
  // 2026-09-16 — every tool's text output passes through the invisible-character
  // strip on the way out (src/text-sanitize.js). These tools return customer
  // -authored text: message bodies, contact names, notes. Unicode TAG characters
  // are invisible to every human who reviews them and fully visible to a model,
  // so anyone who can text the business could otherwise smuggle instructions
  // into an agent's context. Registration is the one choke point that covers all
  // 126 tools, including the ones added after this line.
  const server = withSanitizedResults(rawServer);
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
  // Five9 READ tools (19) — Phase A (2026-07-03) + Phase B (2026-07-21)
  //   + supervisor/config-history (Phase E) + Phase G config surface (2026-08-13)
  //   campaigns/state/configs/profiles/lists/dispositions/skills/users/DNC/reports,
  //   live supervisor telemetry, config history, and the config surface:
  //   IVR scripts / DNIS inventory + ownership map / prompts / domain config
  //   (all read-only; writes execute only via the approve_action gate —
  //   see src/five9/admin-writes.js)
  registerFive9Tools(server);
  // Project-memory tools (3) — priority #8 (2026-09-06)
  //   memory_context (session-start pack), memory_search (hybrid, gated by
  //   MEMORY_VECTOR_MODE), memory_checkpoint (confirm-gated write in the v4
  //   skill shape). claude_* tables only; never the customer request path.
  registerMemoryTools(server);
  // Sales-board hand-post tools (2) — 2026-09-26
  //   post_office_power_ranking, announce_missed_sale. Dry run by default.
  //   For a board or a sale that fell outside the automatic windows (the 9/25
  //   8 PM board lost to the switchover, lead 577880 outside the 48h lookback).
  registerSalesBoardTools(server);
}
