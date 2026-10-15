// ─── GET /vdr/report.xlsx — src/vdr/report-route.js ────────────────────────────
//
// Vendor Lead Report v2 (handoff, 2026-10-15). The n8n "06 VDR" workflow calls this for every due vendor and
// attaches the workbook it returns. Live data only: rpc/vdr_vendor_report (lp_leads + market assignments + Five9);
// the LP report 135 email is a cross-check, never a blocker.
//
//   GET /vdr/report.xlsx?vendor_id=<id>&as_of=<iso>      (operator bearer token, like every LP-MCP endpoint)
//     200 the .xlsx, plus headers n8n reads:
//         X-VDR-Vendor-Id (n8n checks each file belongs to the vendor it asked for), X-VDR-File-Name, X-VDR-Lead-Count, X-VDR-Summary (JSON totals), X-VDR-Lead-Synced-At,
//         X-VDR-Window (start..end), X-VDR-Feed-Leads / X-VDR-Feed-Received-At (the 135 cross-check, when a
//         complete saved feed from the last 36 hours exists; absent otherwise)
//     400 bad vendor_id / as_of · 404 unknown vendor · 500 the database read failed
//
// It never sends anything and never writes: the freshness gate, the cross-check verdict and the send log are n8n's.

import { denyAll } from '../auth.js';
import { buildVendorWorkbook } from './report-xlsx.js';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function defaultReportReader({ vendorId, asOf }) {
  const supabase = (await import('../supabase.js')).default;
  if (!supabase) throw new Error('supabase_not_configured');
  const { data, error } = await supabase.rpc('vdr_vendor_report', { p_vendor_id: vendorId, p_as_of: asOf });
  if (error) throw new Error(error.message || String(error));
  return data;
}

export function registerVdrReportRoutes(app, { authenticate = denyAll, readReport = defaultReportReader, now = () => new Date() } = {}) {
  app.get('/vdr/report.xlsx', authenticate, async (req, res) => {
    const vendorId = Number.parseInt(String(req.query.vendor_id ?? ''), 10);
    if (!Number.isInteger(vendorId) || vendorId <= 0) return res.status(400).json({ ok: false, error: 'vendor_id must be a positive integer' });
    let asOf = now();
    if (req.query.as_of != null && req.query.as_of !== '') {
      asOf = new Date(String(req.query.as_of));
      if (Number.isNaN(asOf.getTime())) return res.status(400).json({ ok: false, error: 'as_of must be an ISO date-time' });
    }
    let report;
    try {
      report = await readReport({ vendorId, asOf: asOf.toISOString() });
    } catch (err) {
      console.error(`[VDR] report read failed vendor=${vendorId}: ${err.message}`);
      return res.status(500).json({ ok: false, error: 'report_read_failed', detail: String(err.message).slice(0, 300) });
    }
    if (!report || report.found !== true) return res.status(404).json({ ok: false, error: 'vendor_not_found', vendor_id: vendorId });
    try {
      const { workbook, fileName, rowCount, totals } = buildVendorWorkbook(report, { generatedAt: now() });
      const buf = Buffer.from(await workbook.xlsx.writeBuffer());
      res.setHeader('Content-Type', XLSX_TYPE);
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('X-VDR-Vendor-Id', String(report.vendor_id ?? vendorId));
      res.setHeader('X-VDR-File-Name', fileName);
      res.setHeader('X-VDR-Lead-Count', String(rowCount));
      res.setHeader('X-VDR-Summary', JSON.stringify(totals));
      res.setHeader('X-VDR-Window', `${report.start_date}..${report.end_date}`);
      if (report.lead_synced_at) res.setHeader('X-VDR-Lead-Synced-At', String(report.lead_synced_at));
      const fc = report.feed_check;
      if (fc && fc.run_id != null) {
        res.setHeader('X-VDR-Feed-Leads', String(fc.leads ?? 0));
        res.setHeader('X-VDR-Feed-Received-At', String(fc.received_at ?? ''));
      }
      res.setHeader('Access-Control-Expose-Headers', 'X-VDR-Vendor-Id, X-VDR-File-Name, X-VDR-Lead-Count, X-VDR-Summary, X-VDR-Window, X-VDR-Lead-Synced-At, X-VDR-Feed-Leads, X-VDR-Feed-Received-At');
      console.log(`[VDR] report vendor=${vendorId} "${report.vendor_name}" rows=${rowCount} ${report.start_date}..${report.end_date}`);
      return res.status(200).end(buf);
    } catch (err) {
      console.error(`[VDR] workbook build failed vendor=${vendorId}: ${err.message}`);
      return res.status(500).json({ ok: false, error: 'workbook_build_failed', detail: String(err.message).slice(0, 300) });
    }
  });
  console.log('[REST API] Registered: GET /vdr/report.xlsx');
}
