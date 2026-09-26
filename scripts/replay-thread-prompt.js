/**
 * replay-thread-prompt.js — replay a real thread through the discovery
 * discipline, the prompt builder and (optionally) the generator, in dry-run.
 *
 * NOT part of `npm test`. Two modes:
 *
 *   node scripts/replay-thread-prompt.js <contactId> [--generate]
 *     Live: buildLeadContext() over GHL/LP/Supabase, renders the DISCOVERY
 *     DISCIPLINE section for the newest inbound and, with --generate, runs
 *     generateResponse(..., {dryRun:true}) and prints the reply the model
 *     produces now. Needs the production env (GHL, Supabase, LLM keys).
 *     Nothing is sent and nothing is written (dryRun gates every write site).
 *
 *   node scripts/replay-thread-prompt.js --thread <file.json> [--turn N]
 *     Offline: a saved thread (an array of {direction, body|text, dateAdded|
 *     timestamp, messageType?}) is replayed turn by turn. For every INBOUND
 *     the script prints what the discipline would have told the model, and
 *     for every OUTBOUND that followed it, what the guards would have done to
 *     that draft. This is the before/after evidence for PR
 *     fix/nepq-discovery-discipline: "before" is the reply that went out,
 *     "after" is the verdict plus the rewritten draft.
 *
 * Deterministic in offline mode — no network, no model.
 */

import fs from 'node:fs';
import {
  buildDiscipline,
  findBookingAsks,
  findBannedOpeners,
  stripBannedOpener,
  findExclamations,
  stripExclamations,
  findPhantomDecisionMaker,
  findInsuranceOutcomeClaims,
  replaceInsuranceClaims,
  findRepeatedOpener,
  stripSentences,
  holdingLine,
} from '../src/agentic/discovery-discipline.js';
import { buildEstablishedFacts } from '../src/agentic/established-facts.js';
import { disciplineBlock } from '../src/agentic/nepq-layer.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

function normalize(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map(m => ({
      direction: m.direction === 'inbound' || m.direction === 1 ? 'inbound' : 'outbound',
      text: String(m.text ?? m.body ?? m.message ?? '').trim(),
      timestamp: m.timestamp ?? m.dateAdded ?? m.at ?? null,
      channel: m.channel ?? m.messageType ?? null,
    }))
    .filter(m => m.text)
    .sort((a, b) => Date.parse(a.timestamp || 0) - Date.parse(b.timestamp || 0));
}

/** What the guards would do to a draft, given the discipline for its turn. */
function judge(draft, d, leadFirstName) {
  const verdicts = [];
  let fixed = draft;
  if (findExclamations(fixed)) { verdicts.push(`exclamation marks ×${findExclamations(fixed)} → stripped`); fixed = stripExclamations(fixed); }
  const openers = findBannedOpeners(fixed);
  if (openers.length) { verdicts.push(`banned opener (${openers.join(', ')}) → regenerate, then strip`); fixed = stripBannedOpener(fixed); }
  if (!d.booking.allowed) {
    const asks = findBookingAsks(fixed);
    if (asks.length) { verdicts.push(`booking ask while NOT ALLOWED (${d.booking.reason}) → regenerate, then strip: "${asks[0]}"`); fixed = stripSentences(fixed, s => asks.includes(s)); }
  }
  const phantoms = findPhantomDecisionMaker(fixed, d.decision_makers);
  if (phantoms.length) { verdicts.push(`phantom decision-maker (dm=${d.decision_makers.status}) → regenerate, then strip: "${phantoms[0]}"`); fixed = stripSentences(fixed, s => phantoms.includes(s)); }
  const ins = findInsuranceOutcomeClaims(fixed);
  if (ins.violations.length) { verdicts.push(`insurance outcome (${ins.violations.join(', ')}) → regenerate, then replace with the approved line`); fixed = replaceInsuranceClaims(fixed); }
  if (d.opener.asked) {
    const rep = findRepeatedOpener(fixed, d.opener.text);
    if (rep.length) { verdicts.push(`repeated the workflow opener → regenerate, then strip: "${rep[0]}"`); fixed = stripSentences(fixed, s => rep.includes(s)); }
  }
  if (!fixed.trim()) fixed = holdingLine(leadFirstName);
  return { verdicts, fixed };
}

