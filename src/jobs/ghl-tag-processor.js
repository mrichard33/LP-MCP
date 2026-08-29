/**
 * src/jobs/ghl-tag-processor.js
 *
 * Drains ghl_tag_inbox and runs the real tag-diff work.
 *
 * Added 2026-08-29 (Project 2 — GHL tag webhook durability). See the header
 * of src/ghl-tag-handler.js for why the work moved out of the request cycle.
 *
 * ORDERING
 * ────────
 * Rows are processed oldest-first, and sequentially. This is not incidental:
 * the diff is stateful — each update is compared against the snapshot the
 * previous one left behind. Processing two updates for the same contact out
 * of order, or concurrently, would emit a tag_removed for a tag that was
 * never removed. The failure data shows this is a real pattern, not a
 * theoretical one: one contact took five tag updates in seven seconds.
 *
 * FAILURE HANDLING
 * ────────────────
 * A row that throws is left unprocessed with attempts incremented and the
 * error recorded, so the next tick retries it. That is the whole point of
 * the inbox — a Supabase blip or a Railway cold start costs a retry, not an
 * event.
 *
 * After MAX_ATTEMPTS a row is parked (processed = true, last_error kept) so
 * one poison row cannot block every later update for that contact forever.
 * Parked rows still carry their payload and show up in the daily failure
 * alert's blast radius, so they are visible rather than silently dropped.
 */

import supabase from '../supabase.js';
import { processTagUpdate } from '../ghl-tag-handler.js';

/** How often the worker wakes. Override: GHL_TAG_PROCESSOR_INTERVAL_MS. */
const INTERVAL_MS = parseInt(
  process.env.GHL_TAG_PROCESSOR_INTERVAL_MS || `${15 * 1000}`, 10
);

/** Rows per tick. Tag traffic is ~10-20 kept events/day; this is headroom. */
const BATCH_SIZE = parseInt(
  process.env.GHL_TAG_PROCESSOR_BATCH_SIZE || '200', 10
);

/**
 * Give up on a row after this many failures. 5 x the retry interval is
 * several minutes of transient tolerance, well past a cold start or a
 * Supabase hiccup, while still bounded.
 */
const MAX_ATTEMPTS = parseInt(
  process.env.GHL_TAG_PROCESSOR_MAX_ATTEMPTS || '5', 10
);

let intervalHandle = null;
let running = false;

/**
 * Process one batch of pending inbox rows.
 *
 * @returns {Promise<{processed: number, failed: number, parked: number, deferred: number, errors: string[]}>}
 */
export async function processTagInbox({ limit = BATCH_SIZE } = {}) {
  const { data: rows, error } = await supabase
    .from('ghl_tag_inbox')
    .select('id, ghl_contact_id, tags, occurred_at, attempts')
    .eq('processed', false)
    .lt('attempts', MAX_ATTEMPTS)
    .order('received_at', { ascending: true })
    .limit(limit);

  if (error) {
    console.error(`[GhlTagProcessor] fetch error: ${error.message}`);
    return { processed: 0, failed: 0, parked: 0, deferred: 0, errors: [error.message] };
  }

  if (!rows?.length) {
    return { processed: 0, failed: 0, parked: 0, deferred: 0, errors: [] };
  }

  let processed = 0;
  let failed = 0;
  let parked = 0;
  let deferred = 0;
  const errors = [];

  /**
   * Contacts whose oldest pending update failed this pass.
   *
   * Ordering is per-contact, so a failure has to hold the line for that
   * contact only. Without this, a row that failed would be retried on the
   * next tick AFTER its successor had already advanced the snapshot — and
   * the retry would then diff a stale tag set against a newer one and emit
   * the difference as removals. That is the same backwards-diff that makes
   * naive replay destructive; it must not be reachable from a transient
   * Supabase error either.
   *
   * Deferred rows are left untouched — no attempts increment — so a slow
   * upstream cannot burn a healthy row's retry budget.
   */
  const blocked = new Set();

  // Sequential by design — see ORDERING above.
  for (const row of rows) {
    if (blocked.has(row.ghl_contact_id)) {
      deferred++;
      continue;
    }

    try {
      const result = await processTagUpdate({
        contact_id:  row.ghl_contact_id,
        tags:        row.tags,
        occurred_at: row.occurred_at,
      });

      await supabase
        .from('ghl_tag_inbox')
        .update({
          processed:    true,
          processed_at: new Date().toISOString(),
          attempts:     row.attempts + 1,
          last_error:   null,
        })
        .eq('id', row.id);

      processed++;

      if (result.events_inserted > 0) {
        console.log(
          `[GhlTagProcessor] contact ${row.ghl_contact_id}: ` +
          `+${result.added} -${result.removed}, ${result.events_inserted} event(s) emitted`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const attempts = row.attempts + 1;
      const giveUp = attempts >= MAX_ATTEMPTS;

      await supabase
        .from('ghl_tag_inbox')
        .update({
          attempts,
          last_error: msg,
          ...(giveUp ? { processed: true, processed_at: new Date().toISOString() } : {}),
        })
        .eq('id', row.id);

      if (giveUp) {
        parked++;
        console.error(
          `[GhlTagProcessor] contact ${row.ghl_contact_id}: parked after ` +
          `${attempts} attempts — ${msg}`
        );
        // Parked, so the next update for this contact may proceed. It will
        // diff forward from a snapshot that skipped one transition, which
        // costs an intermediate event but cannot invert the diff.
      } else {
        failed++;
        blocked.add(row.ghl_contact_id);
        console.warn(
          `[GhlTagProcessor] contact ${row.ghl_contact_id}: attempt ${attempts}/${MAX_ATTEMPTS} ` +
          `failed, will retry — ${msg}`
        );
      }
      errors.push(msg);
    }
  }

  return { processed, failed, parked, deferred, errors };
}

async function tick(reason) {
  if (running) {
    // A slow batch is still draining. Skipping is correct: overlapping ticks
    // would break the per-contact ordering the diff depends on.
    return;
  }
  running = true;
  try {
    const result = await processTagInbox();
    if (result.processed || result.failed || result.parked || result.deferred) {
      console.log(
        `[GhlTagProcessor] ${reason}: processed=${result.processed} ` +
        `retrying=${result.failed} parked=${result.parked} deferred=${result.deferred}`
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[GhlTagProcessor] tick threw: ${msg}`);
  } finally {
    running = false;
  }
}

export function startGhlTagProcessor() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => tick('Scheduled run'), INTERVAL_MS);
  // Do not hold the event loop open on shutdown.
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
  console.log(`[GhlTagProcessor] started — interval=${INTERVAL_MS}ms, batch=${BATCH_SIZE}, max_attempts=${MAX_ATTEMPTS}`);
  // Drain anything the previous process left behind.
  tick('Startup sweep');
}

export function stopGhlTagProcessor() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
