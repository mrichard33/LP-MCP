/**
 * reply-latency-report.js — where the time goes in an agentic reply.
 *
 * READ-ONLY. Prints p50 / p90 / max per stage over the agent_actions rows
 * that carry execution_result.timing (written by send-message-handler.js
 * since 2026-09-26; rows before that report nothing here).
 *
 *   node scripts/reply-latency-report.js --days 3 [--rule AGENTIC_RESPOND_POST_CHATBOT] [--channel livechat]
 *
 * Stages (see buildReplyTiming in src/send-message-handler.js):
 *   total     t0 inbound received → t6 GHL accepted
 *   analyze   t1 reply event written → t4 analysis done
 *   queue     t4 analysis done → t3 action claimed (engine hop + pull-queue wait)
 *   generate  t3 claimed → t5 reply generated (context, KB, model, guards)
 *   send      t5 generated → t6 sent
 *
 * The percentile helper is exported for scripts/test-reply-timing.js.
 */

import supabase from '../src/supabase.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };

/** Nearest-rank percentile over a numeric array. Pure. */
export function percentile(values, p) {
  const xs = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const rank = Math.ceil((p / 100) * xs.length);
  return xs[Math.min(xs.length, Math.max(1, rank)) - 1];
}

const STAGES = ['total_ms', 'analyze_ms', 'queue_ms', 'generate_ms', 'send_ms'];

/** Reduce timing rows to a per-stage {n, p50, p90, max} table. Pure. */
export function summarize(rows) {
  const out = {};
  for (const stage of STAGES) {
    const vals = rows.map(r => r?.[stage]).filter(v => Number.isFinite(v));
    out[stage] = { n: vals.length, p50: percentile(vals, 50), p90: percentile(vals, 90), max: vals.length ? Math.max(...vals) : null };
  }
  return out;
}

function fmt(ms) {
  if (ms === null || ms === undefined) return '   n/a';
  return ms >= 10000 ? `${(ms / 1000).toFixed(1)}s`.padStart(6) : `${ms}ms`.padStart(6);
}

function printTable(title, summary) {
  console.log(`\n${title}`);
  console.log('  stage        n     p50     p90     max');
  for (const stage of STAGES) {
    const s = summary[stage];
    console.log(`  ${stage.replace('_ms', '').padEnd(9)} ${String(s.n).padStart(4)}  ${fmt(s.p50)}  ${fmt(s.p90)}  ${fmt(s.max)}`);
  }
}

async function main() {
  if (!supabase) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set'); process.exit(2); }
  const days = Number(opt('--days', '7'));
  const rule = opt('--rule', null);
  const channel = opt('--channel', null);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  let q = supabase
    .from('agent_actions')
    .select('id, rule_applied, created_at, execution_result')
    .eq('action_type', 'send_message')
    .eq('status', 'completed')
    .gte('created_at', since)
    .not('execution_result->timing', 'is', null)
    .order('created_at', { ascending: false })
    .limit(5000);
  if (rule) q = q.eq('rule_applied', rule);
  const { data, error } = await q;
  if (error) { console.error(error.message); process.exit(1); }

  const rows = (data || [])
    .map(r => ({ rule: r.rule_applied || 'manual', channel: r.execution_result?.channel || null, ...(r.execution_result?.timing || {}) }))
    .filter(r => !channel || r.channel === channel);

  console.log(`reply latency — last ${days} day(s), ${rows.length} completed send_message row(s) with timing${rule ? `, rule=${rule}` : ''}${channel ? `, channel=${channel}` : ''}`);
  if (!rows.length) { console.log('no rows carry execution_result.timing yet (written since 2026-09-26)'); return; }

  printTable('ALL', summarize(rows));
  const byRule = new Map();
  for (const r of rows) { if (!byRule.has(r.rule)) byRule.set(r.rule, []); byRule.get(r.rule).push(r); }
  for (const [name, group] of [...byRule.entries()].sort((a, b) => b[1].length - a[1].length)) {
    printTable(`rule ${name}`, summarize(group));
  }
  const byChannel = new Map();
  for (const r of rows) { const c = r.channel || 'unknown'; if (!byChannel.has(c)) byChannel.set(c, []); byChannel.get(c).push(r); }
  for (const [name, group] of byChannel.entries()) printTable(`channel ${name}`, summarize(group));
}

if (process.argv[1] && process.argv[1].endsWith('reply-latency-report.js')) {
  main().catch(err => { console.error(err); process.exit(1); });
}
