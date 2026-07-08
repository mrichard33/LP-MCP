/**
 * Pending-probe TTL sweep — src/admin/pending-probe-ttl-sweep.js
 *
 * Clears stale `pending:customer-status-check` tags from contacts who
 * received the HDL.3 customer-status probe (PR #499) and never answered
 * it. While the tag is on a contact, the intent-classifier v1.2
 * CUSTOMER_STATUS_AFFIRMATIVE/_NEGATIVE gates stay armed — a short
 * "yes"/"no" weeks later about something else entirely could still trip
 * them and misroute the contact to a callback queue. The gates' ≤8-word
 * answer-shape guard bounds the blast radius, but the tag should not
 * linger forever.
 *
 * Routes:
 *   POST /admin/pending-probe-ttl-sweep                — dry run (default)
 *   POST /admin/pending-probe-ttl-sweep?dryRun=false   — live run
 *   POST /admin/pending-probe-ttl-sweep?ttlDays=3      — override TTL
 *
 * Scheduler (opt-in, default OFF — flip on Railway after a manual dry run):
 *   PENDING_PROBE_TTL_SWEEP_ENABLED=true
 *   PENDING_PROBE_TTL_DAYS=7                — expire after N days unanswered
 *   PENDING_PROBE_TTL_SWEEP_INTERVAL_MIN=1440
 *   PENDING_PROBE_TTL_SWEEP_LIMIT=100
 *
 * How it works:
 *   1. Candidates: HL contacts cache rows whose tags contain the pending
 *      tag (same candidate-list-then-live-verify pattern as
 *      admin/guest-visitor-remediation.js).
 *   2. Age: the most recent agent_actions row for the contact whose
 *      execution_result.reason = 'customer_status_probe_sent' — the probe
 *      sender is the ONLY thing that applies this tag, so its action row
 *      is the authoritative primed-at timestamp. A contact with the tag
 *      but NO probe row on record is SKIPPED and logged: never clear a
 *      tag whose age is unknown.
 *   3. Live verify: re-read the contact from GHL before mutating — the
 *      cache is only a candidate list; the lead may have answered (tag
 *      already cleared) since the last sync.
 *   4. Expire: remove ONLY the pending tag. Deliberately NO handoff tag —
 *      tagging hdl:callback-sales days after the lead went silent would
 *      fire I.HDL-1's "a rep will call you" SMS out of nowhere. Going
 *      quiet is answered with quiet; the lead can always text again.
 *   5. GroupMe summary only when something was actually cleared.
 */

import { createClient } from '@supabase/supabase-js';
import supabase from '../supabase.js';
import { ghlFetch } from '../actions/helpers.js';
import { sendGroupMeMessage } from '../groupme.js';
import { CUSTOMER_STATUS_PENDING_TAG } from '../knowledge/callback-resolver.js';

const INTER_CONTACT_DELAY_MS = 600; // same pacing as guest-visitor-remediation
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hlSupabase() {
  const url = process.env.HL_SUPABASE_URL;
  const key = process.env.HL_SUPABASE_SERVICE_ROLE_KEY || process.env.HL_SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

/**
 * Primed-at lookup: the newest action that primed (or re-encountered)
 * the pending tag for this contact. Two shapes count:
 *   - reason = 'customer_status_probe_sent' — the probe SMS went out.
 *   - callback_basis = 'probe_pending_default_sales' — the probe primed
 *     the tag but the send failed and the in-action retry fell back to
 *     sales (the retry overwrites the probe result on the same row), or
 *     the lead asked for another callback while already primed. Either
 *     way the row's timestamp is a valid (conservative) primed-at bound.
 * Returns an ISO timestamp string or null when no such row exists.
 */
async function findProbePrimedAt(contactId) {
  const { data, error } = await supabase
    .from('agent_actions')
    .select('id, created_at')
    .eq('target_id', contactId)
    .eq('action_type', 'send_message')
    .or('execution_result->>reason.eq.customer_status_probe_sent,execution_result->>callback_basis.eq.probe_pending_default_sales')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`agent_actions lookup failed: ${error.message}`);
  return data?.[0]?.created_at || null;
}

