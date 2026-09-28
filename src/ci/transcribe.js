/**
 * Call Intelligence — transcription — src/ci/transcribe.js
 *
 * Turns the audio pulled by recordings.js into one ci_transcripts row per
 * call. §6 contract:
 *
 *   - A call may have SEVERAL recording files (the Call Log's RECORDINGS
 *     column showed one Appointment Set call carrying 7 segments around
 *     holds). Concatenate in segment-timestamp order, then transcribe, and
 *     record the boundaries in ci_transcripts.segments.
 *   - channels=2 → transcribe each channel separately and merge by timestamp,
 *     which yields deterministic agent/customer labels;
 *     diarization_method='stereo_channels'.
 *   - mono → one pass, diarization_method='none', speakers unlabeled.
 *   - low_confidence when the engine says so, or the heuristics below fire.
 *
 * The transcriber itself is INJECTED. Every function here that decides
 * anything is pure and synchronous, so the ordering and labelling rules —
 * the parts that corrupt notes when wrong — are testable without a network
 * call, an API key, or an audio fixture.
 */

import supabase from '../supabase.js';
import { getConfig } from './config.js';
import { CI_AUDIO_BUCKET } from '../../scripts/setup-ci-audio-bucket.js';
import { channelCount, durationSeconds, extractChannel } from './wav.js';

const LOG = '[CITranscribe]';

/**
 * Segment ordering. Segments come from two places that can disagree: the Call
 * Log's RECORDINGS column (`09:00:25(0:43)`, wall-clock, no date) and the
 * recording filenames (a clock in fixed EST). Both are clock-only, so a call
 * that crosses midnight would sort wrong on the raw string.
 *
 * Ordering therefore prefers `recorded_at` — a real timestamptz, resolved in
 * recordings.js against the call's own date — and falls back to the clock text
 * only when it is absent. A stable tiebreak on source_path keeps the order
 * deterministic for two segments stamped the same second, so re-running
 * transcription on the same call cannot produce a differently-ordered
 * transcript.
 */
export function orderSegments(recordings) {
  return [...(recordings || [])].sort((a, b) => {
    const at = toMillis(a?.recorded_at);
    const bt = toMillis(b?.recorded_at);
    if (at !== null && bt !== null && at !== bt) return at - bt;
    if (at !== null && bt === null) return -1;
    if (at === null && bt !== null) return 1;
    const ac = String(a?.filename_clock_text ?? '');
    const bc = String(b?.filename_clock_text ?? '');
    if (ac !== bc) return ac < bc ? -1 : 1;
    return String(a?.source_path ?? '').localeCompare(String(b?.source_path ?? ''));
  });
}

function toMillis(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Which stereo channel carries the agent.
 *
 * ⚠ UNVERIFIED AGAINST A REAL FILE. Five9's stereo layout has not been
 * confirmed for this domain — no stereo recording has been inspected. Getting
 * this backwards does not fail loudly: it swaps "agent" and "customer" on
 * EVERY labelled line of EVERY transcript, and the analysis (and eventually
 * the CRM note) reads the customer's words as the agent's.
 *
 * So it is a config value with a documented default, not a constant buried in
 * a merge function, and confirming it against one real two-channel recording
 * is a go-live gate — see the PR body. Until then this only ever runs in
 * shadow mode, where a wrong label costs nothing but a re-run.
 */
export function agentChannel(cfg = getConfig()) {
  return cfg.stereoAgentChannel === 1 ? 1 : 0;
}

/**
 * Merge two per-channel transcriptions into one ordered, speaker-labelled
 * turn list.
 *
 * Both channels are transcribed independently, so their segments interleave in
 * time. Sorting the union by start time reconstructs the conversation. Ties
 * (both channels talking at the same offset — a real thing on a live call)
 * break toward the AGENT, deterministically: a stable rule matters more than
 * which side wins, because an unstable one makes the same audio produce
 * different transcripts on re-run.
 *
 * @param {{segments: Array}} agentSide     transcription of the agent channel
 * @param {{segments: Array}} customerSide  transcription of the customer channel
 * @returns {Array<{speaker: string, start: number, end: number, text: string}>}
 */
export function mergeStereoSegments(agentSide, customerSide) {
  const tag = (side, speaker) =>
    (side?.segments || []).map((s) => ({
      speaker,
      start: Number(s.start ?? 0),
      end: Number(s.end ?? s.start ?? 0),
      text: String(s.text ?? '').trim(),
    }));

  return [...tag(agentSide, 'agent'), ...tag(customerSide, 'customer')]
    .filter((s) => s.text)
    .sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      if (a.speaker !== b.speaker) return a.speaker === 'agent' ? -1 : 1;
      return a.end - b.end;
    });
}

