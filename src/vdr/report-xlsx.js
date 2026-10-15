/**
 * Vendor Lead Report v2 — src/vdr/report-xlsx.js (handoff, 2026-10-15).
 *
 * WHY: n8n "06 VDR" never delivered. Every send waited on the LP report 135 email and every vdr_send_log row since
 * 2026-10-13 read blocked/no_feed_email. The report is now built from LIVE data (rpc/vdr_vendor_report: lp_leads +
 * lp_lead_market_assignments + Five9) as one branded workbook with every lead in the vendor's window.
 *
 * Three sheets, Arial throughout:
 *   Summary      KPI tiles, "By market" and "By week" tables. EVERY number is a formula (COUNTIF/COUNTIFS/SUMIFS)
 *                over the Leads sheet, never a typed value. Each formula carries its computed result too, so a
 *                viewer that does not recalculate (a phone, a mail preview) still shows the right number, and
 *                fullCalcOnLoad makes Excel recompute on open.
 *   Leads        one row per lead, the columns in LEAD_COLUMNS order. Never the LP lead id, a rep, setter or
 *                confirmer name: the SQL does not return them and nothing here adds them.
 *   Definitions  one plain-English line per column.
 *
 * Pure: rows in, workbook out. No I/O, so the tests build it offline.
 */
import ExcelJS from 'exceljs';

export const NAVY = 'FF1F3A5F';
export const RED = 'FFB3261E';
export const TILE_FILL = 'FFF5F7FA';
export const TILE_BORDER = 'FFC8C8C8';
export const GREY = 'FF6B7280';
const WHITE = 'FFFFFFFF';
const FONT = 'Arial';

const yn = (v) => (v ? 'Y' : 'N');

// [header, row field, kind, width, definition]. Kind: text | yn | int | num1 | money | datetime | date.
export const LEAD_COLUMNS = [
  ['Prospect ID', 'prospect_id', 'text', 12, 'Lead Perfection prospect number for the household. The same person sent twice keeps the same Prospect ID.'],
  ['Repeat Prospect (Y/N)', 'repeat_prospect', 'yn', 10, 'Y when this prospect appears more than once in this report (you sent the same household more than once in the window).'],
  ['Sub-Source', 'sub_source', 'text', 22, 'The lead source name Lead Perfection recorded for the lead.'],
  ['Market', 'market', 'text', 20, 'The Reece office that serves the address. Outside Service Area means no Reece office serves it.'],
  ['Entry Date', 'entry_at', 'datetime', 16, 'Date and time (Eastern) the lead was entered in Lead Perfection.'],
  ['Entry Week (Mon)', 'entry_week', 'date', 12, 'The Monday of the week the lead was entered.'],
  ['First Name', 'first_name', 'text', 14, 'First name as entered.'],
  ['Last Name', 'last_name', 'text', 16, 'Last name as entered.'],
  ['Phone', 'phone', 'text', 12, 'Phone number, 10 digits.'],
  ['Email', 'email', 'text', 26, 'Email address as entered.'],
  ['City', 'city', 'text', 16, 'City of the address.'],
  ['ZIP', 'zip', 'text', 8, 'ZIP code of the address.'],
  ['Five9 Dials', 'five9_dials', 'int', 8, 'Number of calls to or from this phone in our phone system (Five9) from the time the lead arrived.'],
  ['Minutes to First Dial', 'minutes_to_first_dial', 'num1', 10, 'Minutes from the lead arriving to the first call. Blank when no call was made.'],
  ['Last Call Result (Five9)', 'last_call_result', 'text', 22, 'Result of the most recent call, as our call center recorded it in Five9.'],
  ['Contacted', 'contacted', 'yn', 10, 'Y when any call reached a person (for example Not Interested, Appointment Set, Callback, Do Not Call). Voicemail, no answer and busy do not count.'],
  ['Appt Set Date', 'appt_set_at', 'date', 12, 'Date an appointment was set.'],
  ['Appt Date', 'appt_at', 'datetime', 16, 'Date and time (Eastern) of the appointment.'],
  ['Days Set → Appt', 'days_set_to_appt', 'num1', 9, 'Days between setting the appointment and the appointment itself.'],
  ['Confirmed Date', 'confirmed_at', 'date', 12, 'Date the appointment was confirmed with the homeowner.'],
  ['Set', 'is_set', 'yn', 6, 'Y when an appointment was set.'],
  ['Confirmed', 'is_confirmed', 'yn', 9, 'Y when the appointment was confirmed.'],
  ['Issue Date', 'issue_date', 'date', 12, 'Date the appointment was issued to a sales rep (the appointment date; Lead Perfection keeps no separate issue time).'],
  ['Issued', 'is_issued', 'yn', 7, 'Y when the appointment was issued to a sales rep.'],
  ['Net Issued', 'is_net_issued', 'yn', 8, 'Y when the issued appointment counts as a net issue (it was not reset or cancelled before the visit).'],
  ['Demo', 'is_demo', 'yn', 6, 'Y when the sales rep completed an in-home presentation.'],
  ['Sold', 'is_sold', 'yn', 6, 'Y when the homeowner signed a contract.'],
  ['Gross Sale Amount', 'gross_sale', 'money', 13, 'Contract amount, shown only for sold leads.'],
  ['Current LP Status', 'lp_status', 'text', 24, "The lead's current status in Lead Perfection."],
];

