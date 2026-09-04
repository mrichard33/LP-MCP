// ─── GitHub PR Read + Overlap MCP Tools ──────────────────────────
//
// The GitHub wrappers in github-tools.js are WRITE-CAPABLE for pull
// requests (github_create_pull_request and its three cross-repo
// mirrors) but have no way to READ one back. There is no way to ask
// "what is open right now", and no way to ask "do these two open PRs
// touch the same file". Both questions had to be answered by hand,
// out of band, or not at all.
//
// This module adds the read half, for every repo in the stack:
//
//   github_list_pull_requests      — what is open (or closed, or all)
//   github_get_pull_request_files  — which files one PR touches
//   github_check_pr_overlap        — which open PRs collide, pairwise
//   github_list_branches           — own-repo branches, backups filtered
//
// WHY github_list_branches is here and not in github-tools.js: LP-MCP
// never had an own-repo branch lister at all (only dashboard_, hl_ and
// n8n_ mirrors). It is added here rather than there so github-tools.js
// needs no edit, and it fixes two defects the mirrors have:
//
//   1. THEY DO NOT PAGINATE. `?per_page=100` and nothing else, so a
//      repo with more than 100 refs returns a silently short list with
//      no indication it was cut. LP-MCP has ~93 daily `bk-MM-DD-YYYY`
//      backup branches, which consume the page and truncate the list
//      alphabetically partway through `claude/*` — main and every
//      `feat/*` and `fix/*` branch fall off the end and are invisible.
//   2. THEY DO NOT FILTER. The backup branches are noise for every
//      question anyone actually asks of this tool.
//
// Backups are excluded by default and counted separately, so the
// number is still visible without costing 93 slots. include_backups
// brings them back. Pagination runs to exhaustion and reports
// `truncated: true` if it hits the page cap rather than going quiet.
//
// All tools are READ-ONLY. No confirm flag, because nothing here can
// change the repo.

import { z } from 'zod';
import {
  ghRequest,
  getDashboardRepo,
  getHlRepo,
  getN8nRepo,
} from '../../admin/github-client.js';

// GHL-Workflows has no getter in github-client.js (nothing wrote to it
// from this service). Defined locally so adding read access here does
// not require editing that file.
const getGhlWorkflowsRepo = () =>
  process.env.GHL_WORKFLOWS_GITHUB_REPO || 'mrichard33/GHL-Workflows';

const REPO_CHOICES = ['lp', 'dashboard', 'hl', 'n8n', 'ghl-workflows'];

// Returns null for 'lp' so ghRequest falls through to GITHUB_REPO,
// which is how every own-repo call in github-tools.js already works.
const resolveRepo = (key) => {
  switch (key) {
    case 'dashboard': return getDashboardRepo();
    case 'hl': return getHlRepo();
    case 'n8n': return getN8nRepo();
    case 'ghl-workflows': return getGhlWorkflowsRepo();
    case 'lp':
    default: return null;
  }
};

const repoLabel = (key) => resolveRepo(key) || process.env.GITHUB_REPO || 'lp (GITHUB_REPO)';

const PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 10;

// Page until a SHORT page proves the set is exhausted. A full page is
// never evidence of completion — that is the off-by-one that silently
// truncates at exact multiples of the page size. If the cap is hit,
// the caller is told.
const ghPaged = async (basePath, repo, maxPages = DEFAULT_MAX_PAGES) => {
  const out = [];
  let truncated = false;

  for (let page = 1; page <= maxPages; page++) {
    const sep = basePath.includes('?') ? '&' : '?';
    const data = await ghRequest(
      'GET',
      `${basePath}${sep}per_page=${PER_PAGE}&page=${page}`,
      null,
      repo
    );
    if (!Array.isArray(data) || data.length === 0) break;
    out.push(...data);
    if (data.length < PER_PAGE) break;
    if (page === maxPages) truncated = true;
  }

  return { items: out, truncated };
};

const BACKUP_BRANCH_RE = /^bk-\d{2}-\d{2}-\d{4}$/i;

// Exported for test. Deliberately anchored and exact-width: a branch
// genuinely named "bk-fix/something" or "backfill-x" is real work and
// must NOT be swallowed by the backup filter.
export const isBackupBranch = (name) => BACKUP_BRANCH_RE.test(name || '');

