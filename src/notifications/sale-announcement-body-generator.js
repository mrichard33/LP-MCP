/**
 * Sale Announcements — message composer
 * src/notifications/sale-announcement-body-generator.js
 *
 * ONE question: what single sentence goes on the sales board for this sale?
 *
 * WHY THE PROMPT IS A FILE AND NOT A CONSTANT
 * -------------------------------------------
 * sale-announcement-rulebook.md is loaded from disk and its git blob sha is
 * logged on every run, so any message the floor sees can be traced to the exact
 * wording that produced it. The copy is read by the whole sales team; it gets
 * PR review, not a buried template literal and not a database row someone can
 * change at 11pm without a diff.
 *
 * The A-E structures in that file are ported verbatim from GHL workflow
 * 7f24f79d-3d93-4b62-bd24-074f9ade769a, Sold branch, step "Create
 * Congratulations Message". GroupMe keeps firing from that step through the
 * transition, so the two must not drift.
 *
 * WHY THIS NEVER THROWS
 * ---------------------
 * Unlike appointment-body-generator.js — whose throws are caught upstream and
 * turned into a 5xx so a GHL workflow timeout fires a fallback branch — there is
 * no fallback branch here. This runs AFTER the endpoint has already answered
 * GHL 200. A throw would mean a sale that silently never posted. So every
 * failure path lands on the static approved line in
 * content/fallbacks/sale-announcement.txt instead.
 *
 * WHY VALIDATION IS IN CODE AND NOT ONLY IN THE PROMPT
 * ---------------------------------------------------
 * Two classes of defect, handled differently on purpose:
 *
 *   HARD REJECT -> fallback. An unresolved merge tag, a literal "undefined", or
 *   one of the banned celebratory emoji. These are visibly broken or off-voice
 *   in a way the floor would notice, and a generic-but-correct line beats them.
 *
 *   WARN ONLY -> ship it. The banned WORD list ("amazing", "crushing it", ...).
 *   These are tone, not breakage. Discarding an otherwise good, specific message
 *   in favour of a generic one because it said "awesome" makes the board worse,
 *   not better. The warning is how we find out the prompt needs tightening.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { callLLM } from '../llm-client.js';
import { hasMilestone, monthWindowET } from './sale-facts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULEBOOK_PATH = path.join(HERE, 'sale-announcement-rulebook.md');
const FALLBACK_PATH = path.join(HERE, '..', '..', 'content', 'fallbacks', 'sale-announcement.txt');

/** Last-resort line if even the fallback FILE cannot be read. Names nobody. */
const HARDCODED_FALLBACK = '🛡️ Another Florida family protected. Nice work.';

const MAX_TOKENS = parseInt(process.env.SALE_ANNOUNCEMENT_MAX_TOKENS || '300', 10);
// 0.7 is the value the GHL step has used in production. Sonnet 5 and the other
// newer Anthropic families reject sampling parameters outright (hard 400) —
// llm-client.js strips and retries, so passing it here is safe and stays correct
// for whichever model the group is pointed at. Do NOT add a second guard.
const TEMPERATURE = parseFloat(process.env.SALE_ANNOUNCEMENT_TEMPERATURE || '0.7');

const CHAR_CAP = parseInt(process.env.SALE_ANNOUNCEMENT_CHAR_CAP || '320', 10);

/** From the rulebook's "Never use" line. Their presence is a hard reject. */
const BANNED_EMOJI = ['🎉', '🥳', '👏', '😍', '💯'];

/** From the rulebook's BANNED words line. Warn, never discard. */
const BANNED_WORDS = [
  'amazing', 'awesome', 'incredible', 'fantastic', 'great job',
  'killing it', 'crushing it', 'way to go', 'keep it up',
];

let cached = null;

/**
 * Git blob sha of a buffer — `sha1("blob <bytelen>\0" + content)`, the same id
 * `git hash-object` prints. Lets a log line be matched to a commit without
 * shelling out to git at runtime.
 */
export function gitBlobSha(buf) {
  const body = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  const header = Buffer.from(`blob ${body.length}\0`, 'utf8');
  return crypto.createHash('sha1').update(Buffer.concat([header, body])).digest('hex');
}

/** Read the rulebook once per process and remember its sha. */
export function loadRulebook(readFile = fs.readFileSync) {
  if (cached) return cached;
  const raw = readFile(RULEBOOK_PATH);
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  const text = buf.toString('utf8');
  // Everything above the "## SYSTEM PROMPT" heading is documentation for humans
  // — provenance, why the file exists, how to change it. Only what follows is
  // the model's instruction set.
  const marker = '## SYSTEM PROMPT';
  const idx = text.indexOf(marker);
  const system = (idx === -1 ? text : text.slice(idx + marker.length)).trim();
  cached = { system, sha: gitBlobSha(buf) };
  return cached;
}