export const colLetter = (i) => {           // 0 -> A, 26 -> AA
  let s = '', n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
};
const COL = Object.fromEntries(LEAD_COLUMNS.map((c, i) => [c[1], colLetter(i)]));
export const LEAD_COL = COL;

// Postgres timestamp without zone ("2026-10-15T12:35:30.043") or date ("2026-10-15") → a Date whose UTC parts are
// that wall clock, which is how exceljs writes a cell Excel shows as that exact local time.
export function wallDate(v) {
  if (v == null || v === '') return null;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
}
const ymd = (v) => { const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : ''; };
const mdy = (v) => { const d = ymd(v); return d ? `${d.slice(5, 7)}-${d.slice(8, 10)}-${d.slice(0, 4)}` : ''; };

function cellValue(kind, v) {
  if (kind === 'yn') return yn(v);
  if (kind === 'int') return v == null ? 0 : Number(v);
  if (kind === 'num1' || kind === 'money') return v == null || v === '' ? null : Number(v);
  if (kind === 'datetime' || kind === 'date') return wallDate(v);
  return v == null ? null : String(v);
}
const NUMFMT = { datetime: 'yyyy-mm-dd hh:mm', date: 'yyyy-mm-dd', num1: '0.0', money: '"$"#,##0', int: '0' };

// Market order on the Summary: the six offices west to east as the business lists them, then Outside.
export const MARKET_ORDER = ['Orlando', 'St. Petersburg', 'Jacksonville', 'Fort Lauderdale', 'Fort Myers', 'Sarasota', 'Outside Service Area'];

export function reportFileName(vendorName, endDate) {
  const slug = String(vendorName || 'Vendor').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `Reece_Vendor_Lead_Report_${slug}_${ymd(endDate) || ymd(new Date().toISOString())}.xlsx`;
}

/** The numbers the Summary formulas compute, worked out in JS (formula results + the n8n summary line). */
export function tally(rows) {
  const t = { leads: 0, contacted: 0, set: 0, issued: 0, demos: 0, sold: 0, gross: 0 };
  for (const r of rows) {
    t.leads++;
    if (r.contacted) t.contacted++;
    if (r.is_set) t.set++;
    if (r.is_issued) t.issued++;
    if (r.is_demo) t.demos++;
    if (r.is_sold) { t.sold++; t.gross += Number(r.gross_sale || 0); }
  }
  t.gross = Math.round(t.gross * 100) / 100;
  return t;
}
const ratio = (a, b) => (b ? a / b : 0);

function styleCell(cell, { size = 9, bold = false, color, fill, numFmt, align, border } = {}) {
  cell.font = { name: FONT, size, bold, ...(color ? { color: { argb: color } } : {}) };
  if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  if (numFmt) cell.numFmt = numFmt;
  if (align) cell.alignment = align;
  if (border) cell.border = border;
}

/**
 * @param {object} report  rpc/vdr_vendor_report: { vendor_name, start_date, end_date, rows: [...] }
 * @param {{ generatedAt?: Date }} [opts]
 * @returns {{ workbook: ExcelJS.Workbook, fileName: string, rowCount: number, totals: object }}
 */
