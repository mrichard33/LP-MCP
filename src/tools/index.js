import { registerLeadTools } from './lead-tools.js';
import { registerPipelineTools } from './pipeline-tools.js';
import { registerSourceTools } from './source-tools.js';
import { registerJobTools } from './job-tools.js';
import { registerSyncTools } from './sync-tools.js';
import { registerTriggerTools } from './trigger-tools.js';
import { registerAgentTools } from './agent-tools.js';
import { registerIntelTools } from './intel-tools.js';
import { registerAdminTools } from './admin/index.js';

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
  // Infrastructure admin tools (17) — v5.1
  registerAdminTools(server);
}
