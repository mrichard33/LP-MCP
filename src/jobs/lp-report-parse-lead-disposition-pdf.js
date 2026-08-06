// ─── Lead Disposition Detail (report 135, PDF) — src/jobs/lp-report-parse-lead-disposition-pdf.js ───
//
// PURE. Parses the LP "Lead Disposition Detail 2" PDF from `pdftotext
// -bbox-layout` XML by COORDINATE CLUSTERING. Verified against the real
// 2026-08-06 emailed file (100 pages, 1,194 detail rows).
//
// WHY NOT -layout. Continuation fragments from different columns interleave on
// the same physical line. On page 1, prosp 449705:
//
//     449705  (727)804-2365  08/01/26   Iheart       Data  15 Answering
//                       ,               Simpletext                Machine
//
// `Answering` and `Machine` are ONE Last Result value split across lines, and
// the second line also carries an address comma and a sub-source. Any parser
// that joins lines mangles this. Assigning each word to the column band
// containing its xMin puts `Machine` in Result regardless of which line it
// printed on. That is the whole design.
//
// THIS REPORT IS AUTHORITATIVE FOR LEADS BY MARKET — and Leads is a ROW COUNT.
// LP's own Totals count rows, so nothing here may dedupe: Prosp # repeats
// (449816 3×, 449759 3×, 450442 3×) and two prospects appear in two different
// market bands. Row identity is (snapshot_id, row_ordinal).
//
// NO MONEY COLUMNS — the whole-dollar display_rounding allowance that Reports A
// and B carry does not apply here. The only fail-closed gate is the count.

const ROW_KEYS = ['market', 'lastName', 'prosp', 'phoneEmail', 'entryDate',
  'address', 'sourceSub', 'promoter', 'dispo', 'dials', 'result'];

/**
 * The two header lines, each in x order. Matched EXACTLY — a change to either
 * fails the file closed rather than silently shifting every column.
 *   line A (upper): fragments whose partner sits on line B
 *   line B (lower): includes `Market`, displaced down from its own column
 */
const HEADER_A = ['Phone/', 'Entry', 'Source/', 'Current', '#', 'Last'];
const HEADER_B = ['Market', 'LastName', 'Prosp', '#', 'Email', 'Date', 'Address',
  'Sub', 'Source', 'Promoter', 'Dispo', 'Dials', 'Result'];

/** Which header words define each column's extent, as (line, index) pairs. */
const COLUMN_ANCHORS = [
  { key: 'market', a: [], b: [0] },
  { key: 'lastName', a: [], b: [1] },
  { key: 'prosp', a: [], b: [2, 3] },
  { key: 'phoneEmail', a: [0], b: [4] },
  { key: 'entryDate', a: [1], b: [5] },
  { key: 'address', a: [], b: [6] },
  { key: 'sourceSub', a: [2], b: [7, 8] },
  { key: 'promoter', a: [], b: [9] },
  { key: 'dispo', a: [3], b: [10] },
  { key: 'dials', a: [4], b: [11] },
  { key: 'result', a: [5], b: [12] },
];

// ── Controlled vocabularies (observed 2026-08-06) ───────────────────────────
// Store raw, log unmapped, DO NOT fail closed. Report 133 is failing 25× a day
// on `unmapped_status`; a vocabulary surprise here writes a warning and the
// snapshot still lands. Only the count checksum is fail-closed.

export const LD_DISPO_VOCAB = ['Data', 'Set', 'CXL', 'DNC', 'Cnf', 'Verif',
  'Issue', 'Sale', 'OPPFDN', 'CCC', 'NIS', 'NoHome', 'No Demo', '1Leg', 'NoRehash'];

export const LD_RESULT_VOCAB = ['Hung Up', 'No Answer', 'No Interest Now',
  'Answering Machine', "Can't Do Project", 'Asked DNC', 'Op Intercept', 'Busy',
  'CallBack Set', 'Confirmed', 'Verified', 'Appointment', 'Left VoiceMail',
  'Bought Competition', 'Renter/Mobile Home', 'Dropped on Hold',
  'Foreign Language', 'Bad Data', 'Below Minimum', 'Trans to 3rd Party'];