function replayOffline(thread, { leadName = null, onlyTurn = null } = {}) {
  const turns = normalize(thread);
  const first = String(leadName || '').split(/\s+/)[0] || null;
  let turnNo = 0;
  for (let i = 0; i < turns.length; i += 1) {
    if (turns[i].direction !== 'inbound') continue;
    turnNo += 1;
    if (onlyTurn && turnNo !== onlyTurn) continue;
    const history = turns.slice(0, i + 1);
    const trigger = turns[i].text;
    const established = buildEstablishedFacts({ conversation: history, lead: { name: leadName }, lp: null, intelligence: null });
    const nowMs = Date.parse(turns[i].timestamp || '') || Date.now();
    const d = buildDiscipline({ triggerMessage: trigger, conversation: history, established, nowMs });
    const nextOut = turns.slice(i + 1).find(t => t.direction === 'outbound');

    console.log(`\n${'═'.repeat(78)}\nINBOUND #${turnNo} (${turns[i].timestamp || 'no time'}): "${trigger.slice(0, 200)}"`);
    console.log(`discipline: booking_ask=${d.booking.allowed ? 'ALLOWED' : 'NO'} (${d.booking.reason}) · probe=${d.probe.problem_named ? (d.probe.urgent ? 'URGENT' : d.probe.probe_done ? 'done' : 'FIRST') : '-'} · dm=${d.decision_makers.status}${d.decision_makers.name ? `(${d.decision_makers.name})` : ''} · opener_asked=${d.opener.asked}`);
    if (flag('--verbose')) console.log(disciplineBlock(d, established));
    if (nextOut) {
      const { verdicts, fixed } = judge(nextOut.text, d, first);
      console.log(`BEFORE (sent): "${nextOut.text.slice(0, 400)}"`);
      if (verdicts.length) {
        console.log(`GUARDS: ${verdicts.map(v => `\n  - ${v}`).join('')}`);
        console.log(`AFTER (second-draft rewrite): "${fixed.slice(0, 400)}"`);
      } else {
        console.log('GUARDS: clean');
      }
    }
  }
}

async function replayLive(contactId) {
  const { buildLeadContext } = await import('../src/context-builder.js');
  const context = await buildLeadContext(contactId, { includeConversation: true, skipCache: true });
  const convo = context.conversation_recent || [];
  const newestInbound = [...convo].reverse().find(t => t.direction === 'inbound');
  if (!newestInbound) { console.error('no inbound message on this contact'); process.exit(2); }
  const established = buildEstablishedFacts({ conversation: convo, lead: context.lead, lp: context.lp, intelligence: context.intelligence, estimate: context.estimate });
  const d = buildDiscipline({ triggerMessage: newestInbound.text, conversation: convo, established, nowMs: Date.parse(context.now?.iso || '') || Date.now() });
  console.log(`contact ${contactId} (${context.lead?.name || 'unnamed'}) — newest inbound: "${newestInbound.text.slice(0, 200)}"`);
  console.log(disciplineBlock(d, established));
  if (flag('--generate')) {
    const { generateResponse } = await import('../src/response-generator.js');
    const out = await generateResponse(contactId, 'sms', newestInbound.text, { dryRun: true, threadSenderType: 'rep' });
    console.log(`\nGENERATED (dry run, nothing sent):\n"${out.message}"`);
    if (out.discipline_rewrites) console.log(`(discipline rewrites applied on the second draft: ${out.discipline_rewrites})`);
    if (out.dm_handoff) console.log(`(decision-maker handoff: ${JSON.stringify(out.dm_handoff)})`);
  }
  // In offline mode the historical outbounds are judged; live mode judges the
  // last one so the same before/after shows up.
  const lastOut = [...convo].reverse().find(t => t.direction === 'outbound');
  if (lastOut) {
    const { verdicts, fixed } = judge(lastOut.text, d, (context.lead?.name || '').split(/\s+/)[0]);
    console.log(`\nLAST OUTBOUND (before): "${lastOut.text.slice(0, 400)}"`);
    console.log(verdicts.length ? `GUARDS: ${verdicts.map(v => `\n  - ${v}`).join('')}\nAFTER: "${fixed}"` : 'GUARDS: clean');
  }
}

const threadFile = opt('--thread');
if (threadFile) {
  const raw = JSON.parse(fs.readFileSync(threadFile, 'utf8'));
  const thread = Array.isArray(raw) ? raw : (raw.messages || raw.thread || []);
  const leadName = Array.isArray(raw) ? opt('--name') : (raw.lead_name || opt('--name'));
  const onlyTurn = opt('--turn') ? Number(opt('--turn')) : null;
  replayOffline(thread, { leadName, onlyTurn });
} else if (args[0] && !args[0].startsWith('--')) {
  replayLive(args[0]).catch(err => { console.error(err); process.exit(1); });
} else {
  console.error('usage: node scripts/replay-thread-prompt.js <contactId> [--generate] | --thread <file.json> [--name "First Last"] [--turn N] [--verbose]');
  process.exit(2);
}