/**
 * Run the TTL sweep. Returns a results object with per-contact details.
 */
export async function runPendingProbeTtlSweep({ dryRun = true, ttlDays = null, limit = 100 } = {}) {
  const effectiveTtlDays = Number.isFinite(Number(ttlDays)) && Number(ttlDays) > 0
    ? Number(ttlDays)
    : Math.max(1, parseInt(process.env.PENDING_PROBE_TTL_DAYS || '7', 10));
  const cutoffMs = Date.now() - effectiveTtlDays * 24 * 60 * 60 * 1000;

  const results = {
    dryRun,
    ttl_days: effectiveTtlDays,
    candidates: 0,
    cleared: 0,
    still_fresh: 0,
    answered_since_sync: 0,
    age_unknown_skipped: 0,
    errors: 0,
    details: [],
  };

  const hl = hlSupabase();
  if (!hl) {
    return { ...results, message: 'HL_SUPABASE_URL / HL_SUPABASE_SERVICE_ROLE_KEY not set — sweep skipped' };
  }

  const { data: candidates, error } = await hl
    .from('contacts')
    .select('ghl_contact_id, first_name, last_name, tags')
    .contains('tags', [CUSTOMER_STATUS_PENDING_TAG])
    .is('deleted_at', null)
    .limit(limit);
  if (error) throw new Error(`HL cache query failed: ${error.message}`);

  results.candidates = candidates?.length || 0;
  console.log(`[PendingProbeTTL] ${results.candidates} cache candidate(s) carry ${CUSTOMER_STATUS_PENDING_TAG} (ttl=${effectiveTtlDays}d, dryRun=${dryRun})`);
  if (!candidates?.length) return results;

  for (const row of candidates) {
    const contactId = row.ghl_contact_id;
    if (!contactId) continue;
    const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || contactId;
    await sleep(INTER_CONTACT_DELAY_MS);

    try {
      const primedAt = await findProbePrimedAt(contactId);
      if (!primedAt) {
        // Tag present but no probe row — age unknown. Never clear blind:
        // this either predates the probe pipeline or the tag was applied
        // manually; a human should look at it instead.
        results.age_unknown_skipped++;
        results.details.push({ contactId, name, action: 'skipped_age_unknown' });
        console.warn(`[PendingProbeTTL] ${contactId} carries the pending tag but has no probe-send action on record — skipped (age unknown)`);
        continue;
      }

      if (new Date(primedAt).getTime() > cutoffMs) {
        results.still_fresh++;
        results.details.push({ contactId, name, action: 'still_fresh', primed_at: primedAt });
        continue;
      }

      // Live verify — the cache is only a candidate list.
      const live = await ghlFetch('GET', `/contacts/${contactId}`);
      const liveTags = Array.isArray(live?.contact?.tags) ? live.contact.tags : [];
      if (!liveTags.includes(CUSTOMER_STATUS_PENDING_TAG)) {
        results.answered_since_sync++;
        results.details.push({ contactId, name, action: 'already_cleared_live' });
        continue;
      }

      if (dryRun) {
        results.cleared++;
        results.details.push({ contactId, name, action: 'would_clear', primed_at: primedAt });
        continue;
      }

      await ghlFetch('DELETE', `/contacts/${contactId}/tags`, { tags: [CUSTOMER_STATUS_PENDING_TAG] });
      results.cleared++;
      results.details.push({ contactId, name, action: 'cleared', primed_at: primedAt });
      console.log(`[PendingProbeTTL] cleared stale pending tag from ${contactId} (primed ${primedAt})`);
    } catch (err) {
      results.errors++;
      results.details.push({ contactId, name, action: 'error', error: err.message });
      console.warn(`[PendingProbeTTL] ${contactId} errored: ${err.message}`);
    }
  }

  if (!dryRun && results.cleared > 0) {
    const clearedNames = results.details
      .filter(d => d.action === 'cleared')
      .map(d => d.name)
      .slice(0, 10)
      .join(', ');
    sendGroupMeMessage(
      `🧹 PENDING-PROBE TTL SWEEP\n` +
      `Cleared ${results.cleared} stale ${CUSTOMER_STATUS_PENDING_TAG} tag(s) ` +
      `(unanswered > ${effectiveTtlDays} days): ${clearedNames}${results.cleared > 10 ? ', …' : ''}\n` +
      `These leads never answered the "are you a current customer?" probe. ` +
      `No handoff tag applied — they can text back in any time.`
    ).catch(err => console.warn(`[PendingProbeTTL] GroupMe summary failed: ${err.message}`));
  }

  console.log(`[PendingProbeTTL] Done: ${results.cleared} ${dryRun ? 'would be ' : ''}cleared, ${results.still_fresh} still fresh, ${results.answered_since_sync} answered since sync, ${results.age_unknown_skipped} age-unknown skipped, ${results.errors} errors`);
  return results;
}

