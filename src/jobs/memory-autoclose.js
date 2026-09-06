/**
 * Pending-item auto-close — src/jobs/memory-autoclose.js  (2026-09-06)
 *
 * Pure module called by the nightly memory job (memory-nightly.js). Closes
 * claude_pending_items rows the way Mark ruled on 2026-09-06 (rules A–D
 * approved; rule F — age-only close of unfixed items — REJECTED and replaced
 * by a stale FLAG). "If it's not fixed, it stays open."
 *
 * MODE — MEMORY_AUTOCLOSE_MODE (off default → shadow → live), same flag
 * discipline as MEMORY_VECTOR_MODE:
 *   off     return immediately, log nothing.
 *   shadow  for each rule, SET would_close='<rule tag>' on the rows that would
 *           close. status untouched. Counts logged to claude_memory_autoclose_log.
 *   live    run the close UPDATEs; clear would_close on closed rows and on any
 *           row that no longer matches, so shadow leftovers don't linger.
 *
 * RULES — ordered; each excludes rows already matched by an earlier rule in
 * the same run. The PROTECTED SET is never touched by any rule, in any mode:
 *   item_type IN ('decision_needed','unconfirmed_decision','open_question','approval_needed')
 *
 *   A   next steps from sessions 30+ days old                → expired
 *   B   anything from a retro session 90+ days old           → expired
 *   C   exact-duplicate descriptions → older copies           → superseded (by newest open copy)
 *   D1  ref points at a resolved/duplicate claude_known_issue → done
 *   D2  description/ref names a "PR #n" that is merged        → done   (GitHub; skipped without a token)
 *       Ruling 2026-09-06 (Mark), after the first shadow run:
 *        (1) the repo is resolved from the item text — LP-MCP default;
 *            HL-MCP, Reece-Dashboard, GHL-Workflows, n8n when named (nearest
 *            mention wins). A row that names a repo the resolver does not
 *            know (e.g. "mrichard33/kiosk", "the foo repo") is SKIPPED.
 *        (2) the row closes only when the item is ABOUT SHIPPING that PR —
 *            merge / ship / deploy / awaiting merge, or the PR number is the
 *            object of the item (prIntent → 'ship'). A PR mentioned in
 *            passing ('mention') never closes: it keeps a would_close tag of
 *            D:pr_mentioned and goes into the Monday digest as
 *            "likely done — confirm".
 *        (3) the merge must have happened ON OR AFTER the item's session
 *            date: an item cannot be waiting on a PR that was already merged
 *            when the item was written, so an earlier merge means the number
 *            belongs to another repo or the item is follow-up work → skipped.
 *   STALE  open, not protected, untouched 120+ days           → stale=true (flag only, never a status)
 *
 * HOW THE SQL IS SHAPED. Every rule is a candidate SELECT (ids) followed by an
 * UPDATE ... WHERE id = ANY(ids). The run_sql RPC (sql/run_sql.sql) returns
 * only {status:'ok'} for a non-SELECT statement, so an UPDATE ... RETURNING
 * would give the job no counts and no sample ids; selecting first gives exact
 * numbers, makes shadow / live / dry-run share one WHERE clause per rule, and
 * avoids the CTE-first data-modifying statements the runner rejects. The
 * UPDATEs re-check status='open' so a row closed between the two statements
 * is left alone.
 *
 * Each rule writes one claude_memory_autoclose_log row (affected + up to 20
 * sample ids). The stale flag is cleared only by verified_at (set by the
 * memory_checkpoint verified/close paths) — never by activity, never here.
 */

export const AUTOCLOSE_MODES = new Set(['off', 'shadow', 'live']);
export const PROTECTED_ITEM_TYPES = Object.freeze(['decision_needed', 'unconfirmed_decision', 'open_question', 'approval_needed']);
export const PROTECTED_LIST_SQL = `('decision_needed','unconfirmed_decision','open_question','approval_needed')`;
export const D2_REPO = 'mrichard33/LP-MCP';
export const SAMPLE_LIMIT = 20;

const A_DAYS = 30;
const B_DAYS = 90;
const STALE_DAYS = 120;

