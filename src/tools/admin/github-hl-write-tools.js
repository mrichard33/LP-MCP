// ─── HL MCP Cross-Repo WRITE Tools — src/tools/admin/github-hl-write-tools.js ───
//
// Promotes the HL MCP repo (mrichard33/HL-MCP) from read-only reverse-failover
// to full read + write, mirroring the dashboard_github_* / n8n_github_* write
// tools. Uses the same GITHUB_PAT as every other cross-repo tool (classic
// `repo` scope → read+write on all repos the token owner can access).
//
// The read-side HL tools (hl_github_list_files / get_file / get_recent_commits /
// search_code / list_branches) remain in github-tools.js. These three add the
// write side.
//
// WARNING: committing to main may trigger a Railway redeploy of the HL MCP
// service AND the report.getreecewindows.com static site (public/wp, served via
// Caddy / Dockerfile.wp out of the HL repo).

import { z } from 'zod';
import { ghRequest, getHlRepo } from '../../admin/github-client.js';

export function registerHlWriteTools(server) {

  // hl_github_create_or_update_file [WRITE]
  server.tool(
    'hl_github_create_or_update_file',
    'CROSS-REPO: Create or update a file in the HL MCP repo. Requires confirm: true. WARNING: committing to main may redeploy the HL MCP service and the report.getreecewindows.com static site.',
    {
      path: z.string().describe('File path. Example: "public/wp/index.html"'),
      content: z.string().describe('Full file content'),
      message: z.string().describe('Commit message'),
      sha: z.string().optional().describe('File SHA (required for updates — get from hl_github_get_file)'),
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
            repo: getHlRepo(),
            action: sha ? 'update_file' : 'create_file',
            path,
            branch: targetBranch,
            message,
            content_length: content.length,
            warning: targetBranch === 'main'
              ? 'WARNING: Committing to main may trigger a Railway redeploy of the HL MCP service and the report.getreecewindows.com static site. Set confirm: true to execute.'
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
      const data = await ghRequest('PUT', `/contents/${path}`, body, getHlRepo());
      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true,
          repo: getHlRepo(),
          action: sha ? 'updated' : 'created',
          path,
          branch: targetBranch,
          commit_sha: data.commit?.sha,
          message,
        }, null, 2) }],
      };
    }
  );

  // hl_github_create_branch [WRITE]
  server.tool(
    'hl_github_create_branch',
    'CROSS-REPO: Create a new branch in the HL MCP repo.',
    {
      branch_name: z.string().describe('New branch name'),
      from_branch: z.string().optional().describe('Source branch (default: "main")'),
    },
    async ({ branch_name, from_branch }) => {
      if (!branch_name) {
        return { content: [{ type: 'text', text: 'Error: branch_name is required.' }] };
      }
      const source = from_branch || 'main';
      const ref = await ghRequest('GET', `/git/ref/heads/${source}`, null, getHlRepo());
      const sha = ref.object.sha;
      await ghRequest('POST', '/git/refs', {
        ref: `refs/heads/${branch_name}`,
        sha,
      }, getHlRepo());
      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true,
          repo: getHlRepo(),
          branch: branch_name,
          from: source,
          sha: sha.substring(0, 7),
        }, null, 2) }],
      };
    }
  );

  // hl_github_create_pull_request [WRITE]
  server.tool(
    'hl_github_create_pull_request',
    'CROSS-REPO: Open a pull request in the HL MCP repo. Requires confirm: true.',
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
            repo: getHlRepo(),
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
      }, getHlRepo());
      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true,
          repo: getHlRepo(),
          pr_number: data.number,
          url: data.html_url,
          title,
          head,
          base: targetBase,
        }, null, 2) }],
      };
    }
  );
}
