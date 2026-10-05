import assert from 'node:assert/strict';
import test from 'node:test';
import { callAiOsContext, registerAiOsTools } from '../src/tools/ai-os-tools.js';

test('ai_os_context maps MCP arguments to the protected RPC', async () => {
  let captured = null;
  const client = {
    rpc: async (name, params) => {
      captured = { name, params };
      return {
        data: {
          gateway: 'ai_os_context',
          mode: 'direct_id',
          results: [{ canonical_id: 'CANON.STD.006', lifecycle_state: 'canonical_candidate' }],
        },
        error: null,
      };
    },
  };

  const out = await callAiOsContext({
    ids: ['CANON.STD.006'],
    limit: 3,
    include_full: true,
  }, client);

  assert.equal(out.ok, true);
  assert.equal(captured.name, 'ai_os_context');
  assert.deepEqual(captured.params, {
    p_query: null,
    p_ids: ['CANON.STD.006'],
    p_object_types: null,
    p_lifecycle_states: null,
    p_limit: 3,
    p_include_full: true,
  });
  assert.equal(out.results[0].canonical_id, 'CANON.STD.006');
});

test('ai_os_context fails closed when the dedicated AI OS client is unavailable', async () => {
  const out = await callAiOsContext({ query: 'retrieval' }, null);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'AI_OS_NOT_CONFIGURED');
  assert.equal(out.retryable, false);
});

test('registerAiOsTools exposes one read-only gateway tool', () => {
  const registered = [];
  const server = {
    tool: (name, description, schema, handler) => registered.push({ name, description, schema, handler }),
  };

  registerAiOsTools(server);

  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'ai_os_context');
  assert.match(registered[0].description, /read-only/i);
  assert.match(registered[0].description, /does not approve, activate, enforce, deploy/i);
});
