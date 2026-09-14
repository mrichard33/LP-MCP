/**
 * LP Addlead Validation Proxy — src/lp-addlead-proxy.js
 *
 * v1.0 (2026-07-24). One synchronous hop between GHL's addlead webhooks and
 * LP's legacy br27/addlead endpoint. Validates the appointment hour against
 * business hours (08:00–19:59 ET), strips adate/atime + fires one
 * claim-deduped GroupMe card when the hour is impossible, forwards the body
 * to LP otherwise-unchanged, and mirrors LP's response byte-for-byte.
 *
 * WHY THIS EXISTS: 59 of the 88 impossible-hour LP appointments since
 * 2026-05-01 were canvasser AM/PM entry errors flowing through GHL addlead
 * webhooks with zero time validation. The GHL-native gate needs a formatter
 * + if/else + four duplicated nodes per workflow; this is a URL paste.
 *
 * CONTRACTS (breaking any of these breaks the intake artery):
 *   1. RESPONSE FIDELITY — GHL's "Extract Inbound Lead ID" custom code
 *      parses the webhook response (`message.split(': ')[1]`). We return
 *      LP's status, content-type, and raw body bytes untouched. Never
 *      JSON-parse-and-restringify the response.
 *   2. FAIL-OPEN — any validation exception forwards the body untouched.
 *      The proxy must never be the reason a lead misses LP.
 *   3. WALL-CLOCK — atime is ET wall clock by construction ("6:00 PM" as
 *      the canvasser typed it). No timezone math anywhere.
 *
 * MODES (env LP_ADDLEAD_PROXY_MODE, default 'shadow'):
 *   'shadow'      — validate + card, NEVER strip. First-deploy default.
 *   'validate'    — strip on impossible hour / blank-time / blank-appt_id.
 *   'passthrough' — no validation, pure forward. The kill switch: reverts
 *                   behavior without touching GHL.
 *
 * NOTES ENRICHMENT (env LP_ADDLEAD_NOTES_MODE, default 'shadow' — see
 * notesMode() below): the ONE field this proxy may rewrite on the forward path.
 * `notes` arrives as {{contact.contact_summary}}, written by a ChatGPT node
 * whose prompt reads a field vocabulary that only partly overlaps what the
 * agentic system writes and never references the chat transcript. On 'live' /
 * 'augment' the deterministic builder in services/agentic-lead-notes.js
 * replaces or extends it. Ships on 'shadow', which logs and changes nothing.
 * Contract 2 (fail-open) covers it: any error or timeout forwards unchanged.
 *
 * ATTRIBUTION FALLBACK (v1.1, 2026-08-18 — env LP_ATTRIBUTION_FALLBACK_MODE,
 * default 'live'): the SECOND field group this proxy may rewrite. When a
 * GHL-originated addlead arrives with no usable srs_id, the lead is stamped
 * srs_id=830 / pro_id=5574 (Reece ChatBot) rather than reaching LP
 * unattributed. Mark's ruling, 2026-08-18. See applyAttributionFallback().
 *
 * DORMANT ID BACKSTOP: if the body carries an `appt_id` key that is blank
 * while adate is present, treat as invalid (contamination signature —
 * John Stautinger, lead 560445). Enforced ONLY when the key exists; GHL
 * sends no such key today, so this is inert until a workflow body adds
 *   "appt_id": "{{contact.last_appointment_id}}"
 */

import supabase from './supabase.js';
import { checkDuplicateAppointment } from './services/lp-duplicate-appointment-guard.js';
import { sendGroupMeMessage } from './groupme.js';
import { flattenWebhookBody } from './webhook-body.js';
import { fetchAndBuildAgenticNotes, isWeakNotes } from './services/agentic-lead-notes.js';
import { applyAddressGate } from './services/lp-address-gate.js';
import { LP_SRS, LP_PRO } from './lp-source-ids.js';
import {
  BUSINESS_HOUR_START_ET,
  BUSINESS_HOUR_END_ET,
} from './services/lp-ghl-appointment-reconciler.js';

const LP_ADDLEAD_URL =
  process.env.LP_ADDLEAD_URL || 'http://lppost.leadperfection.com/br27/addlead';
