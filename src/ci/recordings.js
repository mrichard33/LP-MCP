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
import { spawn } from 'node:child_process';

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


/* ─── the per-tick listing memo ─────────────────────────────────────────── */

/**
 * The memo key for one (campaign, dateDir) pair.
 *
 * The separator is NUL, and that is not a style choice. Campaign directory
 * names carry spaces and hyphens — 'Data - Hot Leads less than 7', 'Magazine -
 * CLiPP' — so a separator that can occur INSIDE a key is a separator that folds
 * two different folders onto one cache entry. ':' and '|' are both plausible
 * inside a Five9 campaign name; NUL cannot appear in either a campaign name or
 * a date directory, so the mapping stays injective.
 *
 * A collision here would not fail loudly: the second campaign would be served
 * the FIRST campaign's file list, find no candidate, and park the call on
 * `recording_missing` — the exact symptom this cache exists to reduce.
 */
export function listingCacheKey(campaign, dateDir) {
  return `${String(campaign ?? '')}\u0000${String(dateDir ?? '')}`;
}

/**
 * Memoize `adapter.list` for the life of ONE worker tick.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 * stageFetchRecording lists a directory per CALL. A batch of 50 shares a
 * handful of campaign/date pairs, and each list() opens its own SFTP
 * connection, reads a folder holding up to 758 files, and disconnects. Fifty
 * listings for three folders is why a tick of 50 outlived its 300s lease.
 *
 * ── LIFETIME IS THE TICK, DELIBERATELY ─────────────────────────────────────
 * Created in runTick and thrown away with it. NOT module-level, and NOT
 * TTL'd — a listing that outlives the tick means audio that HAS since landed
 * on the archive reads as absent, and the call is parked `recording_missing`.
 * That turns a throughput fix into data loss, a strictly worse trade than the
 * listing it saves.
 *
 * ── WHAT IS AND IS NOT CACHED ──────────────────────────────────────────────
 * The LISTING only. Fetched bytes are never held here — this wraps list() and
 * nothing else, so the adapter's fetch() stays the single path for audio.
 *
 * An empty result IS cached: an empty folder is a valid answer for the tick.
 *
 * A THROWN listing is NEVER cached. The entry is removed on rejection so the
 * next call re-lists. Caching the error would let one transient SFTP failure
 * park every remaining call in the batch on `recording_missing` — fifty calls
 * lost to one blip.
 *
 * @param {object} opts.adapter  anything with `list({ campaign, date })`
 * @param {object} [opts.cfg]    for the date normalization only
 * @returns {{ list: Function, stats: Function }}
 */
