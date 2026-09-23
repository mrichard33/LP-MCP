/**
 * ActiveProspect intake hop — src/ap-intake.js
 *
 * POST /intake/ap-resolve   resolve only  ← the one ActiveProspect should use
 * POST /intake/ap-lead      resolve + deliver to LP  (fallback)
 *
 * LP accepts `lognumber` / `User1` ONLY on AddLead and never again
 * (src/ghl-note-pipeline/resolve-or-create.js:15-17). So the GHL contact id has
 * to be on the lead the FIRST time LP sees it, or the link has to be rebuilt
 * afterwards by the matcher — which is the backlog Phase A spent a session
 * repairing. Both routes exist to put the id there at AddLead time.
 *
 * ─── WHY THERE ARE TWO, AND WHY /ap-resolve WON (2026-09-21, Mark's ruling) ─
 * /ap-lead was built first and replaces LeadConduit step 12 outright: resolve,
 * post to LP inline, mirror LP's bytes back. One round trip, and ordering is a
 * fact rather than a configuration.
 *
 * Then we actually looked at step 12. It carries 22 proven field mappings,
 * Automated retry, and a dedicated downstream failure filter at step 14.
 * Replacing it means re-creating all of that AND making this service the
 * delivery artery for every purchased lead: if we are down, every AP delivery
 * fails and retries.
 *
 * /ap-resolve is the additive shape instead. It answers with the contact id and
 * nothing else; LeadConduit appends the response to the lead, and step 12 maps
 * it into lognumber/User1 with everything else about step 12 untouched. The
 * cost is one extra HTTP round trip (~0.2-0.5s) — NOT an extra wait on LP,
 * because AP waits on LP in both shapes. The benefit is that a bad deploy or a
 * GHL outage here cannot cost a lead: step 12 still posts to LP exactly as it
 * does today.
 *
 * /ap-lead stays as the fallback for the case where LeadConduit turns out not
 * to let step 12 map an appended response field.
 *
 * ─── THE LATENCY BUDGET IS THE ACCEPTANCE TEST ──────────────────────────────
 * Measured on n8n workflow YOozjkCkeNEe4s3a (I.AP), which AP already delivers
 * to: zero errors, typical 1.1-2.1s, several 5-6s, worst 20.7s. n8n never
 * failed — ActiveProspect gave up while it was still working. The long tail was
 * tag resolution, LP Subsource/Source writes and the ensure-routing-tags call.
 *
 * NONE of that is needed to answer ActiveProspect, so none of it is on this
 * path. /ap-resolve does exactly one thing, and /ap-lead exactly two. I.AP is
 * NOT replaced and must stay: it does the enrichment, and its own phone search
 * means it finds the contact we created rather than creating a second one.
 *
 * The resolve is capped by AP_INTAKE_RESOLVE_TIMEOUT_MS and FAILS OPEN: on a
 * timeout, an error, or an unconfirmable match, we answer with no id rather
 * than hanging. The lead reaches the floor either way and the matcher links it
 * afterwards exactly as it does today. A slow GHL must never cost a lead.
 *
 * /ap-resolve expresses that same contract as ALWAYS HTTP 200. A non-200 marks
 * the step failed in LeadConduit and can trip flow error handling; a 200 with an
 * empty contact_id just means "no id, carry on".
 *
 * There is no configurable delivery timeout in LeadConduit's step UI and none
 * is published, so logClientDisconnect() below is the only way we learn what
 * AP's real ceiling is: the socket closing before we answered.
 *
 * ─── MODES (AP_INTAKE_MODE) ─────────────────────────────────────────────────
 *   off     pure passthrough — forward to LP untouched.
 *   shadow  DEFAULT. Search, never create, never return an id. Logs what it
 *           WOULD have stamped plus the real timings. This is what makes
 *           re-pointing AP at us a safe step on its own: in shadow neither
 *           endpoint changes anything a lead can see, so the risky move
 *           (changing AP) and the behaviour change (stamping ids) happen on
 *           different days.
 *   live    resolve-or-create and stamp.
 */

