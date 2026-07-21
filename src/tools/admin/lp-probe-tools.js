// ─── LP API Probe Admin MCP Tool ─────────────────────────────────
// Read-only ad-hoc access to the Lead Perfection API surface. The LP API
// has namespaces we've never called (SalesApi chief among them) and every
// "can LP give us X?" question used to require a code change to answer.
// This tool makes it one MCP call.
//
// SAFETY MODEL: every LP endpoint is POST, so the HTTP verb carries no
// safety signal. We gate on the function name in the path instead —
// only /api/<Namespace>/Get*|List* passes, and anything containing a
// mutating verb is rejected belt-and-braces. /api/Leads/AddLead fails
// the allowlist; /api/SalesApi/GetSalesSchedule passes. That's the
// whole contract.
//
// SCHEMA NOTE: input schema uses ONLY primitive zod types (string /
// number / boolean), matching the other admin tools — z.record / z.union /
// z.array / z.enum break this MCP SDK's tools/list serialization (see
// http-tools.js). Object-shaped input (the request fields) is passed as a
// JSON string and parsed in the handler.

import { z } from 'zod';
import { lpPost, withCircuit } from '../../lp-client.js';
import supabase from '../../supabase.js';
import { assertProbeSafe, truncateRows } from './lp-probe-safety.js';

// Cap the serialized response so a huge LP payload can't blow up the MCP
// transport (same limit as http-tools.js).
const MAX_RESPONSE_CHARS = 100_000;

// Parse a JSON-object string param; throws a clear error on bad JSON.
function parseJsonObject(str, label) {
  if (str === undefined || str === null || str === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(str);
  } catch {
    throw new Error(`${label} must be a valid JSON object string. Received: ${String(str).slice(0, 80)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object (key/value map), not an array or scalar.`);
  }
  return parsed;
}

// Audit every probe — this tool is deliberately open-ended. Console always;
// system_events best-effort (a failed audit insert must never fail a probe).
async function logProbe({ path, fields, ok, ms, error }) {
  console.log(`[Probe] ${path} ok=${ok} ms=${ms}${error ? ` error=${error}` : ''}`);
  if (!supabase) return;
  try {
    await supabase.from('system_events').insert({
      event_type: 'lp.api_probe',
      source: 'lp_mcp',
      entity_type: 'lp_endpoint',
      entity_id: path,
      payload: { path, fields, ok, ms, error: error || null },
      priority: 'normal',
      event_timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('[Probe] Audit insert failed (probe unaffected):', e.message);
  }
}

function fail(message) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }] };
}

export function registerLpProbeTools(server) {
  // Tool: lp_api_probe [READ — mutating function names are rejected]
  server.tool(
    'lp_api_probe',
    'Read-only probe of the Lead Perfection API. POSTs form-urlencoded fields ' +
      'to any /api/<Namespace>/Get*|List* endpoint and returns the raw response. ' +
      'Mutating function names are rejected. Use to discover LP API capabilities.',
    {
      path: z.string().describe('e.g. "/api/SalesApi/GetSalesSchedule"'),
      fields_json: z
        .string()
        .optional()
        .describe('Request body fields as a JSON object string, e.g. {"type":"h"}.'),
      max_rows: z
        .number()
        .optional()
        .describe('Truncate array responses to this many rows (default 25).'),
      slow: z
        .boolean()
        .optional()
        .describe(
          'Default is fail-fast (single attempt, ~12s timeout). Set true for heavy ' +
            'queries that need the 120s budget (e.g. wide GetSalesSchedule ranges).'
        ),
    },
    async ({ path, fields_json, max_rows, slow }) => {
      const maxRows = max_rows ?? 25;
      let fields;
      try {
        assertProbeSafe(path);
        fields = parseJsonObject(fields_json, 'fields_json');
      } catch (e) {
        return fail(e.message);
      }

      const started = Date.now();
      let result;
      let error = null;
      try {
        result = await withCircuit(() => lpPost(path, fields, 1, { fast: slow !== true }));
      } catch (e) {
        error = e.message;
      }

      await logProbe({ path, fields, ok: !error, ms: Date.now() - started, error });

      if (error) return { content: [{ type: 'text', text: `LP error: ${error}` }] };

      let text = JSON.stringify(truncateRows(result, maxRows), null, 2);
      if (text.length > MAX_RESPONSE_CHARS) {
        text = text.slice(0, MAX_RESPONSE_CHARS) + '\n… (truncated at 100k chars — pass a smaller max_rows or narrower fields)';
      }
      return { content: [{ type: 'text', text }] };
    }
  );
}