const LP_FORWARD_TIMEOUT_MS = Number(process.env.LP_ADDLEAD_TIMEOUT_MS || 30000);

function proxyMode() {
  const m = String(process.env.LP_ADDLEAD_PROXY_MODE || 'shadow').toLowerCase();
  return m === 'validate' || m === 'passthrough' ? m : 'shadow';
}

/**
 * Agentic-notes enrichment (env LP_ADDLEAD_NOTES_MODE, default 'shadow'):
 *   'shadow'  — build the notes and LOG them, inject NOTHING. First-deploy
 *               default; the real output is readable before any setter sees it.
 *   'live'    — replace `notes` when the incoming value is blank or weak.
 *   'augment' — same as 'live' when weak; when the incoming brief is healthy,
 *               APPEND only the deterministic sections it lacks (transcript,
 *               objection code, trust score, market) instead of replacing it.
 *   'off'     — skip entirely, no GHL fetch. Kill switch.
 */
function notesMode() {
  const m = String(process.env.LP_ADDLEAD_NOTES_MODE || 'shadow').toLowerCase();
  return m === 'live' || m === 'augment' || m === 'off' ? m : 'shadow';
}

/**
 * Attribution fallback (env LP_ATTRIBUTION_FALLBACK_MODE):
 *   'live'   — stamp the fallback pair onto unattributed leads. DEFAULT.
 *   'shadow' — log what WOULD be stamped, forward unchanged.
 *   'off'    — skip entirely. Kill switch.
 *
 * WHY THIS DEFAULTS 'live' AND THE OTHER TWO GATES DEFAULT 'shadow'. The
 * house pattern is shadow-first, and it is the right default when a gate can
 * SUPPRESS something (an appointment, a whole lead). This gate cannot. It
 * only ever fills a field that is empty, and the status quo it replaces is
 * already broken: 211 LP leads carry srs_id=0 today, 40 of them in the last
 * 30 days. Shadow mode here would mean knowingly writing more unattributed
 * leads while watching a log say so. It is also the only one of the three
 * whose damage is unrepairable — LP exposes no write endpoint that accepts
 * srs_id, so a lead that lands unattributed stays that way unless someone
 * edits it by hand in the LP UI.
 */
function attributionFallbackMode() {
  const m = String(process.env.LP_ATTRIBUTION_FALLBACK_MODE || 'live').toLowerCase();
  return m === 'shadow' || m === 'off' ? m : 'live';
}

// Hard ceiling on the enrichment fetch. The proxy is a synchronous hop on the
// intake artery; enrichment must never be why a lead is slow to reach LP.
const NOTES_ENRICH_TIMEOUT_MS = Number(process.env.LP_NOTES_ENRICH_TIMEOUT_MS || 3000);

/** Resolve null at the ceiling. The timer is cleared either way so a fast
 *  build never holds the event loop open for the full timeout. */
function raceWithNullTimeout(promise, ms) {
  let timer;
  const ceiling = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([promise, ceiling]).finally(() => clearTimeout(timer));
}

/**
 * ET hour (0–23) from an LP atime string ("6:00 PM", "06:30 AM").
 * Null when the string is not a clean 12-hour time — callers treat null as
 * "cannot judge" and (for non-blank input) fail open.
 */
export function hourFromLpAtime(atime) {
  if (atime == null) return null;
  const m = /^\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*$/i.exec(String(atime));
  if (!m) return null;
  let h = Number(m[1]);
  if (!Number.isInteger(h) || h < 1 || h > 12) return null;
  const pm = m[3].toUpperCase() === 'PM';
  if (h === 12) h = 0;
  if (pm) h += 12;
  return h;
}

function isBlank(v) {
  return v == null || String(v).trim() === '';
}

/**
 * An srs_id is USABLE only if it is a non-blank, non-zero integer that is not
 * an unresolved merge token.
 *
 * The "0" case is the one that matters and the one a plain blank-check misses.
 * LP does not reject srs_id=0 — it accepts the lead and resolves it to no
 * source and no sourcesubdescr, which is exactly the state of Elena's lead
 * 568072 and 210 others. A workflow that ships `srs_id=` empty and a workflow
 * that ships `srs_id=0` produce the identical broken outcome, so both must
 * trigger the fallback.
 */