export const LD_SOURCE_VOCAB = ['Internet', 'Website', 'Main Website', 'Iheart',
  'Affiliates', 'Canvass', 'Canvass Sticky', 'PrevCust', 'SelfGenerated',
  'CustRef', 'Magazine', 'Events 2026'];

/**
 * Normalize a vocabulary value for comparison.
 *
 * The typographic apostrophe (U+2019) is folded to ASCII. NOTE: the real
 * 2026-08-06 file uses ASCII U+0027 — `Can't` is 43 61 6e 27 74 — so matching
 * ONLY the typographic form would have missed every `Can't Do Project` row.
 * Both are folded so either rendering matches whichever the vocabulary uses.
 */
export const normalizeVocab = (s) =>
  String(s ?? '').replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim();

const VOCAB_INDEX = (list) => new Map(list.map((v) => [normalizeVocab(v).toLowerCase(), v]));
const DISPO_INDEX = VOCAB_INDEX(LD_DISPO_VOCAB);
const RESULT_INDEX = VOCAB_INDEX(LD_RESULT_VOCAB);
const SOURCE_INDEX = VOCAB_INDEX(LD_SOURCE_VOCAB);

/** Sentinel for the leading band that carries no label. NEVER null — a NULL
 *  branch is silently dropped by downstream joins and 70 leads vanish. */
export const UNASSIGNED_BAND = 'UNASSIGNED';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

const decodeEntities = (s) =>
  String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const WORD_RE = /<word xMin="([\d.eE+-]+)" yMin="([\d.eE+-]+)" xMax="([\d.eE+-]+)" yMax="([\d.eE+-]+)">([\s\S]*?)<\/word>/g;

/**
 * `pdftotext -bbox-layout` XHTML → pages of positioned words. Pure, so the
 * clustering below is unit-testable without a PDF or a poppler shell-out.
 */
export function parseBboxPages(xml) {
  const chunks = String(xml ?? '').split(/<page\b/).slice(1);
  return chunks.map((chunk) => {
    const dims = chunk.match(/width="([\d.]+)"\s+height="([\d.]+)"/);
    const words = [];
    let m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(chunk)) !== null) {
      const text = decodeEntities(m[5]);
      if (!text.trim()) continue;
      words.push({ text, x: Number(m[1]), y: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]) });
    }
    return { width: dims ? Number(dims[1]) : 0, height: dims ? Number(dims[2]) : 0, words };
  });
}

/** Group words into visual lines by y, tolerant of sub-pixel baseline drift. */
function toLines(words, tol = 3) {
  const sorted = [...words].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const w of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(w.y - last.y) <= tol) { last.words.push(w); continue; }
    lines.push({ y: w.y, words: [w] });
  }
  for (const l of lines) l.words.sort((a, b) => a.x - b.x);
  return lines;
}

const lineText = (line) => line.words.map((w) => w.text).join(' ');

/**
 * Page furniture, dropped by CONTENT match rather than by y — a report that
 * grows a line would otherwise shift every offset.
 */
/** Footer furniture, as patterns that may appear ANYWHERE in a line. */
const FURNITURE_FRAGMENTS = [
  /\bPage\s+\d+\s+of\s+\d+\b/i,
  /\bUser:.*$/i,                                       // `User:Bob Rubertone` — no space after the colon
  /\b\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)\b/i,
];

/**
 * Page furniture, dropped by CONTENT rather than by y — a report that grows a
 * line would otherwise shift every offset.
 *
 * Fragment-stripping, not whole-line matching: the run stamp and the page
 * number print 1.5pt apart vertically, so they cluster into ONE line reading
 * `8/6/2026 7:00AM Page 1 of 100`. Anchored patterns missed it, and because the
 * page footer sits at both x-extremes those words landed in the Market and Last
 * Result bands of whichever row was still open — appending `Page 1 of 100` to
 * the last Last Result on all 100 pages.
 */
