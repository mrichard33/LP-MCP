/**
 * Call Intelligence — deterministic lead matching — src/ci/match.js
 *
 * §8. Decides WHICH customer record a call's note belongs to. This is the most
 * dangerous module in the subsystem: every other stage can be wrong and produce
 * a bad note on the right record, which a human reads and discards. This one
 * being wrong produces a plausible note on the WRONG PERSON'S record — and
 * nobody reviewing that record has any way to know it does not belong there.
 *
 * So the entire module is built to prefer a MISS over a GUESS. Every tier
 * boundary below resolves ambiguity toward `ambiguous`/`none` → review, never
 * toward the most-likely candidate. There is no "best guess" path.
 *
 * ── THE TIERS (stop at the first hit) ──────────────────────────────────────
 *   exact      list-carried lds_id/cst_id on the dialing record
 *   high       phone hit, exactly one candidate
 *   probable   phone hit, several candidates, exactly one survives recency;
 *              or a name+address hit the AI marked 'stated' with conf >= 0.85
 *   ambiguous  a hit we cannot narrow to one → review
 *   none       no hit at all
 *
 * Writes happen at exact|high only, with probable gated behind
 * CALL_INTEL_ALLOW_PROBABLE. That gate lives in config.js, not here — this
 * module reports what it found and never decides whether to write.
 *
 * ── THE CANVASS EXCEPTION, WHICH IS A CORRUPTION RISK, NOT A MISS ──────────
 * On Canvass Confirmation campaigns the ANI is the CANVASSER'S phone at the
 * door, not the customer's (verified live 2026-08-19: canvass lead 568419 /
 * cst 453297 had zero Five9 calls on the customer's number). Phone-matching
 * those calls would attach the note to the canvasser — an employee — or to a
 * stranger who happens to own that number. For campaigns mapped
 * `match_strategy = 'canvass_correlation'` this module NEVER matches on ANI.
 *
 * The data backs this up: of the canvasser roster, every live Canvass
 * Confirmation ANI checked resolved to a real canvasser, not a customer.
 *
 * ── THE GLOBAL CANVASSER-ANI GUARD, WHICH THE CAMPAIGN RULE DOES NOT COVER ─
 * That campaign rule guards ONE campaign. The other 97 all match on phone, so
 * the same canvasser dialling in under any of them was matched as a customer.
 * Proven live: recording ANI 3213050187 belongs to Pro ID 5296, GIAN CROSS,
 * ORL market — a canvasser, matched as a customer.
 *
 * So before ANY phone-tier match, THE CUSTOMER'S NUMBER is checked against the
 * ci_canvassers roster (sql/067) — the same number the phone tier is about to
 * search on, which is the only number a guard on that tier can meaningfully
 * check. On an inbound canvass call that number IS the ANI, so the behaviour
 * this guard was built for is unchanged; on an outbound call it is now the DNIS,
 * i.e. the number actually dialled, which is the one that could belong to a
 * canvasser. A hit does NOT produce a match: it routes the call to
 * review with `canvasser_ani` and records which canvasser it hit. It
 * deliberately does NOT try to work out who the customer really was —
 * correlating a canvass call to its customer is the canvass_correlation
 * strategy's job, and widening it here would be a second guess layered on a
 * first.
 *
 * The guard can only ever WITHHOLD a match, never invent one, so an unseeded
 * or empty roster degrades to exactly today's behaviour.
 *
 * ── PHONE COMPARISON ───────────────────────────────────────────────────────
 * LP stores bare 10-digit (measured: 139,693 of 140,600 prospect phones; zero
 * E.164). Comparison is equality against the 10-digit and '1'-prefixed forms
 * so the sql/065 indexes are usable. Normalizing the COLUMN at query time
 * would defeat them.
 */

import supabase from '../supabase.js';
import { getConfig } from './config.js';
import { last10 } from './time.js';

const LOG = '[CIMatch]';

export const TIERS = ['exact', 'high', 'probable', 'ambiguous', 'none'];
/** Tiers a CRM write may ever consider. `probable` is additionally flag-gated. */
export const WRITABLE_TIERS = new Set(['exact', 'high', 'probable']);