export function isUsableAttributionId(v) {
  if (isBlank(v)) return false;
  const s = String(v).trim();
  if (/\{\{.*?\}\}/.test(s)) return false;   // unresolved GHL merge token
  if (!/^\d+$/.test(s)) return false;
  return Number(s) > 0;
}

/**
 * Pure. Stamp the Reece ChatBot pair onto a body that carries no usable
 * source attribution.
 *
 * RULE (Mark, 2026-08-18): "Anytime our GHL system books an appointment or
 * creates a lead that has no source and subsource then the fallback would be
 * Reece Chatbot srs_id=830 / pro_id=5574."
 *
 * Scope is deliberately narrow — this fills, it never overrides:
 *   - usable srs_id present            → untouched, whatever it is
 *   - srs_id missing/0/token           → srs_id=830 AND pro_id=5574
 *   - srs_id missing but pro_id present→ still stamps both, because a pro_id
 *     without a srs_id cannot be trusted to identify a channel and the pair
 *     is what LP reports on. The original pro_id is returned in `replaced`
 *     so the log and card record what was overwritten.
 *
 * Returns { body, applied, reason, before }.
 */
export function applyAttributionFallback(body) {
  const b = body || {};
  const srs = b.srs_id;
  const pro = b.pro_id;

  if (isUsableAttributionId(srs)) {
    return { body: b, applied: false, reason: 'srs_id_present', before: null };
  }

  return {
    body: { ...b, srs_id: LP_SRS.CHATBOT, pro_id: LP_PRO.CHATBOT },
    applied: true,
    reason: isBlank(srs) ? 'srs_id_blank' : `srs_id_unusable:${String(srs).trim()}`,
    before: { srs_id: isBlank(srs) ? null : String(srs).trim(), pro_id: isBlank(pro) ? null : String(pro).trim() },
  };
}

/**
 * Pure decision. Returns { action: 'forward' | 'strip', reason, hour }.
 *   - no adate and no atime            → forward ('no_appointment')
 *   - appt_id key EXISTS and is blank
 *     while adate present              → strip  ('missing_appt_id')
 *   - adate present, atime blank       → strip  ('blank_time' — a date with
 *                                        no time was never a valid appt)
 *   - atime parses, hour out of window → strip  ('impossible_hour')
 *   - atime present but unparseable    → forward ('unparseable_time' —
 *                                        fail open, never guess)
 *   - otherwise                        → forward ('valid_hour')
 */
export function planAddleadValidation(body) {
  const b = body || {};
  const hasAdate = !isBlank(b.adate);
  const hasAtime = !isBlank(b.atime);

  if (!hasAdate && !hasAtime) return { action: 'forward', reason: 'no_appointment', hour: null };

  if ('appt_id' in b && hasAdate && isBlank(b.appt_id)) {
    return { action: 'strip', reason: 'missing_appt_id', hour: null };
  }

  if (hasAdate && !hasAtime) return { action: 'strip', reason: 'blank_time', hour: null };

  const hour = hourFromLpAtime(b.atime);
  if (hour === null) return { action: 'forward', reason: 'unparseable_time', hour: null };
  if (hour < BUSINESS_HOUR_START_ET || hour >= BUSINESS_HOUR_END_ET) {
    return { action: 'strip', reason: 'impossible_hour', hour };
  }
  return { action: 'forward', reason: 'valid_hour', hour };
}

/**
 * Remove exactly adate/atime, and appt_id when present. appt_id is control
 * data for THIS proxy, never an LP field — it must not reach LP on the
 * forward path either, so it is dropped from every forwarded body.
 */
export function stripAppointmentKeys(body) {
  const { adate, atime, appt_id, ...rest } = body || {};
  return rest;
}

export function dropControlKeys(body) {
  const { appt_id, ...rest } = body || {};
  return rest;
}

