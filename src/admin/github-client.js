// ─── GitHub REST API Client — src/admin/github-client.js ─────────
//
// Wrapper for GitHub REST API v3.
// Requires GITHUB_PAT (repo scope) and GITHUB_REPO env vars.
//
// v1.2: Added optional repoOverride to support cross-repo reads
//       (Reece Dashboard, and HL MCP repo for reverse failover) so
//       those repos stay readable when the HL MCP service is down.
// v1.3: Added getN8nRepo() for the self-hosted n8n deployment repo
//       (mrichard33/n8n on Railway), accessed via the same GITHUB_PAT.
// v1.4: ghSearchCode no longer uses GitHub's /search/code API — that
//       index silently returns 0 results for these private repos
//       (unavailable to the PAT / unindexed). Search is now
//       self-contained: download the repo tarball once (single API
//       call), gunzip + parse in memory, grep every text file for the
//       query as a case-insensitive substring. Cached per repo@ref
//       for 120s. Works on any branch; exact substring semantics.

import zlib from 'node:zlib';

const GH_API = 'https://api.github.com';

const getRepo = (repoOverride) => {
  const repo = repoOverride || process.env.GITHUB_REPO;
  if (!repo) throw new Error('GITHUB_REPO not configured');
  return repo;
};

// Reece Dashboard repo (cross-repo read/write target).
export const getDashboardRepo = () =>
  process.env.DASHBOARD_GITHUB_REPO || 'mrichard33/Reece-Dashboard';

// HL MCP repo (cross-repo read target — reverse failover when HL MCP is down).
export const getHlRepo = () =>
  process.env.HL_GITHUB_REPO || 'mrichard33/HL-MCP';

// Self-hosted n8n deployment repo (cross-repo read/write target).
// n8n runs on Railway from this repo; accessed via the same GITHUB_PAT.
export const getN8nRepo = () =>
  process.env.N8N_GITHUB_REPO || 'mrichard33/n8n';

export const ghRequest = async (method, path, body = null, repoOverride = null) => {
  const token = process.env.GITHUB_PAT;
  if (!token) throw new Error('GITHUB_PAT not configured');

  const repo = getRepo(repoOverride);
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${GH_API}/repos/${repo}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${res.status}: ${text}`);
  }

  return res.json();
};

// ─── Tarball-grep code search (v1.4) ─────────────────────────────
// Replaces GitHub /search/code, whose index returns 0 results for
// these private repos. One tarball fetch per repo@ref per 120s,
// then pure in-memory grep. Binary blobs (NUL byte in first 8KB)
// and files >1MB are skipped.

const TARBALL_CACHE = new Map(); // `${repo}@${ref}` → { files: Map(path → content), fetchedAt }
const TARBALL_TTL_MS = 120000;
const TARBALL_CACHE_MAX = 4;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_RESULT_FILES = 50;
const MAX_MATCHES_PER_FILE = 5;
const MAX_LINE_LEN = 200;

// Minimal tar parser (ustar/pax as produced by git archive / GitHub
// tarballs). Handles pax extended headers ('x') and GNU longnames
// ('L') for long paths; skips dirs, global headers, and symlinks.
const parseTarEntries = (tarBuf) => {
  const files = new Map();
  let offset = 0;
  let pendingLongName = null;

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive zero block

    const rawName = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const sizeOctal = header.toString('utf8', 124, 136).replace(/[^0-7]/g, '');
    const size = parseInt(sizeOctal || '0', 8) || 0;
    const typeflag = String.fromCharCode(header[156]);
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');

    const dataStart = offset + 512;
    const body = tarBuf.subarray(dataStart, Math.min(dataStart + size, tarBuf.length));

    const name = pendingLongName || (prefix ? `${prefix}/${rawName}` : rawName);
    pendingLongName = null;

    if (typeflag === 'L') {
      // GNU longname: body is the real name of the NEXT entry
      pendingLongName = body.toString('utf8').replace(/\0.*$/, '');
    } else if (typeflag === 'x' || typeflag === 'X') {
      // pax extended header: "<len> path=<value>\n" applies to NEXT entry
      const m = body.toString('utf8').match(/\d+ path=([^\n]+)\n/);
      if (m) pendingLongName = m[1];
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      // Regular file. GitHub tarballs prefix every path with a root
      // dir ("owner-repo-shortsha/") — strip the first segment.
      const rel = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
      const looksBinary = body.subarray(0, 8192).includes(0);
      if (rel && size <= MAX_FILE_BYTES && !looksBinary) {
        files.set(rel, body.toString('utf8'));
      }
    }
    // 'g' (pax global), '5' (dir), symlinks etc.: skip body

    offset = dataStart + size + ((512 - (size % 512)) % 512);
  }
  return files;
};

const fetchRepoFiles = async (repo, ref) => {
  const key = `${repo}@${ref}`;
  const cached = TARBALL_CACHE.get(key);
  if (cached && Date.now() - cached.fetchedAt < TARBALL_TTL_MS) return cached.files;

  const token = process.env.GITHUB_PAT;
  if (!token) throw new Error('GITHUB_PAT not configured');

  // Redirects to a signed codeload URL — fetch follows automatically.
  const res = await fetch(`${GH_API}/repos/${repo}/tarball/${encodeURIComponent(ref)}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub tarball ${res.status}: ${text}`);
  }

  const gz = Buffer.from(await res.arrayBuffer());
  const tar = zlib.gunzipSync(gz);
  const files = parseTarEntries(tar);

  TARBALL_CACHE.set(key, { files, fetchedAt: Date.now() });
  if (TARBALL_CACHE.size > TARBALL_CACHE_MAX) {
    let oldestKey = null, oldestAt = Infinity;
    for (const [k, v] of TARBALL_CACHE) {
      if (v.fetchedAt < oldestAt) { oldestAt = v.fetchedAt; oldestKey = k; }
    }
    if (oldestKey) TARBALL_CACHE.delete(oldestKey);
  }
  return files;
};

// Search code across the repo. Case-insensitive exact-substring grep
// over the repo tarball. Return shape is backward compatible with the
// old /search/code response: { total_count, items: [{ name, path,
// html_url, score }] }. Additions: html_url deep-links to the first
// matching line, score = matching line count, and each item carries a
// `matches` array ([{ line, text }]) for richer tool output.
export const ghSearchCode = async (query, repoOverride = null, ref = 'main') => {
  if (!query || !query.trim()) return { total_count: 0, items: [] };

  const repo = getRepo(repoOverride);
  const files = await fetchRepoFiles(repo, ref);
  const needle = query.toLowerCase();

  const items = [];
  for (const [path, content] of files) {
    if (!content.toLowerCase().includes(needle)) continue;

    const lines = content.split('\n');
    const matches = [];
    let matchCount = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        matchCount++;
        if (matches.length < MAX_MATCHES_PER_FILE) {
          matches.push({ line: i + 1, text: lines[i].trim().slice(0, MAX_LINE_LEN) });
        }
      }
    }

    items.push({
      name: path.split('/').pop(),
      path,
      html_url: `https://github.com/${repo}/blob/${ref}/${path}#L${matches[0]?.line || 1}`,
      score: matchCount,
      matches,
    });
    if (items.length >= MAX_RESULT_FILES) break;
  }

  // Most-relevant (most matching lines) first
  items.sort((a, b) => b.score - a.score);

  return { total_count: items.length, items, search_method: 'tarball-grep', ref };
};