/** Render labelled turns into the stored transcript_text. */
export function renderTurns(turns) {
  return (turns || []).map((t) => `${t.speaker}: ${t.text}`).join('\n');
}

/**
 * Offset every segment of a later file by the duration of everything before
 * it, so a multi-file call has ONE monotonic timeline instead of N timelines
 * each restarting at zero. Without this, merging or reading segment offsets
 * across files silently interleaves minute 0 of part 2 with minute 0 of
 * part 1.
 */
export function rebaseSegments(perFile) {
  const out = [];
  let offset = 0;
  for (const file of perFile || []) {
    for (const s of file.segments || []) {
      out.push({
        ...s,
        start: Number(s.start ?? 0) + offset,
        end: Number(s.end ?? s.start ?? 0) + offset,
        source_path: file.source_path ?? null,
      });
    }
    offset += Number(file.audio_seconds ?? 0);
  }
  return out;
}

/** Words per 10 seconds of audio — the density heuristic §6 asks for. */
export function wordsPerTenSeconds(text, audioSeconds) {
  const secs = Number(audioSeconds);
  if (!Number.isFinite(secs) || secs <= 0) return null;
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return (words / secs) * 10;
}

/**
 * §6 low-confidence rules. A transcript flagged here still gets stored and
 * still gets analyzed — it goes to review at the end rather than being
 * dropped, because a human can read a bad transcript and a deleted one helps
 * nobody.
 *
 * @returns {{low: boolean, reasons: string[]}}
 */
export function assessConfidence({ text, audioSeconds, engineLowConfidence = false, confidence = null } = {}) {
  const reasons = [];
  if (engineLowConfidence) reasons.push('engine_flagged');
  if (typeof confidence === 'number' && confidence < 0.5) reasons.push('engine_confidence_below_0.5');

  const trimmed = String(text || '').trim();
  if (!trimmed) reasons.push('empty_transcript');

  const density = wordsPerTenSeconds(trimmed, audioSeconds);
  // §6: fewer than 2 words per 10s of audio. Real conversation runs an order
  // of magnitude above this; at or below it the audio is silence, hold music,
  // or the engine failed on it.
  if (density !== null && trimmed && density < 2) {
    reasons.push(`sparse_output_${density.toFixed(2)}_words_per_10s`);
  }
  return { low: reasons.length > 0, reasons };
}

/**
 * Transcribe one call's audio.
 *
 * @param {object}   call
 * @param {Array}    recordings  ci_recordings rows for this call (>=1)
 * @param {object}   opts
 * @param {Function} opts.transcriber  async ({buffer, filename, channel}) =>
 *                                     {text, segments, language, confidence,
 *                                      low_confidence, audio_seconds}
 * @param {Function} opts.loadAudio    async (recording) => {buffer, channels, audio_seconds}
 * @returns {Promise<object>} a ci_transcripts row (not yet inserted)
 */
