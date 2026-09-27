// ─── Recording archive outage — src/ci/archive-outage.js ────────────────────
//
// 2026-09-27. The recording archive (SFTP, nas1.etgts.com:2282, a third-party
// NAS) has refused every connection since 2026-08-27 ~18:00 UTC:
//   "connect: Remote host has reset the connection: getConnection: read ECONNRESET"
// The last recording was fetched 2026-08-27 17:43 UTC. For a month nobody knew.
//
// What the worker did with that, per claimed call, every 30s tick:
//   - opened a fresh SFTP connection per folder, got reset (~25s each);
//   - counted it as THIS CALL's failure (recordFailure → attempts + 1);
//   - after five, parked the call `failed` for good.
// So a network outage that no call caused turned 16,771 calls into permanent
// failures, logged ~3,000 retry/error rows a day into ci_events, and kept
// knocking on a host that may be refusing us precisely because we keep
// knocking (a fail2ban-style block stays up while the attempts continue). And
// the only sign anywhere was a tick line reading "0% hit, N failed".
//
// This module makes an unreachable archive an OUTAGE, not a per-call failure:
//   - isArchiveUnreachable: connection-level errors only (reset, refused,
//     timeout, DNS, handshake). "No such file" and friends are NOT outages —
//     they stay the call's own failure, as before.
//   - createArchiveBreaker: after one unreachable, every fetch pauses until
//     the cool-down ends (5 min, doubling to 60 min). A call parked by a pause
//     keeps its attempts. The first fetch after the cool-down is the probe.
//   - archiveOutageVerdict: three-way, per the CLAUDE.md alert doctrine —
//     alert once the outage has lasted ALERT_AFTER_MS, healthy only when a
//     listing actually SUCCEEDED this tick, null when no fetch ran (nothing
//     was checked, so nothing is cleared).
//
// Pure — no I/O. The worker owns the calls, the lease writes and the alert.

export const ARCHIVE_BASE_COOLDOWN_MS = 5 * 60 * 1000;
export const ARCHIVE_MAX_COOLDOWN_MS = 60 * 60 * 1000;
export const ARCHIVE_ALERT_AFTER_MS = 30 * 60 * 1000;

const UNREACHABLE = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|reset the connection|Timed out while waiting for handshake|Connection lost before handshake|getConnection/i;

export function isArchiveUnreachable(err) {
  return UNREACHABLE.test(String(err?.message ?? err ?? ''));
}

export function createArchiveBreaker({
  baseMs = ARCHIVE_BASE_COOLDOWN_MS,
  maxMs = ARCHIVE_MAX_COOLDOWN_MS,
  now = () => Date.now(),
} = {}) {
  let openUntil = 0;
  let failures = 0;        // consecutive unreachable probes
  let since = null;        // first unreachable of the current outage
  let lastError = null;

  return {
    /** True while fetches should pause. */
    isOpen() { return now() < openUntil; },
    openUntil() { return openUntil; },
    recordUnreachable(err) {
      failures += 1;
      if (since == null) since = now();
      lastError = String(err?.message ?? err ?? '').slice(0, 300);
      const cooldown = Math.min(maxMs, baseMs * 2 ** (failures - 1));
      openUntil = now() + cooldown;
      return { openUntil, cooldownMs: cooldown, failures };
    },
    /** A listing succeeded: the outage, if any, is over. */
    recordReachable() {
      const was = since;
      openUntil = 0; failures = 0; since = null; lastError = null;
      return was;
    },
    state() {
      return { open: now() < openUntil, openUntil, failures, since, lastError };
    },
  };
}

/**
 * @param {object} a
 * @param {number} a.reachable    fetch-stage calls whose listing worked this tick
 * @param {number} a.unreachable  fetch-stage calls that hit an outage this tick
 * @param {number} a.paused       fetch-stage calls skipped because the breaker was open
 * @param {object} a.breaker      breaker.state()
 * @param {number} a.nowMs
 * @returns {{verdict:'alert'|'healthy'|'insufficient_evidence', active:boolean|null, outageMs:number}}
 */
export function archiveOutageVerdict({ reachable = 0, unreachable = 0, paused = 0, breaker, nowMs, alertAfterMs = ARCHIVE_ALERT_AFTER_MS }) {
  if (reachable > 0 && unreachable === 0) return { verdict: 'healthy', active: false, outageMs: 0 };
  const since = breaker?.since;
  const outageMs = since != null ? Math.max(0, nowMs - since) : 0;
  if ((unreachable > 0 || paused > 0) && since != null && outageMs >= alertAfterMs) {
    return { verdict: 'alert', active: true, outageMs };
  }
  return { verdict: 'insufficient_evidence', active: null, outageMs };
}

const fmtDuration = (ms) => {
  const h = Math.floor(ms / 3600000);
  if (h >= 48) return `${Math.floor(h / 24)} days`;
  if (h >= 1) return `${h}h ${Math.floor((ms % 3600000) / 60000)}m`;
  return `${Math.max(1, Math.round(ms / 60000))} min`;
};

export function formatArchiveOutageAlert({ host, port, outageMs, lastError, waiting, nextTryMs }) {
  return [
    `📼 Call recordings: the recording archive is refusing connections (${fmtDuration(outageMs)} so far in this process).`,
    `Host: ${host}:${port}`,
    `Last error: ${lastError || 'unknown'}`,
    `${waiting ?? '?'} call(s) waiting for their recording. They are PAUSED, not failed — they resume on their own when the archive answers.`,
    `Next check in ${fmtDuration(nextTryMs ?? 0)}.`,
    'A reset before login usually means a firewall / IP allowlist / ban on the archive side — ask the archive owner to check access for this server.',
  ].join('\n');
}

export function formatArchiveRecovered({ host, port }) {
  return `✅ Call recordings: the recording archive (${host}:${port}) is answering again. Paused calls are resuming.`;
}
