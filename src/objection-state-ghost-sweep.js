/**
 * Objection-State Ghost Sweep — src/objection-state-ghost-sweep.js
 *
 * Periodic sweep that emits `confirmation_unacknowledged` events for
 * contacts who match the "ghost after booking" pattern:
 *   - had an appointment booked (ghl.workflow_handoff with appt:booked
 *     OR system_events.event_type='ghl.appointment_booked')
 *   - THE SCHEDULED APPOINTMENT START passed at least GHOST_MIN_HOURS ago
 *   - THE SCHEDULED APPOINTMENT START passed at most GHOST_MAX_HOURS ago
 *     (so we don't re-emit forever)
 *   - NO LP disposition change has been observed since the appointment
 *   - NO inbound reply since the appointment
 *   - NO post-appointment disposition in lp_leads (v3 — 2026-05-21)
 *   - contact does not already have an open objection_state row
 *   - contact's current GHL tags do NOT indicate they've already sat,
 *     are a customer, are stop-bot/DNC, or are already enrolled in
 *     S5.2 v2 / W8.0 / W9.0 (v2 — 2026-05-21)
 *
 * Why emit `confirmation_unacknowledged` instead of writing the state
 * directly: the existing STATE_CLASSIFICATION rule
 * `BEHAVIORAL_GHOST_AFTER_BOOKING` already maps that event to
 * `APPOINTMENT_FRICTION.ghost_after_booking`. Emitting feeds the rule
 * through the same Decision Engine + handler path as every other
 * classification source — single chokepoint, single audit trail.
 *
 * Each candidate is emitted with an idempotency_key keyed by
 * contact_id + appointment fingerprint + day-bucket so the sweep is
 * safe to run on a tight cadence without spamming duplicate events,
 * while still re-evaluating cleanly after a rebook.
 *
 * ---------------------------------------------------------------------
 * 2026-08-17 (v4): TIME-ANCHOR FIX — THE CLASS-OF-BUG FIX.
 *
 * ROOT CAUSE: v1–v3 selected candidates by BOOKING-EVENT timestamp
 * (`system_events.event_timestamp`) and then treated that timestamp as
 * if it were the appointment time. It is not. It is the moment the
 * booking was recorded. Every downstream check ("disposition since",
 * "inbound since") was therefore anchored to the booking, not to the
 * appointment.
 *
 * CONSEQUENCE: any lead who books further out than GHOST_MIN_HOURS and
 * stays quiet — which is the NORMAL, HEALTHY pattern for a canvassed
 * lead booking 3–7 days ahead — was classified as having ghosted an
 * appointment that had not happened yet. The emitted payload even
 * asserted `appointment_pending: true` while classifying the contact
 * as a ghost, and named its own metric `hours_since_booking`.
 *
 * OBSERVED (2026-08-17 audit, trailing 30d, resolvable subset only):
 * 21 of 25 emissions fired while the appointment was still in the
 * future — an ~84% false-positive rate. Worst case fired 2 hours
 * BEFORE the appointment. Example: contact zKSSENAAskI95ARwCuK6
 * (LP prospect 232016) — booked 8/14 for an 8/19 10:00 AM confirmed
 * estimate, swept 8/17 at 51.5h "since booking", classified
 * ghost_after_booking, enrolled in S5.2 with the appointment still
 * two days out and LP disposition Cnf.
 *
 * v4 CHANGES:
 *   1. resolveApptStart() — reads the SCHEDULED start out of the
 *      booking payload, handling every shape the two event types
 *      produce, and converts ET wall-clock to a real UTC instant
 *      (DST-safe). This is the only time anchor used from here on.
 *   2. The GHOST_MIN/MAX window is applied to the APPOINTMENT START,
 *      not the booking timestamp. The SQL prefilter widens to a
 *      booking lookback (GHOST_BOOKING_LOOKBACK_DAYS) purely so that
 *      far-out bookings are still visible to the JS gate.
 *   3. HARD GATE: an appointment whose start is in the future can
 *      never be a ghost. Skipped and counted.
 *   4. FAIL CLOSED on an unresolvable appointment start. An unknown
 *      appointment time is exactly the ambiguity that produced this
 *      bug — we do not guess.
 *   5. LATEST-BOOKING-WINS: candidates are deduped to the newest
 *      booking event per contact. Without this, a rebooked contact
 *      would still be ghosted off their STALE booking event (whose
 *      appointment time IS in the past) — the same false positive
 *      through a side door.
 *   6. All activity checks ("disposition since", "inbound since") now
 *      anchor to the appointment start, which is what "since the
 *      appointment" was always supposed to mean.
 *   7. Payload renamed to honest field names: appointment_start,
 *      hours_since_appointment. The false `appointment_pending: true`
 *      assertion is removed.
 *
 * NOTE: the appointment-tag family (appt-exists, booked-estimate,
 * appt:window-estimate, …) is deliberately NOT added to EXCLUDE_TAGS.
 * Those tags survive a real no-show, so excluding them would suppress
 * legitimate ghost detection. The date gate is the correct guard
 * because it self-resolves once the appointment actually passes.
 * ---------------------------------------------------------------------
 *
 * 2026-05-21 (v3): SECOND DEFENSE LAYER. Bypass the event-bus null-
 * ghl_id problem by reading lp_leads directly. The v2 fix relied on
 * the contact's GHL tags being correctly synced from LP. But for
 * Sales Rabbit / canvassing leads, the `stage:post-appointment` tag
 * is applied via a workflow that depends on the LP→GHL field sync
 * firing — which fails when LP's lp.disposition_changed event is
 * emitted with NULL ghl_contact_id (95% of the time per 30d data).
 *
 * v3 adds hasPostApptDispositionInLPLeads(contactId): a direct
 * supabase query that checks if ANY lp_leads row for this contact
 * shows demo_completed=true, closed_won=true, or a disposition_code
 * in POST_APPT_DISPOSITION_CODES (the set of codes that imply the
 * appointment time has passed with a known outcome — sat, no-show,
 * sold, etc.). This is the canonical LP-side truth, completely
 * independent of the event bus and of GHL tag state.
 *
 * Layered defense order (cheapest-first):
 *   0. resolveApptStart + window gate (v4) — pure arithmetic, no I/O
 *   1. hasDispositionSince     — event bus, by ghl_contact_id (still useful when populated)
 *   2. hasInboundSince         — event bus, inbound replies
 *   3. hasPostApptDispositionInLPLeads (v3) — direct lp_leads check, sidesteps event bus
 *   4. hasOpenObjectionState   — already-managed contacts
 *   5. findExcludedTag (v2)    — live GHL tag check (most expensive — last resort)
 *
 * 2026-05-21 (v2): FALSE-POSITIVE FIX. Mark observed a wave of 24
 * ghost-after-booking enrollments where 14+ contacts had `stage:post-
 * appointment` / `active-w8.0` / `deal-won` tags (already sat or
 * already converted), plus 2 had `stop-bot`. The sweep was checking
 * only the event bus for evidence of life — which fails when LP-MCP
 * never emitted `lp.disposition_changed` for a sit (a known sync gap).
 *
 * v2 adds a live GHL tag check before emitting. Any tag in
 * EXCLUDE_TAGS short-circuits the contact. This is a belt-and-
 * suspenders fix paired with context_conditions on Rule 240
 * (BEHAVIORAL_GHOST_AFTER_BOOKING) — the rule gates again at decision
 * time so a tag added between sweep emit and rule evaluation still
 * blocks the false positive. Both gates were missing in v1.
 *
 * Tuning knobs (env or defaults below):
 *   GHOST_MIN_HOURS=24                 (hours since APPOINTMENT START)
 *   GHOST_MAX_HOURS=72                 (hours since APPOINTMENT START)
 *   GHOST_BOOKING_LOOKBACK_DAYS=120    (how far back to scan booking events)
 *   GHOST_SWEEP_BATCH=200
 *   GHOST_SWEEP_INTERVAL_MS=4h
 */