export function buildVendorWorkbook(report, { generatedAt = new Date() } = {}) {
  const rows = Array.isArray(report?.rows) ? report.rows : [];
  const n = rows.length;
  const last = Math.max(n + 1, 2);                   // last Leads data row (at least row 2, so ranges stay valid)
  const rng = (field) => `Leads!$${COL[field]}$2:$${COL[field]}$${last}`;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Reece Windows & Doors';
  wb.created = generatedAt;
  wb.calcProperties = { fullCalcOnLoad: true };

  // ---------- Summary ----------
  const ws = wb.addWorksheet('Summary', {
    properties: { tabColor: { argb: RED } },
    views: [{ showGridLines: false }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.columns = [{ width: 24 }, ...Array.from({ length: 10 }, () => ({ width: 13 }))];
  ws.mergeCells('A1:K1');
  const title = ws.getCell('A1');
  title.value = 'REECE WINDOWS & DOORS';
  styleCell(title, { size: 18, bold: true, color: WHITE, fill: NAVY, align: { vertical: 'middle' } });
  ws.getRow(1).height = 30;
  const sub = ws.getCell('A2');
  sub.value = `Vendor Lead Report — ${report?.vendor_name || ''}`;
  styleCell(sub, { size: 14, bold: true, color: NAVY });
  const meta = ws.getCell('A3');
  meta.value = `Leads entered ${mdy(report?.start_date)} – ${mdy(report?.end_date)} · Generated ${mdy(generatedAt.toISOString())} · Sources: Lead Perfection (leads, appointments, sales) and Five9 (calls)`;
  styleCell(meta, { size: 9, color: GREY });
  for (let c = 1; c <= 11; c++) ws.getRow(4).getCell(c).border = { top: { style: 'medium', color: { argb: RED } } };

  const t = tally(rows);
  const tiles = [
    ['Leads', { formula: `COUNTA(${rng('sub_source')})`, result: t.leads }, '#,##0'],
    ['Contacted %', { formula: `IFERROR(COUNTIF(${rng('contacted')},"Y")/A6,0)`, result: ratio(t.contacted, t.leads) }, '0.0%'],
    ['Appts Set', { formula: `COUNTIF(${rng('is_set')},"Y")`, result: t.set }, '#,##0'],
    ['Set Rate', { formula: 'IFERROR(C6/A6,0)', result: ratio(t.set, t.leads) }, '0.0%'],
    ['Issued', { formula: `COUNTIF(${rng('is_issued')},"Y")`, result: t.issued }, '#,##0'],
    ['Demos', { formula: `COUNTIF(${rng('is_demo')},"Y")`, result: t.demos }, '#,##0'],
    ['Sales', { formula: `COUNTIF(${rng('is_sold')},"Y")`, result: t.sold }, '#,##0'],
    ['Gross Sales', { formula: `SUM(${rng('gross_sale')})`, result: t.gross }, '"$"#,##0'],
  ];
  const tileBorder = { top: { style: 'thin', color: { argb: TILE_BORDER } }, left: { style: 'thin', color: { argb: TILE_BORDER } }, bottom: { style: 'thin', color: { argb: TILE_BORDER } }, right: { style: 'thin', color: { argb: TILE_BORDER } } };
  tiles.forEach(([label, value, fmt], i) => {
    const l = ws.getRow(5).getCell(i + 1);
    l.value = label;
    styleCell(l, { size: 9, color: GREY, fill: TILE_FILL, border: tileBorder, align: { horizontal: 'center' } });
    const v = ws.getRow(6).getCell(i + 1);
    v.value = value;
    styleCell(v, { size: 14, bold: true, color: NAVY, fill: TILE_FILL, border: tileBorder, numFmt: fmt, align: { horizontal: 'center' } });
  });
  ws.getRow(6).height = 24;

  const TABLE_HEAD = ['Leads', 'Contacted', 'Contact %', 'Appts Set', 'Set Rate', 'Issued', 'Issued / Set', 'Demos', 'Sales', 'Gross Sales'];
  const FMTS = ['#,##0', '#,##0', '0.0%', '#,##0', '0.0%', '#,##0', '0.0%', '#,##0', '#,##0', '"$"#,##0'];
  // One breakdown table (by market, or by entry week). keyField is the Leads column the first column matches.
  function table(startRow, heading, firstHeader, keyField, keys, keyFmt) {
    const h = ws.getCell(`A${startRow}`);
    h.value = heading;
    styleCell(h, { size: 11, bold: true, color: NAVY });
    const head = ws.getRow(startRow + 1);
    [firstHeader, ...TABLE_HEAD].forEach((txt, i) => {
      const c = head.getCell(i + 1);
      c.value = txt;
      styleCell(c, { size: 9, bold: true, color: WHITE, fill: NAVY, align: { horizontal: i ? 'center' : 'left', wrapText: true } });
    });
    const first = startRow + 2;
    keys.forEach((k, idx) => {
      const r = first + idx;
      const row = ws.getRow(r);
      const sub = rows.filter((x) => (keyField === 'entry_week' ? ymd(x.entry_week) === ymd(k) : x.market === k));
      const s = tally(sub);
      const key = `$A${r}`;
      const cf = (field) => `COUNTIFS(${rng(keyField)},${key},${rng(field)},"Y")`;
      const values = [
        keyField === 'entry_week' ? wallDate(k) : k,
        { formula: `COUNTIFS(${rng(keyField)},${key})`, result: s.leads },
        { formula: cf('contacted'), result: s.contacted },
        { formula: `IFERROR(C${r}/B${r},0)`, result: ratio(s.contacted, s.leads) },
        { formula: cf('is_set'), result: s.set },
        { formula: `IFERROR(E${r}/B${r},0)`, result: ratio(s.set, s.leads) },
        { formula: cf('is_issued'), result: s.issued },
        { formula: `IFERROR(G${r}/E${r},0)`, result: ratio(s.issued, s.set) },
        { formula: cf('is_demo'), result: s.demos },
        { formula: cf('is_sold'), result: s.sold },
        { formula: `SUMIFS(${rng('gross_sale')},${rng(keyField)},${key})`, result: s.gross },
      ];
      values.forEach((v, i) => {
        const c = row.getCell(i + 1);
        c.value = v;
        styleCell(c, { size: 9, fill: idx % 2 ? TILE_FILL : undefined, numFmt: i ? FMTS[i - 1] : keyFmt, align: { horizontal: i ? 'right' : 'left' } });
      });
    });
    const tr = first + keys.length;
    const lastData = tr - 1;
    const sum = (col) => (keys.length ? `SUM(${col}${first}:${col}${lastData})` : '0');
    const total = ws.getRow(tr);
    const totals = [
      'Total',
      { formula: sum('B'), result: t.leads }, { formula: sum('C'), result: t.contacted },
      { formula: `IFERROR(C${tr}/B${tr},0)`, result: ratio(t.contacted, t.leads) },
      { formula: sum('E'), result: t.set }, { formula: `IFERROR(E${tr}/B${tr},0)`, result: ratio(t.set, t.leads) },
      { formula: sum('G'), result: t.issued }, { formula: `IFERROR(G${tr}/E${tr},0)`, result: ratio(t.issued, t.set) },
      { formula: sum('I'), result: t.demos }, { formula: sum('J'), result: t.sold }, { formula: sum('K'), result: t.gross },
    ];
    totals.forEach((v, i) => {
      const c = total.getCell(i + 1);
      c.value = v;
      styleCell(c, { size: 9, bold: true, numFmt: i ? FMTS[i - 1] : undefined, align: { horizontal: i ? 'right' : 'left' }, border: { top: { style: 'thin', color: { argb: NAVY } } } });
    });
    return tr;
  }
  const marketsPresent = MARKET_ORDER.filter((m) => rows.some((r) => r.market === m));
  for (const m of new Set(rows.map((r) => r.market))) if (m && !marketsPresent.includes(m)) marketsPresent.push(m);
  const mEnd = table(8, 'By market', 'Market', 'market', marketsPresent, undefined);
  const weeks = [...new Set(rows.map((r) => ymd(r.entry_week)).filter(Boolean))].sort();
  const wEnd = table(mEnd + 2, 'By week (lead entry week)', 'Week of (Mon)', 'entry_week', weeks, 'yyyy-mm-dd');
  const foot = ws.getCell(`A${wEnd + 2}`);
  foot.value = 'Recent weeks are still maturing: appointments, issues and sales keep landing for several weeks after a lead arrives.';
  styleCell(foot, { size: 9, color: GREY, align: { wrapText: false } });

  // ---------- Leads ----------
  const ls = wb.addWorksheet('Leads', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1, topLeftCell: 'B2' }] });
  ls.columns = LEAD_COLUMNS.map(([header, key, , width]) => ({ header, key, width }));
  const hr = ls.getRow(1);
  hr.height = 30;
  hr.eachCell((c) => styleCell(c, { size: 9, bold: true, color: WHITE, fill: NAVY, align: { wrapText: true, vertical: 'middle' } }));
  for (const r of rows) {
    const values = {};
    for (const [, key, kind] of LEAD_COLUMNS) values[key] = cellValue(kind, r[key]);
    const row = ls.addRow(values);
    row.eachCell({ includeEmpty: true }, (c, colNumber) => {
      const kind = LEAD_COLUMNS[colNumber - 1]?.[2];
      c.font = { name: FONT, size: 9 };
      if (NUMFMT[kind]) c.numFmt = NUMFMT[kind];
    });
  }
  ls.autoFilter = { from: 'A1', to: `${colLetter(LEAD_COLUMNS.length - 1)}1` };

  // ---------- Definitions ----------
  const ds = wb.addWorksheet('Definitions');
  ds.columns = [{ header: 'Column', key: 'c', width: 26 }, { header: 'What it means', key: 'd', width: 110 }];
  ds.getRow(1).eachCell((c) => styleCell(c, { size: 9, bold: true, color: WHITE, fill: NAVY }));
  for (const [header, , , , def] of LEAD_COLUMNS) {
    const row = ds.addRow({ c: header, d: def });
    row.eachCell((c) => styleCell(c, { size: 9, align: { wrapText: true, vertical: 'top' } }));
  }

  return { workbook: wb, fileName: reportFileName(report?.vendor_name, report?.end_date), rowCount: n, totals: t };
}