/** §8: an appointment this close to the call counts as relevant. */
export const APPOINTMENT_WINDOW_DAYS = 14;
/** §8: activity this recent counts as relevant. */
export const ACTIVITY_WINDOW_DAYS = 30;
/** §8: canvass correlation window around the call. */
export const CANVASS_WINDOW_MINUTES = 60;
/** §8: name+address fallback demands this much AI confidence, on BOTH fields. */
export const NAME_ADDRESS_MIN_CONFIDENCE = 0.85;

/**
 * The forms of a phone number to compare against LP columns.
 *
 * Bare 10-digit covers 99.4% of rows; the '1'-prefixed form picks up the 118
 * eleven-digit rows. Both are equality probes, so both use the index.
 */
export function phoneVariants(phone) {
  const ten = last10(phone);
  if (!ten) return [];
  return [ten, `1${ten}`];
}

/**
 * Is this call one where the ANI is NOT the customer?
 * Driven by the campaign map, never by a hardcoded campaign name — the live
 * string is 'Canvass Confirmation - Inbound' and near-duplicates exist.
 */
export function isCanvassCorrelation(campaignRow) {
  return campaignRow?.match_strategy === 'canvass_correlation';
}

/**
 * Load the canvasser roster into a Map keyed on the 10-digit phone.
 *
 * ONE read per worker tick, threaded down — not one per call. The roster is
 * ~850 rows and every call in the batch checks the same set.
 *
 * The value is an ARRAY, not a row. 11 numbers in the roster belong to more
 * than one Pro ID (shared household and company lines), which is why
 * ci_canvassers is keyed on (pro_id, phone_last10). Collapsing them to one row
 * here would throw away exactly the information the composite key preserves.
 * Sorted by pro_id so the evidence written to ci_matches is deterministic.
 */
export async function loadCanvasserPhones(db = supabase) {
  const { data, error } = await db
    .from('ci_canvassers')
    .select('pro_id, name, market, phone_last10, active');
  if (error) throw new Error(`ci_canvassers read failed: ${error.message}`);

  const map = new Map();
  for (const r of data || []) {
    // An explicitly deactivated canvasser is no longer on the doors; their
    // number is theirs again and should match normally.
    if (r?.active === false) continue;
    const key = last10(r?.phone_last10);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ pro_id: r.pro_id ?? null, name: r.name ?? null, market: r.market ?? null });
  }
  for (const list of map.values()) {
    list.sort((a, b) => Number(a.pro_id ?? 0) - Number(b.pro_id ?? 0));
  }
  return map;
}

/**
 * Which canvassers, if any, own this number? Pure — the roster is an argument.
 *
 * Both sides go through last10(), so '321-305-0187', '13213050187' and
 * '3213050187' all resolve to the same roster row. A missing roster returns []
 * — the guard is then a no-op, which is the safe direction.
 *
 * @returns {Array<{pro_id: number|null, name: string|null, market: string|null}>}
 */
export function canvasserMatches(canvasserPhones, phone) {
  const key = last10(phone);
  if (!key || typeof canvasserPhones?.get !== 'function') return [];
  return canvasserPhones.get(key) || [];
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const ms = Math.abs(new Date(a).getTime() - new Date(b).getTime());
  return Number.isFinite(ms) ? ms / 86400000 : null;
}

/**
 * §8 step 3: several phone candidates. Prefer one with an appointment within
 * ±14 days of the call OR activity within 30 days. EXACTLY one survivor is
 * `probable`; anything else is `ambiguous`.
 *
 * Note the asymmetry — this narrows, it never ranks. If two candidates both
 * look recent, the answer is "I don't know", not "the more recent one".
 */
export function narrowByRecency(candidates, callStart) {
  const survivors = (candidates || []).filter((c) => {
    const apptDays = daysBetween(c.appointment_date, callStart);
    if (apptDays !== null && apptDays <= APPOINTMENT_WINDOW_DAYS) return true;
    const actDays = daysBetween(c.last_activity_at, callStart);
    if (actDays !== null && actDays <= ACTIVITY_WINDOW_DAYS) return true;
    return false;
  });
  return survivors;
}