// Exported for test. Pure pairwise intersection over
// [{ pr, files: Set<string> }] — no network, no GitHub shapes beyond
// the number/title/head already projected by shapePr.
export const computeOverlaps = (fileSets) => {
  const collisions = [];
  for (let i = 0; i < fileSets.length; i++) {
    for (let j = i + 1; j < fileSets.length; j++) {
      const a = fileSets[i];
      const b = fileSets[j];
      const shared = [...a.files].filter((f) => b.files.has(f));
      if (shared.length > 0) {
        collisions.push({
          pr_a: { number: a.pr.number, title: a.pr.title, head: a.pr.head },
          pr_b: { number: b.pr.number, title: b.pr.title, head: b.pr.head },
          shared_file_count: shared.length,
          shared_files: shared.sort(),
        });
      }
    }
  }
  collisions.sort((x, y) => y.shared_file_count - x.shared_file_count);

  const collided = new Set();
  for (const c of collisions) {
    collided.add(c.pr_a.number);
    collided.add(c.pr_b.number);
  }
  const clean = fileSets
    .filter((s) => !collided.has(s.pr.number))
    .map((s) => ({ number: s.pr.number, title: s.pr.title, files: s.files.size }));

  return { collisions, clean };
};

const shapePr = (p) => ({
  number: p.number,
  title: p.title,
  state: p.state,
  draft: p.draft === true,
  head: p.head?.ref,
  base: p.base?.ref,
  author: p.user?.login,
  created_at: p.created_at,
  updated_at: p.updated_at,
  url: p.html_url,
});

