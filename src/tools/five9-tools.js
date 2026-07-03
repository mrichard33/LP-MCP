import { z } from 'zod';
import { getCampaigns, getCampaignState } from '../five9-admin.js';

/**
 * Five9 admin READ tools — Phase A of programmatic Five9 control.
 *
 * Both tools are read-only against the Five9 Configuration Web Services
 * (Admin SOAP) API. No write tools exist yet; when campaign start/stop/
 * reset ship, they go through create_agent_action + approve_action, never
 * as direct MCP tools.
 *
 * Auth/setup requirements are documented in src/five9-admin.js.
 */
export function registerFive9Tools(server) {

  // Tool: five9_get_campaigns
  server.tool(
    'five9_get_campaigns',
    'Live Five9 campaign inventory via the Admin SOAP API (read-only). Returns every campaign with name, state (RUNNING/NOT_RUNNING), type (OUTBOUND/INBOUND), mode, and profile. Optional filters: name_pattern (substring), type, state. Use this to see what the dialer is actually running right now — e.g. "which outbound campaigns are stopped".',
    {
      name_pattern: z.string().optional().describe('Case-insensitive substring filter on campaign name (e.g. "rehash")'),
      type: z.enum(['OUTBOUND', 'INBOUND']).optional().describe('Filter by campaign type'),
      state: z.enum(['RUNNING', 'NOT_RUNNING']).optional().describe('Filter by live state'),
    },
    async ({ name_pattern, type, state } = {}) => {
      try {
        const out = await getCampaigns({ namePattern: name_pattern, type, state });
        return { content: [{ type: 'text', text: JSON.stringify(out) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
      }
    }
  );

  // Tool: five9_get_campaign_state
  server.tool(
    'five9_get_campaign_state',
    'Live state of ONE Five9 campaign by exact name (read-only, Admin SOAP API). Returns { name, state } — e.g. is "DIAL ASAP" RUNNING right now. Prefer this over five9_get_campaigns when checking a single known campaign.',
    {
      campaign_name: z.string().describe('Exact campaign name (case-insensitive match on fallback path), e.g. "DIAL ASAP"'),
    },
    async ({ campaign_name }) => {
      try {
        const out = await getCampaignState(campaign_name);
        return { content: [{ type: 'text', text: JSON.stringify(out) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
      }
    }
  );
}