import { forwardToLp } from './lp-addlead-proxy.js';
import { flattenWebhookBody } from './webhook-body.js';
import { resolveOrCreateContact } from './services/ghl-contact-resolve.js';
import { backstopTagsFor } from './services/lp-contact-backstop.js';

/** Hard ceiling on the contact resolve. See the budget note above. */
const RESOLVE_TIMEOUT_MS = Number(process.env.AP_INTAKE_RESOLVE_TIMEOUT_MS || 1200);

/** Tags every AP-created contact carries. `ap-intake-created` is load-bearing:
 *  agent rule 355 (INTAKE_ROUTE_BACKSTOP_OTHER) routes on it. */
const AP_INTAKE_TAG = 'ap-intake-created';

function intakeMode() {
  const m = String(process.env.AP_INTAKE_MODE || 'shadow').toLowerCase();
  return ['off', 'shadow', 'live'].includes(m) ? m : 'shadow';
}

/**
 * Resolve null at the ceiling. Same helper shape as lp-addlead-proxy.js:113 —
 * the timer is cleared either way so a fast resolve never holds the event loop
 * open for the full timeout.
 */
function raceWithNullTimeout(promise, ms) {
  let timer;
  const ceiling = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([promise, ceiling]).finally(() => clearTimeout(timer));
}

