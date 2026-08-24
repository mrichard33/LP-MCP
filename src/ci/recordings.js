/**
 * Call Intelligence recording ingest — src/ci/recordings.js
 *
 * Adapter interface plus two sources: `sftp_pull` (primary) and `manual`
 * (backfill upload). Also owns the recording→call join and the audio purge.
 *
 * ══ READ-ONLY IS THE WHOLE SAFETY STORY ══
 * nas1.etgts.com is ETG's server, not ours. Five9 pushes recordings to it
 * continuously and it is the SYSTEM OF RECORD for every call recording the
 * business has — retention back to ~Aug 2023. The account we hold has
 * rwxrwxrwx over that archive. A coding error here does not corrupt our data,
 * it destroys a vendor's.
 *
 * So this module lists and downloads. It never uploads, deletes, or renames,
 * and `assertReadOnly()` is called before every operation rather than once at
 * connect: a guard checked only at startup is a guard that a later refactor
 * silently routes around. Five9's own export config has "delete after
 * uploading" unchecked and must stay that way — we are not the only reader.
 *
 * ══ THE JOIN ══
 * The Call ID is NOT in the filename (see src/ci/filenames.js). Recordings are
 * matched on campaign + THE CUSTOMER'S NUMBER + time — the customer's, not the
 * ANI, because Five9 names the file after the number DIALLED and on an outbound
 * call the ANI is a Reece caller ID. See candidateDistanceSeconds(). When that
 * is ambiguous the recording
 * stays UNLINKED and flagged. Repeat dials to one number minutes apart are
 * routine — one number showed five files inside sixteen minutes — so the
 * ambiguous path is a normal outcome, not an edge case. Guessing here attaches
 * a customer's call to a stranger's record.
 */

import crypto from 'node:crypto';

import supabase from '../supabase.js';
import { getConfig } from './config.js';
import { CI_AUDIO_BUCKET } from '../../scripts/setup-ci-audio-bucket.js';
import { parseRecordingPath, classifyExclusion, isSkippedDir, DEFAULT_EXCLUDED_IVR_MODULES } from './filenames.js';
import { filenameClockToUtc, dateDirFor, last10, last4 } from './time.js';

const LOG = '[CIRecordings]';

/**
 * Hard guard. Throws unless the adapter is in read-only mode, and is invoked
 * at the top of every remote operation.
 */
export function assertReadOnly(cfg = getConfig()) {
  if (!cfg.sftp.readOnly) {
    throw new Error(
      'CI_SFTP_READONLY is disabled. This adapter is list+download only against a third-party archive; ' +
      'refusing to operate with writes enabled.',
    );
  }
}

/**
 * Mutating SFTP operations, permanently refused.
 *
 * These exist as named throwers rather than as absent methods so that a future
 * caller reaching for `.delete()` gets an explicit, explained refusal instead
 * of a TypeError that someone "fixes" by implementing it.
 */
export const FORBIDDEN_OPS = ['put', 'upload', 'delete', 'rmdir', 'rename', 'mkdir', 'chmod', 'append'];

export function refuseMutation(op) {
  throw new Error(
    `${op}: refused. nas1 is ETG's recording archive and the system of record; ` +
    'this codebase is list+download only and must never write to it.',
  );
}

/** SHA-256 of a buffer, hex — the audio's content identity. */
export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/* ─── shareable links ───────────────────────────────────────────────────── */

/**
 * Mint a recording link token.
 *
 * ══ THIS VALUE IS THE ENTIRE ACCESS CONTROL ══
 * Decision record (Mark, 2026-08-24): recording links work for anyone holding
 * them, with no login, because a rep has to be able to forward the note. So
 * there is no second factor behind this — guessing the token IS the attack,
 * and 256 bits of CSPRNG output is the only thing standing in the way.
 *
 * It is therefore NOT, and must never become:
 *   - a uuid           — v4 spends 6 bits on version/variant and leaves 122,
 *                        and some uuid paths in this repo are v1/time-based
 *   - derived from call_id, five9_call_id, source_path, or file_sha256 — all
 *     of those are knowable or enumerable elsewhere, so deriving from them
 *     would let anyone holding ONE token compute others
 *   - a hash of anything at all — same reason
 *
 * base64url so it is safe in a path segment with no escaping: 32 bytes → 43
 * chars, no padding, alphabet [A-Za-z0-9_-]. sql/068's verification query
 * asserts that shape precisely so a regression to something guessable is
 * visible in one SELECT.
 */