/**
 * §8 note target: 'ils' + lds_id when the person has exactly ONE inquiry
 * relevant to this call, otherwise 'cst' + cst_id.
 *
 * "Never guess between multiple appointments" is the rule that matters here.
 * A person with two open jobs gets the note on the PERSON, where whoever reads
 * it can see both, rather than on one arbitrarily chosen job where it silently
 * implies the wrong context.
 */
export function pickNoteTarget(prospectId, leads, callStart) {
  const relevant = narrowByRecency(leads || [], callStart);
  if (relevant.length === 1 && relevant[0].lp_lead_id != null) {
    return { rectype: 'ils', recid: Number(relevant[0].lp_lead_id), reason: 'single_relevant_lead' };
  }
  return {
    rectype: 'cst',
    recid: prospectId != null ? Number(prospectId) : null,
    reason: relevant.length === 0 ? 'no_relevant_lead' : 'multiple_relevant_leads',
  };
}

/**
 * §8 step 4: the name+address fallback. Deliberately strict — this is the only
 * tier that trusts model output to identify a human being, so it requires BOTH
 * fields to be explicitly stated on the call (not inferred) at high confidence,
 * AND a unique LP hit. Anything softer would let a hallucinated name attach a
 * note to a stranger.
 */
export function nameAddressUsable(analysis) {
  const name = analysis?.customer?.name;
  const addr = analysis?.customer?.address;
  const ok = (f) => f
    && f.source === 'stated'
    && typeof f.value === 'string'
    && f.value.trim().length > 0
    && typeof f.confidence === 'number'
    && f.confidence >= NAME_ADDRESS_MIN_CONFIDENCE;
  return Boolean(ok(name) && ok(addr));
}

/**
 * Decide the LP tier from already-fetched candidates. Pure — all the I/O lives
 * in matchLp() so every boundary here is testable without a database.
 *
 * @param {object} args
 * @param {object|null} args.listIds   {cst_id, lds_id} carried by the dialing record
 * @param {Array}  args.phoneCandidates prospect rows matched by phone
 * @param {Array}  args.nameCandidates  prospect rows matched by name+address
 * @param {object} args.analysis        the §7 AI output (for the name fallback)
 * @param {string} args.callStart
 * @returns {{tier: string, method: string, prospectId: number|null, candidates: Array, reason: string}}
 */
export function decideLpTier({ listIds = null, phoneCandidates = [], nameCandidates = [], analysis = null, callStart = null } = {}) {
  // 1. The dialing record carried real LP ids. Nothing to infer.
  if (listIds && (listIds.cst_id || listIds.lds_id)) {
    return {
      tier: 'exact',
      method: 'list_carried_ids',
      prospectId: listIds.cst_id != null ? Number(listIds.cst_id) : null,
      leadId: listIds.lds_id != null ? Number(listIds.lds_id) : null,
      candidates: [],
      reason: 'ids_on_dialing_record',
    };
  }

  // 2 & 3. Phone.
  if (phoneCandidates.length === 1) {
    return {
      tier: 'high',
      method: 'phone_exact',
      prospectId: Number(phoneCandidates[0].lp_prospect_id),
      candidates: phoneCandidates,
      reason: 'single_phone_candidate',
    };
  }
  if (phoneCandidates.length > 1) {
    const survivors = narrowByRecency(phoneCandidates, callStart);
    if (survivors.length === 1) {
      return {
        tier: 'probable',
        method: 'phone_exact_narrowed',
        prospectId: Number(survivors[0].lp_prospect_id),
        candidates: phoneCandidates,
        reason: 'narrowed_by_recency',
      };
    }
    return {
      tier: 'ambiguous',
      method: 'phone_exact',
      prospectId: null,
      candidates: phoneCandidates,
      // Naming which way it failed matters to whoever works the queue: too
      // many survivors is a different problem from none.
      reason: survivors.length === 0 ? 'no_candidate_recent' : `multiple_recent_candidates_${survivors.length}`,
    };
  }

  // 4. Name + address, only on strong stated evidence and a unique hit.
  if (nameAddressUsable(analysis)) {
    if (nameCandidates.length === 1) {
      return {
        tier: 'probable',
        method: 'name_address',
        prospectId: Number(nameCandidates[0].lp_prospect_id),
        candidates: nameCandidates,
        reason: 'unique_name_address_hit',
      };
    }
    if (nameCandidates.length > 1) {
      return { tier: 'ambiguous', method: 'name_address', prospectId: null, candidates: nameCandidates, reason: 'multiple_name_address_hits' };
    }
  }

  return { tier: 'none', method: 'none', prospectId: null, candidates: [], reason: 'no_candidate' };
}