export async function transcribeCall(call, recordings, { transcriber, loadAudio, cfg = getConfig() } = {}) {
  if (typeof transcriber !== 'function') throw new Error('transcribeCall requires a transcriber');
  if (typeof loadAudio !== 'function') throw new Error('transcribeCall requires loadAudio');

  const ordered = orderSegments(recordings);
  if (ordered.length === 0) throw new Error('transcribeCall requires at least one recording');

  const model = cfg.transcribeModel;
  const perFile = [];
  let stereo = false;

  for (const rec of ordered) {
    const audio = await loadAudio(rec);
    const channels = Number(audio?.channels ?? 1);

    if (channels === 2) {
      stereo = true;
      const ac = agentChannel(cfg);
      const [agentSide, customerSide] = await Promise.all([
        transcriber({ buffer: audio.buffer, filename: rec.source_path, channel: ac, model }),
        transcriber({ buffer: audio.buffer, filename: rec.source_path, channel: ac === 0 ? 1 : 0, model }),
      ]);
      const turns = mergeStereoSegments(agentSide, customerSide);
      perFile.push({
        source_path: rec.source_path,
        audio_seconds: audio.audio_seconds ?? agentSide?.audio_seconds ?? null,
        segments: turns,
        text: renderTurns(turns),
        language: agentSide?.language ?? customerSide?.language ?? null,
        confidence: pickConfidence(agentSide, customerSide),
        engineLowConfidence: Boolean(agentSide?.low_confidence || customerSide?.low_confidence),
      });
    } else {
      const one = await transcriber({ buffer: audio.buffer, filename: rec.source_path, channel: null, model });
      perFile.push({
        source_path: rec.source_path,
        audio_seconds: audio.audio_seconds ?? one?.audio_seconds ?? null,
        segments: (one?.segments || []).map((s) => ({ ...s, speaker: null })),
        text: String(one?.text ?? '').trim(),
        language: one?.language ?? null,
        confidence: typeof one?.confidence === 'number' ? one.confidence : null,
        engineLowConfidence: Boolean(one?.low_confidence),
      });
    }
  }

  const segments = rebaseSegments(perFile);
  const text = perFile.map((f) => f.text).filter(Boolean).join('\n');
  const audioSeconds = perFile.reduce((a, f) => a + (Number(f.audio_seconds) || 0), 0) || null;
  const confidences = perFile.map((f) => f.confidence).filter((c) => typeof c === 'number');
  const confidence = confidences.length ? Math.min(...confidences) : null;

  const { low, reasons } = assessConfidence({
    text,
    audioSeconds,
    engineLowConfidence: perFile.some((f) => f.engineLowConfidence),
    confidence,
  });
  if (low) console.log(`${LOG} call=${call.id} low_confidence: ${reasons.join(', ')}`);

  // Say which engine actually produced the row, so cost, quality and any
  // regression can be split by engine after the flip. Hardcoding 'openai'
  // would make self-hosted transcripts indistinguishable from paid ones.
  const selfHosted = cfg.transcribeEngine === 'speech';
  return {
    call_id: call.id,
    engine: selfHosted ? 'reece-speech-api' : 'openai',
    engine_model: selfHosted ? cfg.speech.modelLabel : model,
    language: perFile.find((f) => f.language)?.language ?? null,
    // 'stereo_channels' only when a stereo file actually produced labelled
    // turns — never asserted from config alone.
    diarization_method: stereo ? 'stereo_channels' : 'none',
    transcript_text: text,
    segments,
    confidence,
    low_confidence: low,
    audio_seconds: audioSeconds,
  };
}

function pickConfidence(a, b) {
  const vals = [a?.confidence, b?.confidence].filter((c) => typeof c === 'number');
  return vals.length ? Math.min(...vals) : null;
}

// ─── production defaults ────────────────────────────────────────────────────

/**
 * Load one recording's bytes out of the ci-audio bucket and read its shape.
 *
 * `channels` comes from the file's own RIFF header, never from a column or an
 * assumption — a mono file transcribed as stereo yields one empty channel, and
 * a stereo file transcribed as mono silently loses speaker labels.
 */
export function createStorageAudioLoader({ db = supabase } = {}) {
  return async function loadAudio(recording) {
    if (!recording?.storage_path) {
      throw new Error(`recording ${recording?.id ?? '?'} has no storage_path`);
    }
    const { data, error } = await db.storage.from(CI_AUDIO_BUCKET).download(recording.storage_path);
    if (error) throw new Error(`ci-audio download failed for ${recording.storage_path}: ${error.message}`);
    const buffer = Buffer.from(await data.arrayBuffer());
    return {
      buffer,
      channels: channelCount(buffer),
      audio_seconds: Math.round(durationSeconds(buffer) ?? 0) || null,
    };
  };
}

