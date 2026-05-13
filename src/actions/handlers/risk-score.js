/**
 * Risk Score Handler — src/actions/handlers/risk-score.js
 *
 * Phase 1 #54 — Intake/Routing Layer risk scoring + bucket classification.
 *
 * Computes a 0-100 composite risk score per contact from 4 weighted inputs,
 * then classifies the contact into Bucket A / B / C for downstream routing.
 *
 * INPUTS (locked weights — DO NOT change without explicit Mark approval)
 * ─────────────────────────────────────────────────────────────────────
 *   40% — Decay (engagement recency)
 *         engagement_summary.decay_score (0-1) from #53.
 *         Absent row → 0 (cold by definition).
 *
 *   25% — Deliverability
 *         Binary-ish: bounce / invalid-email tag → 0.1.
 *         email_enrichment_log most recent confidence → that value.
 *         Otherwise 0.6 (unknown, slight optimism).
 *         Missing email entirely → 0.0.
 *
 *   15% — Age (newness in funnel)
 *         EXP(-days_since_lp_created / 180). Half-life 180 days.
 *         30d: 0.89  180d: 0.50  365d: 0.25  730d: 0.06
 *
 *   20% — Intent
 *         lead_intelligence.intent_score (0-100) → /100.
 *         Missing row → 0.
 *
 * COMPOSITE
 * ─────────
 *   score = ROUND(100 * (0.40*decay + 0.25*deliver + 0.15*age + 0.20*intent))
 *
 * CLASSIFICATION
 * ──────────────
 *   'warm_dormant'   (Bucket A) — score >= 50           → S4.5 Agentic Seinfeld
 *   'cold_valid'     (Bucket B) — 15 <= score < 50      → S1.2 Calculator Re-engagement
 *   'dangerous_dead' (Bucket C) — score < 15            → Quarantine
 *
 *   Hard override: if deliverability <= 0.1 (bounce / invalid / no-email),
 *   force 'dangerous_dead' regardless of composite. A reachable contact is
 *   the necessary condition for resurrection — without that, no other
 *   signal matters.
 *
 * OUTPUTS
 * ───────
 *   Upserts contact_risk_scores row with score, components jsonb, and
 *   classification. expires_at = NOW() + 7 days (re-score weekly during
 *   active campaigns; on-demand outside).
 *
 *   Applies tag risk:{a|b|c} for fast GHL-side filtering.
 *
 * ACTION PAYLOAD
 * ──────────────
 *   {
 *     refresh_engagement_first?: boolean   // default false — caller pre-refreshes for batch
 *     ttl_days?: number                    // default 7
 *   }
 *
 * RETURNS (execution_result)
 *   {
 *     score: 0-100,
 *     classification: 'warm_dormant'|'cold_valid'|'dangerous_dead',
 *     bucket: 'A'|'B'|'C',
 *     components: { decay, deliverability, age, intent },
 *     reasoning: string
 *   }
 */

import supabase from '../../supabase.js';
import { ghlFetch } from '../helpers.js';
import { refreshEngagementSummary } from '../../jobs/refresh-engagement-summary.js';

// ── LOCKED WEIGHTS — do not change without explicit approval ─────────
const W_DECAY         = 0.40;
const W_DELIVERABILITY = 0.25;
const W_AGE           = 0.15;
const W_INTENT        = 0.20;

const AGE_HALF_LIFE_DAYS = 180;

// ── Classification thresholds (composite 0-100) ──────────────────────
const SCORE_WARM_THRESHOLD = 50;
const SCORE_COLD_THRESHOLD = 15;

// ── Tags ──────────────────────────────────────────────────────────────
const TAG_BUCKET_A = 'risk:a';
const TAG_BUCKET_B = 'risk:b';
const TAG_BUCKET_C = 'risk:c';
const BUCKET_TAGS = [TAG_BUCKET_A, TAG_BUCKET_B, TAG_BUCKET_C];

// ── Deliverability hard-fail tag set ──────────────────────────────────
// Presence of any of these forces deliverability = 0.1 and classification = C.
const HARD_DELIVERY_FAIL_TAGS = [
  'lp-bounced',
  'email-bounced',
  'email-invalid',
  'email-undeliverable',
  'lp-related-dnc',
  'unsubscribed',
];

/**
 * Read engagement_summary.decay_score for a contact.
 * Returns 0 if no row.
 */
