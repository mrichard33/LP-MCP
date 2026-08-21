/**
 * Recording filename + path parsing — src/ci/filenames.js
 *
 * The archive layout, verified against ETG's server on 2026-08-20:
 *
 *   /Five9/Recordings/{CAMPAIGN NAME}/{M_D_YYYY}/{filename}.wav
 *
 * and the filename itself:
 *
 *   {ANI} by {agent_username} @ {H_MM_SS AM/PM}_{ivr_module}.wav
 *
 * THE LEADING NUMBER IS THE ANI, NOT THE FIVE9 CALL ID. An earlier revision of
 * the handoff assumed a Call ID was recoverable here; it is not, and the whole
 * recording→call join was redesigned around that retraction. Nothing in this
 * module may present the ANI as an identifier for a call.
 *
 * Two shapes that break naive parsing, both real:
 *   - agent_username is EMPTY on transfer legs: 'by  @' — two spaces, no name.
 *   - ivr_module contains spaces ('Transfer to Lightfire', 'Third Party
 *     Transfer'), and the separator is the LAST '_' before '.wav'. Splitting on
 *     the first '_' shreds the clock; splitting on every '_' shreds the module.
 *
 * Pure module: no env, no clients, no import-time work.
 */

/**
 * Parse a recording filename.
 *
 * @returns {object|null} null when the name does not match the format at all —
 *   the caller records the file as unparseable rather than inventing fields.
 *   A null `ivrModule` is normal (plain agent call); an empty-string
 *   `agentUsername` is normal (transfer leg) and is deliberately distinct from
 *   null so "no agent on this leg" stays legible downstream.
 */
export function parseRecordingFilename(filename) {
  const raw = String(filename ?? '').trim();
  if (!raw) return null;

  const base = raw.replace(/\.wav$/i, '');
  if (base === raw && /\.[a-z0-9]{2,4}$/i.test(raw)) return null;  // some other extension

  // {ANI} by {agent} @ {rest}   — agent may be empty, so *? and a greedy tail.
  const m = /^(\d{7,15})\s+by\s(.*?)\s@\s(.+)$/.exec(base);
  if (!m) return null;

  const ani = m[1];
  const agentUsername = m[2].trim();   // '' on transfer legs
  const tail = m[3];

  // The separator is the LAST '_' — but only when what follows it is a module
  // name rather than part of the clock. The clock itself ends in '_SS AM/PM',
  // so a trailing '_' segment is a module only if the text before it still
  // parses as a complete clock.
  const lastUnderscore = tail.lastIndexOf('_');
  let clockText = tail;
  let ivrModule = null;

  if (lastUnderscore > 0) {
    const candidateClock = tail.slice(0, lastUnderscore);
    const candidateModule = tail.slice(lastUnderscore + 1);
    if (CLOCK_RE.test(candidateClock.trim()) && candidateModule.trim()) {
      clockText = candidateClock;
      ivrModule = candidateModule.trim();
    }
  }

  clockText = clockText.trim();
  if (!CLOCK_RE.test(clockText)) return null;

  return { ani, agentUsername, clockText, ivrModule };
}

/** 'H_MM_SS AM/PM' — the complete clock, anchored. */
const CLOCK_RE = /^\d{1,2}_\d{2}_\d{2}\s*[AaPp][Mm]$/;

/**
 * Parse a full remote path into its parts.
 *
 * Campaign is taken from the DIRECTORY and is matched EXACTLY downstream —
 * never case-folded. Near-duplicate directories differing only in case exist
 * on the server ('Magazine - CLiPP' vs 'Magazine - Clipp'), so folding would
 * merge two distinct campaigns into one.
 */
export function parseRecordingPath(fullPath, root = '/Five9/Recordings') {
  const path = String(fullPath ?? '').trim();
  if (!path) return null;

  const prefix = String(root).replace(/\/+$/, '');
  if (!path.startsWith(`${prefix}/`)) return null;

  const rest = path.slice(prefix.length + 1);
  const parts = rest.split('/');
  if (parts.length !== 3) return null;   // campaign/date/file — flat, no nesting

  const [campaignDir, dateDir, filename] = parts;
  if (!campaignDir || !dateDir || !filename) return null;

  const parsed = parseRecordingFilename(filename);
  if (!parsed) return null;

  return { sourcePath: path, campaignDir, dateDir, sourceFilename: filename, ...parsed };
}

/**
 * The ETG-owned directory, untouched since Jan 2026. §6 says skip it — it is
 * not ours and nothing in it is Five9 call audio.
 */
export const SKIP_DIRS = new Set(['Owner']);

export function isSkippedDir(dirName) {
  return SKIP_DIRS.has(String(dirName ?? '').trim());
}

/**
 * Should this file be ingested, or recorded as deliberately excluded?
 *
 * Two exclusions, both from §6:
 *   test_module     — Mark's transfer-module build tests. They appear only on
 *                     8/14 and 8/17/2026 and are ~1 second long. Matched BY
 *                     NAME as well as by size, because a longer test recording
 *                     would slip straight past a byte floor.
 *   below_min_bytes — ~1s files (1.7–4.9 KB observed) that carry no
 *                     conversation. Default floor 8000 bytes.
 *
 * Excluded files are still ROWS — recorded with a reason, never silently
 * dropped, so reconciliation can tell "we chose not to" from "we missed it".
 *
 * @returns {{excluded: boolean, reason: string|null}}
 */
export function classifyExclusion({ ivrModule, fileBytes, campaignDir, excludedModules = [], minBytes = 8000 } = {}) {
  if (isSkippedDir(campaignDir)) {
    return { excluded: true, reason: 'owner_dir' };
  }
  if (ivrModule && excludedModules.some((m) => String(m) === ivrModule)) {
    return { excluded: true, reason: 'test_module' };
  }
  if (Number.isFinite(fileBytes) && fileBytes < minBytes) {
    return { excluded: true, reason: 'below_min_bytes' };
  }
  return { excluded: false, reason: null };
}

/**
 * Default excluded IVR modules, mirroring the ci_campaign_map column default
 * in sql/062 so a crawl still excludes correctly when no campaign row exists
 * yet (an unmapped campaign must not become an ingestion hole).
 */
export const DEFAULT_EXCLUDED_IVR_MODULES = [
  'ThirdPartyTransfer',
  'ThirdPartyTransfer2',
  'Third Party Transfer',
];
