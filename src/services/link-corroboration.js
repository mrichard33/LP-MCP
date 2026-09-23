// ─── LP↔GHL link corroboration resolver ──────────────────────────
//
// Replaces shape-check-only adoption of LP lognumber as ghl_contact_id
// (deriveLeadGhlId) with identity-checked resolution. Every candidate link
// is classified into a ghl_link_source, and the resolver only *binds* a
// lognumber candidate when the GHL contact's phone/email corroborates the
// LP prospect's. Since 2026-09-23 a User1 candidate is tried when lognumber
// is not shape-valid (ActiveProspect leads) — same verification, and it binds
// only on a pass, in either mode (see user1_verified below).
//
// Rollout modes (LP_LINK_CORROBORATION_MODE):
//   observe (default) — full classification runs and persists
//     (ghl_link_source + lp_link_conflicts rows), but the RETURNED contact
//     id is the legacy deriveLeadGhlId result, so sync behavior is
//     bit-identical to pre-resolver. Verification uses the HL Supabase
//     contacts cache only (zero GHL API calls). An observe-mode row can
//     therefore show a bound ghl_contact_id WITH a rejected_* link source —
//     that is the rollout dataset ("what enforce would have done").
//   enforce — the resolver result is authoritative. Step-4 verification
//     uses live GHL reads (token-bucketed, TTL-cached in
//     lp_link_verifications, budget-capped per sync cycle). Cache-sourced
//     verdicts never authorize an enforce-mode link change.
//
// The resolver never unbinds an existing link: rejected_* outcomes refuse
// the NEW bind and return the existing link. Unbinding is the mis-binding
// remediation sweep's job (Part C, explicit admin action).

import { createClient } from '@supabase/supabase-js';
import supabase from '../supabase.js';
import { normalizePhone, getField } from '../sync-utils.js';
import { lognumberCandidate, user1Candidate } from '../ghl-link-shape.js';
import { ghlFetch } from '../actions/helpers.js';

export const LINK_SOURCE = {
  PHONE_EMAIL_MATCH: 'phone_email_match',
  LOGNUMBER_CORROBORATED: 'lognumber_corroborated',
  LOGNUMBER_VERIFIED: 'lognumber_verified',
  EXISTING_PRESERVED: 'existing_preserved',
  REJECTED_UNCORROBORATED: 'rejected_uncorroborated',
  REJECTED_CONFLICT: 'rejected_conflict',
  LEGACY_UNVERIFIED: 'legacy_unverified',
  UNBOUND_REMEDIATION: 'unbound_remediation',
  // 2026-07-29: id arrived on an inbound GHL webhook payload AND was confirmed
  // readable by a live getGHLContact before being persisted (src/rest-api.js).
  // Distinct from legacy_unverified, which that path used to stamp on an
  // entirely unvalidated payload id.
  WEBHOOK_VERIFIED: 'webhook_verified',
  // 2026-09-18: written ONLY by scripts/repair-lp-ghl-links.js, where an open
  // P2 opportunity's contact was matched to an unlinked LP lead on the last 10
  // digits of the phone.
  //
  // Deliberately NOT phone_email_match, even though the evidence is a phone
  // agreement. That value means "matched against GHL via matchToGHL" and
  // carries STRENGTH 3; this one compared the HL contacts MIRROR to lp_leads and
  // never corroborated the candidate against live GHL identity. It therefore
  // falls through linkStrength() to 1, so any later real corroboration displaces
  // it — which is the correct direction for a repair.
  //
  // It is also the audit trail: `SELECT count(*) FROM lp_leads WHERE
  // ghl_link_source = 'phone10_repair'` says exactly what that script did, for
  // as long as the rows exist.
  PHONE10_REPAIR: 'phone10_repair',
  // 2026-09-19: written ONLY by scripts/propagate-prospect-links.js. One LP
  // prospect is one person, so leads under it cannot belong to two different
  // GHL contacts. Where some of a prospect's leads carried a link and its
  // siblings were NULL, the link is copied across — and ONLY when every
  // linked sibling agrees on the same id. A prospect whose leads disagree is
  // the ambiguous case and is refused, never tie-broken.
  //
  // No new evidence is created here: the id is already trusted on a sibling
  // row. So like phone10_repair this falls through linkStrength() to 1 and any
  // later real corroboration displaces it, and it is its own audit trail.
  PROSPECT_PROPAGATED: 'prospect_propagated',
  // 2026-09-19: written ONLY by scripts/repair-dead-link-targets.js, where the
  // GHL contact a lead pointed at is soft-deleted in the mirror. The link does
  // not point at a person any more, so the id is cleared and this stands in its
  // place as the record of why — a NULL id under a stale phone_email_match
  // would claim evidence that no longer exists.
  //
  // Reserved for a target that is GONE. A contact that is merely
  // uncorroboratable (no phone and no email to compare against) is NOT this:
  // that is "could not tell", and a read concluding nothing must never destroy
  // a link. Those rows are reported and left alone.
  TARGET_UNRESOLVABLE: 'target_unresolvable',
  // 2026-09-19: written ONLY by scripts/elect-prospect-links.js, where the
  // leads under one prospect disagreed about their GHL contact and
  // src/prospect-link-election.js elected one on evidence (phone agreement
  // first, then source trust, then how many leads held it). The losing leads
  // are re-pointed at the winner, because one LP prospect is one person.
  //
  // Strength 1 like the other repair sources, so a later real corroboration
  // displaces it, and it is its own audit trail: this value marks every lead
  // whose link was decided by the ladder rather than matched directly.
  PROSPECT_ELECTED: 'prospect_elected',
  // 2026-09-23: the LP lead's User1 (userfields slot 1, "HLCID") held a
  // shape-valid GHL id, lognumber did NOT, and the GHL contact's phone/email
  // corroborated the LP prospect. This is the ActiveProspect path: LeadConduit
  // step 13 spends LogNumber on the Modernize Lead ID and carries our
  // /intake/ap-resolve contact id in User1 instead. Same evidence as
  // lognumber_verified, so the same strength (2).
  USER1_VERIFIED: 'user1_verified',
};

