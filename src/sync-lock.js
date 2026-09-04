// ─── Cross-process sync lock — src/sync-lock.js ───────────────────
//
// WO-6 / PR A.3 — single-flight the sync.
//
// WHY THIS EXISTS
//
// The previous guard was `syncInProgress`, a module-level boolean in
// sync-log.js. It is correct within one process and blind across two.
//
// Railway runs LP-MCP at numReplicas=1 (verified 2026-09-04), so the
// obvious "two replicas, two schedulers" explanation is not the cause.
// The cause is the deploy handover: the service is configured with
// drainingSeconds=120 and overlapSeconds=20, so during EVERY deploy the
// outgoing container keeps running for up to two minutes after the new
// one boots. For that window there are two processes, each with its own
// in-memory boolean, each running startSyncScheduler's boot sync.
//
// Measured 2026-09-04 02:28:15 UTC, during a run of 17 back-to-back
// deploys: three distinct 6-row sweep batches opened 265ms apart
// (.525, .654, .790), all three later killed by SIGTERM.
//
// THE DESIGN CONSTRAINT
//
// A lock that requires a clean shutdown to release is the wrong shape
// here, because the thing we are defending against is precisely an
// unclean shutdown. The old boot-time "Stale lock — cleaned up on boot"
// sweep is the tell: it exists to undo a lock the previous process could
// not release.
//
// So: a LEASE. The holder writes an expiry and extends it on a
// heartbeat. A holder that is SIGKILLed stops heartbeating, the lease
// runs out on its own, and the next worker acquires cleanly with no
// cleanup step and no boot sweep.
//
// FAIL-OPEN, DELIBERATELY
//
// If Supabase is unreachable, acquire() returns `acquired: true` with
// `degraded: true` and logs loudly. Failing closed would mean a Supabase
// blip silently stops all LP syncing — a data-freshness outage, which is
// strictly worse than the duplicate-sweep window this lock closes. The
// in-memory `syncInProgress` guard stays in place underneath as the
// second layer, so a degraded acquire is still single-flight within the
// process.

import { randomUUID } from 'node:crypto';
import supabase from './supabase.js';

// Lease length. Must comfortably exceed the heartbeat interval, and
// should exceed a normal sweep so a slow-but-alive sweep is never
// mistaken for a dead one on the strength of one missed heartbeat.
export const LOCK_TTL_SEC = parseInt(process.env.LOCK_TTL_SEC || '300', 10);

// How often a holder extends its lease. A third of the TTL means two
// consecutive heartbeats can be lost before the lease lapses.
export const LOCK_HEARTBEAT_MS = Math.max(
  5000,
  Math.floor((LOCK_TTL_SEC * 1000) / 3)
);

// Identifies this process in lp_sync_lock.holder. Railway exposes the
// deployment id, which makes "which container held it" answerable
// straight from the table during a deploy-overlap incident.
const PROCESS_TAG = [
  process.env.RAILWAY_DEPLOYMENT_ID || process.env.RAILWAY_REPLICA_ID || 'local',
  process.pid,
].join(':');

/**
 * Try to take `key`. Resolves to a handle; check `.acquired`.
 *
 * A caller that does not get the lock must SKIP — not queue, not wait,
 * and above all not open lp_sync_log rows. A queued second sweep would
 * reintroduce exactly the overlap this is here to remove, and a
 * skipped-but-logged sweep would put phantom rows in the health metric.
 */
export async function acquireSyncLock(key, { ttlSec = LOCK_TTL_SEC } = {}) {
  const holder = `${PROCESS_TAG}:${randomUUID().slice(0, 8)}`;

  if (!supabase) {
    console.warn(`[SyncLock] Supabase unavailable — proceeding WITHOUT cross-process lock on "${key}" (in-memory guard only)`);
    return makeHandle({ key, holder, acquired: true, degraded: true });
  }

  try {
    const { data, error } = await supabase.rpc('lp_acquire_sync_lock', {
      p_key: key, p_holder: holder, p_ttl_sec: ttlSec,
    });
    if (error) throw error;

    // The function RETURNs true on a win and no row at all on a loss, so
    // anything falsy means someone else holds a live lease.
    if (data !== true) {
      return makeHandle({ key, holder, acquired: false, degraded: false });
    }

    const handle = makeHandle({ key, holder, acquired: true, degraded: false });
    handle._timer = setInterval(() => heartbeat(handle, ttlSec), LOCK_HEARTBEAT_MS);
    // Never hold the event loop open on the heartbeat alone.
    handle._timer.unref?.();
    return handle;
  } catch (err) {
    // See FAIL-OPEN above.
    console.error(`[SyncLock] Acquire failed for "${key}": ${err.message} — proceeding WITHOUT cross-process lock (in-memory guard only)`);
    return makeHandle({ key, holder, acquired: true, degraded: true });
  }
}

async function heartbeat(handle, ttlSec) {
  if (!handle.acquired || handle.released || handle.degraded) return;
  try {
    const { data, error } = await supabase.rpc('lp_heartbeat_sync_lock', {
      p_key: handle.key, p_holder: handle.holder, p_ttl_sec: ttlSec,
    });
    if (error) throw error;
    if (data !== true) {
      // Our lease lapsed and someone else has the lock. Say so loudly —
      // it means a sweep ran longer than its lease, which is a real
      // finding about sweep duration, not a lock bug.
      console.warn(`[SyncLock] Lost lease on "${handle.key}" — another worker holds it now. This sweep outran its ${ttlSec}s lease.`);
      handle.lost = true;
      clearInterval(handle._timer);
    }
  } catch (err) {
    console.warn(`[SyncLock] Heartbeat failed for "${handle.key}": ${err.message}`);
  }
}

function makeHandle({ key, holder, acquired, degraded }) {
  return {
    key, holder, acquired, degraded,
    lost: false,
    released: false,
    _timer: null,
    async release() {
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      if (this.released || !this.acquired || this.degraded) { this.released = true; return; }
      this.released = true;
      try {
        await supabase.rpc('lp_release_sync_lock', { p_key: this.key, p_holder: this.holder });
      } catch (err) {
        // Non-fatal by design: an unreleased lease expires on its own.
        console.warn(`[SyncLock] Release failed for "${this.key}": ${err.message} — lease will expire in ≤${LOCK_TTL_SEC}s`);
      }
    },
  };
}
