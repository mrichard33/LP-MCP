/**
 * Five9 API recording source — src/ci/five9-recordings.js
 *
 * 2026-10-20. Every SFTP connection to ETG's archive (nas1.etgts.com:2282) has
 * been reset since 2026-09-28; the last recording was fetched 2026-08-27 and
 * ~11,500 calls sit at `discovered` waiting for audio. This adapter gets the
 * same audio from Five9 directly:
 *
 *   list  — run the saved report `CI Call Recordings` (data source "Call
 *           Recording", built by Mark in the VCC UI) ONCE per date per tick,
 *           through the existing SOAP report trio, and hand back descriptors
 *           shaped like describeRecording() so the listing cache, the join and
 *           the fetch stage work unchanged.
 *   fetch — download one recording through Five9's REST API
 *           (src/ci/five9-rest.js) and make sure what is stored is a RIFF WAV,
 *           because transcribe.js reads the channel count from the RIFF header.
 *
 * Selected by CI_RECORDING_SOURCE=five9_api (src/ci/config.js); anything else
 * keeps the SFTP adapter, which stays intact as the fallback if GoCloud reopens.
 *
 * ══ READ ONLY, AND GOCLOUD UNTOUCHED ══
 * A report run and a GET. Nothing here writes to Five9: no VCC configuration
 * (modifyVCCConfiguration is denied in src/five9/op-registry.js anyway), no
 * campaign FTP setting, no report edit. In Five9 a campaign's FTP setting
 * REPLACES the domain's, so touching one would cut GoCloud's feed off.
 *
 * ══ THE JOIN IS EXACT NOW ══
 * The SFTP filenames never carried the Call ID, so recordings were joined on
 * campaign + customer number + time. The report carries CALL ID, and every
 * ci_calls row is keyed on five9_call_id, so the worker links on it first
 * (match_method 'five9_call_id', confidence 1.0) and falls back to the time
 * join only when no row in the report has the call's id.
 */

import { spawn } from 'node:child_process';

import { getConfig } from './config.js';
import { createSftpAdapter, FORBIDDEN_OPS, FFMPEG_BIN } from './recordings.js';
import { classifyExclusion, DEFAULT_EXCLUDED_IVR_MODULES, isSkippedDir } from './filenames.js';
import { parseDateDir, parsePacificReportTimestamp, last4 } from './time.js';
import { customerNumberFor, durationToSeconds } from './discovery.js';
import { parseReportTimestamp, toReportCriteriaString, cellText } from '../five9/call-journey.js';
import { runReportAndWait } from '../five9-admin.js';
import { createFive9RestClient, sourceOutageError } from './five9-rest.js';

const LOG = '[CIFive9Recordings]';

/**
 * Rows one report run returns before Five9 truncates. The Call Log's limit is
 * 5,000 (src/ci/discovery.js); the custom-report limit is not documented for
 * this data source, so the smaller one is assumed. Over-splitting costs a
 * report run; under-splitting loses recordings without an error.
 */
export const RECORDING_REPORT_ROW_CAP = 5000;

/** How far either side of the day the report window reaches. */
export const DAY_MARGIN_MS = 30 * 60 * 1000;

/** Five9 allows 16 runReport calls a minute ACCOUNT-WIDE (shared with the journey sync). */
export const REPORT_RATE_LIMIT_WAIT_MS = 65_000;
export const REPORT_PACE_MS = 6_000;

/**
 * The status_detail a call too old for Five9's retention is skipped with.
 * The Five9 API only returns recordings for CI_FIVE9_BACKLOG_DAYS; asking for
 * an older one would park the call on recording_missing after a retry cycle
 * for nothing, so it is settled up front and never retried.
 */
export const PAST_FIVE9_RETENTION = 'recording_past_five9_retention';