/** First non-empty value among several possible key spellings. */
export function pick(body, ...keys) {
  for (const k of keys) {
    const v = body?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

// ─── Vendor NAME, not LeadConduit's record id (2026-09-23) ──────────────────
//
// Shadow mode's first two days logged `vendor=659d63d0effd26f951b6da45 srs=790`
// on every call: step 12's payload carries LeadConduit's 24-hex vendor/source
// record id, not a name. In live mode that id became the GHL contact's
// `source` AND a junk `source:internet-659d63d0…` attribution tag, because
// both were built from whatever pick() found first.
//
// The payload's `srs_id` is the reliable handle. It is LP's own SubSource id
// — the value LP attributes the lead under — and lp_source_catalog (refreshed
// daily by src/jobs/source-reconcile.js) maps it to the name LP reports and
// lp_source_mapping routes on: 790 → HomeBuddy, 717 → MyHomePros,
// 874 → Swish Leads, each matching every lp_leads row with that srs_id.

/** LeadConduit record ids are 24-hex ObjectIds. Never a vendor name. */
const LEADCONDUIT_ID = /^[0-9a-f]{24}$/i;
export function looksLikeLeadConduitId(value) {
  return LEADCONDUIT_ID.test(String(value || '').trim());
}

/** pick(), skipping values that are LeadConduit record ids. */
export function pickName(body, ...keys) {
  for (const k of keys) {
    const v = pick(body, k);
    if (v && !looksLikeLeadConduitId(v)) return v;
  }
  return '';
}

// srs_id → subsource name, cached in memory. ActiveProspect is waiting on the
// line, so the lead path must never wait on this: the load is capped, runs at
// route registration to warm the cache, and on any failure the answer is "no
// name" — the lead proceeds exactly as it did before this lookup existed.
const SRS_CACHE_TTL_MS = 60 * 60 * 1000;
const SRS_LOAD_TIMEOUT_MS = 300;
const srsCache = { names: null, at: 0 };

async function loadSrsNamesFromCatalog() {
  // Imported lazily so the pure helpers in this module stay testable without
  // Supabase credentials.
  const { default: supabase } = await import('./supabase.js');
  const { data, error } = await supabase
    .from('lp_source_catalog')
    .select('lp_source_id, lp_source_subdetail')
    .eq('active', true);
  if (error) throw new Error(error.message);
  const names = new Map();
  for (const row of data || []) {
    const id = String(row.lp_source_id ?? '').trim();
    const name = String(row.lp_source_subdetail ?? '').trim();
    if (id && name) names.set(id, name);
  }
  return names;
}

/**
 * The cached srs_id → name map. Serves the last good map while stale, never
 * caches a failure, and never throws.
 */
export async function getSrsNames({ load = loadSrsNamesFromCatalog, now = Date.now } = {}) {
  if (srsCache.names && now() - srsCache.at < SRS_CACHE_TTL_MS) return srsCache.names;
  try {
    const names = await raceWithNullTimeout(load(), SRS_LOAD_TIMEOUT_MS);
    if (names instanceof Map && names.size > 0) {
      srsCache.names = names;
      srsCache.at = now();
      return names;
    }
    if (names === null) console.warn(`[AP-INTAKE] source catalog load exceeded ${SRS_LOAD_TIMEOUT_MS}ms — vendor name from payload only`);
  } catch (err) {
    console.warn(`[AP-INTAKE] source catalog load failed — vendor name from payload only: ${err.message}`);
  }
  return srsCache.names || new Map();
}

/**
 * Build the GHL contact shape from an ActiveProspect payload.
 *
 * Pure, so the key mapping is testable without a network. AP field names vary
 * per vendor mapping, so each value accepts the spellings LeadConduit actually
 * sends alongside the LP AddLead names the body already carries.
 */
export function contactInputFromApBody(body, { vendor = '' } = {}) {
  return {
    phone: pick(body, 'phone', 'phone1', 'Phone1', 'phone_1', 'primary_phone',
      'Phone', 'mobile', 'cell', 'phone_number'),
    firstName: pick(body, 'firstname', 'first_name', 'FirstName', 'firstName'),
    lastName: pick(body, 'lastname', 'last_name', 'LastName', 'lastName'),
    email: pick(body, 'email', 'Email', 'email_address'),
    address: pick(body, 'address1', 'Address1', 'address', 'address_1', 'Address', 'street'),
    city: pick(body, 'city', 'City'),
    state: pick(body, 'state', 'State'),
    postalCode: pick(body, 'zip', 'Zip', 'postal_code', 'postalCode', 'zipcode'),
    // The real origin, not the pipe that carried it — the same choice
    // lp-contact-backstop.js makes for its `source` field. Never a
    // LeadConduit record id (see the vendor note above).
    source: vendor || pickName(body, 'sourcesubdescr', 'source', 'Source') || 'activeprospect',
  };
}

/**
 * The vendor NAME for an AP payload: LP's catalog name for the payload's
 * srs_id first, then any payload field holding a real name. '' when neither —
 * a blank is better than an id, which would become a bogus attribution tag.
 */
export function vendorFromApBody(body, { srsNames = null } = {}) {
  const srsId = pick(body, 'srs_id', 'srsid', 'SRS_id');
  const fromCatalog = srsId && srsNames ? srsNames.get(srsId) : '';
  return fromCatalog || pickName(body, 'sourcesubdescr', 'vendor', 'lp_subsource', 'source',
    'source_name', 'lead_source', 'Source');
}

/**
 * Resolve the GHL contact for an AP payload. Shared by both routes so there is
 * exactly one copy of the mode gate, the tag set and the timeout ceiling.
 *
 * Never throws: every failure is reported as an `outcome` and an empty id,
 * because both callers must forward the lead regardless (fail-open contract,
 * see the header note).
 *
 * `contactId` is populated ONLY in live mode. `wouldStamp` carries what shadow
 * found, so shadow can measure the real hit rate while writing nothing and
 * returning nothing a caller could act on.
 */
export async function resolveApContact(body, { mode = intakeMode(), deps, log, srsNames } = {}) {
  const vendor = vendorFromApBody(body, { srsNames: srsNames ?? await getSrsNames() });
  if (mode === 'off') return { contactId: null, wouldStamp: null, outcome: 'skipped', resolveMs: 0, mirrorMs: null, vendor };

  const t0 = Date.now();
  try {
    const input = contactInputFromApBody(body, { vendor });
    const tags = [AP_INTAKE_TAG, 'lp-linked', 'stage:new-lead',
      ...backstopTagsFor('Internet', vendor || null, { suppressOutbound: false })];
    const result = await raceWithNullTimeout(
      resolveOrCreateContact({ ...input, tags }, {
        create: mode === 'live',
        // Ask the HL contacts mirror before GoHighLevel. ghlFetch queues on the
        // same token bucket as the action executor, which is what timed this
        // endpoint out at 1200ms on 2026-09-21 while the search itself measured
        // 101-270ms. See services/ghl-contact-mirror.js.
        mirrorFirst: true,
        // Synchronous lead intake: ActiveProspect is on the line, and LP takes
        // `lognumber` at AddLead and never again, so an id we fail to get here
        // is not late — it is gone. This draws below the rate limiter's reserve
        // and ahead of every batch waiter (src/ghl-rate-limiter.js v1.5).
        priority: 'high',
        ...(deps ? { deps } : {}),
        ...(log ? { log } : {}),
      }),
      RESOLVE_TIMEOUT_MS,
    );
    const resolveMs = Date.now() - t0;
    // The ceiling won. Answer without an id rather than hang.
    if (result === null) return { contactId: null, wouldStamp: null, outcome: 'timeout', resolveMs, mirrorMs: null, vendor };
    return {
      contactId: mode === 'live' ? (result.contactId || null) : null,
      wouldStamp: result.contactId || null,
      outcome: result.outcome,
      resolveMs,
      // How much of resolveMs was the mirror query. See the note in
      // services/ghl-contact-resolve.js — the two have opposite fixes.
      mirrorMs: result.mirrorMs ?? null,
      vendor,
    };
  } catch (err) {
    const resolveMs = Date.now() - t0;
    // Fail open by contract: a GHL problem must not stop a lead reaching the
    // sales floor.
    console.warn(`[AP-INTAKE] resolve failed (${resolveMs}ms), continuing without id: ${err.message}`);
    return { contactId: null, wouldStamp: null, outcome: 'error', resolveMs, mirrorMs: null, vendor };
  }
}

/**
 * Log the moment ActiveProspect gives up on us.
 *
 * LeadConduit exposes NO delivery timeout setting in its step UI and publishes
 * none, so the only way to learn the real ceiling is to notice the socket
 * closing before we answered. Without this line a lead AP abandoned is
 * indistinguishable from one it never sent.
 */
function logClientDisconnect(req, res, started, label) {
  // 2026-09-21 — LISTEN ON `res`, NOT `req`, AND CHECK writableFinished.
  //
  // The first cut used `req.on('close')` with `res.writableEnded`. On Node the
  // REQUEST stream's 'close' fires as soon as the request body has been read —
  // on every healthy request, before the handler has answered. So this logged
  // `client disconnected after 5ms — ActiveProspect gave up` at severity error
  // for every single call, including the four successful probes that first
  // exercised it.
  //
  // That is the failure CLAUDE.md names directly: an alarm that fires on the
  // healthy case gets muted, and a muted alarm is how a 47-hour outage went
  // unnoticed. Worse here than useless — this line is the ONLY evidence we can
  // ever get of ActiveProspect's real delivery timeout, since LeadConduit
  // exposes none, so drowning it in false positives costs the one measurement.
  //
  // The RESPONSE's 'close' fires when the response completes OR the connection
  // is torn down early, and `writableFinished` is true only once the whole
  // response was flushed. That pair distinguishes the two.
  res.on('close', () => {
    if (res.writableFinished) return;
    console.warn(`[${label}] client disconnected after ${Date.now() - started}ms — `
      + 'ActiveProspect gave up before we answered');
  });
}

export function registerApIntakeRoutes(app) {
  // ── Resolve only. The step that sits BEFORE the Lead Perfection Form POST.
  //
  // WHY THIS EXISTS ALONGSIDE /intake/ap-lead (2026-09-21, Mark's ruling).
  // /intake/ap-lead replaces LeadConduit step 12 outright and posts to LP
  // itself. Step 12 carries 22 proven field mappings, Automated retry and a
  // dedicated downstream failure filter (step 14); replacing it makes this
  // service the delivery artery for every purchased lead. This route is the
  // additive shape instead: we return the contact id, LeadConduit appends it
  // to the lead, and step 12 maps it into lognumber/User1 unchanged. If we are
  // slow or down, step 12 still posts to LP exactly as it does today, so
  // neither a bad deploy nor a GHL outage can cost a lead.
  //
  // ALWAYS HTTP 200, including on timeout and error. A non-200 marks the step
  // failed in LeadConduit and can trip flow error handling; a 200 carrying an
  // empty contact_id means "no id, carry on", which is the fail-open contract
  // expressed in the only vocabulary the flow understands.
  app.post('/intake/ap-resolve', async (req, res) => {
    const started = Date.now();
    logClientDisconnect(req, res, started, 'AP-RESOLVE');
    const mode = intakeMode();
    const body = flattenWebhookBody(req.body || {});

    const r = await resolveApContact(body, { mode });

    console.log(
      // srs_id is printed beside the vendor NAME it resolved to (via
      // lp_source_catalog — see the vendor note at the top). Shadow printing
      // the two side by side is how the 24-hex LeadConduit id was caught.
      `[AP-RESOLVE] vendor=${r.vendor || '?'} srs=${pick(body, 'srs_id', 'srsid', 'SRS_id') || '?'} `
      + `mode=${mode} resolve=${r.outcome}/${r.resolveMs}ms mirror=${r.mirrorMs ?? '-'}ms `
      + `${r.contactId ? `returned=${r.contactId}` : `returned=no${r.wouldStamp ? ` would=${r.wouldStamp}` : ''}`} `
      + `total=${Date.now() - started}ms`
    );

    res.status(200).json({
      contact_id: r.contactId || '',
      outcome: r.outcome,
      ms: r.resolveMs,
      // Shadow's whole product: what we WOULD have handed back, with nothing
      // written and nothing the flow can map yet.
      ...(mode === 'shadow' ? { would_stamp: r.wouldStamp || '' } : {}),
    });
  });

  // ── Resolve AND deliver. Replaces step 12. Kept as the fallback for the case
  // where LeadConduit cannot map an appended response field onto step 12.
  app.post('/intake/ap-lead', async (req, res) => {
    const started = Date.now();
    logClientDisconnect(req, res, started, 'AP-INTAKE');
    const mode = intakeMode();
    const body = flattenWebhookBody(req.body || {});

    const r = await resolveApContact(body, { mode });

    // Stamp only when we actually have an id. LP takes these at AddLead and
    // never again, so a blank would waste the one chance rather than defer it.
    const outbound = r.contactId
      ? { ...body, lognumber: r.contactId, User1: r.contactId }
      : body;

    try {
      const lp = await forwardToLp(outbound);
      console.log(
        `[AP-INTAKE] vendor=${r.vendor || '?'} mode=${mode} resolve=${r.outcome}/${r.resolveMs}ms `
        + `${r.contactId ? `stamped=${r.contactId} ` : 'stamped=no '}`
        + `lp=${lp.status} total=${Date.now() - started}ms`
      );
      // Contract: return LP's own bytes, so ActiveProspect's existing handling
      // of an LP response keeps working unchanged. Never re-serialise.
      res.status(lp.status).type(lp.contentType).send(lp.raw);
    } catch (err) {
      console.error(`[AP-INTAKE] LP forward failed after ${Date.now() - started}ms: ${err.message}`);
      // Surface the failure so ActiveProspect retries, exactly as it would if
      // it had posted to LP itself and LP were down.
      res.status(502).type('text/plain').send(`LP forward failed: ${err.message}`);
    }
  });

  // Warm the srs_id → vendor-name cache so the first lead after a deploy does
  // not pay for the catalog read. Fire-and-forget: getSrsNames never throws.
  getSrsNames();

  console.log(`[AP-INTAKE] Registered: POST /intake/ap-resolve, POST /intake/ap-lead `
    + `(mode=${intakeMode()}, resolve_ceiling=${RESOLVE_TIMEOUT_MS}ms)`);
}

export const _internal = {
  intakeMode, raceWithNullTimeout, logClientDisconnect, RESOLVE_TIMEOUT_MS, AP_INTAKE_TAG,
  __resetSrsCacheForTest() { srsCache.names = null; srsCache.at = 0; },
};
