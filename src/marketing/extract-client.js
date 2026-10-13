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
 * 2026-10-13 (the user: "ensure our system can reliably extract information and
 * data from emails in various formats"). Read in-process, no service:
 *   - an HTML body or .htm/.html file (tags, scripts and styles out, entities
 *     decoded, table cells kept apart, link targets kept so a OneDrive link
 *     can be named);
 *   - a Word .docx (word/document.xml);
 *   - a forwarded email (.eml / message/rfc822): its text AND every attachment
 *     inside it, a PDF in it going to the service like any other PDF.
 * Old binary Office files (.xls, .doc, Outlook .msg) cannot be read here; they
 * come back kind 'unsupported' so the ingest can say "save it as PDF" instead
 * of making a junk card.
 *
 * Sync for small files; `POST /v1/jobs` with kind=extract past
 * MKT_EXTRACT_SYNC_MAX_PAGES (10) pages. 429 / 503 on a poll are transient,
 * like createSpeechApiTranscriber; a 404 means the job store forgot the job.
 */
import { parseCsv } from '../jobs/lp-report-csv-common.js';
import { MONEY_RX } from './invoice-triage.js';

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
  if (head.subarray(0, 6).toString('latin1') === 'GIF87a' || head.subarray(0, 6).toString('latin1') === 'GIF89a') return 'image';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image';
  if (head.subarray(0, 2).toString('latin1') === 'BM' && /\.bmp$|image\/bmp/.test(name + mime)) return 'image';
  if (head.subarray(0, 2).toString('latin1') === 'PK') {
    if (/\.xlsx$/.test(name) || /spreadsheet/.test(mime)) return 'xlsx';
    if (/\.docx$/.test(name) || /wordprocessingml/.test(mime)) return 'docx';
    return 'zip'; // an Office file with an odd name: extractDocument looks inside
  }
  // Old binary Office (compound file): .xls, .doc, Outlook .msg. Not readable here.
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return 'unsupported';
  if (/\.(xls|doc|msg|xlsb|numbers|pages)$/.test(name)) return 'unsupported';
  if (/\.csv$/.test(name) || mime === 'text/csv') return 'csv';
  if (/\.pdf$/.test(name) || mime === 'application/pdf') return 'pdf';
  if (/\.(png|jpe?g|tiff?|heic|gif|webp|bmp)$/.test(name) || /^image\//.test(mime)) return 'image';
  if (/\.xlsx$/.test(name)) return 'xlsx';
  if (/\.docx$/.test(name)) return 'docx';
  if (/\.eml$/.test(name) || mime === 'message/rfc822') return 'eml';
  if (/\.html?$/.test(name) || mime === 'text/html') return 'html';
  const start = Buffer.isBuffer(buffer) ? buffer.subarray(0, 2000).toString('utf8') : '';
  if (/^\s*(<!doctype html|<html\b)/i.test(start)) return 'html';
  if (/^(?:[A-Za-z-]+:[^\n]*\r?\n)+/.test(start) && /^(?:mime-version|content-type|received|from|subject):/im.test(start) && /^content-type:/im.test(start)) return 'eml';
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

// ─── HTML, Word and forwarded email (2026-10-13) ─────────────────────────────

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', dollar: '$', copy: '©', reg: '®', trade: '™', bull: '•', middot: '·', euro: '€', pound: '£', cent: '¢', times: '×',
};

/** "&amp;" / "&#36;" / "&#x24;" → the character. Unknown names are left as written. */
export function decodeEntities(text) {
  return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const looksLikeHtml = (s) => /<\/?(?:html|body|div|p|table|tr|td|span|br|a)\b[^>]*>/i.test(String(s || ''));

/** HTML → readable text: one line per block, table cells as " | ", a link's target kept in parentheses. */
export function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => (/^https?:/i.test(href) ? `${inner} (${href})` : inner));
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:p|div|tr|li|h[1-6]|table|section|article|blockquote|header|footer)>/gi, '\n').replace(/<\/t[dh]>/gi, ' | ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s.split(/\r?\n/)
    .map((l) => l.replace(/[ \t\u00a0\u200b]+/g, ' ').replace(/^\s*\|\s*|\s*\|\s*$/g, '').trim())
    .filter(Boolean).join('\n');
}

/**
 * The text of an email body. Gmail gives a plain part, an HTML part, or both;
 * a forward from Outlook often has amounts only in the HTML table. The part
 * that names an amount wins; otherwise the longer one.
 */
