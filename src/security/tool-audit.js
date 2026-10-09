/**
 * tool-audit — append-only trail of privileged MCP tool calls (2026-10-07).
 *
 * WHY. The 2026-09-23 IT/GoCloud security review asked for an append-only
 * audit trail of every privileged tool call (AI OS CANON.SEC.011): who asked,
 * when, under which mode, and what was decided. Before this, a
 * set_railway_env_var or a DELETE through supabase_run_query left no record
 * beyond a Railway log line that rotates.
 *
 * WHAT. recordToolAudit() writes one `tool_audit_log` row (sql/153) —
 * fire-and-forget: it never throws, never awaits on the caller's path, and a
 * missing table or a Supabase outage costs the row (one warning per minute),
 * never the tool call. The table refuses UPDATE / DELETE / TRUNCATE by
 * trigger, so a row once written stays.
 *
 * Recorded: the SQL write tool (every call), infra tools (every call),
 * http_request egress would-deny / deny, and supabase_run_query / hl_query
 * would-deny / deny. Plain allowed reads are NOT recorded (volume).
 *
 * NEVER recorded: secrets, request bodies, auth headers, env var VALUES.
 * SQL is stored as a sha256 plus its first 500 characters (the review's ask),
 * which can include a phone number in a WHERE clause — the table is
 * service_role-only for that reason.
 *
 * TOOL_AUDIT_LOG_MODE=off is the rollback (default live).
 */

import { createHash } from 'node:crypto';
import supabase from '../supabase.js';

const TABLE = 'tool_audit_log';
export const AUDIT_DECISIONS = Object.freeze(['allow', 'deny', 'would_deny']);
const SQL_HEAD_CHARS = 500;
const WARN_EVERY_MS = 60_000;

export function toolAuditMode(env = process.env) {
  return String(env.TOOL_AUDIT_LOG_MODE || '').trim().toLowerCase() === 'off' ? 'off' : 'live';
}

/** { sql_sha256, sql_head } for an audit row's detail. Pure. */
export function sqlFingerprint(sql) {
  const s = String(sql ?? '');
  return {
    sql_sha256: createHash('sha256').update(s).digest('hex'),
    sql_head: s.slice(0, SQL_HEAD_CHARS),
    sql_length: s.length,
  };
}

/**
 * Who made an MCP tool call, from the SDK's `extra` (src/index.js puts
 * `req.auth` on every /mcp and /messages request; see infra-guard.js).
 */
export function actorFromExtra(extra) {
  const a = extra?.authInfo;
  const operator = Array.isArray(a?.scopes) && a.scopes.includes('operator');
  return {
    actor: operator ? 'operator' : (a?.clientId || 'mcp-client'),
    operator,
    session_id: extra?.sessionId ?? null,
  };
}

let _clientOverride;
/** TESTS ONLY. Pass undefined to restore. */
export function __setToolAuditClientForTests(client) { _clientOverride = client; }

let _lastWarnAt = 0;
function warnOnce(msg) {
  const now = Date.now();
  if (now - _lastWarnAt < WARN_EVERY_MS) return;
  _lastWarnAt = now;
  console.warn(msg);
}

/**
 * Record one decision. Fire-and-forget; never throws.
 * Returns the row it attempted (for tests), or null when off / no client.
 *
 * @param {{ tool: string, actor?: string, mode?: string, decision: 'allow'|'deny'|'would_deny',
 *           reason?: string|null, detail?: object }} entry
 */
export function recordToolAudit({ tool, actor = 'unknown', mode = null, decision, reason = null, detail = {} }, env = process.env) {
  try {
    if (toolAuditMode(env) === 'off') return null;
    const client = _clientOverride !== undefined ? _clientOverride : supabase;
    const row = {
      tool: String(tool || 'unknown'),
      actor: String(actor || 'unknown'),
      mode: mode == null ? null : String(mode),
      decision: AUDIT_DECISIONS.includes(decision) ? decision : 'deny',
      reason: reason == null ? null : String(reason).slice(0, 1000),
      detail: detail && typeof detail === 'object' ? detail : {},
    };
    if (!client) return null;
    Promise.resolve()
      .then(() => client.from(TABLE).insert(row))
      .then((res) => {
        if (res?.error) warnOnce(`[ToolAudit] insert failed (row dropped — is sql/153 applied?): ${res.error.message}`);
      })
      .catch((err) => warnOnce(`[ToolAudit] insert threw (row dropped): ${err?.message || err}`));
    return row;
  } catch (err) {
    warnOnce(`[ToolAudit] record failed (row dropped): ${err?.message || err}`);
    return null;
  }
}