/** NULL-safe protected-set exclusion (373 migrated rows have item_type NULL — they are NOT protected). */
export function protectedClause(alias = '') {
  const col = alias ? `${alias}.item_type` : 'item_type';
  return `coalesce(${col},'') NOT IN ${PROTECTED_LIST_SQL}`;
}
const age = (alias = '') => `coalesce(${alias ? `${alias}.` : ''}session_date, ${alias ? `${alias}.` : ''}created_at::date)`;

// ─── Candidate SELECTs (one per rule; shared by shadow, live and dry-run) ──
export const RULE_A_SELECT = `
SELECT id FROM claude_pending_items
WHERE status='open' AND kind='next_step'
  AND ${age()} < current_date - ${A_DAYS}
  AND ${protectedClause()}
ORDER BY id`;

export const RULE_B_SELECT = `
SELECT id FROM claude_pending_items
WHERE status='open' AND origin='retro'
  AND ${age()} < current_date - ${B_DAYS}
  AND ${protectedClause()}
ORDER BY id`;

// Partition over ALL open rows (a protected row may be the newest copy and
// therefore the keeper); only non-protected older copies are closed.
export const RULE_C_SELECT = `
SELECT id, keep_id FROM (
  SELECT id, item_type,
         first_value(id) OVER (PARTITION BY lower(regexp_replace(description,'\\s+',' ','g'))
                               ORDER BY ${age()} DESC, id DESC) AS keep_id
  FROM claude_pending_items WHERE status='open'
) r
WHERE r.id <> r.keep_id AND ${protectedClause('r')}
ORDER BY id`;

export const RULE_D1_SELECT = `
SELECT p.id FROM claude_pending_items p
JOIN claude_known_issues i
  ON i.id = (CASE WHEN p.ref ~ '^#?\\d+$' THEN substring(p.ref from '\\d+')::int END)
WHERE p.status='open'
  AND i.status IN ('resolved','duplicate')
  AND ${protectedClause('p')}
ORDER BY p.id`;

// Only the "PR #123" form counts. Bare "PR 5" / "PR1" in this table are project
// phase labels, not GitHub PRs, and would match ancient merged PRs.
export const RULE_D2_SELECT = `
SELECT id, item_type, description, ref, coalesce(session_date, created_at::date)::text AS session_date
FROM claude_pending_items
WHERE status='open'
  AND (description ~* 'PR\\s*#\\s*\\d+' OR ref ~* 'PR\\s*#\\s*\\d+')
  AND ${protectedClause()}
ORDER BY id`;

export const RULE_STALE_SELECT = `
SELECT id FROM claude_pending_items
WHERE status='open' AND stale=false
  AND (verified_at IS NULL OR verified_at < now() - interval '${STALE_DAYS} days')
  AND ${age()} < current_date - ${STALE_DAYS}
  AND ${protectedClause()}
ORDER BY id`;

export const AUTOCLOSE_RULES = Object.freeze([
  { rule: 'A',     tag: 'A:next_step_30d',   status: 'expired',    select: RULE_A_SELECT },
  { rule: 'B',     tag: 'B:retro_90d',       status: 'expired',    select: RULE_B_SELECT },
  { rule: 'C',     tag: 'C:duplicate',       status: 'superseded', select: RULE_C_SELECT },
  { rule: 'D',     tag: 'D:issue_resolved',  status: 'done',       select: RULE_D1_SELECT },
  { rule: 'D',     tag: 'D:pr_merged',       status: 'done',       select: RULE_D2_SELECT, github: true, mention_tag: 'D:pr_mentioned' },
  { rule: 'STALE', tag: 'STALE:untouched_120d', status: null,      select: RULE_STALE_SELECT, flag: 'stale' },
]);

// ─── UPDATE builders (ids are integers validated before interpolation) ─────
const idList = (ids) => `ARRAY[${ids.map((n) => Number(n)).filter(Number.isInteger).join(',')}]::int[]`;
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** shadow: tag only. Does not bump updated_at — the shadow column is not activity. */
export function shadowSql(tag, ids) {
  return `UPDATE claude_pending_items SET would_close=${q(tag)}
WHERE status='open' AND id = ANY(${idList(ids)}) AND would_close IS DISTINCT FROM ${q(tag)}`;
}