/**
 * Fetch LP person records whose primary or alternate phone matches.
 *
 * NOTE ON WHICH RECENCY SIGNAL APPLIES HERE. lp_prospects carries
 * `has_appointment` (a boolean) but NO appointment date — only lp_leads has
 * `appointment_date`. So a prospect candidate can only be narrowed by ACTIVITY
 * (latest_lead_date, the 30-day rule); the ±14-day appointment rule genuinely
 * applies one level down, in pickNoteTarget, where the dates exist. Mapping
 * `has_appointment` onto the appointment window would be worse than not having
 * it: a boolean cannot say "within 14 days", so a two-year-old appointment
 * would qualify a stale candidate and turn an honest `ambiguous` into a
 * confident wrong `probable`.
 *
 * Verified against the live schema 2026-08-22. The planner uses
 * idx_lp_prospects_phone + idx_lp_prospects_phone_alt via BitmapOr.
 */
export async function findLpByPhone(db, phone) {
  const variants = phoneVariants(phone);
  if (variants.length === 0) return [];
  const list = variants.map((v) => `"${v}"`).join(',');
  const { data, error } = await db
    .from('lp_prospects')
    .select('lp_prospect_id, first_name, last_name, phone, phone_alt, address, city, state, zip, ghl_contact_id, latest_lead_date, has_appointment')
    .or(`phone.in.(${list}),phone_alt.in.(${list})`)
    .limit(50);
  if (error) throw new Error(`lp_prospects phone lookup failed: ${error.message}`);
  return (data || []).map((p) => ({ ...p, last_activity_at: p.latest_lead_date }));
}

/** Fetch the inquiries belonging to one person. */
export async function findLpLeads(db, prospectId) {
  const { data, error } = await db
    .from('lp_leads')
    .select('lp_lead_id, lp_prospect_id, appointment_date, appointment_set, last_contact_date, disposition_code, ghl_contact_id, created_at_lp')
    .eq('lp_prospect_id', String(prospectId))
    .limit(100);
  if (error) throw new Error(`lp_leads lookup failed: ${error.message}`);
  return (data || []).map((l) => ({ ...l, last_activity_at: l.last_contact_date || l.created_at_lp }));
}

/**
 * §8 canvass correlation: find the canvassing lead created in the same flow.
 * ±60 minutes of the call, and EXACTLY one candidate, or it goes to review.
 * The ANI is never consulted.
 */
export async function findCanvassCorrelation(db, call, { windowMinutes = CANVASS_WINDOW_MINUTES } = {}) {
  const t = new Date(call.call_start).getTime();
  const from = new Date(t - windowMinutes * 60000).toISOString();
  const to = new Date(t + windowMinutes * 60000).toISOString();

  const { data, error } = await db
    .from('lp_leads')
    .select('lp_lead_id, lp_prospect_id, created_at_lp, lead_source, lead_source_detail, ghl_contact_id')
    .gte('created_at_lp', from)
    .lte('created_at_lp', to)
    .limit(50);
  if (error) throw new Error(`canvass correlation lookup failed: ${error.message}`);
  return data || [];
}

/**
 * GHL resolution. The LP↔GHL link already exists on the mirrored rows, so the
 * first tier is a read of that link rather than a fresh phone search — a link
 * a human or the sync engine already established beats anything inferred here.
 */
