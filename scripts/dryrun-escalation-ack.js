/**
 * dryrun-escalation-ack.js — verify acknowledgment-only conduct against a REAL
 * contact's live context, without sending anything or writing anything.
 *
 * NOT part of `npm test` (the glob is scripts/test-*.js): this makes live GHL,
 * LP, and LLM calls, so it is deterministic only in the sense that it asserts
 * the same contract the unit tests do — assertAcknowledgmentBody() is shared
 * with scripts/test-responder-context.js so the two cannot drift.
 *
 * Why a live run is needed at all
 * ──────────────────────────────
 * The unit tests exercise buildResponsePrompt over a Kelly fixture. That proves
 * the prompt carries the right directives. It does NOT prove the model obeys
 * them. This runs the real generator, end to end, and asserts on the body the
 * model actually produced.
 *
 * Safety: generateResponse() is not naturally side-effect free — it promotes
 * identity fields to GHL, stamps booking:active / email-asked tags, persists
 * preferred times, and emits events. opts.dryRun suppresses all seven write
 * sites. Nothing is sent to the customer on any path; sending lives in
 * send-message-handler, which is never called here.
 *
 * Usage:
 *   node scripts/dryrun-escalation-ack.js <contactId> [triggerMessage]
 *
 * Exit code 0 = the generated body satisfies the acknowledgment contract.
 */

import { generateResponse, assertAcknowledgmentBody, resolveOwningRepName } from '../src/response-generator.js';
import { buildLeadContext } from '../src/context-builder.js';

const contactId = process.argv[2];
const triggerMessage = process.argv[3]
  || "I have not received an estimate. I'm interested in the product, but still have not heard from Beverly.";

if (!contactId) {
  console.error('usage: node scripts/dryrun-escalation-ack.js <contactId> [triggerMessage]');
  process.exit(2);
}

const line = (s = '') => console.log(s);

line(`\n═══ DRY RUN — escalation acknowledgment ═══`);
line(`contact:  ${contactId}`);
line(`trigger:  "${triggerMessage}"`);
line(`writes:   SUPPRESSED (dryRun)   sends: NONE\n`);

// Show the state we are generating against, so a reviewer can confirm the
// fixture really does reproduce the incident conditions.
const ctx = await buildLeadContext(contactId, { includeConversation: true, skipCache: true });
const owner = resolveOwningRepName(ctx);
line(`live stage tag:     ${ctx.lead?.current_stage_tag || '(none)'}`);
line(`lp.demo_completed:  ${ctx.lp?.demo_completed}`);
line(`lp.disposition:     ${ctx.lp?.disposition_code || ctx.lp?.disposition || '(none)'}`);
line(`owning field rep:   ${owner || '(none)'}`);
line(`tags:               ${(ctx.lead?.current_tags || []).slice(0, 12).join(', ')}\n`);

const generated = await generateResponse(contactId, 'email', triggerMessage, {
  dryRun: true,
  recommendedAction: 'escalate_to_rep',
  escalationCategory: 'existing_customer_service',
  threadSenderType: 'mark',
});

if (generated?.short_circuit) {
  line(`SHORT-CIRCUIT: ${generated.intent_class || 'n/a'} — no body generated.`);
  process.exit(1);
}

const body = generated?.message || '';
line('─── generated body ───');
line(body);
line('──────────────────────\n');

const violations = assertAcknowledgmentBody(body, { ownerName: owner });
if (violations.length) {
  line(`❌ FAIL — ${violations.length} violation(s):`);
  for (const v of violations) line(`   · ${v}`);
  line('\nAcknowledgment mode is NOT ready. Leave A1 in place.');
  process.exit(1);
}

line('✅ PASS — body satisfies the acknowledgment contract:');
line('   · no handoff bridge');
line('   · no booking/rebooking vocabulary');
line('   · no time commitment');
line('   · no question, no link, no unresolved token');
line(`   · names the owning rep${owner ? ` (${owner})` : ''}`);
line('   · two sentences or fewer\n');
process.exit(0);
