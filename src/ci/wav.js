/**
 * Minimal RIFF/WAVE reader — src/ci/wav.js
 *
 * Just enough WAV to answer two questions about a Five9 recording without
 * shelling out to ffmpeg: how many channels does it have, and can I get one
 * channel on its own? §6 needs both — stereo calls are transcribed per channel
 * so the agent/customer labels are deterministic rather than guessed by a
 * diarizer.
 *
 * Scope is deliberate. This reads uncompressed PCM (format 1) and IEEE float
 * (format 3), which is what a telephony recorder emits. Anything else —
 * compressed, extensible, malformed — is reported as unsupported and the
 * caller treats the file as mono and transcribes it whole. Degrading to mono
 * loses speaker labels; guessing at a format we cannot parse would corrupt the
 * audio and produce a confident, wrong transcript.
 *
 * Pure and synchronous: no I/O, no env. Every branch is reachable from a
 * handcrafted buffer in a test.
 */

const RIFF = 0x52494646; // 'RIFF'
const WAVE = 0x57415645; // 'WAVE'

export const WAV_FORMAT_PCM = 1;
export const WAV_FORMAT_FLOAT = 3;
export const WAV_FORMAT_EXTENSIBLE = 0xfffe;

/**
 * Parse the header and locate the data chunk.
 *
 * Chunks are walked rather than assumed to sit at fixed offsets: real files
 * carry LIST/INFO or fact chunks between `fmt ` and `data`, and a reader that
 * assumes data starts at byte 44 silently treats metadata as audio.
 *
 * @returns {{ok: true, ...} | {ok: false, reason: string}}
 */
export function parseWav(buffer) {
  const buf = toBuffer(buffer);
  if (!buf || buf.length < 12) return { ok: false, reason: 'too_short' };
  if (buf.readUInt32BE(0) !== RIFF) return { ok: false, reason: 'not_riff' };
  if (buf.readUInt32BE(8) !== WAVE) return { ok: false, reason: 'not_wave' };

  let offset = 12;
  let fmt = null;
  let dataStart = null;
  let dataLength = 0;

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = {
        formatTag: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        byteRate: buf.readUInt32LE(body + 8),
        blockAlign: buf.readUInt16LE(body + 12),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataStart = body;
      // A streamed file can declare a size of 0 or one longer than what
      // actually arrived. Trust the buffer, not the header.
      dataLength = size === 0 ? buf.length - body : Math.min(size, buf.length - body);
      break;
    }
    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = body + size + (size % 2);
  }

  if (!fmt) return { ok: false, reason: 'no_fmt_chunk' };
  if (dataStart === null) return { ok: false, reason: 'no_data_chunk' };
  if (!fmt.channels || !fmt.bitsPerSample || !fmt.sampleRate) {
    return { ok: false, reason: 'degenerate_fmt' };
  }

  const bytesPerSample = fmt.bitsPerSample / 8;
  const blockAlign = fmt.blockAlign || bytesPerSample * fmt.channels;
  const durationSeconds = blockAlign > 0 && fmt.sampleRate > 0
    ? dataLength / (blockAlign * fmt.sampleRate)
    : null;

  return {
    ok: true,
    ...fmt,
    blockAlign,
    bytesPerSample,
    dataStart,
    dataLength,
    durationSeconds,
    supported: (fmt.formatTag === WAV_FORMAT_PCM || fmt.formatTag === WAV_FORMAT_FLOAT)
      && Number.isInteger(bytesPerSample) && bytesPerSample > 0,
  };
}

/** Channel count, or 1 when the file cannot be parsed (treat as mono). */
export function channelCount(buffer) {
  const info = parseWav(buffer);
  return info.ok ? info.channels : 1;
}

/** Duration in seconds, or null when unknown. */
export function durationSeconds(buffer) {
  const info = parseWav(buffer);
  return info.ok ? info.durationSeconds : null;
}

/**
 * Extract one channel as a standalone mono WAV.
 *
 * Returns null rather than a corrupted buffer whenever the input is not
 * something we can safely de-interleave — an unparseable file, an unsupported
 * codec, or a channel index that does not exist. The caller then falls back to
 * transcribing the original whole, which loses labels but never invents audio.
 */
export function extractChannel(buffer, channel) {
  const info = parseWav(buffer);
  if (!info.ok || !info.supported) return null;
  if (!Number.isInteger(channel) || channel < 0 || channel >= info.channels) return null;
  if (info.channels === 1) return toBuffer(buffer);

  const { bytesPerSample, blockAlign, dataStart, dataLength } = info;
  const src = toBuffer(buffer);
  const frames = Math.floor(dataLength / blockAlign);
  const out = Buffer.alloc(frames * bytesPerSample);

  for (let f = 0; f < frames; f++) {
    src.copy(
      out,
      f * bytesPerSample,
      dataStart + f * blockAlign + channel * bytesPerSample,
      dataStart + f * blockAlign + channel * bytesPerSample + bytesPerSample,
    );
  }
  return buildWav(out, {
    formatTag: info.formatTag,
    channels: 1,
    sampleRate: info.sampleRate,
    bitsPerSample: info.bitsPerSample,
  });
}

/** Wrap raw sample bytes in a canonical 44-byte RIFF/WAVE header. */
export function buildWav(samples, { formatTag = WAV_FORMAT_PCM, channels = 1, sampleRate = 8000, bitsPerSample = 16 } = {}) {
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + samples.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(formatTag, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(samples.length, 40);

  return Buffer.concat([header, samples]);
}

function toBuffer(b) {
  if (!b) return null;
  if (Buffer.isBuffer(b)) return b;
  if (b instanceof Uint8Array) return Buffer.from(b);
  if (b instanceof ArrayBuffer) return Buffer.from(new Uint8Array(b));
  return null;
}

export default { parseWav, channelCount, durationSeconds, extractChannel, buildWav };