import supabase from './supabase.js';
import { emitEvent } from './event-emitter.js';
import { getGHLContact } from './ghl.js';

const GHOST_MIN_HOURS = Number(process.env.GHOST_MIN_HOURS || 24);
const GHOST_MAX_HOURS = Number(process.env.GHOST_MAX_HOURS || 72);
const GHOST_BOOKING_LOOKBACK_DAYS = Number(process.env.GHOST_BOOKING_LOOKBACK_DAYS || 120);
const GHOST_SWEEP_BATCH = Number(process.env.GHOST_SWEEP_BATCH || 200);
const GHOST_SWEEP_INTERVAL_MS = Number(process.env.GHOST_SWEEP_INTERVAL_MS || 4 * 60 * 60 * 1000);

const APPT_EVENT_TYPES = ['ghl.appointment_booked', 'ghl.workflow_handoff'];
const APPT_SUBTYPES = ['appt:booked', 'appointment_booked'];

const DISPOSITION_EVENT_TYPES = ['lp.disposition_changed'];
const INBOUND_EVENT_TYPES = ['ghl.reply_received', 'sms.received'];

// The business runs in ET. Appointment payloads carry ET wall-clock
// times with no offset, so they must be converted against this zone.
const ET_TZ = 'America/New_York';

// v3 — disposition codes that mean "the appointment time has passed
// with a known outcome." Any contact whose lp_leads cache shows ANY
// of these codes is past the ghost-after-booking window — they
// either sat, no-showed, sold, or reached a definitive post-demo
// state. Pre-demo codes (Set, Cnf, Data, CCC, Verif) are NOT in
// this set — those are still in the window where ghosting matters.
//
// Source for code semantics: src/sync-dispositions.js
// KNOWN_DISPOSITION_LABELS.
const POST_APPT_DISPOSITION_CODES = new Set([
  // Sat / closed-won
  'OPPFDN',    // Opportunity Found — post-demo, opp identified
  'Sat',       // Sat for the demo
  'Sold',      // Sold (legacy SL)
  'SW',        // Sold — Written Up
  'Sale',      // Contract Signed
  'PM',        // Pending Measure — post-sale
  // No-show / appointment-failed-but-resolved
  'NS',        // No-Show on first demo attempt
  'FDNS',      // Final Demo No-Show — appointment fully resolved
  'No Demo',   // Demo not completed (but attempted)
  // Post-demo no-opp variants
  '1Leg',      // One Leg Present — they sat, only one spouse
  'NIS',       // Not Interested — Shown (sat then declined)
  'NIS2',      // NIS variant
  'NOP NOP',   // No Opportunity — No Opp
  'NOP ITM',   // No Opp — In The Market
  'NOP MPR',   // No Opp — Must Price Right
  'OPP NOI',   // Opportunity — Not Interested Now (deferred)
]);

