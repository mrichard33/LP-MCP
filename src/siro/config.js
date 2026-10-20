/**
 * Siro configuration — src/siro/config.js (2026-10-16, Siro PR 1)
 *
 * Every Siro environment variable and its default, in one place, so the client,
 * the jobs, the context read and the F.0 step never disagree on a default.
 * Every *_MODE here is registered in src/mode-registry.js (decider Mark,
 * go-live NEEDS_RULING); scripts/test-mode-registry.js finds each read here.
 *
 * AIOS: CANON.K.078 (least privilege: one org credential, read-mostly), K.070
 * (a bad value falls back to the safe default, never throws).
 */

import { simSiroOverrides } from '../simulator/sim-overrides.js';

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
export const F0_FORMULAS = ['v1', 'four_step'];

// 2026-10-19: a bot-gate run may try SIRO_CONTEXT_MODE, SIRO_FOLLOWUP_TEXT_MODE
// and F0_FORMULA_MODE without Railway (src/simulator/sim-overrides.js). Outside
// a simulation the overrides are null and the environment decides.
export function siroModes(env = process.env) {
  const sim = simSiroOverrides();
  return {
    webhook: pick(env.SIRO_WEBHOOK_MODE, OSL, 'shadow'),
    sync: pick(env.SIRO_SYNC_MODE, OSL, 'shadow'),
    context: pick(sim.siroContextMode ?? env.SIRO_CONTEXT_MODE, OSL, 'shadow'),
    // Siro's drafted follow-up text (Mark, 2026-10-19, ruling 2): off stores
    // none, shadow stores it, live also shows it to the bot as a reference.
    followupText: pick(sim.siroFollowupTextMode ?? env.SIRO_FOLLOWUP_TEXT_MODE, OSL, 'shadow'),
    // F.0 v2 copy formula (ruling 6): v1 = the 2026-10-16 prompts, four_step =
    // the Four-Step "If I could …, would you …?" prompts (version 2 rows).
    f0Formula: pick(sim.f0FormulaMode ?? env.F0_FORMULA_MODE, F0_FORMULAS, 'v1'),
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
    organizationId: env.SIRO_ORGANIZATION_ID || '',
    lpConnectionId: env.SIRO_LP_CONNECTION_ID || '',
    presentationConversationType: env.SIRO_PRESENTATION_CONVERSATION_TYPE || '',
    lpNoteAuthor: env.SIRO_LP_NOTE_AUTHOR || 'Siro',
    storeUtterances: String(env.SIRO_STORE_UTTERANCES || 'false').toLowerCase() === 'true',
    // Siro allows 1,000 requests per credential per minute; we keep headroom.
    ratePerMin: num(env.SIRO_RATE_PER_MIN, 600, { min: 1, max: 1000 }),
    waitMaxH: num(env.SIRO_WAIT_MAX_H, 24, { min: 0, max: 168 }),
    waitHoldH: num(env.SIRO_WAIT_HOLD_H, 2, { min: 1, max: 24 }),
    // A demo note is written only for a visit this recent (new visits only, 2026-10-16).
    demoNoteMaxAgeH: num(env.SIRO_DEMO_NOTE_MAX_AGE_H, 48, { min: 1, max: 720 }),
    nurtureShadowWorkflows: String(env.NURTURE_SHADOW_WORKFLOWS ?? 'F.0')
      .split(',').map(s => s.trim()).filter(Boolean),
    f0ApprovalChannel: env.F0_APPROVAL_CHANNEL || env.SLACK_CHANNEL_REHASH || 'C0C5YMHNYJH',
  };
}

export function siroRecordingUrl(recordingId) {
  return `${SIRO_APP_BASE}/analyze/${encodeURIComponent(String(recordingId || ''))}`;
}
