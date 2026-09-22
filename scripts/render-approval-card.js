#!/usr/bin/env node
/**
 * render-approval-card.js — DRY RUN. Prints the approval card an
 * agent_actions row would produce, for GroupMe and for Slack, and sends
 * nothing.
 *
 *   node scripts/render-approval-card.js 486315
 *   railway run node scripts/render-approval-card.js 486315
 *
 * READ-ONLY by construction: it goes through renderApprovalCard (the same
 * function sendApprovalRequest uses) and never calls sendApprovalRequest,
 * which is the only path that claims a groupme_approval_requests row or posts.
 * It also skips resolveLPProspectId on purpose — that resolver can write the
 * prospect id back to GHL, and a dry run must not write anything. The prospect
 * id comes from the lp_leads row instead.
 *
 * Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (and GHL creds for the
 * contact name); run it where those are set.
 */
import supabase from '../src/supabase.js';
import { renderApprovalCard } from '../src/groupme.js';
import { resolveContactInfo, getEventContext } from '../src/actions/resolvers.js';
import { buildNotificationEnrichment } from '../src/actions/enrichment.js';
import { buildApprovalBlocks } from '../src/slack-approvals-core.js';

const id = process.argv[2];
if (!/^\d+$/.test(String(id || ''))) {
  console.error('usage: node scripts/render-approval-card.js <agent_actions id>');
  process.exit(2);
}
if (!supabase) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.');
  process.exit(2);
}

const { data: first, error } = await supabase.from('agent_actions').select('*').eq('id', id).maybeSingle();
if (error || !first) {
  console.error(`agent_actions #${id} not found${error ? `: ${error.message}` : ''}`);
  process.exit(1);
}

// The whole batch, the way processApprovalQueue groups it.
let actions = [first];
if (first.batch_id) {
  const { data } = await supabase.from('agent_actions').select('*').eq('batch_id', first.batch_id)
    .order('sequence_order', { ascending: true });
  if (data?.length) actions = data;
}

const { name, phone, lpLead, ghlContactId, ghlContact } = await resolveContactInfo(first.target_id);
const ctx = await getEventContext(first);
const enrichment = await buildNotificationEnrichment(first.target_id, ctx, {
  lpLead, ghlContactId, ghlContact, prospectId: lpLead?.lp_prospect_id ? String(lpLead.lp_prospect_id) : null,
});

const { slackCardText, groupmeText } = await renderApprovalCard(actions, name, phone, enrichment);

console.log('──── GroupMe ────');
console.log(groupmeText);
console.log('\n──── Slack (blocks) ────');
console.log(JSON.stringify(buildApprovalBlocks(slackCardText, String(actions[0].id)), null, 2));
process.exit(0);