// ─── Claim-before-send card dedup (inline; see commit bbe5bb9 pattern) ──
// Duplicate key 23505 → suppress. Missing table 42P01 → send unguarded.
// Any other DB error → suppress the card; the strip decision stands and the
// route log still records it. NOT imported from lp-appointment-sync.js —
// require-cycle risk through admin/lp-force-addlead.js.
async function claimAddleadNotice({ lognumber, adate, atime, reason }) {
  const noticeKey = `addlead-strip:${lognumber || 'nolog'}:${adate || 'nodate'}:${reason}`;
  try {
    const { error } = await supabase.from('lp_sync_failure_notices').insert({
      notice_key: noticeKey,
      contact_id: lognumber || 'unknown',
      appt_date: adate || null,
      appt_time: atime || null,
    });
    if (!error) return true;
    if (error.code === '23505') return false;
    if (error.code === '42P01') {
      console.error('[LP-PROXY] lp_sync_failure_notices missing — apply sql/047 — sending card UNGUARDED');
      return true;
    }
    console.warn(`[LP-PROXY] notice claim errored (card suppressed): ${error.message}`);
    return false;
  } catch (err) {
    console.warn(`[LP-PROXY] notice claim threw (card suppressed): ${err.message}`);
    return false;
  }
}

async function sendStripCard({ body, plan, mode }) {
  const name = [body.firstname, body.lastname].filter(Boolean).join(' ') || '(no name)';
  const shadowLine = mode === 'shadow'
    ? '🕶️ SHADOW MODE — appointment was SENT to LP anyway. Flip LP_ADDLEAD_PROXY_MODE=validate to enforce.\n'
    : 'The lead WAS created in LP — without the appointment.\n';
  await sendGroupMeMessage(
    `🚨 ADDLEAD APPOINTMENT ${mode === 'shadow' ? 'FLAGGED' : 'STRIPPED'} — ${plan.reason}\n` +
    `👤 ${name}\n` +
    `📞 ${body.phone1 || 'no phone'} | Sender: ${body.sender || '?'}\n` +
    `📅 Sent time: ${body.adate || '?'} ${body.atime || '?'}${plan.hour != null ? ` (hour ${plan.hour} ET)` : ''}\n` +
    shadowLine +
    // The duplicate case needs the OTHER lead ids to be actionable at all —
    // "stripped, duplicate" with nothing to compare against is a dead end.
    (plan.conflicts?.length
      ? `Contact already holds: ${plan.conflicts.map((c) => `${c.lp_lead_id} (${c.disposition_code})`).join(', ')}\n`
      : '') +
    `Confirm the real time with the customer and set it in LP (LP is system of record; Five9 lists repopulate at 6 AM).`,
    { flushNow: true }
  ).catch((err) => console.warn(`[LP-PROXY] GroupMe card failed: ${err.message}`));
}