export function createListingCache({ adapter, cfg = getConfig() } = {}) {
  if (typeof adapter?.list !== 'function') {
    throw new Error('createListingCache requires an adapter with a list()');
  }

  /** key → in-flight or settled Promise<recording[]>. */
  const entries = new Map();
  const counts = { pairs: 0, calls: 0, hits: 0, errors: 0 };

  /**
   * Normalize `date` exactly as createSftpAdapter().list does, so the key is
   * derived from the directory that will actually be listed. Without this, two
   * Date objects for the same day key differently and both miss.
   */
  function dirFor(date) {
    return typeof date === 'string'
      ? date
      : dateDirFor(date ?? new Date(), cfg.recordingTzOffsetMin);
  }

  /**
   * The key is the FOLDER, never the connection: any extra argument (an
   * injected `client`) is forwarded to the adapter but deliberately kept out
   * of the key, because two connections to the same archive see the same
   * directory. Keying on it would just re-list the folder per connection.
   */
  async function list({ campaign, date, ...rest } = {}) {
    const dateDir = dirFor(date);
    const key = listingCacheKey(campaign, dateDir);
    counts.calls += 1;

    let pending = entries.get(key);
    if (pending) {
      counts.hits += 1;
    } else {
      counts.pairs += 1;
      pending = adapter.list({ campaign, date: dateDir, ...rest }).catch((err) => {
        // Evict BEFORE rethrowing: a failed listing must not become this
        // tick's answer for the pair.
        entries.delete(key);
        counts.errors += 1;
        throw err;
      });
      entries.set(key, pending);
    }

    const out = await pending;
    // A copy per caller. The elements themselves are shared — nothing in the
    // pipeline mutates a described recording — but handing out the same ARRAY
    // instance fifty times invites one caller's sort or splice to rewrite what
    // the other forty-nine see.
    return Array.isArray(out) ? out.slice() : out;
  }

  /** What the tick log reports: how much listing this actually saved. */
  function stats() {
    return {
      pairs: counts.pairs,
      calls: counts.calls,
      hits: counts.hits,
      errors: counts.errors,
      hit_rate: counts.calls ? Math.round((counts.hits / counts.calls) * 100) / 100 : 0,
    };
  }

  return { list, stats };
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

/* ─── MP3 derivative ────────────────────────────────────────────────────── */

/**
 * ══ WHY THIS EXISTS ══
 * Five9 writes WAVE format tag 0x0031 — GSM 6.10, 8 kHz, 1 channel, with a
 * fact chunk. Verified by fetching a real file through GET /ci/rec/:token:
 * HTTP 200, content-type audio/wav, 456,036 bytes, valid RIFF. The route and
 * the token work correctly. Chrome, Safari, Firefox and QuickTime all refuse
 * to decode GSM 6.10, so the rep clicks the link and gets nothing.
 *
 * So every fetched recording also gets an MP3 derivative, stored alongside the
 * original in the SAME private bucket. THE WAV IS NOT REPLACED: it is the
 * archival copy and the transcription input (Whisper accepts the GSM WAV, and
 * transcribe.js keeps reading storage_path). The MP3 is for humans only.
 */

/** Overridable so a container with ffmpeg somewhere unusual still works. */
export const FFMPEG_BIN = process.env.CI_FFMPEG_PATH || 'ffmpeg';

/** Mono, 64 kbps — speech from an 8 kHz telephony source. */
export const MP3_BITRATE = '64k';

/**
 * 44.1 kHz OUTPUT, from an 8 kHz source, and the upsample is the point.
 *
 * MP3 sample rates fall in three families: MPEG-1 (32/44.1/48 kHz), MPEG-2 LSF
 * (16/22.05/24) and MPEG-2.5 (8/11.025/12). Encoding at the source's native
 * 8 kHz would produce MPEG-2.5, whose decoder support is exactly the thing that
 * is spotty in Safari and QuickTime — both named targets here. Re-encoding at
 * 44.1 kHz yields plain MPEG-1 Layer III, which every browser and player
 * decodes, and costs nothing in file size because BITRATE governs size, not
 * sample rate. It adds no information to the audio and is not meant to: this
 * whole derivative exists so the file PLAYS, and the container is what was
 * stopping it.
 */
export const MP3_SAMPLE_RATE = 44100;

/** A call that will not convert in this long is not going to. */
export const MP3_TIMEOUT_MS = 120_000;

/**
 * Transcode a WAV buffer to MP3 bytes via ffmpeg, over pipes — no temp files.
 *
 * THROWS on failure. The caller (transcodeAndStoreMp3) is what swallows it;
 * this stays honest so the backfill can report why a file would not convert.
 *
 * @returns {Promise<Buffer>}
 */
export function transcodeToMp3(buffer, {
  bin = FFMPEG_BIN,
  bitrate = MP3_BITRATE,
  sampleRate = MP3_SAMPLE_RATE,
  timeoutMs = MP3_TIMEOUT_MS,
  spawnImpl = spawn,
} = {}) {
  return new Promise((resolve, reject) => {
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
      reject(new Error('transcodeToMp3 requires a non-empty buffer'));
      return;
    }

    // -f wav on the INPUT is deliberate: ffmpeg cannot seek a pipe, so letting
    // it probe would make it buffer looking for a format it has already been
    // told. -ac 1 because these files are mono and an upmix would only double
    // the bytes.
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'wav', '-i', 'pipe:0',
      '-vn', '-ac', '1', '-ar', String(sampleRate), '-b:a', bitrate,
      '-f', 'mp3', 'pipe:1',
    ];

    let child;
    try {
      child = spawnImpl(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error(`ffmpeg could not be started (${bin}): ${err.message}`));
      return;
    }

    const out = [];
    const errText = [];
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`ffmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d) => out.push(d));
    // Bounded: a pathological file must not accumulate megabytes of log lines
    // in memory just to be quoted in an error message.
    child.stderr.on('data', (d) => { if (errText.length < 40) errText.push(String(d)); });

    child.on('error', (err) => finish(reject, new Error(`ffmpeg failed to run (${bin}): ${err.message}`)));

    child.on('close', (code) => {
      if (code !== 0) {
        finish(reject, new Error(`ffmpeg exited ${code}: ${errText.join('').trim().slice(0, 500) || 'no stderr'}`));
        return;
      }
      const mp3 = Buffer.concat(out);
      if (!mp3.length) {
        finish(reject, new Error('ffmpeg produced no output'));
        return;
      }
      finish(resolve, mp3);
    });

    // EPIPE here is normal when ffmpeg rejects the input and exits before
    // reading it all; the non-zero exit above is the real error, and letting
    // this one through unhandled would crash the process instead.
    child.stdin.on('error', () => {});
    child.stdin.end(buffer);
  });
}

/**
 * Is ffmpeg present? Resolves a verdict, NEVER throws and never rejects.
 *
 * @returns {Promise<{ok: boolean, version: string|null, error: string|null}>}
 */
export function ffmpegAvailable({ bin = FFMPEG_BIN, spawnImpl = spawn, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(bin, ['-hide_banner', '-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, version: null, error: err.message });
      return;
    }
    const out = [];
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done({ ok: false, version: null, error: 'timed out' }); }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.on('error', (err) => done({ ok: false, version: null, error: err.message }));
    child.on('close', (code) => {
      if (code !== 0) return done({ ok: false, version: null, error: `exited ${code}` });
      done({ ok: true, version: Buffer.concat(out).toString().split('\n')[0].trim() || null, error: null });
    });
  });
}

/**
 * Startup probe. A CLEAR LOG LINE, NOT A CRASH.
 *
 * A missing ffmpeg costs playable links and nothing else: the WAV is still
 * fetched, still transcribed, still analyzed, still matched, still synced, and
 * the route falls back to serving it. Refusing to boot over that would trade a
 * working pipeline for a convenience — the exact trade ensureLinkToken()
 * already refuses to make. So this says so loudly and returns.
 */
export async function logFfmpegStatus(opts = {}) {
  const status = await ffmpegAvailable(opts);
  if (status.ok) {
    console.log(`${LOG} ffmpeg present — recordings will get a browser-playable MP3 (${status.version})`);
  } else {
    console.warn(
      `${LOG} ffmpeg NOT FOUND (${status.error}). The pipeline runs normally and links still resolve, ` +
      'but they serve the original Five9 GSM 6.10 WAV, which no browser can decode — a rep clicking a ' +
      'link will get nothing. Install ffmpeg in the runtime image (Dockerfile: apk add ffmpeg).',
    );
  }
  return status;
}

/**
 * Store the MP3 derivative beside its original.
 *
 * Keyed on the SOURCE WAV's sha, not the MP3's own, so the derivative is
 * addressed by the identity of the audio it came from: re-running the
 * transcode overwrites one object instead of littering the bucket with a new
 * one per encoder run, and the pairing with the .wav is readable from the path.
 */
export async function storeMp3({ callId, buffer, sha, db = supabase }) {
  const storagePath = `${callId || 'unlinked'}/${sha}.mp3`;
  const { error } = await db.storage
    .from(CI_AUDIO_BUCKET)
    .upload(storagePath, buffer, { contentType: 'audio/mpeg', upsert: true });
  if (error) throw new Error(`ci-audio mp3 upload failed for ${storagePath}: ${error.message}`);
  return { storagePath, bytes: buffer.length };
}

/**
 * Transcode + store + report, and NEVER THROW.
 *
 * ══ A FAILED TRANSCODE MUST NOT FAIL THE FETCH STAGE ══
 * This is the whole contract. A call whose audio will not convert still needs
 * its transcript, its analysis, its match and its note — everything that
 * actually reaches a customer record. Losing the convenience of a playable
 * link is a bad afternoon; losing the note is the pipeline not working. So
 * every failure path here logs and returns nulls, the row keeps
 * mp3_storage_path null, and the route serves the WAV exactly as it does today.
 *
 * @returns {Promise<{mp3StoragePath: string|null, mp3Bytes: number|null, error: string|null}>}
 */
export async function transcodeAndStoreMp3({ callId, buffer, sha, filename = null, db = supabase, opts = {} } = {}) {
  try {
    const mp3 = await transcodeToMp3(buffer, opts);
    const stored = await storeMp3({ callId, buffer: mp3, sha, db });
    return { mp3StoragePath: stored.storagePath, mp3Bytes: stored.bytes, error: null };
  } catch (err) {
    console.warn(`${LOG} mp3 transcode skipped for ${filename || sha}: ${err.message} (the WAV is stored and will still be transcribed)`);
    return { mp3StoragePath: null, mp3Bytes: null, error: err.message };
  }
}

/**
 * Purge audio past the retention window. Five9/ETG remain the system of
 * record, so deleting OUR copy loses nothing; the row is kept and stamped
 * purged_at so the audit trail still shows the file existed.
 *
 * BOTH OBJECTS GO. The MP3 derivative is audio of the same conversation and is
 * subject to the same retention — purging the WAV and leaving the MP3 would
 * keep the recording we promised to delete, in the more playable of the two
 * formats, addressable by a token that is about to be nulled anyway.
 */
export async function purgeExpiredAudio({ db = supabase, cfg = getConfig(), now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - cfg.audioRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from('ci_recordings')
    .select('id, storage_path, mp3_storage_path')
    .not('storage_path', 'is', null)
    .is('purged_at', null)
    .lt('fetched_at', cutoff)
    .limit(200);
  if (error) throw new Error(`purge query failed: ${error.message}`);

  const rows = data || [];
  if (!rows.length) return { purged: 0 };

  // One remove() call carrying both objects per row. Nulls filtered out — a
  // row with no MP3 (pre-070, or a failed transcode) is normal, and passing a
  // null path would fail the whole batch over a file that never existed.
  const objects = rows.flatMap((r) => [r.storage_path, r.mp3_storage_path]).filter(Boolean);
  const { error: rmErr } = await db.storage.from(CI_AUDIO_BUCKET).remove(objects);
  if (rmErr) throw new Error(`ci-audio remove failed: ${rmErr.message}`);

  const { error: updErr } = await db
    .from('ci_recordings')
    .update({
      purged_at: new Date().toISOString(),
      storage_path: null,
      // The derivative is gone from the bucket, so the column that points at
      // it must go too — otherwise the route prefers an object that no longer
      // exists and the fallback to the WAV never runs.
      mp3_storage_path: null,
      mp3_bytes: null,
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

  console.log(
    `${LOG} purged ${rows.length} recording(s) — ${objects.length} object(s), WAV + MP3 — ` +
    `older than ${cfg.audioRetentionDays}d`,
  );
  return { purged: rows.length, objects: objects.length };
}

export const _internal = { confidenceFor, last4 };
export default {
  createSftpAdapter,
  createManualAdapter,
  createListingCache,
  listingCacheKey,
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
  transcodeToMp3,
  transcodeAndStoreMp3,
  storeMp3,
  ffmpegAvailable,
  logFfmpegStatus,
};
