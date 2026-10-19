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

// ─── Payroll run approval (2026-09-26) ──────────────────────────────────────
//
// A separate action id, not a third decision on approval_approve: the agent
// approval path resolves a numeric groupme_approval_requests ref, while a
// payroll card carries a run uuid and is authorised against a different list
// (active lf_report_approvers emails, not SLACK_APPROVER_IDS).
//
// It MUST be recognised here. Anything this module does not parse is relayed
// to n8n's onboarding workflow, which reads every action_id that is not
// `deny_member` as an approval (CLAUDE.md, "front door for the WHOLE
// workspace").

export const ACTION_PAYROLL_APPROVE = 'payroll_approve';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse a payroll Approve click. Returns null for anything else — including a
 * payroll click whose value is not a uuid, which is dropped rather than
 * forwarded (see isPayrollAction).
 */
export function parsePayrollInteraction(rawBody) {
  const params = new URLSearchParams(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || ''));
  const raw = params.get('payload');
  if (!raw) return null;
  let p;
  try { p = JSON.parse(raw); } catch { return null; }
  if (p?.type !== 'block_actions') return null;
  const action = Array.isArray(p.actions) ? p.actions[0] : null;
  if (action?.action_id !== ACTION_PAYROLL_APPROVE) return null;
  const runId = String(action.value ?? '').trim();
  if (!UUID_RE.test(runId)) return null;
  return {
    kind: 'payroll',
    decision: 'approve',
    runId,
    userId: String(p.user?.id || ''),
    userName: String(p.user?.name || p.user?.username || p.user?.id || 'unknown'),
    responseUrl: isSlackResponseUrl(p.response_url) ? p.response_url : '',
    originalText: String(p.message?.text || ''),
  };
}

/** True for ANY click on a payroll_* action, parseable or not — never forwarded. */
export function isPayrollAction(rawBody) {
  const params = new URLSearchParams(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || ''));
  try {
    const p = JSON.parse(params.get('payload') || 'null');
    const id = Array.isArray(p?.actions) ? String(p.actions[0]?.action_id || '') : '';
    return id.startsWith('payroll_');
  } catch { return false; }
}

/** Card body + one Approve button (confirm dialog). No Reject: disputes are resolved line by line. */
export function buildPayrollApproveBlocks(text, runId, pendingLabel = '') {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: escapeMrkdwn(text).slice(0, 2900) } },
    {
      type: 'actions',
      block_id: `payroll_${runId}`,
      elements: [
        {
          type: 'button',
          action_id: ACTION_PAYROLL_APPROVE,
          style: 'primary',
          text: { type: 'plain_text', text: 'Approve payroll' },
          value: String(runId),
          confirm: {
            title: { type: 'plain_text', text: 'Approve this payroll run?' },
            text: {
              type: 'mrkdwn',
              text: `Approves the pending lines${pendingLabel ? ` (${pendingLabel})` : ''}. Needs-review and disputed lines are NOT approved. No money moves — paid is marked by a person.`,
            },
            confirm: { type: 'plain_text', text: 'Approve' },
            deny: { type: 'plain_text', text: 'Cancel' },
          },
        },
      ],
    },
  ];
}

// ─── DNC-lift buttons (2026-09-28, Consent Model v1) ─────────────────────────
// The Approve Lift / Keep Blocked buttons n8n's "OPS.DNC-LIFT Slack Approval"
// posts in #dnc-lift-approval. Slack sends their clicks to this app's ONE
// interactivity URL like every other button, so the front door must recognise
// them: relayed to the onboarding workflow, `dnc_lift_approve` would read as
// "approve a team member" (it treats every action_id but deny_member as an
// approval). They go ONLY to SLACK_DNC_LIFT_FORWARD_URL, or nowhere.
export const DNC_LIFT_ACTION_PREFIX = 'dnc_lift_';

/** True for ANY click on a dnc_lift_* action — never relayed to onboarding. */
export function isDncLiftAction(rawBody) {
  const params = new URLSearchParams(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || ''));
  try {
    const p = JSON.parse(params.get('payload') || 'null');
    const id = Array.isArray(p?.actions) ? String(p.actions[0]?.action_id || '') : '';
    return id.startsWith(DNC_LIFT_ACTION_PREFIX);
  } catch { return false; }
}

// ─── Marketing invoice review buttons (2026-10-12, migration 20261012222106) ──────────────────
// Approve / Edit / Reject on the #marketing-invoice-review card
// (src/marketing/slack-review.js), plus the Edit MODAL's view_submission. Both
// are ours and NEVER relayed: the onboarding workflow reads any action_id but
// deny_member as "approve a team member", and it has never seen a
// view_submission at all. Authorised against MKT_INVOICE_APPROVER_SLACK_IDS
// (Mark, Brad Codman — D6), empty = nobody, in src/marketing/review-actions.js.
export const MKT_INVOICE_ACTION_PREFIX = 'mktinv_';
/** Choices inside the Edit form that redraw it (show/hide fields). Keep in step with slack-review.js. */
export const MKT_INVOICE_FORM_CHANGE_ACTIONS = Object.freeze(['mktinv_v_split', 'mktinv_v_vendor']);

