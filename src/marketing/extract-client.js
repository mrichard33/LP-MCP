/**
 * Document text extraction — src/marketing/extract-client.js
 *
 * PDFs and images go to reece-speech-api's FREE `POST /v1/extract` (pdfplumber
 * text layer, Tesseract OCR for scanned pages — D9: no paid model ever sees
 * the file). CSV / XLSX / plain text are read in-process. The result is one
 * shape: { text, meta }, where meta carries pages / method per page /
 * ocr_pages / engine for the card and the OCR-heavy flag.
 *
 * URL and key: MKT_EXTRACT_API_URL / MKT_EXTRACT_API_KEY, falling back to the
 * CI_SPEECH_API_* values the call-intelligence transcriber already uses
 * (src/ci/config.js). Same service, same key, same 30/min rate limit —
 * so the async job poll is 10 s, not 5 (the calls poll two jobs at 5 s).
 *
 * Sync for small files; `POST /v1/jobs` with kind=extract past
 * MKT_EXTRACT_SYNC_MAX_PAGES (10) pages. 429 / 503 on a poll are transient,
 * like createSpeechApiTranscriber; a 404 means the job store forgot the job.
 */
import { parseCsv } from '../jobs/lp-report-csv-common.js';

const LOG = '[MktExtract]';

export function extractConfig(env = process.env) {
  const url = String(env.MKT_EXTRACT_API_URL || env.CI_SPEECH_API_URL || '').trim().replace(/\/+$/, '') || null;
  const apiKey = env.MKT_EXTRACT_API_KEY || env.CI_SPEECH_API_KEY || null;
  return {
    url, apiKey,
    syncMaxPages: Math.max(1, parseInt(env.MKT_EXTRACT_SYNC_MAX_PAGES || '10', 10) || 10),
    pollMs: Math.max(2000, parseInt(env.MKT_EXTRACT_POLL_MS || '10000', 10) || 10000),
    timeoutMs: Math.max(30000, parseInt(env.MKT_EXTRACT_TIMEOUT_MS || '600000', 10) || 600000),
  };
}