/** live: close. would_close is cleared on the same row. */
export function closeSql(tag, status, ids) {
  return `UPDATE claude_pending_items
SET status=${q(status)}, closed_by='nightly', closed_reason=${q(tag)}, closed_at=now(), would_close=NULL, updated_at=now()
WHERE status='open' AND id = ANY(${idList(ids)})`;
}

/** live, rule C: close + point at the keeper. */
export function supersedeSql(tag, pairs) {
  const values = pairs.map(({ id, keep_id }) => `(${Number(id)},${Number(keep_id)})`).join(',');
  return `UPDATE claude_pending_items p
SET status='superseded', superseded_by=v.keep_id, closed_by='nightly', closed_reason=${q(tag)}, closed_at=now(), would_close=NULL, updated_at=now()
FROM (VALUES ${values}) AS v(id, keep_id)
WHERE p.id = v.id AND p.status='open'`;
}

/** live, STALE: flag only. Never touches status. */
export function staleFlagSql(ids) {
  return `UPDATE claude_pending_items SET stale=true, would_close=NULL, updated_at=now()
WHERE status='open' AND stale=false AND id = ANY(${idList(ids)})`;
}

/** shadow + live: drop tags on rows that no longer match any rule this run. */
export function clearWouldCloseSql(keepIds) {
  const keep = keepIds.length ? ` AND NOT (id = ANY(${idList(keepIds)}))` : '';
  return `UPDATE claude_pending_items SET would_close=NULL WHERE would_close IS NOT NULL${keep}`;
}

export function logSql({ mode, rule, affected, sample_ids = [], notes = null }) {
  const ids = sample_ids.length ? `ARRAY[${sample_ids.map(Number).filter(Number.isInteger).join(',')}]::integer[]` : 'NULL';
  return `INSERT INTO claude_memory_autoclose_log (mode, rule, affected, sample_ids, notes)
VALUES (${q(mode)}, ${q(rule)}, ${Number(affected) || 0}, ${ids}, ${notes == null ? 'NULL' : q(notes)})`;
}

// ─── Rule D2 helpers ───────────────────────────────────────────────────────
const PR_RE = /\bPR\s*#\s*(\d{1,6})\b/gi;

/** Repos a pending item can name. Order matters only for the default (first). */
export const KNOWN_REPOS = Object.freeze([
  { repo: 'mrichard33/LP-MCP',          re: /\bLP[-_ ]?MCP\b/gi },
  { repo: 'mrichard33/HL-MCP',          re: /\bHL[-_ ]?MCP\b/gi },
  { repo: 'mrichard33/Reece-Dashboard', re: /\b(?:reece[-_ ]?)?dashboard\b/gi },
  { repo: 'mrichard33/GHL-Workflows',   re: /\bGHL[-_ ]?Workflows\b/gi },
  { repo: 'mrichard33/n8n',             re: /\bn8n\b/gi },
]);

const rowText = (row) => `${row.description || ''} ${row.ref || ''}`;