export function mintLinkToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * When a link dies: fetched_at + CI_AUDIO_RETENTION_DAYS.
 *
 * Deliberately the SAME horizon as the audio purge rather than a policy of its
 * own. The link cannot outlive the object it points at, and tying the two
 * together means there is one number to change, not two that can drift into
 * disagreeing.
 */
export function linkExpiresAt(fetchedAt, cfg = getConfig()) {
  const base = fetchedAt ? new Date(fetchedAt) : new Date();
  if (Number.isNaN(base.getTime())) return null;
  return new Date(base.getTime() + cfg.audioRetentionDays * 24 * 60 * 60 * 1000);
}

/**
 * Give a stored recording a link token IF IT DOES NOT ALREADY HAVE ONE.
 *
 * WHY THIS IS A SEPARATE CONDITIONAL UPDATE rather than columns on the upsert.
 * The ci_recordings write is an upsert on source_path, so re-fetching a
 * recording (a review retry, a re-run of the fetch stage) runs it again. If
 * the token were part of that payload, the re-fetch would ROTATE it — and
 * every link already pasted into an LP or GHL note for that call would break,
 * silently, with no error anywhere. `.is('link_token', null)` makes the write
 * happen exactly once per recording and turns a re-fetch into a no-op.
 *
 * Never throws. A recording that fails to get a token still has its audio and
 * its row; the note simply omits the link line. Failing the whole fetch stage
 * over a link would trade a working pipeline for a convenience.
 *
 * @returns {Promise<{token: string|null, expiresAt: string|null}>}
 */
export async function ensureLinkToken({ sourcePath, fetchedAt = null, db = supabase, cfg = getConfig() }) {
  if (!sourcePath || !db) return { token: null, expiresAt: null };
  const token = mintLinkToken();
  const expires = linkExpiresAt(fetchedAt, cfg);
  const expiresAt = expires ? expires.toISOString() : null;

  try {
    const { data, error } = await db
      .from('ci_recordings')
      .update({ link_token: token, link_expires_at: expiresAt })
      .eq('source_path', sourcePath)
      .is('link_token', null)
      .select('link_token, link_expires_at');
    if (error) throw new Error(error.message);

    // No row updated means one already had a token — read it back rather than
    // reporting null, so the caller can still compose a link.
    if (!data || data.length === 0) {
      const { data: existing, error: readErr } = await db
        .from('ci_recordings')
        .select('link_token, link_expires_at')
        .eq('source_path', sourcePath)
        .maybeSingle();
      if (readErr) throw new Error(readErr.message);
      return {
        token: existing?.link_token ?? null,
        expiresAt: existing?.link_expires_at ?? null,
      };
    }
    return { token, expiresAt };
  } catch (err) {
    console.warn(`${LOG} link token not issued for ${sourcePath}: ${err.message}`);
    return { token: null, expiresAt: null };
  }
}

/**
 * Choose the recording a note should link to: the FIRST by recorded_at.
 *
 * A held call produces several segments — one live call carried seven. Pasting
 * seven URLs into a CRM note would make the note unreadable, so the note links
 * the first and says how many more there are. Pure.
 *
 * Rows with no usable token are skipped entirely; ordering falls back to
 * fetched_at, then to the original array order, so a null recorded_at cannot
 * make the choice non-deterministic between runs.
 *
 * @returns {{recording: object|null, extra: number}}
 */
