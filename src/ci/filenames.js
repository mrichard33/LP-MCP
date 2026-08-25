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
 * recording->call join was redesigned around that retraction. Nothing in this
 * module may present the ANI as an identifier for a call.
 *
 * Two shapes that break naive parsing, both real:
 *   - agent_username is EMPTY on transfer legs: 'by  @' — two spaces, no name.
 *   - ivr_module contains spaces ('Transfer to Lightfire', 'Third Party
 *     Transfer'), and the separator is the LAST '_' before '.wav'.
 *
 * Pure module: no env, no clients, no import-time work.
 */

/**
 * Parse a recording filename.
 *
 * @returns {object|null} null when the name does not match the format at all —
 *   the caller records the file as unparseable rather than inventing fields.
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

  const head = CLOCK_HEAD_RE.exec(tail);
  if (!head) return null;
  const clockText = head[1].trim();
  const rest = head[2];

  // Old format: nothing follows the clock. Byte-identical behaviour.
  if (!rest) return { ani, agentUsername, clockText, ivrModule: null, sessionId: null };

  // agentUsername is threaded in DELIBERATELY — see splitModuleAndSession.
  const split = splitModuleAndSession(rest, agentUsername);
  if (!split) return null;

  return { ani, agentUsername, clockText, ivrModule: split.ivrModule, sessionId: split.sessionId };
}

/**
 * 'H_MM_SS AM/PM' at the START of the string, with the remainder captured.
 */
const CLOCK_HEAD_RE = /^(\d{1,2}_\d{2}_\d{2}\s*[AaPp][Mm])(.*)$/;

/**
 * The session id Five9 began appending on 2026-08-22.
 *
 * == THE ACTUAL SHAPE, from verbatim filenames read off the archive ==
 * Confirmed 2026-08-25 via GET /ci/trace-fetch on a full Main Number folder
 * (335 .wav files). The id is NOT '32 hex + 15 digits'. On a plain agent call
 * the AGENT USERNAME sits BETWEEN the hex run and the digits:
 *
 *   ...2_47_37 PMA7DD782645174F9285831B51AD12EB90ljulien300000002867064.wav
 *                |--------- 32 hex -----------||agent||-- 15 digits --|
 *
 * On a transfer leg there is no agent, so the two are contiguous:
 *
 *   ..._Transfer to LightfireB6A58CED4F5246238AAB0FCA8EFAF2D0300000002867137
 *       |---- module ------||-------- 32 hex ------------||- 15 digits -|
 *
 * A single regex of /[0-9A-Fa-f]{32}\d{15}$/ therefore matches transfer legs
 * and NEVER matches a plain agent call — which is precisely why, between
 * 2026-08-22 and 2026-08-25, Canvass Confirmation and Dispatch were the only
 * campaigns still fetching while 335-file folders reported as empty.
 *
 * == THIS IS NOT THE FIVE9 CALL ID. DO NOT JOIN ON IT. ==
 * Verified 2026-08-25 against all 20 rows that carried it, plus a direct
 * lookup:
 *
 *   filename tail   300000002864763   300000002864750   300000002866719
 *   five9_call_id   300000010289685   300000010289658   300000010296218
 *
 * Disjoint ranges, roughly 7.4 million apart, and raw_metadata.recordings_raw
 * carries only a timestamp and a duration, so nothing we store maps one space
 * to the other. The id is stored for provenance and for the day a mapping
 * exists; the join stays campaign + customer number + time.
 *
 * ci_calls.five9_session_id is declared and discovery.js already writes it; it
 * is populated on 0 rows because the saved Call Log report does not emit a
 * Session ID column. Adding that column is a REPORT CONFIG change, after which
 * this becomes testable:
 *
 *   SELECT count(*) FILTER (WHERE right(r.five9_recording_id, 15) = c.five9_session_id)
 *   FROM ci_recordings r JOIN ci_calls c ON c.id = r.call_id
 *   WHERE r.five9_recording_id IS NOT NULL AND c.five9_session_id IS NOT NULL;
 *
 * That is a HYPOTHESIS, not a finding.
 */

/** Exactly 15 digits ending the string — the id's tail in both shapes. */
const TAIL_DIGITS_RE = /(\d{15})$/;

/** Exactly 32 hex characters ending the string, after the tail is peeled. */
const HEX32_END_RE = /[0-9A-Fa-f]{32}$/;

/**
 * Split what follows the clock into an optional module and the session id.
 *
 * -- WHY IT PEELS FROM THE RIGHT INSTEAD OF SEARCHING FOR THE HEX RUN --
 * 'Find a 32-hex run' does not have one answer, and getting it wrong is
 * SILENT. The module can end in a hex character:
 *
 *   Transfer to LightfireB6A58CED4F5246238AAB0FCA8EFAF2D0300000002867137
 *                      ^ 'e' is a hex digit, so a lazy or leftmost scan
 *                        starts HERE and yields module 'Transfer to Lightfir'
 *
 * A truncated module is not a loud failure — it would silently miss
 * ci_transfer_target_map's exact-equality lookup and re-break classifyTeam.
 * Verified: a lazy /[0-9A-Fa-f]{32}[A-Za-z0-9._@-]*?\d{15}$/ does exactly this.
 *
 * So the boundary is not searched for. It is PEELED off the right in a fixed
 * order, using information we already hold:
 *
 *   1. take the trailing 15 digits
 *   2. take the agentUsername — which the caller parsed out of 'by {agent} @'
 *      and therefore KNOWS, so the token between hex and digits needs no
 *      guessing at all
 *   3. what remains must END in exactly 32 hex, or the name is unparseable
 *   4. anything before that is the module, introduced by its '_'
 *
 * Step 2 is why this is deterministic where a regex cannot be: the ambiguous
 * middle token is not inferred from shape, it is read from another field of
 * the same filename. An agent username containing digits ('mcole2321') or
 * punctuation ('c.garner@reecewindows.com') needs no special case.
 *
 * -- AND WHY IT STILL REFUSES --
 * If the remainder does not end in 32 hex, this returns null and the file is
 * COUNTED as unparseable (see createSftpAdapter's onStats) rather than guessed
 * at. That refusal is the feature: a parser that invents a shape hides the
 * next vendor change instead of surfacing it, which is how the 2026-08-22
 * break went unnoticed for three days.
 *
 * @param {string} rest what follows the clock
 * @param {string} agentUsername from 'by {agent} @' — '' on transfer legs
 * @returns {{ivrModule: string|null, sessionId: string|null}|null}
 */
function splitModuleAndSession(rest, agentUsername = '') {
  const tail = TAIL_DIGITS_RE.exec(rest);

  // No trailing digits: the OLD format's transfer leg — '_{module}' and
  // nothing else — which must keep parsing exactly as it always has. The
  // archive holds these back to ~Aug 2023 and the backfill reads them.
  if (!tail) {
    if (rest[0] !== '_') return null;
    const legacyModule = rest.slice(1).trim();
    return legacyModule ? { ivrModule: legacyModule, sessionId: null } : null;
  }

  const digits = tail[1];
  const withoutDigits = rest.slice(0, rest.length - digits.length);

  // Peel the agent token when the caller knows one AND it is actually there.
  // Both conditions matter: transfer legs have no agent, and a plain-agent
  // name has it immediately before the digits.
  const agent = String(agentUsername ?? '').trim();
  const hasAgentToken = agent.length > 0 && withoutDigits.endsWith(agent);
  const head = hasAgentToken
    ? withoutDigits.slice(0, withoutDigits.length - agent.length)
    : withoutDigits;

  // What is left MUST end in the 32-hex run, or we cannot read this name.
  if (!HEX32_END_RE.test(head)) return null;

  const before = head.slice(0, head.length - 32);

  // The id is stored verbatim as it appears in the filename — hex, the agent
  // token when present, and the digits — so provenance is exact and a future
  // mapping can be tested against the real string rather than a normalised one.
  const sessionId = rest.slice(before.length);

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
 * on the server ('Magazine - CLiPP' vs 'Magazine - Clipp').
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
 * The ETG-owned directory, untouched since Jan 2026. Skip it — it is not ours
 * and nothing in it is Five9 call audio.
 */
export const SKIP_DIRS = new Set(['Owner']);

export function isSkippedDir(dirName) {
  return SKIP_DIRS.has(String(dirName ?? '').trim());
}

/**
 * Should this file be ingested, or recorded as deliberately excluded?
 *
 * Excluded files are still ROWS — recorded with a reason, never silently
 * dropped, so reconciliation can tell 'we chose not to' from 'we missed it'.
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
