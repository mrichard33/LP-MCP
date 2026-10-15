// ─── GET /vdr/report.xlsx — src/vdr/report-route.js ────────────────────────────
//
// Vendor Lead Report v2 (handoff, 2026-10-15). The n8n "06 VDR" workflow calls this for every due vendor and
// attaches the workbook it returns. Live data only: rpc/vdr_vendor_report (lp_leads + market assignments + Five9);
// the LP report 135 email is a cross-check, never a blocker.
//
//   GET /vdr/report.xlsx?vendor_id=<id>&as_of=<iso>      (operator token or the LP Supabase service-role key; vdrAuthenticate)
//     200 the .xlsx, plus headers n8n reads:
//         X-VDR-Vendor-Id (n8n checks each file belongs to the vendor it asked for), X-VDR-File-Name, X-VDR-Lead-Count, X-VDR-Summary (JSON totals), X-VDR-Lead-Synced-At,
//         X-VDR-Window (start..end), X-VDR-Feed-Leads / X-VDR-Feed-Received-At (the 135 cross-check, when a
//         complete saved feed from the last 36 hours exists; absent otherwise)
//     400 bad vendor_id / as_of · 404 unknown vendor · 500 the database read failed
//
// It never sends anything and never writes: the freshness gate, the cross-check verdict and the send log are n8n's.

import { createHash } from 'node:crypto';
import { denyAll, safeEqual } from '../auth.js';
import { buildVendorWorkbook } from './report-xlsx.js';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Who may download a workbook (2026-10-15). It carries every lead's name, phone, email and address, so this route
 * never runs on the shared soft-launch check: with AUTH_SOFT_LAUNCH=true in production, a request with no token was
 * answered with the full Modernize file. Two keys open it, nothing else:
 *   - the operator bearer token (MCP_AUTH_TOKEN), compared in constant time;
 *   - a Supabase SERVICE-ROLE key of the LP project, which is what n8n's "LP Supabase" credential sends. It already
 *     reads every row this report is built from, so accepting it opens nothing new, and it keeps the n8n relay off
 *     MCP_AUTH_TOKEN (index.js: "the n8n relay must not hold the key to every admin route"). The key is proven by
 *     asking the database: vdr_vendor_config is readable by service_role only (RLS on, no grant to anon or
 *     authenticated), so a key that reads a row is a service-role key. A verdict is cached for 10 minutes by a hash
 *     of the key (1 minute when refused), never the key itself.
 * No token configured and no way to verify a key → 503. Anything else → 401.
 */
const KEY_CACHE = new Map();   // sha256(key) -> { ok, until }
const OK_TTL_MS = 10 * 60 * 1000;
const NO_TTL_MS = 60 * 1000;

export async function defaultVerifyServiceKey(key, { fetchImpl = fetch, url = process.env.SUPABASE_URL } = {}) {
  if (!url) return false;
  const res = await fetchImpl(`${url.replace(/\/$/, '')}/rest/v1/vdr_vendor_config?select=id&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return false;
  const rows = await res.json().catch(() => null);
  return Array.isArray(rows) && rows.length > 0;
}

export function vdrAuthenticate({ token = null, verifyServiceKey = defaultVerifyServiceKey, canVerify = !!process.env.SUPABASE_URL, now = () => Date.now() } = {}) {
  return async function vdrAuth(req, res, next) {
    const h = String(req.headers.authorization || '');
    const bearer = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (token && bearer && safeEqual(bearer, token)) return next();
    if (!token && !canVerify) return res.status(503).json({ error: 'auth_not_configured' });
    if (bearer && canVerify) {
      const k = createHash('sha256').update(bearer).digest('hex');
      const hit = KEY_CACHE.get(k);
      let ok = hit && hit.until > now() ? hit.ok : null;
      if (ok === null) {
        try { ok = await verifyServiceKey(bearer); } catch (err) { console.warn(`[VDR] service-key check failed: ${err.message}`); ok = false; }
        KEY_CACHE.set(k, { ok, until: now() + (ok ? OK_TTL_MS : NO_TTL_MS) });
      }
      if (ok) return next();
    }
    console.warn(`[VDR] REJECTED ${req.method} ${req.path} from ${req.ip} (${bearer ? 'bad_key' : 'missing_token'})`);
    return res.status(401).json({ error: 'Unauthorized' });
  };
}
export function _resetVdrKeyCache() { KEY_CACHE.clear(); }

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
