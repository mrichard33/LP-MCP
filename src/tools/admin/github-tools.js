// ─── GitHub Admin MCP Tools (Tools 23–29) ────────────────────────
import { ghRequest, ghSearchCode } from '../../admin/github-client.js';

export function registerGitHubTools(server) {

  // Tool 23: github_list_files [READ]
  server.tool(
    'github_list_files',
    'List files and directories at a path in the GitHub repo.',
    {
      path: { type: 'string', description: 'Directory path (default: root). Example: "src/tools"' },
      branch: { type: 'string', description: 'Branch name (default: "main")' },
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
      path: { type: 'string', description: 'File path. Example: "src/sync-engine.js"' },
      branch: { type: 'string', description: 'Branch name (default: "main")' },
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
      path: { type: 'string', description: 'File path. Example: "src/tools/admin/reconcile.js"' },
      content: { type: 'string', description: 'Full file content' },
      message: { type: 'string', description: 'Commit message' },
      sha: { type: 'string', description: 'File SHA (required for updates — get from github_get_file)' },
      branch: { type: 'string', description: 'Branch name (default: "main")' },
      confirm: { type: 'boolean', description: 'Must be true to execute.' },
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
      count: { type: 'number', description: 'Number of commits (default 10, max 30)' },
      branch: { type: 'string', description: 'Branch name (default: "main")' },
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
      branch_name: { type: 'string', description: 'New branch name. Example: "fix/pagination-increment"' },
      from_branch: { type: 'string', description: 'Source branch (default: "main")' },
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
      title: { type: 'string', description: 'PR title' },
      body: { type: 'string', description: 'PR description (markdown)' },
      head: { type: 'string', description: 'Source branch' },
      base: { type: 'string', description: 'Target branch (default: "main")' },
      confirm: { type: 'boolean', description: 'Must be true to execute.' },
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
      query: { type: 'string', description: 'Search query. Example: "startIndex += pageSize"' },
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
}