// ═══════════════════════════════════════════════════════════════════
// SCHEDULER — daily live sweep, opt-in via env (default OFF).
// Run POST /admin/pending-probe-ttl-sweep (dry run) and review details
// before setting PENDING_PROBE_TTL_SWEEP_ENABLED=true on Railway.
// ═══════════════════════════════════════════════════════════════════

const SWEEP_ENABLED = process.env.PENDING_PROBE_TTL_SWEEP_ENABLED === 'true';
const SWEEP_INTERVAL_MS = Math.max(60, parseInt(process.env.PENDING_PROBE_TTL_SWEEP_INTERVAL_MIN || '1440', 10)) * 60 * 1000;
const SWEEP_LIMIT = parseInt(process.env.PENDING_PROBE_TTL_SWEEP_LIMIT || '100', 10);

export function startPendingProbeTtlSweepScheduler() {
  if (!SWEEP_ENABLED) {
    console.log('[PendingProbeTTL] Scheduler disabled (set PENDING_PROBE_TTL_SWEEP_ENABLED=true to enable daily live sweep)');
    return;
  }
  console.log(`[PendingProbeTTL] Scheduler ENABLED — live sweep every ${SWEEP_INTERVAL_MS / 60000} min, limit ${SWEEP_LIMIT}`);
  // First run 5 minutes after boot (let sync + rate limiter settle), then on interval.
  setTimeout(() => {
    runPendingProbeTtlSweep({ dryRun: false, limit: SWEEP_LIMIT }).catch(e => console.error('[PendingProbeTTL] Sweep failed:', e.message));
    setInterval(() => {
      runPendingProbeTtlSweep({ dryRun: false, limit: SWEEP_LIMIT }).catch(e => console.error('[PendingProbeTTL] Sweep failed:', e.message));
    }, SWEEP_INTERVAL_MS);
  }, 5 * 60 * 1000);
}

/**
 * Register the admin route and start the opt-in scheduler. Same pattern
 * as admin/email-cleanup.js: the scheduler lives here so the feature
 * no-ops unless the env var is set.
 */
export function registerPendingProbeTtlSweepRoutes(app) {
  app.post('/admin/pending-probe-ttl-sweep', async (req, res) => {
    try {
      const dryRun = req.query.dryRun !== 'false';
      const ttlDays = req.query.ttlDays || null;
      const limit = parseInt(req.query.limit || '100', 10);
      const results = await runPendingProbeTtlSweep({ dryRun, ttlDays, limit });
      res.json(results);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  startPendingProbeTtlSweepScheduler();

  console.log('[PendingProbeTTL] Registered: POST /admin/pending-probe-ttl-sweep');
}
