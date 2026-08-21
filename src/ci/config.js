/**
 * Call Intelligence config + flag logic — src/ci/config.js
 *
 * Env parsing for the ci_* pipeline (sql/061) and the ONLY authority on
 * whether a CRM write is allowed. Every write path in sync_lp.js / sync_ghl.js
 * (PR 5) must go through liveWrites()/ghlCreateEnabled()/allowProbableLp() —
 * never read CALL_INTEL_* env directly at a write site.
 *
 * Posture: ships dark. CALL_INTEL_MODE defaults to 'shadow' and anything that
 * is not exactly 'live' (including typos and unset) coerces to 'shadow', so a
 * misconfigured deploy fails toward zero CRM writes. Each write target is
 * additionally gated by its own flag ANDed with mode==='live'. Flipping flags
 * is Mark's decision, never part of a PR.
 *
 * This is the repo's first centralized config module: everywhere else parses
 * process.env inline per module. Centralizing here is deliberate — the flag
 * logic is the safety boundary of the whole subsystem and must be testable as
 * a pure function (parseConfig takes an env object; nothing here reads
 * process.env at import time or imports any client).
 */

const TRUE = (v) => String(v || '').toLowerCase() === 'true';

// House numeric idiom: parseInt with a string default, clamped to a floor.
const intFloor = (v, def, floor) => {
  const n = parseInt(v || String(def), 10);
  return Math.max(floor, Number.isNaN(n) ? def : n);
};

/**
 * Signed integer with NO floor. Required for CI_RECORDING_TZ_OFFSET_MIN,
 * whose correct value is NEGATIVE (-300). Routing it through intFloor would
 * apply Math.max(floor, n) and clamp -300 to 0 for any floor >= 0, silently
 * shifting every filename-derived timestamp by five hours and breaking the
 * campaign+ANI+time join for every recording. Three timezones meet in that
 * join and it is the highest-likelihood source of silent mismatch in the
 * subsystem, so the offset gets a parser that cannot quietly change its sign.
 */
const intSigned = (v, def) => {
  const n = parseInt(v ?? String(def), 10);
  return Number.isNaN(n) ? def : n;
};

