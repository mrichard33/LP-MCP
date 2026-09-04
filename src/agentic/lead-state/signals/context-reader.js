/**
 * Context Reader — src/agentic/lead-state/signals/context-reader.js
 *
 * Pure functions that read the context envelope (output of
 * buildLeadContext) and return small boolean / value signals used by
 * shape modules to decide states. Every function is defensive against
 * missing paths — if the data isn't there, the signal is false (or null).
 *
 * Why a separate file from shapes/
 * ───────────────────────────────
 * Signal extraction is "what does this contact have on record" (data
 * question). Shape logic is "what does this contact's record mean"
 * (policy question). Keeping them separate lets the same signal feed
 * multiple shapes without duplication, and lets us swap implementations
 * (e.g., move RECENT_REP_CONTACT from lp.last_call_date to a dedicated
 * rep-message table) without touching shape policy.
 *
 * Phase 1 scope: only the suppression-state signals. Phase 2 adds
 * engagement/intent/objection/pressure extractors here.
 *
 * v1.1 — 2026-05-12. Broaden isCustomerP2() to catch post-sale contacts
 *   that still have stale BOFU buyer-journey tags. Surfaced by Chuck
 *   Muller dry-run: opp status='won' in P1, all p2-stage:* + lp-milestone-*
 *   tags present, but my v1.0 CUSTOMER_P2 check only looked at
 *   pipeline.pipeline_id and lp.closed_won — neither fired because
 *   context-builder returns the P1 sale-recorded opp (not the P2 one)
 *   and LP marks his disposition OPPFDN (closed_won=false). He hit
 *   ACTIVE_BOFU via bj:stage-5-committed, which is a sticky historical
 *   tag that never clears after sale. False positive avoided by reading
 *   the post-sale tag signature.
 * v1.2 — 2026-06-03. Add isPostDemoDecline() — a recorded post-demo
 *   decline (LP disposition_code OPPFDN / FDNS = "Full Demo No Sale").
 *   Feeds the SUPPRESSED_POST_DEMO_DECLINE suppression state so a declined
 *   contact is ineligible for S4.5 via ANY behavioral shape, not just
 *   DEMO_STALL (the v0.2.3 isDemoStall fix only covered that one shape; a
 *   decline was re-admitted through DORMANT_HIGH_INTENT on stale intent
 *   signals). Reads disposition_code (the real field) with a legacy
 *   `disposition` fallback.
 * v1.3 — 2026-06-03. Add isConfirmedLoss() — a confirmed competitor /
 *   not-interested LOSS recorded in GHL TAGS, independent of the LP
 *   disposition_code. isPostDemoDecline only catches OPPFDN/FDNS
 *   disposition codes; a lost contact whose disposition is CXL (or any
 *   non-demo-decline code) carried the loss only in tags
 *   (loss-reason:*, objection-confirmed:not-interested,
 *   p3:not-interested-now, concern-expressed:competitor) and fell through
 *   to the eligible shapes. Surfaced live by Gerald Aloia
 *   (zrjJPmKbjX3TZpHiEuVX): bought elsewhere, disposition CXL, classified
 *   S45_TRUST_RECOVERY 0.90 and auto-enrolled. Feeds the new
 *   SUPPRESSED_CONFIRMED_LOSS state.
 * v1.4 — 2026-06-03. Add isInActiveSoapOpera() — contact is currently
 *   inside an active soap-opera / nurture SEQUENCE (an ordered,
 *   goal-directed narrative), read from the active-SOS stage:* tags.
 *   Brunson (DotCom Secrets) gates the Seinfeld/Side-Filled broadcast
 *   (= S4.5 v2) on COMPLETION of the soap opera sequence — you never run
 *   the Seinfeld layer on a contact still inside an SOS, or the narratives
 *   blur. inNarrativeNurture only caught the active-s4.5 tag (already on
 *   the Seinfeld layer); isInActiveBofu only caught bottom-funnel
 *   CONVERSION tags. Neither caught a contact mid-Indoctrination /
 *   re-engagement / reactivation / post-appointment — ~1,300 open-P1
 *   contacts that leaked into S4.5. Feeds the new
 *   SUPPRESSED_ACTIVE_NARRATIVE state. DELIBERATELY EXCLUDES
 *   stage:long-term-nurture (the post-SOS holding state = Brunson's "moved
 *   into the broadcast list", which IS the S4.5 destination) and the
 *   transient pre-SOS stages (stage:new-lead, stage:entry-bridge).
 * v1.5 — 2026-06-04. Fix hasActiveBooking() — it fired on ANY historical
 *   lp.appointment_set=true with NO date check, so a contact whose
 *   appointment was months in the PAST (cancelled / no-show / never-ran)
 *   still classified APPT_BOOKED and was wrongly suppressed from S4.5.
 *   Audit of the live APPT_BOOKED bucket (841 contacts) found only ~120
 *   had a genuinely future appointment; ~194 had an appointment >30d past
 *   with no demo, plus 111 demo-already-happened and 26 with a Sale row.
 *   An appointment is "active" only while it is UPCOMING and the demo has
 *   not yet run; once the date passes with no demo it's a no-show/cancel
 *   (S5.2 reactivation territory), and once the demo runs the contact is
 *   post-demo (ACTIVE_BOFU / DEMO_STALL / decline) — neither is APPT_BOOKED.
 *   hasActiveBooking now requires appointment_date >= now − grace
 *   (APPT_GRACE_DAYS, default 2, covers same-/next-day reschedule lag) on
 *   the LP-field branch. The stage:booked-* TAG branch is unchanged: those
 *   tags are set AND CLEARED by the APPT Handler workflows on booking /
 *   completion, so they're a reliable "currently booked" signal that
 *   doesn't drift the way a stale LP date does.
 */