/**
 * OpenAI transcription. `channel` selects one side of a stereo file; when the
 * file cannot be split (unsupported codec, unparseable header) the whole
 * buffer is sent instead — a mono transcript of a stereo call beats no
 * transcript, and the caller records diarization honestly either way.
 *
 * Verbose JSON is requested so segment offsets come back; §6 stores those as
 * ci_transcripts.segments and the stereo merge is ordered by them.
 */
export function createOpenAITranscriber({ apiKey = process.env.OPENAI_API_KEY, fetchImpl = fetch } = {}) {
  return async function transcribe({ buffer, filename, channel, model }) {
    if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');

    let payload = buffer;
    if (channel !== null && channel !== undefined) {
      const one = extractChannel(buffer, channel);
      if (one) payload = one;
      else console.warn(`${LOG} could not split channel ${channel} of ${filename}; sending whole file`);
    }

    const form = new FormData();
    form.append('file', new Blob([payload], { type: 'audio/wav' }), basename(filename) || 'audio.wav');
    form.append('model', model);
    form.append('response_format', 'verbose_json');

    const res = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OpenAI transcription failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    const json = await res.json();
    return {
      text: String(json.text ?? '').trim(),
      segments: (json.segments || []).map((s) => ({
        start: Number(s.start ?? 0),
        end: Number(s.end ?? s.start ?? 0),
        text: String(s.text ?? '').trim(),
      })),
      language: json.language ?? null,
      audio_seconds: typeof json.duration === 'number' ? Math.round(json.duration) : null,
      confidence: null,
      low_confidence: false,
    };
  };
}

/**
 * Self-hosted transcription via reece-speech-api (faster-whisper).
 *
 * Uses the ASYNC job endpoints, not /v1/transcribe: the sync route answers 413
 * for anything longer than the service's SYNC_MAX_SECONDS (900), and Five9
 * calls routinely run long. Create a job, poll it, map the result into the
 * SAME shape createOpenAITranscriber returns, so transcribeCall and everything
 * after it cannot tell the engines apart.
 *
 * Channel handling is identical to the OpenAI path: split one side of a stereo
 * file, or send the whole buffer when it cannot be split.
 *
 * Contract, read from mrichard33/reece-speech-api main (app/main.py, app/auth.py,
 * app/jobs.py) on 2026-09-28 — its /openapi.json does not describe it:
 *   POST /v1/jobs      → 202 {job_id, status:'queued', chunks_total}
 *   GET  /v1/jobs/{id} → 200 {job_id, status, chunks_total, chunks_done, chunks,
 *                             result, error}
 *   status is exactly queued | processing | done | failed; `result` is null
 *   until done, then {text, language, duration, model, segments[{start,end,text}]}.
 *
 * Two poll answers are TRANSIENT and keep the loop going until the deadline:
 * 429 (the service rate-limits polls too, 30/min per key) and 503 (model still
 * loading after a service restart, or its job store briefly unreachable).
 * Giving up on either would throw away a job that is still running. A 404 is
 * NOT transient — the default memory store forgets every job on restart, so
 * the job is gone and only a resubmit (the call's normal retry) recovers it.
 *
 * Throws on any failure. recordFailure() then applies the normal backoff and
 * the call retries. There is deliberately NO silent fallback to OpenAI, since
 * that would quietly bring back the cost this exists to remove.
 */
