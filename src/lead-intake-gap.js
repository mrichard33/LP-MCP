/**
 * Leads that never reached LP — src/lead-intake-gap.js
 *
 * Pure and dependency-free. src/jobs/lead-leak-monitor.js owns the reads (the
 * HL contacts mirror, lp_leads, the Five9 history) and hands this module plain
 * values.
 *
 * WHY (2026-09-26)
 *   The lead-leak monitor can only see leads that are IN LP. A GHL contact
 *   whose addlead never landed was never going to be dialled, and nothing
 *   watched for it: no addlead attempt log exists, and the proxy only logs to
 *   the console. "I don't want to find out later that we have leads that never
 *   made it into our system to be called" (2026-09-26) — this is that check.
 *
 * WHAT COUNTS
 *   A GHL contact added in the window, at least INTAKE_GRACE_HOURS old (the
 *   push is asynchronous; a contact a minute old is not a gap yet), with a
 *   usable phone and no LP id stamped on it (the lp_lead_id and in1_id custom
 *   fields). Then, by phone:
 *     in_lp_unlinked        an LP lead exists for the phone — the contact just
 *                           was not stamped. Not a missed lead; data hygiene.
 *     not_in_lp_but_called  no LP lead, but Five9 rang the number after the
 *                           contact arrived. Softer: someone reached them.
 *     not_in_lp             no LP lead and no Five9 call. The real gap.
 *   Measured 2026-09-26: 8,512 contacts in 30 days, 83 with a phone and no LP
 *   id — before the phone check that separates the three.
 *
 * The two Supabase instances cannot be joined (CLAUDE.md): contacts come from
 * the HL mirror, the LP check runs against LP, and the classes meet here.
 */

// GHL custom fields that carry the LP link. Either one set means the push landed.
export const LP_ID_FIELDS = Object.freeze([
  'GmAVmW6V9sekD7pVONKr', // LP lead id
  '3YMxheIlPyhACB8zyc3W', // LP inbound id (in1_id) — set by addlead before LP makes the lead
]);

// How old a contact must be before a missing LP id is a gap. Addlead is async
// and LP turns the inbound row into a lead on its own schedule.
export const INTAKE_GRACE_HOURS = 24;

export const INTAKE_CLASSES = Object.freeze(['not_in_lp', 'not_in_lp_but_called', 'in_lp_unlinked']);

const esc = (s) => String(s).replace(/'/g, "''");

/**
 * The HL mirror read: contacts added between `sinceIso` and `untilIso`, not
 * deleted, with a 10+ digit phone and neither LP id field filled. The LP-id
 * test runs in SQL so only the handful of candidates cross the wire.
 */
export function buildIntakeCandidatesSql({ sinceIso, untilIso }) {
  const ids = LP_ID_FIELDS.map((id) => `'${esc(id)}'`).join(',');
  return `
    SELECT ghl_contact_id, first_name, last_name, phone, source, date_added
      FROM contacts c
     WHERE c.deleted_at IS NULL
       AND c.date_added >= '${esc(sinceIso)}'
       AND c.date_added <  '${esc(untilIso)}'
       AND length(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g')) >= 10
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.custom_fields::jsonb) = 'array'
                                          THEN c.custom_fields::jsonb ELSE '[]'::jsonb END) e
          WHERE e->>'id' IN (${ids}) AND coalesce(e->>'value', '') <> ''
       )
     ORDER BY c.date_added DESC
  `;
}

/** Did Five9 ring this phone at or after `fromMs`? `times` ascending. */
function calledSince(times, fromMs) {
  return Array.isArray(times) && times.length > 0 && times[times.length - 1] >= fromMs;
}

/**
 * The class of one candidate.
 *   lpPhones     Set of phone10 that have an lp_leads row
 *   five9Phones  Map phone10 → ascending Five9 call times (true UTC ms)
 * `addedMs` is GHL's date_added — real UTC, unlike LP's clock.
 */
export function classifyIntakeGap({ phone10, addedMs }, { lpPhones, five9Phones }) {
  if (lpPhones?.has(phone10)) return 'in_lp_unlinked';
  if (calledSince(five9Phones?.get(phone10), Number.isFinite(addedMs) ? addedMs : -Infinity)) {
    return 'not_in_lp_but_called';
  }
  return 'not_in_lp';
}

/** Counts per class. */
export function summarizeIntakeGap(rows) {
  const out = { not_in_lp: 0, not_in_lp_but_called: 0, in_lp_unlinked: 0, checked: (rows || []).length };
  for (const r of rows || []) if (r.class in out) out[r.class] += 1;
  return out;
}