function payloadOf(rawBody) {
  const params = new URLSearchParams(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || ''));
  try { return JSON.parse(params.get('payload') || 'null'); } catch { return null; }
}

/** True for ANY mktinv_* button click or mktinv_* modal submission — never forwarded. */
export function isMarketingInvoiceAction(rawBody) {
  const p = payloadOf(rawBody);
  if (!p) return false;
  if (p.type === 'block_actions') {
    const id = Array.isArray(p.actions) ? String(p.actions[0]?.action_id || '') : '';
    return id.startsWith(MKT_INVOICE_ACTION_PREFIX);
  }
  if (p.type === 'view_submission' || p.type === 'view_closed') {
    return String(p.view?.callback_id || '').startsWith(MKT_INVOICE_ACTION_PREFIX);
  }
  return false;
}

/**
 * Parse a marketing-invoice interaction. Returns null for anything malformed
 * (which the route DROPS, never forwards): a non-uuid document id, an unknown
 * decision, a modal without its document in private_metadata.
 */
export function parseMarketingInvoiceInteraction(rawBody) {
  const p = payloadOf(rawBody);
  if (!p) return null;
  const user = { userId: String(p.user?.id || ''), userName: String(p.user?.name || p.user?.username || p.user?.id || 'unknown') };
  if (p.type === 'block_actions') {
    const action = Array.isArray(p.actions) ? p.actions[0] : null;
    const id = String(action?.action_id || '');
    if (!id.startsWith(MKT_INVOICE_ACTION_PREFIX)) return null;
    // 2026-10-19: a choice changed INSIDE the open Edit form ("What is this
    // cost?" or the vendor pick). The form redraws itself to show only the
    // fields that choice needs; the document id rides in private_metadata.
    if (p.view && MKT_INVOICE_FORM_CHANGE_ACTIONS.includes(id)) {
      const documentId = String(p.view.private_metadata || '').trim();
      if (!UUID_RE.test(documentId)) return null;
      return {
        kind: 'mktinv', decision: 'form_change', documentId, ...user,
        viewId: String(p.view.id || ''), viewHash: String(p.view.hash || ''),
        values: p.view.state?.values || {}, triggerId: '', responseUrl: '',
      };
    }
    const decision = id.slice(MKT_INVOICE_ACTION_PREFIX.length);
    if (!['approve', 'reject', 'edit'].includes(decision)) return null;
    const documentId = String(action.value ?? '').trim();
    if (!UUID_RE.test(documentId)) return null;
    return {
      kind: 'mktinv', decision, documentId, ...user,
      triggerId: String(p.trigger_id || ''),
      responseUrl: isSlackResponseUrl(p.response_url) ? p.response_url : '',
      channelId: String(p.channel?.id || p.container?.channel_id || ''),
      messageTs: String(p.message?.ts || p.container?.message_ts || ''),
    };
  }
  if (p.type === 'view_submission') {
    if (!String(p.view?.callback_id || '').startsWith(MKT_INVOICE_ACTION_PREFIX)) return null;
    const documentId = String(p.view?.private_metadata || '').trim();
    if (!UUID_RE.test(documentId)) return null;
    return { kind: 'mktinv', decision: 'edit_submit', documentId, ...user, values: p.view?.state?.values || {}, triggerId: '', responseUrl: '' };
  }
  return null;
}


// ─── System health incident buttons (2026-10-15, System Health 1.6) ─────────
// incident_ack / incident_snooze (and the incident_open URL button, which Slack
// still reports as a click). Ours, and NEVER forwarded: the onboarding workflow
// reads any action_id but deny_member as "approve a team member".
export const INCIDENT_ACTION_PREFIX = 'incident_';

export function isIncidentAction(rawBody) {
  const p = payloadOf(rawBody);
  if (!p || p.type !== 'block_actions') return false;
  const id = Array.isArray(p.actions) ? String(p.actions[0]?.action_id || '') : '';
  return id.startsWith(INCIDENT_ACTION_PREFIX);
}

/** { action: 'ack'|'snooze'|'open', incidentId, userId, userName, responseUrl } or null. */
export function parseIncidentInteraction(rawBody) {
  const p = payloadOf(rawBody);
  const a = Array.isArray(p?.actions) ? p.actions[0] : null;
  const actionId = String(a?.action_id || '');
  if (!actionId.startsWith(INCIDENT_ACTION_PREFIX)) return null;
  const action = actionId.slice(INCIDENT_ACTION_PREFIX.length);
  if (action === 'open') return { action, incidentId: null, userId: p.user?.id || null };
  const incidentId = Number(a?.value);
  if (!['ack', 'snooze'].includes(action) || !Number.isInteger(incidentId) || incidentId <= 0) return null;
  return {
    action,
    incidentId,
    userId: p.user?.id || null,
    userName: p.user?.username || p.user?.name || null,
    responseUrl: p.response_url || null,
  };
}