// v2 — tag-based exclusion list. Any contact carrying ANY of these tags
// is treated as "already past the point where ghosting matters" and
// skipped by the sweep. Keep this list in sync with Rule 240's
// context_conditions.not_has_any_tag — both layers should be redundant.
//
// Categories:
//   - Already-sat / post-demo:  stage:post-appointment, lp-demo-completed,
//                               active-w8.0, active-w9.0
//   - Already-converted:        customer, lp-sale, lp-customer, deal-won,
//                               buyer:post-decision, bj:stage-5-committed,
//                               stage:customer-onboarding, p2:active
//   - DNC / suppression:        stop-bot, dnc, dnc-related, unsubscribed,
//                               optedOut, stage:dnc, cooling-active
//   - Already-in-rescue:        active-w-S5.2, active-w5.2, active-w-S5.1,
//                               active-s5.2
//
// v4 note: appointment-EXISTS tags are intentionally absent — see the
// v4 header block. They persist through a genuine no-show, so gating
// on them would suppress real ghosts. Time is the correct gate.
const EXCLUDE_TAGS = new Set([
  // Sat / post-demo
  'stage:post-appointment',
  'lp-demo-completed',
  'active-w8.0',
  'active-w9.0',
  // Converted
  'customer', 'lp-sale', 'lp-customer', 'deal-won',
  'buyer:post-decision', 'bj:stage-5-committed',
  'stage:customer-onboarding', 'p2:active',
  // DNC / suppression
  'stop-bot', 'dnc', 'dnc-related', 'unsubscribed', 'optedOut',
  'stage:dnc', 'cooling-active',
  // Terminal hard-DQ (closeout chain, 2026-06-10) — structurally
  // disqualified contacts must never be ghost-recovered
  'hard-disqualified', 'suppress-outbound',
  // Already in rescue workflow
  'active-w-S5.2', 'active-w5.2', 'active-w-S5.1', 'active-s5.2',
]);

