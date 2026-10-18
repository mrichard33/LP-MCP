/**
 * report-stage-agreement.js — does the shadow conversation stage agree with
 * what the bot is running on today?
 *
 * Phase 0 (architecture review 2026-10-17): LEAD_STAGE_MODE has run in shadow
 * since 2026-10-12 and nothing measured it. This is the go / no-go input for
 * promoting it (Phase 4). Read-only: it reads lead_conversation_stage_events
 * (mode shadow) and bot_message_context for the last N days and prints counts.
 * Neither table's columns used here hold customer text (stages and reason codes
 * only, lead-stage.js), so the output is safe to paste in a PR.
 *
 * The two are different axes: the stored stage is the NEPQ conversation stage
 * (connection … booked, side states), buyer_stage is the analyzer's 1-5
 * journey. The one existing link is playForConversationStage
 * (src/agentic/nepq-layer.js), the play number LEAD_STAGE_MODE=live uses in
 * place of buyer_stage, so (a) compares play(shadow stage) with buyer_stage.
 * No new map is invented here; a stage it does not map is counted "unmapped".
 *
 *   node scripts/report-stage-agreement.js [--days 7] [--from-file export.json] [--json]
 *     export.json: { events: [lead_conversation_stage_events rows], rows: [bot_message_context rows] }
 *
 * Not part of `npm test` (it needs the database); the pure core is pinned in
 * scripts/test-report-stage-agreement.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── pure ────────────────────────────────────────────────────────────────────

// The stage is recorded right after the send, so an event a little after the
// reply's generated_at is that turn's stage.
const AFTER_SEND_MS = 5 * 60_000;

const ms = (t) => Date.parse(t || '');

/**
 * The stage in force after each reply: the contact's latest shadow event at or
 * before generated_at + 5 min. Rows with no event yet are left out. Pure.
 */
export function joinStages(events, rows) {
  const byContact = new Map();
  for (const e of events || []) {
    if (!e?.contact_id || !e?.to_stage) continue;
    const list = byContact.get(e.contact_id) || [];
    list.push(e);
    byContact.set(e.contact_id, list);
  }
  for (const list of byContact.values()) list.sort((a, b) => ms(a.created_at) - ms(b.created_at));
  const joined = [];
  for (const r of rows || []) {
    if (!r?.ghl_contact_id || String(r.channel || '') === 'email') continue;
    const list = byContact.get(r.ghl_contact_id);
    if (!list) continue;
    const limit = ms(r.generated_at) + AFTER_SEND_MS;
    let stage = null;
    for (const e of list) { if (ms(e.created_at) <= limit) stage = e.to_stage; else break; }
    if (!stage) continue;
    joined.push({ contact_id: r.ghl_contact_id, at: r.generated_at, channel: r.channel, stage, buyer_stage: Number.isFinite(Number(r.buyer_stage)) && r.buyer_stage != null ? Number(r.buyer_stage) : null });
  }
  return joined.sort((a, b) => (a.contact_id === b.contact_id ? ms(a.at) - ms(b.at) : a.contact_id.localeCompare(b.contact_id)));
}

const top = (counts, n) => Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);

/**
 * The agreement report. Pure.
 * @param {object[]} events  lead_conversation_stage_events rows (shadow)
 * @param {object[]} rows    bot_message_context rows (ghl_contact_id, channel, buyer_stage, generated_at)
 * @param {object} deps      { playFor(stage) → number|null }
 */
