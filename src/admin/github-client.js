// ─── GitHub REST API Client — src/admin/github-client.js ─────────
//
// Wrapper for GitHub REST API v3.
// Requires GITHUB_PAT (repo scope) and GITHUB_REPO env vars.

const GH_API = 'https://api.github.com';

const getRepo = () => {
  const repo = process.env.GITHUB_REPO;
  if (!repo) throw new Error('GITHUB_REPO not configured');
  return repo;
};

export const ghRequest = async (method, path, body = null) => {
  const token = process.env.GITHUB_PAT;
  if (!token) throw new Error('GITHUB_PAT not configured');

  const repo = getRepo();
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

// Search code across the repo (uses search API, not repo API)
export const ghSearchCode = async (query) => {
  const token = process.env.GITHUB_PAT;
  if (!token) throw new Error('GITHUB_PAT not configured');

  const repo = getRepo();
  const q = encodeURIComponent(`${query} repo:${repo}`);
  const res = await fetch(`${GH_API}/search/code?q=${q}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub Search ${res.status}: ${text}`);
  }
  return res.json();
};
