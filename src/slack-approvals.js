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
 *
 * ─── FAN-OUT (2026-09-21) ────────────────────────────────────────────────
 *
 * A Slack app has exactly ONE Interactivity Request URL, and this workspace's
 * was already spoken for: the n8n workflow "OPS.SLK-E Approval Buttons" owns
 * the team-onboarding Approve / Deny buttons on #ops-alerts. Pointing Slack
 * here would have silently broken onboarding.
 *
 * So this route is the FRONT DOOR for every interactivity POST, not just ours:
 *
 *   Slack → /webhook/slack/interactions
 *              ├─ approval_approve / approval_reject  → resolveApproval()
 *              └─ anything else → SLACK_INTERACTIONS_FORWARD_URL, raw bytes
 *                                 and Slack's signing headers unchanged
 *
 * Three rules make that safe:
 *
 *   - FORWARDING IS INDEPENDENT OF SLACK_APPROVALS_ENABLED. Once Slack points
 *     here, onboarding clicks must work whether or not agent approvals are on.
 *     Gating the forward on our own feature flag is how you break someone
 *     else's production flow with a flag flip.
 *   - OUR OWN BUTTONS ARE NEVER FORWARDED, even with the flag off. n8n's
 *     parser treats any action_id that is not `deny_member` as an approval, so
 *     leaking an `approval_approve` click into it would read as "approve a team
 *     member" with a null id.
 *   - THE SIGNATURE IS CHECKED BEFORE EITHER PATH. Unset SLACK_SIGNING_SECRET
 *     refuses everything (verifySlackSignature returns no_secret) — including
 *     forwards. That is deliberate: set the secret BEFORE repointing Slack.
 *     The upside is that the onboarding flow, which verifies nothing of its
 *     own, gets signature checking it never had.
 */
import express from 'express';
import { resolveApproval } from './groupme.js';
import { slackApprovalsEnabled } from './slack.js';
import { trackBackground } from './graceful-shutdown.js';
import { verifySlackSignature, parseInteraction, parseApproverIds } from './slack-approvals-core.js';

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || '';
const APPROVERS = parseApproverIds(process.env.SLACK_APPROVER_IDS);

// Where interactions that are not ours go. https only — a plaintext hop would
// put the whole Slack payload on the wire. Unset = forwarding off.
const RAW_FORWARD_URL = (process.env.SLACK_INTERACTIONS_FORWARD_URL || '').trim();
const FORWARD_URL = RAW_FORWARD_URL.startsWith('https://') ? RAW_FORWARD_URL : '';
if (RAW_FORWARD_URL && !FORWARD_URL) {
  console.error(`[SlackApprovals] SLACK_INTERACTIONS_FORWARD_URL must start with https:// — forwarding DISABLED (got "${RAW_FORWARD_URL.slice(0, 40)}")`);
}

console.log(`[SlackApprovals] enabled=${slackApprovalsEnabled()} secret=${SIGNING_SECRET ? 'set' : 'unset'} approvers=${APPROVERS.size} forward=${FORWARD_URL ? new URL(FORWARD_URL).host : '-'}`);
// A forward target with no secret refuses every click, ours and theirs alike.
// Say so at boot rather than letting it be discovered by a broken onboarding.
if (FORWARD_URL && !SIGNING_SECRET) {
  console.error('[SlackApprovals] FORWARDING IS CONFIGURED BUT SLACK_SIGNING_SECRET IS UNSET — every interaction will be refused with 401. Set the secret.');
}

/** Mounted ahead of the global parsers in index.js, so the signature sees the exact bytes. */
export function slackRawBodyParser() {
  return express.raw({ type: 'application/x-www-form-urlencoded', limit: '1mb' });
}

/**
 * Hand an interaction that is not ours to its real owner, byte-for-byte.
 *
 * The body is relayed as the exact Buffer Slack sent, and the two signing
 * headers ride along, so the destination can verify the signature itself if it
 * ever starts to. Nothing else is copied — no auth headers, no cookies.
 *
 * ONE ATTEMPT, no retry. The destination replaces the Slack card through
 * response_url, so a dropped forward leaves the buttons visibly unclicked and
 * the operator simply clicks again; a retry would risk two card replacements
 * for one click. Never throws.
 */
export async function forwardInteraction(rawBody, headers = {}, { url = FORWARD_URL, fetchImpl = fetch } = {}) {
  if (!url) return { forwarded: false, reason: 'no_url' };
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Slack-Request-Timestamp': String(headers['x-slack-request-timestamp'] || ''),
        'X-Slack-Signature': String(headers['x-slack-signature'] || ''),
      },
      body: rawBody,
      signal: AbortSignal.timeout(8000),
    });
    if (!res?.ok) {
      console.error(`[SlackApprovals] forward failed: HTTP ${res?.status}`);
      return { forwarded: false, reason: `http_${res?.status}` };
    }
    return { forwarded: true };
  } catch (err) {
    console.error(`[SlackApprovals] forward threw: ${err.message}`);
    return { forwarded: false, reason: err.message };
  }
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

/**
 * @param {object} app — express app
 * @param {object} [deps] — network seam, per the repo's deps convention. Tests
 *   point `forwardUrl` at a local stub; production passes nothing.
 */
export function registerSlackApprovalRoutes(app, { forwardUrl = FORWARD_URL, forward = forwardInteraction } = {}) {
  app.post('/webhook/slack/interactions', (req, res) => {
    const approvalsOn = slackApprovalsEnabled();
    // Nothing configured for either job — ack so Slack does not retry, and stop.
    if (!approvalsOn && !forwardUrl) {
      console.log('[SlackApprovals] click received while disabled and not forwarding — ignored');
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

    // Parsed BEFORE the flag is consulted: one of our buttons is ours to drop
    // when approvals are off, never to forward into someone else's workflow.
    const parsed = parseInteraction(req.body);
    const rawBody = req.body;
    const headers = req.headers;
    res.status(200).send('');

    if (parsed) {
      if (!approvalsOn) {
        console.log(`[SlackApprovals] click on #${parsed.shortRef} received while disabled — ignored`);
        return;
      }
      trackBackground(
        handleInteraction(parsed).catch((err) => console.error(`[SlackApprovals] handler error: ${err.message}`)),
      );
      return;
    }

    if (forwardUrl) {
      trackBackground(forward(rawBody, headers, { url: forwardUrl }));
    }
  });
  console.log(`[SlackApprovals] Registered: POST /webhook/slack/interactions${forwardUrl ? ' (fan-out on)' : ''}`);
}