/* ------------------------------------------------------------------ *
 * v4 — appointment-time resolution (ET wall clock → UTC instant)
 * ------------------------------------------------------------------ */

/**
 * Minutes by which ET wall-clock leads real UTC at a given instant.
 * Derived from Intl so DST is handled without a tz dependency.
 */
function etOffsetMinutes(date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TZ,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(date)) p[type] = value;
  const hour = p.hour === '24' ? 0 : Number(p.hour);
  const asIfUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    hour, Number(p.minute), Number(p.second),
  );
  return (asIfUtc - date.getTime()) / 60000;
}

/**
 * Convert an ET wall-clock date/time into a UTC instant, DST-safe.
 * Two-pass: guess, measure the offset at the guess, correct, re-check.
 */
function etWallToInstant(y, mo, d, h, mi) {
  const naive = Date.UTC(y, mo - 1, d, h, mi, 0);
  let instant = naive;
  for (let i = 0; i < 2; i++) {
    const off = etOffsetMinutes(new Date(instant));
    const next = naive - off * 60000;
    if (next === instant) break;
    instant = next;
  }
  return new Date(instant);
}

/** Parse "6:00 PM" / "18:00" / "10:00 AM" → { h, mi } or null. */
function parseClock(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2]);
  const mer = m[3] ? m[3].toUpperCase() : null;
  if (mer === 'PM' && h < 12) h += 12;
  if (mer === 'AM' && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  return { h, mi };
}

/** Parse "2026-08-19" → { y, mo, d } or null. */
function parseYmd(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}

/**
 * v4 — resolve the SCHEDULED appointment start from a booking event.
 *
 * Handles every payload shape the two candidate event types emit:
 *
 *   ghl.appointment_booked
 *     payload.startDate  "2026-08-19"   +  payload.start_time "10:00 AM"
 *
 *   ghl.workflow_handoff (appt:booked)
 *     payload.calendar.startTime          "2026-08-19T10:00:00"  (naive ET)
 *     payload.customData.appointment_date "2026-08-19"
 *       + payload.customData.appointment_time "10:00 AM"
 *     payload["Last Appointment Start Date"] / ["... Start Time"]
 *
 * A string carrying an explicit offset or Z is parsed as an absolute
 * instant. A naive string is interpreted as ET wall time.
 *
 * Returns a Date, or null when nothing usable is present. Callers MUST
 * treat null as fail-closed.
 */
export function resolveApptStart(appt) {
  const p = appt && appt.payload;
  if (!p || typeof p !== 'object') return null;

  const cal = p.calendar && typeof p.calendar === 'object' ? p.calendar : {};
  const cd = p.customData && typeof p.customData === 'object' ? p.customData : {};

  // 1. Full datetime strings, most trustworthy first.
  const isoCandidates = [cal.startTime, p.start_time_iso, p.startTime];
  for (const raw of isoCandidates) {
    if (!raw || typeof raw !== 'string') continue;
    const s = raw.trim();
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) continue;
    if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
      const dt = new Date(s);
      if (!Number.isNaN(dt.getTime())) return dt;
      continue;
    }
    const ymd = parseYmd(s);
    const clock = parseClock(s.slice(11, 16));
    if (ymd && clock) return etWallToInstant(ymd.y, ymd.mo, ymd.d, clock.h, clock.mi);
  }

  // 2. Split date + clock pairs (ET wall time).
  const pairs = [
    [p.startDate, p.start_time],
    [cd.appointment_date, cd.appointment_time],
    [p['Last Appointment Start Date'], p['Last Appointment Start Time']],
    [p['LP Appointment Date'], p['LP Appointment Time']],
  ];
  for (const [dateRaw, timeRaw] of pairs) {
    const ymd = parseYmd(dateRaw);
    if (!ymd) continue;
    const clock = parseClock(timeRaw);
    if (!clock) continue;
    return etWallToInstant(ymd.y, ymd.mo, ymd.d, clock.h, clock.mi);
  }

  return null;
}

