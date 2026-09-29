/**
 * Consent store — src/consent/consent-store.js
 *
 * Consent Model v1 (2026-09-28). contact_consent (sql/136) is the one place
 * that says whether a contact may be phoned/texted or emailed, and
 * consent_events (sql/137) says who changed it, when, and on what evidence.
 * Before this, the answer was spread across GHL tags, GHL DND, LP DNC codes and
 * the Five9 DNC list, and "why is this lead blocked?" had no single answer.
 *
 * CHANNELS ARE phone | email | all — NEVER sms OR call ON THEIR OWN.
 *   Texts and automated calls are ONE channel ('phone') by decision: FCC 24-24
 *   para. 32 attaches a revocation to the NUMBER, not the medium, so a texted
 *   STOP blocks calls too and a verbal "stop calling" blocks texts too.
 *   CONSENT_SPLIT_SMS_CALL is the single switch that could split them later.
 *   It is only a hook: the split is NOT built, and turning the flag on makes
 *   'sms' / 'call' fail with a different message rather than start working.
 *   TODO(counsel): build the split only after counsel signs off in writing.
 *   Email is separate because the TCPA does not govern email.
 *
 * sms_carrier_stop IS THE LEAD'S OWN TEXTED STOP. A Slack-approved lift never
 *   clears it. Texts reopen only when the lead texts START/UNSTOP or submits a
 *   new first-party form with explicit SMS consent.
 *
 * CONSENT_MODEL_MODE
 *   shadow (default) — writes happen; nothing reads these tables to gate a
 *                      send. Tag/DND behaviour is unchanged.
 *   live             — reserved. Flipping it is Mark's separate decision after
 *                      7+ days of shadow; no gate reads it yet.
 *   off              — no writes at all (kill switch).
 *
 * FAILS SOFT WHEN THE SCHEMA IS MISSING. DDL (sql/136–140) is applied before
 * this deploys, but if it is not, a consent write logs and returns
 * { skipped: true, reason: 'consent_schema_missing' } instead of failing the
 * action — in shadow mode a missing audit row must never block a real
 * suppression (the tags, DND, LP and Five9 steps beside it).
 */

import supabase from '../supabase.js';

export const CONSENT_CHANNELS = Object.freeze(['phone', 'email', 'all']);
export const CONSENT_CHANGES = Object.freeze([
  'revoked', 'granted', 'dnc_full_on', 'dnc_full_off', 'carrier_stop_on', 'carrier_stop_off',
]);
// Channels that exist only once SMS and automated calls are split. Named so the
// refusal can say exactly why, rather than "unknown channel".
export const SPLIT_ONLY_CHANNELS = Object.freeze(['sms', 'call']);

// Which channel each change is allowed on. dnc_full is a whole-contact state,
// carrier_stop is the phone number's own STOP; revoked/granted take any channel.
const CHANGE_CHANNELS = {
  revoked: CONSENT_CHANNELS,
  granted: CONSENT_CHANNELS,
  dnc_full_on: ['all'],
  dnc_full_off: ['all'],
  carrier_stop_on: ['phone'],
  carrier_stop_off: ['phone'],
};

/**
 * The GHL tags that block a lead. Used by the review card ("which tags block
 * them") and by DNC_LIFT_REVIEW_REQUEST's has_any_tag. dnc-sms is listed
 * because it blocks — whether a lift may clear it is a separate question
 * (detectCarrierStop).
 */
export const DNC_FAMILY_TAGS = Object.freeze([
  'dnc', 'dnc-sms', 'dnc-voice', 'dnc-email', 'stage:dnc', 'p3:dnc', 'lp-dnc', 'do-not-contact',
  'loss-reason:dnc', 'stop-bot', 'suppress:dnc-reply', 'suppress:dnc-voice',
]);

export function consentModelMode(env = process.env) {
  const v = String(env.CONSENT_MODEL_MODE || '').trim().toLowerCase();
  return v === 'live' || v === 'off' ? v : 'shadow';
}

export function splitSmsCallEnabled(env = process.env) {
  return String(env.CONSENT_SPLIT_SMS_CALL || '').trim().toLowerCase() === 'true';
}

/**
 * Validate one change. Throws a plain-English Error; never returns false.
 * Pure — the tests call it directly.
 */
