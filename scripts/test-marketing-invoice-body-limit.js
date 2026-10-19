// The invoice route must accept a real PDF (2026-10-19). Six LightFire invoices,
// ~390 KB each (~520 KB base64), all got 413 "request entity too large" from the
// global express.json() 100 kB default, which ran before the route's own 40 MB
// parser. invoiceBodyParser() is mounted on the path before the global parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { invoiceBodyParser, INVOICE_INGEST_PATH, INVOICE_BODY_LIMIT } from '../src/jobs/marketing-invoice-ingest.js';

async function post(app, bytes) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const body = JSON.stringify({ file_name: 'x.pdf', file_b64: 'A'.repeat(bytes) });
    const res = await fetch(`http://127.0.0.1:${port}${INVOICE_INGEST_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    return { status: res.status, body: res.status === 200 ? await res.json() : null };
  } finally {
    server.close();
  }
}

function appLike({ mounted }) {
  const app = express();
  if (mounted) app.use(INVOICE_INGEST_PATH, invoiceBodyParser());
  app.use(express.json()); // the global parser, 100 kB default
  app.post(INVOICE_INGEST_PATH, express.json({ limit: INVOICE_BODY_LIMIT }), (req, res) => res.json({ got: req.body.file_b64.length }));
  return app;
}

test('a ~520 KB base64 invoice is refused without the early mount (the 2026-10-19 failure)', async () => {
  assert.equal((await post(appLike({ mounted: false }), 535_000)).status, 413);
});

test('with invoiceBodyParser mounted first, the same invoice and a 5 MB one reach the route', async () => {
  const app = appLike({ mounted: true });
  assert.deepEqual(await post(app, 535_000), { status: 200, body: { got: 535_000 } });
  assert.deepEqual(await post(app, 5_000_000), { status: 200, body: { got: 5_000_000 } });
});

test('src/index.js mounts invoiceBodyParser on the invoice path before the global express.json()', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const mount = src.indexOf('app.use(INVOICE_INGEST_PATH, invoiceBodyParser());');
  const global = src.indexOf('app.use(express.json());');
  assert.ok(mount > 0, 'invoiceBodyParser is mounted');
  assert.ok(mount < global, 'mounted before the global parser');
});
