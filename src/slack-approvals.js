/**
 * Slack approval buttons — src/slack-approvals.js
 *
 * POST /webhook/slack/interactions receives Approve / Reject clicks from the
 * approval cards posted by src/slack.js:postSlackApprovalCard and resolves
 * them through groupme.js:resolveApproval, the same path GroupMe replies use.
 *
 * WHY THIS EXISTS (2026-09-21): src/slack.js was send-only. Approval cards
 * reached Slack as a text mirror whose footer read "Reply: Yes <ref>", but
 * nothing in this repo received anything from Slack. Mark replied "yes" in
 * Slack and nothing happened.
 *
 * Trust chain, all required:
 *   1. SLACK_APPROVALS_ENABLED=true (off → every click is a logged no-op)
 *   2. Valid Slack v0 signature over the RAW body, within 5 minutes
 *   3. Clicking user's member ID is in SLACK_APPROVER_IDS (empty → nobody)
 *
 * Slack needs a 200 within 3 seconds, so we ack immediately and do the work in
 * the background, reporting back through the click's response_url.
 */
import express from 'express';
import { resolveApproval } from './groupme.js';
import { slackApprovalsEnabled } from './slack.js';
import { trackBackground } from './graceful-shutdown.js';
import { verifySlackSignature, parseInteraction, parseApproverIds } from './slack-approvals-core.js';

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || '';
const APPROVERS = parseApproverIds(process.env.SLACK_APPROVER_IDS);

console.log(`[SlackApprovals] enabled=${slackApprovalsEnabled()} secret=${SIGNING_SECRET ? 'set' : 'unset'} approvers=${APPROVERS.size}`);

/** Mounted ahead of the global parsers in index.js, so the signature sees the exact bytes. */
export function slackRawBodyParser() {
  return express.raw({ type: 'application/x-www-form-urlencoded', limit: '1mb' });
}

async function respond(responseUrl, body) {
  if (!responseUrl) return;
  try {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    console.warn(`[SlackApprovals] response_url post failed: ${err.message}`);
  }
}

export async function handleInteraction(parsed, { approvers = APPROVERS, resolver = resolveApproval, reply = respond } = {}) {
  const { decision, shortRef, userId, userName, responseUrl, originalText } = parsed;

  if (!approvers.has(userId)) {
    console.warn(`[SlackApprovals] refused ${decision} #${shortRef} from non-approver ${userName} (${userId})`);
    await reply(responseUrl, {
      response_type: 'ephemeral',
      replace_original: false,
      text: `You're not on the approver list for agent actions, so #${shortRef} was not changed. Ask Mark to add your Slack member ID.`,
    });
    return { handled: true, action: 'unauthorized' };
  }

  const result = await resolver({ shortRef, approve: decision === 'approve', resolverName: `${userName} (slack)`, via: 'slack' });

  if (result.ok) {
    const icon = decision === 'approve' ? '✅' : '🚫';
    const verb = decision === 'approve' ? 'Approved' : 'Rejected';
    const n = result.actionCount;
    const detail = n === 0
      ? 'no actions were still waiting (handled elsewhere)'
      : `${n} action${n === 1 ? '' : 's'} ${decision === 'approve' ? 'queued' : 'cancelled'}`;
    await reply(responseUrl, { replace_original: true, text: `${originalText}\n\n${icon} ${verb} by ${userName} — ${detail}.` });
    return { handled: true, action: result.outcome };
  }

  if (result.outcome === 'already_resolved') {
    await reply(responseUrl, {
      replace_original: true,
      text: `${originalText}\n\nℹ️ Already ${result.previousStatus}${result.resolvedBy ? ` by ${result.resolvedBy}` : ''}.`,
    });
    return { handled: true, action: 'already_resolved' };
  }

  if (result.outcome === 'not_found') {
    await reply(responseUrl, { replace_original: true, text: `${originalText}\n\n❓ No pending approval #${shortRef} — it may have expired.` });
    return { handled: true, action: 'not_found' };
  }

  await reply(responseUrl, {
    response_type: 'ephemeral',
    replace_original: false,
    text: `❌ Couldn't ${decision} #${shortRef}: ${String(result.error || 'unknown error').slice(0, 200)}. Nothing changed. Try again.`,
  });
  return { handled: true, action: 'error' };
}

export function registerSlackApprovalRoutes(app) {
  app.post('/webhook/slack/interactions', (req, res) => {
    if (!slackApprovalsEnabled()) {
      console.log('[SlackApprovals] click received while disabled — ignored');
      return res.status(200).send('');
    }
    const v = verifySlackSignature({
      rawBody: Buffer.isBuffer(req.body) ? req.body : null,
      timestamp: req.headers['x-slack-request-timestamp'],
      signature: req.headers['x-slack-signature'],
      secret: SIGNING_SECRET,
    });
    if (!v.ok) {
      console.warn(`[SlackApprovals] rejected request: ${v.reason}`);
      return res.status(401).send('');
    }
    const parsed = parseInteraction(req.body);
    res.status(200).send('');
    if (!parsed) return;
    trackBackground(
      handleInteraction(parsed).catch((err) => console.error(`[SlackApprovals] handler error: ${err.message}`)),
    );
  });
  console.log('[SlackApprovals] Registered: POST /webhook/slack/interactions');
}