export function cleanEmailBody(text, html = null) {
  const t = text == null ? '' : (looksLikeHtml(text) ? htmlToText(text) : decodeEntities(String(text)));
  const h = html ? htmlToText(html) : '';
  if (MONEY_RX.test(t)) return t;
  if (MONEY_RX.test(h)) return h;
  return h.length > t.length ? h : t;
}

/** A Word .docx → text (paragraphs as lines, table cells as " | "). */
export async function docxToText(buffer) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);
  const f = zip.file('word/document.xml');
  if (!f) throw new Error('docx: no word/document.xml');
  let xml = await f.async('string');
  // One line per table row, its cells joined by " | " (each cell holds its own
  // paragraphs, which would otherwise break the row into one line per cell).
  xml = xml.replace(/<w:tr\b[\s\S]*?<\/w:tr>/g, (row) => `${[...row.matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)]
    .map((c) => c[0].replace(/<\/w:p>/g, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).join(' | ')}</w:p>`);
  const text = decodeEntities(xml.replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<\/w:tc>/g, ' | ').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, ''))
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').replace(/\s*\|\s*$/, '').trim()).filter(Boolean).join('\n');
  return { text, meta: { format: 'docx', page_count: 1, ocr_pages: 0, engine: 'docx', chars: text.length }, tables: [] };
}

/** Which Office file a zip really is (an attachment with an odd name). */
async function zipKind(buffer) {
  try {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buffer);
    if (zip.file('word/document.xml')) return 'docx';
    if (zip.file('xl/workbook.xml')) return 'xlsx';
  } catch { /* not a zip we can read */ }
  return 'unsupported';
}

function parseMimeHeaders(block) {
  const out = {};
  const lines = String(block || '').replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/);
  for (const l of lines) {
    const i = l.indexOf(':');
    if (i > 0) out[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  return out;
}
const headerParam = (value, name) => {
  const m = new RegExp(`${name}\\*?=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(String(value || ''));
  return m ? (m[1] ?? m[2]) : null;
};
function decodeTransfer(body, encoding) {
  const enc = String(encoding || '').toLowerCase();
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64');
  if (enc === 'quoted-printable') {
    const qp = body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(qp, 'latin1');
  }
  return Buffer.from(body, 'latin1');
}

/** Walk a MIME message (latin1 string) into leaf parts { type, filename, disposition, data }. */
export function mimeParts(raw, depth = 0, out = []) {
  const split = /\r?\n\r?\n/.exec(raw);
  const headers = parseMimeHeaders(split ? raw.slice(0, split.index) : raw);
  const body = split ? raw.slice(split.index + split[0].length) : '';
  const ctype = headers['content-type'] || 'text/plain';
  const type = ctype.split(';')[0].trim().toLowerCase();
  if (type.startsWith('multipart/') && depth < 6) {
    const boundary = headerParam(ctype, 'boundary');
    if (boundary) {
      const pieces = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`));
      for (const p of pieces.slice(1)) if (p.trim()) mimeParts(p, depth + 1, out);
      return out;
    }
  }
  const disposition = (headers['content-disposition'] || '').split(';')[0].trim().toLowerCase() || null;
  const filename = headerParam(headers['content-disposition'], 'filename') || headerParam(ctype, 'name');
  out.push({ type, filename, disposition, contentId: headers['content-id'] || null, data: decodeTransfer(body, headers['content-transfer-encoding']), headers: depth === 0 ? headers : null });
  return out;
}

/**
 * A forwarded email (.eml): its own text plus every attachment inside it,
 * each read by extractDocument (a PDF goes to the service). Inline images and
 * small images are logos, as in n8n's own selection.
 */
