#!/usr/bin/env node
/**
 * Run one hybrid memory search from the command line and print both legs.
 * Every run in shadow/live mode writes a memory_vector_queries row — this is
 * how shadow evidence is gathered before priority #8 wraps the search as an
 * MCP tool.
 *
 *   node scripts/memory-search.js "appointment title"
 *   node scripts/memory-search.js "why did we stop double-writing decisions" --mode shadow --limit 10
 *   node scripts/memory-search.js "LightFire payroll" --area payroll-callcenter --kind decision
 *
 * --mode overrides MEMORY_VECTOR_MODE for this run only.
 */
import 'dotenv/config';
import { hybridMemorySearch } from '../src/memory/memory-search.js';

const args = process.argv.slice(2);
const query = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') === false || args.indexOf(a) === 0);
const val = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
if (!query) { console.error('usage: node scripts/memory-search.js "<query>" [--mode off|shadow|live] [--limit N] [--area slug] [--kind decision|issue|session|pending]'); process.exit(2); }

const out = await hybridMemorySearch(query, {
  mode: val('--mode') || undefined,
  limit: val('--limit') ? parseInt(val('--limit'), 10) : undefined,
  filterArea: val('--area') || undefined,
  filterKind: val('--kind') || undefined,
});

const show = (rows, label) => {
  console.log(`\n${label} (${rows.length})`);
  for (const r of rows) {
    const legs = [r.fts_rank ? `fts#${r.fts_rank}` : null, r.vec_rank ? `vec#${r.vec_rank}` : null].filter(Boolean).join(' ');
    const sim = typeof r.similarity === 'number' ? ` sim ${r.similarity.toFixed(2)}` : '';
    console.log(`  ${r.kind}#${r.id} [${r.origin || '-'}|${r.status || '-'}|${r.row_date || '-'}] ${legs}${sim} — ${String(r.text || '').slice(0, 120).replace(/\n/g, ' ')}`);
  }
};
console.log(`mode=${out.mode} latency=${out.latency_ms}ms vector_only=${out.vector_only ?? '-'}${out.error ? ` error=${out.error}` : ''}`);
show(out.results, out.mode === 'live' ? 'FUSED' : 'FULL-TEXT (returned)');
if (out.shadow) show(out.shadow, 'FUSED (shadow — what live would return)');
