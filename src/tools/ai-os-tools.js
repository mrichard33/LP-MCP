import { z } from 'zod';
import aiOsSupabase from '../ai-os/client.js';

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const CANON_ID = /^CANON\.[A-Z]+\.\d{3}$/;

export async function callAiOsContext(args = {}, client = aiOsSupabase) {
  if (!client) {
    return {
      ok: false,
      code: 'AI_OS_NOT_CONFIGURED',
      message: 'AI OS is not configured for this server. Set AI_OS_SUPABASE_URL and AI_OS_SUPABASE_SERVICE_ROLE_KEY.',
      retryable: false,
    };
  }

  const ids = args.ids?.length ? args.ids : null;
  const query = args.query?.trim() || null;
  const objectTypes = args.object_types?.length ? args.object_types : null;
  const lifecycleStates = args.lifecycle_states?.length ? args.lifecycle_states : null;
  const limit = args.limit ?? 5;
  const includeFull = args.include_full === true;

  try {
    const res = await client.rpc('ai_os_context', {
      p_query: query,
      p_ids: ids,
      p_object_types: objectTypes,
      p_lifecycle_states: lifecycleStates,
      p_limit: limit,
      p_include_full: includeFull,
    });

    if (res.error) {
      return {
        ok: false,
        code: res.error.code || 'AI_OS_RPC_ERROR',
        message: res.error.message,
        details: res.error.details || null,
        retryable: false,
      };
    }

    return { ok: true, ...res.data };
  } catch (err) {
    return {
      ok: false,
      code: 'AI_OS_TRANSPORT_ERROR',
      message: err?.message || String(err),
      retryable: true,
    };
  }
}

export function registerAiOsTools(server) {
  server.tool(
    'ai_os_context',
    'Read-only engineering-knowledge gateway for the Reece AI Engineering OS. Use exact canonical IDs when known. Otherwise search by concept or filter by object type/lifecycle. Every result includes lifecycle and verification status so canonical candidates are never mistaken for approved policy. This tool does not approve, activate, enforce, deploy, or change runtime configuration.',
    {
      query: z.string().min(2).max(1000).optional().describe('Concept, exact term, protocol name, or ID fragment to discover relevant canonical guidance.'),
      ids: z.array(z.string().regex(CANON_ID)).min(1).max(20).optional().describe('Exact canonical IDs. When supplied, direct ID lookup takes precedence over search.'),
      object_types: z.array(z.string().regex(/^[A-Z]+$/)).min(1).max(20).optional().describe('Optional canonical type filters such as STD, K, RULE, SEC, SK, MCP.'),
      lifecycle_states: z.array(z.enum(['canonical_candidate', 'verified', 'approved', 'active', 'enforced', 'retired'])).min(1).max(6).optional().describe('Optional lifecycle filters. Current v0.2.1 content is candidate or verified only.'),
      limit: z.number().int().min(1).max(20).optional().describe('Maximum results. Default 5.'),
      include_full: z.boolean().optional().describe('Return full object content. Default false returns compact context.'),
    },
    async (args = {}) => text(await callAiOsContext(args)),
  );
}