export async function forwardToLp(bodyObj) {
  const res = await fetch(LP_ADDLEAD_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': '*/*' },
    body: JSON.stringify(bodyObj),
    signal: AbortSignal.timeout(LP_FORWARD_TIMEOUT_MS),
  });
  const raw = Buffer.from(await res.arrayBuffer());
  return { status: res.status, contentType: res.headers.get('content-type') || 'text/plain', raw };
}

export function registerLpAddleadProxyRoutes(app) {
  app.post('/webhook/ghl/lp-addlead-proxy', async (req, res) => {
    const started = Date.now();
    const raw = req.body && typeof req.body === 'object' ? req.body : {};
    // Flatten GHL's nested customData before anything reads a key. Workflow
    // 8e30ff37 step "Send Lead to Agentic System" is the same standard Webhook
    // action type confirmed to nest declared keys on /webhooks/canvassing-lead.
    // This route fails open, so an unflattened body reads as no_appointment,
    // forwards {} to LP and mirrors LP's response — a silent no-op with no
    // error surface. Not independently confirmed here; shipped separately so
    // it can be reverted alone.
    //
    // Only rebuild the object when there is actually something nested. A
    // flat body keeps its original reference, so this cannot perturb how any
    // existing payload reaches the fail-open guard below — the blast radius
    // is exactly the customData case that is broken today.
    const body = raw.customData == null ? raw : flattenWebhookBody(raw);
    const mode = proxyMode();

    let outbound = dropControlKeys(body);
    let plan = { action: 'forward', reason: 'passthrough_mode', hour: null };

    if (mode !== 'passthrough') {
      try {
        plan = planAddleadValidation(body);

        // 2026-09-14 (Change C, PREVENT half) — a body that survives the hour
        // checks can still be a SECOND live appointment on a day this contact
        // already holds, which double-counts one person across confirmed and
        // set. Expressed as another STRIP reason rather than a rejection, on
        // purpose: the lead still reaches LP and still gets dialled, it just
        // does not open a duplicate appointment row. Dropping the lead outright
        // would trade a counting error for a lost customer.
        //
        // Fails open inside the same try/catch as every other stage here.
        // Coverage is genuinely narrow — see the guard module header; it would
        // have blocked none of the five observed cases, which arrived from
        // vendors posting straight into LP.
        if (plan.action === 'forward' && body.adate && body.atime) {
          const dupe = await checkDuplicateAppointment({
            ghlContactId: body.lognumber || null,
            apptDate: body.adate,
          });
          if (dupe.action === 'block') {
            plan = {
              action: 'strip',
              reason: 'duplicate_live_appointment',
              hour: null,
              conflicts: dupe.conflicts,
            };
          }
        }

        if (plan.action === 'strip') {
          if (await claimAddleadNotice({ lognumber: body.lognumber, adate: body.adate, atime: body.atime, reason: plan.reason })) {
            await sendStripCard({ body, plan, mode });
          }
          if (mode === 'validate') outbound = stripAppointmentKeys(body);
        }
      } catch (err) {
        // FAIL-OPEN: validation must never block the artery.
        console.error(`[LP-PROXY] validation threw — forwarding untouched: ${err.message}`);
        outbound = dropControlKeys(body);
        plan = { action: 'forward', reason: `validation_error:${err.message}`, hour: null };
      }
    }

    // ── Attribution fallback (2026-08-18) ───────────────────────────────
    // Runs BEFORE the address gate so a held-and-later-released payload is
    // already attributed when the sweeper forwards it. Fail-open like every
    // other stage: a throw here leaves the body exactly as it was.
    const aMode = attributionFallbackMode();
    let attribution = { applied: false, reason: 'skipped' };
    if (aMode !== 'off') {
      try {
        const result = applyAttributionFallback(outbound);
        if (result.applied && aMode === 'live') {
          outbound = result.body;
          attribution = { applied: true, reason: result.reason, before: result.before };
        } else if (result.applied) {
          attribution = { applied: false, reason: `shadow_would_stamp:${result.reason}`, before: result.before };
          console.log(
            `[LP-PROXY] 🕶️ ATTRIBUTION SHADOW log=${body.lognumber || '?'} sender="${body.sender || ''}" ` +
            `would stamp srs_id=${LP_SRS.CHATBOT}/pro_id=${LP_PRO.CHATBOT} (was ${JSON.stringify(result.before)})`
          );
        } else {
          attribution = { applied: false, reason: result.reason };
        }
      } catch (err) {
        console.error(`[LP-PROXY] attribution fallback threw — forwarding untouched: ${err.message}`);
      }
    }

    // ── Address completeness gate (Section D, 2026-08-18) ───────────────
    // D1: the LP push is the dial trigger and LP never repairs a prospect
    // from a later push, so the FIRST push must carry a complete address.
    // Hold-and-enrich, never drop: incomplete → fill from the GHL contact
    // (lognumber = contact id) → still incomplete → park in
    // lp_addlead_address_hold (the sweeper retries, then forwards anyway
    // stamped "INCOMPLETE ADDRESS ON FILE"). Ships LP_ADDRESS_GATE_MODE=
    // shadow: evaluates + logs, forwards everything. applyAddressGate is
    // fail-open by construction — any internal error forwards untouched.
    let gate = null;
    try {
      gate = await applyAddressGate(outbound);
      if (gate.action === 'hold') {
        console.log(
          `[LP-PROXY] ${body.sender || '?'} log=${body.lognumber || '?'} mode=${mode} ` +
          `attribution=${aMode}/${attribution.reason} ` +
          `plan=${plan.action}/${plan.reason} address_gate=HELD missing=[${gate.missing.join(',')}] ${Date.now() - started}ms`
        );
        // No LP response exists for a held lead — Contract 1 (response
        // fidelity) applies to forwarded bodies only. GHL's "Extract
        // Inbound Lead ID" finds no "lead added:" prefix in this body, so
        // downstream id-writeback simply doesn't run; the sweeper writes
        // the in1_id to the contact when the hold releases.
        res.status(200).type('application/json').send(JSON.stringify({
          status: 'HELD',
          message: `address hold: lead parked for enrichment (missing ${gate.missing.join(', ')})`,
        }));
        return;
      }
      if (gate.body !== outbound) outbound = gate.body; // enriched fields flow to LP
    } catch (err) {
      console.error(`[LP-PROXY] address gate threw — forwarding untouched: ${err.message}`);
    }

    // ── Agentic notes enrichment ────────────────────────────────────────
    // A rich brief already on the body (canvassing, or a healthy ChatGPT-node
    // output) is never clobbered: 'live' only replaces a weak one, and
    // 'augment' appends to a healthy one rather than overwriting it.
    // isWeakNotes() also catches an unresolved "{{contact.contact_summary}}"
    // merge token, which is the exact failure mode on agentic leads today.
    //
    // hasAppointment is read off the OUTBOUND body, not off plan.reason: under
    // 'passthrough' no validation ran, and under 'shadow' a strip-planned lead
    // still forwards its appointment. The body is what LP actually receives.
    //
    // FAIL-OPEN, matching the validation posture above. Any error, timeout, or
    // null build forwards the body untouched.
    const nMode = notesMode();
    let notesAction = 'skipped';
    if (nMode !== 'off' && !isBlank(body.lognumber)) {
      const weak = isWeakNotes(outbound.notes);
      // 'augment' is the only mode that touches a healthy brief. 'shadow'
      // builds in both cases so the true before/after is visible in logs
      // before anything is enforced.
      const enriches = weak || nMode === 'augment';
      if (enriches || nMode === 'shadow') {
        const augmentFrom = weak ? null : outbound.notes;
        const kind = augmentFrom ? 'augmented' : 'injected';
        try {
          const built = await raceWithNullTimeout(
            fetchAndBuildAgenticNotes(body.lognumber, {
              hasAppointment: !isBlank(outbound.adate),
              augmentFrom,
            }),
            NOTES_ENRICH_TIMEOUT_MS
          );
          if (!built) {
            notesAction = 'no_build';
          } else if (nMode === 'shadow') {
            notesAction = `shadow_${kind}(${built.length})`;
            console.log(`[LP-PROXY] 🕶️ NOTES SHADOW log=${body.lognumber} — NOT sent:\n${built}`);
          } else {
            outbound = { ...outbound, notes: built };
            notesAction = `${kind}(${built.length})`;
          }
        } catch (err) {
          notesAction = 'error';
          console.warn(`[LP-PROXY] notes enrichment threw — forwarding unchanged: ${err.message}`);
        }
      }
    }

    try {
      const lp = await forwardToLp(outbound);
      console.log(
        `[LP-PROXY] ${body.sender || '?'} log=${body.lognumber || '?'} mode=${mode} ` +
        `attribution=${aMode}/${attribution.reason}${attribution.applied ? `→${LP_SRS.CHATBOT}/${LP_PRO.CHATBOT}` : ''} ` +
        `notes=${nMode}/${notesAction} ` +
        `address_gate=${gate ? `${gate.mode}/${gate.reason}${gate.would_hold ? '/WOULD_HOLD' : ''}` : 'skipped'} ` +
        `plan=${plan.action}/${plan.reason} lp=${lp.status} ${Date.now() - started}ms`
      );
      res.status(lp.status).type(lp.contentType).send(lp.raw);
    } catch (err) {
      // LP unreachable/slow: surface an error status so GHL's existing
      // "No Error"/Default retry branches behave exactly as they do today
      // when LP itself is down.
      console.error(`[LP-PROXY] LP forward failed for log=${body.lognumber || '?'}: ${err.message}`);
      res.status(502).type('text/plain').send(`LP forward failed: ${err.message}`);
    }
  });

  console.log(`[LP-PROXY] Registered: POST /webhook/ghl/lp-addlead-proxy (mode=${proxyMode()}, notes=${notesMode()}, attribution=${attributionFallbackMode()}, target=${LP_ADDLEAD_URL})`);
}

export const _internal = { proxyMode, notesMode, attributionFallbackMode };
