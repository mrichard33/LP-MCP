// ─── Railway Admin MCP Tools (Tools 17–22) ───────────────────────
import { z } from 'zod';
import { railwayQuery, getServiceId } from '../../admin/railway-client.js';

// Helper to get project + environment IDs (required by several Railway queries)
const getProjectId = () => {
  const id = process.env.RAILWAY_PROJECT_ID;
  if (!id) throw new Error('RAILWAY_PROJECT_ID not configured');
  return id;
};

const getEnvironmentId = () => {
  const id = process.env.RAILWAY_ENVIRONMENT_ID;
  if (!id) throw new Error('RAILWAY_ENVIRONMENT_ID not configured');
  return id;
};

export function registerRailwayTools(server) {

  // Tool 17: get_railway_service_status [READ]
  server.tool(
    'get_railway_service_status',
    'Current Railway service status, uptime, and recent deployments.',
    {
      service_id: z.string().optional().describe('Railway service ID (defaults to RAILWAY_SERVICE_ID env var)'),
    },
    async ({ service_id }) => {
      const sid = service_id || getServiceId();
      const data = await railwayQuery(`
        query($serviceId: String!) {
          service(id: $serviceId) {
            name
            icon
            updatedAt
            deployments(first: 5) {
              edges {
                node {
                  id
                  status
                  createdAt
                }
              }
            }
          }
        }
      `, { serviceId: sid });

      // Railway returns service: null for an unknown service, or one the
      // RAILWAY_API_TOKEN cannot see. JSON.stringify(undefined) yields
      // undefined, which is not a valid MCP text block and surfaces as a
      // bare "Failed" with no message — so say what actually happened.
      if (!data?.service) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            error: 'service_not_found',
            service_id: sid,
            message: 'Railway returned no service for this ID. Check the service_id, or that RAILWAY_API_TOKEN is scoped to the project that owns it.',
          }, null, 2) }],
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(data.service, null, 2) }],
      };
    }
  );

  // Tool 18: get_railway_logs [READ]
  server.tool(
    'get_railway_logs',
    'Recent Railway deploy logs. Filter by keyword (e.g. "[Sync]", "error").',
    {
      lines: z.number().optional().describe('Number of log lines to return (default 100, max 500)'),
      filter: z.string().optional().describe('Optional keyword filter (e.g. "[Sync]", "error")'),
      deployment_id: z.string().optional().describe('Deployment ID (defaults to latest active)'),
    },
    async ({ lines, filter, deployment_id }) => {
      const limit = Math.min(lines || 100, 500);

      // If no deployment_id, get latest
      let deployId = deployment_id;
      if (!deployId) {
        const sid = getServiceId();
        const svc = await railwayQuery(`
          query($serviceId: String!) {
            service(id: $serviceId) {
              deployments(first: 1) {
                edges { node { id status } }
              }
            }
          }
        `, { serviceId: sid });
        deployId = svc?.service?.deployments?.edges?.[0]?.node?.id;
        if (!deployId) {
          return { content: [{ type: 'text', text: 'No deployments found.' }] };
        }
      }

      // Railway deploymentLogs query — uses deployment ID
      const data = await railwayQuery(`
        query($deploymentId: String!, $limit: Int) {
          deploymentLogs(deploymentId: $deploymentId, limit: $limit) {
            timestamp
            message
            severity
          }
        }
      `, { deploymentId: deployId, limit });

      let logs = data?.deploymentLogs || [];
      if (filter) {
        const f = filter.toLowerCase();
        logs = logs.filter(l => l.message?.toLowerCase().includes(f));
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({ deployment_id: deployId, count: logs.length, logs }, null, 2) }],
      };
    }
  );

  // Tool 19: get_railway_env_vars [READ]
  // SECURITY: Returns names and metadata only — NEVER actual values.
  server.tool(
    'get_railway_env_vars',
    'List Railway environment variable names and whether they are set. NEVER returns actual values.',
    {
      service_id: z.string().optional().describe('Railway service ID (defaults to RAILWAY_SERVICE_ID env var)'),
    },
    async ({ service_id }) => {
      const sid = service_id || getServiceId();
      const projectId = getProjectId();
      const environmentId = getEnvironmentId();

      // Railway's variables query returns a JSON object (key-value map), not an array
      const data = await railwayQuery(`
        query($projectId: String!, $environmentId: String!, $serviceId: String!) {
          variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
        }
      `, { projectId, environmentId, serviceId: sid });

      // data.variables is a JSON object like { KEY: "value", ... }
      const rawVars = data?.variables || {};
      const vars = Object.entries(rawVars).map(([name, value]) => ({
        name,
        is_set: value !== null && value !== undefined && value !== '',
        length: typeof value === 'string' ? value.length : 0,
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify(vars, null, 2) }],
      };
    }
  );

  // Tool 20: set_railway_env_var [WRITE]
  server.tool(
    'set_railway_env_var',
    'Create or update a Railway environment variable. Triggers auto-redeploy. Requires confirm: true.',
    {
      name: z.string().describe('Environment variable name'),
      value: z.string().describe('New value to set'),
      confirm: z.boolean().optional().describe('Must be true to execute. If false/missing, returns preview only.'),
    },
    async ({ name, value, confirm }) => {
      if (!name || value === undefined) {
        return { content: [{ type: 'text', text: 'Error: name and value are required.' }] };
      }

      if (confirm !== true) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            preview: true,
            action: 'set_env_var',
            name,
            value_length: value.length,
            warning: 'This will trigger an auto-redeploy. Set confirm: true to execute.',
          }, null, 2) }],
        };
      }

      const sid = getServiceId();
      const projectId = getProjectId();
      const environmentId = getEnvironmentId();

      await railwayQuery(`
        mutation($input: VariableUpsertInput!) {
          variableUpsert(input: $input)
        }
      `, {
        input: {
          projectId,
          environmentId,
          serviceId: sid,
          name,
          value,
        },
      });

      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, name, action: 'set', note: 'Auto-redeploy triggered.' }, null, 2) }],
      };
    }
  );

  // Tool 21: redeploy_railway_service [WRITE]
  server.tool(
    'redeploy_railway_service',
    'Trigger a redeployment from the latest commit. Requires confirm: true.',
    {
      confirm: z.boolean().optional().describe('Must be true to execute.'),
    },
    async ({ confirm }) => {
      if (confirm !== true) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            preview: true,
            action: 'redeploy',
            warning: 'This will redeploy the service from the latest commit. Set confirm: true to execute.',
          }, null, 2) }],
        };
      }

      const sid = getServiceId();
      const environmentId = getEnvironmentId();

      await railwayQuery(`
        mutation($serviceId: String!, $environmentId: String!) {
          serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
        }
      `, { serviceId: sid, environmentId });

      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, action: 'redeploy', service_id: sid }, null, 2) }],
      };
    }
  );

  // Tool 22: rollback_railway_deployment [WRITE]
  server.tool(
    'rollback_railway_deployment',
    'Roll back to a specified previous deployment. Requires confirm: true.',
    {
      deployment_id: z.string().describe('Target deployment ID to roll back to'),
      confirm: z.boolean().optional().describe('Must be true to execute.'),
    },
    async ({ deployment_id, confirm }) => {
      if (!deployment_id) {
        return { content: [{ type: 'text', text: 'Error: deployment_id is required.' }] };
      }

      if (confirm !== true) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            preview: true,
            action: 'rollback',
            target_deployment: deployment_id,
            warning: 'This will roll back to the specified deployment. Set confirm: true to execute.',
          }, null, 2) }],
        };
      }

      await railwayQuery(`
        mutation($deploymentId: String!) {
          deploymentRollback(id: $deploymentId)
        }
      `, { deploymentId: deployment_id });

      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, action: 'rollback', deployment_id }, null, 2) }],
      };
    }
  );
}