// Repo names the resolver cannot map: "mrichard33/<x>", "<x> repo", "the <x> repository", "repo <x>".
const REPO_NAME_RE = /\bmrichard33\/([\w.-]+)|\b(?:the\s+)?([\w.-]+)\s+(?:repo|repository)\b|\b(?:repo|repository)\s+[`"']?([\w.-]+)/gi;
const REPO_STOPWORDS = new Set(['this', 'that', 'same', 'other', 'each', 'the', 'a', 'in', 'to', 'of', 'on', 'its', 'our', 'new', 'any', 'right', 'wrong', 'correct', 'github', 'git']);

/**
 * Repo names in the text that are NOT one of KNOWN_REPOS. A non-empty list
 * means "names a repo we can't resolve" → the row is skipped. Exported for tests.
 */
export function unresolvedReposIn(row) {
  const text = rowText(row);
  const out = new Set();
  for (const m of text.matchAll(REPO_NAME_RE)) {
    const name = (m[1] || m[2] || m[3] || '').trim();
    if (!name || REPO_STOPWORDS.has(name.toLowerCase())) continue;
    if (KNOWN_REPOS.some(({ re }) => { re.lastIndex = 0; const hit = re.test(name); re.lastIndex = 0; return hit; })) continue;
    out.add(name);
  }
  return [...out];
}

const AFTER_WINDOW = 40; // "PR #12 to the Reece Dashboard" counts; a repo named a sentence later does not

/**
 * Distinct { repo, number } refs named as "PR #n" in a row's description + ref.
 * Repo = the nearest repo mention BEFORE the PR token; else one within 40
 * chars AFTER it; else LP-MCP. Exported for tests.
 */
export function prRefsIn(row) {
  const text = rowText(row);
  const mentions = [];
  for (const { repo, re } of KNOWN_REPOS) for (const m of text.matchAll(re)) mentions.push({ repo, at: m.index });
  const resolve = (at) => {
    let best = null;
    for (const m of mentions) {
      let d;
      if (m.at <= at) d = at - m.at;                                   // any "before" beats any "after"
      else if (m.at - at <= AFTER_WINDOW) d = (m.at - at) + 100000;
      else continue;
      if (!best || d < best.d) best = { repo: m.repo, d };
    }
    return best ? best.repo : D2_REPO;
  };
  const seen = new Set();
  const out = [];
  for (const m of text.matchAll(PR_RE)) {
    const ref = { repo: resolve(m.index), number: Number(m[1]) };
    const key = `${ref.repo}#${ref.number}`;
    if (!seen.has(key)) { seen.add(key); out.push(ref); }
  }
  return out;
}

/** Back-compat: distinct PR numbers only. */
export function prNumbersIn(row) { return [...new Set(prRefsIn(row).map((r) => r.number))]; }

