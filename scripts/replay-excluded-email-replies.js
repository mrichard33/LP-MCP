#!/usr/bin/env node
/**
 * Replay the email replies that behavioral-emitter v2.14's SMS-only gate dropped
 * (2026-07-06 → 2026-07-13). Re-drives each contact's inbound through the real
 * pipeline: /n8n/analyze-message (channel=email) → /n8n/decision-engine/process.
 *
 * NOTE: AGENTIC_RESPOND_POST_CHATBOT send_message actions FAST-PATH at creation
 * (decision-engine createActionsFromRule → executeActionById), so /process alone
 * triggers the send. No /execute call needed.
 *
 * DRY RUN BY DEFAULT. Nothing is written or sent without --send.
 *
 *   node scripts/replay-excluded-email-replies.js
 *   node scripts/replay-excluded-email-replies.js --send --contacts=abc,def
 */
import 'dotenv/config';
import supabase from '../src/supabase.js';

const BASE = process.env.LP_MCP_BASE_URL || 'https://lp-mcp-production.up.railway.app';
const args = process.argv.slice(2);
const SEND = args.includes('--send');
const onlyArg = (args.find((a) => a.startsWith('--contacts=')) || '').split('=')[1];
const ONLY = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim()).filter(Boolean)) : null;
const SINCE_DAYS = Number((args.find((a) => a.startsWith('--since-days=')) || '').split('=')[1] || 30);

function answerable(text) {
  const t = String(text || '')
    .replace(/https?:\/\/\S*conversations-assets\/\S*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length >= 3;
}

async function main() {
  const since = new Date(Date.now() - SINCE_DAYS * 86400000).toISOString();
  const { data: events, error } = await supabase
    .from('system_events')
    .select('id, ghl_contact_id, created_at, payload')
    .eq('event_type', 'ghl.reply_channel_excluded')
    .eq('event_subtype', 'email')
    .gte('created_at', since)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);

  const byContact = new Map();
  for (const e of events || []) {
    const cid = e.ghl_contact_id;
    if (!cid) continue;
    if (ONLY && !ONLY.has(cid)) continue;
    const text = e.payload?.message_text || '';
    if (!answerable(text)) continue;                 // empty / attachment-only → human
    if (!byContact.has(cid)) byContact.set(cid, { messages: [], eventIds: [], lastId: null, last: null });
    const b = byContact.get(cid);
    b.messages.push(String(text).trim());            // oldest → newest, like the reply buffer
    b.eventIds.push(e.id);
    b.lastId = e.payload?.message_id || null;        // latest wins
    b.last = e.created_at;
  }

  if (!byContact.size) { console.log('Nothing replayable.'); return; }

  console.log(`\n${byContact.size} contact(s) with replayable email replies since ${since}:\n`);
  for (const [cid, b] of byContact) {
    const ageH = ((Date.now() - Date.parse(b.last)) / 3600000).toFixed(1);
    console.log(`  ${cid}   ${b.messages.length} msg   ${ageH}h old`);
    console.log(`    "${b.messages.join(' / ').slice(0, 150)}"\n`);
  }

  if (!SEND) {
    console.log('DRY RUN — nothing analyzed, nothing sent. To replay:\n');
    console.log(`  node scripts/replay-excluded-email-replies.js --send --contacts=${[...byContact.keys()].join(',')}\n`);
    return;
  }

  for (const [cid, b] of byContact) {
    const combined = b.messages.join('\n');
    console.log(`\n→ ${cid}: analyzing ${b.messages.length} message(s)…`);
    const aRes = await fetch(`${BASE}/n8n/analyze-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId: cid, message: combined, channel: 'email', message_id: b.lastId }),
    });
    const aJson = await aRes.json().catch(() => ({}));
    if (!aRes.ok || aJson?.success !== true) {
      console.error(`   ✗ analyze failed (${aRes.status}): ${JSON.stringify(aJson).slice(0, 200)}`);
      continue;
    }
    console.log(`   ✓ analyzed — stage=${aJson.analysis?.buyer_stage ?? '?'}, action=${aJson.analysis?.recommended_action ?? '?'}`);

    const pRes = await fetch(`${BASE}/n8n/decision-engine/process`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const pJson = await pRes.json().catch(() => ({}));
    console.log(`   ✓ processed — ${pJson.total_actions_created ?? 0} action(s) created (send fast-paths at creation)`);

    await supabase.from('system_events').update({
      processed: true,
      processed_by: 'email_replay_backfill',
      processed_at: new Date().toISOString(),
      action_taken: 'replayed_through_analyzer (v2.14 gate backfill)',
    }).in('id', b.eventIds);

    await new Promise((r) => setTimeout(r, 4000));   // don't stampede the GHL limiter
  }

  console.log('\nDone. Verify:');
  console.log("  SELECT id, target_id, status, rule_applied, execution_result->>'sent_body'");
  console.log("  FROM agent_actions WHERE action_type='send_message' ORDER BY created_at DESC LIMIT 10;\n");
}

main().catch((err) => { console.error(err); process.exit(1); });