function isFurniture(line) {
  const t = lineText(line).trim();
  if (t === 'Lead Disposition Detail') return true;
  if (/^[A-Z][a-z]+day,/.test(t) && /\bthrough\b/.test(t)) return true;
  if (/^Sources:/.test(t)) return true;
  if (/^Market:\s*ALL/.test(t)) return true;
  let rest = t;
  for (const re of FURNITURE_FRAGMENTS) rest = rest.replace(re, ' ');
  return !rest.trim();
}

/**
 * Column x-boundaries, derived from the header ONCE per page.
 *
 * A boundary is the MIDPOINT between one column's right edge and the next
 * column's left edge — not the midpoint of their left edges. `# Dials` is
 * right-aligned, so a single-digit count prints at x≈682 while the `Dials`
 * header starts at x≈663; midpoint-of-starts would put that digit in Last
 * Result. Midpoint-of-adjacent-extents places it correctly.
 */
export function deriveColumns(page) {
  const lines = toLines(page.words);
  let ia = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    const a = lines[i].words.map((w) => w.text);
    const b = lines[i + 1].words.map((w) => w.text);
    if (a.join('') === HEADER_A.join('') && b.join('') === HEADER_B.join('')) { ia = i; break; }
  }
  if (ia < 0) {
    return { error: 'header_not_found', detail: { expectedA: HEADER_A, expectedB: HEADER_B } };
  }
  const A = lines[ia].words;
  const B = lines[ia + 1].words;

  const extents = COLUMN_ANCHORS.map(({ key, a, b }) => {
    const ws = [...a.map((i) => A[i]), ...b.map((i) => B[i])];
    return { key, xMin: Math.min(...ws.map((w) => w.x)), xMax: Math.max(...ws.map((w) => w.x2)) };
  });
  for (let i = 1; i < extents.length; i++) {
    if (!(extents[i].xMin > extents[i - 1].xMax)) {
      return { error: 'header_columns_overlap', detail: { at: extents[i].key } };
    }
  }
  // A column runs from its own left edge to the NEXT column's left edge — the
  // header WORD does not span the column it labels. `Address` is 41pt wide as a
  // word but its column is 120pt, and `9807 Pavarotti Ter Apt 202` fills it: a
  // midpoint-of-extents boundary put the tail of every long address into Source
  // (`"202 Internet"`, `"Blvd Main Website"` — 220 rows) and the tail of every
  // rep promoter suffix into Dispo (`"- Set"`).
  //
  // EPS covers data that starts slightly LEFT of its header word — entry dates
  // print at x≈261.8 under a `Entry`/`Date` header at x≈267.8. It stays small
  // because `# Dials` is right-aligned: a single digit starts at x≈682.5 and
  // must stay left of the Result boundary at 693.1.
  const EPS = 8;
  const bounds = [];
  for (let i = 1; i < extents.length; i++) bounds.push(extents[i].xMin - EPS);
  for (let i = 1; i < bounds.length; i++) {
    if (bounds[i] <= bounds[i - 1]) return { error: 'column_bounds_not_monotonic', detail: { at: extents[i].key, bounds } };
  }
  return { extents, bounds, headerBottom: Math.max(...B.map((w) => w.y2)) };
}

const bandOf = (x, bounds) => {
  let i = 0;
  while (i < bounds.length && x >= bounds[i]) i++;
  return ROW_KEYS[i];
};

/** `Saturday, August 1, 2026 through Monday, August 31, 2026` → ISO pair. */
export function parseWindowLine(text) {
  const re = /([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{4})/g;
  const hits = [];
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) {
    const mi = MONTHS.indexOf(m[1].toLowerCase());
    if (mi < 0) continue;
    hits.push(`${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`);
  }
  return { periodStart: hits[0] ?? null, periodEnd: hits[1] ?? null };
}