export function linkableRecording(recordings) {
  const usable = (recordings || []).filter((r) => r && r.link_token && !r.purged_at);
  if (!usable.length) return { recording: null, extra: 0 };
  const key = (r) => {
    const t = new Date(r.recorded_at ?? r.fetched_at ?? 0).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  const ordered = usable
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (key(a.r) - key(b.r)) || (a.i - b.i))
    .map((x) => x.r);
  return { recording: ordered[0], extra: ordered.length - 1 };
}

/**
 * Recording→call match methods.
 *
 * 'campaign_ani_time' is the LEGACY name for what 'campaign_customer_time' now
 * does. The rename is not cosmetic: the join used to compare the recording's
 * number against ci_calls.ani, which is the CUSTOMER only on inbound calls —
 * on everything else the ANI is a Reece local-presence caller ID, so the search
 * looked for a Reece number in filenames Five9 names after the number DIALLED
 * and never found one. 44 calls sat at review_reason='recording_missing' with
 * recording segments in raw_metadata, i.e. Five9 said the audio existed.
 *
 * THE LEGACY STRING STAYS READABLE FOREVER. ci_recordings rows written before
 * this change carry it, the column has no CHECK constraint, and nothing may
 * treat those rows as unmatched. Any code that asks "was this matched by the
 * campaign+time join?" asks isCampaignTimeMatch(), never an equality test
 * against one string.
 */
export const RECORDING_MATCH_CAMPAIGN_TIME = 'campaign_customer_time';
export const RECORDING_MATCH_CAMPAIGN_TIME_LEGACY = 'campaign_ani_time';
export const RECORDING_MATCH_METHODS = Object.freeze([
  RECORDING_MATCH_CAMPAIGN_TIME,
  RECORDING_MATCH_CAMPAIGN_TIME_LEGACY,
  'manual',
]);

/** True for both the current and the legacy campaign+time method names. */
export function isCampaignTimeMatch(method) {
  return method === RECORDING_MATCH_CAMPAIGN_TIME
    || method === RECORDING_MATCH_CAMPAIGN_TIME_LEGACY;
}

/**
 * Score one candidate call against one parsed recording.
 *
 * Order (handoff §6): campaign dir must match ci_calls.campaign EXACTLY (never
 * case-folded — near-duplicate campaign dirs differ only by case); the phone
 * compares on last-10; time must fall inside the window. Among survivors the
 * NEAREST in time wins, and duration breaks a remaining tie.
 *
 * ══ IT IS THE CUSTOMER'S NUMBER ON BOTH SIDES, NOT THE ANI ══
 * Five9 names a recording file after the number DIALLED. Confirmed in a fetched
 * path: '/Five9/Recordings/Main Number/8_19_2026/4436170733 by cdeer @ 7_16_55
 * AM.wav' — 4436170733 is the DNIS of an OUTBOUND call, not its ANI. So the
 * call side of this comparison must be ci_calls.customer_phone, which
 * discovery.js's customerNumberFor() sets to the ANI on inbound and the DNIS on
 * everything else. On an inbound call the two are the same value, so inbound
 * behaviour is unchanged.
 *
 * The `|| call.ani` fallback covers rows discovered before that fix whose
 * customer_phone was never repaired; it can only ever restore today's
 * behaviour, never worsen it.
 *
 * @returns {number|null} seconds of separation, or null when disqualified
 */
export function candidateDistanceSeconds(recording, call) {
  if (!recording.recordedAt || !call.call_start) return null;
  if (recording.campaignDir !== call.campaign) return null;
  const a = last10(recording.ani);
  const b = last10(call.customer_phone || call.ani);
  if (!a || !b || a !== b) return null;
  return Math.abs(new Date(call.call_start).getTime() - recording.recordedAt.getTime()) / 1000;
}

/**
 * Choose the call a recording belongs to.
 *
 * NEVER GUESSES. If two candidates survive at indistinguishable distance and
 * duration cannot separate them, the result is `ambiguous` and the recording
 * is stored unlinked for a human. That is the designed outcome, not a failure:
 * an unlinked recording is a gap someone can close, a wrongly-linked one is a
 * customer's conversation filed under a stranger's name.
 *
 * @returns {{call: object|null, method: string|null, confidence: number|null, reason: string}}
 */