async function getDecayScore(ghlContactId) {
  const { data } = await supabase
    .from('engagement_summary')
    .select('decay_score, last_engagement_at, refreshed_at')
    .eq('ghl_contact_id', ghlContactId)
    .maybeSingle();
  if (!data) return { score: 0, source: 'no_engagement_summary_row' };
  return {
    score: Number(data.decay_score ?? 0),
    last_engagement_at: data.last_engagement_at,
    refreshed_at: data.refreshed_at,
    source: 'engagement_summary',
  };
}

/**
 * Compute deliverability score from live GHL contact tags + enrichment log.
 *
 * @param {object} contact — GHL contact object (already fetched)
 * @returns {Promise<{score:number, reason:string, hard_fail:boolean}>}
 */
async function getDeliverabilityScore(ghlContactId, contact) {
  const email = (contact?.email || '').trim().toLowerCase();
  const tags = Array.isArray(contact?.tags) ? contact.tags : [];

  // Missing email → 0
  if (!email || !email.includes('@')) {
    return { score: 0.0, reason: 'no_email', hard_fail: true };
  }
  // Placeholder emails
  const placeholders = ['fake@gmail.com'];
  if (placeholders.includes(email) || email.endsWith('@noemail.com') || email.endsWith('@invalid.com')) {
    return { score: 0.0, reason: 'placeholder_email', hard_fail: true };
  }

  // Hard-fail tags
  const matchedFail = tags.find(t => HARD_DELIVERY_FAIL_TAGS.includes(t));
  if (matchedFail) {
    return { score: 0.1, reason: `tag:${matchedFail}`, hard_fail: true };
  }

  // Latest enrichment confidence (if any)
  const { data: enrichRow } = await supabase
    .from('email_enrichment_log')
    .select('confidence_score, action_taken, created_at')
    .eq('ghl_contact_id', ghlContactId)
    .order('created_at', { ascending: false })
    .limit(1);
  const latest = enrichRow?.[0];
  if (latest?.confidence_score != null) {
    return {
      score: Number(latest.confidence_score),
      reason: `enrichment:${latest.action_taken}`,
      hard_fail: false,
    };
  }

  // Default — unknown, slight optimism
  return { score: 0.6, reason: 'no_enrichment_record_default', hard_fail: false };
}

/**
 * Compute age score from earliest lp_lead row for this contact.
 */
async function getAgeScore(ghlContactId) {
  const { data } = await supabase
    .from('lp_leads')
    .select('created_at_lp')
    .eq('ghl_contact_id', ghlContactId)
    .not('created_at_lp', 'is', null)
    .order('created_at_lp', { ascending: true })
    .limit(1);
  const row = data?.[0];
  if (!row?.created_at_lp) {
    return { score: 0.5, days_old: null, reason: 'no_lp_record' };
  }
  const daysOld = (Date.now() - new Date(row.created_at_lp).getTime()) / (86400 * 1000);
  const score = Math.exp(-daysOld / AGE_HALF_LIFE_DAYS);
  return {
    score: Number(score.toFixed(4)),
    days_old: Math.round(daysOld),
    reason: 'lp_created_at',
  };
}

/**
 * Read intent_score from lead_intelligence (0-100 → 0-1).
 */
async function getIntentScore(ghlContactId) {
  const { data } = await supabase
    .from('lead_intelligence')
    .select('intent_score, intent_tier, last_high_intent_at')
    .eq('ghl_contact_id', ghlContactId)
    .maybeSingle();
  if (!data || data.intent_score == null) {
    return { score: 0, tier: null, reason: 'no_intelligence_row' };
  }
  return {
    score: Math.max(0, Math.min(1, Number(data.intent_score) / 100)),
    tier: data.intent_tier,
    last_high_intent_at: data.last_high_intent_at,
    reason: 'lead_intelligence.intent_score',
  };
}

/**
 * Apply the appropriate risk:{a|b|c} tag to the contact, removing any
 * conflicting bucket tags first. Best-effort — failure doesn't change
 * the classification decision.
 */
async function applyBucketTag(ghlContactId, bucket, currentTags) {
  const targetTag = bucket === 'A' ? TAG_BUCKET_A
                  : bucket === 'B' ? TAG_BUCKET_B
                  : TAG_BUCKET_C;
  try {
    // Remove conflicting bucket tags
    const conflicting = (currentTags || []).filter(t => BUCKET_TAGS.includes(t) && t !== targetTag);
    if (conflicting.length > 0) {
      await ghlFetch('DELETE', `/contacts/${ghlContactId}/tags`, { tags: conflicting });
    }
    // Add the target tag
    if (!currentTags?.includes(targetTag)) {
      await ghlFetch('POST', `/contacts/${ghlContactId}/tags`, { tags: [targetTag] });
    }
  } catch (err) {
    console.warn(`[risk-score] bucket tag ${targetTag} on ${ghlContactId} failed: ${err.message}`);
  }
}

