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
 *   null so "no agent on this leg" stays legible downstream. `sessionId` is
 *   null for every pre-2026-08-22 name and is NEVER a call key — see below.
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

  // ── the clock comes off the HEAD, not the whole tail ────────────────────
  // Until 2026-08-22 the clock WAS the whole tail (after an optional module
  // split) and the clock had to match the remainder exactly. It now appends a
  // session id, so anything that insists the clock is the entire remainder
  // rejects every new name. Anchoring at the head reads both eras.
  const head = CLOCK_HEAD_RE.exec(tail);
  if (!head) return null;
  const clockText = head[1].trim();
  let rest = head[2];

  // Old format: nothing follows the clock. Byte-identical behaviour.
  if (!rest) return { ani, agentUsername, clockText, ivrModule: null, sessionId: null };

  const split = splitModuleAndSession(rest);
  if (!split) return null;

  return { ani, agentUsername, clockText, ivrModule: split.ivrModule, sessionId: split.sessionId };
}

/**
 * 'H_MM_SS AM/PM' at the START of the string, with the remainder captured.
 *
 * Anchored at the head rather than over the whole string, which is the single
 * change that reads both filename eras: before 2026-08-22 the remainder is
 * empty or '_{module}', and after it the remainder also carries a session id.
 */
const CLOCK_HEAD_RE = /^(\d{1,2}_\d{2}_\d{2}\s*[AaPp][Mm])(.*)$/;

/**
 * The session id Five9 began appending on 2026-08-22: 32 hex characters
 * followed by digits.
 *
 * ══ THIS IS NOT THE FIVE9 CALL ID. DO NOT JOIN ON IT. ══
 * The trailing digits look exactly like a call id and are not one. Verified
 * 2026-08-25 against all 20 rows that carried it, plus a direct lookup:
 *
 *   filename tail   300000002864763   300000002864750   300000002866719
 *   five9_call_id   300000010289685   300000010289658   300000010296218
 *
 * Every ci_calls.five9_call_id since 2026-08-24 (n=15,590) falls in
 * 300000010282668 … 300000010298341; the filename tails sit around
 * 3000000028…, roughly 7.4 million below. Disjoint ranges, and
 * raw_metadata.recordings_raw carries only a timestamp and a duration, so
 * nothing we store maps one space to the other.
 *
 * This module already records that the LEADING number is the ANI and not a
 * call id — an earlier handoff assumed otherwise and the whole join had to be
 * redesigned around the retraction. The same rule applies here. The id is
 * stored for provenance and for the day a mapping exists; the join stays
 * campaign + customer number + time.
 *
 * ── THE DAY A MAPPING MIGHT EXIST, AND HOW TO TEST IT ──────────────────────
 * ci_calls.five9_session_id has been declared since sql/061 and discovery.js
 * already writes it (`five9_session_id: primary.sessionId || null`). It is
 * populated on 0 of 15,848 rows because the saved Call Log report does not
 * currently emit a Session ID column — not because the code is missing.
 *
 * So there is a plausible, cheap route to the exact key this heuristic join
 * would love to have, and it is a REPORT CONFIGURATION change rather than a
 * code change: add the Session ID column to the Five9 saved report, let
 * discovery populate five9_session_id, then check whether the filename tail
 * matches it:
 *
 *   SELECT count(*) FILTER (WHERE right(r.five9_recording_id, 15) = c.five9_session_id)
 *   FROM ci_recordings r JOIN ci_calls c ON c.id = r.call_id
 *   WHERE r.five9_recording_id IS NOT NULL AND c.five9_session_id IS NOT NULL;
 *
 * That is a HYPOTHESIS, not a finding. Until that query returns a convincing
 * number on real rows, nothing here joins on this id.
 *
 * ══ WHY THE SHAPE IS EXACT AND ANCHORED TO THE END ══
 * Because "find a 32-hex run" does not have one answer. The id abuts the
 * module with no separator, and the module can END in a hex character:
 *
 *   Transfer to LightfireCB3E712B7E084D8A9BD23381B216E482300000002866719
 *                      ^
 *                      'e' is a hex digit, so a leftmost scan starts HERE
 *                      and returns the module as 'Transfer to Lightfir'
 *
 * A rightmost scan is no better — it eats into the id — because the trailing
 * digits are themselves hex characters, so runs of ≥32 hex start at many
 * positions. Only the id's exact structure pins the boundary: 32 hex followed
 * by exactly 15 digits, ending the string. That is 47 characters, uniform
 * across all 20 rows carrying it as of 2026-08-25.
 *
 * A truncated module is not a loud failure. It would silently miss
 * ci_transfer_target_map's exact-equality lookup and re-break classifyTeam —
 * the very defect this parser exists to repair. If Five9 changes the id's
 * length the name stops parsing and is COUNTED as unparseable, which is the
 * correct failure: visible, not silently wrong.
 */
const SESSION_ID_RE = /[0-9A-Fa-f]{32}\d{15}$/;

/**
 * Split what follows the clock into an optional module and the session id.
 *
 * ── WHY IT ANCHORS ON THE HEX RUN ──────────────────────────────────────────
 * The id abuts whatever precedes it with NO separator:
 *
 *   _Transfer to LightfireCB3E712B7E084D8A9BD23381B216E482300000002866719
 *    └──── module ───────┘└─────────── session id ───────────────────────┘
 *
 * so there is no delimiter to split on and the 32-hex run is the only reliable
 * boundary. Taking the module as everything BEFORE the run and the id as
 * everything FROM it onward is also robust to what sits inside the id: whether
 * the trailing blob is hex+digits or carries another token between them, the
 * module still ends where the hex begins. That matters because the plain-agent
 * shape has not been observed directly — only the transfer shape has.
 *
 * ── AND WHY IT REFUSES ANYTHING ELSE ───────────────────────────────────────
 * A trailing blob with no 32-hex run returns null, exactly as today. That
 * refusal is the feature: a filename this code cannot confidently read must
 * stay unreadable and be COUNTED (see createSftpAdapter's onStats), because a
 * parser that guesses at an unknown shape is a parser that hides the next
 * vendor change instead of surfacing it. That is precisely how the 2026-08-22
 * break went unnoticed for three days.
 *
 * @returns {{ivrModule: string|null, sessionId: string}|null}
 */
function splitModuleAndSession(rest) {
  // End-anchored, so there is exactly one match and no boundary to choose.
  const at = rest.search(SESSION_ID_RE);

  // No session id. This is the OLD format's transfer leg — '_{module}' and
  // nothing else — and it must keep parsing exactly as it always has. The
  // archive holds these back to ~Aug 2023 and the backfill reads them.
  if (at === -1) {
    if (rest[0] !== '_') return null;
    const legacyModule = rest.slice(1).trim();
    return legacyModule ? { ivrModule: legacyModule, sessionId: null } : null;
  }

  const before = rest.slice(0, at);
  const sessionId = rest.slice(at);

  // What precedes the id is the module, introduced by the '_' that has always
  // separated it from the clock. No '_' and no text means a plain agent call.
  if (!before) return { ivrModule: null, sessionId };
  if (before[0] !== '_') return null;

  const ivrModule = before.slice(1).trim();
  return { ivrModule: ivrModule || null, sessionId };
}

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