// ── Tag presence ────────────────────────────────────────────────────

/** True if any of the listed tags is on the contact. Case-insensitive. */
export function hasAnyTag(ctx, tagList = []) {
  const tags = (ctx?.lead?.current_tags || []).map(t => String(t).toLowerCase());
  return tagList.some(t => tags.includes(String(t).toLowerCase()));
}

/** True if any tag matches one of the prefixes. */
export function hasAnyTagPrefix(ctx, prefixes = []) {
  const tags = (ctx?.lead?.current_tags || []).map(t => String(t).toLowerCase());
  return prefixes.some(p => {
    const pp = String(p).toLowerCase();
    return tags.some(t => t.startsWith(pp));
  });
}

// ── Legal / DNC ─────────────────────────────────────────────────────

const LEGAL_SUPPRESSION_TAGS = [
  'dnc',
  'dnc-email',
  'lp-dnc',
  'p3:dnc',
  'unsubscribed',
  'stop-seinfeld',
  'stop-marketing',
  'opt-out',
];

export function hasLegalSuppression(ctx) {
  return hasAnyTag(ctx, LEGAL_SUPPRESSION_TAGS);
}

// ── Appointment booked ──────────────────────────────────────────────
//
// A contact is APPT_BOOKED only while an appointment is genuinely ACTIVE:
// upcoming (or within a short reschedule grace) AND the demo has not yet
// run. Two independent signals — either is enough:
//
//   1. LP field branch: lp.appointment_set === true
//      AND lp.demo_completed !== true
//      AND lp.appointment_date >= now − APPT_GRACE_DAYS
//      The date guard is the v1.5 fix: without it, ANY historical
//      appointment_set=true (a cancelled/no-show/long-past booking) tripped
//      this signal and wrongly suppressed the contact from S4.5. Once the
//      appointment date passes with no demo, the contact is a no-show/cancel
//      (S5.2 reactivation territory), not "booked". A contact with
//      appointment_set=true but NO appointment_date is treated as NOT an
//      active booking on this branch (no date = can't confirm it's upcoming)
//      — the tag branch below still covers genuinely-booked contacts.
//
//   2. Tag branch: stage:booked-main-appointment / stage:booked-review /
//      stage:booking-main. These tags are SET on booking and CLEARED on
//      completion/cancel by the APPT Handler (A.*) workflows, so they're a
//      reliable "currently booked" signal that — unlike a stale LP date —
//      doesn't linger after the appointment is over. Left unchanged by v1.5.
//
// We deliberately do NOT treat lp.demo_completed=true as a booking — a
// completed demo means they're PAST the appointment. Post-demo states
// belong in ACTIVE_BOFU / S45_DEMO_STALL / post-demo-decline.

