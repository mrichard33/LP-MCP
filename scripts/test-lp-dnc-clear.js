/**
 * test-lp-dnc-clear.js — the LP DNC clear value (2026-09-29)
 *
 * LP's API docs for /api/Customers/UpdateDNCStatus: "Passing a blank value
 * will remove the existing selection and reset the status." The old clear
 * value 'N' was a guess LP rejected ("Error: Invalid DNC value."), so every
 * lift failed in LP. These pin: CLEAR sends a blank newDncStatus, the blank
 * survives form encoding, and the set codes are unchanged.
 *
 * 2026-10-01 — the blank went out as '+' (URLSearchParams) and LP rejected it
 * for all 26 Slack lifts. The body is now a pre-encoded string with %20.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

const { updateDncStatus, LP_DNC_CLEAR_CODE, encodeDncBody } = await import('../src/lp-client.js');

function recorder(response = [{ Result: 1, Message: 'Success' }]) {
  const calls = [];
  return {
    calls,
    lpPost: async (path, body) => {
      // The body is the exact string LP receives; fields is what LP decodes.
      calls.push({ path, body, fields: Object.fromEntries(new URLSearchParams(body)) });
      return response;
    },
  };
}

test('CLEAR sends a single space (LP\'s blank), never N or an empty field', async () => {
  assert.equal(LP_DNC_CLEAR_CODE, ' ');
  const r = recorder();
  await updateDncStatus({ custid: 458487, newDncStatus: 'CLEAR', empid: 5686 }, { lpPost: r.lpPost });
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].path, '/api/Customers/UpdateDNCStatus');
  assert.equal(r.calls[0].fields.newDncStatus, ' ');
  assert.ok(!['N', ''].includes(r.calls[0].fields.newDncStatus), 'both were rejected by LP on 2026-09-29');
});

test('CLEAR goes out as newDncStatus=%20, never as +', async () => {
  const r = recorder();
  await updateDncStatus({ custid: 458487, newDncStatus: 'CLEAR', empid: 5686 }, { lpPost: r.lpPost });
  assert.equal(typeof r.calls[0].body, 'string', 'a pre-encoded string, so lpPost sends it byte for byte');
  assert.ok(r.calls[0].body.includes('newDncStatus=%20'));
  assert.ok(!r.calls[0].body.includes('+'), "'+' is what LP rejected on 2026-10-01");
  assert.equal(r.calls[0].body, 'custid=458487&newDncStatus=%20&empid=5686');
});

test('encodeDncBody percent-encodes, and a phone with + stays a literal +', () => {
  assert.equal(encodeDncBody({ a: ' ', b: '+19545551234' }), 'a=%20&b=%2B19545551234');
});

test('set codes are sent as-is, and an unknown code is refused before any call', async () => {
  for (const code of ['C', 'T', 'M', 'E', 'P']) {
    const r = recorder();
    await updateDncStatus({ custid: 1, newDncStatus: code.toLowerCase() }, { lpPost: r.lpPost });
    assert.equal(r.calls[0].fields.newDncStatus, code);
  }
  const r = recorder();
  await assert.rejects(updateDncStatus({ custid: 1, newDncStatus: 'N' }, { lpPost: r.lpPost }), /invalid newDncStatus/);
  assert.equal(r.calls.length, 0);
});

test('an LP error still fails loud, naming the blank clear', async () => {
  const r = recorder([{ Result: 0, Message: 'Error: Invalid DNC value.' }]);
  await assert.rejects(
    updateDncStatus({ custid: 458487, newDncStatus: 'CLEAR', empid: 5686 }, { lpPost: r.lpPost }),
    /single space = CLEAR.*Invalid DNC value/,
  );
});

test('"already set to supplied value" on a set code is success, not a retry', async () => {
  const r = recorder([{ Result: 0, Message: 'Error: Current DNC status is already set to supplied value. ' }]);
  const out = await updateDncStatus({ custid: 449505, newDncStatus: 'C', empid: 5686 }, { lpPost: r.lpPost });
  assert.equal(out.already_set, true);
  assert.equal(r.calls.length, 1);
});

test('a clear on a record that is already clear is success; any other refusal still fails', async () => {
  const r = recorder([{ Result: 0, Message: 'Error: Current DNC status is already set to supplied value.' }]);
  assert.equal((await updateDncStatus({ custid: 1, newDncStatus: 'CLEAR' }, { lpPost: r.lpPost })).already_set, true);
  const bad = recorder([{ Result: 0, Message: 'Error: Invalid DNC value.' }]);
  await assert.rejects(updateDncStatus({ custid: 1, newDncStatus: 'CLEAR' }, { lpPost: bad.lpPost }), /Invalid DNC value/);
});

test('lpPost sends a pre-encoded string body byte for byte (%20 stays %20)', async () => {
  // The whole 2026-10-01 bug was bytes on the wire, so check the wire: stub
  // fetch, let the real lpPost run, and read the body it hands to fetch.
  process.env.LP_API_BASE_URL = 'https://lp.test';
  process.env.LP_USERNAME ||= 'u'; process.env.LP_PASSWORD ||= 'p';
  process.env.LP_CLIENT_ID ||= 'c'; process.env.LP_APP_KEY ||= 'k';
  const { lpPost } = await import('../src/lp-client.js');
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/token')) {
      return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    }
    sent.push({ url: String(url), body: init.body });
    return new Response(JSON.stringify([{ Result: 1, Message: 'Success' }]), { status: 200 });
  };
  try {
    await lpPost('/api/Customers/UpdateDNCStatus', 'custid=458487&newDncStatus=%20&empid=5686', 1);
    await lpPost('/api/Customers/GetLead', { cst_id: '1', note: 'a b' }, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sent[0].body, 'custid=458487&newDncStatus=%20&empid=5686');
  assert.equal(sent[1].body, 'cst_id=1&note=a+b', 'object bodies are encoded exactly as before');
});