export function createSpeechApiTranscriber({
  baseUrl,
  apiKey,
  timeoutMs = 240000,
  pollMs = 5000,
  language = 'auto',
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  clock = () => Date.now(),
} = {}) {
  return async function transcribe({ buffer, filename, channel }) {
    if (!baseUrl) throw new Error('CI_SPEECH_API_URL is not configured');
    if (!apiKey) throw new Error('CI_SPEECH_API_KEY is not configured');
    const base = String(baseUrl).replace(/\/+$/, '');
    const headers = speechAuthHeaders(apiKey);

    let payload = buffer;
    if (channel !== null && channel !== undefined) {
      const one = extractChannel(buffer, channel);
      if (one) payload = one;
      else console.warn(`${LOG} could not split channel ${channel} of ${filename}; sending whole file`);
    }

    const form = new FormData();
    form.append('audio', new Blob([payload], { type: 'audio/wav' }), basename(filename) || 'audio.wav');
    form.append('language', language);
    form.append('timestamps', 'true');

    const deadline = clock() + timeoutMs;
    const created = await fetchImpl(`${base}/v1/jobs`, { method: 'POST', headers, body: form });
    if (!created.ok) {
      const detail = await created.text().catch(() => '');
      throw new Error(`speech job create failed (${created.status}): ${detail.slice(0, 300)}`);
    }
    const jobId = jobIdOf(await created.json());
    if (!jobId) throw new Error('speech job create returned no job id');

    for (;;) {
      await sleep(pollMs);
      // Checked AFTER the wait, so no request goes out once the budget is spent.
      if (clock() > deadline) throw new Error(`speech job ${jobId} timed out after ${Math.round(timeoutMs / 1000)}s`);
      const res = await fetchImpl(`${base}/v1/jobs/${encodeURIComponent(jobId)}`, { headers });
      if (res.status === 429 || res.status === 503) continue;
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`speech job ${jobId} poll failed (${res.status}): ${detail.slice(0, 300)}`);
      }
      const job = await res.json();
      const state = jobStateOf(job);
      if (state === 'done') return mapSpeechResult(job);
      if (state === 'failed') {
        throw new Error(`speech job ${jobId} failed: ${String(job?.error ?? 'unknown').slice(0, 300)}`);
      }
    }
  };
}

/** The service checks `Authorization: Bearer <SPEECH_API_KEY>` and nothing else (app/auth.py). */
export function speechAuthHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

/** POST /v1/jobs answers {job_id, status, chunks_total}. */
export function jobIdOf(json) {
  return json?.job_id ?? null;
}

/**
 * 'done' | 'failed' | 'pending'. The service's statuses are exactly
 * queued | processing | done | failed. Anything else THROWS rather than being
 * polled until the deadline: an unknown status means the contract changed,
 * and that should surface on the first poll, not as a 4-minute timeout.
 */
export function jobStateOf(job) {
  const s = job?.status;
  if (s === 'done') return 'done';
  if (s === 'failed') return 'failed';
  if (s === 'queued' || s === 'processing') return 'pending';
  throw new Error(`speech job returned unknown status ${JSON.stringify(s ?? null)}`);
}

/**
 * Map a finished job to the transcriber contract used by transcribeCall.
 * confidence stays null and low_confidence false, EXACTLY as the OpenAI path
 * returns. assessConfidence() still applies its own empty/sparse-output rules,
 * so low-confidence detection is unchanged across engines.
 */
export function mapSpeechResult(job) {
  const body = job?.result ?? {};
  const segs = Array.isArray(body.segments) ? body.segments : [];
  return {
    text: String(body.text ?? '').trim(),
    segments: segs.map((s) => ({
      start: Number(s.start ?? 0),
      end: Number(s.end ?? s.start ?? 0),
      text: String(s.text ?? '').trim(),
    })),
    language: body.language ?? null,
    audio_seconds: typeof body.duration === 'number' ? Math.round(body.duration) : null,
    confidence: null,
    low_confidence: false,
  };
}

/** The ONE place the engine flag is read to build a transcriber. */
export function selectTranscriber(cfg = getConfig(), deps = {}) {
  if (cfg.transcribeEngine === 'speech') {
    return createSpeechApiTranscriber({
      baseUrl: cfg.speech.url,
      apiKey: cfg.speech.apiKey,
      timeoutMs: cfg.speech.timeoutMs,
      pollMs: cfg.speech.pollMs,
      language: cfg.speech.language,
      ...deps,
    });
  }
  return createOpenAITranscriber(deps);
}

function basename(p) {
  return String(p || '').split('/').filter(Boolean).pop() || '';
}

export default {
  orderSegments,
  mergeStereoSegments,
  rebaseSegments,
  renderTurns,
  assessConfidence,
  wordsPerTenSeconds,
  agentChannel,
  transcribeCall,
  createStorageAudioLoader,
  createOpenAITranscriber,
  createSpeechApiTranscriber,
  selectTranscriber,
  mapSpeechResult,
};