/** `8/6/2026 7:00AM` → ISO date (ET; the report is generated in ET). */
function parseGeneratedDate(text) {
  // Non-anchored: the stamp shares a cluster with `Page N of M`.
  const m = String(text ?? '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+\d{1,2}:\d{2}\s*(?:AM|PM)/i);
  if (!m) return null;
  return `${m[3]}-${String(Number(m[1])).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

/** `08/03/26` → ISO. LP prints two-digit years; 20xx throughout. */
function parseEntryDate(text) {
  const m = String(text ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!m) return null;
  return `20${m[3]}-${String(Number(m[1])).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

/**
 * Phone/Email band → { phone, email }.
 *
 * Both wrap, and they wrap DIFFERENTLY. A phone continuation is a separate
 * chunk of the same free-text value (`( 91)786-2005` + `030`) and rejoins with
 * a space; an email continuation is the tail of one token
 * (`project@thesolarvoltaic.co` + `m`) and MUST rejoin with nothing, or the
 * address is silently corrupted into `…co m`.
 *
 * Phone is never validated — real values include `( 91)786-2005 030`,
 * `234567890`, `((31)5)3-23-5449` and `(999)999-9999`.
 */
export function splitPhoneEmail(bandLines) {
  const texts = bandLines.map((l) => l.map((w) => w.text).join(' '));
  const at = texts.findIndex((t) => t.includes('@'));
  if (at < 0) {
    const phone = texts.join(' ').trim();
    return { phone: phone || null, email: null };
  }
  const phone = texts.slice(0, at).join(' ').trim();
  const email = texts.slice(at).join('').replace(/\s+/g, '').trim();
  return { phone: phone || null, email: email || null };
}

/** `123 Main St` + `Boynton Beach, FL 33437` → parts. Address is often just `,`. */
export function splitAddress(joined) {
  const raw = String(joined ?? '').replace(/\s+/g, ' ').trim();
  if (!raw || raw === ',') return { address: null, city: null, state: null, zip: null };
  const m = raw.match(/^(.*?),?\s*([A-Za-z .'\-]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (!m) return { address: raw, city: null, state: null, zip: null };
  return {
    address: m[1].replace(/,\s*$/, '').trim() || null,
    city: m[2].trim() || null,
    state: m[3],
    zip: m[4],
  };
}

/**
 * Promoter shape. Rep promoters carry a territory suffix (`Sheehan, Jack - ORL`)
 * that FREQUENTLY DISAGREES with the band it sits in — `Muldoon, Joshua - SARA`
 * appears inside FTMYR, `Pettus, Brandon - FTM` inside SAR, TAMPA-suffixed reps
 * inside STPET. The suffix is a rep's territory, not the lead's market, and it
 * is never used to set one. TAMPA in particular is not a market at all.
 */
export function classifyPromoter(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  return /-\s*[A-Z]{2,6}$/.test(t) ? 'rep' : 'channel';
}

/**
 * Junk that LP counts in its own Totals. FLAG, never filter — filtering here
 * would break the checksum and undercount leads. Downstream decides.
 *
 * Observed markers, 2026-08-06 (106 of 1,194 rows): fake@gmail.com ×82,
 * real@gmail.com ×10, test23433@343.com ×3, na@gmail.com ×3, none@gmail.com,
 * test@test.com, last names Test/test/fake, and the internal test prospect
 * promoted by `Richard, Mark`.
 */
const TEST_EMAILS = new Set(['fake@gmail.com', 'test@test.com', 'real@gmail.com',
  'none@gmail.com', 'na@gmail.com']);
const TEST_PROMOTERS = new Set(['richard, mark']);
function isTestRow(row) {
  const email = (row.email_raw ?? '').trim().toLowerCase();
  const name = (row.last_name ?? '').trim().toLowerCase();
  const promoter = (row.promoter_raw ?? '').trim().toLowerCase();
  return TEST_EMAILS.has(email)
    || /^test\d*@/.test(email)
    || name === 'test' || name === 'fake'
    || TEST_PROMOTERS.has(promoter);
}

const mapVocab = (index, raw) => {
  const t = normalizeVocab(raw);
  if (!t) return { value: null, mapped: true };
  const hit = index.get(t.toLowerCase());
  return hit ? { value: hit, mapped: true } : { value: t, mapped: false };
};

/**
 * Parse the 135 PDF from `pdftotext -bbox-layout` XML.
 *
 * @returns {{ rows:object[], header:{periodStart,periodEnd,asOf,scope},
 *             bands:{label:string,printed:number,parsed:number}[],
 *             grandTotalPrinted:number|null, warnings:object[], error?:string }}
 */
export function parseLeadDispositionPdf(xml) {
  const pages = parseBboxPages(xml);
  const empty = { rows: [], header: { periodStart: null, periodEnd: null, asOf: null, scope: null }, bands: [], grandTotalPrinted: null, warnings: [] };
  if (!pages.length) return { ...empty, error: 'no_pages' };

  const cols = deriveColumns(pages[0]);
  if (cols.error) return { ...empty, error: cols.error, detail: cols.detail };
  const { bounds } = cols;

  // Header text comes from page 1's furniture, before it is stripped.
  const p1Lines = toLines(pages[0].words);
  const windowLine = p1Lines.map(lineText).find((t) => /\bthrough\b/.test(t) && /\d{4}/.test(t));
  const { periodStart, periodEnd } = parseWindowLine(windowLine);
  const stampLine = p1Lines.map((l) => lineText(l).trim()).find((t) => parseGeneratedDate(t));
  const asOf = parseGeneratedDate(stampLine);

  // Column geometry must hold across the file. Sampling a later page catches a
  // layout that drifts mid-report rather than trusting page 1 for 100 pages.
  const warnings = [];
  const sampleIdx = pages.length > 1 ? Math.min(pages.length - 1, Math.floor(pages.length / 2)) : 0;
  if (sampleIdx > 0) {
    const sample = deriveColumns(pages[sampleIdx]);
    if (sample.error) return { ...empty, error: 'header_drift', detail: { page: sampleIdx + 1, ...sample } };
    const drift = sample.bounds.some((b, i) => Math.abs(b - bounds[i]) > 1);
    if (drift) {
      return { ...empty, error: 'column_boundaries_drift', detail: { page: sampleIdx + 1, page1: bounds, sampled: sample.bounds } };
    }
  }

  const rows = [];
  const bands = [];
  let grandTotalPrinted = null;
  let pending = [];          // rows accumulated since the last Totals line
  let openLabel = null;      // the bare label line that opened the current band

  for (let p = 0; p < pages.length; p++) {
    const lines = toLines(pages[p].words).filter((l) => !isFurniture(l));
    // Drop the two column-header lines on every page.
    const hdr = lines.findIndex((l, i) =>
      l.words.map((w) => w.text).join('') === HEADER_A.join('')
      && lines[i + 1]?.words.map((w) => w.text).join('') === HEADER_B.join(''));
    const body = hdr >= 0 ? lines.slice(hdr + 2) : lines;

    // Split the page body into row groups: a new row opens at a line whose
    // Prosp band carries a 4–7 digit number.
    let current = null;
    const flush = () => { if (current) { pending.push(current); current = null; } };

    for (const line of body) {
      const banded = new Map();
      for (const w of line.words) {
        const k = bandOf(w.x, bounds);
        if (!banded.has(k)) banded.set(k, []);
        banded.get(k).push(w);
      }
      const prospWords = banded.get('prosp') ?? [];
      const prospNo = prospWords.map((w) => w.text).find((t) => /^\d{4,7}$/.test(t)) ?? null;
      const hasTotals = prospWords.some((w) => w.text === 'Totals:')
        || (banded.get('lastName') ?? []).some((w) => w.text === 'Totals:')
        || (banded.get('market') ?? []).some((w) => w.text === 'Totals:');

      if (hasTotals) {
        flush();
        const all = line.words.map((w) => w.text);
        const ti = all.indexOf('Totals:');
        const labelWord = ti > 0 ? all[ti - 1] : '';
        const countTok = all.slice(ti + 1).find((t) => /^[\d,]+$/.test(t));
        const printed = countTok ? Number(countTok.replace(/,/g, '')) : null;
        if (/^grand$/i.test(labelWord)) {
          grandTotalPrinted = printed;
        } else {
          const label = labelWord || UNASSIGNED_BAND;
          if (openLabel && label !== UNASSIGNED_BAND && openLabel !== label) {
            warnings.push({ kind: 'band_label_mismatch', detail: { opened: openLabel, closed: label } });
          }
          const ordinalBase = rows.length;
          pending.forEach((r, i) => {
            r.branch_code_raw = label;
            r.branch_band_unlabeled = label === UNASSIGNED_BAND;
            r.row_ordinal = ordinalBase + i;
            rows.push(r);
          });
          bands.push({ label, printed, parsed: pending.length });
          pending = [];
          openLabel = null;
        }
        continue;
      }

      // A lone short token in the Market band, on a line with no prosp number,
      // OPENS the next band. The first band has no such line at all.
      const marketWords = banded.get('market') ?? [];
      if (!prospNo && marketWords.length && line.words.length === marketWords.length) {
        const label = marketWords.map((w) => w.text).join(' ').trim();
        if (/^[A-Z][A-Z0-9 _-]{1,20}$/.test(label)) { flush(); openLabel = label; continue; }
      }

      if (prospNo) { flush(); current = newRow(prospNo); }
      if (!current) continue;
      for (const [k, ws] of banded) {
        if (k === 'prosp') continue;
        (current._bands[k] ??= []).push(ws);
      }
    }
    flush();
  }

  // Rows after the last Totals line never closed a band — surface, never drop.
  if (pending.length) {
    const ordinalBase = rows.length;
    pending.forEach((r, i) => {
      r.branch_code_raw = openLabel || UNASSIGNED_BAND;
      r.branch_band_unlabeled = !openLabel;
      r.row_ordinal = ordinalBase + i;
      rows.push(r);
    });
    warnings.push({ kind: 'rows_after_last_totals', detail: { count: pending.length } });
  }

  for (const r of rows) finalizeRow(r, warnings);

  const scope = periodEnd && asOf && periodEnd > asOf ? 'mtd' : 'custom';
  return {
    rows: rows.map(({ _bands, ...r }) => r),
    header: { periodStart, periodEnd, asOf, scope },
    bands,
    grandTotalPrinted,
    warnings,
  };
}

function newRow(prospNo) {
  return { prosp_no: prospNo, _bands: {} };
}

function joinBand(lists, sep = ' ') {
  return (lists ?? []).map((ws) => ws.map((w) => w.text).join(' ')).join(sep).replace(/\s+/g, ' ').trim();
}

function finalizeRow(r, warnings) {
  const b = r._bands;
  r.last_name = joinBand(b.lastName) || null;      // blank on dozens of rows; one is literally '.'
  const pe = splitPhoneEmail(b.phoneEmail ?? []);
  r.phone_raw = pe.phone;
  r.email_raw = pe.email;
  r.entry_date = parseEntryDate(joinBand(b.entryDate));
  Object.assign(r, splitAddress(joinBand(b.address)));
  r.address_raw = r.address; delete r.address;

  // Source and Sub Source share one column, printed on successive lines — the
  // two-line header (`Source/` over `Sub Source`) is the structure. Both are
  // optional; rows exist with neither.
  const srcLines = (b.sourceSub ?? []).map((ws) => ws.map((w) => w.text).join(' ').trim()).filter(Boolean);
  r.source_raw = srcLines[0] ?? null;
  r.sub_source_raw = srcLines.length > 1 ? srcLines.slice(1).join(' ').replace(/\s+/g, ' ').trim() : null;

  r.promoter_raw = joinBand(b.promoter) || null;
  r.promoter_kind = classifyPromoter(r.promoter_raw);

  const dispo = mapVocab(DISPO_INDEX, joinBand(b.dispo));
  r.current_dispo_raw = dispo.value;
  if (!dispo.mapped) warnings.push({ kind: 'unmapped_dispo', detail: { prosp: r.prosp_no, value: dispo.value } });

  const dialsTok = joinBand(b.dials).replace(/,/g, '');
  r.dials = /^\d+$/.test(dialsTok) ? Number(dialsTok) : null;

  const result = mapVocab(RESULT_INDEX, joinBand(b.result));
  r.last_result_raw = result.value;
  if (!result.mapped) warnings.push({ kind: 'unmapped_last_result', detail: { prosp: r.prosp_no, value: result.value } });

  if (r.source_raw && !SOURCE_INDEX.has(normalizeVocab(r.source_raw).toLowerCase())) {
    warnings.push({ kind: 'unmapped_source', detail: { prosp: r.prosp_no, value: r.source_raw } });
  }
  r.test_row_suspect = isTestRow(r);
}

/**
 * Two-level count gate. COUNTS ONLY are fail-closed: an unmapped vocabulary
 * value is a warning, not a rejection (report 133's `unmapped_status` failure
 * mode is exactly what that avoids).
 */
export function validateLeadDispositionPdf(parsed) {
  const violations = [];
  const reconciliations = [];
  if (parsed.error) {
    violations.push({ rule: parsed.error, detail: parsed.detail ?? {} });
    return { ok: false, violations, reconciliations };
  }
  if (!parsed.rows.length) violations.push({ rule: 'no_detail_rows', detail: { rows: 0 } });

  for (const band of parsed.bands) {
    if (band.printed == null) {
      violations.push({ rule: 'band_total_unreadable', detail: { band: band.label } });
    } else if (band.printed !== band.parsed) {
      violations.push({ rule: 'band_count_mismatch', detail: { band: band.label, printed: band.printed, parsed: band.parsed } });
    }
  }
  if (parsed.grandTotalPrinted == null) {
    violations.push({ rule: 'missing_grand_total', detail: { expected: 'Grand Totals: line' } });
  } else if (parsed.grandTotalPrinted !== parsed.rows.length) {
    violations.push({ rule: 'grand_total_mismatch', detail: { printed: parsed.grandTotalPrinted, parsed: parsed.rows.length } });
  }
  const bandSum = parsed.bands.reduce((a, b) => a + b.parsed, 0);
  if (parsed.grandTotalPrinted != null && bandSum !== parsed.grandTotalPrinted) {
    violations.push({ rule: 'band_sum_mismatch', detail: { bands: bandSum, grand: parsed.grandTotalPrinted } });
  }
  for (const w of parsed.warnings) reconciliations.push({ class: 'parse_warning', scope: w.kind, detail: w.detail });

  return { ok: violations.length === 0, violations, reconciliations };
}

/**
 * Derived facts at BRANCH grain. The display rollup
 * (FTLAU + BOCA + MIAMI + RFED → Fort Lauderdale) happens at READ time, never
 * here — and LAKE is a peer market, not folded into ORL. An absent band is
 * absent, not zero: RFED has no August rows and gets no fact row.
 */
export function leadDispositionFacts(rows) {
  const bump = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);
  const leads = new Map();
  const byDispo = new Map();
  const bySource = new Map();
  const bySubSource = new Map();
  const byEntryDate = new Map();
  const dials = new Map();
  for (const r of rows) {
    const br = r.branch_code_raw ?? UNASSIGNED_BAND;
    bump(leads, br);
    bump(byDispo, `${br}${r.current_dispo_raw ?? ''}`);
    bump(bySource, `${br}${r.source_raw ?? ''}`);
    bump(bySubSource, `${br}${r.sub_source_raw ?? ''}`);
    if (r.entry_date) bump(byEntryDate, `${br}${r.entry_date}`);
    bump(dials, `${br}${r.dials ?? ''}`);
  }
  const split = (m) => [...m].map(([k, count]) => {
    const [branch, value] = k.split('');
    return { branch, value: value || null, count };
  });
  return {
    leads: [...leads].map(([branch, count]) => ({ branch, count })),
    byDispo: split(byDispo),
    bySource: split(bySource),
    bySubSource: split(bySubSource),
    byEntryDate: split(byEntryDate),
    dialsDistribution: split(dials),
  };
}
