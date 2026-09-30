#!/usr/bin/env node
// scripts/f0-integrity-audit.js — the daily F.0 integrity audit, printed to
// stdout instead of Slack. Same logic as src/jobs/f0-integrity-audit.js.
// READ-ONLY. Needs SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (LP) and
// HL_SUPABASE_URL / HL_SUPABASE_SERVICE_ROLE_KEY (HL contacts cache).
import { runF0IntegrityAudit } from '../src/jobs/f0-integrity-audit.js';

const result = await runF0IntegrityAudit({ post: false });
console.log(result.text);
if (result.flagged.length > 25) {
  console.log('\nFull list:');
  for (const f of result.flagged) console.log(`${f.contact_id}\t${f.disposition || 'none'}\t${f.reason}`);
}
process.exit(result.ok ? 0 : 1);