/**
 * v4 — collapse candidates to the NEWEST booking event per contact.
 *
 * Critical: a contact who rebooked has an older booking event whose
 * appointment time has already passed. Evaluating that stale event
 * re-creates the exact false positive this version fixes. Only the
 * current appointment can be ghosted.
 */
function pickLatestBookingPerContact(events) {
  const byContact = new Map();
  let superseded = 0;
  for (const e of events) {
    const id = e.ghl_contact_id;
    if (!id) continue;
    const prev = byContact.get(id);
    if (!prev) {
      byContact.set(id, e);
      continue;
    }
    superseded++;
    if (new Date(e.event_timestamp) > new Date(prev.event_timestamp)) {
      byContact.set(id, e);
    }
  }
  return { latest: [...byContact.values()], superseded };
}

async function findApptCandidates(now) {
  // v4 — the SQL filter is now only a coarse prefilter on BOOKING time.
  // Bookings can be made far in advance, so the lookback must be wide
  // enough that a far-out appointment is still visible when its start
  // finally lands in the ghost window. The real window test is applied
  // in JS against the resolved APPOINTMENT START.
  const bookingFloor = new Date(
    now.getTime() - GHOST_BOOKING_LOOKBACK_DAYS * 24 * 3600 * 1000,
  ).toISOString();

  const { data, error } = await supabase
    .from('system_events')
    .select('id, ghl_contact_id, event_type, event_subtype, event_timestamp, payload')
    .in('event_type', APPT_EVENT_TYPES)
    .gte('event_timestamp', bookingFloor)
    .not('ghl_contact_id', 'is', null)
    .order('event_timestamp', { ascending: false })
    .limit(GHOST_SWEEP_BATCH);

  if (error) throw new Error(`ghost sweep candidate query: ${error.message}`);
  return (data || []).filter(e =>
    e.event_type === 'ghl.appointment_booked' ||
    (e.event_type === 'ghl.workflow_handoff' && APPT_SUBTYPES.includes(e.event_subtype)),
  );
}

async function hasDispositionSince(contactId, since) {
  const { data } = await supabase
    .from('system_events')
    .select('id')
    .eq('ghl_contact_id', contactId)
    .in('event_type', DISPOSITION_EVENT_TYPES)
    .gt('event_timestamp', since)
    .limit(1);
  return (data || []).length > 0;
}

async function hasInboundSince(contactId, since) {
  const { data } = await supabase
    .from('system_events')
    .select('id')
    .eq('ghl_contact_id', contactId)
    .in('event_type', INBOUND_EVENT_TYPES)
    .gt('event_timestamp', since)
    .limit(1);
  return (data || []).length > 0;
}

async function hasOpenObjectionState(contactId) {
  // contact_objection_states may not exist in all envs (substrate seed
  // pending). Treat a missing table / query error as "no open state" so
  // the sweep degrades gracefully instead of silently halting.
  try {
    const { data, error } = await supabase
      .from('contact_objection_states')
      .select('id')
      .eq('contact_id', contactId)
      .is('exited_at', null)
      .limit(1);
    if (error) return false;
    return (data || []).length > 0;
  } catch {
    return false;
  }
}

