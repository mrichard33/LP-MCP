/**
 * Suppress-Automation Backfill — src/jobs/suppress-automation-backfill.js
 *
 * One-shot / repeatable remediation sweep that clears the orphaned
 * `suppress-automation` tag from contacts who should never have kept it.
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────
 *
 * The agent rule AUTOMATION_SUPPRESS_ON_BOOKING added `suppress-automation`
 * on every ghl.appointment_booked as a "48h post-booking pause". Nothing
 * ever removed it:
 *
 *   - The rule set no TTL and wrote no `suppress_until` value.
 *   - * Suppression TTL Manager (n8n eKwD9TGvXPb3c0TG) was the intended
 *     safety net but queried a table named `ghl_contacts`, which does not
 *     exist in the HL warehouse (the table is `contacts`), and posted to
 *     an HL MCP `/tools/*` REST surface that does not exist either. It has
 *     been a silent no-op since 2026-04-10. Repointed at this endpoint
 *     2026-08-25.
 *   - The CANCELLATION rules (GHL_APPT_CANCELLED_REBOOK_COLD,
 *     LP_DISP_CANCEL_COLD_TO_S5_2) removed the tag before routing to S5.2.
 *     The NO-SHOW rules did not — patched 2026-08-25, but only forward.
 *
 * Two populations were left stranded:
 *
 *   1. UPCOMING APPOINTMENTS. `suppress-automation` is the ONLY suppression
 *      tag the three reminder workflows gate on — A.WE-1 Window Estimate
 *      (9 gates), A.MV-1 Measurement Verification (8), A.CC-1 Confirmation
 *      Call (5). Every gate reads "Automation Suppressed? -> Suppressed
 *      (Skip)". Booking an appointment silently disabled that contact's own
 *      appointment reminders.
 *
 *   2. NO-SHOW / STALE-APPT. Enrolled into S5.2 v2 while still carrying the
 *      tag, so all 11 "Check for Suppression" gates sent them down the exit
 *      branch and no rescue message ever sent.
 *
 * AUTOMATION_SUPPRESS_ON_BOOKING was disabled 2026-08-25 (redundant:
 * GHL_APPT_STAGE_ADVANCE at priority 10 already performs the nurture exit
 * on the same event). This sweep drains the backlog it left behind.
 *
 * ─── SAFETY ──────────────────────────────────────────────────────
 *
 *   - dryRun defaults TRUE. A caller must opt in to writing.
 *   - GUARD_TAGS: never touched if the contact carries a REAL suppression
 *     signal. Lifting suppression off a DNC contact is a compliance event,
 *     so the guard is checked twice — once in SQL, once against live GHL
 *     tags immediately before the write.
 *   - minAgeHours (default 24): a belt-and-braces recency window on top of
 *     the tag guards. REPLY_INTENT_BUYING_SIGNAL sets `suppress-automation`
 *     with a 24h suppress_until, and `buying-signal-detected` / `intent-spike`
 *     are already in GUARD_TAGS — so the age window is the SECOND line of
 *     defence, not the only one. Callers working the time-critical
 *     upcoming-appointment cohort may lower it (0 is honoured; see the
 *     numeric coercion note below) because a contact whose appointment is
 *     three days out cannot afford to wait a day for their reminders.
 *   - Live GHL re-read before every removal — other release paths may have
 *     already cleared the tag, and the mirror can be stale.
 *   - Bounded by `limit`; rate limited between writes.
 *   - Every removal emits a system event for audit.
 *
 * ─── ROUTE ───────────────────────────────────────────────────────
 *
 *   POST /n8n/suppress-automation/backfill
 *     { dryRun: true, cohort: 'upcoming_appt'|'no_show'|'all', limit: 200,
 *       minAgeHours: 24, appointmentHorizonDays: 60 }
 *
 * No scheduler of its own. The hourly * Suppression TTL Manager drives the
 * standing safety-net pass; the OPS backfill n8n workflow drives the drain.
 */

import { hlRunSQL, esc } from '../admin/hl-client.js';
import { emitEvent } from '../event-emitter.js';

const TARGET_TAG = 'suppress-automation';
const GHL_API_KEY = process.env.GHL_API_KEY;

/**
 * Tags that represent a genuine reason to stay suppressed. A contact
 * carrying any of these is skipped outright — this sweep only clears the
 * orphaned booking-pause, never a real suppression.
 */
const GUARD_TAGS = [
  'dnc',
  'lp-dnc',
  'suppress-outbound',
  'pause-workflow',
  'nurture-paused',
  'nurture-stop',
  'hard-disqualified',
  'stop-bot',
  'needs-human-repair',
  'spouse-gate-blocked',
  'buying-signal-detected',
  'intent-spike',
  'trust-break-accuracy',
];

