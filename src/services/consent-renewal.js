/**
 * Consent renewal guard — src/services/consent-renewal.js
 *
 * Pure predicates for Phase 2 "re-entry = new consent" (2026-07-24). Kept
 * dependency-free (no supabase / ghl / node_modules) so the compliance-
 * critical boundary can be unit-tested in isolation — mirrors the
 * lp-probe-safety.js pattern. The emit + interception live in sync-leads.js;
 * only the decision logic lives here.
 *
 * A DNC disposition normally drives LP_DISP_DNC + RECONCILE (suppression). But
 * when a NEW consumer-initiated inbound (estimator form / chatbot) lands on a
 * prospect who was DNC from PRIOR history, that inbound is a fresh, express-
 * consent inquiry — the lead is "born DNC" only because it inherited the
 * prospect's old flag (ref incident: Max Lesser, LP lead 561019 / prospect
 * 447640, suppressed before the opener landed).
 *
 * Compliance: renewal is defensible ONLY because inbound web forms carry
 * express-consent language (TCPA prior express written consent). DNC history is
 * never silently deleted — sync-leads.js emits consent.reestablished (the audit
 * trail) and CONSENT_RENEWAL_ON_REENTRY clears the stack.
 */

// Consumer-initiated inbound source buckets that carry per-lead express
// consent. Excludes rep-created opps, Five9, resellers/aggregators ("other"),
// referral, canvassing, high-intent-digital (mixed rep-entered) — none of
// which carry a form-level consent record. Configurable via env.
export const CONSENT_RENEWAL_SOURCE_BUCKETS = new Set(
  (process.env.CONSENT_RENEWAL_SOURCE_BUCKETS || 'estimate-calculator,chatbot')
    .split(',').map(s => s.trim()).filter(Boolean)
);

// An old DNC lead first surfacing on a full/backfill sync is NOT new consent.
// Only a freshly-created inbound (within this window) counts.
export const CONSENT_RENEWAL_MAX_AGE_DAYS =
  parseInt(process.env.CONSENT_RENEWAL_MAX_AGE_DAYS || '3', 10);

// Kill switch — set CONSENT_RENEWAL_ENABLED=false to fall back to the pre-Phase-2
// behavior (DNC disposition always emits, never converted to consent).
export const CONSENT_RENEWAL_ENABLED = process.env.CONSENT_RENEWAL_ENABLED !== 'false';

export function isRecentInbound(createdAt) {
  if (!createdAt) return false;
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return false;
  const ageMs = Date.now() - t;
  if (ageMs < 0) return true; // clock skew / future-dated — treat as fresh
  return ageMs <= CONSENT_RENEWAL_MAX_AGE_DAYS * 86_400_000;
}

/**
 * True when a DNC disposition should be treated as a consent RE-ENTRY (a new
 * inbound on a previously-DNC prospect) rather than a suppression signal.
 *
 * Fires ONLY when ALL hold:
 *   1. newDisposition === 'DNC' — the only disposition we intercept.
 *   2. existing === null (FIRST APPEARANCE of this lead). A re-read of an
 *      already-synced lead is NOT new consent — this protects a valid
 *      post-inbound STOP revocation (Max texted STOP 2026-07-23; his lead
 *      already exists, so re-syncs never re-lift him).
 *   3. consumer-initiated inbound source bucket (estimate-calculator/chatbot).
 *   4. recent createdAt (within CONSENT_RENEWAL_MAX_AGE_DAYS).
 *
 * @param {Object}      ctx
 * @param {Object|null} ctx.existing        cached lp_leads row (null = first sight)
 * @param {string|null} ctx.newDisposition  incoming LP disposition code
 * @param {string}      ctx.bucket          resolved source bucket
 * @param {string|null} ctx.createdAt       lead creation timestamp (ISO)
 * @returns {boolean}
 */
export function shouldRenewConsent({ existing, newDisposition, bucket, createdAt }) {
  if (!CONSENT_RENEWAL_ENABLED) return false;
  if (String(newDisposition || '').trim() !== 'DNC') return false;
  if (existing) return false;                                   // first appearance only
  if (!CONSENT_RENEWAL_SOURCE_BUCKETS.has(bucket)) return false; // consumer inbound only
  if (!isRecentInbound(createdAt)) return false;                // not an old-lead backfill
  return true;
}