/**
 * v3 — direct lp_leads check, sidesteps the event-bus null-ghl_id
 * problem. Returns the matched signal if ANY lp_leads row tied to
 * this contact shows:
 *   - demo_completed = true
 *   - closed_won = true
 *   - disposition_code in POST_APPT_DISPOSITION_CODES
 *
 * No `since` cutoff: a contact who has EVER had a post-appointment
 * disposition is, by definition, not in the "first-time ghost"
 * window. Subsequent ghosting (a contact who sat in 2024 and rebooks
 * in 2026, then ghosts the new appt) needs a different state machine
 * (re-engagement / S5.x), not ghost-after-booking. The system
 * recognizes "first sat" as a terminal state for this classifier.
 *
 * Returns:
 *   null                     — no post-appt signal in lp_leads
 *   string (signal name)     — first match found, e.g. "demo_completed",
 *                              "closed_won", "disposition:OPPFDN"
 *
 * Fails open (returns null) on supabase errors — the v2 tag check
 * downstream still gates, so we don't double-fail-closed.
 */
async function findPostApptDispositionSignal(contactId) {
  try {
    const { data, error } = await supabase
      .from('lp_leads')
      .select('lp_lead_id, disposition_code, demo_completed, closed_won, updated_at_lp')
      .eq('ghl_contact_id', contactId)
      .order('updated_at_lp', { ascending: false, nullsFirst: false })
      .limit(10);
    if (error || !data || data.length === 0) return null;

    for (const row of data) {
      if (row.demo_completed === true) return 'demo_completed';
      if (row.closed_won === true) return 'closed_won';
      if (row.disposition_code && POST_APPT_DISPOSITION_CODES.has(row.disposition_code)) {
        return `disposition:${row.disposition_code}`;
      }
    }
    return null;
  } catch (err) {
    console.warn(`[GhostSweep] lp_leads sit check failed for ${contactId}: ${err.message}`);
    return null; // fail-open — tag check downstream still gates
  }
}

/**
 * v2 — fetch the contact's live tags from GHL and return the first
 * EXCLUDE_TAGS match, or null if none match. Used to short-circuit
 * contacts who have already sat / converted / been DNC'd before
 * emitting the ghost-after-booking event.
 *
 * On GHL API failure we FAIL CLOSED: return 'fetch_failed' so the
 * sweep skips the contact rather than emitting a potentially-wrong
 * ghost classification. The contact will get another chance on the
 * next sweep cycle when GHL is healthy.
 *
 * Returns:
 *   null                 — no excluded tags, OK to emit
 *   string (tag name)    — first excluded tag found; skip contact
 *   'fetch_failed'       — GHL fetch errored; fail closed and skip
 */
async function findExcludedTag(contactId) {
  let contact;
  try {
    contact = await getGHLContact(contactId);
  } catch (err) {
    console.warn(`[GhostSweep] contact fetch failed for ${contactId}: ${err.message} — failing closed`);
    return 'fetch_failed';
  }
  if (!contact) return 'fetch_failed';

  const tags = Array.isArray(contact.tags) ? contact.tags : [];
  for (const t of tags) {
    if (EXCLUDE_TAGS.has(t)) return t;
  }
  return null;
}