const DEFAULT_LIMIT = 200;
const DEFAULT_MIN_AGE_HOURS = 24;
const DEFAULT_APPT_HORIZON_DAYS = 60;
const WRITE_PAUSE_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Coerce a caller-supplied number, treating 0 as a real value.
 *
 * `Number(x) || fallback` is wrong here and was a live bug: minAgeHours: 0
 * is a legitimate "no recency window" request, but 0 is falsy, so it fell
 * through to the 24h default and silently ignored the caller. That kept 106
 * contacts with appointments inside four days out of the upcoming_appt
 * cohort while reporting success.
 */
function num(value, fallback, { min = 0 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}

function sqlTagArray(tags) {
  return `ARRAY[${tags.map((t) => `'${esc(t)}'`).join(',')}]`;
}

/**
 * Build the cohort query against the HL warehouse.
 *
 * `upcoming_appt` is deliberately first-class and separate: those contacts
 * are missing reminders for appointments that have not happened yet, which
 * is the time-critical half of the backlog.
 */
function buildCohortSql({ cohort, limit, minAgeHours, appointmentHorizonDays }) {
  const guard = sqlTagArray(GUARD_TAGS);
  const routeTags = sqlTagArray([
    'lp-route:no-show-on-us',
    'lp-route:no-show-rep-traveled',
    'appt-no-show-cold',
    'lp-route:stale-appt',
  ]);

  const upcomingApptExists = `EXISTS (
        SELECT 1 FROM appointments a
         WHERE a.ghl_contact_id = c.ghl_contact_id
           AND a.deleted_at IS NULL
           AND a.start_time > now()
           AND a.start_time < now() + interval '${appointmentHorizonDays} days'
      )`;

  let cohortPredicate;
  if (cohort === 'upcoming_appt') {
    cohortPredicate = upcomingApptExists;
  } else if (cohort === 'no_show') {
    cohortPredicate = `c.tags && ${routeTags} AND NOT ${upcomingApptExists}`;
  } else {
    cohortPredicate = 'TRUE';
  }

  // minAgeHours of 0 makes the interval clause a no-op tautology rather than
  // an always-false comparison against now(), so it is dropped outright.
  const ageClause =
    minAgeHours > 0
      ? `AND c.date_updated < now() - interval '${minAgeHours} hours'`
      : '';

  return `
    SELECT c.ghl_contact_id,
           c.tags,
           ${upcomingApptExists} AS has_upcoming_appt
      FROM contacts c
     WHERE c.tags @> ARRAY['${esc(TARGET_TAG)}']
       AND NOT (c.tags && ${guard})
       ${ageClause}
       AND ${cohortPredicate}
     ORDER BY ${cohort === 'all' ? `(${upcomingApptExists}) DESC,` : ''} c.date_updated ASC
     LIMIT ${limit}
  `;
}

/** Live GHL tag read. Returns null on failure — caller treats null as "skip". */
async function fetchContactTags(contactId) {
  if (!GHL_API_KEY || !contactId) return null;
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        Version: '2021-07-28',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.warn(`[SuppressBackfill] GHL lookup failed for ${contactId}: ${res.status}`);
      return null;
    }
    const data = await res.json();
    return data?.contact?.tags || [];
  } catch (err) {
    console.warn(`[SuppressBackfill] GHL lookup error for ${contactId}: ${err.message}`);
    return null;
  }
}

