/**
 * ActiveProspect intake hop — src/ap-intake.js
 *
 * POST /intake/ap-lead
 *
 * ActiveProspect posts the lead here instead of straight to Lead Perfection.
 * We resolve the GHL contact, stamp its id into `lognumber` / `User1`, forward
 * to LP, and return LP's own response bytes so AP's existing success/failure
 * handling keeps working unchanged.
 *
 * ─── WHY WE FORWARD TO LP, RATHER THAN HANDING THE ID BACK ──────────────────
 * The first design had AP call us for an id and then post to LP itself. That
 * is worse, and the reason is latency, which is the constraint that decides
 * this whole design:
 *
 *   today          AP waits for the LP post.                      1 round trip
 *   two-hop        AP waits for us, THEN for the LP post.         2 round trips
 *   this (one-hop) AP waits for us; we do the LP post inline.     1 round trip
 *
 * AP is ALREADY waiting on Lead Perfection today, so folding the contact
 * resolve in front of that same call adds only the resolve — capped below —
 * instead of adding a whole extra round trip. It also makes ordering a fact
 * rather than a configuration: LP cannot see the lead before the contact
 * exists, because the same function does both in order.
 *
 * LP accepts `lognumber` / `User1` ONLY on AddLead and never again
 * (src/ghl-note-pipeline/resolve-or-create.js:15-17), so this ordering is the
 * only way the id ever reaches LP.
 *
 * ─── WHAT THIS COSTS, STATED PLAINLY ────────────────────────────────────────
 * We become the delivery path. If this service is down, AP's delivery fails
 * and retries; leads are delayed rather than lost, and AP should carry a
 * fallback delivery straight to LP for a total outage. That is the trade for
 * the ordering guarantee, and it is the same trade lp-addlead-proxy.js already
 * makes for the chatbot path.
 *
 * ─── THE LATENCY BUDGET IS THE ACCEPTANCE TEST ──────────────────────────────
 * Measured on n8n workflow YOozjkCkeNEe4s3a (I.AP), the pipe this replaces:
 * zero errors, typical 1.1-2.1s, several 5-6s, worst 20.7s. n8n never failed —
 * ActiveProspect gave up while it was still working. The long tail was tag
 * resolution, LP Subsource/Source writes and the ensure-routing-tags call.
 *
 * NONE of that is needed to answer ActiveProspect, so none of it is on this
 * path. The response does exactly two things: resolve a contact, forward to
 * LP. Enrichment happens afterwards, driven by the event the sync already
 * emits when the lead comes back.
 *
 * The resolve is capped by AP_INTAKE_RESOLVE_TIMEOUT_MS and FAILS OPEN: on a
 * timeout, an error, or an unconfirmable match, we forward to LP with no id
 * rather than hanging. The lead reaches the floor either way and the matcher
 * links it afterwards exactly as it does today. A slow GHL must never cost a
 * lead.
 *
 * ─── MODES (AP_INTAKE_MODE) ─────────────────────────────────────────────────
 *   off     pure passthrough — forward to LP untouched.
 *   shadow  DEFAULT. Search, never create, never stamp. Forwards to LP exactly
 *           as `off` does, and logs what it WOULD have stamped plus the real
 *           timings. This is what makes re-pointing AP at us a safe step on
 *           its own: in shadow the endpoint is a transparent proxy, so the
 *           risky move (changing AP) and the behaviour change (stamping ids)
 *           happen on different days.
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

/**
 * Build the GHL contact shape from an ActiveProspect payload.
 *
 * Pure, so the key mapping is testable without a network. AP field names vary
 * per vendor mapping, so each value accepts the spellings LeadConduit actually
 * sends alongside the LP AddLead names the body already carries.
 */
export function contactInputFromApBody(body, { vendor = '' } = {}) {
  return {
    phone: pick(body, 'phone', 'phone1', 'Phone1', 'phone_1', 'primary_phone'),
    firstName: pick(body, 'firstname', 'first_name', 'FirstName'),
    lastName: pick(body, 'lastname', 'last_name', 'LastName'),
    email: pick(body, 'email', 'Email'),
    address: pick(body, 'address1', 'Address1', 'address'),
    city: pick(body, 'city', 'City'),
    state: pick(body, 'state', 'State'),
    postalCode: pick(body, 'zip', 'Zip', 'postal_code', 'postalCode'),
    // The real origin, not the pipe that carried it — the same choice
    // lp-contact-backstop.js makes for its `source` field.
    source: vendor || pick(body, 'sourcesubdescr', 'source', 'Source') || 'activeprospect',
  };
}

export function registerApIntakeRoutes(app) {
  app.post('/intake/ap-lead', async (req, res) => {
    const started = Date.now();
    const mode = intakeMode();
    const body = flattenWebhookBody(req.body || {});
    const vendor = pick(body, 'sourcesubdescr', 'vendor', 'source');

    let contactId = null;
    let outcome = 'skipped';
    let resolveMs = 0;

    if (mode !== 'off') {
      const t0 = Date.now();
      try {
        const input = contactInputFromApBody(body, { vendor });
        // Shadow searches but never creates, so it can measure the real hit
        // rate and the real latency while writing nothing.
        const tags = [AP_INTAKE_TAG, 'lp-linked', 'stage:new-lead',
          ...backstopTagsFor('Internet', vendor || null, { suppressOutbound: false })];
        const result = await raceWithNullTimeout(
          resolveOrCreateContact({ ...input, tags }, { create: mode === 'live' }),
          RESOLVE_TIMEOUT_MS,
        );
        resolveMs = Date.now() - t0;
        if (result === null) {
          // The ceiling won. Forward without an id rather than hang.
          outcome = 'timeout';
        } else {
          outcome = result.outcome;
          if (mode === 'live') contactId = result.contactId;
        }
      } catch (err) {
        resolveMs = Date.now() - t0;
        outcome = 'error';
        // Fail open by contract: a GHL problem must not stop a lead reaching
        // the sales floor.
        console.warn(`[AP-INTAKE] resolve failed (${resolveMs}ms), forwarding without id: ${err.message}`);
      }
    }

    // Stamp only when we actually have an id. LP takes these at AddLead and
    // never again, so a blank would waste the one chance rather than defer it.
    const outbound = contactId
      ? { ...body, lognumber: contactId, User1: contactId }
      : body;

    try {
      const lp = await forwardToLp(outbound);
      console.log(
        `[AP-INTAKE] vendor=${vendor || '?'} mode=${mode} resolve=${outcome}/${resolveMs}ms `
        + `${contactId ? `stamped=${contactId} ` : 'stamped=no '}`
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

  console.log(`[AP-INTAKE] Registered: POST /intake/ap-lead (mode=${intakeMode()}, resolve_ceiling=${RESOLVE_TIMEOUT_MS}ms)`);
}

export const _internal = { intakeMode, raceWithNullTimeout, RESOLVE_TIMEOUT_MS, AP_INTAKE_TAG };