// ─── Shipping intent ───────────────────────────────────────────────────────
// 'ship'    the item is about getting the PR merged / deployed — closing it
//           when the PR is merged is right.
// 'mention' the PR is context (verify after it merges, ask about it, rows it
//           did not fix…) — the merge does not finish the item.
const SHIP_WORDS = /\b(merge[sd]?|merging|ship(?:ped|s)?|shipping|deploy(?:ed|s|ing|ment)?|land(?:ed|s|ing)?|release[sd]?|releasing|close\s+PR\b|awaiting\s+(?:\w+(?:'s)?\s+){0,2}(?:review|merge|approval|deploy)|needs?\s+(?:a\s+)?(?:merge|deploy|review)|ready\s+(?:to|for)\s+(?:merge|deploy)|open\s+on\s+\w+\s*->\s*\w+|approve[sd]?|approval)\b/i;
const NON_SHIP_LEAD = /^\W*(?:verify|confirm|check|test|ask|decide|investigate|answer|ensure|validate|monitor|measure|compare|re-?run|document|explain|read|analy[sz]e|audit|watch|track|review\s+(?:the\s+)?(?:output|results?|logs?|data)|follow\s*up|remember|note|record|update|fix|add|build|write|migrate|backfill|close\s+(?!pr\b)|rule\s+on|decide|why|whether|what|how)\b/i;
const SHIP_ITEM_TYPES = /merge|deploy|dev_pr|ship|release/i;
// Items typed as verification / review / questions are about confirming, not shipping.
const NON_SHIP_ITEM_TYPES = /verif|question|decision|confirm|check|audit|review|investigat|analys|test/i;
// Phrases that say the PR should NOT be merged, or that it did not finish the work.
const NON_SHIP_ANYWHERE = /\bclose\s+PR\s*#\s*\d+\s+unmerged\b|\bwithout merging\b|\bdo not merge\b|\bdon'?t merge\b|\bnot rolled back\b|\bstill unapplied\b/i;
// The PR number is the object of the item: it opens the text (at most a few words before it).
const OBJECT_RE = /^\W*(?:\w+\W+){0,3}PR\s*#\s*\d+/i;
const SHIP_WINDOW = 60;

/**
 * 'ship' | 'mention'. Ship when the item is about getting the PR merged or
 * deployed: a shipping item_type, or a ship word BEFORE the PR token (within
 * 60 chars), or the PR is the item's subject (opens the text) with a ship word
 * anywhere. A ship word only AFTER the token ("(PR #866, merged 09-06) fills
 * it") is past-tense context, not intent. Exported for tests.
 */
export function prIntent(row) {
  const text = rowText(row).replace(/\s+/g, ' ').trim();
  if (row.item_type && SHIP_ITEM_TYPES.test(row.item_type)) return 'ship';
  if (row.item_type && NON_SHIP_ITEM_TYPES.test(row.item_type)) return 'mention';
  if (NON_SHIP_LEAD.test(text) || NON_SHIP_ANYWHERE.test(text)) return 'mention';
  const tokens = [...text.matchAll(PR_RE)];
  if (!tokens.length) return 'mention';
  for (const m of tokens) {
    const before = text.slice(Math.max(0, m.index - SHIP_WINDOW), m.index + m[0].length);
    if (SHIP_WORDS.test(before)) return 'ship';
  }
  if (OBJECT_RE.test(text) && SHIP_WORDS.test(text)) return 'ship';
  return 'mention';
}

export function githubTokenPresent(env = process.env) {
  return Boolean(env.GITHUB_PAT || env.GITHUB_TOKEN);
}

/** GET /repos/:repo/pulls/:n → { merged_at } | null (404). Throws on other errors. */
async function defaultFetchPR(n, repo = D2_REPO, env = process.env) {
  const token = env.GITHUB_PAT || env.GITHUB_TOKEN;
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${n}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${repo} PR #${n}`);
  const j = await res.json();
  return { merged_at: j.merged_at || null };
}

/** True when the PR merged on or after the item's session date (UTC date of merged_at vs YYYY-MM-DD). */
export function mergedAfterSession(merged_at, session_date) {
  if (!merged_at) return false;
  if (!session_date) return true;
  return String(merged_at).slice(0, 10) >= String(session_date).slice(0, 10);
}

/**
 * Classify rows whose named PRs are ALL merged on or after the row's session
 * date: `ids` (intent 'ship' → close) and `mention` (intent 'mention' → tag
 * D:pr_mentioned, digest, never close). Rows naming an unresolvable repo,
 * unknown PRs (404), lookup errors and merges that predate the item are
 * skipped. One GitHub call per distinct repo+number per run (cached).
 * fetchPR(number, repo) → { merged_at } | null.
 */
export async function mergedPrRows(rows, fetchPR) {
  const cache = new Map();
  const errors = new Map();
  const lookup = async ({ repo, number }) => {
    const key = `${repo}#${number}`;
    if (!cache.has(key)) {
      cache.set(key, Promise.resolve().then(() => fetchPR(number, repo)).then((r) => (r && r.merged_at) || null)
        .catch((err) => { errors.set(key, err.message); return null; }));
    }
    return cache.get(key);
  };
  const ids = [];
  const mention = [];
  let too_early = 0;
  let unresolved = 0;
  for (const row of rows) {
    if (unresolvedReposIn(row).length) { unresolved++; continue; }
    const refs = prRefsIn(row);
    if (!refs.length) continue;
    const mergedAts = await Promise.all(refs.map(lookup));
    if (!mergedAts.every(Boolean)) continue;
    if (!mergedAts.every((m) => mergedAfterSession(m, row.session_date))) { too_early++; continue; }
    (prIntent(row) === 'ship' ? ids : mention).push(row.id);
  }
  return { ids, mention, checked: cache.size - errors.size, too_early, unresolved, errors: [...errors.entries()].map(([k, v]) => `${k}: ${v}`) };
}

// ─── Runner ────────────────────────────────────────────────────────────────
function normaliseMode(mode) {
  const m = String(mode || 'off').toLowerCase().trim();
  if (!AUTOCLOSE_MODES.has(m)) { console.warn(`[MemoryAutoclose] unknown MEMORY_AUTOCLOSE_MODE=${mode} — treating as off`); return 'off'; }
  return m;
}

const rowsOf = (r) => (Array.isArray(r) ? r : []);

/**
 * @param {Object} opts
 * @param {string}  opts.mode     off | shadow | live
 * @param {boolean} opts.dry_run  count only; no UPDATE, no log row (GitHub reads still happen for D2)
 * @param {Object}  opts.deps     { runSQL, fetchPR, env }
 * @returns {{ mode, dry_run, rules: {tag: {affected, sample_ids, skipped?}}, matched, errors }}
 */
export async function runAutoclose({ mode = process.env.MEMORY_AUTOCLOSE_MODE, dry_run = false, deps = {} } = {}) {
  const m = normaliseMode(mode);
  const result = { mode: m, dry_run, rules: {}, matched: 0, errors: [] };
  if (m === 'off') return result;

  const sql = deps.runSQL;
  if (typeof sql !== 'function') throw new Error('runAutoclose: deps.runSQL required');
  const env = deps.env || process.env;
  const fetchPR = deps.fetchPR || ((n, repo) => defaultFetchPR(n, repo, env));
  const seen = new Set();          // ids matched earlier this run (rule ordering)
  const matchedAll = [];           // every id tagged/closed this run (shadow: keep all tags)
  const keepTagged = [];           // ids whose tag survives a LIVE run (D:pr_mentioned)

  for (const r of AUTOCLOSE_RULES) {
    const entry = { affected: 0, sample_ids: [] };
    result.rules[r.tag] = entry;
    try {
      if (r.github && !githubTokenPresent(env)) { entry.skipped = 'no GITHUB_PAT/GITHUB_TOKEN'; continue; }
      let rows = rowsOf(await sql(r.select)).filter((row) => Number.isInteger(row.id) && !seen.has(row.id));
      if (r.github) {
        const d2 = await mergedPrRows(rows, fetchPR);
        entry.prs_checked = d2.checked;
        entry.merged_before_item = d2.too_early;
        entry.unresolved_repo = d2.unresolved;
        if (d2.errors.length) entry.lookup_errors = d2.errors.slice(0, 5);
        // Passing mentions: tag (both modes), never close, surface in the digest.
        const mentionEntry = { affected: d2.mention.length, sample_ids: d2.mention.slice(0, SAMPLE_LIMIT), closes: false };
        result.rules[r.mention_tag] = mentionEntry;
        d2.mention.forEach((id) => seen.add(id));
        matchedAll.push(...d2.mention); keepTagged.push(...d2.mention);
        if (!dry_run) {
          if (d2.mention.length) await sql(shadowSql(r.mention_tag, d2.mention));
          await sql(logSql({ mode: m, rule: r.rule, affected: d2.mention.length, sample_ids: mentionEntry.sample_ids, notes: r.mention_tag }));
        }
        const keep = new Set(d2.ids);
        rows = rows.filter((row) => keep.has(row.id));
      }
      const ids = rows.map((row) => row.id);
      ids.forEach((id) => seen.add(id));
      matchedAll.push(...ids);
      entry.affected = ids.length;
      entry.sample_ids = ids.slice(0, SAMPLE_LIMIT);
      if (dry_run || !ids.length) {
        if (!dry_run) await sql(logSql({ mode: m, rule: r.rule, affected: 0, notes: r.tag }));
        continue;
      }
      if (m === 'shadow') {
        await sql(shadowSql(r.tag, ids));
      } else if (r.flag === 'stale') {
        await sql(staleFlagSql(ids));
      } else if (r.rule === 'C') {
        await sql(supersedeSql(r.tag, rows.map(({ id, keep_id }) => ({ id, keep_id }))));
      } else {
        await sql(closeSql(r.tag, r.status, ids));
      }
      await sql(logSql({ mode: m, rule: r.rule, affected: ids.length, sample_ids: entry.sample_ids, notes: r.tag }));
    } catch (err) {
      entry.error = err.message;
      result.errors.push(`${r.tag}: ${err.message}`);
    }
  }

  result.matched = matchedAll.length;
  if (!dry_run) {
    try { await sql(clearWouldCloseSql(m === 'live' ? keepTagged : matchedAll)); }
    catch (err) { result.errors.push(`clear_would_close: ${err.message}`); }
  }
  return result;
}