export function parseConfig(env = process.env) {
  const rawMode = String(env.CALL_INTEL_MODE || 'shadow').trim().toLowerCase();
  return {
    // shadow|live master switch. Anything not exactly 'live' is shadow.
    mode: rawMode === 'live' ? 'live' : 'shadow',

    // Per-target write flags — each ANDed with mode==='live' by liveWrites().
    lpWrites: TRUE(env.CALL_INTEL_LP_WRITES),
    ghlWrites: TRUE(env.CALL_INTEL_GHL_WRITES),
    // GHL contact creation — duplicate-contact risk is the top danger; stays
    // false until matching has ≥2 weeks of shadow QA (handoff §14.4).
    ghlCreate: TRUE(env.CALL_INTEL_GHL_CREATE),
    // LP probable-tier write gate (write threshold is otherwise exact|high).
    allowProbable: TRUE(env.CALL_INTEL_ALLOW_PROBABLE),

    minSeconds: intFloor(env.CALL_INTEL_MIN_SECONDS, 30, 0),
    batchSize: intFloor(env.CALL_INTEL_BATCH_SIZE, 10, 1),
    maxAttempts: intFloor(env.CALL_INTEL_MAX_ATTEMPTS, 5, 1),
    recordingWaitHours: intFloor(env.CI_RECORDING_WAIT_HOURS, 6, 0),
    audioRetentionDays: intFloor(env.CI_AUDIO_RETENTION_DAYS, 7, 0),

    // Tolerance for the campaign+ANI+time recording→call join. Repeat dials
    // to one number minutes apart are common, so this window is what decides
    // whether a recording links, or stays unlinked as ambiguous.
    recordingMatchWindowS: intFloor(env.CI_RECORDING_MATCH_WINDOW_S, 180, 1),
    // Files below this are transfer-module test calls (~1s, 1.7–4.9 KB), not
    // production traffic — marked excluded rather than ingested.
    minRecordingBytes: intFloor(env.CI_MIN_RECORDING_BYTES, 8000, 0),
    // FIXED offset for recording-filename clocks. The Recordings export runs
    // at EST (GMT-05:00) with NO DST, so this is -300 year-round; applying
    // America/New_York instead would add an hour for eight months of the year.
    // Signed parser, deliberately unclamped — see intSigned above.
    recordingTzOffsetMin: intSigned(env.CI_RECORDING_TZ_OFFSET_MIN, -300),
    // Date Mark enabled recording on the canvass transfer module. Transfer
    // legs before it legitimately have no audio, so reconciliation must not
    // count them as gaps. Null until set (PHASE 0 2b).
    transferRecordingEnabledFrom: env.CI_TRANSFER_RECORDING_ENABLED_FROM || null,

    transcribeModel: env.CI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',
    analysisModel: env.CI_ANALYSIS_MODEL || 'gpt-4o-mini',
    promptVersion: env.CI_PROMPT_VERSION || 'v1',

    sftp: {
      host: env.CI_SFTP_HOST || 'nas1.etgts.com',
      port: intFloor(env.CI_SFTP_PORT, 2282, 1),
      user: env.CI_SFTP_USER || 'Five9reece',
      // Password auth, not a key: the credential comes from the Five9 VCC
      // config (getVCCConfiguration.recordingsServer) and is shared with
      // Five9's own push to this server.
      password: env.CI_SFTP_PASSWORD || null,
      root: env.CI_SFTP_ROOT || '/Five9/Recordings',
      // OPT-OUT, not opt-in — the ONLY safe default here is true, and this is
      // deliberately NOT the repo's usual `=== 'true'` idiom. nas1 is a third
      // party's archive that Five9 pushes to continuously, the account holds
      // rwxrwxrwx over it, and it is the system of record for every
      // recording we have. An unset or misspelled variable must never be the
      // thing that makes this adapter writable; only the literal string
      // 'false' can, and PR 2's adapter re-asserts this before every op.
      readOnly: String(env.CI_SFTP_READONLY ?? 'true').trim().toLowerCase() !== 'false',
    },

    // 1 is a placeholder until Mark picks a dedicated "AI Call Note" category
    // (PHASE 0.3) — writes are impossible in shadow mode regardless.
    lpNoteCategoryId: intFloor(env.LP_NOTE_CATEGORY_ID, 1, 1),
    groupmeCiBotId: env.GROUPME_CI_BOT_ID || null,
  };
}

/**
 * The write gate. True ONLY when mode is live AND the target's own flag is
 * on. Unknown targets return false — a typo at a call site must fail toward
 * "no write", never throw its way past the gate.
 */
export function liveWrites(target, cfg = getConfig()) {
  if (cfg.mode !== 'live') return false;
  if (target === 'lp') return cfg.lpWrites;
  if (target === 'ghl') return cfg.ghlWrites;
  return false;
}

/** GHL contact creation: needs live + GHL writes + its own flag, all three. */
export function ghlCreateEnabled(cfg = getConfig()) {
  return liveWrites('ghl', cfg) && cfg.ghlCreate;
}

/** LP probable-tier writes: needs live + LP writes + its own flag, all three. */
export function allowProbableLp(cfg = getConfig()) {
  return liveWrites('lp', cfg) && cfg.allowProbable;
}

/**
 * Retry backoff (handoff §10): next_retry_at = now + min(6h, 5min × 2^attempts).
 * Pure — takes `now` as a Date so tests pin time. Shared by the worker (PR 2)
 * and the sync retry path (PR 5) so there is exactly one implementation.
 */
export function nextRetryAt(attempts, now = new Date()) {
  const delayMs = Math.min(6 * 60 * 60 * 1000, 5 * 60 * 1000 * Math.pow(2, attempts));
  return new Date(now.getTime() + delayMs);
}

// Runtime singleton for callers that just want the deployed config. Lazy so
// importing this module never reads env at import time (test doctrine:
// scripts/test-* must not need env stubbing to import src modules).
let _config = null;
export function getConfig() {
  if (!_config) _config = parseConfig(process.env);
  return _config;
}

/** Test-only: drop the memoized config so the next getConfig() re-parses. */
export function __resetConfigForTest() {
  _config = null;
}
