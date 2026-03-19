import { registerRailwayTools } from './railway-tools.js';
import { registerGitHubTools } from './github-tools.js';
import { registerSupabaseAdminTools } from './supabase-tools.js';

export function registerAdminTools(server) {
  registerRailwayTools(server);
  registerGitHubTools(server);
  registerSupabaseAdminTools(server);
}