/** What kind of document is this, by content first, name second. */
export function documentKind(buffer, { fileName = '', mimeType = '' } = {}) {
  const head = Buffer.isBuffer(buffer) ? buffer.subarray(0, 12) : Buffer.alloc(0);
  const name = String(fileName || '').toLowerCase();
  const mime = String(mimeType || '').toLowerCase();
  if (head.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (head[0] === 0x89 && head.subarray(1, 4).toString('latin1') === 'PNG') return 'image';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image';
  if (head.subarray(0, 4).toString('latin1') === 'II*\0' || head.subarray(0, 4).toString('latin1') === 'MM\0*') return 'image';
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') return 'image'; // HEIC
  if (head.subarray(0, 2).toString('latin1') === 'PK' && (/\.xlsx$/.test(name) || /spreadsheet/.test(mime))) return 'xlsx';
  if (/\.csv$/.test(name) || mime === 'text/csv') return 'csv';
  if (/\.pdf$/.test(name) || mime === 'application/pdf') return 'pdf';
  if (/\.(png|jpe?g|tiff?|heic)$/.test(name) || /^image\//.test(mime)) return 'image';
  if (/\.xlsx$/.test(name)) return 'xlsx';
  return 'text';
}

/** Rough page count from a PDF's /Type /Page objects; null when unreadable. */
export function pdfPageCountGuess(buffer) {
  try {
    const s = buffer.toString('latin1');
    const n = (s.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
    return n || null;
  } catch { return null; }
}

/** CSV → readable text (one line per row, cells joined by " | ") + the grid. */
export function csvToText(buffer) {
  const grid = parseCsv(buffer.toString('utf8')).filter((r) => r.some((c) => String(c).trim()));
  return { text: grid.map((r) => r.map((c) => String(c).trim()).join(' | ')).join('\n'), meta: { format: 'csv', rows: grid.length, page_count: 1, ocr_pages: 0, engine: 'csv' }, tables: [grid] };
}

export async function xlsxToText(buffer) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const lines = [];
  const tables = [];
  wb.eachSheet((ws) => {
    const grid = [];
    lines.push(`## ${ws.name}`);
    ws.eachRow((row) => {
      const cells = row.values.slice(1).map((v) => (v && typeof v === 'object' ? (v.result ?? v.text ?? v.richText?.map((t) => t.text).join('') ?? '') : (v ?? '')));
      grid.push(cells.map(String));
      lines.push(cells.map((c) => String(c).trim()).join(' | '));
    });
    tables.push(grid);
  });
  return { text: lines.join('\n'), meta: { format: 'xlsx', sheets: tables.length, page_count: 1, ocr_pages: 0, engine: 'exceljs' }, tables };
}

function mapExtractResponse(body) {
  const pages = Array.isArray(body?.pages) ? body.pages : [];
  return {
    text: String(body?.text ?? ''),
    meta: {
      format: 'document', page_count: body?.page_count ?? pages.length, ocr_pages: body?.ocr_pages ?? pages.filter((p) => p.method === 'ocr').length,
      engine: body?.engine ?? 'reece-speech-api', seconds: body?.seconds ?? null,
      pages: pages.map((p) => ({ page: p.page, method: p.method, chars: p.chars })),
    },
    tables: pages.flatMap((p) => p.tables || []),
  };
}

/**
 * Send a PDF / image to reece-speech-api. Throws on failure (the ingest marks
 * the document failed and n8n retries on the 5xx).
 */
export async function extractViaService(buffer, { fileName = 'document', mimeType = 'application/octet-stream' } = {}, {
  cfg = extractConfig(), fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), clock = () => Date.now(),
} = {}) {
  if (!cfg.url) throw new Error('MKT_EXTRACT_API_URL / CI_SPEECH_API_URL is not configured');
  if (!cfg.apiKey) throw new Error('MKT_EXTRACT_API_KEY / CI_SPEECH_API_KEY is not configured');
  const headers = { Authorization: `Bearer ${cfg.apiKey}` };
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), fileName || 'document');
  const pages = documentKind(buffer, { fileName, mimeType }) === 'pdf' ? pdfPageCountGuess(buffer) : 1;
  const useJob = (pages || 1) > cfg.syncMaxPages;

  if (!useJob) {
    const res = await fetchImpl(`${cfg.url}/v1/extract`, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(cfg.timeoutMs) });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`extract failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    return mapExtractResponse(await res.json());
  }

  form.append('kind', 'extract');
  const deadline = clock() + cfg.timeoutMs;
  const created = await fetchImpl(`${cfg.url}/v1/jobs`, { method: 'POST', headers, body: form });
  if (!created.ok) {
    const detail = await created.text().catch(() => '');
    throw new Error(`extract job create failed (${created.status}): ${detail.slice(0, 300)}`);
  }
  const jobId = (await created.json())?.job_id;
  if (!jobId) throw new Error('extract job create returned no job id');
  for (;;) {
    await sleep(cfg.pollMs);
    if (clock() > deadline) throw new Error(`extract job ${jobId} timed out after ${Math.round(cfg.timeoutMs / 1000)}s`);
    const res = await fetchImpl(`${cfg.url}/v1/jobs/${encodeURIComponent(jobId)}`, { headers });
    if (res.status === 429 || res.status === 503) continue;
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`extract job ${jobId} poll failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    const job = await res.json();
    if (job?.status === 'done') return mapExtractResponse(job.result || {});
    if (job?.status === 'failed') throw new Error(`extract job ${jobId} failed: ${String(job?.error ?? 'unknown').slice(0, 300)}`);
    if (job?.status !== 'queued' && job?.status !== 'processing') throw new Error(`extract job returned unknown status ${JSON.stringify(job?.status ?? null)}`);
  }
}

/**
 * The one entry point: any supported file or a body text → { text, meta, tables, kind }.
 */
export async function extractDocument(buffer, { fileName = '', mimeType = '', bodyText = null } = {}, deps = {}) {
  if (bodyText != null && (!buffer || !buffer.length)) {
    const text = String(bodyText);
    return { kind: 'text', text, meta: { format: 'email_body', page_count: 1, ocr_pages: 0, engine: 'email_body', chars: text.length }, tables: [] };
  }
  const kind = documentKind(buffer, { fileName, mimeType });
  if (kind === 'csv') return { kind, ...csvToText(buffer) };
  if (kind === 'xlsx') return { kind, ...(await xlsxToText(buffer)) };
  if (kind === 'text') {
    const text = buffer.toString('utf8');
    return { kind, text, meta: { format: 'text', page_count: 1, ocr_pages: 0, engine: 'text', chars: text.length }, tables: [] };
  }
  const extractor = deps.extractViaService || extractViaService;
  const out = await extractor(buffer, { fileName, mimeType }, deps);
  console.log(`${LOG} ${kind} ${fileName || ''}: ${out.meta.page_count} page(s), ${out.meta.ocr_pages} OCR, ${out.text.length} chars`);
  return { kind, ...out };
}