/** TESTS ONLY — drop the memoized rulebook. */
export function __resetRulebookCache() {
  cached = null;
}

export function loadFallbackLine(readFile = fs.readFileSync) {
  try {
    const line = String(readFile(FALLBACK_PATH, 'utf8')).trim();
    return line || HARDCODED_FALLBACK;
  } catch {
    return HARDCODED_FALLBACK;
  }
}

function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return `$${Math.round(v).toLocaleString('en-US')}`;
}

/**
 * Is a rank climb one we can state out loud?
 *
 * 2026-09-17. A climb is only celebratory if it LANDS somewhere respectable.
 * The first live batch produced rank_climb {from: 50, to: 41} out of a field of
 * 50 — a genuine climb that begins at dead last. Any message using it tells the
 * floor exactly where that rep started, which is the one thing the rulebook's
 * comparison rule forbids. The model that day wrote "Biggest close of his year"
 * instead and the post read fine, but that was luck, not a guarantee, and a
 * guard we rely on the model to honour is not a guard.
 *
 * Top third of the field, with a floor of 3 so a small field still works.
 */
export function isCelebratableClimb(climb, field) {
  if (!climb || climb.to == null || climb.from == null) return false;
  if (climb.to >= climb.from) return false;
  if (!field || field < 2) return false;
  return climb.to <= Math.max(3, Math.ceil(field / 3));
}

/**
 * Render the FACTS block. Only facts the rulebook is allowed to use appear here
 * — nothing that could be read as a rep doing badly ever reaches the model, so
 * the comparison rule cannot be violated even by a model that ignores it.
 *
 * WHY THE MONTH TOTALS ARE NOT HERE (2026-09-17)
 * ----------------------------------------------
 * They used to be, and they were the whole problem. Fed "3 sales this month,
 * $36,300 total", the model dutifully reported it and produced:
 *
 *   🧱 Craig Barela closes another one — $1,500 today, $36,300 on the month.
 *
 * That is a ledger entry, not a celebration. Note that NONE of the ten examples
 * in the rulebook cite a month total — every one of them is the sale alone. So
 * sale-only was always the target style, and the bookkeeping was working against
 * it. The month numbers now go out as a threaded reply built by
 * formatStatsLine(); this block carries only what a person would actually cheer.
 *
 * Most sales will therefore return 'none', which routes to the rulebook's
 * "write the sale alone" path. That is correct, not a degradation.
 */
export function buildFactsBlock(facts) {
  if (!facts || facts.degraded) return 'none';

  const lines = [];

  if (isCelebratableClimb(facts.rank_climb, facts.rank_field)) {
    lines.push(`Moved up the month's volume board: ${facts.rank_climb.from} to ${facts.rank_climb.to}.`);
  } else if (facts.rank != null && facts.rank <= 3) {
    lines.push(`Currently ${facts.rank === 1 ? '1st' : facts.rank === 2 ? '2nd' : '3rd'} on the month's volume board.`);
  }

  if (facts.is_personal_record) {
    lines.push('This is their largest sale in the last twelve months.');
  }

  if (facts.notable_streak && facts.streak_days != null) {
    lines.push(`${facts.streak_days} consecutive days with a sale.`);
  }

  return lines.length ? lines.join('\n') : 'none';
}

/** Month name for the stats line. */
function monthName(date) {
  // Florida's calendar month, the same window the counts use (2026-09-25), so
  // "3 sales in September" never labels a count that has already rolled over.
  return monthWindowET(date).monthName;
}

/**
 * The rep's own month in one line: "📊 Tim O'Connor — 3 sales in September,
 * $36,300." The first line of the stats reply, and (2026-09-24) the opening
 * line of the market channel's office ranking post. Null when there is nothing
 * countable. Pure, never throws.
 */
export function formatRepMonthLine(repDisplayName, facts, now = new Date()) {
  if (!facts || facts.degraded) return null;

  const count = Number(facts.mtd_sale_count) || 0;
  if (count < 1) return null;

  const month = monthName(now);
  const vol = money(facts.mtd_volume);
  const noun = count === 1 ? 'sale' : 'sales';

  return `📊 ${repDisplayName} — ${count} ${noun} in ${month}` + (vol ? `, ${vol}.` : '.');
}

/**
 * The threaded stats reply — the numbers, kept out of the celebration.
 *
 * Pure and null-safe: degraded facts, or facts with nothing countable in them,
 * return null and the caller posts no reply. Never throws.
 */
export function formatStatsLine(repDisplayName, facts, now = new Date()) {
  const first = formatRepMonthLine(repDisplayName, facts, now);
  if (!first) return null;

  const team = money(facts.team_mtd_volume);
  return team ? `${first}\nTeam month to date: ${team}.` : first;
}