// Trust ranking for the downgrade guard: a stored rank-3 source is only ever
// displaced by a *differing* rank-3 result this cycle (precedence case 2).
const STRENGTH = {
  [LINK_SOURCE.PHONE_EMAIL_MATCH]: 3,
  [LINK_SOURCE.LOGNUMBER_CORROBORATED]: 3,
  [LINK_SOURCE.LOGNUMBER_VERIFIED]: 2,
  [LINK_SOURCE.USER1_VERIFIED]: 2,
};
function linkStrength(source) {
  return (source && STRENGTH[source]) || 1;
}

function corroborationMode() {
  return process.env.LP_LINK_CORROBORATION_MODE === 'enforce' ? 'enforce' : 'observe';
}
function verifyCapPerCycle() {
  return Math.max(1, parseInt(process.env.LP_LINK_VERIFY_MAX_READS_PER_CYCLE || '200', 10));
}
function verifyTtlMs() {
  const days = Math.max(1, parseInt(process.env.LP_LINK_VERIFY_TTL_DAYS || '7', 10));
  return days * 24 * 60 * 60 * 1000;
}

// ─── Identity normalization ──────────────────────────────────────

// LP sentinel values that mean "no email". Wanda's LP email is literally
// "NA" — a naive comparison would false-match every LP-origin lead.
const EMAIL_SENTINELS = new Set(['', 'na', 'n/a', 'none']);

function normalizeEmail(email) {
  if (email == null) return null;
  const e = String(email).trim().toLowerCase();
  return EMAIL_SENTINELS.has(e) ? null : e;
}

// Compare on the last 10 digits: LP stores bare 10-digit numbers while GHL
// and the HL contacts cache store E.164 (+1XXXXXXXXXX).
function phonesMatch(a, b) {
  const da = String(a || '').replace(/\D/g, '');
  const db = String(b || '').replace(/\D/g, '');
  if (da.length < 10 || db.length < 10) return false;
  return da.slice(-10) === db.slice(-10);
}

