#!/usr/bin/env node
/**
 * Give already-stored recordings a playable MP3 — scripts/backfill-ci-mp3.js
 *
 * WHY: sql/070 adds mp3_storage_path/mp3_bytes and src/ci/recordings.js fills
 * them on every NEW fetch. Recordings already in the bucket keep serving the
 * original Five9 WAV — GSM 6.10, WAVE format tag 0x0031 — which Chrome, Safari,
 * Firefox and QuickTime all refuse to decode. The rep clicks the link and gets
 * nothing. This walks those rows and transcodes them.
 *
 * There are 10 today. It is written to work on thousands: it pages rather than
 * taking the first N, it streams one recording at a time rather than loading a
 * batch of audio into memory, and it can be stopped and re-run.
 *
 * Usage:
 *   node scripts/backfill-ci-mp3.js                 # dry-run
 *   node scripts/backfill-ci-mp3.js --execute       # write
 *   node scripts/backfill-ci-mp3.js --limit=50 --execute
 *
 * Flags:
 *   --execute   actually transcode and write; omitted, nothing is written
 *   --limit=N   process at most N recordings
 *
 * ── IDEMPOTENT ─────────────────────────────────────────────────────────────
 * Selection is `mp3_storage_path IS NULL`, so a row that already has an MP3 is
 * never re-encoded and a second run over an unchanged bucket does nothing. Stop
 * it half way and re-run: it picks up exactly where it left off.
 *
 * ── IT NEVER TOUCHES THE WAV ───────────────────────────────────────────────
 * storage_path is READ and never written. That file is the archival copy and
 * the transcription input — src/ci/transcribe.js reads storage_path, and
 * Whisper accepts the GSM WAV as-is. This script adds an object and sets two
 * columns; it removes nothing.
 *
 * ── ONE BAD FILE DOES NOT STOP THE RUN ─────────────────────────────────────
 * A recording that will not convert is counted, named, and skipped. Its row
 * keeps mp3_storage_path null, the route keeps serving its WAV, and the rest of
 * the batch still gets done.
 *
 * Pre-conditions:
 *   - ffmpeg on PATH (Dockerfile installs it; CI_FFMPEG_PATH overrides)
 *   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY set (for --execute)
 *   - sql/070 applied (runMigrations() mirrors it)
 */

import { CI_AUDIO_BUCKET } from './setup-ci-audio-bucket.js';
import { transcodeToMp3, storeMp3, ffmpegAvailable } from '../src/ci/recordings.js';

const ARGV = process.argv.slice(2);

/** PostgREST caps a read; page rather than silently taking the first N. */
export const PAGE_SIZE = 200;

/** Parse the flags. Pure — argv is an argument, so the rules are testable. */
export function parseArgs(argv) {
  let execute = false;
  let limit = null;
  for (const a of argv || []) {
    if (a === '--execute') execute = true;
    else if (a.startsWith('--limit=')) {
      const n = parseInt(a.slice('--limit='.length), 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    }
  }
  return { execute, limit };
}

/**
 * Is this row a candidate? Pure.
 *
 * Needs a WAV to convert FROM, must not already have an MP3, and must not be
 * purged — a purged row's bytes are gone, and re-creating a derivative of audio
 * we deliberately deleted would resurrect it past its retention window.
 */
export function needsMp3(row) {
  return Boolean(row?.storage_path) && !row?.mp3_storage_path && !row?.purged_at;
}

/** Filter a page down to the rows worth working. Pure. */
export function selectCandidates(rows) {
  return (rows || []).filter(needsMp3);
}

/** Refuse to touch anything but the LP MCP instance. */
async function assertLpInstance(supabase) {
  const host = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).host : '(unset)';
  const { error } = await supabase.from('lp_leads').select('id').limit(1);
  if (error) {
    console.error(`Refusing to write: SUPABASE_URL points at ${host}, which does not look like the LP MCP instance.`);
    console.error(`  probe: SELECT id FROM lp_leads LIMIT 1 -> ${error.message}`);
    process.exit(1);
  }
  console.log(`  target instance OK (${host}, lp_leads reachable)`);
}

/**
 * Read ONE page of recordings that still have no MP3.
 *
 * Filtered server-side so a bucket of 100k rows does not come down the wire to
 * be discarded client-side. needsMp3() re-checks each row anyway — the filter
 * and the predicate must agree, and the predicate is the one under test.
 *
 * ── WHY THE CALLER ADVANCES THE OFFSET, AND NOT BY THE PAGE SIZE ───────────
 * --execute MUTATES the set this pages over: every row it writes stops matching
 * `mp3_storage_path is null` and drops out. Advancing a numeric offset by the
 * page size would then step over that many UNPROCESSED rows — the set has
 * shrunk underneath the cursor — and the run would silently skip most of the
 * backlog while reporting success.
 *
 * So the offset advances only by the number of rows that did NOT leave the set:
 * the failures in --execute (which must not be retried forever inside one run),
 * and the whole page in a dry-run (where nothing is written and nothing drops
 * out). That is correct in both modes and needs no cursor encoding.
 */
async function readPendingPage(supabase, { offset, size }) {
  const { data, error } = await supabase
    .from('ci_recordings')
    .select('id, call_id, source_path, source_filename, file_sha256, file_bytes, storage_path, mp3_storage_path, purged_at, fetched_at')
    .is('mp3_storage_path', null)
    .is('purged_at', null)
    .not('storage_path', 'is', null)
    .order('fetched_at', { ascending: true })
    .order('id', { ascending: true })
    .range(offset, offset + size - 1);
  if (error) throw new Error(`ci_recordings read failed: ${error.message}`);
  return data || [];
}