/** Header aliases, lowercased. Exact match first, then a prefix match. */
export const RECORDING_COLUMNS = Object.freeze({
  callId: ['call id', 'call_id', 'callid'],
  sessionId: ['session id', 'session_id', 'sessionid'],
  recordingId: ['recording id', 'record id', 'record_id', 'recording_id', 'recordingid', 'recordid'],
  campaign: ['campaign', 'campaign name'],
  agentUsername: ['agent', 'agent username', 'agent user name', 'agent login', 'agent name', 'username'],
  agentFive9Id: ['agent id', 'agent_id', 'agentid', 'agent five9 id', 'user id'],
  ani: ['ani'],
  dnis: ['dnis'],
  timestamp: ['timestamp', 'date/time', 'start time', 'recording start time'],
  duration: ['length', 'duration', 'recording length', 'recording duration'],
  fileBytes: ['file size', 'size', 'file_size', 'bytes'],
  callType: ['call type', 'type', 'direction'],
});

/** Without these a row cannot be keyed, timed, filed or downloaded. */
export const REQUIRED_RECORDING_COLUMNS = Object.freeze(['callId', 'recordingId', 'campaign', 'timestamp']);

/**
 * Report headers → column indexes. Pure.
 * @returns {{index: object, missing: string[]}}
 */
export function resolveRecordingColumns(columns) {
  const lower = (columns || []).map((c) => String(c ?? '').trim().toLowerCase().replace(/\s+/g, ' '));
  const index = {};
  const taken = new Set();
  // Exact matches for every field first, so 'AGENT ID' is never claimed by
  // 'agent' as a prefix before agentFive9Id gets to it.
  for (const [field, aliases] of Object.entries(RECORDING_COLUMNS)) {
    const at = lower.findIndex((c, i) => !taken.has(i) && aliases.includes(c));
    if (at >= 0) { index[field] = at; taken.add(at); }
  }
  for (const [field, aliases] of Object.entries(RECORDING_COLUMNS)) {
    if (index[field] !== undefined) continue;
    const at = lower.findIndex((c, i) => !taken.has(i) && aliases.some((a) => c.startsWith(`${a} `) || c.startsWith(`${a}(`)));
    if (at >= 0) { index[field] = at; taken.add(at); }
  }
  const missing = REQUIRED_RECORDING_COLUMNS.filter((f) => index[f] === undefined);
  return { index, missing };
}

/** A report TIMESTAMP cell in the report's zone → UTC Date, or null. Never a guess. */
export function parseRecordingTimestamp(text, tz) {
  const d = parseReportTimestamp(text, tz);
  if (d) return d;
  // The Call Log's defensive shapes (ISO, US) are Pacific-only; use them only
  // when the report really is Pacific.
  return tz === 'America/Los_Angeles' ? parsePacificReportTimestamp(text) : null;
}

/**
 * Which number is the customer's. The Call Log's rule (customerNumberFor):
 * ANI on inbound, DNIS on everything else. Without a call-type column the
 * direction is unknown, and then a row with two different numbers gets NO
 * customer number: the time join is skipped for it rather than guessing,
 * and the exact Call ID join still works.
 */
export function customerNumberForRecording({ callType, ani, dnis }) {
  if (callType) return customerNumberFor({ direction: callType, ani, dnis });
  const a = String(ani ?? '').trim() || null;
  const d = String(dnis ?? '').trim() || null;
  if (a && d && a !== d) return null;
  return a || d;
}

const sizeToBytes = (text) => {
  const s = String(text ?? '').replace(/,/g, '').trim();
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(b|bytes|kb|mb)?$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 'b').toLowerCase();
  if (unit === 'kb') return Math.round(n * 1024);
  if (unit === 'mb') return Math.round(n * 1024 * 1024);
  return Math.round(n);
};

/**
 * One report row → a recording descriptor, the shape describeRecording()
 * returns plus the Five9 ids. Pure.
 *
 * @returns {{descriptor: object}|{reject: string}}
 */