export function matchRecordingToCall(recording, calls, { windowSeconds = 180 } = {}) {
  const scored = [];
  for (const call of calls || []) {
    const d = candidateDistanceSeconds(recording, call);
    if (d === null || d > windowSeconds) continue;
    scored.push({ call, distance: d });
  }

  if (scored.length === 0) return { call: null, method: null, confidence: null, reason: 'no_candidate' };

  scored.sort((x, y) => x.distance - y.distance);
  if (scored.length === 1) {
    return {
      call: scored[0].call,
      method: RECORDING_MATCH_CAMPAIGN_TIME,
      confidence: confidenceFor(scored[0].distance, windowSeconds),
      reason: 'single_candidate',
    };
  }

  // More than one. A clear nearest wins only if it is meaningfully nearer;
  // otherwise try duration, then give up rather than coin-flip.
  const [best, next] = scored;
  const separation = next.distance - best.distance;
  if (separation >= 30) {
    return {
      call: best.call,
      method: RECORDING_MATCH_CAMPAIGN_TIME,
      confidence: confidenceFor(best.distance, windowSeconds),
      reason: 'nearest_by_time',
    };
  }

  if (Number.isFinite(recording.durationSeconds)) {
    const byDuration = scored
      .map((s) => ({ ...s, delta: Math.abs((s.call.duration_seconds ?? -1e9) - recording.durationSeconds) }))
      .sort((x, y) => x.delta - y.delta);
    if (Number.isFinite(byDuration[0].delta) && byDuration[1].delta - byDuration[0].delta >= 5) {
      return {
        call: byDuration[0].call,
        method: RECORDING_MATCH_CAMPAIGN_TIME,
        confidence: 0.6,
        reason: 'nearest_by_duration',
      };
    }
  }

  return { call: null, method: null, confidence: null, reason: 'ambiguous' };
}

/** Nearer in time ⇒ higher confidence, floored at 0.5 inside the window. */
function confidenceFor(distance, windowSeconds) {
  const ratio = Math.min(1, Math.max(0, distance / Math.max(1, windowSeconds)));
  return Number((1 - 0.5 * ratio).toFixed(3));
}

/**
 * Turn a remote path + stat into the shape the join and the DB row need.
 * Pure — no I/O — so the whole classification path is testable offline.
 *
 * @returns {object|null} null when the path/filename does not parse
 */
export function describeRecording({ fullPath, fileBytes, root, cfg = getConfig(), excludedModules }) {
  const parsed = parseRecordingPath(fullPath, root ?? cfg.sftp.root);
  if (!parsed) return null;

  const recordedAt = filenameClockToUtc({
    dateDir: parsed.dateDir,
    clockText: parsed.clockText,
    offsetMin: cfg.recordingTzOffsetMin,
  });

  const { excluded, reason } = classifyExclusion({
    ivrModule: parsed.ivrModule,
    fileBytes,
    campaignDir: parsed.campaignDir,
    excludedModules: excludedModules ?? DEFAULT_EXCLUDED_IVR_MODULES,
    minBytes: cfg.minRecordingBytes,
  });

  return { ...parsed, recordedAt, fileBytes: fileBytes ?? null, excluded, excludedReason: reason };
}

/**
 * Team classification for a recording, IVR module first.
 *
 * §6: the module string in the filename ('_Transfer to Lightfire') is a
 * direct, self-describing signal and beats mapping a transfer-leg DNIS. Order:
 * ivr_module → agent map → campaign map → 'unknown' (→ review). 'unknown' is a
 * real answer here; a guessed team silently mis-attributes a partner's calls.
 *
 * The agent map is consulted by LOGIN first. Verified 2026-08-21: neither the
 * Call Log nor a recording filename carries the numeric Five9 user id, so an
 * id-only lookup here is unreachable in production and every agent call would
 * fall through to the campaign map. The login is the identifier both sources
 * actually share (see sql/064). `agentMap` may be keyed either way — pass the
 * username-keyed map; `usernameMap` is accepted separately for callers that
 * hold both.
 */