/** Pull the stored WAV back out of the bucket. */
async function downloadWav(supabase, storagePath) {
  const { data, error } = await supabase.storage.from(CI_AUDIO_BUCKET).download(storagePath);
  if (error) throw new Error(`download failed: ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}

/**
 * Convert one recording and record it. Throws on failure so the caller can
 * count it and carry on.
 *
 * The MP3 is keyed on the SOURCE WAV's sha — the same rule the fetch stage
 * uses — so a row backfilled here and a row transcoded at fetch land on
 * identical paths, and re-running overwrites one object instead of littering.
 */
async function backfillOne(supabase, rec) {
  const wav = await downloadWav(supabase, rec.storage_path);
  const mp3 = await transcodeToMp3(wav);
  const stored = await storeMp3({
    callId: rec.call_id,
    buffer: mp3,
    // Older rows can predate file_sha256; fall back to the WAV object's own
    // basename, which IS that hash for anything storeAudio() ever wrote.
    sha: rec.file_sha256 || String(rec.storage_path).split('/').pop().replace(/\.wav$/i, ''),
    db: supabase,
  });

  // Two columns, nothing else. storage_path is not in this payload.
  const { error } = await supabase
    .from('ci_recordings')
    .update({ mp3_storage_path: stored.storagePath, mp3_bytes: stored.bytes })
    .eq('id', rec.id);
  if (error) throw new Error(`ci_recordings update failed: ${error.message}`);

  return { wavBytes: wav.length, mp3Bytes: stored.bytes, path: stored.storagePath };
}

async function main() {
  const args = parseArgs(ARGV);

  const ff = await ffmpegAvailable();
  if (!ff.ok) {
    console.error(`ffmpeg is not available (${ff.error}). This script cannot transcode without it.`);
    console.error('  Install it (Dockerfile: apk add ffmpeg) or set CI_FFMPEG_PATH.');
    process.exit(1);
  }
  console.log(`backfill-ci-mp3 ${args.execute ? '--execute' : '(DRY-RUN — no transcode, no writes; pass --execute after review)'}`);
  console.log(`  ffmpeg: ${ff.version}`);
  console.log(`  selecting: ci_recordings with storage_path set, mp3_storage_path null, not purged${args.limit ? `, at most ${args.limit}` : ''}`);
  console.log('  the original WAV is never modified or removed\n');

  const { default: supabase } = await import('../src/supabase.js');
  if (!supabase) {
    console.error('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing).');
    process.exit(1);
  }

  if (args.execute) {
    await assertLpInstance(supabase);
    console.log('');
  }

  let examined = 0;
  let done = 0;
  let wavTotal = 0;
  let mp3Total = 0;
  const failures = [];

  // See readPendingPage(): the offset advances by the rows that STAYED in the
  // set, so --execute cannot step over unprocessed rows as successes drop out.
  let offset = 0;
  for (;;) {
    const size = args.limit ? Math.min(PAGE_SIZE, args.limit - examined) : PAGE_SIZE;
    if (size <= 0) break;

    const page = await readPendingPage(supabase, { offset, size });
    if (!page.length) break;

    let stayed = 0;
    for (const rec of selectCandidates(page)) {
      examined += 1;

      if (!args.execute) {
        console.log(`  would transcode ${rec.source_filename || rec.storage_path} (${rec.file_bytes ?? '?'} B)`);
        stayed += 1;   // nothing is written, so nothing leaves the set
        continue;
      }

      try {
        // ONE AT A TIME. Each recording is a whole call's audio held in memory
        // twice over — WAV in, MP3 out — and a parallel batch of those is how
        // a 512 MB container dies on a long call.
        const r = await backfillOne(supabase, rec);
        done += 1;
        wavTotal += r.wavBytes;
        mp3Total += r.mp3Bytes;
        console.log(`  ${rec.source_filename || rec.id} -> ${r.mp3Bytes} B mp3`);
      } catch (err) {
        // Counted, named, skipped. The row keeps mp3_storage_path null, the
        // route keeps serving its WAV, and the rest of the batch still runs.
        // It stays in the set, so the offset must step past it or the next
        // page would hand it back forever.
        stayed += 1;
        failures.push({ rec: rec.source_filename || rec.id, error: err.message });
        console.error(`  ${rec.source_filename || rec.id} FAILED: ${err.message}`);
      }
    }

    // A row the server matched but selectCandidates() rejected also stays.
    stayed += page.length - selectCandidates(page).length;

    offset += stayed;
    if (page.length < size) break;
  }

  if (!examined) {
    console.log('Nothing to do — every live recording already has an MP3.');
    return;
  }

  if (!args.execute) {
    console.log(`\n${examined} recording(s) would be transcoded.`);
    console.log('DRY-RUN complete. No writes performed.');
    return;
  }

  console.log(`\nTranscoded ${done}/${examined} recording(s).`);
  if (done) console.log(`  ${wavTotal} B of WAV -> ${mp3Total} B of MP3 (originals all retained)`);
  if (failures.length) {
    console.log(`\n${failures.length} recording(s) FAILED and still serve their WAV:`);
    for (const f of failures.slice(0, 20)) console.log(`  ${f.rec}: ${f.error}`);
    process.exitCode = 1;
  }
}

// Only run as a script — the pure helpers are imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('backfill-ci-mp3 failed:', err.message);
    process.exit(1);
  });
}