export async function emlToText(buffer, deps = {}, depth = 0) {
  const raw = buffer.toString('latin1');
  const top = parseMimeHeaders((/\r?\n\r?\n/.exec(raw) ? raw.slice(0, /\r?\n\r?\n/.exec(raw).index) : raw));
  const parts = mimeParts(raw);
  const plain = parts.filter((p) => p.type === 'text/plain' && !p.filename).map((p) => p.data.toString('utf8'));
  const html = parts.filter((p) => p.type === 'text/html' && !p.filename).map((p) => p.data.toString('utf8'));
  const sections = [];
  const head = ['from', 'subject', 'date'].filter((k) => top[k]).map((k) => `${k[0].toUpperCase()}${k.slice(1)}: ${top[k]}`).join('\n');
  if (head) sections.push(head);
  const bodyText = cleanEmailBody(plain.join('\n'), html.join('\n'));
  if (bodyText) sections.push(bodyText);
  const meta = { format: 'eml', page_count: 1, ocr_pages: 0, engine: 'eml', attachments: [] };
  for (const p of parts) {
    const isAttachment = p.filename || (p.type !== 'text/plain' && p.type !== 'text/html');
    if (!isAttachment) continue;
    const kind = p.type === 'message/rfc822' ? 'eml' : documentKind(p.data, { fileName: p.filename || '', mimeType: p.type });
    if (kind === 'image' && (p.disposition === 'inline' || p.contentId || p.data.length < 50 * 1024)) continue;
    if (kind === 'eml' && depth >= 2) continue;
    try {
      const inner = kind === 'eml' ? await emlToText(p.data, deps, depth + 1) : await extractDocument(p.data, { fileName: p.filename || '', mimeType: p.type }, deps);
      if (inner.kind === 'unsupported' || !String(inner.text || '').trim()) { meta.attachments.push({ name: p.filename, kind: inner.kind || kind, read: false }); continue; }
      sections.push(`--- attachment: ${p.filename || p.type} ---\n${inner.text}`);
      meta.page_count += inner.meta?.page_count || 0;
      meta.ocr_pages += inner.meta?.ocr_pages || 0;
      meta.attachments.push({ name: p.filename, kind: inner.kind || kind, read: true });
    } catch (err) {
      // A part that failed for a passing reason (the service is down) fails the
      // whole email so n8n retries it; a part that cannot be read is skipped.
      if (/\((?:429|5\d\d)\)|timed out|timeout|aborted|ECONN|fetch failed|not configured/i.test(String(err?.message || err))) throw err;
      meta.attachments.push({ name: p.filename, kind, read: false, error: String(err?.message || err).slice(0, 200) });
    }
  }
  const text = sections.join('\n\n');
  return { kind: 'eml', text, meta: { ...meta, chars: text.length }, tables: [] };
}

/**
 * The one entry point: any supported file or a body text → { text, meta, tables, kind }.
 */
export async function extractDocument(buffer, { fileName = '', mimeType = '', bodyText = null, bodyHtml = null } = {}, deps = {}) {
  if ((bodyText != null || bodyHtml != null) && (!buffer || !buffer.length)) {
    const text = cleanEmailBody(bodyText, bodyHtml);
    return { kind: 'text', text, meta: { format: 'email_body', page_count: 1, ocr_pages: 0, engine: 'email_body', chars: text.length }, tables: [] };
  }
  let kind = documentKind(buffer, { fileName, mimeType });
  if (kind === 'zip') kind = await zipKind(buffer);
  if (kind === 'unsupported') {
    const ext = (/\.([a-z0-9]{2,5})$/i.exec(fileName || '')?.[1] || (buffer[0] === 0xd0 ? 'old Office' : 'unknown')).toLowerCase();
    return { kind, text: '', meta: { format: ext, page_count: 0, ocr_pages: 0, engine: 'none', chars: 0 }, tables: [] };
  }
  if (kind === 'csv') return { kind, ...csvToText(buffer) };
  if (kind === 'xlsx') return { kind, ...(await xlsxToText(buffer)) };
  if (kind === 'docx') return { kind, ...(await docxToText(buffer)) };
  if (kind === 'eml') return emlToText(buffer, deps);
  if (kind === 'html') {
    const text = htmlToText(buffer.toString('utf8'));
    return { kind: 'text', text, meta: { format: 'html', page_count: 1, ocr_pages: 0, engine: 'html', chars: text.length }, tables: [] };
  }
  if (kind === 'text') {
    const raw = buffer.toString('utf8');
    const text = looksLikeHtml(raw) ? htmlToText(raw) : decodeEntities(raw);
    return { kind, text, meta: { format: 'text', page_count: 1, ocr_pages: 0, engine: 'text', chars: text.length }, tables: [] };
  }
  const extractor = deps.extractViaService || extractViaService;
  const out = await extractor(buffer, { fileName, mimeType }, deps);
  console.log(`${LOG} ${kind} ${fileName || ''}: ${out.meta.page_count} page(s), ${out.meta.ocr_pages} OCR, ${out.text.length} chars`);
  return { kind, ...out };
}