export function descriptorFromRow(cells, index, { cfg = getConfig(), dateDir, excludedModules } = {}) {
  const get = (field) => (index[field] === undefined ? null : cellText(cells?.[index[field]]));

  const five9CallId = get('callId');
  const five9RecordingId = get('recordingId');
  const campaignDir = get('campaign');
  const tsText = get('timestamp');
  if (!five9CallId) return { reject: 'no_call_id' };
  if (!five9RecordingId) return { reject: 'no_recording_id' };
  if (!campaignDir) return { reject: 'no_campaign' };
  const recordedAt = parseRecordingTimestamp(tsText, cfg.five9Api.reportTz);
  if (!recordedAt) return { reject: 'unparseable_timestamp' };

  const callType = get('callType');
  const ani = customerNumberForRecording({ callType, ani: get('ani'), dnis: get('dnis') });
  const fileBytes = sizeToBytes(get('fileBytes'));
  const durationSeconds = durationToSeconds(get('duration'));

  // Campaign case is kept EXACTLY: near-duplicate campaigns differ only by
  // case, and candidateDistanceSeconds compares without folding.
  const { excluded, reason } = classifyExclusion({
    ivrModule: null,
    fileBytes,
    campaignDir,
    excludedModules: excludedModules ?? DEFAULT_EXCLUDED_IVR_MODULES,
    minBytes: cfg.minRecordingBytes,
  });

  return {
    descriptor: {
      sourcePath: `five9api://${five9CallId}/${five9RecordingId}`,
      sourceFilename: `${five9CallId}_${five9RecordingId}.wav`,
      campaignDir,
      dateDir: dateDir ?? null,
      ani,
      agentUsername: get('agentUsername') || '',
      clockText: null,
      ivrModule: null,
      sessionId: get('sessionId'),
      recordedAt,
      durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
      fileBytes,
      excluded,
      excludedReason: reason,
      callType,
      five9CallId,
      five9SessionId: get('sessionId'),
      five9RecordingId,
      agentFive9Id: get('agentFive9Id'),
    },
  };
}

/**
 * The UTC window to report on for one date folder name. The folder day is the
 * fixed-offset day dateDirFor() produced (CI_RECORDING_TZ_OFFSET_MIN), padded
 * by DAY_MARGIN_MS on both sides so a call near midnight still finds its
 * recording, and never past `nowMs`. Pure.
 */
export function dayWindowFor(dateDir, offsetMin = -300, nowMs = Date.now()) {
  const d = parseDateDir(dateDir);
  if (!d) return null;
  const dayStart = Date.UTC(d.year, d.monthIdx, d.day) - offsetMin * 60 * 1000;
  const from = new Date(dayStart - DAY_MARGIN_MS);
  const to = new Date(Math.min(dayStart + 24 * 3600 * 1000 + DAY_MARGIN_MS, nowMs));
  if (to.getTime() <= from.getTime()) return null;
  return { from, to };
}

/**
 * The listing report, the same keys the SFTP adapter's onStats carries, so
 * /ci/trace-fetch and the unreadable-folder check read it unchanged. Nothing is
 * ever "unparseable" here (rows the report cannot use are counted in the log
 * line), and no names are sampled.
 */
function emptyListStats(dir) {
  return {
    dir, entries: 0, dirs: 0, nonWav: 0, wav: 0, unparseable: 0, unparseableNames: [], wavNames: [],
    described: 0, excluded: 0, usable: 0, listError: null, skippedDir: false,
  };
}

const isReportRateLimit = (err) => /seconds limit \(\d+\) for report request/i.test(String(err?.message || ''));

/* ─── audio: always a RIFF WAV in storage ───────────────────────────────── */

export function isRiffWav(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= 12
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WAVE';
}

/**
 * ffmpeg writing WAV to a PIPE cannot seek back to fill in the RIFF and data
 * sizes, so it leaves placeholders. parseWav() copes, but a stored file should
 * be a well-formed one: rewrite both sizes from the buffer we actually hold.
 * Returns the same buffer (patched in place). Pure apart from that.
 */
export function fixWavSizes(buffer) {
  if (!isRiffWav(buffer)) return buffer;
  buffer.writeUInt32LE(buffer.length - 8, 4);
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'data') {
      buffer.writeUInt32LE(buffer.length - (offset + 8), offset + 4);
      break;
    }
    const next = offset + 8 + size + (size % 2);
    if (next <= offset || next > buffer.length) break;
    offset = next;
  }
  return buffer;
}