export function classifyTeam({ ivrModule, agentUsername, agentFive9Id, campaign }, { transferTargets = [], agentMap = new Map(), usernameMap = null, campaignMap = new Map() } = {}) {
  if (ivrModule) {
    const hit = transferTargets.find((t) => t.label && t.label === ivrModule);
    if (hit) return { team: hit.team, source: 'ivr_module' };
  }
  const byUsername = usernameMap || agentMap;
  if (agentUsername && byUsername.has(agentUsername)) {
    const t = byUsername.get(agentUsername)?.team;
    if (t && t !== 'unknown') return { team: t, source: 'agent_map' };
  }
  if (agentFive9Id && agentMap.has(agentFive9Id)) {
    const t = agentMap.get(agentFive9Id)?.team;
    if (t && t !== 'unknown') return { team: t, source: 'agent_map' };
  }
  if (campaign && campaignMap.has(campaign)) {
    const t = campaignMap.get(campaign)?.team;
    if (t && t !== 'unknown') return { team: t, source: 'campaign_map' };
  }
  return { team: 'unknown', source: 'none' };
}

/* ─── adapters ──────────────────────────────────────────────────────────── */

/**
 * Adapter contract: { name, list(opts) → descriptors[], fetch(descriptor) → Buffer }.
 * `manual` implements fetch only; the bytes arrive on the request.
 */

/**
 * sftp_pull — read-only crawl of ETG's archive.
 *
 * The ssh2-sftp-client dependency is loaded LAZILY so that importing this
 * module (which the worker and routes do at boot) never requires the package
 * to be installed or the credentials to exist. Discovery, the join, and every
 * pure helper stay usable — and testable — without it.
 */
export function createSftpAdapter({ cfg = getConfig(), clientFactory } = {}) {
  const name = 'sftp';

  async function connect() {
    assertReadOnly(cfg);
    if (!cfg.sftp.password) {
      throw new Error('CI_SFTP_PASSWORD is not set — the recording archive credential lives in Railway env');
    }
    if (clientFactory) return clientFactory(cfg);
    const { default: SftpClient } = await import('ssh2-sftp-client');
    const client = new SftpClient();
    await client.connect({
      host: cfg.sftp.host,
      port: cfg.sftp.port,
      username: cfg.sftp.user,
      password: cfg.sftp.password,
      readyTimeout: 20000,
    });
    return client;
  }

  /**
   * List recordings for one campaign/date pair. Both are REQUIRED — the
   * archive holds ~1,025 date folders under a single campaign, so an
   * unqualified crawl is a very expensive mistake.
   */
  async function list({ campaign, date, client: injected } = {}) {
    assertReadOnly(cfg);
    if (!campaign) throw new Error('list requires a campaign');
    if (isSkippedDir(campaign)) return [];
    const dateDir = typeof date === 'string' ? date : dateDirFor(date ?? new Date(), cfg.recordingTzOffsetMin);
    const dir = `${cfg.sftp.root}/${campaign}/${dateDir}`;

    const client = injected || await connect();
    try {
      const entries = await client.list(dir);
      const out = [];
      for (const e of entries) {
        if (e.type === 'd') continue;
        if (!/\.wav$/i.test(e.name)) continue;
        const described = describeRecording({
          fullPath: `${dir}/${e.name}`,
          fileBytes: e.size,
          cfg,
        });
        if (described) out.push(described);
      }
      return out;
    } catch (err) {
      // A missing date folder is normal — no calls on that campaign that day.
      if (/no such file|not found|ENOENT/i.test(err.message || '')) return [];
      throw err;
    } finally {
      if (!injected && client?.end) await client.end().catch(() => {});
    }
  }

  /** Download one file's bytes. Never removes the remote copy. */
  async function fetch({ sourcePath, client: injected } = {}) {
    assertReadOnly(cfg);
    if (!sourcePath) throw new Error('fetch requires sourcePath');
    const client = injected || await connect();
    try {
      const buf = await client.get(sourcePath);
      return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    } finally {
      if (!injected && client?.end) await client.end().catch(() => {});
    }
  }

  // Mutating operations are present and permanently refused — see FORBIDDEN_OPS.
  const refusals = Object.fromEntries(FORBIDDEN_OPS.map((op) => [op, () => refuseMutation(op)]));

  return { name, list, fetch, ...refusals };
}

