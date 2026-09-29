/**
 * test-lp-dnc-clear.js — the LP DNC clear value (2026-09-29)
 *
 * LP's API docs for /api/Customers/UpdateDNCStatus: "Passing a blank value
 * will remove the existing selection and reset the status." The old clear
 * value 'N' was a guess LP rejected ("Error: Invalid DNC value."), so every
 * lift failed in LP. These pin: CLEAR sends a blank newDncStatus, the blank
 * survives form encoding, and the set codes are unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

const { updateDncStatus, LP_DNC_CLEAR_CODE } = await import('../src/lp-client.js');

function recorder(response = [{ Result: 1, Message: 'Success' }]) {
  const calls = [];
  return { calls, lpPost: async (path, fields) => { calls.push({ path, fields }); return response; } };
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

test('the single space survives form encoding', () => {
  const body = new URLSearchParams({ custid: '458487', newDncStatus: ' ', empid: '5686' }).toString();
  assert.match(body, /(^|&)newDncStatus=\+(&|$)/);
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