/** A call that will not convert in this long is not going to. */
export const WAV_TIMEOUT_MS = 120_000;

/**
 * Anything ffmpeg can read → WAV, mono, 8 kHz, signed 16-bit PCM, over pipes.
 * Same spawn shape as transcodeToMp3 (src/ci/recordings.js). THROWS on failure.
 */
export function transcodeToWav(buffer, { bin = FFMPEG_BIN, timeoutMs = WAV_TIMEOUT_MS, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
      reject(new Error('transcodeToWav requires a non-empty buffer'));
      return;
    }
    // No -f on the INPUT: the source format is exactly what we do not know.
    // -map_metadata -1 keeps a LIST chunk out of the header.
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vn', '-map_metadata', '-1', '-ac', '1', '-ar', '8000', '-c:a', 'pcm_s16le',
      '-f', 'wav', 'pipe:1',
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
    child.stderr.on('data', (d) => { if (errText.length < 40) errText.push(String(d)); });
    child.on('error', (err) => finish(reject, new Error(`ffmpeg failed to run (${bin}): ${err.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(reject, new Error(`ffmpeg exited ${code}: ${errText.join('').trim().slice(0, 500) || 'no stderr'}`));
        return;
      }
      const wav = Buffer.concat(out);
      if (!isRiffWav(wav)) {
        finish(reject, new Error('ffmpeg produced no WAV output'));
        return;
      }
      finish(resolve, fixWavSizes(wav));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(buffer);
  });
}

/**
 * The stored audio is ALWAYS a RIFF WAV. A RIFF WAV passes through byte for
 * byte (a stereo file keeps both channels, which the speaker split needs);
 * anything else is converted.
 */
export async function ensureWav(buffer, { transcode = transcodeToWav } = {}) {
  if (isRiffWav(buffer)) return { buffer, converted: false };
  return { buffer: await transcode(buffer), converted: true };
}

const magic = (buffer) => (Buffer.isBuffer(buffer) ? buffer.toString('latin1', 0, 4).replace(/[^\x20-\x7e]/g, '.') : '');

/* ─── the adapter ───────────────────────────────────────────────────────── */

/**
 * Mutating operations, permanently refused — present as named throwers (the
 * FORBIDDEN_OPS pattern of the SFTP adapter) so a caller reaching for one gets
 * an explanation, not a TypeError somebody "fixes" by implementing it.
 */
export function refuseFive9Write(op) {
  throw new Error(
    `${op}: refused. The Five9 recording source is report + download only; it never changes `
    + 'anything in Five9 (and a campaign FTP change would cut GoCloud\'s recording feed off).',
  );
}

/**
 * @param {object} [opts.cfg]
 * @param {Function} [opts.clientFactory]  (cfg) → { getRecording } (tests)
 * @param {object} [opts.reportDeps]       { runReportAndWait, sleep } (tests)
 * @param {Function} [opts.transcode]      buffer → WAV buffer (tests)
 * @param {Function} [opts.onStats]
 */
export function createFive9ApiAdapter({ cfg = getConfig(), clientFactory, reportDeps = {}, transcode, onStats } = {}) {
  const name = 'five9_api';
  const runReport = reportDeps.runReportAndWait || runReportAndWait;
  const sleep = reportDeps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const nowMs = reportDeps.now || (() => Date.now());
  const api = cfg.five9Api;

  /** dateDir → Promise<descriptor[]>. Lives as long as this adapter: one tick. */
  const days = new Map();
  let reportRuns = 0;
  let downloads = 0;
  let client = null;

  async function runOnce(from, to) {
    if (reportRuns > 0) await sleep(REPORT_PACE_MS);
    reportRuns += 1;
    const args = {
      folder: api.reportFolder,
      name: api.reportName,
      startIso: toReportCriteriaString(from, api.reportTz),
      endIso: toReportCriteriaString(to, api.reportTz),
      pollMs: api.pollMs,
      maxWaitMs: api.timeoutMs,
    };
    try {
      return await runReport(args);
    } catch (err) {
      if (!isReportRateLimit(err)) throw err;
      console.warn(`${LOG} report rate-limited; waiting ${REPORT_RATE_LIMIT_WAIT_MS / 1000}s and retrying once`);
      await sleep(REPORT_RATE_LIMIT_WAIT_MS);
      return runReport(args);
    }
  }

  /** One window, split in halves while it comes back at the row cap. */
  async function pull(from, to, depth = 0) {
    let result;
    try {
      result = await runOnce(from, to);
    } catch (err) {
      // A report that cannot run is the SOURCE being unavailable, not one
      // call's problem — the worker pauses rather than burning attempts.
      if (err?.ciSourceOutage) throw err;
      throw sourceOutageError(`Five9 recording report failed: ${err.message}`);
    }
    if (!result?.done) {
      throw sourceOutageError(
        `Five9 recording report did not finish for ${from.toISOString()}..${to.toISOString()}`
        + `${result?.identifier ? ` (identifier ${result.identifier})` : ''}`,
      );
    }
    const { index, missing } = resolveRecordingColumns(result.columns);
    if (missing.length) {
      throw sourceOutageError(
        `"${api.reportName}" is missing required column(s): ${missing.join(', ')}; `
        + `headers were [${(result.columns || []).join(', ')}]`,
      );
    }
    const rows = result.rows || [];
    if (rows.length >= RECORDING_REPORT_ROW_CAP) {
      const span = to.getTime() - from.getTime();
      if (depth >= 6 || span <= 60 * 1000) {
        throw sourceOutageError(
          `"${api.reportName}" hit the ${RECORDING_REPORT_ROW_CAP}-row cap on a ${Math.round(span / 1000)}s window; rows are being lost`,
        );
      }
      const mid = new Date(from.getTime() + Math.floor(span / 2));
      console.warn(`${LOG} window ${from.toISOString()}..${to.toISOString()} hit the row cap; splitting`);
      const left = await pull(from, mid, depth + 1);
      const right = await pull(mid, to, depth + 1);
      return { index, rows: [...left.rows, ...right.rows] };
    }
    return { index, rows: rows.map((cells) => ({ cells, index })) };
  }

  function loadDay(dateDir) {
    let pending = days.get(dateDir);
    if (pending) return pending;
    pending = (async () => {
      const win = dayWindowFor(dateDir, cfg.recordingTzOffsetMin, nowMs());
      if (!win) throw new Error(`five9_api list: unreadable date '${dateDir}'`);
      const { rows } = await pull(win.from, win.to);
      const out = [];
      const rejects = {};
      const seen = new Set();
      for (const { cells, index } of rows) {
        const r = descriptorFromRow(cells, index, { cfg, dateDir });
        if (r.reject) { rejects[r.reject] = (rejects[r.reject] || 0) + 1; continue; }
        // Two windows overlap at their seam; one recording is one descriptor.
        if (seen.has(r.descriptor.sourcePath)) continue;
        seen.add(r.descriptor.sourcePath);
        out.push(r.descriptor);
      }
      const rejected = Object.values(rejects).reduce((a, b) => a + b, 0);
      console.log(
        `${LOG} ${dateDir}: ${out.length} recording(s) from "${api.reportName}"`
        + (rejected ? `, ${rejected} row(s) unusable ${JSON.stringify(rejects)}` : ''),
      );
      return out;
    })().catch((err) => {
      // Never cache a failure: the next call in the tick asks again.
      days.delete(dateDir);
      throw err;
    });
    days.set(dateDir, pending);
    return pending;
  }

  /**
   * Same contract as the SFTP list: recordings for one campaign/date. The
   * report runs once per DATE and every campaign is filtered from it in memory.
   */
  async function list({ campaign, date, onStats: onStatsArg } = {}) {
    if (!campaign) throw new Error('list requires a campaign');
    if (typeof date !== 'string') throw new Error('five9_api list requires a date folder name (M_D_YYYY)');
    const report = typeof (onStatsArg ?? onStats) === 'function' ? (onStatsArg ?? onStats) : null;
    const dir = `five9api:${campaign}/${date}`;
    if (isSkippedDir(campaign)) {
      report?.({ ...emptyListStats(dir), skippedDir: true });
      return [];
    }
    const all = await loadDay(date);
    const out = all.filter((r) => r.campaignDir === campaign);
    try {
      // No filenames in a report here: they would be phone numbers.
      report?.({
        ...emptyListStats(dir),
        entries: out.length,
        wav: out.length,
        described: out.length,
        excluded: out.filter((r) => r.excluded).length,
        usable: out.filter((r) => !r.excluded).length,
      });
    } catch (err) {
      console.warn(`${LOG} listing stats callback threw (the listing itself is unaffected): ${err.message}`);
    }
    return out;
  }

  /** Room left under CI_FIVE9_MAX_DOWNLOADS_PER_TICK in this tick. */
  function canFetch() {
    return downloads < api.maxDownloadsPerTick;
  }

  /** Download one recording and return a RIFF WAV buffer. Never writes to Five9. */
  async function fetch(descriptor = {}) {
    const { five9RecordingId, agentFive9Id, five9CallId } = descriptor;
    if (!five9RecordingId) throw new Error('five9_api fetch requires a five9RecordingId');
    if (api.recordingAgent === 'recording' && !agentFive9Id) {
      throw new Error(`recording ${five9RecordingId} has no agent id, and CI_FIVE9_RECORDING_AGENT=recording needs one`);
    }
    downloads += 1;
    client = client || (clientFactory ? clientFactory(cfg) : createFive9RestClient({ cfg }));
    const { buffer } = await client.getRecording({
      recordingId: five9RecordingId,
      agentId: api.recordingAgent === 'recording' ? agentFive9Id : undefined,
    });
    const wav = await ensureWav(buffer, transcode ? { transcode } : {});
    console.log(
      `${LOG} fetched call ${five9CallId} recording ${five9RecordingId} (${last4(descriptor.ani)}): `
      + `${buffer.length} bytes '${magic(buffer)}'${wav.converted ? ` → WAV ${wav.buffer.length} bytes` : ''}`,
    );
    return wav.buffer;
  }

  // Five9 is read-only from here: the same named refusals as the SFTP adapter.
  const refusals = Object.fromEntries(FORBIDDEN_OPS.map((op) => [op, () => refuseFive9Write(op)]));

  // _loadDay: every recording of one date, all campaigns. For the probe only.
  return { name, list, fetch, canFetch, stats: () => ({ reportRuns, downloads }), _loadDay: loadDay, ...refusals };
}

/* ─── the probe (Phase 0.4) ─────────────────────────────────────────────── */

/** What a download looked like, never the audio itself. Pure. */
export function describeDownload({ status, contentType, buffer }) {
  const out = {
    http_status: status,
    content_type: contentType || null,
    bytes: Buffer.isBuffer(buffer) ? buffer.length : 0,
    first4: magic(buffer),
    riff_wav: isRiffWav(buffer),
  };
  if (out.riff_wav) {
    // channels / rate / codec straight from the fmt chunk (wav.js's reading).
    let offset = 12;
    while (offset + 8 <= buffer.length) {
      const id = buffer.toString('ascii', offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);
      if (id === 'fmt ' && offset + 24 <= buffer.length) {
        out.wav_format_tag = buffer.readUInt16LE(offset + 8);
        out.wav_channels = buffer.readUInt16LE(offset + 10);
        out.wav_sample_rate = buffer.readUInt32LE(offset + 12);
        break;
      }
      const next = offset + 8 + size + (size % 2);
      if (next <= offset) break;
      offset = next;
    }
  } else if (out.bytes && out.bytes < 2000 && /json|text|xml|html/i.test(contentType || '')) {
    // A short error body is worth reading; audio never is.
    out.body_excerpt = buffer.toString('utf8').slice(0, 300);
  }
  return out;
}

/**
 * GET /ci/five9-recording-probe — the handoff's Phase 0.4, run against the
 * deployed service because that is where the Five9 credential lives.
 *
 * Runs the recording report for one day (default: yesterday), picks one
 * recording (or the one named), and downloads it up to three ways: as the
 * logged-in user with and without download=true, and as the recording's own
 * agent. For each it reports the HTTP status, content type, size, first four
 * bytes and the WAV channels. It returns NO audio and no phone numbers, and
 * it writes nothing anywhere: not to Five9, not to storage, not to ci_*.
 * Works whatever CI_RECORDING_SOURCE says, so it can run before the flip.
 */
export async function probeFive9Recording({ cfg = getConfig(), date, recordingId, five9CallId, deps = {} } = {}) {
  const adapter = createFive9ApiAdapter({ cfg, reportDeps: deps.reportDeps || {}, clientFactory: deps.clientFactory });
  const client = deps.client || (deps.clientFactory ? deps.clientFactory(cfg) : createFive9RestClient({ cfg, deps: deps.restDeps || {} }));
  const nowMs = deps.now ? deps.now() : Date.now();
  const day = date || (() => {
    const shifted = new Date(nowMs - 86400000 + cfg.recordingTzOffsetMin * 60000);
    return `${shifted.getUTCMonth() + 1}_${shifted.getUTCDate()}_${shifted.getUTCFullYear()}`;
  })();

  const out = { ok: false, report: `${cfg.five9Api.reportFolder} / ${cfg.five9Api.reportName}`, date: day };
  let rows;
  try {
    rows = await adapter._loadDay(day);
  } catch (err) {
    return { ...out, stage: 'report', error: err.message };
  }
  out.recordings_in_report = rows.length;
  out.campaigns = [...new Set(rows.map((r) => r.campaignDir))].length;
  out.with_agent_id = rows.filter((r) => r.agentFive9Id).length;
  out.with_call_type = rows.filter((r) => r.callType).length;

  const pick = rows.find((r) => (recordingId && r.five9RecordingId === String(recordingId))
      || (five9CallId && r.five9CallId === String(five9CallId)))
    || (!recordingId && !five9CallId ? [...rows].filter((r) => !r.excluded).sort((a, b) => b.recordedAt - a.recordedAt)[0] : null);
  if (!pick) return { ...out, stage: 'pick', error: 'no matching recording in that day\'s report' };

  out.picked = {
    five9_call_id: pick.five9CallId,
    five9_recording_id: pick.five9RecordingId,
    agent_five9_id: pick.agentFive9Id,
    campaign: pick.campaignDir,
    recorded_at: pick.recordedAt.toISOString(),
    age_hours: Math.round((nowMs - pick.recordedAt.getTime()) / 3600000),
    duration_seconds: pick.durationSeconds,
    file_bytes: pick.fileBytes,
  };

  const variants = [
    { name: 'self_download', agentId: undefined, download: true },
    { name: 'self_stream', agentId: undefined, download: false },
    ...(pick.agentFive9Id ? [{ name: 'recording_agent_download', agentId: pick.agentFive9Id, download: true }] : []),
  ];
  out.attempts = [];
  for (const v of variants) {
    try {
      const r = await client.getRecording({ recordingId: pick.five9RecordingId, agentId: v.agentId, download: v.download, raw: true });
      out.attempts.push({ variant: v.name, ...describeDownload(r) });
    } catch (err) {
      out.attempts.push({ variant: v.name, error: err.message });
      if (err?.httpStatus === 401 || /breaker open/i.test(err.message)) break;
    }
  }
  out.ok = out.attempts.some((a) => a.http_status >= 200 && a.http_status < 300 && a.bytes > 0);
  return out;
}

/**
 * The ONE place a recording adapter is chosen. Every caller that used to build
 * createSftpAdapter (the worker's tick and fetch stage, the two diagnostic
 * routes) builds through here, like selectTranscriber() for the engine.
 */
export function createRecordingAdapter({ cfg = getConfig(), ...rest } = {}) {
  return cfg.recordingSource === 'five9_api'
    ? createFive9ApiAdapter({ cfg, ...rest })
    : createSftpAdapter({ cfg, ...rest });
}

export default {
  createFive9ApiAdapter,
  createRecordingAdapter,
  resolveRecordingColumns,
  descriptorFromRow,
  dayWindowFor,
  ensureWav,
  isRiffWav,
};