export function decideGhlTier({ lpProspect = null, lpLeads = [], phoneCandidates = [] } = {}) {
  const linked = lpProspect?.ghl_contact_id
    || (lpLeads || []).map((l) => l.ghl_contact_id).find(Boolean)
    || null;
  if (linked) {
    return { tier: 'exact', method: 'lp_ghl_link', ghlContactId: linked, candidates: [], reason: 'existing_lp_ghl_link' };
  }
  if (phoneCandidates.length === 1) {
    return { tier: 'high', method: 'ghl_phone', ghlContactId: phoneCandidates[0].ghl_contact_id, candidates: phoneCandidates, reason: 'single_ghl_phone_candidate' };
  }
  if (phoneCandidates.length > 1) {
    return { tier: 'ambiguous', method: 'ghl_phone', ghlContactId: null, candidates: phoneCandidates, reason: 'multiple_ghl_phone_candidates' };
  }
  return { tier: 'none', method: 'none', ghlContactId: null, candidates: [], reason: 'no_ghl_candidate' };
}

/**
 * Resolve one call to LP and GHL records.
 *
 * Returns the decision; it does NOT write ci_matches and never writes a CRM.
 * The worker stage owns persistence, so this stays callable from a review
 * endpoint that wants to show a human what the matcher would decide.
 *
 * @returns {Promise<{lp: object, ghl: object, target: object, review: string|null}>}
 */
export async function matchCall(call, { db = supabase, analysis = null, campaignRow = null, cfg = getConfig(), canvasserPhones = null } = {}) {
  const canvass = isCanvassCorrelation(campaignRow);

  let lp;
  if (canvass) {
    // NEVER phone-match these — the ANI belongs to the canvasser at the door.
    const candidates = await findCanvassCorrelation(db, call);
    if (candidates.length === 1) {
      lp = {
        tier: 'high',
        method: 'canvass_correlation',
        prospectId: candidates[0].lp_prospect_id != null ? Number(candidates[0].lp_prospect_id) : null,
        leadId: candidates[0].lp_lead_id != null ? Number(candidates[0].lp_lead_id) : null,
        candidates,
        reason: 'single_canvass_lead_in_window',
      };
    } else {
      lp = {
        tier: 'ambiguous',
        method: 'canvass_correlation',
        prospectId: null,
        candidates,
        reason: candidates.length === 0 ? 'no_canvass_lead_in_window' : `multiple_canvass_leads_${candidates.length}`,
      };
    }
  } else {
    const listIds = call.raw_metadata?.list_ids ?? null;
    const hasListIds = Boolean(listIds && (listIds.cst_id || listIds.lds_id));

    // THE GUARD, and note what it does NOT cover: list-carried ids. Those are
    // real LP ids the dialing record supplied, tier 'exact', nothing inferred
    // from a phone number at all — a canvasser's phone on the call does not
    // make them wrong. The guard is specifically about the PHONE tier, which
    // is the one that resolves a number to a person.
    //
    // THE NUMBER CHECKED IS call.customer_phone — set by discovery.js's
    // customerNumberFor(): the ANI on inbound, the DNIS on everything else.
    // That is deliberately the SAME expression findLpByPhone() is handed six
    // lines below. The guard and the lookup it guards must never resolve
    // different numbers, or the guard checks one person and the matcher
    // resolves another.
    const canvassers = hasListIds ? [] : canvasserMatches(canvasserPhones, call.customer_phone || call.ani);

    if (canvassers.length) {
      // Withhold the match; do NOT try to work out who the customer was.
      // Tier 'none' keeps this out of WRITABLE_TIERS, so no CRM write can
      // consider it even if every write flag were on.
      lp = {
        tier: 'none',
        method: 'canvasser_ani',
        prospectId: null,
        candidates: [],
        reason: 'ani_belongs_to_canvasser',
        canvassers,
      };
    } else {
      const phoneCandidates = await findLpByPhone(db, call.customer_phone || call.ani);
      // The name+address fallback needs its own lookup, and only earns one when
      // the AI evidence is strong enough to justify it.
      let nameCandidates = [];
      if (phoneCandidates.length === 0 && nameAddressUsable(analysis)) {
        nameCandidates = await findLpByNameAddress(db, analysis);
      }
      lp = decideLpTier({
        listIds,
        phoneCandidates,
        nameCandidates,
        analysis,
        callStart: call.call_start,
      });
    }
  }

  // Note target + GHL both need the person's inquiries.
  let leads = [];
  if (lp.prospectId != null) leads = await findLpLeads(db, lp.prospectId);

  const prospect = (lp.candidates || []).find((c) => Number(c.lp_prospect_id) === lp.prospectId) || null;
  const target = lp.prospectId != null
    ? (lp.leadId != null
      // An id carried by the dialing record or the canvass correlation names
      // the inquiry outright — no selection to make.
      ? { rectype: 'ils', recid: Number(lp.leadId), reason: 'id_supplied' }
      : pickNoteTarget(lp.prospectId, leads, call.call_start))
    : { rectype: null, recid: null, reason: 'no_lp_match' };

  const ghl = decideGhlTier({ lpProspect: prospect, lpLeads: leads });

  const review = reviewReasonFor(lp, call);
  if (review) console.log(`${LOG} call=${call.id} → review (${review}) lp_tier=${lp.tier}`);

  return { lp, ghl, target, review };
}