// LP-side identity for corroboration. Prefers the prospect record (identity
// lives there on the nested path); falls back to the lead (flat path rows
// carry prospect-level fields directly).
function extractLpIdentity(lead, prospect) {
  const src = (obj, ...keys) => (obj ? getField(obj, ...keys) : null);
  const phone = normalizePhone(
    src(prospect, 'phone1', 'Phone1', 'phone', 'Phone') || src(lead, 'phone1', 'Phone1', 'phone', 'Phone'),
  );
  const phoneAlt = normalizePhone(
    prospect?.altphones?.[0]?.phone
      || src(prospect, 'Phone2', 'phone2', 'phone_alt')
      || src(lead, 'Phone2', 'phone2', 'phone_alt'),
  );
  const email = normalizeEmail(src(prospect, 'email', 'Email') || src(lead, 'email', 'Email'));
  return { phone, phoneAlt, email };
}

// Corroborate LP identity against a GHL contact (live shape or HL-cache row).
// Returns 'pass' | 'fail' | 'no_identity'. Name is NEVER used — "Guest
// Visitor NNN" is not unique.
function corroborateIdentity(lpIdentity, ghlContact) {
  const ghlPhones = [
    ghlContact?.phone,
    ...(Array.isArray(ghlContact?.additionalPhones) ? ghlContact.additionalPhones : []),
  ].filter(Boolean);
  const ghlEmails = [
    ghlContact?.email,
    ...(Array.isArray(ghlContact?.additionalEmails)
      ? ghlContact.additionalEmails.map((e) => (typeof e === 'string' ? e : e?.email))
      : []),
  ].map(normalizeEmail).filter(Boolean);

  if (ghlPhones.length === 0 && ghlEmails.length === 0) return 'no_identity';

  const lpPhones = [lpIdentity.phone, lpIdentity.phoneAlt].filter(Boolean);
  for (const lp of lpPhones) {
    for (const gp of ghlPhones) {
      if (phonesMatch(lp, gp)) return 'pass';
    }
  }
  if (lpIdentity.email && ghlEmails.includes(lpIdentity.email)) return 'pass';

  // The contact has identity, and none of it matches LP's.
  return 'fail';
}

// ─── Per-cycle live-read budget ──────────────────────────────────

let verifyReadsUsed = 0;
let deferredThisCycle = 0;

export function resetLinkVerifyBudget() {
  if (deferredThisCycle > 0) {
    console.warn(`[LinkCorroboration] previous cycle deferred ${deferredThisCycle} verification(s) at cap ${verifyCapPerCycle()}`);
  }
  verifyReadsUsed = 0;
  deferredThisCycle = 0;
}

export function logLinkCorroborationConfig() {
  console.log(
    `[LinkCorroboration] mode=${corroborationMode()} verify_cap=${verifyCapPerCycle()}/cycle ttl=${process.env.LP_LINK_VERIFY_TTL_DAYS || '7'}d`,
  );
}

// ─── Injected dependencies (test seam + isolation) ───────────────

let hlClient = null;
let hlClientMissing = false;
function hlSupabase() {
  if (hlClient) return hlClient;
  if (hlClientMissing) return null;
  const url = process.env.HL_SUPABASE_URL;
  const key = process.env.HL_SUPABASE_SERVICE_ROLE_KEY || process.env.HL_SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    hlClientMissing = true;
    console.warn('[LinkCorroboration] HL_SUPABASE_URL / HL_SUPABASE_SERVICE_ROLE_KEY unset — cache verification unavailable, lognumber-only links stay unclassified');
    return null;
  }
  hlClient = createClient(url, key);
  return hlClient;
}

