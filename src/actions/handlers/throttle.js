/**
 * Throttle Check Handler — src/actions/handlers/throttle.js
 *
 * Phase 1 #55 — Intake/Routing Layer enrollment throttle gate.
 *
 * Prevents duplicate enrollment of a contact in the same campaign within a
 * configurable rolling window. Reads resurrection_enrollment_log and counts
 * matching prior enrollments by (ghl_contact_id, throttle_key).
 *
 * THROTTLE KEYS
 * ─────────────
 *   Free-form strings keyed per campaign type. Recommended convention:
 *     'resurrection:s1_2'      — Bucket B Calculator Re-engagement
 *     'resurrection:s4_5'      — Bucket A Agentic Seinfeld
 *     'resurrection:quarantine' — Bucket C (sticky cooldown)
 *     'reactivation:rebook'    — Re-attempt booking after no-show
 *
 *   Throttle keys are written by classify_bucket (#56) AND by this handler
 *   when it records an enrollment attempt. See action_payload.record below.
 *
 * ACTION PAYLOAD
 * ──────────────
 *   {
 *     throttle_key:    string          // REQUIRED — campaign type
 *     window_days?:    number          // default 30
 *     max_enrollments?: number         // default 1 — usually we want 1 per window
 *     record?:         boolean         // if true, INSERT an enrollment row on pass
 *     bucket?:         'A'|'B'|'C'     // required if record=true
 *     target_workflow_id?: string      // required if record=true (for the log)
 *     phase_marker?:   string          // optional — e.g. 'phase_1_500_cap'
 *   }
 *
 * RETURNS (execution_result)
 *   {
 *     throttled:        boolean,
 *     count_in_window:  number,
 *     window_days:      number,
 *     last_enrolled_at: timestamp|null,
 *     last_workflow_id: string|null,
 *     recorded:         boolean,  // true if we INSERTed a new log row
 *     contact_id, throttle_key
 *   }
 *
 *   throttled=true → downstream actions in the batch should NOT proceed
 *   (the batch executor short-circuits on first failed action). To enforce
 *   that, this handler RETURNS the result and lets the batch decision
 *   stay with the rule. For now, a non-throttled pass is "completed" and
 *   a throttled pass is also "completed" — the caller checks the result.
 *
 *   This handler does NOT throw on throttle hit. Throwing would mark the
 *   action 'failed' and trigger retries, which would re-check throttle
 *   and stay throttled. Better: return cleanly with throttled=true so the
 *   audit trail shows the gate fired.
 *
 * SAFETY
 * ──────
 *   Fail-OPEN on read errors (network/db hiccup) — better to occasionally
 *   re-enroll than to silently halt the entire batch. Phase 1 dry-run will
 *   catch any duplicates before scaling.
 *
 *   Idempotency: when record=true, the INSERT uses an idempotency_key
 *   composed of (contact_id|throttle_key|day_bucket) so retries of the
 *   same action don't double-log.
 */

import supabase from '../../supabase.js';
import crypto from 'node:crypto';

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_MAX_ENROLLMENTS = 1;

function buildIdempotencyKey({ contactId, throttleKey }) {
  const dayBucket = new Date().toISOString().slice(0, 10);
  return crypto
    .createHash('sha256')
    .update(`enroll:${contactId}:${throttleKey}:${dayBucket}`)
    .digest('hex')
    .slice(0, 32);
}

export async function executeCheckThrottle(action) {
  const contactId = action.target_id;
  if (!contactId) throw new Error('Missing contactId');

  const params = action.action_payload || {};
  const throttleKey = params.throttle_key;
  if (!throttleKey) throw new Error('Missing throttle_key in action_payload');

  const windowDays = Number.isFinite(params.window_days) ? params.window_days : DEFAULT_WINDOW_DAYS;
  const maxEnrollments = Number.isFinite(params.max_enrollments) ? params.max_enrollments : DEFAULT_MAX_ENROLLMENTS;
  const shouldRecord = params.record === true;

  // ── 1. Count prior enrollments in window ──────────────────────
  const sinceIso = new Date(Date.now() - windowDays * 86400 * 1000).toISOString();
  const { data: priorRows, error: countErr } = await supabase
    .from('resurrection_enrollment_log')
    .select('id, enrolled_at, bucket, target_workflow_id, phase_marker', { count: 'exact' })
    .eq('ghl_contact_id', contactId)
    .eq('throttle_key', throttleKey)
    .gte('enrolled_at', sinceIso)
    .order('enrolled_at', { ascending: false });

  if (countErr) {
    console.warn(`[check-throttle] read failed for ${contactId} key=${throttleKey}: ${countErr.message} — failing open`);
    return {
      throttled: false,
      count_in_window: 0,
      window_days: windowDays,
      last_enrolled_at: null,
      last_workflow_id: null,
      recorded: false,
      open_due_to_error: true,
      error: countErr.message,
      contact_id: contactId,
      throttle_key: throttleKey,
    };
  }

  const countInWindow = priorRows?.length || 0;
  const throttled = countInWindow >= maxEnrollments;
  const latest = priorRows?.[0];

  // ── 2. Optionally record a new enrollment intent ──────────────
  let recorded = false;
  let recordedRow = null;
  if (!throttled && shouldRecord) {
    if (!params.bucket || !params.target_workflow_id) {
      console.warn(
        `[check-throttle] record=true but missing bucket / target_workflow_id for ${contactId} key=${throttleKey} — skipping record`
      );
    } else {
      const idemKey = buildIdempotencyKey({ contactId, throttleKey });
      const { data: insertRow, error: insertErr } = await supabase
        .from('resurrection_enrollment_log')
        .upsert({
          ghl_contact_id: contactId,
          bucket: params.bucket,
          target_workflow_id: params.target_workflow_id,
          enrolled_at: new Date().toISOString(),
          phase_marker: params.phase_marker || null,
          enrollment_source: 'agentic_classify',
          throttle_key: throttleKey,
          idempotency_key: idemKey,
        }, { onConflict: 'idempotency_key' })
        .select()
        .single();
      if (insertErr) {
        console.warn(`[check-throttle] enrollment log insert failed for ${contactId}: ${insertErr.message}`);
      } else {
        recorded = true;
        recordedRow = insertRow;
      }
    }
  }

  console.log(
    `[check-throttle] ${contactId} key=${throttleKey} ` +
    `count=${countInWindow}/${maxEnrollments} window=${windowDays}d ` +
    `throttled=${throttled} recorded=${recorded}`
  );

  return {
    throttled,
    count_in_window: countInWindow,
    window_days: windowDays,
    max_enrollments: maxEnrollments,
    last_enrolled_at: latest?.enrolled_at || null,
    last_workflow_id: latest?.target_workflow_id || null,
    recorded,
    recorded_id: recordedRow?.id || null,
    contact_id: contactId,
    throttle_key: throttleKey,
  };
}
