// ─── GitHub Admin MCP Tools (Tools 23–29) ────────────────────────
import { z } from 'zod';
import { ghRequest, ghSearchCode, getDashboardRepo, getHlRepo } from '../../admin/github-client.js';

export function registerGitHubTools(server) {

  // Tool 23: github_list_files [READ]
  server.tool(
    'github_list_files',
    'List files and directories at a path in the GitHub repo.',
    {
      path: z.string().optional().describe('Directory path (default: root). Example: "src/tools"'),
      branch: z.string().optional().describe('Branch name (default: "main")'),
    },
    async ({ path, branch }) => {
      const dirPath = path || '';
      const ref = branch || 'main';
      const data = await ghRequest('GET', `/contents/${dirPath}?ref=${ref}`);

      const files = Array.isArray(data)
        ? data.map(f => ({ name: f.name, type: f.type, size: f.size, path: f.path }))
        : [{ name: data.name, type: data.type, size: data.size, path: data.path }];

      return {
        content: [{ type: 'text', text: JSON.stringify({ path: dirPath, branch: ref, files }, null, 2) }],
      };
    }
  );

  // Tool 24: github_get_file [READ]
  server.tool(
    'github_get_file',
    'Read full content of a file from the GitHub repo. Returns content + sha (needed for edits).',
    {
      path: z.string().describe('File path. Example: "src/sync-engine.js"'),
      branch: z.string().optional().describe('Branch name (default: "main")'),
    },
    async ({ path, branch }) => {
      if (!path) return { content: [{ type: 'text', text: 'Error: path is required.' }] };

      const ref = branch || 'main';
      const data = await ghRequest('GET', `/contents/${path}?ref=${ref}`);

      // Decode base64 content
      const content = data.content ? Buffer.from(data.content, 'base64').toString('utf-8') : '';

      return {
        content: [{ type: 'text', text: JSON.stringify({
          path: data.path,
          sha: data.sha,
          size: data.size,
          content,
        }, null, 2) }],
      };
    }
  );

  // Tool 25: github_create_or_update_file [WRITE]
  server.tool(
    'github_create_or_update_file',
    'Create or update a file in the GitHub repo. Commits to main trigger Railway auto-deploy. Requires confirm: true.',
    {
      path: z.string().describe('File path. Example: "src/tools/admin/reconcile.js"'),
      content: z.string().describe('Full file content'),
      message: z.string().describe('Commit message'),
      sha: z.string().optional().describe('File SHA (required for updates — get from github_get_file)'),
      branch: z.string().optional().describe('Branch name (default: "main")'),
      confirm: z.boolean().optional().describe('Must be true to execute.'),
    },
    async ({ path, content, message, sha, branch, confirm }) => {
      if (!path || !content || !message) {
        return { content: [{ type: 'text', text: 'Error: path, content, and message are required.' }] };
      }

      const targetBranch = branch || 'main';

      if (confirm !== true) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            preview: true,
            action: sha ? 'update_file' : 'create_file',
            path,
            branch: targetBranch,
            message,
            content_length: content.length,
            warning: targetBranch === 'main'
              ? 'WARNING: Committing to main triggers Railway auto-deploy. Set confirm: true to execute.'
              : 'Set confirm: true to execute.',
          }, null, 2) }],
        };
      }

      const body = {
        message,
        content: Buffer.from(content).toString('base64'),
        branch: targetBranch,
      };
      if (sha) body.sha = sha;

      const data = await ghRequest('PUT', `/contents/${path}`, body);

      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true,
          action: sha ? 'updated' : 'created',
          path,
          branch: targetBranch,
          commit_sha: data.commit?.sha,
          message,
        }, null, 2) }],
      };
    }
  );

  // Tool 26: github_get_recent_commits [READ]
  server.tool(
    'github_get_recent_commits',
    'Recent commit history on a branch.',
    {
      count: z.number().optional().describe('Number of commits (default 10, max 30)'),
      branch: z.string().optional().describe('Branch name (default: "main")'),
    },
    async ({ count, branch }) => {
      const n = Math.min(count || 10, 30);
      const ref = branch || 'main';
      const data = await ghRequest('GET', `/commits?sha=${ref}&per_page=${n}`);

      const commits = data.map(c => ({
        sha: c.sha?.substring(0, 7),
        message: c.commit?.message,
        author: c.commit?.author?.name,
        date: c.commit?.author?.date,
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify({ branch: ref, commits }, null, 2) }],
      };
    }
  );

  // Tool 27: github_create_branch [WRITE]
  server.tool(
    'github_create_branch',
    'Create a new branch from an existing branch.',
    {
      branch_name: z.string().describe('New branch name. Example: "fix/pagination-increment"'),
      from_branch: z.string().optional().describe('Source branch (default: "main")'),
    },
    async ({ branch_name, from_branch }) => {
      if (!branch_name) {
        return { content: [{ type: 'text', text: 'Error: branch_name is required.' }] };
      }

      const source = from_branch || 'main';

      // Get the SHA of the source branch
      const ref = await ghRequest('GET', `/git/ref/heads/${source}`);
      const sha = ref.object.sha;

      // Create the new branch
      await ghRequest('POST', '/git/refs', {
        ref: `refs/heads/${branch_name}`,
        sha,
      });

      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true,
          branch: branch_name,
          from: source,
          sha: sha.substring(0, 7),
        }, null, 2) }],
      };
    }
  );

  // Tool 28: github_create_pull_request [WRITE]
  server.tool(
    'github_create_pull_request',
    'Open a pull request. Requires confirm: true.',
    {
      title: z.string().describe('PR title'),
      body: z.string().optional().describe('PR description (markdown)'),
      head: z.string().describe('Source branch'),
      base: z.string().optional().describe('Target branch (default: "main")'),
      confirm: z.boolean().optional().describe('Must be true to execute.'),
    },
    async ({ title, body, head, base, confirm }) => {
      if (!title || !head) {
        return { content: [{ type: 'text', text: 'Error: title and head are required.' }] };
      }

      const targetBase = base || 'main';

      if (confirm !== true) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            preview: true,
            action: 'create_pull_request',
            title,
            head,
            base: targetBase,
            body_length: body?.length || 0,
            warning: 'Set confirm: true to execute.',
          }, null, 2) }],
        };
      }

      const data = await ghRequest('POST', '/pulls', {
        title,
        body: body || '',
        head,
        base: targetBase,
      });

      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true,
          pr_number: data.number,
          url: data.html_url,
          title,
          head,
          base: targetBase,
        }, null, 2) }],
      };
    }
  );

  // Tool 29: github_search_code [READ]
  server.tool(
    'github_search_code',
    'Search for a string across all files in the repo.',
    {
      query: z.string().describe('Search query. Example: "startIndex += pageSize"'),
    },
    async ({ query }) => {
      if (!query) return { content: [{ type: 'text', text: 'Error: query is required.' }] };

      const data = await ghSearchCode(query);

      const results = (data.items || []).map(item => ({
        path: item.path,
        name: item.name,
        url: item.html_url,
        score: item.score,
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify({
          total_count: data.total_count,
          results,
        }, null, 2) }],
      };
    }
  );

  // ─── Reece Dashboard Cross-Repo Tools (read + write) ────────────
  // Mirror of the HL MCP dashboard_github_* tools so the Reece Dashboard
  // repo stays readable/writable when the HL MCP service is down.

  // dashboard_github_list_files [READ]
  server.tool(
    'dashboard_github_list_files',
    'CROSS-REPO: List files/directories at a path in the Reece Dashboard repo.',
    {
      path: z.string().optional().describe('Directory path (default: root)'),
      branch: z.string().optional().describe('Branch name (default: "main")'),
    },
    async ({ path, branch }) => {
      const dirPath = path || '';
      const ref = branch || 'main';
      const data = await ghRequest('GET', `/contents/${dirPath}?ref=${ref}`, null, getDashboardRepo());
      const files = Array.isArray(data)
        ? data.map(f => ({ name: f.name, type: f.type, size: f.size, path: f.path }))
        : [{ name: data.name, type: data.type, size: data.size, path: data.path }];
      return {
        content: [{ type: 'text', text: JSON.stringify({ repo: getDashboardRepo(), path: dirPath, branch: ref, files }, null, 2) }],
      };
    }
  );

  // dashboard_github_get_file [READ]
  server.tool(
    'dashboard_github_get_file',
    'CROSS-REPO: Read full content of a file from the Reece Dashboard repo.',
    {
      path: z.string().describe('File path. Example: "src/App.tsx"'),
      branch: z.string().optional().describe('Branch name (default: "main")'),
    },
    async ({ path, branch }) => {
      if (!path) return { content: [{ type: 'text', text: 'Error: path is required.' }] };
      const ref = branch || 'main';
      const data = await ghRequest('GET', `/contents/${path}?ref=${ref}`, null, getDashboardRepo());
      const content = data.content ? Buffer.from(data.content, 'base64').toString('utf-8') : '';
      return {
        content: [{ type: 'text', text: JSON.stringify({ repo: getDashboardRepo(), path: data.path, sha: data.sha, size: data.size, content }, null, 2) }],
      };
    }
  );

  // dashboard_github_get_recent_commits [READ]
  server.tool(
    'dashboard_github_get_recent_commits',
    'CROSS-REPO: Recent commit history on a branch of the Reece Dashboard repo.',
    {
      count: z.number().optional().describe('Number of commits (default 10, max 30)'),
      branch: z.string().optional().describe('Branch name (default: "main")'),
    },
    async ({ count, branch }) => {
      const n = Math.min(count || 10, 30);
      const ref = branch || 'main';
      const data = await ghRequest('GET', `/commits?sha=${ref}&per_page=${n}`, null, getDashboardRepo());
      const commits = data.map(c => ({
        sha: c.sha?.substring(0, 7),
        message: c.commit?.message,
        author: c.commit?.author?.name,
        date: c.commit?.author?.date,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify({ repo: getDashboardRepo(), branch: ref, commits }, null, 2) }],
      };
    }
  );

  // dashboard_github_search_code [READ]
  server.tool(
    'dashboard_github_search_code',
    'CROSS-REPO: Search for a string across all files in the Reece Dashboard repo.',
    {
      query: z.string().describe('Search query'),
    },
    async ({ query }) => {
      if (!query) return { content: [{ type: 'text', text: 'Error: query is required.' }] };
      const data = await ghSearchCode(query, getDashboardRepo());
      const results = (data.items || []).map(item => ({
        path: item.path,
        name: item.name,
        url: item.html_url,
        score: item.score,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify({ repo: getDashboardRepo(), total_count: data.total_count, results }, null, 2) }],
      };
    }
  );

  // dashboard_github_list_branches [READ]
  server.tool(
    'dashboard_github_list_branches',
    'CROSS-REPO: List all branches in the Reece Dashboard repo.',
    {},
    async () => {
      const data = await ghRequest('GET', `/branches?per_page=100`, null, getDashboardRepo());
      const branches = (Array.isArray(data) ? data : []).map(b => ({
        name: b.name,
        sha: b.commit?.sha?.substring(0, 7),
        protected: b.protected,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify({ repo: getDashboardRepo(), branches, count: branches.length }, null, 2) }],
      };
    }
  );

  // dashboard_github_create_or_update_file [WRITE]
  server.tool(
    'dashboard_github_create_or_update_file',
    'CROSS-REPO: Create or update a file in the Reece Dashboard repo. Requires confirm: true. WARNING: committing to main may trigger an auto-deploy of the dashboard.',
    {
      path: z.string().describe('File path. Example: "src/App.tsx"'),
      content: z.string().describe('Full file content'),
      message: z.string().describe('Commit message'),
      sha: z.string().optional().describe('File SHA (required for updates — get from dashboard_github_get_file)'),
      branch: z.string().optional().describe('Branch name (default: "main")'),
      confirm: z.boolean().optional().describe('Must be true to execute.'),
    },
    async ({ path, content, message, sha, branch, confirm }) => {
      if (!path || !content || !message) {
        return { content: [{ type: 'text', text: 'Error: path, content, and message are required.' }] };
      }
      const targetBranch = branch || 'main';
      if (confirm !== true) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            preview: true,
            repo: getDashboardRepo(),
            action: sha ? 'update_file' : 'create_file',
            path,
            branch: targetBranch,
            message,
            content_length: content.length,
            warning: targetBranch === 'main'
              ? 'WARNING: Committing to main may trigger an auto-deploy of the dashboard. Set confirm: true to execute.'
              : 'Set confirm: true to execute.',
          }, null, 2) }],
        };
      }
      const body = {
        message,
        content: Buffer.from(content).toString('base64'),
        branch: targetBranch,
      };
      if (sha) body.sha = sha;
      const data = await ghRequest('PUT', `/contents/${path}`, body, getDashboardRepo());
      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true,
          repo: getDashboardRepo(),
          action: sha ? 'updated' : 'created',
          path,
          branch: targetBranch,
          commit_sha: data.commit?.sha,
          message,
        }, null, 2) }],
      };
    }
  );

  // dashboard_github_create_branch [WRITE]
  server.tool(
    'dashboard_github_create_branch',
    'CROSS-REPO: Create a new branch in the Reece Dashboard repo.',
    {
      branch_name: z.string().describe('New branch name'),
      from_branch: z.string().optional().describe('Source branch (default: "main")'),
    },
    async ({ branch_name, from_branch }) => {
      if (!branch_name) {
        return { content: [{ type: 'text', text: 'Error: branch_name is required.' }] };
      }
      const source = from_branch || 'main';
      const ref = await ghRequest('GET', `/git/ref/heads/${source}`, null, getDashboardRepo());
      const sha = ref.object.sha;
      await ghRequest('POST', '/git/refs', {
        ref: `refs/heads/${branch_name}`,
        sha,
      }, getDashboardRepo());
      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true,
          repo: getDashboardRepo(),
          branch: branch_name,
          from: source,
          sha: sha.substring(0, 7),
        }, null, 2) }],
      };
    }
  );

  // dashboard_github_create_pull_request [WRITE]
  server.tool(
    'dashboard_github_create_pull_request',
    'CROSS-REPO: Open a pull request in the Reece Dashboard repo. Requires confirm: true.',
    {
      title: z.string().describe('PR title'),
      body: z.string().optional().describe('PR description (markdown)'),
      head: z.string().describe('Source branch'),
      base: z.string().optional().describe('Target branch (default: "main")'),
      confirm: z.boolean().optional().describe('Must be true to execute.'),
    },
    async ({ title, body, head, base, confirm }) => {
      if (!title || !head) {
        return { content: [{ type: 'text', text: 'Error: title and head are required.' }] };
      }
      const targetBase = base || 'main';
      if (confirm !== true) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            preview: true,
            repo: getDashboardRepo(),
            action: 'create_pull_request',
            title,
            head,
            base: targetBase,
            body_length: body?.length || 0,
            warning: 'Set confirm: true to execute.',
          }, null, 2) }],
        };
      }
      const data = await ghRequest('POST', '/pulls', {
        title,
        body: body || '',
        head,
        base: targetBase,
      }, getDashboardRepo());
      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true,
          repo: getDashboardRepo(),
          pr_number: data.number,
          url: data.html_url,
          title,
          head,
          base: targetBase,
        }, null, 2) }],
      };
    }
  );

  // ─── HL MCP Cross-Repo Tools (read-only — reverse failover) ─────
  // So the HL MCP repo stays readable when the HL MCP service is down.

  // hl_github_list_files [READ]
  server.tool(
    'hl_github_list_files',
    'CROSS-REPO: List files/directories at a path in the HL MCP repo (reverse failover).',
    {
      path: z.string().optional().describe('Directory path (default: root)'),
      branch: z.string().optional().describe('Branch name (default: "main")'),
    },
    async ({ path, branch }) => {
      const dirPath = path || '';
      const ref = branch || 'main';
      const data = await ghRequest('GET', `/contents/${dirPath}?ref=${ref}`, null, getHlRepo());
      const files = Array.isArray(data)
        ? data.map(f => ({ name: f.name, type: f.type, size: f.size, path: f.path }))
        : [{ name: data.name, type: data.type, size: data.size, path: data.path }];
      return {
        content: [{ type: 'text', text: JSON.stringify({ repo: getHlRepo(), path: dirPath, branch: ref, files }, null, 2) }],
      };
    }
  );

  // hl_github_get_file [READ]
  server.tool(
    'hl_github_get_file',
    'CROSS-REPO: Read full content of a file from the HL MCP repo (reverse failover).',
    {
      path: z.string().describe('File path. Example: "src/index.ts"'),
      branch: z.string().optional().describe('Branch name (default: "main")'),
    },
    async ({ path, branch }) => {
      if (!path) return { content: [{ type: 'text', text: 'Error: path is required.' }] };
      const ref = branch || 'main';
      const data = await ghRequest('GET', `/contents/${path}?ref=${ref}`, null, getHlRepo());
      const content = data.content ? Buffer.from(data.content, 'base64').toString('utf-8') : '';
      return {
        content: [{ type: 'text', text: JSON.stringify({ repo: getHlRepo(), path: data.path, sha: data.sha, size: data.size, content }, null, 2) }],
      };
    }
  );

  // hl_github_get_recent_commits [READ]
  server.tool(
    'hl_github_get_recent_commits',
    'CROSS-REPO: Recent commit history on a branch of the HL MCP repo (reverse failover).',
    {
      count: z.number().optional().describe('Number of commits (default 10, max 30)'),
      branch: z.string().optional().describe('Branch name (default: "main")'),
    },
    async ({ count, branch }) => {
      const n = Math.min(count || 10, 30);
      const ref = branch || 'main';
      const data = await ghRequest('GET', `/commits?sha=${ref}&per_page=${n}`, null, getHlRepo());
      const commits = data.map(c => ({
        sha: c.sha?.substring(0, 7),
        message: c.commit?.message,
        author: c.commit?.author?.name,
        date: c.commit?.author?.date,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify({ repo: getHlRepo(), branch: ref, commits }, null, 2) }],
      };
    }
  );

  // hl_github_search_code [READ]
  server.tool(
    'hl_github_search_code',
    'CROSS-REPO: Search for a string across all files in the HL MCP repo (reverse failover).',
    {
      query: z.string().describe('Search query'),
    },
    async ({ query }) => {
      if (!query) return { content: [{ type: 'text', text: 'Error: query is required.' }] };
      const data = await ghSearchCode(query, getHlRepo());
      const results = (data.items || []).map(item => ({
        path: item.path,
        name: item.name,
        url: item.html_url,
        score: item.score,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify({ repo: getHlRepo(), total_count: data.total_count, results }, null, 2) }],
      };
    }
  );

  // hl_github_list_branches [READ]
  server.tool(
    'hl_github_list_branches',
    'CROSS-REPO: List all branches in the HL MCP repo (reverse failover).',
    {},
    async () => {
      const data = await ghRequest('GET', `/branches?per_page=100`, null, getHlRepo());
      const branches = (Array.isArray(data) ? data : []).map(b => ({
        name: b.name,
        sha: b.commit?.sha?.substring(0, 7),
        protected: b.protected,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify({ repo: getHlRepo(), branches, count: branches.length }, null, 2) }],
      };
    }
  );
}