export function agreementReport(events, rows, { playFor }) {
  const joined = joinStages(events, rows);
  let mapped = 0;
  let agree = 0;
  const unmappedStages = {};
  const noBuyer = { n: 0 };
  const disagreePairs = {};
  for (const j of joined) {
    j.play = playFor(j.stage);
    if (j.buyer_stage == null) { noBuyer.n += 1; continue; }
    if (j.play == null) { unmappedStages[j.stage] = (unmappedStages[j.stage] || 0) + 1; continue; }
    mapped += 1;
    if (j.play === j.buyer_stage) agree += 1;
    else { const k = `${j.stage} (play ${j.play}) vs buyer_stage ${j.buyer_stage}`; disagreePairs[k] = (disagreePairs[k] || 0) + 1; }
  }
  // (b) Per contact, consecutive replies: which side moved. Both sides are
  // compared in play numbers, so a move the shadow made inside one play
  // (situation → problem) is not counted as a disagreement.
  const shadowOnly = {};
  const plannerOnly = {};
  let bothMoved = 0;
  let pairs = 0;
  for (let i = 1; i < joined.length; i++) {
    const a = joined[i - 1];
    const b = joined[i];
    if (a.contact_id !== b.contact_id || a.play == null || b.play == null || a.buyer_stage == null || b.buyer_stage == null) continue;
    pairs += 1;
    const sMoved = a.play !== b.play;
    const pMoved = a.buyer_stage !== b.buyer_stage;
    if (sMoved && pMoved) bothMoved += 1;
    else if (sMoved) { const k = `${a.stage} → ${b.stage} (play ${a.play}→${b.play})`; shadowOnly[k] = (shadowOnly[k] || 0) + 1; }
    else if (pMoved) { const k = `buyer_stage ${a.buyer_stage}→${b.buyer_stage} (shadow stays ${b.stage})`; plannerOnly[k] = (plannerOnly[k] || 0) + 1; }
  }
  const sum = (o) => Object.values(o).reduce((x, y) => x + y, 0);
  return {
    events: (events || []).length,
    contacts_with_events: new Set((events || []).map(e => e.contact_id)).size,
    replies: (rows || []).filter(r => String(r?.channel || '') !== 'email').length,
    replies_with_stage: joined.length,
    no_buyer_stage: noBuyer.n,
    unmapped: sum(unmappedStages),
    unmapped_stages: Object.fromEntries(top(unmappedStages, 20)),
    compared: mapped,
    agree,
    agreement_pct: mapped ? Math.round((agree / mapped) * 1000) / 10 : null,
    transitions: { consecutive_pairs: pairs, both_moved: bothMoved, shadow_only: sum(shadowOnly), planner_only: sum(plannerOnly), top_shadow_only: top(shadowOnly, 10), top_planner_only: top(plannerOnly, 10) },
    top_disagreements: top(disagreePairs, 10),
  };
}

/** A plain table for a PR body. Pure. */
export function formatAgreement(r, { days = 7 } = {}) {
  const lines = [
    `Shadow stage agreement, last ${days} days`,
    `  shadow events ${r.events} over ${r.contacts_with_events} contacts; ${r.replies} SMS/chat replies, ${r.replies_with_stage} with a shadow stage in force`,
    `  (a) play(shadow stage) == buyer_stage: ${r.agree}/${r.compared} = ${r.agreement_pct == null ? 'n/a' : `${r.agreement_pct}%`}`,
    `      not compared: ${r.unmapped} on a stage with no play (${Object.entries(r.unmapped_stages).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}), ${r.no_buyer_stage} with no buyer_stage`,
    `  (b) consecutive reply pairs ${r.transitions.consecutive_pairs}: both moved ${r.transitions.both_moved}, shadow only ${r.transitions.shadow_only}, buyer_stage only ${r.transitions.planner_only}`,
  ];
  for (const [k, n] of r.transitions.top_shadow_only) lines.push(`      shadow only  ${String(n).padStart(4)}  ${k}`);
  for (const [k, n] of r.transitions.top_planner_only) lines.push(`      buyer only   ${String(n).padStart(4)}  ${k}`);
  lines.push('  (c) top disagreement pairs:');
  for (const [k, n] of r.top_disagreements) lines.push(`      ${String(n).padStart(4)}  ${k}`);
  return lines.join('\n');
}

// ── io ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };

async function pageAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function load(days) {
  const file = opt('--from-file');
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const { default: supabase } = await import('../src/supabase.js');
  if (!supabase) throw new Error('Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY); or pass --from-file');
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const events = await pageAll(() => supabase.from('lead_conversation_stage_events').select('contact_id, from_stage, to_stage, reason, channel, mode, created_at')
    .eq('mode', 'shadow').gte('created_at', since).order('created_at', { ascending: true }));
  const rows = await pageAll(() => supabase.from('bot_message_context').select('message_ref, ghl_contact_id, channel, buyer_stage, generated_at')
    .eq('message_type', 'reply').gte('generated_at', since).order('generated_at', { ascending: true }));
  return { events, rows };
}

async function main() {
  const days = Number(opt('--days', 7));
  const { events, rows } = await load(days);
  const { playForConversationStage } = await import('../src/agentic/nepq-layer.js');
  const report = agreementReport(events, rows, { playFor: (stage) => playForConversationStage({ stage }) });
  if (args.includes('--json')) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(formatAgreement(report, { days }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err?.message || err); process.exit(1); });
}
