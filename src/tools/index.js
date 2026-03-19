import { registerLeadTools } from './lead-tools.js';
import { registerPipelineTools } from './pipeline-tools.js';
import { registerSourceTools } from './source-tools.js';
import { registerJobTools } from './job-tools.js';
import { registerSyncTools } from './sync-tools.js';
import { registerTriggerTools } from './trigger-tools.js';
import { registerAdminTools } from './admin/index.js';

export function registerAllTools(server) {
  // LP data tools (16)
  registerLeadTools(server);
  registerPipelineTools(server);
  registerSourceTools(server);
  registerJobTools(server);
  registerSyncTools(server);
  registerTriggerTools(server);
  // Infrastructure admin tools (17) — v5.1
  registerAdminTools(server);
}
