/**
 * infra-guard — the four infrastructure MCP tools answer only to the operator
 * (2026-10-07, AI OS CANON.SEC.003 MCP server authn/authz, SEC.007).
 *
 * WHY. The 2026-09-23 IT/GoCloud review flagged that set_railway_env_var,
 * redeploy_railway_service, rollback_railway_deployment and http_request are
 * exposed to ANY MCP client. /mcp and /sse sit behind `authenticate`, but
 * production runs AUTH_SOFT_LAUNCH=true (src/security/request-auth.js), so an
 * unauthenticated client connects and sees every tool. One env var write can
 * repoint a webhook secret or an API base URL, and a redeploy or rollback can
 * take the service down.
 *
 * HOW (per call, not per session). The MCP SDK hands each tool callback an
 * `extra.authInfo` taken from `req.auth` on THAT request (StreamableHTTP
 * handleRequest and SSE handlePostMessage both read it — SDK 1.27). So
 * src/index.js stamps `req.auth` on every /mcp and /messages request from the
 * request's own Authorization header (attachOperatorAuth), and the guard
 * reads it at call time. Per-call beats hiding the tools at session start: a
 * session id that leaks cannot be reused for an infra call without the token,
 * and SSE posts are authorised individually.
 *
 * The operator token is INFRA_OPERATOR_TOKEN when set (sent as
 * `Authorization: Bearer <t>` or `X-Operator-Token: <t>`), otherwise
 * MCP_AUTH_TOKEN as `Authorization: Bearer <t>`. Compared in constant time
 * (safeEqual, 2026-10-03). The raw token is never stored on req.auth.
 *
 * INFRA_TOOLS_MODE:
 *   open (default)  — today's behaviour: every client may call them. Every
 *                     call is still audited (decision allow).
 *   shadow          — allowed, but a call without the operator token logs
 *                     `[InfraGuard] would_deny` and audits would_deny.
 *   operator        — a call without the operator token is refused.
 */

import { safeEqual } from '../auth.js';
import { recordToolAudit, actorFromExtra } from './tool-audit.js';

export const INFRA_TOOLS = Object.freeze([
  'set_railway_env_var',
  'redeploy_railway_service',
  'rollback_railway_deployment',
  'http_request',
]);
const INFRA_SET = new Set(INFRA_TOOLS);

export function infraToolsMode(env = process.env) {
  const v = String(env.INFRA_TOOLS_MODE || '').trim().toLowerCase();
  return v === 'shadow' || v === 'operator' ? v : 'open';
}

/** True when this HTTP request carries the operator token. Pure over req/env. */
export function isOperatorRequest(req, env = process.env) {
  const headers = req?.headers || {};
  const auth = typeof headers.authorization === 'string' ? headers.authorization : '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const infra = env.INFRA_OPERATOR_TOKEN;
  if (typeof infra === 'string' && infra.length > 0) {
    const xop = typeof headers['x-operator-token'] === 'string' ? headers['x-operator-token'] : null;
    return safeEqual(bearer, infra) || safeEqual(xop, infra);
  }
  const mcp = env.MCP_AUTH_TOKEN;
  if (typeof mcp === 'string' && mcp.length > 0) return safeEqual(bearer, mcp);
  return false;
}

/**
 * Stamp `req.auth` (the SDK's AuthInfo) so tool callbacks see who called.
 * Express middleware shape; call before transport.handleRequest.
 */
export function attachOperatorAuth(req, _res, next) {
  try {
    const operator = isOperatorRequest(req);
    req.auth = {
      token: '[redacted]',
      clientId: operator ? 'operator' : 'mcp-client',
      scopes: operator ? ['operator'] : [],
    };
  } catch {
    req.auth = { token: '[redacted]', clientId: 'mcp-client', scopes: [] };
  }
  if (typeof next === 'function') next();
}

/**
 * The decision for one infra call, pure.
 * @returns {{ allow: boolean, decision: 'allow'|'would_deny'|'deny', reason: string|null }}
 */
export function decideInfraCall({ operator, mode }) {
  if (operator) return { allow: true, decision: 'allow', reason: 'operator_token' };
  if (mode === 'operator') return { allow: false, decision: 'deny', reason: 'operator_token_required' };
  if (mode === 'shadow') return { allow: true, decision: 'would_deny', reason: 'operator_token_missing' };
  return { allow: true, decision: 'allow', reason: 'open_mode' };
}

/** Non-secret summary of an infra tool's arguments for the audit row. */
export function summarizeInfraArgs(tool, args = {}) {
  const a = args || {};
  if (tool === 'set_railway_env_var') {
    // The NAME only — never the value, which is usually a secret.
    return { name: a.name ?? null, value_length: typeof a.value === 'string' ? a.value.length : null, confirm: a.confirm === true };
  }
  if (tool === 'rollback_railway_deployment') return { deployment_id: a.deployment_id ?? null, confirm: a.confirm === true };
  if (tool === 'redeploy_railway_service') return { confirm: a.confirm === true };
  if (tool === 'http_request') {
    let host = null;
    try { host = new URL(String(a.url)).hostname; } catch { /* relative path on a profile */ }
    return {
      method: String(a.method || 'GET').toUpperCase(),
      host,
      url_head: String(a.url ?? '').split('?')[0].slice(0, 200),
      auth_profile: a.auth_profile ?? null,
      confirm: a.confirm === true,
    };
  }
  return {};
}

function refusal(tool) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        error: 'operator_token_required',
        tool,
        detail: `${tool} is an infrastructure tool and INFRA_TOOLS_MODE=operator. ` +
          'Reconnect this MCP client with the operator token (Authorization: Bearer <INFRA_OPERATOR_TOKEN> ' +
          'or X-Operator-Token), or make the change in the Railway dashboard.',
      }, null, 2),
    }],
    isError: true,
  };
}

/**
 * Wrap a server so the infra tools' handlers run the guard first. Other tools
 * pass through untouched. Same Proxy shape as withSanitizedResults.
 */
export function withInfraGuard(server, { env = process.env, audit = recordToolAudit, log = (m) => console.warn(m) } = {}) {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== 'tool') return Reflect.get(target, prop, receiver);
      return (...args) => {
        const name = args[0];
        const handler = args[args.length - 1];
        if (!INFRA_SET.has(name) || typeof handler !== 'function') return target.tool(...args);
        const guarded = async (toolArgs, extra) => {
          const mode = infraToolsMode(env);
          const who = actorFromExtra(extra);
          const d = decideInfraCall({ operator: who.operator, mode });
          audit({
            tool: name,
            actor: who.actor,
            mode,
            decision: d.decision,
            reason: d.reason,
            detail: { session_id: who.session_id, args: summarizeInfraArgs(name, toolArgs) },
          }, env);
          if (d.decision === 'would_deny') log(`[InfraGuard] would_deny ${name} actor=${who.actor} (INFRA_TOOLS_MODE=shadow)`);
          if (!d.allow) {
            log(`[InfraGuard] denied ${name} actor=${who.actor} (INFRA_TOOLS_MODE=operator)`);
            return refusal(name);
          }
          return handler(toolArgs, extra);
        };
        return target.tool(...args.slice(0, -1), guarded);
      };
    },
  });
}