export function registerGitHubPrTools(server) {

  // ─── github_list_pull_requests [READ] ──────────────────────────
  server.tool(
    'github_list_pull_requests',
    'List pull requests in any repo in the stack. Defaults to OPEN PRs in the LP MCP repo. This is the read half of github_create_pull_request — use it before opening a PR to see what is already in flight.',
    {
      repo: z.enum(REPO_CHOICES).optional()
        .describe('Which repo (default: "lp"). One of: lp, dashboard, hl, n8n, ghl-workflows'),
      state: z.enum(['open', 'closed', 'all']).optional()
        .describe('PR state (default: "open")'),
      base: z.string().optional()
        .describe('Only PRs targeting this base branch. Example: "main"'),
      limit: z.number().optional()
        .describe('Max PRs to return (default 50, max 300)'),
    },
    async ({ repo, state, base, limit }) => {
      const repoKey = repo || 'lp';
      const target = resolveRepo(repoKey);
      const prState = state || 'open';
      const cap = Math.min(limit || 50, 300);

      let path = `/pulls?state=${prState}&sort=updated&direction=desc`;
      if (base) path += `&base=${encodeURIComponent(base)}`;

      const { items, truncated } = await ghPaged(path, target, 3);
      const prs = items.slice(0, cap).map(shapePr);

      return {
        content: [{ type: 'text', text: JSON.stringify({
          repo: repoLabel(repoKey),
          state: prState,
          count: prs.length,
          total_fetched: items.length,
          truncated: truncated || items.length > cap,
          pull_requests: prs,
        }, null, 2) }],
      };
    }
  );

  // ─── github_get_pull_request_files [READ] ──────────────────────
  server.tool(
    'github_get_pull_request_files',
    'List the files a single pull request changes, with per-file status and line counts. Use to judge review scope, or to check by hand whether one PR touches the same files as another.',
    {
      number: z.number().describe('Pull request number. Example: 825'),
      repo: z.enum(REPO_CHOICES).optional()
        .describe('Which repo (default: "lp")'),
    },
    async ({ number, repo }) => {
      if (!number) {
        return { content: [{ type: 'text', text: 'Error: number is required.' }] };
      }
      const repoKey = repo || 'lp';
      const target = resolveRepo(repoKey);

      const pr = await ghRequest('GET', `/pulls/${number}`, null, target);
      const { items, truncated } = await ghPaged(`/pulls/${number}/files`, target, 5);

      const files = items.map((f) => ({
        path: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        previous_path: f.previous_filename,
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify({
          repo: repoLabel(repoKey),
          number,
          title: pr.title,
          state: pr.state,
          head: pr.head?.ref,
          base: pr.base?.ref,
          // mergeable is computed async by GitHub; null means "not ready
          // yet", which is NOT the same as "will not merge". Reported as-is
          // rather than coerced to a boolean.
          mergeable: pr.mergeable,
          mergeable_state: pr.mergeable_state,
          changed_files: pr.changed_files,
          files_listed: files.length,
          truncated,
          files,
        }, null, 2) }],
      };
    }
  );

  // ─── github_check_pr_overlap [READ] ────────────────────────────
  //
  // The question this exists to answer: "do the open PRs clash?"
  //
  // Two PRs that touch no common file cannot conflict textually. Two
  // that share a file are the pair worth reading before merging both.
  // That is the signal reported here — SHARED FILES, pairwise, named.
  //
  // Deliberately NOT reported as a merge verdict. GitHub's own
  // `mergeable` flag is computed against main as it stands right now,
  // so it goes stale the moment any sibling PR merges, and it says
  // nothing about semantic collisions (two PRs editing different lines
  // of the same function still both "merge"). Shared files is the
  // honest signal: it flags what to look at, and does not pretend to
  // rule.
  //
  // Cost: 1 + N API calls for N open PRs. Bounded by max_prs.
  server.tool(
    'github_check_pr_overlap',
    'Check whether the OPEN pull requests in a repo touch the same files. Returns every pair of open PRs sharing at least one file, with the shared paths named, plus the PRs that overlap with nothing. Use before merging a batch of PRs.',
    {
      repo: z.enum(REPO_CHOICES).optional()
        .describe('Which repo (default: "lp")'),
      base: z.string().optional()
        .describe('Only consider PRs targeting this base branch (default: "main")'),
      max_prs: z.number().optional()
        .describe('Max open PRs to inspect, newest-updated first (default 25, max 50). One API call per PR.'),
      include_drafts: z.boolean().optional()
        .describe('Include draft PRs (default: true)'),
    },
    async ({ repo, base, max_prs, include_drafts }) => {
      const repoKey = repo || 'lp';
      const target = resolveRepo(repoKey);
      const targetBase = base || 'main';
      const cap = Math.min(max_prs || 25, 50);
      const wantDrafts = include_drafts !== false;

      const { items } = await ghPaged(
        `/pulls?state=open&base=${encodeURIComponent(targetBase)}&sort=updated&direction=desc`,
        target,
        3
      );

      const candidates = items
        .filter((p) => (wantDrafts ? true : p.draft !== true))
        .slice(0, cap);

      if (candidates.length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            repo: repoLabel(repoKey),
            base: targetBase,
            open_prs: 0,
            verdict: 'No open pull requests. Nothing to clash.',
          }, null, 2) }],
        };
      }

      // Fetch the file list for each candidate.
      const fileSets = [];
      for (const p of candidates) {
        const { items: fileRows, truncated } = await ghPaged(
          `/pulls/${p.number}/files`,
          target,
          5
        );
        fileSets.push({
          pr: shapePr(p),
          files: new Set(fileRows.map((f) => f.filename)),
          truncated,
        });
      }

      const { collisions, clean } = computeOverlaps(fileSets);

      const partial = fileSets.filter((s) => s.truncated).map((s) => s.pr.number);

      return {
        content: [{ type: 'text', text: JSON.stringify({
          repo: repoLabel(repoKey),
          base: targetBase,
          open_prs: fileSets.length,
          inspected_cap: cap,
          more_open_than_inspected: items.length > candidates.length,
          colliding_pairs: collisions.length,
          collisions,
          no_overlap: clean,
          // A truncated file list means the overlap answer for that PR is
          // a LOWER BOUND — it may share more than reported. Said out loud
          // rather than left to look complete.
          partial_file_lists: partial,
          note: 'Shared files flag pairs worth reading before merging both. It is not a merge verdict: PRs sharing no file cannot conflict textually, but PRs sharing a file may still merge cleanly.',
        }, null, 2) }],
      };
    }
  );

  // ─── github_list_branches [READ] ───────────────────────────────
  server.tool(
    'github_list_branches',
    'List branches in any repo in the stack, excluding the daily bk-MM-DD-YYYY backup branches by default and paginating past the 100-branch page limit. LP-MCP had no own-repo branch lister before this.',
    {
      repo: z.enum(REPO_CHOICES).optional()
        .describe('Which repo (default: "lp")'),
      include_backups: z.boolean().optional()
        .describe('Include daily bk-MM-DD-YYYY backup branches (default: false)'),
      contains: z.string().optional()
        .describe('Only branches whose name contains this substring, case-insensitive. Example: "fix/"'),
    },
    async ({ repo, include_backups, contains }) => {
      const repoKey = repo || 'lp';
      const target = resolveRepo(repoKey);

      const { items, truncated } = await ghPaged('/branches', target, 10);

      const all = items.map((b) => ({
        name: b.name,
        sha: b.commit?.sha?.substring(0, 7),
        protected: b.protected,
      }));

      const backups = all.filter((b) => isBackupBranch(b.name));
      let branches = include_backups === true
        ? all
        : all.filter((b) => !isBackupBranch(b.name));

      if (contains) {
        const needle = contains.toLowerCase();
        branches = branches.filter((b) => b.name.toLowerCase().includes(needle));
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({
          repo: repoLabel(repoKey),
          total_branches: all.length,
          backup_branches_excluded: include_backups === true ? 0 : backups.length,
          count: branches.length,
          truncated,
          branches,
        }, null, 2) }],
      };
    }
  );
}