export function validateConsentChange({ ghlContactId, channel, change, source, actor } = {}, env = process.env) {
  if (!ghlContactId) throw new Error('record_consent_change: ghlContactId is required');
  const ch = String(channel || '').trim().toLowerCase();
  if (SPLIT_ONLY_CHANNELS.includes(ch)) {
    if (!splitSmsCallEnabled(env)) {
      throw new Error(
        `record_consent_change: channel '${ch}' is not allowed — texts and automated calls are paired as ` +
        `'phone' (FCC 24-24 para. 32: revocation attaches to the number). Use channel 'phone'. ` +
        'Splitting them needs CONSENT_SPLIT_SMS_CALL=true AND counsel sign-off.'
      );
    }
    // TODO(counsel): the split is a flag hook only. Do not add 'sms'/'call'
    // handling here until counsel has signed off in writing.
    throw new Error(
      `record_consent_change: CONSENT_SPLIT_SMS_CALL is on, but per-channel '${ch}' consent is not built — ` +
      'it waits on counsel sign-off. Use channel \'phone\'.'
    );
  }
  if (!CONSENT_CHANNELS.includes(ch)) {
    throw new Error(`record_consent_change: channel must be one of ${CONSENT_CHANNELS.join(' | ')} (got '${channel}')`);
  }
  if (!CONSENT_CHANGES.includes(change)) {
    throw new Error(`record_consent_change: change must be one of ${CONSENT_CHANGES.join(' | ')} (got '${change}')`);
  }
  if (!CHANGE_CHANNELS[change].includes(ch)) {
    throw new Error(`record_consent_change: change '${change}' only applies to channel ${CHANGE_CHANNELS[change].join(' | ')} (got '${ch}')`);
  }
  if (!source || !String(source).trim()) throw new Error('record_consent_change: source is required');
  if (actor != null && !String(actor).trim()) throw new Error('record_consent_change: actor may not be blank');
  return ch;
}

export const EMPTY_CONSENT = Object.freeze({
  phone_consent: 'unknown',
  email_consent: 'unknown',
  sms_carrier_stop: false,
  dnc_full: false,
});

/**
 * Pure mirror of record_consent_change() in sql/139 — the SAME state rules.
 * The database function is the one that runs; this exists so the rules are
 * unit-tested and so the backfill dry-run can preview a result. Keep the two
 * in step: a change touches only the column it names.
 */
export function applyConsentChange(prev, { channel, change }) {
  const next = { ...EMPTY_CONSENT, ...(prev || {}) };
  const isGrantRevoke = change === 'revoked' || change === 'granted';
  if (isGrantRevoke && (channel === 'phone' || channel === 'all')) next.phone_consent = change;
  if (isGrantRevoke && (channel === 'email' || channel === 'all')) next.email_consent = change;
  if (change === 'carrier_stop_on') next.sms_carrier_stop = true;
  if (change === 'carrier_stop_off') next.sms_carrier_stop = false;
  if (change === 'dnc_full_on') next.dnc_full = true;
  if (change === 'dnc_full_off') next.dnc_full = false;
  return next;
}

// GHL sets SMS/RCS DND to 'permanent' itself when the contact texts a STOP
// keyword; the API refuses to change it (see src/actions/handlers/dnd.js).
//
// 2026-09-29 — dnc-sms is NOT on this list any more. Since TAG_DNC_SMS_OPTOUT a
// person can add dnc-sms to block calls + texts, and that tag alone made the
// lift keep texts off with "This lead texted STOP" on a contact who never did
// (the user's test contact). A real STOP always leaves a stronger signal: of
// the 1,072 contacts carrying dnc-sms that day, 1,070 also had
// suppress:dnc-reply or consent sms_carrier_stop; GHL's own STOP sets the
// 'permanent' DND read below. The user's ruling: a lift restores texts unless
// the lead really texted STOP.
const CARRIER_STOP_TAGS = ['suppress:dnc-reply'];

/**
 * Did this lead text STOP? Any ONE signal is enough — the cost of a false
 * "yes" is that texts stay off after a lift (a human can still call); the cost
 * of a false "no" is texting someone who told us to stop.
 *
 *   consent row sms_carrier_stop = true
 *   tag suppress:dnc-reply   (written by BEHAVIORAL_DNC_REPLY; dnc-sms alone is
 *                            a staff block, not proof of a STOP)
 *   GHL dndSettings SMS or RCS status 'permanent' (GHL's own STOP lock)
 *   the contact could not be read at all (unreadable is NOT "no")
 *
 * Pure. Returns { carrierStop, basis[] } so the card can say why.
 */
