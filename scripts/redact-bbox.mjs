import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

/**
 * Structure-preserving redaction of `pdftotext -bbox-layout` output.
 *
 * Masks PII GLYPHS ONLY. Coordinates, token counts and line-wrap points are
 * untouched, so every hazard the fixture exists to test survives: mid-token
 * email wraps, malformed phones, blank names, the interleaved Answering/Machine
 * result, duplicate prosp numbers, band structure.
 *
 * NEVER masked: anything numeric (prosp #, dates, dial counts, band totals),
 * `Totals:` lines in their entirety, band labels, the column header, and page
 * furniture — those are exactly what the goldens assert.
 */
const src = readFileSync(process.argv[2], "utf8");
const limit = process.argv[4] ? Number(process.argv[4]) : 0;

const B = { name: [55.1, 127.8], addr: [301.8, 421.8], phoneEmail: [176.6, 259.8] };
const inBand = (x, [lo, hi]) => x >= lo && x < hi;
const WORD = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="[\d.]+" yMax="[\d.]+">([\s\S]*?)<\/word>/g;

let pages = src.split(/(?=<page\b)/);
const head = pages.shift();
if (limit) pages = pages.slice(0, limit);

const masked = { name: 0, addr: 0, phone: 0, email: 0 };
const body = pages.map((page) => {
  // y-values of any line carrying `Totals:` — those lines are left verbatim.
  const totalsY = new Set();
  let m;
  WORD.lastIndex = 0;
  while ((m = WORD.exec(page)) !== null) if (m[3] === "Totals:") totalsY.add(Math.round(Number(m[2])));
  const nearTotals = (y) => [...totalsY].some((t) => Math.abs(t - y) <= 3);

  WORD.lastIndex = 0;
  return page.replace(
    /(<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="[\d.]+" yMax="[\d.]+">)([\s\S]*?)(<\/word>)/g,
    (_, open, xs, ys, text, close) => {
      const x = Number(xs), y = Number(ys), t = text;
      if (y < 180) return open + t + close;                    // header + title furniture
      if (nearTotals(y)) return open + t + close;              // band label + printed count
      if (/^[\d,.\-/$]+$/.test(t)) return open + t + close;    // prosp #, dates, counts
      if (t.includes("@")) { masked.email++; return open + t.replace(/[^@.]+/g, (p, i) => (i === 0 ? "x".repeat(p.length) : p)) + close; }
      if (inBand(x, B.phoneEmail) && /\d/.test(t)) { masked.phone++; return open + t.replace(/\d/g, "5") + close; }
      const hide = (s) => s[0] + "x".repeat(Math.max(0, s.length - 1));
      if (inBand(x, B.addr) && /^[A-Za-z][A-Za-z.'\-]*$/.test(t) && !/^[A-Z]{2}$/.test(t)) { masked.addr++; return open + hide(t) + close; }
      if (inBand(x, B.name) && /^[A-Za-z][A-Za-z.'\- ]*$/.test(t)) { masked.name++; return open + hide(t) + close; }
      return open + t + close;
    }
  );
}).join("");

const out = head + body + (limit ? "\n</doc>\n</body>\n</html>\n" : "");
writeFileSync(process.argv[3], out);
console.log(`pages=${pages.length} gzip=${gzipSync(out).length}`, JSON.stringify(masked));
