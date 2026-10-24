#!/usr/bin/env node
// Website → knowledge-base candidates, review first (the user, 2026-10-23: "extract the data from our website, so
// you have that information to use when speaking with customers"; ruling: the user reviews it before the bot uses it).
//
// Read-only against reecewindows.com: reads page-sitemap.xml, keeps the non-city pages (plus areas-served/ and
// locations/), turns each page into plain text with htmlToText (src/marketing/extract-client.js) and
// stripUnicodeTags (src/text-sanitize.js), drops the site chrome repeated on every page, and writes one .txt per
// page plus index.json to the output folder. It writes nothing to the database: the reviewed answers become
// kb_faqs rows through a seed in sql/seeds/, never raw pages in kb_embeddings (those would reach UNCLEAR and
// pricing turns unreviewed).
//
//   node scripts/website-kb-extract.js <out_dir> [--base=https://reecewindows.com]
import fs from 'node:fs';
import path from 'node:path';
import { htmlToText } from '../src/marketing/extract-client.js';
import { stripUnicodeTags } from '../src/text-sanitize.js';

const args = process.argv.slice(2);
const outDir = args.find(a => !a.startsWith('--'));
const base = (args.find(a => a.startsWith('--base=')) || '--base=https://reecewindows.com').slice(7).replace(/\/$/, '');
if (!outDir) { console.error('usage: node scripts/website-kb-extract.js <out_dir>'); process.exit(1); }

// Pages a customer question could be answered from. Legal, app and test pages are left out.
const SKIP = /\/(terms-and-conditions|sms-mms-program-terms-conditions|privacy-policy|app-linq|micro-app-linq|geotarget|windows-2|home-makeover-2|msflh|categories)\//;
const KEEP_AREAS = /\/(areas-served|locations)\/$/;

/** The page URLs worth reading from a sitemap's XML. Pure. */
export function pageUrls(xml) {
  return [...String(xml).matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim())
    .filter(u => !SKIP.test(u))
    .filter(u => !/\/service-areas\//.test(u) || KEEP_AREAS.test(u));
}

/** The main content of a WordPress page: scripts, styles, nav, header and footer dropped. Pure. */
export function mainHtml(html) {
  let h = String(html);
  const main = h.match(/<main[\s\S]*?<\/main>/i) || h.match(/<article[\s\S]*?<\/article>/i);
  if (main) h = main[0];
  return h.replace(/<(script|style|noscript|nav|header|footer|form|svg)[\s\S]*?<\/\1>/gi, ' ');
}

/** Lines repeated on most pages (menus, footers) are chrome, not content. Pure. */
export function dropRepeatedLines(pages, share = 0.5) {
  const seen = new Map();
  for (const p of pages) for (const l of new Set(p.text.split('\n').map(s => s.trim()).filter(Boolean))) seen.set(l, (seen.get(l) || 0) + 1);
  const limit = Math.max(3, Math.ceil(pages.length * share));
  return pages.map(p => ({ ...p, text: p.text.split('\n').map(s => s.trim()).filter(l => l && (seen.get(l) || 0) < limit).join('\n') }));
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const xml = await (await fetch(`${base}/page-sitemap.xml`)).text();
  const urls = pageUrls(xml);
  const pages = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'ReeceKB-extract/1.0' } });
      if (!res.ok) { console.warn(`skip ${url}: ${res.status}`); continue; }
      const html = await res.text();
      const title = (html.match(/<title>([^<]*)<\/title>/i) || [, ''])[1].replace(/\s+/g, ' ').trim();
      const text = stripUnicodeTags(htmlToText(mainHtml(html))).replace(/\n{3,}/g, '\n\n').trim();
      pages.push({ url, title, text });
    } catch (err) { console.warn(`skip ${url}: ${err.message}`); }
  }
  const clean = dropRepeatedLines(pages);
  const index = clean.map((p, i) => {
    const file = `${String(i + 1).padStart(3, '0')}-${new URL(p.url).pathname.replace(/^\/|\/$/g, '').replace(/[^a-z0-9]+/gi, '-') || 'home'}.txt`;
    fs.writeFileSync(path.join(outDir, file), `${p.title}\n${p.url}\n\n${p.text}\n`);
    return { url: p.url, title: p.title, file, chars: p.text.length };
  });
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`${index.length} pages → ${outDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
