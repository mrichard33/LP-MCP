#!/usr/bin/env node
/**
 * Concierge KB seed — ingest the canon-corrected Bot 2 (Lead Concierge)
 * belief-stack docs into kb_embeddings via POST /n8n/kb/ingest.
 *
 * These are the 7 verbatim, canon-corrected source docs distilled from
 * Bot 2 (objection handling, belief stack, offer ladder, pricing doctrine,
 * FAQ, send-info value, compliance guardrails). Content lives in
 * data/kb/concierge/*.md so the locked phrasing (em-dashes included) stays
 * reviewable and version-controlled. Re-runnable: each doc is ingested with
 * replace:true, so running again cleanly supersedes the prior chunks.
 *
 * Usage:
 *   LP_BASE_URL=https://<lp-mcp-host> node scripts/ingest-concierge-kb.js
 *   node scripts/ingest-concierge-kb.js https://<lp-mcp-host>
 *   node scripts/ingest-concierge-kb.js --only=reece_faq_core,reece_offer_ladder
 *
 * --only (2026-09-23): re-ingest just the named docs. Two of these docs
 * (reece_belief_stack, reece_compliance_guardrails) were re-versioned live
 * from outside this repo before the repo copy caught up, so a blanket run can
 * roll a doc BACK. Ingest only what you changed. DOC_META keeps the section
 * and version labels those two docs carry live.
 *
 * Optional: MCP_AUTH_TOKEN env adds an Authorization: Bearer header (the
 * /n8n/kb/* routes are unauthenticated today, but the header is harmless if
 * that changes).
 */
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KB_DIR = join(__dirname, '..', 'data', 'kb', 'concierge');

const args = process.argv.slice(2);
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean)) : null;
const BASE_URL = (process.env.LP_BASE_URL || args.find((a) => !a.startsWith('--')) || '').replace(/\/$/, '');

// Live section/version labels for docs that carry their own canon version.
const DOC_META = {
  reece_belief_stack: { source_section: 'Big Domino Asset Bible v2.0 §1', source_doc_version: '2026-09-22' },
  reece_compliance_guardrails: { source_section: 'GTD 7.6 hard lines', source_doc_version: '2026-09-23' },
};
if (!BASE_URL) {
  console.error('ERROR: set LP_BASE_URL env or pass the base URL as the first arg.');
  console.error('  e.g. LP_BASE_URL=https://lp-mcp-production.up.railway.app node scripts/ingest-concierge-kb.js');
  process.exit(2);
}

const headers = { 'Content-Type': 'application/json' };
if (process.env.MCP_AUTH_TOKEN) headers.Authorization = `Bearer ${process.env.MCP_AUTH_TOKEN}`;

async function main() {
  const files = (await readdir(KB_DIR))
    .filter((f) => f.endsWith('.md'))
    .filter((f) => !ONLY || ONLY.has(basename(f, '.md')))
    .sort();
  if (ONLY) {
    const missing = [...ONLY].filter((d) => !files.includes(`${d}.md`));
    if (missing.length) {
      console.error(`ERROR: --only names docs with no file in ${KB_DIR}: ${missing.join(', ')}`);
      process.exit(2);
    }
  }
  if (files.length === 0) {
    console.error(`ERROR: no .md docs found in ${KB_DIR}`);
    process.exit(2);
  }

  let failures = 0;
  for (const file of files) {
    const source_doc = basename(file, '.md');
    const text = await readFile(join(KB_DIR, file), 'utf8');
    const body = JSON.stringify({
      text,
      source_doc,
      source_section: DOC_META[source_doc]?.source_section || 'concierge',
      source_doc_version: DOC_META[source_doc]?.source_doc_version,
      replace: true,
      ingested_by: 'claude',
    });

    try {
      const res = await fetch(`${BASE_URL}/n8n/kb/ingest`, { method: 'POST', headers, body });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        failures++;
        console.error(`✗ ${source_doc}: HTTP ${res.status} — ${json.error || 'unknown error'}`);
        continue;
      }
      console.log(
        `✓ ${source_doc}: +${json.chunks_added} chunks (replaced ${json.chunks_replaced ?? 0}), ` +
          `${json.total_tokens} tokens, $${json.embed_cost_usd}`,
      );
    } catch (err) {
      failures++;
      console.error(`✗ ${source_doc}: ${err.message}`);
    }
  }

  console.log(`\nDone. ${files.length - failures}/${files.length} docs ingested.`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