import { lpStoredToUtcMs } from '../../../lp-dates.js';

const APPT_GRACE_DAYS = Number(process.env.APPT_ACTIVE_GRACE_DAYS || 2);

export function hasActiveBooking(ctx) {
  // 1. LP field branch — requires an UPCOMING (or within-grace) date and no demo yet.
  if (ctx?.lp?.appointment_set === true && ctx?.lp?.demo_completed !== true) {
    const apptRaw = ctx?.lp?.appointment_date;
    if (apptRaw) {
      // lp.appointment_date holds ET wall-clock digits tagged +00:00, so
      // new Date(...) reads it 4-5h early and this gate released a live
      // booking that many hours before the grace cutoff. Convert to true
      // UTC before comparing to Date.now(). See src/lp-dates.js.
      const apptMs = lpStoredToUtcMs(apptRaw);
      if (Number.isFinite(apptMs)) {
        const graceCutoffMs = Date.now() - APPT_GRACE_DAYS * 86400000;
        if (apptMs >= graceCutoffMs) return true;
      }
    }
    // appointment_set=true but no/invalid date, or a past date → not an
    // active booking on this branch. Fall through to the tag branch.
  }
  // 2. Tag branch — APPT Handler gate tags (set on booking, cleared on completion).
  return hasAnyTag(ctx, [
    'stage:booked-main-appointment',
    'stage:booked-review',
    'stage:booking-main',
  ]);
}

// ── P2 customer (post-sale) ─────────────────────────────────────────
//
// v1.1: broadened from the original two checks to a five-signal OR.
//
// Why the broadening was needed
// ─────────────────────────────
// Original checks (still here, top of the OR chain):
//   1. opportunity in pipeline P2
//   2. lp.closed_won === true
// Both are clean signals when present, but neither is REQUIRED for a
// real post-sale customer:
//   - context-builder returns only the most-recently-updated opp; for
//     contacts who finished the P1 sale path and moved to P2 lifecycle,
//     that's often still the P1 "Sale Recorded" opp, not any P2 row
//   - lp.closed_won is tied to LP disposition codes like SW; contacts
//     with OPPFDN (demo ran, opp full down) can still be post-sale per
//     downstream milestones, even though closed_won=false
//
// Added signals (broaden the net):
//   3. ANY p2-stage:* tag — set by P2 lifecycle workflows (financing,
//      production, install-scheduled, install-completed)
//   4. lp-milestone-completion — LP confirms install complete
//   5. opportunity.status === 'won' + lp-demo-completed — P1 sale path
//      finished, demo verified by LP
//
// False-positive resistance: none of the added signals can fire on a
// pre-sale contact. p2-stage:* prefix is reserved for the P2 lifecycle
// pipeline. lp-milestone-completion is set only by the LP completion
// webhook. opp.status='won' + lp-demo-completed requires both a closed-
// won P1 opportunity AND a verified completed demo — impossible pre-sale.
//
// Priority effect: CUSTOMER_P2 runs BEFORE ACTIVE_BOFU in the suppression
// shape, so this broadening correctly catches Chuck-Muller-style contacts
// (post-sale but still carrying bj:stage-5-committed) before the sticky
// BOFU tag mistakenly fires.

const PIPELINE_P2_ID = '44mOrpmHqk7YqZN9vSPW';

const P2_LIFECYCLE_TAG_PREFIXES = ['p2-stage:'];

const POST_SALE_MILESTONE_TAGS = [
  'lp-milestone-completion',
];

const DEMO_VERIFIED_TAGS = [
  'lp-demo-completed',
];

