/**
 * Slack approvals — pure core. src/slack-approvals-core.js
 *
 * No I/O and no project imports on purpose, so every rule that decides whether
 * a click is trusted can be tested offline (scripts/test-slack-approvals.js).
 */
import crypto from 'node:crypto';

export const MAX_SKEW_SEC = 60 * 5;
export const ACTION_APPROVE = 'approval_approve';
export const ACTION_REJECT = 'approval_reject';

/** Escape the three characters Slack mrkdwn treats as control characters. */
export function escapeMrkdwn(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Comma-separated Slack member IDs -> Set. EMPTY MEANS NOBODY: an unset
 * allowlist refuses every click. It never means "allow all".
 */
export function parseApproverIds(raw) {
  return new Set(String(raw || '').split(',').map((s) => s.trim()).filter(Boolean));
}

/**
 * Slack request signing, v0 scheme. Constant-time compare, 5-minute replay
 * window. Returns { ok, reason }. Never throws.
 */
export function verifySlackSignature({ rawBody, timestamp, signature, secret, nowSec = Math.floor(Date.now() / 1000) }) {
  if (!secret) return { ok: false, reason: 'no_secret' };
  if (rawBody == null || !timestamp || !signature) return { ok: false, reason: 'missing_header' };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > MAX_SKEW_SEC) return { ok: false, reason: 'stale' };
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const expected = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  // Length check first: timingSafeEqual THROWS on a length mismatch, and a
  // forged signature of the wrong length would otherwise crash the route
  // rather than being refused.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

/** response_url must be Slack's own hook host; anything else is ignored. */
export function isSlackResponseUrl(url) {
  return typeof url === 'string' && url.startsWith('https://hooks.slack.com/');
}

/**
 * Parse an interactivity POST (form-encoded `payload=<json>`). Returns null
 * for anything that is not one of our two buttons with a numeric ref.
 */
export function parseInteraction(rawBody) {
  const params = new URLSearchParams(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || ''));
  const raw = params.get('payload');
  if (!raw) return null;
  let p;
  try { p = JSON.parse(raw); } catch { return null; }
  if (p?.type !== 'block_actions') return null;
  const action = Array.isArray(p.actions) ? p.actions[0] : null;
  if (!action) return null;
  const decision = action.action_id === ACTION_APPROVE ? 'approve'
    : action.action_id === ACTION_REJECT ? 'reject' : null;
  if (!decision) return null;
  const shortRef = String(action.value ?? '').trim();
  if (!/^\d+$/.test(shortRef)) return null;
  return {
    decision,
    shortRef,
    userId: String(p.user?.id || ''),
    userName: String(p.user?.name || p.user?.username || p.user?.id || 'unknown'),
    responseUrl: isSlackResponseUrl(p.response_url) ? p.response_url : '',
    originalText: String(p.message?.text || ''),
  };
}

/** Section with the card body + Approve (confirm dialog) / Reject buttons. */
export function buildApprovalBlocks(text, shortRef) {
  const ref = String(shortRef);
  return [
    { type: 'section', text: { type: 'mrkdwn', text: escapeMrkdwn(text).slice(0, 2900) } },
    {
      type: 'actions',
      block_id: `approval_${ref}`,
      elements: [
        {
          type: 'button',
          action_id: ACTION_APPROVE,
          style: 'primary',
          text: { type: 'plain_text', text: 'Approve' },
          value: ref,
          confirm: {
            title: { type: 'plain_text', text: 'Approve these actions?' },
            text: { type: 'mrkdwn', text: `This runs every action in #${ref}.` },
            confirm: { type: 'plain_text', text: 'Approve' },
            deny: { type: 'plain_text', text: 'Cancel' },
          },
        },
        {
          type: 'button',
          action_id: ACTION_REJECT,
          style: 'danger',
          text: { type: 'plain_text', text: 'Reject' },
          value: ref,
        },
      ],
    },
  ];
}
