// n8n I.MCIN reports back after every invoice (2026-10-22). Until today the two
// addresses did not exist, so every run ended on a red 404 after the invoice had
// already been handled. They now answer 200, check the intake password, and post
// ONE #ops-alerts line only for a failure n8n saw that never reached us.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const SECRET = 'test-intake-secret';
let register;

before(async () => {
  process.env.LP_REPORT_INGEST_SECRET = SECRET;
  ({ registerMarketingInvoiceRoutes: register } = await import('../src/jobs/marketing-invoice-ingest.js'));
});

async function post(path, body, { secret = SECRET, alerts = [] } = {}) {
  const app = express();
  register(app, { sendAlert: async (text, opts) => { alerts.push({ text, opts }); return { sent: true }; } });
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const headers = { 'content-type': 'application/json' };
    if (secret !== null) headers['x-ghl-signature'] = secret;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test('the success report answers 200 (it was a 404 on every invoice)', async () => {
  const r = await post('/events/marketing_invoice_ingest_succeeded', { workflow: 'I.MCIN', duplicate: true, document_id: null });
  assert.deepEqual(r, { status: 200, body: { success: true } });
});

test('a failure that never reached us posts one ops line, with bank numbers removed', async () => {
  const alerts = [];
  const r = await post('/events/marketing_invoice_ingest_failed',
    { workflow: 'I.MCIN', failure_reason: 'timeout; Routing # 021000021 Account # 123456789012', document_id: null },
    { alerts });
  assert.equal(r.status, 200);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].opts.channel, 'ops');
  assert.doesNotMatch(alerts[0].text, /021000021|123456789012/);
});

test('a failure we already reported (it has a document) posts nothing more', async () => {
  const alerts = [];
  const r = await post('/events/marketing_invoice_ingest_failed',
    { workflow: 'I.MCIN', failure_reason: 'missing_total', document_id: 'abc' }, { alerts });
  assert.equal(r.status, 200);
  assert.equal(alerts.length, 0);
});

test('a missing or wrong password is refused, like the ingest itself', async () => {
  for (const secret of [null, 'wrong']) {
    const alerts = [];
    const ok = await post('/events/marketing_invoice_ingest_succeeded', {}, { secret });
    const failed = await post('/events/marketing_invoice_ingest_failed', { failure_reason: 'x' }, { secret, alerts });
    assert.equal(ok.status, 401);
    assert.equal(failed.status, 401);
    assert.equal(alerts.length, 0);
  }
});