/**
 * §7 review triggers owned by matching: an ambiguous tier always, and `none`
 * on a call that was eligible in the first place. A `none` on an ineligible
 * call is expected and is not queue-worthy.
 */
export function reviewReasonFor(lp, call) {
  // A canvasser hit outranks the tier reasons, and is NOT gated on
  // call.eligible the way a plain 'none' is. A plain miss on an ineligible
  // call is expected and not queue-worthy; a canvasser hit is a call we
  // deliberately refused to match, and a reviewer needs to see it either way.
  //
  // The STRING stays 'canvasser_ani' even though the guard now checks the
  // customer's number rather than the ANI. It is a stored value: ci_calls rows
  // already carry it, and scripts/requeue-ci-review.js selects on it by name.
  // Renaming it would strand those rows and silently break that selector — a
  // cosmetic gain for a real loss.
  if (lp?.canvassers?.length) return 'canvasser_ani';
  if (lp.tier === 'ambiguous') return 'match_ambiguous';
  if (lp.tier === 'none' && call?.eligible) return 'match_none';
  return null;
}

/** Name + address lookup, used only behind nameAddressUsable(). */
export async function findLpByNameAddress(db, analysis) {
  const name = String(analysis?.customer?.name?.value ?? '').trim();
  const address = String(analysis?.customer?.address?.value ?? '').trim();
  if (!name || !address) return [];

  const parts = name.split(/\s+/);
  const first = parts[0];
  const last = parts.length > 1 ? parts[parts.length - 1] : null;
  if (!last) return [];

  // Match on the street number + name prefix rather than the whole spoken
  // address: a caller says "twelve twenty-four Oak" and the AI writes
  // "1224 Oak St", which will not equal LP's "1224 OAK STREET".
  const streetPrefix = address.split(',')[0].trim().slice(0, 12);

  const { data, error } = await db
    .from('lp_prospects')
    .select('lp_prospect_id, first_name, last_name, phone, address, city, state, zip, ghl_contact_id, latest_lead_date')
    .ilike('last_name', last)
    .ilike('first_name', `${first}%`)
    .ilike('address', `${streetPrefix}%`)
    .limit(25);
  if (error) throw new Error(`lp_prospects name/address lookup failed: ${error.message}`);
  return (data || []).map((p) => ({ ...p, last_activity_at: p.latest_lead_date }));
}

export default {
  matchCall,
  decideLpTier,
  decideGhlTier,
  pickNoteTarget,
  narrowByRecency,
  nameAddressUsable,
  isCanvassCorrelation,
  loadCanvasserPhones,
  canvasserMatches,
  phoneVariants,
  reviewReasonFor,
  TIERS,
  WRITABLE_TIERS,
};
