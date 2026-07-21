import { z } from 'zod';
import {
  getCampaigns,
  getCampaignState,
  getOutboundCampaign,
  getInboundCampaign,
  getCampaignProfiles,
  getListsInfo,
  getDispositions,
  getSkills,
  getUsersGeneralInfo,
  checkDncForNumbers,
  runReportAndWait,
  isReportRunning,
  getReportResult,
} from '../five9-admin.js';

/**
 * Five9 admin READ tools — Phases A+B of programmatic Five9 control.
 *
 * Every tool here is read-only against the Five9 Configuration Web Services
 * (Admin SOAP) API. Write operations (campaign start/stop/reset, dialing
 * patches, list records, DNC) live in src/five9/admin-writes.js and execute
 * ONLY through create_agent_action + approve_action — never as direct MCP
 * tools (doctrine, see src/five9-admin.js header).
 *
 * Auth/setup requirements are documented in src/five9-admin.js.
 */

// Shared handler wrapper: JSON-stringified payloads, errors returned not thrown.
function asTool(fn) {
  return async (args = {}) => {
    try {
      const out = await fn(args);
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
    }
  };
}

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
    asTool(({ name_pattern, type, state }) => getCampaigns({ namePattern: name_pattern, type, state }))
  );

  // Tool: five9_get_campaign_state
  server.tool(
    'five9_get_campaign_state',
    'Live state of ONE Five9 campaign by exact name (read-only, Admin SOAP API). Returns { name, state } — e.g. is "DIAL ASAP" RUNNING right now. Prefer this over five9_get_campaigns when checking a single known campaign.',
    {
      campaign_name: z.string().describe('Exact campaign name (case-insensitive match on fallback path), e.g. "DIAL ASAP"'),
    },
    asTool(({ campaign_name }) => getCampaignState(campaign_name))
  );

  // Tool: five9_get_outbound_campaign
  server.tool(
    'five9_get_outbound_campaign',
    'Full config of ONE Five9 OUTBOUND campaign (read-only): dialing mode (PREDICTIVE/PROGRESSIVE/PREVIEW/POWER), dialing ratio, abandon % (maxDroppedCallsPercentage), max queue time in seconds, attached lists with priorities, plus the complete raw config object. Retry/attempt settings live in the campaign profile — see five9_get_campaign_profiles.',
    {
      campaign_name: z.string().describe('Exact outbound campaign name'),
    },
    asTool(({ campaign_name }) => getOutboundCampaign(campaign_name))
  );

  // Tool: five9_get_inbound_campaign
  server.tool(
    'five9_get_inbound_campaign',
    'Full config of ONE Five9 INBOUND campaign (read-only): state, mode, profile, max lines, plus the complete raw config object (IVR script params, DNIS, etc.).',
    {
      campaign_name: z.string().describe('Exact inbound campaign name, e.g. the Main Number campaign'),
    },
    asTool(({ campaign_name }) => getInboundCampaign(campaign_name))
  );

  // Tool: five9_get_campaign_profiles
  server.tool(
    'five9_get_campaign_profiles',
    'Five9 campaign profile inventory (read-only): per-profile dial settings — number of attempts (retries), dialing timeout, ANI, initial call priority, dialing schedule. This is where redial/retry behavior lives, not on the campaign itself.',
    {},
    asTool(() => getCampaignProfiles())
  );

  // Tool: five9_get_lists
  server.tool(
    'five9_get_lists',
    'Five9 dialing list inventory with record counts (read-only). Optional name_pattern substring filter.',
    {
      name_pattern: z.string().optional().describe('Case-insensitive substring filter on list name'),
    },
    asTool(async ({ name_pattern }) => {
      const out = await getListsInfo();
      if (!name_pattern) return out;
      const q = String(name_pattern).toLowerCase();
      const lists = out.lists.filter(l => (l.name || '').toLowerCase().includes(q));
      return { count: lists.length, lists };
    })
  );

  // Tool: five9_get_dispositions
  server.tool(
    'five9_get_dispositions',
    'Full Five9 disposition inventory (read-only): name, type, agent-must-confirm flags, redial/attempt-counter behavior (typeParameters).',
    {},
    asTool(() => getDispositions())
  );

  // Tool: five9_get_skills
  server.tool(
    'five9_get_skills',
    'Five9 skill inventory (read-only): id, name, description, voicemail routing.',
    {},
    asTool(() => getSkills())
  );

  // Tool: five9_get_users
  server.tool(
    'five9_get_users',
    'Five9 user inventory (read-only, general info): userName, full name, email, extension, active flag, profile. Password fields are stripped. Optional userNamePattern regex (Five9-side), default ".*" = everyone.',
    {
      pattern: z.string().optional().describe('Five9 userNamePattern regex, e.g. ".*@reecewindows.com"; default ".*"'),
    },
    asTool(({ pattern }) => getUsersGeneralInfo(pattern || '.*'))
  );

  // Tool: five9_check_dnc
  server.tool(
    'five9_check_dnc',
    'Check which of the given phone numbers are on the Five9 domain DNC list (read-only). Returns { checked, on_dnc, not_on_dnc }. Adding/removing DNC numbers is a gated write (create_agent_action), not a tool.',
    {
      numbers: z.array(z.string()).min(1).max(200).describe('Phone numbers to check (10-digit or as stored in Five9)'),
    },
    asTool(({ numbers }) => checkDncForNumbers(numbers))
  );

  // Tool: five9_run_report
  server.tool(
    'five9_run_report',
    'Run a saved Five9 report by folder + name (read-only) and wait for the result, polling up to ~55s. Returns { done:true, columns, rows } when finished, or { done:false, identifier } if still running — then call five9_get_report_result with that identifier to fetch it once ready. Optional start/end restrict the report time window.',
    {
      folder: z.string().describe('Report folder name, e.g. "Call Log Reports"'),
      report: z.string().describe('Saved report name inside the folder'),
      start: z.string().optional().describe('Window start, ISO datetime (e.g. 2026-07-01T00:00:00)'),
      end: z.string().optional().describe('Window end, ISO datetime'),
      max_wait_seconds: z.number().int().min(5).max(60).optional().describe('How long to poll before returning done:false (default 55)'),
    },
    asTool(({ folder, report, start, end, max_wait_seconds }) => runReportAndWait({
      folder,
      name: report,
      startIso: start,
      endIso: end,
      maxWaitMs: (max_wait_seconds ? max_wait_seconds * 1000 : undefined),
    }))
  );

  // Tool: five9_get_report_result
  server.tool(
    'five9_get_report_result',
    'Fetch the result of a previously started Five9 report run by identifier (read-only). Returns { done:false, identifier } if the run is still executing, else { done:true, columns, rows }.',
    {
      identifier: z.string().describe('Report run identifier returned by five9_run_report'),
    },
    asTool(async ({ identifier }) => {
      if (await isReportRunning(identifier)) {
        return { done: false, identifier };
      }
      const result = await getReportResult(identifier);
      return { done: true, ...result };
    })
  );
}