const deps = {
  now: () => new Date(),

  // Live GHL contact read (enforce mode / explicit admin verify).
  fetchContactLive: async (contactId) => {
    const res = await ghlFetch('GET', `/contacts/${contactId}`);
    return res?.contact || res || null;
  },

  // HL Supabase contacts-cache read (observe mode). Returns the cache row
  // (with synced_at for staleness measurement) or undefined when the row is
  // absent / cache unavailable — which is NOT evidence of anything.
  fetchContactCache: async (contactId) => {
    const hl = hlSupabase();
    if (!hl) return undefined;
    const { data, error } = await hl
      .from('contacts')
      .select('ghl_contact_id, phone, email, first_name, last_name, synced_at, deleted_at')
      .eq('ghl_contact_id', contactId)
      .maybeSingle();
    if (error) {
      console.warn(`[LinkCorroboration] HL cache read failed for ${contactId}: ${error.message}`);
      return undefined;
    }
    if (!data || data.deleted_at) return undefined;
    return data;
  },

  getVerdict: async (lpLeadId, ghlContactId) => {
    const { data } = await supabase
      .from('lp_link_verifications')
      .select('verdict, verify_source, verified_at, detail')
      .eq('lp_lead_id', lpLeadId)
      .eq('ghl_contact_id', ghlContactId)
      .maybeSingle();
    return data || null;
  },

  saveVerdict: async (lpLeadId, ghlContactId, verdict, verifySource, detail) => {
    const { error } = await supabase.from('lp_link_verifications').upsert({
      lp_lead_id: lpLeadId,
      ghl_contact_id: ghlContactId,
      verdict,
      verify_source: verifySource,
      detail: detail || {},
      verified_at: new Date().toISOString(),
    }, { onConflict: 'lp_lead_id,ghl_contact_id' });
    if (error) console.warn(`[LinkCorroboration] verdict save failed for ${lpLeadId}/${ghlContactId}: ${error.message}`);
  },

  // Recurrence-counting conflict recorder: one row per natural key,
  // seen_count/last_seen_at incremented on re-detection (a link flapping
  // forty times is different signal from forty links flapping once).
  recordConflict: async (conflict) => {
    try {
      let query = supabase.from('lp_link_conflicts')
        .select('id, seen_count')
        .eq('lp_lead_id', conflict.lp_lead_id)
        .eq('resolution', conflict.resolution);
      query = conflict.lognumber_ghl_id
        ? query.eq('lognumber_ghl_id', conflict.lognumber_ghl_id)
        : query.is('lognumber_ghl_id', null);
      query = conflict.verified_ghl_id
        ? query.eq('verified_ghl_id', conflict.verified_ghl_id)
        : query.is('verified_ghl_id', null);
      const { data: existing } = await query.maybeSingle();

      if (existing) {
        await supabase.from('lp_link_conflicts')
          .update({ seen_count: (existing.seen_count || 1) + 1, last_seen_at: new Date().toISOString() })
          .eq('id', existing.id);
      } else {
        await supabase.from('lp_link_conflicts').insert(conflict);
      }
    } catch (err) {
      console.warn(`[LinkCorroboration] conflict record failed for lead ${conflict.lp_lead_id}: ${err.message}`);
    }
  },
};

// ─── Verification ────────────────────────────────────────────────

// Verify a shape-valid lognumber candidate against GHL contact identity.
// Cache-first; live reads only when allowLive (enforce mode inside the
// budget, or an explicit admin action). Returns:
//   { verdict: 'pass'|'fail'|'no_identity'|'unknown', source: 'hl_cache'|'ghl_live'|null, detail }
// 'unknown' means "could not evaluate" (cache row absent, budget exhausted,
// live read failed) — never treated as a rejection.
export async function verifyLognumberCandidate({ lpIdentity, candidateId, allowLive = false, lpLeadId = null }) {
  if (!lpIdentity.phone && !lpIdentity.phoneAlt && !lpIdentity.email) {
    // Nothing on the LP side to corroborate with — indistinguishable from a
    // contact mismatch, so treat as unevaluable rather than rejected.
    return { verdict: 'unknown', source: null, detail: { reason: 'lp_identity_empty' } };
  }

  if (allowLive) {
    try {
      const contact = await deps.fetchContactLive(candidateId);
      if (contact) {
        const verdict = corroborateIdentity(lpIdentity, contact);
        const detail = { ghl_phone: contact.phone || null, ghl_email: contact.email || null };
        if (lpLeadId) await deps.saveVerdict(lpLeadId, candidateId, verdict, 'ghl_live', detail);
        return { verdict, source: 'ghl_live', detail };
      }
      // Contact gone in GHL — no identity to corroborate against.
      const detail = { reason: 'contact_not_found' };
      if (lpLeadId) await deps.saveVerdict(lpLeadId, candidateId, 'no_identity', 'ghl_live', detail);
      return { verdict: 'no_identity', source: 'ghl_live', detail };
    } catch (err) {
      console.warn(`[LinkCorroboration] live verify failed for ${candidateId}: ${err.message}`);
      return { verdict: 'unknown', source: null, detail: { reason: 'live_read_failed', error: err.message } };
    }
  }

  const cacheRow = await deps.fetchContactCache(candidateId);
  if (cacheRow === undefined) {
    // Absent cache row may be cache lag, not evidence — leave unclassified.
    return { verdict: 'unknown', source: null, detail: { reason: 'cache_row_missing' } };
  }
  const verdict = corroborateIdentity(lpIdentity, cacheRow);
  const detail = {
    ghl_phone: cacheRow.phone || null,
    ghl_email: cacheRow.email || null,
    cache_synced_at: cacheRow.synced_at || null,
  };
  if (lpLeadId) await deps.saveVerdict(lpLeadId, candidateId, verdict, 'hl_cache', detail);
  return { verdict, source: 'hl_cache', detail };
}

