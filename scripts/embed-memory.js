#!/usr/bin/env node
/**
 * Backfill / refresh claude_memory_embeddings from the claude_* memory tables.
 *
 * DRY RUN BY DEFAULT — prints counts, estimated tokens/cost and three sample
 * texts (already PII-stripped) per kind, writes nothing, needs no OpenAI key.
 *
 *   node scripts/embed-memory.js                       dry run, all kinds
 *   node scripts/embed-memory.js --kind decision,issue  dry run, two kinds
 *   node scripts/embed-memory.js --limit 50            dry run, first 50 per kind
 *   node scripts/embed-memory.js --execute             embed + upsert changed rows
 *   node scripts/embed-memory.js --execute --force     re-embed everything
 *   node scripts/embed-memory.js --since 2026-09-01    only rows dated on/after
 *
 * Re-runnable: rows whose content_hash already matches are skipped.
 * Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY; --execute also needs OPENAI_API_KEY.
 */
import 'dotenv/config';
import { planKind, executePlan } from '../src/memory/memory-embed.js';
import { SOURCES } from '../src/memory/memory-text.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const val = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

const execute = flag('--execute');
const force = flag('--force');
const kinds = (val('--kind') || Object.keys(SOURCES).join(',')).split(',').map((k) => k.trim()).filter(Boolean);
const limit = val('--limit') ? parseInt(val('--limit'), 10) : null;
const since = val('--since');

for (const k of kinds) {
  if (!SOURCES[k]) { console.error(`unknown --kind ${k}; use ${Object.keys(SOURCES).join(', ')}`); process.exit(2); }
}
if (execute && !process.env.OPENAI_API_KEY) { console.error('--execute needs OPENAI_API_KEY'); process.exit(2); }

let grandTodo = 0; let grandTokens = 0; let grandCost = 0;
for (const kind of kinds) {
  const plan = await planKind(kind, { force, limit, since });
  grandTodo += plan.todo.length; grandTokens += plan.est_tokens; grandCost += plan.est_cost_usd;
  console.log(`\n== ${kind}: ${plan.total} rows, ${plan.unchanged} unchanged, ${plan.todo.length} to embed, ~${plan.est_tokens} tokens, ~$${plan.est_cost_usd.toFixed(4)}`);
  for (const s of plan.todo.slice(0, 3)) {
    console.log(`  [${s.source_id} | ${s.status || '-'} | ${s.area || '-'}] ${s.embedded_text.slice(0, 160).replace(/\n/g, ' ')}${s.embedded_text.length > 160 ? '…' : ''}`);
  }
  if (execute && plan.todo.length) {
    const r = await executePlan(plan, { log: (m) => console.log(m) });
    console.log(`   → wrote ${r.written} ${kind} rows, ${r.tokens} tokens, $${r.cost_usd.toFixed(4)}`);
  }
}
console.log(`\nTOTAL ${execute ? 'written' : 'to embed'}: ${grandTodo} rows, ~${grandTokens} tokens, ~$${grandCost.toFixed(4)}${execute ? '' : '  (dry run — add --execute to write)'}`);