export async function runGhostSweep({ dryRun = false } = {}) {
  const start = Date.now();
  const now = new Date();
  const rawCandidates = await findApptCandidates(now);

  // v4 — only the current appointment per contact is eligible.
  const { latest: candidates, superseded } = pickLatestBookingPerContact(rawCandidates);

  const minMs = GHOST_MIN_HOURS * 3600 * 1000;
  const maxMs = GHOST_MAX_HOURS * 3600 * 1000;

  let emitted = 0;
  let skippedFutureAppt = 0;
  let skippedOutsideWindow = 0;
  let skippedUnresolvedApptTime = 0;
  let skippedActivity = 0;
  let skippedHasState = 0;
  let skippedPostApptDispo = 0;
  let skippedExcludedTag = 0;
  let skippedFetchFailed = 0;
  let errors = 0;
  const details = [];
  const exclusionCounts = {};
  const postApptDispoCounts = {};

  for (const appt of candidates) {
    const contactId = appt.ghl_contact_id;
    if (!contactId) continue;
    try {
      // ---- v4 GATE 0: the appointment itself. -----------------------
      const apptStart = resolveApptStart(appt);

      // FAIL CLOSED. An unknown appointment time is precisely the
      // ambiguity that caused the v1–v3 false-positive wave.
      if (!apptStart) {
        skippedUnresolvedApptTime++;
        if (dryRun) {
          details.push({
            contact_id: contactId,
            appt_id: appt.id,
            decision: 'skipped_unresolved_appt_time',
            event_type: appt.event_type,
          });
        }
        continue;
      }

      const elapsedMs = now.getTime() - apptStart.getTime();

      // A future appointment can never have been ghosted.
      if (elapsedMs < 0) {
        skippedFutureAppt++;
        if (dryRun) {
          details.push({
            contact_id: contactId,
            appt_id: appt.id,
            decision: 'skipped_future_appointment',
            appointment_start: apptStart.toISOString(),
            hours_until_appointment: Number((-elapsedMs / 3600000).toFixed(2)),
          });
        }
        continue;
      }

      // Outside the ghost window: too fresh, or too stale to re-open.
      if (elapsedMs < minMs || elapsedMs > maxMs) {
        skippedOutsideWindow++;
        if (dryRun) {
          details.push({
            contact_id: contactId,
            appt_id: appt.id,
            decision: 'skipped_outside_window',
            appointment_start: apptStart.toISOString(),
            hours_since_appointment: Number((elapsedMs / 3600000).toFixed(2)),
          });
        }
        continue;
      }

      // v4 — every "since" check below anchors to the APPOINTMENT,
      // which is what "since the appointment" always meant.
      const since = apptStart.toISOString();

      if (await hasDispositionSince(contactId, since)) {
        skippedActivity++;
        continue;
      }
      if (await hasInboundSince(contactId, since)) {
        skippedActivity++;
        continue;
      }

      // v3 — direct lp_leads check. Catches the 95% of cases where
      // lp.disposition_changed events fired with NULL ghl_contact_id
      // because lp_leads.ghl_contact_id wasn't populated at sync time.
      // No since cutoff — a contact who EVER had a post-appt
      // disposition is permanently outside the ghost-after-booking
      // classifier. Re-engagement after a prior sit is a different
      // state and goes through a different recovery path.
      const postApptSignal = await findPostApptDispositionSignal(contactId);
      if (postApptSignal !== null) {
        skippedPostApptDispo++;
        postApptDispoCounts[postApptSignal] = (postApptDispoCounts[postApptSignal] || 0) + 1;
        if (dryRun) details.push({ contact_id: contactId, decision: 'skipped_post_appt_dispo', signal: postApptSignal });
        continue;
      }

      if (await hasOpenObjectionState(contactId)) {
        skippedHasState++;
        continue;
      }

      // v2 — tag check (after all the cheap supabase checks; this hits
      // the GHL API per surviving candidate).
      const excludedTag = await findExcludedTag(contactId);
      if (excludedTag === 'fetch_failed') {
        skippedFetchFailed++;
        if (dryRun) details.push({ contact_id: contactId, decision: 'skipped_fetch_failed' });
        continue;
      }
      if (excludedTag !== null) {
        skippedExcludedTag++;
        exclusionCounts[excludedTag] = (exclusionCounts[excludedTag] || 0) + 1;
        if (dryRun) details.push({ contact_id: contactId, decision: 'skipped_excluded_tag', tag: excludedTag });
        continue;
      }

      const hoursSinceAppointment = Number((elapsedMs / 3600000).toFixed(2));

      if (dryRun) {
        emitted++;
        details.push({
          contact_id: contactId,
          appt_id: appt.id,
          appointment_start: apptStart.toISOString(),
          hours_since_appointment: hoursSinceAppointment,
          would_emit: true,
        });
        continue;
      }

      // v4 — idempotency keyed by the APPOINTMENT as well as the day,
      // so a rebook gets a fresh evaluation instead of being
      // suppressed by a same-day bucket from the prior appointment.
      const dayBucket = new Date().toISOString().slice(0, 10);
      const apptFingerprint = apptStart.toISOString().slice(0, 13);
      const result = await emitEvent({
        event_type: 'confirmation_unacknowledged',
        event_subtype: 'ghost_after_booking',
        source: 'objection_state_ghost_sweep',
        entity_type: 'contact',
        entity_id: contactId,
        ghl_contact_id: contactId,
        payload: {
          appointment_start: apptStart.toISOString(),
          appointment_event_id: appt.id,
          booking_timestamp: appt.event_timestamp,
          hours_since_appointment: hoursSinceAppointment,
          sweep_version: 'v4',
        },
        priority: 'normal',
        idempotency_key: `ghost_sweep_${contactId}_${apptFingerprint}_${dayBucket}`,
        bypass_filter: true,
      });
      if (result && result.filtered !== true) emitted++;
    } catch (err) {
      errors++;
      console.error(`[GhostSweep] ${contactId} failed: ${err.message}`);
    }
  }

  const summary = {
    success: true,
    booking_events_scanned: rawCandidates.length,
    candidates: candidates.length,
    superseded_bookings_collapsed: superseded,
    emitted,
    skipped_future_appointment: skippedFutureAppt,
    skipped_outside_window: skippedOutsideWindow,
    skipped_unresolved_appt_time: skippedUnresolvedApptTime,
    skipped_recent_activity: skippedActivity,
    skipped_has_open_state: skippedHasState,
    skipped_post_appt_dispo: skippedPostApptDispo,
    skipped_excluded_tag: skippedExcludedTag,
    skipped_fetch_failed: skippedFetchFailed,
    errors,
    dry_run: !!dryRun,
    window_hours: [GHOST_MIN_HOURS, GHOST_MAX_HOURS],
    anchored_on: 'appointment_start',
    elapsed_ms: Date.now() - start,
  };
  if (skippedPostApptDispo > 0) summary.post_appt_dispo_breakdown = postApptDispoCounts;
  if (skippedExcludedTag > 0) summary.exclusion_breakdown = exclusionCounts;
  if (dryRun) summary.details = details;
  console.log(
    `[GhostSweep v4] ${rawCandidates.length} booking events → ${candidates.length} current → ${emitted} emitted, ` +
    `${skippedFutureAppt} skipped (future appt), ${skippedOutsideWindow} skipped (outside window), ` +
    `${skippedUnresolvedApptTime} skipped (unresolved appt time), ` +
    `${skippedActivity} skipped (activity), ${skippedHasState} skipped (open state), ` +
    `${skippedPostApptDispo} skipped (post-appt dispo), ` +
    `${skippedExcludedTag} skipped (excluded tag), ${skippedFetchFailed} skipped (fetch failed), ` +
    `${errors} errors (${summary.elapsed_ms}ms)`
  );
  return summary;
}