// Enforce-mode verification: TTL-cached live verdicts, then a budget-gated
// live read. Cache-sourced (hl_cache) verdict rows are deliberately NOT
// trusted here — enforce re-verifies live before acting.
async function verifyForEnforce(lpIdentity, candidateId, lpLeadId) {
  const cached = await deps.getVerdict(lpLeadId, candidateId);
  if (cached && cached.verify_source === 'ghl_live') {
    const age = deps.now().getTime() - new Date(cached.verified_at).getTime();
    if (age < verifyTtlMs()) {
      return { verdict: cached.verdict, source: 'ghl_live', detail: cached.detail || {} };
    }
  }
  if (verifyReadsUsed >= verifyCapPerCycle()) {
    deferredThisCycle++;
    if (deferredThisCycle === 1) {
      console.warn(`[LinkCorroboration] live-verify budget exhausted (${verifyCapPerCycle()}) — deferring further verifications this cycle`);
    }
    return { verdict: 'unknown', source: null, detail: { reason: 'budget_exhausted' } };
  }
  verifyReadsUsed++;
  return verifyLognumberCandidate({ lpIdentity, candidateId, allowLive: true, lpLeadId });
}

// ─── Resolution ──────────────────────────────────────────────────

// user1Id rides in `detail` rather than a column: lp_link_conflicts has no
// User1 column (DDL is dashboard-only), and LP only accepts User1 on AddLead,
// so one lead never carries two different User1 values — the natural key
// (lead, lognumber id, verified id, resolution) still dedupes correctly.
function buildConflictRow({ lpLeadId, lpProspectId, lognumberId, verifiedGhlId, existingGhlId, resolution, reason, lpIdentity, ghlDetail, user1Id = null }) {
  return {
    lp_lead_id: lpLeadId || null,
    lp_prospect_id: lpProspectId || null,
    lognumber_ghl_id: lognumberId || null,
    verified_ghl_id: verifiedGhlId || null,
    existing_ghl_id: existingGhlId || null,
    resolution,
    reason,
    lp_phone: lpIdentity?.phone || null,
    lp_email: lpIdentity?.email || null,
    ghl_phone: ghlDetail?.ghl_phone || null,
    ghl_email: ghlDetail?.ghl_email || null,
    detail: {
      lp_phone_alt: lpIdentity?.phoneAlt || null,
      ...(user1Id ? { user1_ghl_id: user1Id } : {}),
      // candidate_field marks rows where User1 was the id under test; on a
      // user1_disagrees_with_lognumber row lognumber was, so it is omitted.
      ...(user1Id && !lognumberId ? { candidate_field: 'user1' } : {}),
      ...(ghlDetail || {}),
    },
  };
}

/**
 * Resolve the GHL link for one LP lead.
 *
 * @param {object} input
 * @param {object} input.lead              LP lead record (nested or flat)
 * @param {object} [input.prospect]        LP prospect record (identity source)
 * @param {string} [input.verifiedGhlId]   matchToGHL() phone/email result
 * @param {string} [input.existingGhlId]   stored lp_leads.ghl_contact_id
 * @param {string} [input.existingLinkSource] stored lp_leads.ghl_link_source
 * @param {object} [opts]
 * @param {string} [opts.lpLeadId]         for verification cache + conflict rows
 * @param {string} [opts.lpProspectId]
 * @returns {Promise<{ghlContactId: string|null, linkSource: string|null, conflict: object|null, deferred: boolean}>}
 *   linkSource null = "leave the stored ghl_link_source untouched".
 *   In observe mode ghlContactId is ALWAYS the legacy derivation result.
 */
