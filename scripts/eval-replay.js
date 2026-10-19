/**
 * eval-replay.js — score the replies the bots ACTUALLY SENT against the hard
 * checks in src/eval/reply-invariants.js, grouped by channel and prompt
 * version.
 *
 * 2026-10-05 (AI audit, Task 1). Read-only and model-free: it reads
 * bot_message_context, runs the pure checks, and prints a scorecard. Nothing
 * is written anywhere. NOT part of `npm test` (it needs the database); the CI
 * half is scripts/test-golden-replay.js.
 *
 * Customer conversations stay in the LP database (the user's ruling,
 * 2026-10-05): this script reads them where they live and prints only codes,
 * counts and, with --examples, the reply text to the operator's own terminal.
 * Never commit its output.
 *
 *   node scripts/eval-replay.js [--days 30] [--channel sms|livechat|email]
 *                               [--by version|channel|model] [--examples 3] [--json]
 *   node scripts/eval-replay.js --from-file rows.json [...]
 *     rows.json: an array of bot_message_context rows (or [{ r: [...] }]) —
 *     for scoring an export without database credentials.
 */

import fs from 'node:fs';
import { checkReply, summarize, INVARIANTS_VERSION } from '../src/eval/reply-invariants.js';
import { MONEY_RX } from '../src/agentic/nepq-planner.js';

const args = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes(name);

/** The check context for one stored row. Unknowns stay undefined so their checks are skipped, not guessed. Pure. */
export function contextForRow(row) {
  const snap = row.input_snapshot && typeof row.input_snapshot === 'object' ? row.input_snapshot : {};
  const inbound = String(row.inbound_text || '');
  const tags = Array.isArray(snap.contact_tags) ? snap.contact_tags.map(t => String(t).toLowerCase()) : [];
  const reply = String(row.reply_text || '');
  // The post-demo rehash line signs as the rep (2026-10-01 ruling), so a name there is allowed.
  const rehashName = tags.includes('active-f.0') ? (reply.match(/[—–-]\s*([A-Z][a-z]+)\s*$/) || [])[1] : null;
  const sentMs = Date.parse(row.sent_at || row.generated_at || '');
  return {
    channel: row.channel || snap.channel || null,
    inbound,
    // SMS snapshots carry the thread; live-chat snapshots do not (unknown → skipped).
    conversation: Array.isArray(snap.thread) ? snap.thread : undefined,
    hasAppointment: snap.has_existing_appt === true ? true : undefined,
    // Whether THIS turn booked is not stored on the row: unknown → the claim check is skipped.
    booked: undefined,
    nowMs: Number.isFinite(sentMs) ? sentMs : undefined,
    // The customer's own figure may be echoed back: one they typed, or a
    // calculator lead's online estimate ("the customer's own estimate excepted").
    allowFigures: MONEY_RX.test(inbound) || tags.some(t => t === 'active-entry:estimate-calculator' || t === 'active-entry:calculator'),
    allowName: rehashName || null,
    // 2026-10-19: a post-demo email decline turn ends with no question.
    postDemoEmailStep: row.plan_step === 'post_demo_email_decline_first' ? 'decline_first'
      : row.plan_step === 'post_demo_email_decline_close' ? 'decline_close' : undefined,
  };
}

function groupKey(row, by) {
  if (by === 'channel') return String(row.channel || 'unknown');
  if (by === 'model') return `${row.channel || 'unknown'} | ${row.model || 'model not recorded'}`;
  return `${row.channel || 'unknown'} | ${row.core_prompt_version || 'version not recorded'}`;
}

/** Score rows. Only rows that carry a sent reply are scored; the rest are counted. Pure. */
export function scoreRows(rows, { by = 'channel' } = {}) {
  const scored = [];
  let notSent = 0;
  for (const row of rows) {
    if (!row || !String(row.reply_text || '').trim()) { notSent += 1; continue; }
    scored.push({ row, group: groupKey(row, by), result: checkReply(row.reply_text, contextForRow(row)) });
  }
  return { scored, notSent, summary: summarize(scored) };
}

async function loadRows() {
  const file = opt('--from-file');
  if (file) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(raw) && raw.length === 1 && Array.isArray(raw[0]?.r) ? raw[0].r : raw;
    return Array.isArray(list) ? list : [];
  }
  const { default: supabase } = await import('../src/supabase.js');
  if (!supabase) throw new Error('Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  const days = Number(opt('--days', 30));
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from('bot_message_context')
      .select('message_ref, channel, model, core_prompt_version, inbound_text, reply_text, input_snapshot, generated_at, sent_at, plan_step')
      .gte('generated_at', since).order('generated_at', { ascending: true }).range(from, from + 999);
    const channel = opt('--channel');
    if (channel) q = q.eq('channel', channel);
    const { data, error } = await q;
    if (error) throw new Error(`bot_message_context read failed: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

async function main() {
  const by = opt('--by', 'channel');
  const rows = await loadRows();
  const { scored, notSent, summary } = scoreRows(rows, { by });

  if (flag('--json')) {
    console.log(JSON.stringify({ invariants_version: INVARIANTS_VERSION, rows: rows.length, not_sent: notSent, summary }, null, 2));
    return;
  }
  console.log(`Reply checks ${INVARIANTS_VERSION} — ${scored.length} sent replies scored, ${notSent} rows with no sent reply skipped\n`);
  for (const g of summary) {
    const top = Object.entries(g.violations).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k} ×${n}`).join(', ');
    console.log(`${g.group}\n  ${g.passed}/${g.n} pass (${Math.round((g.pass_rate || 0) * 100)}%)${top ? `\n  top failures: ${top}` : ''}`);
  }
  const examples = Number(opt('--examples', 0));
  if (examples > 0) {
    const byCode = new Map();
    for (const s of scored) for (const v of s.result.violations) {
      const list = byCode.get(v.code) || [];
      if (list.length < examples) list.push(`  [${s.row.channel}] ${String(s.row.reply_text).replace(/\s+/g, ' ').slice(0, 220)}`);
      byCode.set(v.code, list);
    }
    console.log('\nExamples (customer text: do not paste outside the team):');
    for (const [code, list] of byCode) console.log(`${code}\n${list.join('\n')}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(`[eval-replay] ${err.message}`); process.exit(1); });
}
