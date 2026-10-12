/**
 * Brad-format XLSX — src/marketing/report-xlsx.js (handoff §9, D7).
 *
 * exceljs workbook, one per market (and one for the company), three sheets.
 * FORMULAS, NOT TYPED VALUES: every ratio cell is a formula over the count
 * and dollar cells on its own row, the "All Campaigns" / "Jan–YTD" row is
 * SUM() over the rows above, and divide-by-zero reads "n.a." through
 * IFERROR. The input numbers are the only literals.
 *
 * Column layout (Campaign Summary and Monthly Results):
 *   A Campaign | B Raw | C Set | D Issue | E % Issue | F # Demo | G % Demo |
 *   H # Sold | I STD % | J Gross $ | K Working $ | L Net Sales $ | M NSLI |
 *   N Invoice Cost | O Calculated Cost | P Total Cost | Q Cost / Issued Lead | R Mkt %
 */
import ExcelJS from 'exceljs';

const MONEY = '"$"#,##0.00';
const PCT = '0.0%';
const INT = '#,##0';

const HEADERS = ['Campaign', 'Raw', 'Set', 'Issue', '% Issue', '# Demo', '% Demo', '# Sold', 'STD %', 'Gross $', 'Working $', 'Net Sales $', 'NSLI', 'Invoice Cost', 'Calculated Cost', 'Total Cost', 'Cost / Issued Lead', 'Mkt %'];

function ratioFormulas(r) {
  return {
    E: `IFERROR(D${r}/C${r},"n.a.")`,
    G: `IFERROR(F${r}/D${r},"n.a.")`,
    I: `IFERROR(H${r}/F${r},"n.a.")`,
    M: `IFERROR(L${r}/D${r},"n.a.")`,
    P: `N${r}+O${r}`,
    Q: `IFERROR(P${r}/D${r},"n.a.")`,
    R: `IFERROR(P${r}/L${r},"n.a.")`,
  };
}

function styleHeader(row) {
  row.font = { bold: true };
  row.alignment = { horizontal: 'center', wrapText: true };
  row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } }; c.border = { bottom: { style: 'thin' } }; });
}

function writeRow(ws, r, item) {
  const row = ws.getRow(r);
  row.getCell('A').value = item.label + (item.has_provisional ? ' †' : '');
  row.getCell('B').value = item.raw;
  row.getCell('C').value = item.set_count;
  row.getCell('D').value = item.issued;
  row.getCell('F').value = item.sat;
  row.getCell('H').value = item.sold;
  row.getCell('J').value = item.has_dollars ? round2(item.gross) : null;
  row.getCell('K').value = item.has_dollars ? round2(item.working) : null;
  row.getCell('L').value = item.has_dollars ? round2(item.net) : null;
  row.getCell('N').value = round2(item.invoice_cost);
  row.getCell('O').value = round2(item.calculated_cost);
  const f = ratioFormulas(r);
  for (const [col, formula] of Object.entries(f)) row.getCell(col).value = { formula };
  applyFormats(row);
}

function writeTotalRow(ws, r, first, last, label) {
  const row = ws.getRow(r);
  row.getCell('A').value = label;
  for (const col of ['B', 'C', 'D', 'F', 'H', 'J', 'K', 'L', 'N', 'O']) {
    row.getCell(col).value = { formula: last >= first ? `SUM(${col}${first}:${col}${last})` : '0' };
  }
  const f = ratioFormulas(r);
  for (const [col, formula] of Object.entries(f)) row.getCell(col).value = { formula };
  row.font = { bold: true };
  row.eachCell((c) => { c.border = { top: { style: 'thin' } }; });
  applyFormats(row);
}

function applyFormats(row) {
  for (const col of ['B', 'C', 'D', 'F', 'H']) row.getCell(col).numFmt = INT;
  for (const col of ['E', 'G', 'I', 'R']) row.getCell(col).numFmt = PCT;
  for (const col of ['J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q']) row.getCell(col).numFmt = MONEY;
}

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

function tableSheet(wb, name, title, items, totalLabel, footnotes) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 2 }] });
  ws.getCell('A1').value = title;
  ws.getCell('A1').font = { bold: true, size: 13 };
  const header = ws.getRow(2);
  HEADERS.forEach((h, i) => { header.getCell(i + 1).value = h; });
  styleHeader(header);
  ws.columns = HEADERS.map((h, i) => ({ width: i === 0 ? 34 : h.length > 12 ? 16 : 12 }));
  let r = 3;
  const first = r;
  for (const item of items) writeRow(ws, r++, item);
  const last = r - 1;
  writeTotalRow(ws, r++, first, last, totalLabel);
  r++;
  for (const note of footnotes || []) { ws.getCell(`A${r}`).value = note; ws.getCell(`A${r}`).font = { italic: true, size: 9 }; r++; }
  return ws;
}

function weeklySheet(wb, model) {
  const ws = wb.addWorksheet('Weekly', { views: [{ state: 'frozen', ySplit: 2 }] });
  ws.getCell('A1').value = `${model.title} — last 8 ISO weeks (monthly invoices spread by days; the feed uses actual days)`;
  ws.getCell('A1').font = { bold: true, size: 13 };
  const header = ws.getRow(2);
  ['Week', 'Raw', 'Issue', 'Total Cost', 'Cost / Issued Lead'].forEach((h, i) => { header.getCell(i + 1).value = h; });
  styleHeader(header);
  ws.columns = [{ width: 22 }, { width: 10 }, { width: 10 }, { width: 14 }, { width: 18 }];
  let r = 3;
  for (const w of model.weekly) {
    const row = ws.getRow(r);
    row.getCell('A').value = w.label;
    row.getCell('B').value = w.raw;
    row.getCell('C').value = w.issued;
    row.getCell('D').value = round2(w.invoice_cost + w.calculated_cost);
    row.getCell('E').value = { formula: `IFERROR(D${r}/C${r},"n.a.")` };
    row.getCell('B').numFmt = INT; row.getCell('C').numFmt = INT; row.getCell('D').numFmt = MONEY; row.getCell('E').numFmt = MONEY;
    r++;
  }
  return ws;
}

/** One workbook for one model → Buffer. */
export async function buildWorkbook(model) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'LP-MCP marketing cost ledger';
  wb.created = new Date();
  tableSheet(wb, 'Campaign Summary', `${model.title} — ${model.monthLabel}`, model.campaign, 'All Campaigns', model.footnotes);
  tableSheet(wb, 'Monthly Results', `${model.title} — ${model.month.slice(0, 4)} by month`, model.monthly, 'Jan–YTD', model.footnotes.slice(-2));
  weeklySheet(wb, model);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Test helper: read the formulas back out of a buffer. */
export async function readWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}
