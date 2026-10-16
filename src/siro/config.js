/**
 * Siro configuration — src/siro/config.js (2026-10-16, Siro PR 1)
 *
 * Every Siro environment variable and its default, in one place, so the client,
 * the jobs, the context read and the F.0 step never disagree on a default.
 * Every *_MODE here is registered in src/mode-registry.js (decider Mark,
 * go-live NEEDS_RULING); the registry scan reads `env.X_MODE` from this file.
 *
 * AIOS: CANON.K.078 (least privilege: one org credential, read-mostly), K.070
 * (a bad value falls back to the safe default, never throws).
 */

export const SIRO_ORG_BASE = 'https://functions.siro.ai/api-externalApi/v1';
export const SIRO_USER_BASE = 'https://api.siro.ai/v1';
export const SIRO_TOKEN_URL = 'https://auth.siro.ai/oauth2/token';
export const SIRO_APP_BASE = 'https://app.siro.ai';

function pick(value, allowed, fallback) {
  const v = String(value ?? '').trim().toLowerCase();
  return allowed.includes(v) ? v : fallback;
}
function num(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
const OSL = ['off', 'shadow', 'live'];
const OL = ['off', 'live'];

export function siroModes(env = process.env) {
  return {
    webhook: pick(env.SIRO_WEBHOOK_MODE, OSL, 'shadow'),
    sync: pick(env.SIRO_SYNC_MODE, OSL, 'shadow'),
    context: pick(env.SIRO_CONTEXT_MODE, OSL, 'shadow'),
    ensure: pick(env.SIRO_ENSURE_MODE, OL, 'off'),
    demoNote: pick(env.SIRO_DEMO_NOTE_MODE, OSL, 'shadow'),
    scorecardSync: pick(env.SIRO_SCORECARD_SYNC_MODE, OL, 'off'),
    f0: pick(env.F0_V2_MODE, OSL, 'shadow'),
  };
}

export function siroConfig(env = process.env) {
  return {
    clientId: env.SIRO_CLIENT_ID || '',
    clientSecret: env.SIRO_CLIENT_SECRET || '',
    legacyToken: env.SIRO_API || '',
    webhookSecret: env.SIRO_WEBHOOK_SECRET || '',
    // 2026-10-16 (the user): a second, shared header key on top of the svix signature.
    webhookHeaderKey: env.SIRO_WEBHOOK_HEADER_KEY || '',
    organizationId: env.SIRO_ORGANIZATION_ID || '',
    lpConnectionId: env.SIRO_LP_CONNECTION_ID || '',
    presentationConversationType: env.SIRO_PRESENTATION_CONVERSATION_TYPE || '',
    lpNoteAuthor: env.SIRO_LP_NOTE_AUTHOR || 'Siro',
    storeUtterances: String(env.SIRO_STORE_UTTERANCES || 'false').toLowerCase() === 'true',
    // Siro allows 1,000 requests per credential per minute; we keep headroom.
    ratePerMin: num(env.SIRO_RATE_PER_MIN, 600, { min: 1, max: 1000 }),
    waitMaxH: num(env.SIRO_WAIT_MAX_H, 24, { min: 0, max: 168 }),
    waitHoldH: num(env.SIRO_WAIT_HOLD_H, 2, { min: 1, max: 24 }),
    nurtureShadowWorkflows: String(env.NURTURE_SHADOW_WORKFLOWS ?? 'F.0')
      .split(',').map(s => s.trim()).filter(Boolean),
    f0ApprovalChannel: env.F0_APPROVAL_CHANNEL || env.SLACK_CHANNEL_REHASH || 'C0C5YMHNYJH',
  };
}

export function siroRecordingUrl(recordingId) {
  return `${SIRO_APP_BASE}/analyze/${encodeURIComponent(String(recordingId || ''))}`;
}