export function detectCarrierStop({ consent = null, tags = null, dndSettings = null, contactReadFailed = false } = {}) {
  const basis = [];
  if (contactReadFailed) basis.push('contact_unreadable_assumed_stop');
  if (consent?.sms_carrier_stop === true) basis.push('consent:sms_carrier_stop');
  const lower = (Array.isArray(tags) ? tags : []).map((t) => String(t || '').toLowerCase());
  for (const t of CARRIER_STOP_TAGS) if (lower.includes(t)) basis.push(`tag:${t}`);
  for (const ch of ['SMS', 'RCS']) {
    if (String(dndSettings?.[ch]?.status || '').toLowerCase() === 'permanent') basis.push(`dnd:${ch}:permanent`);
  }
  return { carrierStop: basis.length > 0, basis };
}

/** The DNC-family tags this contact actually carries, in DNC_FAMILY_TAGS order. */
export function blockingTags(tags) {
  const lower = new Set((Array.isArray(tags) ? tags : []).map((t) => String(t || '').toLowerCase()));
  return DNC_FAMILY_TAGS.filter((t) => lower.has(t));
}

// PostgREST / Postgres codes that mean "the consent schema is not there yet":
// 42P01 undefined_table, 42883 undefined_function, PGRST202 function not in the
// schema cache, PGRST205 table not in the schema cache.
const MISSING_SCHEMA_CODES = new Set(['42P01', '42883', 'PGRST202', 'PGRST205']);

export function isMissingSchemaError(error) {
  if (!error) return false;
  if (MISSING_SCHEMA_CODES.has(String(error.code || ''))) return true;
  return /does not exist|could not find the (function|table)/i.test(String(error.message || ''));
}

/**
 * Upsert contact_consent and insert consent_events in ONE transaction, via the
 * record_consent_change() database function (sql/139).
 *
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, event_id?:number, consent?:object}>}
 *   Throws on invalid input (a caller bug) and on a real database error
 *   (retryable). A missing schema or CONSENT_MODEL_MODE=off is a skip.
 */
export async function recordConsentChange(params = {}, deps = {}) {
  const env = deps.env || process.env;
  const channel = validateConsentChange(params, env);
  const mode = consentModelMode(env);
  if (mode === 'off') return { ok: true, skipped: true, reason: 'consent_model_off', mode };

  const db = deps.supabase || supabase;
  if (!db) return { ok: true, skipped: true, reason: 'supabase_not_configured', mode };

  const { data, error } = await db.rpc('record_consent_change', {
    p_ghl_contact_id: String(params.ghlContactId),
    p_channel: channel,
    p_change: params.change,
    p_source: String(params.source),
    p_reason: params.reason == null ? null : String(params.reason),
    p_actor: params.actor ? String(params.actor) : 'system',
    p_evidence: params.evidence == null ? null : params.evidence,
    p_lp_lead_id: params.lpLeadId ? String(params.lpLeadId) : null,
    p_lp_prospect_id: params.lpProspectId ? String(params.lpProspectId) : null,
  });

  if (error) {
    if (isMissingSchemaError(error)) {
      console.warn(`[Consent] schema missing — skipped ${channel}/${params.change} for ${params.ghlContactId} (apply sql/136–139): ${error.message}`);
      return { ok: true, skipped: true, reason: 'consent_schema_missing', mode };
    }
    throw new Error(`record_consent_change failed for ${params.ghlContactId}: ${error.message}`);
  }
  const row = Array.isArray(data) ? data[0] : data;
  return { ok: true, mode, event_id: row?.event_id ?? null, consent: row?.consent ?? null };
}

/**
 * Current consent row + the newest `eventLimit` events for one contact.
 * status: 'ok' (row may be null = never recorded) | 'schema_missing' | 'error'.
 * Never throws — callers decide what an unreadable consent means.
 */
export async function getConsent(ghlContactId, deps = {}) {
  const db = deps.supabase || supabase;
  const eventLimit = deps.eventLimit ?? 5;
  if (!db || !ghlContactId) return { status: 'error', consent: null, events: [], error: 'no_client_or_contact' };
  try {
    const [row, events] = await Promise.all([
      db.from('contact_consent').select('*').eq('ghl_contact_id', ghlContactId).maybeSingle(),
      db.from('consent_events')
        .select('id, channel, change, source, reason, actor, created_at')
        .eq('ghl_contact_id', ghlContactId)
        .order('created_at', { ascending: false })
        .limit(eventLimit),
    ]);
    const err = row.error || events.error;
    if (err) {
      return { status: isMissingSchemaError(err) ? 'schema_missing' : 'error', consent: null, events: [], error: err.message };
    }
    return { status: 'ok', consent: row.data || null, events: events.data || [] };
  } catch (err) {
    return { status: 'error', consent: null, events: [], error: err.message };
  }
}