export function isCustomerP2(ctx) {
  // 1. Direct P2 pipeline membership
  if (ctx?.pipeline?.pipeline_id === PIPELINE_P2_ID) return true;
  // 2. LP says sale is recorded
  if (ctx?.lp?.closed_won === true) return true;
  // 3. Any p2-stage:* tag = P2 lifecycle workflow has touched the contact
  if (hasAnyTagPrefix(ctx, P2_LIFECYCLE_TAG_PREFIXES)) return true;
  // 4. LP completion milestone = install finished
  if (hasAnyTag(ctx, POST_SALE_MILESTONE_TAGS)) return true;
  // 5. P1 sale-recorded path: won opp + demo verified
  if (ctx?.pipeline?.status === 'won' && hasAnyTag(ctx, DEMO_VERIFIED_TAGS)) return true;
  return false;
}

// ── Post-demo decline (Full Demo No Sale) ───────────────────────────
//
// A recorded post-demo decline: the demo ran and the customer said no.
// LP disposition_code OPPFDN ("Opportunity / Full Demo No Sale") or FDNS.
// This is an attribute of the PERSON / relationship stage — they have
// EXITED the buying conversation — not of one funnel. Per the Brunson
// follow-up-funnel framing, the S4.5 Seinfeld/soap-opera nurture is for
// the undecided "maybe," never the recorded "no." So a decline suppresses
// S4.5 across ALL FIVE eligible behavioral shapes, not per-shape.
//
// Why this is a SUPPRESSION signal, not just a DEMO_STALL exclusion
// ─────────────────────────────────────────────────────────────────
// behavioral-signals.js v0.2.3 already excludes OPPFDN/FDNS from the
// DEMO_STALL shape. But a declined contact with stale intent on record
// (old estimate, historical clicks) + dormancy was re-admitted via
// S45_DORMANT_HIGH_INTENT. The decline has to gate the whole eligible
// set, so it lives here as a suppression signal checked before any shape.
//
// Field name: the real LP/context field is `disposition_code`
// (`disposition` kept as a legacy fallback). Upper-cased for comparison.
// NOTE: OPPFDN also appears in the isCustomerP2 commentary as a code that
// does NOT imply closed_won — consistent here: a decline is a LOSS, routed
// to the loss/reactivation track (S5.2 / L.*), distinct from a P2 customer.

const POST_DEMO_DECLINE_DISPOSITIONS = ['OPPFDN', 'FDNS'];

/** Normalised LP disposition code (disposition_code, legacy disposition). */
function dispositionCode(ctx) {
  const raw = ctx?.lp?.disposition_code ?? ctx?.lp?.disposition ?? '';
  return String(raw).trim().toUpperCase();
}

export function isPostDemoDecline(ctx) {
  return POST_DEMO_DECLINE_DISPOSITIONS.includes(dispositionCode(ctx));
}

// ── Confirmed loss (competitor / not-interested, recorded in TAGS) ──
//
// A confirmed LOSS recorded in GHL tags, INDEPENDENT of the LP disposition
// code. Where isPostDemoDecline catches the demo-decline disposition codes
// (OPPFDN/FDNS), a contact can be a settled "no" — bought from a competitor,
// explicitly not interested — while LP carries a non-demo-decline
// disposition (e.g. CXL). The loss then lives ONLY in the tag signature, and
// without this check the contact falls through to the S4.5 eligible shapes.
//
// Surfaced live 2026-06-03 by Gerald Aloia (zrjJPmKbjX3TZpHiEuVX): tags
// loss-reason:not-interested + p3:not-interested-now +
// objection-confirmed:not-interested, AI summary "hired another company, no
// longer interested," disposition CXL — classified S45_TRUST_RECOVERY 0.90
// and auto-enrolled into S4.5 by the sweep. A bought-elsewhere "no" is the
// textbook contact the follow-up funnel must SUPPRESS.
//
// Signals (any one = confirmed loss):
//   - exact tags: objection-confirmed:not-interested, loss-needs-reason is
//     NOT included (that's a pending-reason flag, not a confirmed loss)
//   - prefix loss-reason:*  — a loss reason has been recorded
//   - prefix p3:not-interested  — P3 recycle bucket: not-interested(-now)
//   - exact tag concern-expressed:competitor PAIRED with a loss/objection
//     signal — competitor concern alone is mid-funnel and must NOT suppress;
//     only when it co-occurs with a confirmed-loss marker is it a loss.
//
// Deliberately CONSERVATIVE: a bare concern-expressed:competitor (still in
// the conversation, comparing vendors) is NOT a loss and stays eligible for
// BOFU/objection handling. We require an explicit loss/not-interested marker.
//
// Routes to the loss/reactivation track (L.* / P3), not S4.5.