let intervalHandle = null;

export function startGhostSweepScheduler() {
  if (intervalHandle) return;
  // First run after 3 minutes (server-settle delay).
  setTimeout(() => {
    runGhostSweep().catch(err => console.error('[GhostSweep] scheduled run failed:', err.message));
    intervalHandle = setInterval(() => {
      runGhostSweep().catch(err => console.error('[GhostSweep] scheduled run failed:', err.message));
    }, GHOST_SWEEP_INTERVAL_MS);
  }, 180000);
  console.log(`[GhostSweep] Scheduler armed: ${GHOST_MIN_HOURS}–${GHOST_MAX_HOURS}h post-APPOINTMENT window, ${GHOST_BOOKING_LOOKBACK_DAYS}d booking lookback, ${GHOST_SWEEP_INTERVAL_MS / 60000}min cadence`);
}

export function registerGhostSweepRoutes(app) {
  app.post('/n8n/objection-state/ghost-sweep', async (req, res) => {
    try {
      const dryRun = req.body?.dryRun === true || req.query?.dryRun === 'true';
      const result = await runGhostSweep({ dryRun });
      res.json(result);
    } catch (err) {
      console.error('[GhostSweep] /ghost-sweep error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });
  console.log('[GhostSweep] Registered: POST /n8n/objection-state/ghost-sweep');
}

// v3: Export POST_APPT_DISPOSITION_CODES so the fall-through sweep and
// any future consumers can reuse the same canonical "appointment-resolved"
// disposition set.
export { POST_APPT_DISPOSITION_CODES, findPostApptDispositionSignal };