/** manual — bytes supplied by POST /ci/backfill, keyed to a five9_call_id. */
export function createManualAdapter() {
  return {
    name: 'manual',
    async list() { return []; },
    async fetch({ buffer } = {}) {
      if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('manual fetch requires a non-empty buffer');
      return buffer;
    },
  };
}

/* ─── storage ───────────────────────────────────────────────────────────── */

/**
 * Archive audio into the private ci-audio bucket.
 * Path is {call_id or 'unlinked'}/{sha}.wav — content-hashed, so upsert makes
 * a re-fetch idempotent rather than duplicative.
 */
export async function storeAudio({ callId, buffer, filename, db = supabase }) {
  const sha = sha256Hex(buffer);
  const storagePath = `${callId || 'unlinked'}/${sha}.wav`;
  const { error } = await db.storage
    .from(CI_AUDIO_BUCKET)
    .upload(storagePath, buffer, { contentType: 'audio/wav', upsert: true });
  if (error) throw new Error(`ci-audio archive failed for ${filename}: ${error.message}`);
  return { storagePath, sha256: sha, bytes: buffer.length };
}

/**
 * Purge audio past the retention window. Five9/ETG remain the system of
 * record, so deleting OUR copy loses nothing; the row is kept and stamped
 * purged_at so the audit trail still shows the file existed.
 */
export async function purgeExpiredAudio({ db = supabase, cfg = getConfig(), now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - cfg.audioRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from('ci_recordings')
    .select('id, storage_path')
    .not('storage_path', 'is', null)
    .is('purged_at', null)
    .lt('fetched_at', cutoff)
    .limit(200);
  if (error) throw new Error(`purge query failed: ${error.message}`);

  const rows = data || [];
  if (!rows.length) return { purged: 0 };

  const { error: rmErr } = await db.storage.from(CI_AUDIO_BUCKET).remove(rows.map((r) => r.storage_path));
  if (rmErr) throw new Error(`ci-audio remove failed: ${rmErr.message}`);

  const { error: updErr } = await db
    .from('ci_recordings')
    .update({
      purged_at: new Date().toISOString(),
      storage_path: null,
      // NULL THE TOKEN AT PURGE, not at link_expires_at. The two are normally
      // the same instant, but a purge can run early (a retention change, a
      // manual cleanup) and a token that outlived its object would resolve to
      // a row whose storage_path is null — a 500, or worse a signed URL for
      // nothing. Killing the token here makes the link dead the moment the
      // audio is, and the route's 404 then reads as "expired", which it is.
      link_token: null,
    })
    .in('id', rows.map((r) => r.id));
  if (updErr) throw new Error(`purge stamp failed: ${updErr.message}`);

  console.log(`${LOG} purged ${rows.length} audio object(s) older than ${cfg.audioRetentionDays}d`);
  return { purged: rows.length };
}

export const _internal = { confidenceFor, last4 };
export default {
  createSftpAdapter,
  createManualAdapter,
  matchRecordingToCall,
  describeRecording,
  classifyTeam,
  storeAudio,
  purgeExpiredAudio,
  assertReadOnly,
  mintLinkToken,
  linkExpiresAt,
  ensureLinkToken,
  linkableRecording,
  isCampaignTimeMatch,
  RECORDING_MATCH_CAMPAIGN_TIME,
  RECORDING_MATCH_CAMPAIGN_TIME_LEGACY,
  RECORDING_MATCH_METHODS,
};