const CONFIRMED_LOSS_TAGS = [
  'objection-confirmed:not-interested',
];

const CONFIRMED_LOSS_TAG_PREFIXES = [
  'loss-reason:',
  'p3:not-interested',
];

export function isConfirmedLoss(ctx) {
  if (hasAnyTag(ctx, CONFIRMED_LOSS_TAGS)) return true;
  if (hasAnyTagPrefix(ctx, CONFIRMED_LOSS_TAG_PREFIXES)) return true;
  // Competitor concern is a loss ONLY when paired with a confirmed-loss
  // marker — a bare competitor concern is mid-funnel comparison, not a loss.
  if (
    hasAnyTag(ctx, ['concern-expressed:competitor', 'objection:competitor']) &&
    (hasAnyTag(ctx, CONFIRMED_LOSS_TAGS) || hasAnyTagPrefix(ctx, CONFIRMED_LOSS_TAG_PREFIXES))
  ) {
    return true;
  }
  return false;
}

// ── Active BOFU ─────────────────────────────────────────────────────
//
// BOFU = Bottom of Funnel — contact is in active conversion work and
// shouldn't be diverted to long-horizon narrative nurture.
//
// Signals (any one is enough):
//   1. stage:* tag in the BOFU set
//   2. buyer:* / bj:* tag indicating stage 3+
//   3. hold:no-rehash (rep is closing — do not interfere)
//
// IMPORTANT: bj:stage-5-committed and buyer:committed are STICKY tags
// that remain after a sale completes. They correctly identify pre-sale
// committed buyers as BOFU, but produce false positives for post-sale
// customers. The CUSTOMER_P2 check (v1.1+, above) runs FIRST in the
// suppression priority order and catches post-sale customers via the
// p2-stage:* / lp-milestone-completion / won-opp signals before the
// sticky BOFU tags get a chance to fire here. Don't remove the sticky
// tags from BOFU_BUYER_TAGS — they're correct for pre-sale committed
// buyers; the priority order is what disambiguates the two cases.

const BOFU_STAGE_TAGS = [
  'stage:solution-pitch',
  'stage:vendor-comparison',
  'stage:proposal-delivered',
  'stage:negotiating',
  'stage:conversion-sequence',
  'stage:objection-handling',
  'stage:hot-call',
];

const BOFU_BUYER_TAGS = [
  'buyer:vendor-comparison',
  'buyer:negotiating',
  'buyer:committed',
  'bj:stage-3-comparing',
  'bj:stage-4-negotiating',
  'bj:stage-5-committed',
];

const HOLD_TAGS = [
  'hold:no-rehash',
];

export function isInActiveBofu(ctx) {
  return hasAnyTag(ctx, [...BOFU_STAGE_TAGS, ...BOFU_BUYER_TAGS, ...HOLD_TAGS]);
}

// ── In another narrative nurture (already on the Seinfeld layer) ────
//
// Avoid two identity-framing sequences running in parallel — Mark's
// "two overlapping Seinfeld-style nurtures will psychologically blur."
//
// This catches a contact ALREADY ON the S4.5 (Seinfeld) layer via the
// active-s4.5 tag. It is the sibling of isInActiveSoapOpera below, which
// catches the contact still on a PRIOR soap-opera sequence (not yet on
// S4.5). Both feed suppression; they cover the two distinct "a narrative
// is already running" cases.
//
// Phase 2 expansion: as other broadcast-layer nurtures come online, add
// their tags here.

const NARRATIVE_NURTURE_TAGS = [
  'active-s4.5',
  's4.5-active',  // tolerate either naming convention
];

export function inNarrativeNurture(ctx) {
  return hasAnyTag(ctx, NARRATIVE_NURTURE_TAGS);
}

