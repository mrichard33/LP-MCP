/**
 * railway-state.js — is each Railway service running? (pure, no I/O)
 *
 * WHY (2026-10-15). The "Service restarts" check showed
 * "LP-MCP: 1, HL-MCP: ?, n8n: ?, Reece Dashboard: ?". It looked services up by
 * NAME inside LP-MCP's own Railway project, but HL-MCP, n8n and the Dashboard
 * each live in their own project (and n8n's service is "n8n main instance"),
 * so three of four were never found. Railway answers a service by its ID from
 * any project the token can see (verified the same day for all four), so the
 * check now asks by ID.
 *
 * It also counted "deployments created in the last hour", which is not a
 * crash. What a person needs to know is whether the version running now is
 * up: Railway marks the live deployment SUCCESS, flips it to CRASHED when it
 * dies, and marks a new build that never went live FAILED (the previous
 * version keeps running).
 */

import { etClock, count } from './plain.js';

/** The services the board watches, by Railway service ID. */
export const RAILWAY_SERVICES = Object.freeze([
  { name: 'LP-MCP', id: '53517100-8b00-4dc9-b7ad-9574af35b7b6' },
  { name: 'HL-MCP', id: '6bb782e3-3566-4789-9fb6-bbfcda69106a' },
  { name: 'n8n', id: '22ddcac2-2428-450c-a20f-b3e83c010b5b' },
  { name: 'n8n worker', id: '6c7912c9-34dc-4fbf-97e7-709dabd18ba2' },
  { name: 'Reece Dashboard', id: 'ef638732-bdf6-4e72-b8e8-189bcbaa9326' },
]);

export const serviceIdFor = (name) => RAILWAY_SERVICES.find((s) => s.name.toLowerCase() === String(name).toLowerCase())?.id || null;

const IN_PROGRESS = new Set(['BUILDING', 'DEPLOYING', 'INITIALIZING', 'QUEUED', 'WAITING']);
const IGNORED = new Set(['REMOVED', 'REMOVING', 'SKIPPED', 'NEEDS_APPROVAL']);

/**
 * One service's state from its newest deployments:
 *   running        the newest finished deployment is live (SUCCESS / SLEEPING)
 *   crashed        the live deployment died (CRASHED), or nothing ever went live
 *   failed_update  the newest build FAILED but an older version is still running
 *   unknown        no deployments to read
 * plus `updatingNow` (a build in progress) and `deploysLastHour`.
 */
export function serviceState(deployments, nowMs = Date.now()) {
  const deps = [...(deployments || [])].filter((d) => d && d.status).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const deploysLastHour = deps.filter((d) => nowMs - Date.parse(d.createdAt) <= 3_600_000).length;
  const updatingNow = deps.length > 0 && IN_PROGRESS.has(deps[0].status);
  const finished = deps.filter((d) => !IN_PROGRESS.has(d.status) && !IGNORED.has(d.status));
  const newest = finished[0];
  if (!newest) return { state: deps.length ? 'running' : 'unknown', updatingNow, deploysLastHour, at: null };
  const at = Date.parse(newest.createdAt) || null;
  if (newest.status === 'SUCCESS' || newest.status === 'SLEEPING') return { state: 'running', updatingNow, deploysLastHour, at };
  if (newest.status === 'CRASHED') return { state: 'crashed', updatingNow, deploysLastHour, at };
  if (newest.status === 'FAILED') {
    const stillUp = finished.slice(1).some((d) => d.status === 'SUCCESS' || d.status === 'SLEEPING');
    return { state: stillUp ? 'failed_update' : 'crashed', updatingNow, deploysLastHour, at };
  }
  return { state: 'unknown', updatingNow, deploysLastHour, at };
}

/**
 * The "Service restarts" result for every watched service. `entries` are
 * { name, deployments } or { name, error }. Red when a service is down;
 * yellow for a failed update, a restart loop (4+ deploys in an hour) or a
 * service we could not read; unknown only when none could be read.
 */
export function restartsResult(entries, { nowMs = Date.now(), loopDeploys = 4 } = {}) {
  const rows = (entries || []).map((e) => (e.error ? { name: e.name, error: e.error } : { name: e.name, ...serviceState(e.deployments, nowMs) }));
  const readable = rows.filter((r) => !r.error);
  if (!readable.length) {
    return { status: 'unknown', summary: `Can't read Railway right now${rows[0]?.error ? ` (${rows[0].error})` : ''}.`.slice(0, 300), detail: { services: rows } };
  }
  const down = readable.filter((r) => r.state === 'crashed');
  const failedUpdate = readable.filter((r) => r.state === 'failed_update');
  // Two or three deploys in an hour is a normal busy merge day, not a problem.
  const looping = readable.filter((r) => r.deploysLastHour >= loopDeploys);
  const unread = rows.filter((r) => r.error);
  const parts = [];
  for (const r of down) parts.push(`${r.name} is down${r.at ? ` (since ${etClock(r.at)})` : ''}`);
  for (const r of looping) parts.push(`${r.name} restarted ${count(r.deploysLastHour, 'time')} in the last hour`);
  for (const r of failedUpdate) parts.push(`${r.name}'s latest update failed${r.at ? ` at ${etClock(r.at)}` : ''}; the previous version is still running`);
  for (const r of unread) parts.push(`Can't see ${r.name} on Railway`);
  const status = down.length ? 'fail' : looping.length || failedUpdate.length || unread.length ? 'warn' : 'pass';
  const summary = status === 'pass' ? `All ${readable.length} services are running normally.` : `${parts.join('. ')}.`;
  return {
    status,
    value: Math.max(0, ...readable.map((r) => r.deploysLastHour)),
    summary,
    detail: { services: rows },
  };
}