export function buildUserPrompt({ repDisplayName, saleAmount, facts }) {
  const amount = money(saleAmount) || String(saleAmount);
  return [
    'A sale was just closed.',
    `Rep: ${repDisplayName}`,
    `Amount: ${amount}`,
    '',
    'FACTS:',
    buildFactsBlock(facts),
    '',
    hasMilestone(facts)
      ? 'Structure F is available. So are A through E — rotate, do not default to F.'
      : 'Structure F is NOT available for this sale. Use one of A through E.',
    '',
    'Write ONE short motivational message (1-2 sentences max) for the sales board.',
  ].join('\n');
}

/** Strip markdown and surrounding quotes the prompt already forbids. */
export function cleanMessage(text) {
  let s = String(text ?? '').trim();
  s = s.replace(/^```(?:\w+)?\s*/i, '').replace(/```\s*$/, '').trim();
  // A model that wraps its whole answer in quotes despite being told not to.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('“') && s.endsWith('”'))) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/(^|\s)_(.+?)_(?=\s|$)/g, '$1$2');
  return s.replace(/\s*\n+\s*/g, ' ').trim();
}

/**
 * Decide whether a composed message may go on the board.
 * Returns { ok, reason, warnings }.
 */
export function validateMessage(text) {
  const warnings = [];
  const s = String(text ?? '');

  if (!s.trim()) return { ok: false, reason: 'empty', warnings };
  if (s.length > CHAR_CAP) return { ok: false, reason: `too_long:${s.length}`, warnings };
  // An unresolved merge tag or a stringified nothing means the input was broken
  // upstream; posting it tells the floor our system is broken.
  if (/\{\{|\}\}/.test(s)) return { ok: false, reason: 'unresolved_merge_tag', warnings };
  if (/\b(undefined|null|NaN)\b/.test(s)) return { ok: false, reason: 'null_leak', warnings };

  const badEmoji = BANNED_EMOJI.find((e) => s.includes(e));
  if (badEmoji) return { ok: false, reason: `banned_emoji:${badEmoji}`, warnings };

  const lower = s.toLowerCase();
  for (const w of BANNED_WORDS) {
    if (lower.includes(w)) warnings.push(`banned_word:${w}`);
  }

  return { ok: true, reason: null, warnings };
}

/**
 * Compose the announcement. Always returns
 * { text, source: 'llm' | 'fallback', model, rulebook_sha, reason }.
 * Never throws.
 */
export async function generateSaleAnnouncement(
  { repDisplayName, saleAmount, facts },
  deps = {},
) {
  const {
    llm = callLLM,
    readFile = fs.readFileSync,
    logger = console,
  } = deps;

  let rulebook;
  try {
    rulebook = loadRulebook(readFile);
  } catch (err) {
    logger.warn?.(`[SaleAnnounce] rulebook unreadable (${err.message}) — static fallback`);
    return {
      text: loadFallbackLine(readFile),
      source: 'fallback',
      model: null,
      rulebook_sha: null,
      reason: `rulebook_unreadable:${err.message}`,
    };
  }

  const user = buildUserPrompt({ repDisplayName, saleAmount, facts });

  let raw;
  let model = null;
  try {
    const res = await llm({
      fn: 'sale_announcement',
      system: rulebook.system,
      user,
      maxTokens: MAX_TOKENS,
      temperature: TEMPERATURE,
    });
    raw = res?.text;
    model = res?.model || null;
  } catch (err) {
    logger.warn?.(`[SaleAnnounce] compose failed (${err.message}) rulebook=${rulebook.sha} — static fallback`);
    return {
      text: loadFallbackLine(readFile),
      source: 'fallback',
      model: null,
      rulebook_sha: rulebook.sha,
      reason: `llm_failed:${err.message}`,
    };
  }

  const cleaned = cleanMessage(raw);
  const verdict = validateMessage(cleaned);

  if (!verdict.ok) {
    logger.warn?.(
      `[SaleAnnounce] composed message rejected (${verdict.reason}) ` +
      `model=${model} rulebook=${rulebook.sha} — static fallback`,
    );
    return {
      text: loadFallbackLine(readFile),
      source: 'fallback',
      model,
      rulebook_sha: rulebook.sha,
      reason: verdict.reason,
    };
  }

  if (verdict.warnings.length) {
    logger.warn?.(
      `[SaleAnnounce] composed with warnings [${verdict.warnings.join(', ')}] ` +
      `model=${model} rulebook=${rulebook.sha} — shipping anyway (tone, not breakage)`,
    );
  }

  logger.log?.(`[SaleAnnounce] composed model=${model} rulebook=${rulebook.sha} len=${cleaned.length}`);
  return { text: cleaned, source: 'llm', model, rulebook_sha: rulebook.sha, reason: null };
}
