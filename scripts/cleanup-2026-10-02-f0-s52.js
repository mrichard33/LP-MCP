#!/usr/bin/env node
// scripts/cleanup-2026-10-02-f0-s52.js — the one-time F.0 / S5.2 cleanup
// (2026-10-02, Mark). The logic lives in src/admin/cleanup-2026-10-02-f0-s52.js;
// production runs it through the authenticated route
//   POST /admin/cleanup/2026-10-02-f0-s52?mode=report   (then mode=apply)
//   GET  /admin/cleanup/2026-10-02-f0-s52               (summary; &full=1 per contact)
// because it needs GHL + LP credentials only the server has.
//
// Locally (with every credential set): node scripts/cleanup-2026-10-02-f0-s52.js [--apply] [--limit=N]
// Report is the default. It never enrolls anyone except Gaby (group c).
import { pathToFileURL } from 'node:url';
import { runCleanup, summarize } from '../src/admin/cleanup-2026-10-02-f0-s52.js';

export function parseArgs(argv) {
  const out = { mode: 'report', limit: Infinity };
  for (const a of argv) {
    if (a === '--apply') out.mode = 'apply';
    else if (a.startsWith('--limit=')) out.limit = Number(a.slice(8)) || Infinity;
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runCleanup(args);
  console.log(JSON.stringify(summarize(summary), null, 2));
  process.exit(summary.f0.failed + summary.s52.failed > 0 ? 1 : 0);
}
