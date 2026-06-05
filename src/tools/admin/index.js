import { registerRailwayTools } from './railway-tools.js';
import { registerGitHubTools } from './github-tools.js';
import { registerSupabaseAdminTools } from './supabase-tools.js';
import { registerGhlTriggerLinkTools } from './ghl-trigger-link-tools.js';
import { registerHttpTools } from './http-tools.js';
import { registerHlFallbackTools } from './hl-fallback.js';

export function registerAdminTools(server) {
  registerRailwayTools(server);
  registerGitHubTools(server);
  registerSupabaseAdminTools(server);
  registerGhlTriggerLinkTools(server);
  registerHttpTools(server);
  // Reverse failover: read-only HL Supabase access (hl_query, hl_list_tables,
  // hl_get_table_schema, hl_get_workflows, hl_search_contacts). Active only
  // when HL_SUPABASE_URL + HL_SUPABASE_SERVICE_ROLE_KEY are set.
  registerHlFallbackTools(server);
}
