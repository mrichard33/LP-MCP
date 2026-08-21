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
  // 2026-08-13 Phase G — config surface (IVR / DNIS / prompts / domain)
  getIVRScripts,
  getDNISList,
  getCampaignDNISList,
  getDnisMap,
  getPrompts,
  getVCCConfiguration,
} from '../five9-admin.js';
import { getUsersFullInfo, getUserProfiles, getUserProfile } from '../five9-users-info.js';
import supabase from '../supabase.js';
import {
  STATISTIC_TYPES,
  getStatistics,
  setSessionParameters,
  resetSession,
} from '../five9-supervisor.js';

/**
 * Five9 READ tools.
 *
 * Two APIs are wrapped here:
 *   - Admin SOAP (src/five9-admin.js) — configuration and saved reports.
 *   - Supervisor SOAP (src/five9-supervisor.js) — live real-time statistics.
 *
 * Every tool is read-only. Write operations (campaign start/stop/reset,
 * dialing patches, list records, DNC) live in src/five9/admin-writes.js and
 * execute ONLY through create_agent_action + approve_action behind
 * FIVE9_WRITES_ENABLED — never as direct MCP tools (doctrine, see the
 * src/five9-admin.js header).
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
    'Full config of ONE Five9 OUTBOUND campaign (read-only): dialing mode (PREDICTIVE/PROGRESSIVE/PREVIEW/POWER), dialing ratio, abandon % (maxDroppedCallsPercentage), max queue time in seconds, the agent distributionAlgorithm (RoundRobin ignores agent skill LEVEL entirely), attached lists with priorities, plus the complete raw config object. Retry/attempt settings live in the campaign profile — see five9_get_campaign_profiles.',
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
    'Five9 dialing list inventory with record counts (read-only). Optional name_pattern substring filter. Lists repopulate at 6 AM ET daily — any count reads differently either side of that boundary.',
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
    'Five9 skill inventory (read-only): id, name, description, voicemail routing. This is the domain-wide skill list — to see which USERS hold which skills, call five9_get_users with include_roles: true.',
    {},
    asTool(() => getSkills())
  );

  // Tool: five9_get_users
  server.tool(
    'five9_get_users',
    'Five9 user inventory (read-only). Default returns general info only: userName, full name, email, extension, active flag. Set include_roles: true to get the FULL user record instead — assigned roles (admin / agent / supervisor / reporting / crmManager), the per-role permission flags, assigned skills with levels, and agent groups. Use include_roles for any role, permission, or skill-routing audit, and to reconcile Five9 usernames against LP rep identities (LP stores setter/confirmer as denormalized "Last, First" text, so a Five9 login with no LP counterpart — or vice versa — is an attribution gap worth chasing). Password fields are stripped either way. Optional userNamePattern regex (Five9-side), default ".*" = everyone — narrow it when include_roles is on, the payload is much larger. NOTE: userProfileName is returned only when the user actually has a user profile assigned; Five9 omits the field entirely otherwise, so treat an absent field as "no profile", not as a read failure. Verified live 2026-08-21: two profiles are in use — "Level 1 Setter Profile" (5 users) and "Level 2 Setter Profile" (1 user) — with the remaining 47 users carrying none. This description previously asserted that NO user in the domain had a profile, which was true when written on 2026-07-30 and has since gone stale; that claim is what an earlier Phase H operation index was built on, so re-verify against a live call rather than trusting this line.',
    {
      pattern: z.string().optional().describe('Five9 userNamePattern regex, e.g. ".*@reecewindows.com"; default ".*"'),
      include_roles: z.boolean().optional().describe('Include roles, per-role permissions, skills, and agent groups (calls SOAP getUsersInfo instead of getUsersGeneralInfo). Default false.'),
    },
    asTool(({ pattern, include_roles }) => (include_roles
      ? getUsersFullInfo(pattern || '.*')
      : getUsersGeneralInfo(pattern || '.*')))
  );

  // Tool: five9_check_dnc
  server.tool(
    'five9_check_dnc',
    'Check which of the given phone numbers are on the Five9 domain DNC list (read-only). Returns { checked, on_dnc, not_on_dnc }. Caps at 200 numbers per call — batch larger sets and report the batch boundaries so a partial check is not mistaken for a full one. Adding/removing DNC numbers is a gated write (create_agent_action), not a tool.',
    {
      numbers: z.array(z.string()).min(1).max(200).describe('Phone numbers to check (10-digit or as stored in Five9)'),
    },
    asTool(({ numbers }) => checkDncForNumbers(numbers))
  );

  // Tool: five9_run_report
  server.tool(
    'five9_run_report',
    'Run a saved Five9 report by folder + name (read-only) and wait for the result, polling up to ~55s. Returns { done:true, columns, rows } when finished, or { done:false, identifier } if still running — then call five9_get_report_result with that identifier to fetch it once ready. Optional start/end restrict the report time window. For HISTORICAL reporting; for what the floor is doing right now use five9_supervisor_statistics.',
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

  /* ---- Phase G (2026-08-13): config surface ----------------------------- */

  // Tool: five9_get_ivr_scripts
  server.tool(
    'five9_get_ivr_scripts',
    'Five9 IVR script inventory (read-only). Returns name + description per script. name_pattern is a Five9-SIDE REGEX (default ".*" = every script), not a substring — anchor it (e.g. "^Canvass.*") to narrow. Set include_definition: true to also get the full xmlDefinition, which is REFUSED above 3 matching scripts because script XML is large; narrow name_pattern first. Note the API has no names-only mode — it always sends every matching definition — so a wide pattern is a large fetch even when definitions are stripped from the reply.',
    {
      name_pattern: z.string().optional().describe('Five9-side regex on script name, e.g. "^Canvass.*"; default ".*"'),
      include_definition: z.boolean().optional().describe('Include the full xmlDefinition per script. Refused above 3 matches. Default false.'),
      limit: z.number().int().min(1).max(200).optional().describe('Max scripts to return (default 20)'),
    },
    asTool(async ({ name_pattern, include_definition, limit }) => {
      const out = await getIVRScripts({
        namePattern: name_pattern || '.*',
        includeDefinition: Boolean(include_definition),
      });
      const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
      if (out.count <= cap) return out;
      return { ...out, returned: cap, truncated: true, scripts: out.scripts.slice(0, cap) };
    })
  );

  // Tool: five9_get_dnis_list
  server.tool(
    'five9_get_dnis_list',
    'Five9 DNIS (inbound phone number) inventory (read-only). Four modes: no arguments returns the ASSIGNED numbers only — it is NOT the full domain inventory, because Five9 treats selectUnassigned as a filter rather than an include-all flag, so the spares are missing from it and a number can look absent when it is merely unassigned; unassigned_only: true returns the spare numbers not attached to any campaign — this is how you find a free number for a new inbound line, and it is disjoint from the no-argument list, so union the two to see everything; campaign_name returns the DNIS assigned to that one campaign; map: true returns the full { number -> campaign } ownership map plus the unassigned list, which is what you need before reassigning any number. map walks every INBOUND campaign serially and is cached for the process lifetime — every reply carries fetched_at, and refresh: true re-reads it.',
    {
      unassigned_only: z.boolean().optional().describe('Return only DNIS not assigned to any campaign (the spares). Default false.'),
      campaign_name: z.string().optional().describe('Exact campaign name — return only that campaign\'s DNIS'),
      map: z.boolean().optional().describe('Return the full { dnis -> campaign } ownership map plus unassigned. Default false.'),
      refresh: z.boolean().optional().describe('map mode only: bypass the cached map and re-read from Five9'),
    },
    asTool(({ unassigned_only, campaign_name, map, refresh }) => {
      if (map) return getDnisMap({ refresh: Boolean(refresh) });
      if (campaign_name) return getCampaignDNISList(campaign_name);
      return getDNISList({ selectUnassigned: Boolean(unassigned_only) });
    })
  );

  // Tool: five9_get_prompts
  server.tool(
    'five9_get_prompts',
    'Five9 prompt inventory (read-only): name, description, type (TTSGenerated / PreRecorded), and languages. Use this to see what greeting/menu audio already exists before creating another. The Five9 API takes no filter here, so name_pattern is applied client-side as a case-insensitive substring over the full list.',
    {
      name_pattern: z.string().optional().describe('Case-insensitive substring filter on prompt name (applied client-side)'),
    },
    asTool(async ({ name_pattern }) => {
      const out = await getPrompts();
      if (!name_pattern) return out;
      const q = String(name_pattern).toLowerCase();
      const prompts = out.prompts.filter(p => (p.name || '').toLowerCase().includes(q));
      return { count: prompts.length, filtered_from: out.count, prompts };
    })
  );

  // Tool: five9_get_user_profiles
  server.tool(
    'five9_get_user_profiles',
    'Five9 user-profile inventory (read-only). A user profile is a named bundle of ROLES, skills and membership attached to many users at once — so a profile granting admin hands admin to every user carrying it. Omit profile_name (or pass empty) to list ALL profiles; pass it for an exact single lookup. Either way the response includes each profile\'s roles block — roles.assigned is the list of roles the profile grants, roles.permissions the per-role permission flags — so a role audit needs no second call. Also returns skills[] (which skills the profile\'s agents can be routed to) and users[] (which usernames carry it). Live as of 2026-08-21: two profiles exist — "Level 1 Setter Profile" (5 users) and "Level 2 Setter Profile" (1 user) — both granting agent only, no admin and no supervisor. To go the other direction (which profile does a given USER have), call five9_get_users, which returns userProfileName. Writes to profiles are gated action types, never this tool: five9_modify_user_profile_skills and five9_modify_user_profile_user_list are the narrow patches, five9_create_user_profile / five9_modify_user_profile the full-object writes.',
    {
      profile_name: z.string().optional().describe('Exact profile name for a single lookup, e.g. "Level 1 Setter Profile". Omit to list every profile.'),
    },
    asTool(async ({ profile_name }) => {
      const name = String(profile_name || '').trim();
      if (!name) {
        return { ...(await getUserProfiles()), lookup: 'all' };
      }
      const profile = await getUserProfile(name);
      return profile
        ? { count: 1, profiles: [profile], lookup: 'exact' }
        : { count: 0, profiles: [], lookup: 'exact', not_found: name };
    })
  );

  // Tool: five9_get_vcc_configuration
  server.tool(
    'five9_get_vcc_configuration',
    'Five9 domain-level configuration (read-only): domain id/name, recording / report / transcript servers, campaign settings (priority and ratio enabled, graceful agent state transition), misc VCC options, the state dialing rule, and timezone assignment. This is the domain-wide posture — per-campaign settings live in five9_get_outbound_campaign / five9_get_inbound_campaign. Read-only by design: modifyVCCConfiguration exists in the API but is deliberately not implemented. PASSWORDS ARE REDACTED: every server block reports its password as "[REDACTED]" when one is set, and as "" when none is — so you can still tell configured from unconfigured, but the credential itself never leaves Five9. hostName and userName are returned in full. Note that each server block appears twice, once at the top level and once under raw; both are redacted. Reece runs no Reports Server by design, which is why reportsServer reads as all-empty rather than as a defect.',
    {},
    asTool(() => getVCCConfiguration())
  );

  /* ---- Supervisor Web Services (live real-time telemetry) --------------- */

  // Tool: five9_supervisor_statistics
  server.tool(
    'five9_supervisor_statistics',
    'LIVE real-time Five9 floor telemetry via the Supervisor SOAP API (read-only) — this is "what is happening right now", as opposed to five9_run_report which is historical. statistic_type selects the view: AgentState (who is logged in, ready, on a call, in wrap-up), AgentStatistics (per-agent call counts and times for the session window), ACDStatus (live queue depth, calls waiting, longest wait per skill), CampaignState, OutboundCampaignStatistics / InboundCampaignStatistics (live dial and abandon behavior), AutodialCampaignStatistics, ListState. Returns columns + rows, plus a records array of column-keyed objects when the shapes align. The session is established and refreshed automatically. Set include_raw: true to see the unnormalized parse when a statistic type returns an unexpected shape.',
    {
      statistic_type: z.enum(STATISTIC_TYPES).describe('Which live statistics view to fetch'),
      include_raw: z.boolean().optional().describe('Also return the raw parsed SOAP block — use when columns/rows come back empty or oddly shaped'),
      rolling_period: z.enum(['Minutes5', 'Minutes10', 'Minutes15', 'Minutes30', 'Hour1', 'Today']).optional().describe('Rolling window for rate-style statistics. Default Minutes30.'),
      statistics_range: z.enum(['CurrentDay', 'CurrentWeek', 'CurrentMonth', 'RecentPeriod', 'Interval', 'Lifetime']).optional().describe('Aggregation range for cumulative statistics. Default CurrentDay.'),
    },
    asTool(({ statistic_type, include_raw, rolling_period, statistics_range }) => getStatistics(statistic_type, {
      includeRaw: Boolean(include_raw),
      session: (rolling_period || statistics_range)
        ? { rollingPeriod: rolling_period, statisticsRange: statistics_range }
        : undefined,
    }))
  );

  // Tool: five9_supervisor_session_reset
  server.tool(
    'five9_supervisor_session_reset',
    'Force a fresh Five9 Supervisor API session (read-only side effect — resets only our own API view window, never campaign or agent state). Use when supervisor statistics repeatedly fault, look frozen, or another process may be holding the session. Returns the applied view settings including the DST-aware ET timezone offset actually sent.',
    {
      rolling_period: z.enum(['Minutes5', 'Minutes10', 'Minutes15', 'Minutes30', 'Hour1', 'Today']).optional().describe('Rolling window. Default Minutes30.'),
      statistics_range: z.enum(['CurrentDay', 'CurrentWeek', 'CurrentMonth', 'RecentPeriod', 'Interval', 'Lifetime']).optional().describe('Aggregation range. Default CurrentDay.'),
    },
    asTool(({ rolling_period, statistics_range }) => resetSession({
      rollingPeriod: rolling_period,
      statisticsRange: statistics_range,
    }))
  );

  // Exported for callers that want to pre-warm the session explicitly.
  void setSessionParameters;

  // Tool: five9_config_history — 2026-08-06 Phase E
  server.tool(
    'five9_config_history',
    'HISTORICAL Five9 configuration record (read-only): daily snapshots of every campaign, campaign profile, list, skill, user and disposition, plus a field-level change log of what differed between days. This is the HISTORY, not live state — five9_get_campaign_profiles / five9_get_outbound_campaign / five9_get_campaigns remain the authority for what is configured right now. Use this to answer "when did this change" and "what did it look like last week", including changes made by a human in the Five9 admin UI, which leave no trace in the five9.admin_write audit events. Set changes_only:true for the change log instead of the snapshots.',
    {
      entity_type: z.string().optional().describe('Filter: campaign_outbound, campaign_inbound, campaign_profile, list, skill, user, disposition'),
      entity_name: z.string().optional().describe('Filter: exact entity name, e.g. "Data Leads"'),
      days: z.number().optional().describe('Lookback window in days (default 30)'),
      changes_only: z.boolean().optional().describe('Return five9_config_changes rows (what changed) instead of full snapshots'),
    },
    asTool(async ({ entity_type, entity_name, days, changes_only }) => {
      if (!supabase) throw new Error('Supabase not configured');
      const lookback = Number.isFinite(days) && days > 0 ? Math.floor(days) : 30;
      const since = new Date(Date.now() - lookback * 86400000);
      const table = changes_only ? 'five9_config_changes' : 'five9_config_snapshots';
      let q = supabase.from(table).select('*');
      if (entity_type) q = q.eq('entity_type', entity_type);
      if (entity_name) q = q.eq('entity_name', entity_name);
      q = changes_only
        ? q.gte('detected_at', since.toISOString()).order('detected_at', { ascending: false })
        : q.gte('snapshot_date', since.toISOString().slice(0, 10)).order('snapshot_date', { ascending: false });
      const { data, error } = await q.limit(500);
      if (error) throw new Error(error.message);
      return { source: table, lookback_days: lookback, count: (data || []).length, rows: data || [] };
    })
  );

}