export async function resolveLeadGhlLink(
  { lead, prospect = null, verifiedGhlId = null, existingGhlId = null, existingLinkSource = null },
  { lpLeadId = null, lpProspectId = null } = {},
) {
  const mode = corroborationMode();
  const lognumberId = lognumberCandidate(lead);
  // 2026-09-23: User1 is a candidate ONLY when lognumber is not. When both are
  // shape-valid, lognumber keeps its path unchanged; a differing User1 is
  // recorded as a conflict below and never bound.
  const user1Raw = user1Candidate(lead);
  const user1Id = lognumberId ? null : user1Raw;
  const user1DisagreesWithLognumber = Boolean(lognumberId && user1Raw && user1Raw !== lognumberId);
  // The one candidate this pass evaluates.
  const candidateId = lognumberId || user1Id;

  // Pre-resolver behavior: lognumber shape-wins, then the phone/email match,
  // then the stored link. This is what observe mode must keep returning.
  // User1 is deliberately NOT in it: the legacy result is shape-only, and a
  // User1 id may only reach a row after corroboration passes (returnedUser1Pass).
  const legacyId = lognumberId || verifiedGhlId || existingGhlId || null;
  const returned = (id, linkSource, conflict = null, deferred = false) => ({
    ghlContactId: mode === 'observe' ? legacyId : id,
    linkSource,
    conflict,
    deferred,
  });
  // A corroborated User1 binds in BOTH modes. Observe mode exists to keep the
  // pre-resolver lognumber behavior bit-identical; there was no pre-resolver
  // User1 behavior to preserve, and without this the ActiveProspect leads
  // could never link until enforce is switched on.
  const returnedUser1Pass = (id) => ({
    ghlContactId: id,
    linkSource: LINK_SOURCE.USER1_VERIFIED,
    conflict: null,
    deferred: false,
  });

  const existingStrength = linkStrength(existingLinkSource);
  const candidateUnchanged = !candidateId || candidateId === existingGhlId;
  const verifiedAgreesOrAbsent = !verifiedGhlId || verifiedGhlId === existingGhlId;

  // Cheap upgrade: this cycle's phone/email match confirms the stored link.
  if (verifiedGhlId && verifiedGhlId === existingGhlId && candidateUnchanged) {
    const upgraded = lognumberId === verifiedGhlId
      ? LINK_SOURCE.LOGNUMBER_CORROBORATED
      : LINK_SOURCE.PHONE_EMAIL_MATCH;
    return returned(existingGhlId, existingLinkSource === upgraded ? null : upgraded);
  }

  // Fast path: link already classified, nothing new this cycle. Zero queries.
  // This is also the "never live-verify an unchanged re-sync" guarantee.
  if (
    existingLinkSource
    && existingLinkSource !== LINK_SOURCE.LEGACY_UNVERIFIED
    && candidateUnchanged
    && verifiedAgreesOrAbsent
  ) {
    return returned(existingGhlId, null);
  }

  const lpIdentity = extractLpIdentity(lead, prospect);

  // Two LP fields naming two different GHL contacts. Lognumber keeps its
  // path; User1 is never bound here, but the disagreement is recorded. Sits
  // after the fast path so an unchanged re-sync stays zero-query.
  if (user1DisagreesWithLognumber) {
    await deps.recordConflict(buildConflictRow({
      lpLeadId, lpProspectId, lognumberId, verifiedGhlId: null, existingGhlId,
      resolution: 'user1_ignored',
      reason: 'user1_disagrees_with_lognumber',
      lpIdentity,
      user1Id: user1Raw,
    }));
  }

  // Case 1+2+3: a verified phone/email match exists.
  if (verifiedGhlId) {
    if (lognumberId && lognumberId === verifiedGhlId) {
      return returned(lognumberId, LINK_SOURCE.LOGNUMBER_CORROBORATED);
    }
    if (lognumberId) {
      // Lognumber and verified match disagree → verified wins, record it.
      const conflict = buildConflictRow({
        lpLeadId, lpProspectId, lognumberId, verifiedGhlId, existingGhlId,
        resolution: LINK_SOURCE.PHONE_EMAIL_MATCH,
        reason: 'lognumber_disagrees_with_verified_match',
        lpIdentity,
      });
      await deps.recordConflict(conflict);
      return returned(verifiedGhlId, LINK_SOURCE.PHONE_EMAIL_MATCH, conflict);
    }
    if (user1Id && user1Id !== verifiedGhlId) {
      // Same as the lognumber case above: the verified match wins.
      const conflict = buildConflictRow({
        lpLeadId, lpProspectId, lognumberId: null, verifiedGhlId, existingGhlId,
        resolution: LINK_SOURCE.PHONE_EMAIL_MATCH,
        reason: 'user1_disagrees_with_verified_match',
        lpIdentity,
        user1Id,
      });
      await deps.recordConflict(conflict);
      return returned(verifiedGhlId, LINK_SOURCE.PHONE_EMAIL_MATCH, conflict);
    }
    // No candidate, or User1 equals the verified match — the phone/email
    // match is the stronger evidence either way (strength 3).
    return returned(verifiedGhlId, LINK_SOURCE.PHONE_EMAIL_MATCH);
  }

  // Case 4: lognumber (or, failing that, User1) only → verify before binding.
  if (candidateId) {
    const field = lognumberId ? 'lognumber' : 'User1';
    // Downgrade guard: a rank-3 stored link is never displaced by anything
    // weaker than a differing verified match (handled above).
    if (existingStrength >= 3 && candidateId !== existingGhlId) {
      console.log(`[LinkCorroboration] downgrade guard: kept ${existingLinkSource} link for lead ${lpLeadId} over ${field} candidate ${candidateId}`);
      return returned(existingGhlId, null);
    }

    const { verdict, detail } = mode === 'enforce'
      ? await verifyForEnforce(lpIdentity, candidateId, lpLeadId)
      : await verifyLognumberCandidate({ lpIdentity, candidateId, lpLeadId });

    if (verdict === 'pass') {
      return lognumberId
        ? returned(lognumberId, LINK_SOURCE.LOGNUMBER_VERIFIED)
        : returnedUser1Pass(user1Id);
    }
    // Every non-pass outcome below goes through returned(), so in observe
    // mode a rejected or deferred User1 can never reach the row: legacyId
    // does not contain it.
    if (verdict === 'no_identity') {
      // Contact has neither phone nor email (the Wanda case) → refuse to bind.
      return returned(existingGhlId, LINK_SOURCE.REJECTED_UNCORROBORATED);
    }
    if (verdict === 'fail') {
      const conflict = buildConflictRow({
        lpLeadId, lpProspectId, lognumberId, verifiedGhlId: null, existingGhlId,
        resolution: LINK_SOURCE.REJECTED_CONFLICT,
        reason: 'ghl_contact_identity_contradicts_lp',
        lpIdentity,
        ghlDetail: detail,
        user1Id,
      });
      await deps.recordConflict(conflict);
      return returned(existingGhlId, LINK_SOURCE.REJECTED_CONFLICT, conflict);
    }
    // 'unknown' — unevaluable this cycle; leave link + classification alone.
    return returned(existingGhlId, null, null, true);
  }

  // Case 5: no candidate at all → carry the existing link forward. Keep the
  // legacy_unverified marker (untriaged) rather than relabeling it.
  if (existingGhlId && !existingLinkSource) {
    return returned(existingGhlId, LINK_SOURCE.EXISTING_PRESERVED);
  }
  return returned(existingGhlId, null);
}

// ─── Test seam ───────────────────────────────────────────────────
export const _internal = {
  corroborateIdentity,
  extractLpIdentity,
  phonesMatch,
  normalizeEmail,
  linkStrength,
  buildConflictRow,
  corroborationMode,
  __setDepsForTest(overrides) {
    const previous = { ...deps };
    Object.assign(deps, overrides);
    return () => Object.assign(deps, previous);
  },
  __getVerifyStats() {
    return { verifyReadsUsed, deferredThisCycle };
  },
};