export async function executeComputeRiskScore(action) {
  const contactId = action.target_id;
  if (!contactId) throw new Error('Missing contactId');

  const params = action.action_payload || {};
  const refreshFirst = params.refresh_engagement_first === true;
  const ttlDays = Number.isFinite(params.ttl_days) ? params.ttl_days : 7;

  // ── 1. Optionally refresh engagement first ─────────────────────
  if (refreshFirst) {
    try {
      await refreshEngagementSummary({ mode: 'targeted', contact_ids: [contactId] });
    } catch (err) {
      console.warn(`[risk-score] engagement refresh failed for ${contactId}: ${err.message} — using stale/absent data`);
    }
  }

  // ── 2. Fetch live GHL contact (one call, used by 2 inputs) ────
  let contact;
  try {
    const resp = await ghlFetch('GET', `/contacts/${contactId}`);
    contact = resp?.contact || resp || null;
  } catch (err) {
    throw new Error(`risk-score fetch failed for ${contactId}: ${err.message}`);
  }
  if (!contact) {
    throw new Error(`Contact ${contactId} not found in GHL`);
  }

  // ── 3. Gather all 4 component scores in parallel ──────────────
  const [decay, deliv, age, intent] = await Promise.all([
    getDecayScore(contactId),
    getDeliverabilityScore(contactId, contact),
    getAgeScore(contactId),
    getIntentScore(contactId),
  ]);

  // ── 4. Composite ──────────────────────────────────────────────
  const composite01 = (
    W_DECAY * decay.score +
    W_DELIVERABILITY * deliv.score +
    W_AGE * age.score +
    W_INTENT * intent.score
  );
  let score = Math.round(composite01 * 100);
  score = Math.max(0, Math.min(100, score));

  // ── 5. Classify with hard-deliverability override ─────────────
  let classification, bucket;
  if (deliv.hard_fail) {
    classification = 'dangerous_dead';
    bucket = 'C';
  } else if (score >= SCORE_WARM_THRESHOLD) {
    classification = 'warm_dormant';
    bucket = 'A';
  } else if (score >= SCORE_COLD_THRESHOLD) {
    classification = 'cold_valid';
    bucket = 'B';
  } else {
    classification = 'dangerous_dead';
    bucket = 'C';
  }

  // ── 6. Persist to contact_risk_scores ─────────────────────────
  const components = {
    decay:           { value: decay.score,  weight: W_DECAY,         source: decay.source },
    deliverability:  { value: deliv.score,  weight: W_DELIVERABILITY, reason: deliv.reason, hard_fail: deliv.hard_fail },
    age:             { value: age.score,    weight: W_AGE,           days_old: age.days_old, reason: age.reason },
    intent:          { value: intent.score, weight: W_INTENT,        tier: intent.tier, reason: intent.reason },
  };
  const expiresAt = new Date(Date.now() + ttlDays * 86400 * 1000).toISOString();

  const { error: upsertErr } = await supabase
    .from('contact_risk_scores')
    .upsert({
      ghl_contact_id: contactId,
      score,
      components,
      classification,
      computed_at: new Date().toISOString(),
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'ghl_contact_id' });

  if (upsertErr) {
    console.warn(`[risk-score] upsert failed for ${contactId}: ${upsertErr.message}`);
    // Continue — return the computed result even if persistence failed
  }

  // ── 7. Apply bucket tag (best-effort) ─────────────────────────
  await applyBucketTag(contactId, bucket, contact.tags || []);

  const reasoning =
    `decay=${decay.score.toFixed(2)} (40%), deliv=${deliv.score.toFixed(2)} (25%, ${deliv.reason}), ` +
    `age=${age.score.toFixed(2)} (15%, ${age.days_old}d), intent=${intent.score.toFixed(2)} (20%, ${intent.tier || 'none'}) ` +
    `→ score=${score} → bucket ${bucket} (${classification})` +
    (deliv.hard_fail ? ' [hard_fail override]' : '');

  console.log(`[risk-score] ${contactId} → ${score}/${classification} | ${reasoning}`);

  return {
    score,
    classification,
    bucket,
    components,
    reasoning,
    expires_at: expiresAt,
    contact_id: contactId,
  };
}