/** Subtractive tag removal — leaves every other tag intact. */
async function removeContactTag(contactId, tag) {
  if (!GHL_API_KEY || !contactId) return false;
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        Version: '2021-07-28',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ tags: [tag] }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[SuppressBackfill] Tag removal failed for ${contactId}: ${res.status} ${body}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[SuppressBackfill] Tag removal error for ${contactId}: ${err.message}`);
    return false;
  }
}

export async function runSuppressAutomationBackfill({
  dryRun = true,
  cohort = 'upcoming_appt',
  limit = DEFAULT_LIMIT,
  minAgeHours = DEFAULT_MIN_AGE_HOURS,
  appointmentHorizonDays = DEFAULT_APPT_HORIZON_DAYS,
} = {}) {
  const startTime = Date.now();

  if (!['upcoming_appt', 'no_show', 'all'].includes(cohort)) {
    throw new Error(`Unknown cohort "${cohort}" — expected upcoming_appt | no_show | all`);
  }
  if (!GHL_API_KEY) {
    return { success: false, error: 'GHL_API_KEY not set — cannot verify or write tags.' };
  }

  const boundedLimit = Math.min(Math.max(1, num(limit, DEFAULT_LIMIT, { min: 1 })), 500);
  const effMinAgeHours = num(minAgeHours, DEFAULT_MIN_AGE_HOURS);
  const effHorizonDays = num(appointmentHorizonDays, DEFAULT_APPT_HORIZON_DAYS, { min: 1 });

  let rows;
  try {
    // hlRunSQL wraps in json_agg, so a zero-row result comes back as null.
    rows = (await hlRunSQL(
      buildCohortSql({
        cohort,
        limit: boundedLimit,
        minAgeHours: effMinAgeHours,
        appointmentHorizonDays: effHorizonDays,
      })
    )) || [];
  } catch (err) {
    return { success: false, error: `HL query failed: ${err.message}` };
  }

  if (!Array.isArray(rows)) rows = [];

  const results = {
    success: true,
    dry_run: !!dryRun,
    cohort,
    limit: boundedLimit,
    // Echoed back so a caller can confirm the knobs were actually applied
    // rather than silently defaulted — see the num() note above.
    min_age_hours: effMinAgeHours,
    appointment_horizon_days: effHorizonDays,
    candidates: rows.length,
    cleared: 0,
    skipped_guard_tag: 0,
    skipped_already_clear: 0,
    skipped_lookup_failed: 0,
    errors: 0,
    upcoming_appt_cleared: 0,
    samples: [],
  };

  for (const row of rows) {
    const contactId = row.ghl_contact_id;
    if (!contactId) continue;

    try {
      // Second guard pass against LIVE tags. The mirror lags GHL, and lifting
      // suppression off a contact who went DNC since the last sync would be a
      // compliance failure — worth the extra read on every single contact.
      const liveTags = await fetchContactTags(contactId);
      if (liveTags === null) {
        results.skipped_lookup_failed++;
        continue;
      }
      if (!liveTags.includes(TARGET_TAG)) {
        results.skipped_already_clear++;
        continue;
      }
      const hitGuard = GUARD_TAGS.find((g) => liveTags.includes(g));
      if (hitGuard) {
        results.skipped_guard_tag++;
        continue;
      }

      if (results.samples.length < 25) {
        results.samples.push({
          contact_id: contactId,
          has_upcoming_appt: !!row.has_upcoming_appt,
        });
      }

      if (dryRun) {
        results.cleared++;
        if (row.has_upcoming_appt) results.upcoming_appt_cleared++;
        continue;
      }

      const ok = await removeContactTag(contactId, TARGET_TAG);
      if (!ok) {
        results.errors++;
        continue;
      }

      await emitEvent({
        event_type: 'suppression.backfill_cleared',
        event_subtype: cohort,
        source: 'suppress_automation_backfill',
        entity_type: 'contact',
        entity_id: contactId,
        ghl_contact_id: contactId,
        payload: {
          tag: TARGET_TAG,
          cohort,
          has_upcoming_appt: !!row.has_upcoming_appt,
          reason:
            'Orphaned post-booking pause from AUTOMATION_SUPPRESS_ON_BOOKING (rule disabled 2026-08-25). Blocked appointment reminders (A.WE-1/A.MV-1/A.CC-1) and S5.2 v2 rescue sends.',
        },
        priority: 'low',
        idempotency_key: `suppress_backfill_${contactId}`,
      }).catch((e) => console.warn(`[SuppressBackfill] emitEvent failed for ${contactId}: ${e.message}`));

      results.cleared++;
      if (row.has_upcoming_appt) results.upcoming_appt_cleared++;
      await sleep(WRITE_PAUSE_MS);
    } catch (err) {
      console.error(`[SuppressBackfill] Error on ${contactId}: ${err.message}`);
      results.errors++;
    }
  }

  results.elapsed_ms = Date.now() - startTime;
  // `remaining_hint` lets the n8n driver decide whether to loop again without
  // running a second count query: a full page means there is probably more.
  results.remaining_hint = rows.length >= boundedLimit ? 'more_likely' : 'drained';

  console.log(
    `[SuppressBackfill] ${dryRun ? 'DRY RUN ' : ''}cohort=${cohort} minAge=${effMinAgeHours}h: ` +
      `${rows.length} candidates -> ${results.cleared} cleared ` +
      `(${results.upcoming_appt_cleared} w/ upcoming appt), ` +
      `${results.skipped_guard_tag} guard-tag, ${results.skipped_already_clear} already-clear, ` +
      `${results.skipped_lookup_failed} lookup-failed, ${results.errors} errors (${results.elapsed_ms}ms)`
  );

  return results;
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESS ROUTE
// ═══════════════════════════════════════════════════════════════════

export function registerSuppressAutomationBackfillRoutes(app) {
  app.post('/n8n/suppress-automation/backfill', async (req, res) => {
    try {
      const b = req.body || {};
      // Fail SAFE: anything other than an explicit false leaves dryRun on.
      const dryRun = !(b.dryRun === false || b.dry_run === false || req.query.dryRun === 'false');
      const result = await runSuppressAutomationBackfill({
        dryRun,
        cohort: b.cohort || req.query.cohort || 'upcoming_appt',
        limit: b.limit ?? req.query.limit ?? DEFAULT_LIMIT,
        minAgeHours: b.minAgeHours ?? b.min_age_hours ?? req.query.minAgeHours ?? DEFAULT_MIN_AGE_HOURS,
        appointmentHorizonDays:
          b.appointmentHorizonDays ?? b.appointment_horizon_days ?? DEFAULT_APPT_HORIZON_DAYS,
      });
      res.json(result);
    } catch (err) {
      console.error('[SuppressBackfill] route error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });
}
