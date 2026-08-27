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
    // false until matching has >=2 weeks of shadow QA (handoff §14.4).
    ghlCreate: TRUE(env.CALL_INTEL_GHL_CREATE),
    // LP probable-tier write gate (write threshold is otherwise exact|high).
    allowProbable: TRUE(env.CALL_INTEL_ALLOW_PROBABLE),

    minSeconds: intFloor(env.CALL_INTEL_MIN_SECONDS, 30, 0),
    batchSize: intFloor(env.CALL_INTEL_BATCH_SIZE, 10, 1),
    maxAttempts: intFloor(env.CALL_INTEL_MAX_ATTEMPTS, 5, 1),
    recordingWaitHours: intFloor(env.CI_RECORDING_WAIT_HOURS, 6, 0),
    audioRetentionDays: intFloor(env.CI_AUDIO_RETENTION_DAYS, 7, 0),

    /**
     * How old a call may be and still have a note posted to a CRM.
     *
     * WHY THIS EXISTS. Lead Perfection stamps a note with the date it was
     * WRITTEN and offers no way to backdate it. So a call from three days ago
     * lands on the record dated today, next to notes a rep typed today, with
     * nothing on the record to say the conversation was not today's. That
     * misleads whoever reads it next, and it cannot be corrected after the
     * fact — LP has no edit for the note date.
     *
     * A stale note is therefore not a smaller version of a fresh note; it is a
     * different and worse artifact. Backfills stay valuable in the DATABASE
     * (transcript, summary, recording link, match) and stop at the CRM door.
     *
     * 0 DISABLES the gate — every matched call posts regardless of age, which
     * is the pre-2026-08-25 behaviour and what a deliberate historical backfill
     * would want. Default 24 hours: yesterday evening's calls still post the
     * next morning, which is the normal working pattern, while a multi-day
     * backfill does not.
     *
     * Skipped calls still COMPLETE. They are not failures and not review
     * items — the pipeline did everything asked of it and deliberately
     * withheld one write. ci_syncs records the skip and its reason, so
     * "we chose not to post this" stays distinguishable from "we missed it".
     */
    maxNoteAgeHours: intFloor(env.CALL_INTEL_MAX_NOTE_AGE_HOURS, 24, 0),

    // Tolerance for the campaign+ANI+time recording->call join. Repeat dials
    // to one number minutes apart are common, so this window is what decides
    // whether a recording links, or stays unlinked as ambiguous.
    recordingMatchWindowS: intFloor(env.CI_RECORDING_MATCH_WINDOW_S, 180, 1),
    // Files below this are transfer-module test calls (~1s, 1.7-4.9 KB), not
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
    promptVersion: env.CI_PROMPT_VERSION || 'v1',

    /**
     * Transcribe a call the early gate resolved to NO writable target?
     *
     * ── WHAT THE GATE IS FOR ───────────────────────────────────────────────
     * Matching keys on campaign + customer phone against LP and reads nothing
     * from the transcript (measured: every `evidence` row across 2,989 matches
     * carries only ghl / note_target / canvass_strategy / reason /
     * canvasser_ani — no transcript-derived field). It was nonetheless paid
     * for AFTER transcription. Over 4,154 transcripts / 113.5 audio-hours,
     * 2,120 calls — 51% of the ~$40.86 Whisper spend — produced no writable
     * match and therefore no note. Resolving the customer BEFORE the Whisper
     * call is what stops paying for those.
     *
     * ── WHY IT DEFAULTS TO true, i.e. TO TODAY'S BEHAVIOUR ─────────────────
     * Not every `none` is worthless. Some are genuinely NEW callers who ought
     * to become leads, and for those the transcript is the ONLY record of who
     * rang and what they wanted. Killing it saves fractions of a cent and
     * loses the lead.
     *
     * So this ships as an OPT-OUT and the gate ships INERT: with the default,
     * a tier-'none' call transcribes exactly as it does today and the only
     * new artifact is the ci_events gate row saying what WOULD have been
     * saved. Mark turns it off once he has read what those calls contain.
     * Shipping it default-off would be a silent behaviour change wearing an
     * optimisation's clothes.
     *
     * ── AND WHAT TURNING IT OFF ALSO TURNS OFF ─────────────────────────────
     * decideLpTier()'s name+address fallback (match.js step 4) runs only when
     * the phone found nothing, and needs the AI's `customer.name`/`.address`.
     * The early gate has no analysis yet, so with this false a call that today
     * matches on name+address is gated out before the analysis that would have
     * matched it exists. That is a real, small loss and it is the reason the
     * flag exists rather than the gate being unconditional.
     *
     * OPT-OUT parsing, not the repo's usual `=== 'true'`: an unset or
     * misspelled variable must land on "keep transcribing", never on "stop".
     * Only the literal string 'false' disarms it.
     */
    transcribeUnmatched: String(env.CI_TRANSCRIBE_UNMATCHED ?? 'true').trim().toLowerCase() !== 'false',

    // Origin for the recording link in a CRM note, e.g.
    // 'https://lp-mcp-production.up.railway.app'. DELIBERATELY NO DEFAULT:
    // unset means the note omits the link line entirely and everything else
    // behaves exactly as before. A guessed default would paste a URL nobody
    // can open into two CRMs, which is worse than no link at all. Trailing
    // slashes are trimmed so base + '/ci/rec/...' cannot produce a double
    // slash that some CRMs render as a broken link.
    recordingLinkBase: String(env.CI_RECORDING_LINK_BASE || '').trim().replace(/\/+$/, '') || null,

    // Which channel of a 2-channel recording is the agent. UNVERIFIED against
    // a real Five9 stereo file — see the warning on agentChannel() in
    // transcribe.js. Wrong, it swaps the speaker label on every labelled line
    // of every transcript without failing, so it is a named, testable value
    // rather than a constant inside the merge.
    stereoAgentChannel: intSigned(env.CI_STEREO_AGENT_CHANNEL, 0) === 1 ? 1 : 0,

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

/**
 * Is this call too old to post a note for?
 *
 * Pure, and takes `now` so tests pin time. Returns false when the gate is
 * disabled (maxNoteAgeHours === 0) or when call_start is unparseable — an
 * unreadable timestamp must not silently suppress a write, because that would
 * turn a data defect into missing notes nobody looks for. The age gate is a
 * deliberate policy, not a fallback.
 *
 * @param {object} call     ci_calls row (needs call_start)
 * @param {object} [cfg]
 * @param {Date}   [now]
 * @returns {{tooOld: boolean, ageHours: number|null, limitHours: number}}
 */
export function noteAgeVerdict(call, cfg = getConfig(), now = new Date()) {
  const limitHours = cfg.maxNoteAgeHours ?? 0;
  if (!limitHours) return { tooOld: false, ageHours: null, limitHours: 0 };

  const started = new Date(call?.call_start ?? NaN);
  if (Number.isNaN(started.getTime())) return { tooOld: false, ageHours: null, limitHours };

  const ageHours = (now.getTime() - started.getTime()) / 3600000;
  return { tooOld: ageHours > limitHours, ageHours, limitHours };
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