// ── In an active soap-opera / nurture SEQUENCE (pre-Seinfeld) ───────
//
// Brunson follow-up-funnel doctrine (DotCom Secrets): the Seinfeld /
// Side-Filled broadcast layer — which S4.5 v2 IS — is entered ONLY "after
// someone has completed your soap opera sequence." The Soap Opera Sequence
// (SOS) is the fixed, ordered, goal-directed narrative a contact runs on
// entry; the Seinfeld layer is the ongoing broadcast they're MOVED INTO
// once it finishes. COMPLETION is the gate. Running S4.5 on a contact still
// inside an SOS puts two narratives on one person — narrative blur.
//
// The active-SOS sequences in this system, by stage:* tag:
//   - stage:indoctrination / stage:education  — S2.x Indoctrination SOS
//   - stage:re-engagement                     — re-engagement SOS
//   - stage:reactivation                      — S5.x Reactivation SOS
//   - stage:appointment-rescue                — S5.2 Appointment Rescue SOS
//   - stage:post-appointment                  — F.x Post-Appointment SOS
//   - stage:active-nurture-broadcast          — already a broadcast layer
//
// DELIBERATE EXCLUSIONS (NOT suppressed by this signal):
//   - stage:long-term-nurture — the parked/holding state a contact reaches
//     AFTER its SOS completes. This is exactly Brunson's "moved into the
//     broadcast list" — the S4.5 destination — so it stays ELIGIBLE.
//   - stage:new-lead, stage:entry-bridge — transient pre-SOS states; not an
//     ordered narrative yet, left to the confidence floor to handle.
//   - BOFU conversion stages (solution-pitch, negotiating, …) — already
//     covered by isInActiveBofu; not duplicated here.
//   - terminal stages (dnc, unresponsive, customer-onboarding) — caught by
//     legal / cold / P2 paths.
//
// Note: stage:booked-main-appointment / stage:booking-main are handled by
// hasActiveBooking (APPT_BOOKED), so they are intentionally NOT in this set.

const ACTIVE_SOAP_OPERA_STAGE_TAGS = [
  'stage:indoctrination',
  'stage:education',
  'stage:re-engagement',
  'stage:reactivation',
  'stage:appointment-rescue',
  'stage:post-appointment',
  'stage:active-nurture-broadcast',
];

export function isInActiveSoapOpera(ctx) {
  return hasAnyTag(ctx, ACTIVE_SOAP_OPERA_STAGE_TAGS);
}

// ── Recent rep contact ──────────────────────────────────────────────
//
// "Manual rep call/SMS in last 14d" — protects the rep's active outreach
// from getting tangled with agentic nurture during a live conversation.
//
// Phase 1 signal source: lp.last_call_date (most reliable; LP is where
// reps log calls). Phase 2 may add: GHL conversation messages where
// outbound rep messages exist in last 14d.
//
// Returns true if the last LP call was within `withinDays` days.

export function hasRecentRepContact(ctx, withinDays = 14) {
  const lastCall = ctx?.lp?.last_call_date;
  if (!lastCall) return false;
  const ageMs = Date.now() - new Date(lastCall).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return false;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return ageDays <= withinDays;
}

// ── Diagnostics ─────────────────────────────────────────────────────

/**
 * Returns a snapshot of which signals fired for an audit trail. Used by
 * shapes when building state_reason — every classification carries an
 * explanation of which signals drove the decision.
 */
export function snapshotSuppressionSignals(ctx) {
  return {
    legal_suppression:    hasLegalSuppression(ctx),
    active_booking:       hasActiveBooking(ctx),
    customer_p2:          isCustomerP2(ctx),
    post_demo_decline:    isPostDemoDecline(ctx),
    confirmed_loss:       isConfirmedLoss(ctx),
    active_bofu:          isInActiveBofu(ctx),
    in_narrative_nurture: inNarrativeNurture(ctx),
    active_soap_opera:    isInActiveSoapOpera(ctx),
    recent_rep_contact:   hasRecentRepContact(ctx, 14),
    disposition_code:     dispositionCode(ctx) || null,
  };
}
