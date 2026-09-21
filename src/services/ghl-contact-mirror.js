/**
 * Contact lookup against the HL contacts mirror — src/services/ghl-contact-mirror.js
 *
 * ONE job: given a phone, return the GHL contact id the HL Supabase mirror holds
 * for it — WITHOUT touching the GoHighLevel API.
 *
 * ─── WHY THIS EXISTS (2026-09-21) ───────────────────────────────────────────
 * POST /intake/ap-resolve timed out on four consecutive live probes, every one
 * at the 1200ms ceiling. The obvious reading — "GHL's search is slow" — was
 * WRONG, and acting on it (just raising the ceiling) would have shipped a fix
 * that fails precisely when the system is busy.
 *
 * Measured at a 5000ms ceiling with the bucket healthy
 * (/n8n/rate-limiter/stats: tokens=100/120, queueDepth=0):
 *
 *   unknown number, full GHL search + miss    101ms, 112ms, 114ms
 *   known number, GHL search + match          137ms, 270ms
 *
 * The search is fast. What was slow is `acquireToken()` — ghlFetch draws on the
 * SAME process-wide token bucket as the action executor (src/ghl-rate-limiter.js).
 * The probes landed while the executor was mid-batch: the logs for that window
 * read `20 executed ... [budget exhausted] (61464ms)` and
 * `limiter alert sent — 12 token timeouts since last check`. The intake request
 * was not waiting on GoHighLevel, it was queued behind our own executor.
 *
 * That is why the ceiling is not the fix. ActiveProspect's leads arrive all day,
 * the executor runs all day, and a lead that arrives during a batch is exactly
 * the lead we would lose the id for. This module removes intake from that
 * contention entirely:
 *
 *   - It spends no GHL token, so executor load cannot delay it.
 *   - It spends no GHL REQUEST either, so every AP lead it answers gives the
 *     shared bucket one more token for everything else.
 *
 * ─── WHY THE MIRROR IS TRUSTWORTHY ENOUGH ───────────────────────────────────
 * Verified 2026-09-21: 25,577 contacts, 24,560 with a phone, and
 * `idx_contacts_phone10` already exists — a functional btree on exactly this
 * expression, so the lookup is index-backed rather than a scan. Freshness was
 * checked against the clock, not assumed: contact TxYo2aOwRkQIBrBYl5Ld, created
 * by an addLead at 16:21:43, was already in the mirror four minutes later.
 *
 * It is still a mirror, so this is a FIRST TIER and never the only one. A miss
 * falls through to the live GHL search, which is what ran before this module
 * existed. The mirror can only ever save a round trip; it can never be the
 * reason a contact is missed.
 *
 * ─── THE RULE, INHERITED FROM ghl-contact-resolve.js ────────────────────────
 *   creating a duplicate contact is a recoverable annoyance;
 *   stamping one lead's identity onto a different person is not.
 *
 * So: last-10-digit exact match only, shape-checked, and two rows REFUSE rather
 * than pick. Every uncertain path returns null.
 */

import { hlRunSQL, esc } from '../admin/hl-client.js';
import { normalizePhone } from '../sync-utils.js';
import { GHL_CONTACT_ID_PATTERN } from '../ghl-link-shape.js';

/** Network seam, per CLAUDE.md — so this unit-tests without a live Supabase. */
export const DEFAULT_DEPS = { hlRunSQL };

/**
 * Last 10 digits of a phone, or '' when there are not 10 to take.
 *
 * The same normalization the rest of the repo uses: GHL stores '+13524453161'
 * and LP stores '3524453161', so only the last 10 digits compare (measured
 * 2026-09-18 — comparing full strings matched 0 of 344).
 */
export function phone10(phone) {
  const digits = String(normalizePhone(phone) || '').replace(/[^0-9]/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

/**
 * The mirror's answer for a phone, or null.
 *
 * null means "ask GoHighLevel" — it is returned for a miss, for an unreadable
 * mirror, for an id that does not look like a GHL id, and for ambiguity. It
 * never means "no such contact".
 *
 * @returns {Promise<string|null>} a GHL contact id, or null
 */
export async function findContactIdByPhone(phone, { deps = DEFAULT_DEPS, log = console } = {}) {
  const p10 = phone10(phone);
  if (!p10) return null;

  let rows;
  try {
    // LIMIT 2 is the whole ambiguity check: we need to know whether a SECOND
    // contact holds this number, and nothing beyond that.
    rows = await deps.hlRunSQL(
      `SELECT ghl_contact_id
         FROM contacts
        WHERE deleted_at IS NULL
          AND right(regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g'), 10) = '${esc(p10)}'
        LIMIT 2`,
    );
  } catch (err) {
    // A mirror we cannot read is not evidence of anything. Fall through to the
    // live search rather than treating an outage as "no contact exists".
    log.warn?.(`[GhlMirror] read failed for ${p10}: ${err.message} — falling through to GHL`);
    return null;
  }

  const ids = (Array.isArray(rows) ? rows : [])
    .map((r) => r?.ghl_contact_id)
    .filter((id) => typeof id === 'string' && GHL_CONTACT_ID_PATTERN.test(id));

  if (ids.length === 0) return null;

  if (ids.length > 1) {
    // Two live contacts share this number. Picking one here would be a guess,
    // and a guess is the one thing this path must never make. Falling through
    // leaves the decision exactly where it was before this module existed.
    log.warn?.(`[GhlMirror] ${p10} matches ${ids.length} contacts — refusing to pick, falling through to GHL`);
    return null;
  }

  return ids[0];
}
