/**
 * Vendor Lead Report v2 — GET /vdr/report.xlsx and its workbook (handoff, 2026-10-15).
 *
 * The workbook goes to outside vendors, so these tests pin what the handoff ruled:
 *   - three tabs; the Leads columns in the agreed order; never an LP lead id, rep, setter or confirmer name
 *   - Arial everywhere, Summary tab red, gridlines off, A1:K1 merged navy title, Leads frozen at B2 with a filter
 *   - EVERY Summary number is a formula over the Leads tab (never a typed value), and the cached result of each
 *     equals the counts worked out from the rows (tally)
 *   - the route: 401 without the operator token, 400/404/500 on bad input or a failed read, 200 with the
 *     X-VDR-* headers n8n reads
 *
 * Run: node --test scripts/test-vdr-report-xlsx.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const { default: express } = await import('express');
const { default: ExcelJS } = await import('exceljs');
const { makeAuthenticate } = await import('../src/auth.js');
const { buildVendorWorkbook, tally, reportFileName, LEAD_COLUMNS, LEAD_COL } = await import('../src/vdr/report-xlsx.js');
const { registerVdrReportRoutes, vdrAuthenticate, defaultVerifyServiceKey, _resetVdrKeyCache } = await import('../src/vdr/report-route.js');

const TOKEN = 'test-operator-token';

const HEADERS = [
  'Prospect ID', 'Repeat Prospect (Y/N)', 'Sub-Source', 'Market', 'Entry Date', 'Entry Week (Mon)', 'First Name',
  'Last Name', 'Phone', 'Email', 'City', 'ZIP', 'Five9 Dials', 'Minutes to First Dial', 'Last Call Result (Five9)',
  'Contacted', 'Appt Set Date', 'Appt Date', 'Days Set → Appt', 'Confirmed Date', 'Set', 'Confirmed', 'Issue Date',
  'Issued', 'Net Issued', 'Demo', 'Sold', 'Gross Sale Amount', 'Current LP Status',
];

function lead(over = {}) {
  return {
    prospect_id: '100', repeat_prospect: false, sub_source: 'Modernize', market_code: 'ORL_MKT', market: 'Orlando',
    entry_at: '2026-10-14T09:15:00', entry_week: '2026-10-12', first_name: 'Ann', last_name: 'Lee',
    phone: '3525550188', email: 'a@example.com', city: 'Ocala', zip: '34470', five9_dials: 2,
    minutes_to_first_dial: 1.5, last_call_result: 'No Answer', contacted: false, appt_set_at: null, appt_at: null,
    days_set_to_appt: null, confirmed_at: null, is_set: false, is_confirmed: false, issue_date: null,
    is_issued: false, is_net_issued: false, is_demo: false, is_sold: false, gross_sale: null, lp_status: 'New',
    ...over,
  };
}

const ROWS = [
  lead({ prospect_id: '1', contacted: true, is_set: true, is_issued: true, is_demo: true, is_sold: true, gross_sale: 24000,
    appt_set_at: '2026-10-14T10:00:00', appt_at: '2026-10-16T14:00:00', days_set_to_appt: 2.2, issue_date: '2026-10-16' }),
  lead({ prospect_id: '2', contacted: true, is_set: true, market: 'Sarasota', market_code: 'SAR_MKT' }),
  lead({ prospect_id: '3', market: 'Outside Service Area', market_code: 'UNASSIGNED', entry_week: '2026-10-05', entry_at: '2026-10-07T08:00:00' }),
  lead({ prospect_id: '3', repeat_prospect: true, market: 'Outside Service Area', market_code: 'UNASSIGNED', five9_dials: 0, minutes_to_first_dial: null }),
  lead({ prospect_id: '4', contacted: true, is_set: true, is_issued: true, is_demo: true, is_sold: true, gross_sale: 15500.5, entry_week: '2026-10-05' }),
];
const REPORT = { found: true, vendor_id: 1, vendor_name: 'Modernize', start_date: '2026-07-17', end_date: '2026-10-15',
  lead_synced_at: '2026-10-15T14:50:00+00:00', rows: ROWS };

async function roundTrip(report) {
  const { workbook } = buildVendorWorkbook(report, { generatedAt: new Date('2026-10-15T15:00:00Z') });
  const buf = await workbook.xlsx.writeBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb;
}

test('three tabs, Leads headers in the agreed order, no id or rep field', async () => {
  const wb = await roundTrip(REPORT);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Summary', 'Leads', 'Definitions']);
  const ls = wb.getWorksheet('Leads');
  const got = [];
  ls.getRow(1).eachCell((c) => got.push(c.value));
  assert.deepEqual(got, HEADERS);
  assert.equal(ls.rowCount, ROWS.length + 1);
  for (const [h, field] of LEAD_COLUMNS) {
    assert.doesNotMatch(`${h} ${field}`, /lead.?id|rep\b|setter|confirmer|sales.?rep/i, h);
  }
  // Definitions: one line per column, in the same order, without the contact columns (the user, 2026-10-15).
  const ds = wb.getWorksheet('Definitions');
  const defined = HEADERS.filter((h) => !['First Name', 'Last Name', 'Phone', 'Email', 'City', 'ZIP'].includes(h));
  assert.equal(defined.length, 23);
  assert.equal(ds.rowCount, defined.length + 1);
  defined.forEach((h, i) => assert.equal(ds.getRow(i + 2).getCell(1).value, h));
});

test('Y/N booleans, 10-digit phone, dates as real dates', async () => {
  const wb = await roundTrip(REPORT);
  const ls = wb.getWorksheet('Leads');
  const r = ls.getRow(2);
  const at = (field) => r.getCell(LEAD_COL[field]).value;
  assert.equal(at('contacted'), 'Y');
  assert.equal(at('is_sold'), 'Y');
  assert.equal(at('repeat_prospect'), 'N');
  assert.equal(at('phone'), '3525550188');
  assert.ok(at('entry_at') instanceof Date);
  assert.equal(at('entry_at').toISOString(), '2026-10-14T09:15:00.000Z');
  assert.equal(ls.getCell(`${LEAD_COL.entry_at}2`).numFmt, 'yyyy-mm-dd hh:mm');
  assert.equal(ls.getRow(3).getCell(LEAD_COL.gross_sale).value, null);  // not sold → blank
});

test('branding: Arial, red tab, no gridlines, merged navy title, frozen Leads with a filter', async () => {
  const wb = await roundTrip(REPORT);
  const ws = wb.getWorksheet('Summary');
  assert.equal(ws.properties.tabColor.argb, 'FFB3261E');
  assert.equal(ws.views[0].showGridLines, false);
  assert.equal(ws.pageSetup.orientation, 'landscape');
  assert.equal(ws.pageSetup.fitToWidth, 1);
  assert.ok(ws.model.merges.includes('A1:K1'));
  const a1 = ws.getCell('A1');
  assert.equal(a1.value, 'REECE WINDOWS & DOORS');
  assert.equal(a1.fill.fgColor.argb, 'FF1F3A5F');
  assert.equal(a1.font.size, 18);
  assert.equal(a1.font.bold, true);
  assert.equal(ws.getCell('A2').value, 'Vendor Lead Report — Modernize');
  for (const sheet of wb.worksheets) {
    sheet.eachRow((row) => row.eachCell((c) => {
      if (c.value != null && c.value !== '') assert.equal(c.font?.name, 'Arial', `${sheet.name}!${c.address}`);
    }));
  }
  const ls = wb.getWorksheet('Leads');
  assert.equal(ls.views[0].state, 'frozen');
  assert.equal(ls.views[0].topLeftCell, 'B2');
  assert.ok(ls.autoFilter);
});

test('every Summary number is a formula over the Leads tab, and its result equals tally()', async () => {
  const wb = await roundTrip(REPORT);
  const ws = wb.getWorksheet('Summary');
  const t = tally(ROWS);
  const tile = (col) => ws.getCell(`${col}6`).value;
  for (const col of 'ABCDEFGH') {
    assert.ok(tile(col) && typeof tile(col).formula === 'string', `tile ${col} is a formula`);
  }
  assert.match(tile('A').formula, /Leads!/);
  assert.equal(tile('A').result, t.leads);
  assert.equal(tile('B').result, t.contacted / t.leads);
  assert.equal(tile('C').result, t.set);
  assert.equal(tile('E').result, t.issued);
  assert.equal(tile('F').result, t.demos);
  assert.equal(tile('G').result, t.sold);
  assert.equal(tile('H').result, 39500.5);

  // Every numeric cell below the tiles (market + week tables and their totals) is a formula.
  let numbers = 0;
  ws.eachRow((row, r) => {
    if (r < 8) return;
    row.eachCell((c, col) => {
      if (col === 1) return;
      if (typeof c.value === 'number') assert.fail(`typed number at ${c.address}`);
      if (c.value && typeof c.value === 'object' && 'formula' in c.value) numbers++;
    });
  });
  assert.ok(numbers > 40, `found ${numbers} formulas`);

  // The two Total rows read the same as the tiles.
  const totals = [];
  ws.eachRow((row) => { if (row.getCell(1).value === 'Total') totals.push(row); });
  assert.equal(totals.length, 2);
  for (const row of totals) {
    assert.equal(row.getCell(2).value.result, t.leads);
    assert.equal(row.getCell(5).value.result, t.set);
    assert.equal(row.getCell(11).value.result, t.gross);
  }
  // Markets in the business order, Outside last; weeks oldest first.
  const labels = [];
  ws.eachRow((row) => labels.push(row.getCell(1).value));
  const iO = labels.indexOf('Orlando'), iS = labels.indexOf('Sarasota'), iX = labels.indexOf('Outside Service Area');
  assert.ok(iO > 0 && iO < iS && iS < iX);
  const foot = labels.find((v) => typeof v === 'string' && v.startsWith('Recent weeks are still maturing'));
  assert.ok(foot);
});

test('a vendor with no leads still builds a valid workbook', async () => {
  const wb = await roundTrip({ ...REPORT, rows: [] });
  const ws = wb.getWorksheet('Summary');
  // exceljs drops a cached result of 0 when it writes; Excel recomputes on open (fullCalcOnLoad).
  assert.equal(ws.getCell('A6').value.result ?? 0, 0);
  assert.match(ws.getCell('A6').value.formula, /^COUNTA\(Leads!/);
  assert.equal(wb.getWorksheet('Leads').rowCount, 1);
});

test('file name: Reece_Vendor_Lead_Report_<Vendor>_<yyyy-mm-dd>.xlsx', () => {
  assert.equal(reportFileName('Modernize', '2026-10-15'), 'Reece_Vendor_Lead_Report_Modernize_2026-10-15.xlsx');
  assert.equal(reportFileName('Contractor Appointment Rev Share', '2026-10-15'),
    'Reece_Vendor_Lead_Report_Contractor_Appointment_Rev_Share_2026-10-15.xlsx');
});

// ---------- route ----------
async function startApp(readReport) {
  const app = express();
  registerVdrReportRoutes(app, {
    authenticate: makeAuthenticate({ token: TOKEN, log: () => {} }),
    readReport,
    now: () => new Date('2026-10-15T15:00:00Z'),
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}
const auth = { Authorization: `Bearer ${TOKEN}` };

test('route: no token is 401', async () => {
  const app = await startApp(async () => REPORT);
  try {
    const res = await fetch(`${app.url}/vdr/report.xlsx?vendor_id=1`);
    assert.equal(res.status, 401);
  } finally { await app.close(); }
});

test('route: bad input is 400, unknown vendor 404, failed read 500', async () => {
  let fail = false;
  const app = await startApp(async ({ vendorId }) => {
    if (fail) throw new Error('db down');
    return vendorId === 99 ? { found: false } : REPORT;
  });
  try {
    assert.equal((await fetch(`${app.url}/vdr/report.xlsx`, { headers: auth })).status, 400);
    assert.equal((await fetch(`${app.url}/vdr/report.xlsx?vendor_id=abc`, { headers: auth })).status, 400);
    assert.equal((await fetch(`${app.url}/vdr/report.xlsx?vendor_id=1&as_of=nope`, { headers: auth })).status, 400);
    assert.equal((await fetch(`${app.url}/vdr/report.xlsx?vendor_id=99`, { headers: auth })).status, 404);
    fail = true;
    assert.equal((await fetch(`${app.url}/vdr/report.xlsx?vendor_id=1`, { headers: auth })).status, 500);
  } finally { await app.close(); }
});

test('route: 200 returns the workbook and the headers n8n reads', async () => {
  const seen = [];
  const app = await startApp(async (args) => {
    seen.push(args);
    return { ...REPORT, feed_check: { run_id: 7, received_at: '2026-10-15T11:02:00+00:00', leads: 5 } };
  });
  try {
    const res = await fetch(`${app.url}/vdr/report.xlsx?vendor_id=1&as_of=2026-10-15T15:00:00Z`, { headers: auth });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /spreadsheetml/);
    assert.equal(res.headers.get('x-vdr-vendor-id'), '1');
    assert.equal(res.headers.get('x-vdr-file-name'), 'Reece_Vendor_Lead_Report_Modernize_2026-10-15.xlsx');
    assert.equal(res.headers.get('x-vdr-lead-count'), String(ROWS.length));
    assert.equal(JSON.parse(res.headers.get('x-vdr-summary')).sold, 2);
    assert.equal(res.headers.get('x-vdr-window'), '2026-07-17..2026-10-15');
    assert.equal(res.headers.get('x-vdr-lead-synced-at'), REPORT.lead_synced_at);
    assert.equal(res.headers.get('x-vdr-feed-leads'), '5');
    assert.deepEqual(seen[0], { vendorId: 1, asOf: '2026-10-15T15:00:00.000Z' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    assert.equal(wb.getWorksheet('Leads').rowCount, ROWS.length + 1);
  } finally { await app.close(); }
});

test('route: no saved 135 feed means no feed headers', async () => {
  const app = await startApp(async () => ({ ...REPORT, feed_check: null }));
  try {
    const res = await fetch(`${app.url}/vdr/report.xlsx?vendor_id=1`, { headers: auth });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-vdr-feed-leads'), null);
  } finally { await app.close(); }
});

// 2026-10-15: production runs AUTH_SOFT_LAUNCH=true, and the shared check let a request with no token download the
// whole Modernize file. This route is always enforced: the operator token, or a key the database proves is the LP
// project's service-role key (what n8n's "LP Supabase" credential sends).
async function serveWith(authenticate) {
  const app = express();
  registerVdrReportRoutes(app, { authenticate, readReport: async () => REPORT });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
const get = (url, key) => fetch(`${url}/vdr/report.xlsx?vendor_id=1`, key ? { headers: { Authorization: `Bearer ${key}` } } : {});

test('route auth: no soft launch; operator token or a verified service-role key only', async () => {
  const prev = process.env.AUTH_SOFT_LAUNCH;
  process.env.AUTH_SOFT_LAUNCH = 'true';
  _resetVdrKeyCache();
  const asked = [];
  const verifyServiceKey = async (k) => { asked.push(k); return k === 'service-key'; };
  const app = await serveWith(vdrAuthenticate({ token: TOKEN, verifyServiceKey, canVerify: true }));
  try {
    assert.equal((await get(app.url)).status, 401);
    assert.equal((await get(app.url, 'wrong')).status, 401);
    assert.equal((await get(app.url, TOKEN)).status, 200);
    assert.equal((await get(app.url, 'service-key')).status, 200);
    assert.equal((await get(app.url, 'service-key')).status, 200);
    assert.deepEqual(asked, ['wrong', 'service-key']);   // the operator token never reaches the database; verdicts are cached
  } finally {
    await app.close();
    if (prev === undefined) delete process.env.AUTH_SOFT_LAUNCH; else process.env.AUTH_SOFT_LAUNCH = prev;
  }
});

test('route auth: nothing configured refuses with 503', async () => {
  const app = await serveWith(vdrAuthenticate({ token: null, canVerify: false }));
  try { assert.equal((await get(app.url)).status, 503); } finally { await app.close(); }
});

test('service-key check: a key that reads vdr_vendor_config is the service role', async () => {
  const seen = [];
  const fetchImpl = async (u, o) => { seen.push([u, o.headers.apikey]); return { ok: o.headers.apikey === 'svc', json: async () => (o.headers.apikey === 'svc' ? [{ id: 1 }] : []) }; };
  assert.equal(await defaultVerifyServiceKey('svc', { fetchImpl, url: 'https://x.supabase.co/' }), true);
  assert.equal(await defaultVerifyServiceKey('anon', { fetchImpl, url: 'https://x.supabase.co' }), false);
  assert.equal(await defaultVerifyServiceKey('svc', { fetchImpl, url: '' }), false);
  assert.equal(seen[0][0], 'https://x.supabase.co/rest/v1/vdr_vendor_config?select=id&limit=1');
});
