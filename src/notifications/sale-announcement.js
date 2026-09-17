/**
 * Agentic Sale Announcements — endpoint + orchestrator
 * src/notifications/sale-announcement.js
 *
 * POST /notifications/sale-announcement
 *
 * Receives each completed sale from the GHL Sold branch, enriches it with the
 * rep's real performance history, composes a motivational message and posts it
 * to the Slack sales board. GroupMe keeps firing from inside the GHL workflow
 * (steps 46-47) as the transition fallback, so for a few weeks every sale posts
 * twice with different wording. That divergence is expected and correct.
 *
 * WHY IT ANSWERS 200 BEFORE IT DOES THE WORK
 * ------------------------------------------
 * The row is written, then GHL gets its 200, then composition happens under
 * setImmediate. A GHL webhook action must never wait on a model call — the
 * workflow would time out and take its own fallback branch while we were still
 * writing a sentence. Same shape as the backfill and sweep endpoints under
 * src/admin/.
 *
 * WHY IT DOES NOT USE THE SHARED authenticate MIDDLEWARE
 * -----------------------------------------------------
 * src/index.js authenticate() calls next() when MCP_AUTH_TOKEN is unset, and
 * lets everything through when AUTH_SOFT_LAUNCH=true. Both are reasonable for a
 * read-only diagnostic and wrong for an endpoint whose whole job is to post to a
 * channel the entire company reads. checkSaleBearer below FAILS CLOSED: no
 * SALE_ANNOUNCE_TOKEN configured means 401, not "open to the internet".
 * (appointment-notifications.js checkBearerAuth fails OPEN on an unset token —
 * deliberately not copied.)
 *
 * WHY THE IDEMPOTENCY KEY IS THE LEAD AND NOT THE PROSPECT
 * -------------------------------------------------------
 * LP dispositions replay. Measured live 2026-09-16: lp_leads holds 241,625
 * distinct lp_lead_id against 146,595 distinct lp_prospect_id, equal on 2,049
 * rows. One prospect owns many leads, so a prospect-keyed announcement would
 * suppress a repeat customer's SECOND sale as a false duplicate. See
 * resolve-lead.js for the resolution order and sql/117 for the constraint.
 *
 * WHY THE CLOSE-DATE WRITE HAPPENS BEFORE THE FACTS READ
 * -----------------------------------------------------
 * lp_leads.close_date was NULL on all 24,834 closed_won rows (measured
 * 2026-09-16) because nothing ever wrote it. sql/118 backfills it and this
 * endpoint writes a real one per sale. Writing THIS sale's close_date first
 * means "including this sale" falls out of the data instead of being
 * special-cased in every metric. It is gated on canWriteBack(): a key we
 * invented from a prospect or a contact is not a lead we found.
 */

import crypto from 'crypto';
import supabaseDefault from '../supabase.js';
import { resolveLeadId, canWriteBack } from './resolve-lead.js';
import { buildRepFacts } from './sale-facts.js';
import { generateSaleAnnouncement, formatStatsLine } from './sale-announcement-body-generator.js';
import { postSaleAnnouncement, postSaleStats, mirrorSaleToGroupMe, alertSaleDeliveryFailed } from './slack-sale.js';

export const ROUTE_PATH = '/notifications/sale-announcement';

export const STATUSES = Object.freeze({
  PENDING: 'pending',
  POSTED: 'posted',
  SLACK_FAILED: 'slack_failed',
  SKIPPED_INVALID: 'skipped_invalid',
  DISABLED: 'disabled',
});

function featureEnabled() {
  return String(process.env.SALE_ANNOUNCE_ENABLED || 'false') === 'true';
}

/**
 * Bearer check, fail-closed. Returns { ok, fingerprint } — the fingerprint
 * carries lengths and never the token, because an empty bearer here almost
 * always means the GHL custom value did not resolve and the length is what tells
 * you that. Same diagnostic idea as appointment-notifications.js, opposite
 * default on an unset token.
 */
export function checkSaleBearer(req, token = process.env.SALE_ANNOUNCE_TOKEN) {
  const expected = String(token || '');
  const auth = String(req?.headers?.authorization || '');
  const headerPresent = auth.length > 0;
  const scheme = auth.startsWith('Bearer ') ? 'bearer' : headerPresent ? 'other' : 'none';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  const fingerprint = {
    header_present: headerPresent,
    scheme,
    provided_len: provided == null ? null : provided.length,
    expected_len: expected.length,
    token_configured: expected.length > 0,
  };

  if (!expected) return { ok: false, reason: 'token_not_configured', fingerprint };
  if (provided == null) return { ok: false, reason: 'no_bearer', fingerprint };

  // Constant-time compare. Lengths must match first — timingSafeEqual throws on
  // unequal lengths, and the length is already exposed in the fingerprint.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return { ok: false, reason: 'length_mismatch', fingerprint };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'mismatch', fingerprint };

  return { ok: true, reason: null, fingerprint };
}

/**
 * Pull the five fields out of a GHL body, tolerating a customData wrapper.
 *
 * customData arrives in three shapes depending on how the webhook action is
 * configured: absent (fields at the top level), a nested object, or a JSON
 * STRING. appointment-notifications.js logs `string[len]` as one of the shapes it
 * sees, so the string case is real and not defensive padding — unparsed, it would
 * present as "no fields at all" and every sale would 400.
 */
export function extractSaleFields(body) {
  const raw = body && typeof body === 'object' ? body : {};

  let wrapper = raw.customData;
  if (typeof wrapper === 'string') {
    try {
      wrapper = JSON.parse(wrapper);
    } catch {
      wrapper = null;
    }
  }
  const cd = wrapper && typeof wrapper === 'object' && !Array.isArray(wrapper) ? wrapper : {};
  const pick = (...keys) => {
    for (const k of keys) {
      if (raw[k] !== undefined && raw[k] !== null && String(raw[k]).trim() !== '') return String(raw[k]).trim();
      if (cd[k] !== undefined && cd[k] !== null && String(cd[k]).trim() !== '') return String(cd[k]).trim();
    }
    return null;
  };
  return {
    contact_id: pick('contact_id', 'contactId'),
    lp_lead_id: pick('lp_lead_id', 'lpLeadId'),
    lp_prospect_id: pick('lp_prospect_id', 'lpProspectId'),
    rep_display_name: pick('rep_display_name', 'repDisplayName'),
    lp_gross_sale_amount: pick('lp_gross_sale_amount', 'lpGrossSaleAmount', 'gross_sale_amount'),
  };
}

/**
 * A rep name we are willing to put on the sales board.
 *
 * "0" is the specific defect this guards. The GHL webhook previously mapped
 * rep_display_name to the contact's Last Name, and an unresolved or numeric
 * field arrives as the literal string "0" — which would post "0 steps up and
 * puts $31,500 on the board" to the whole floor. A numeric-only or punctuation-
 * only name is never a person.
 */
export function isUsableRepName(value) {
  const s = String(value ?? '').trim();
  if (!s) return false;
  if (s === '0') return false;
  if (/^[\d\s.,;:_-]+$/.test(s)) return false;
  // Needs at least two consecutive letters somewhere to be a name.
  return /[A-Za-z]{2}/.test(s);
}

/** Parse a GHL money field. Returns null for anything not a positive number. */
export function parseSaleAmount(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/[$,\s]/g, '');
  if (!cleaned || !/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** sha256(<key_input>:<rounded amount>) — see sql/117 for why. */
export function idempotencyKey(keyInput, amount) {
  const rounded = Math.round(Number(amount) || 0);
  return crypto.createHash('sha256').update(`${keyInput}:${rounded}`).digest('hex');
}

/**
 * Insert the pending row, or return the row that already exists.
 * A replay is a no-op returning the original — never an error back to GHL.
 */
export async function claimAnnouncement(row, deps = {}) {
  const { supabase = supabaseDefault } = deps;

  const ins = await supabase
    .from('sale_announcements')
    .insert(row)
    .select('id, status, slack_ts, message_text, created_at')
    .single();

  if (!ins.error) return { claimed: true, row: ins.data, error: null };

  // 23505 = unique_violation on idempotency_key. That is the replay path, and it
  // is a success: somebody already owns this sale.
  const isDuplicate =
    ins.error.code === '23505' || /duplicate key|unique constraint/i.test(ins.error.message || '');

  if (!isDuplicate) return { claimed: false, row: null, error: ins.error };

  const existing = await supabase
    .from('sale_announcements')
    .select('id, status, slack_ts, message_text, created_at')
    .eq('idempotency_key', row.idempotency_key)
    .single();

  return {
    claimed: false,
    duplicate: true,
    row: existing.data || null,
    error: existing.error || null,
  };
}

async function updateRow(id, patch, deps = {}) {
  const { supabase = supabaseDefault, logger = console } = deps;
  const res = await supabase.from('sale_announcements').update(patch).eq('id', id);
  if (res.error) logger.warn?.(`[SaleAnnounce] row ${id} update failed: ${res.error.message}`);
  return res;
}

/**
 * Stamp the sale onto the lp_leads row.
 *
 * Deliberately conservative: it only ever FILLS blanks. close_date is set only
 * when null, so sql/118's appointment_proxy value is replaced but a real LP
 * close date never is; job_value is set only when null, so LP stays the owner of
 * a number it already has. closed_won is set true because that is what the Sold
 * branch is telling us.
 *
 * Never called on prospect_fallback or contact_fallback — see canWriteBack().
 */
export async function stampCloseDate({ leadId, amount, now }, deps = {}) {
  const { supabase = supabaseDefault, logger = console } = deps;
  if (!leadId) return { written: false, reason: 'no_lead' };

  const cur = await supabase
    .from('lp_leads')
    .select('lp_lead_id, close_date, job_value')
    .eq('lp_lead_id', leadId)
    .single();

  if (cur.error || !cur.data) {
    logger.warn?.(`[SaleAnnounce] close_date skipped — lead ${leadId} unreadable: ${cur.error?.message || 'no row'}`);
    return { written: false, reason: 'lead_unreadable' };
  }

  const patch = { closed_won: true };
  if (!cur.data.close_date) {
    patch.close_date = new Date(now).toISOString();
    patch.close_date_source = 'sale_announcement';
  }
  if ((cur.data.job_value == null || Number(cur.data.job_value) === 0) && amount) {
    patch.job_value = amount;
  }

  const res = await supabase.from('lp_leads').update(patch).eq('lp_lead_id', leadId);
  if (res.error) {
    logger.warn?.(`[SaleAnnounce] close_date write failed lead=${leadId}: ${res.error.message}`);
    return { written: false, reason: res.error.message };
  }
  return { written: true, fields: Object.keys(patch) };
}

/**
 * Everything after the 200: stamp, gather facts, compose, post.
 * Never throws — it runs detached, so a throw here is an unhandled rejection.
 */
export async function completeAnnouncement(ctx, deps = {}) {
  const {
    logger = console,
    stamp = stampCloseDate,
    facts: factsFn = buildRepFacts,
    compose = generateSaleAnnouncement,
    post = postSaleAnnouncement,
    postStats = postSaleStats,
    statsLine = formatStatsLine,
    mirror = mirrorSaleToGroupMe,
    alert = alertSaleDeliveryFailed,
    update = updateRow,
    now = () => new Date(),
  } = deps;

  const { rowId, repDisplayName, amount, leadId, keySource } = ctx;

  try {
    // ── 1. Stamp the lead first, so facts include this sale ──────
    if (canWriteBack(keySource) && leadId) {
      await stamp({ leadId, amount, now: now() }, deps);
    }

    // ── 2. Facts (never fatal) ───────────────────────────────────
    let facts;
    try {
      facts = await factsFn(repDisplayName, amount, deps);
    } catch (err) {
      logger.warn?.(`[SaleAnnounce] facts threw (${err.message}) — composing on the sale alone`);
      facts = { degraded: true, reason: `threw:${err.message}` };
    }

    // ── 3. Compose (never throws by contract) ────────────────────
    const composed = await compose({ repDisplayName, saleAmount: amount, facts }, deps);

    await update(rowId, { message_text: composed.text, facts_json: facts }, deps);

    // ── 4. Post ──────────────────────────────────────────────────
    const res = await post(composed.text, deps);

    if (res.ok) {
      await update(rowId, {
        status: STATUSES.POSTED,
        slack_ts: res.ts,
        slack_channel: res.channel,
        completed_at: new Date(now()).toISOString(),
        error_message: null,
      }, deps);

      // ── The stats reply, in the thread under the celebration ─────
      // Added 2026-09-17. The month numbers used to ride inside the
      // announcement and turned it into a ledger entry; they now sit one click
      // away instead. Wrapped in its own try/catch because the row is ALREADY
      // 'posted' at this point and nothing below may take that away — the sale
      // reached the board, which is the thing that matters.
      try {
        const stats = statsLine(repDisplayName, facts, now());
        if (stats) {
          const statsRes = await postStats(stats, res.ts, deps);
          if (statsRes.ok) await update(rowId, { slack_stats_ts: statsRes.ts }, deps);
        }
      } catch (err) {
        logger.warn?.(`[SaleAnnounce] stats reply threw for row=${rowId}: ${err.message}`);
      }

      await mirror(composed.text, deps);
      logger.log?.(
        `[SaleAnnounce] posted row=${rowId} rep="${repDisplayName}" ts=${res.ts} ` +
        `key_source=${keySource} source=${composed.source}`,
      );
      return { ok: true, status: STATUSES.POSTED, ts: res.ts };
    }

    // ── 5. Failed delivery is loud, never silent ─────────────────
    await update(rowId, {
      status: STATUSES.SLACK_FAILED,
      error_message: `slack:${res.error} after ${res.attempts} attempts`,
      completed_at: new Date(now()).toISOString(),
    }, deps);
    await alert({
      row_id: rowId,
      rep_display_name: repDisplayName,
      gross_sale_amount: amount,
      lp_lead_id: leadId,
      key_source: keySource,
      error: res.error,
      attempts: res.attempts,
    }, deps);
    return { ok: false, status: STATUSES.SLACK_FAILED, error: res.error };
  } catch (err) {
    // Belt and braces: this function runs detached, so nothing above may escape.
    logger.error?.(`[SaleAnnounce] completion threw for row=${rowId}: ${err.message}`);
    await update(rowId, {
      status: STATUSES.SLACK_FAILED,
      error_message: `unexpected:${err.message}`,
      completed_at: new Date(now()).toISOString(),
    }, deps).catch(() => {});
    return { ok: false, status: STATUSES.SLACK_FAILED, error: err.message };
  }
}

/**
 * The HTTP handler. Resolves, validates, writes the row, answers 200, then hands
 * off to completeAnnouncement.
 */
export function makeSaleAnnouncementHandler(deps = {}) {
  const {
    logger = console,
    resolve = resolveLeadId,
    claim = claimAnnouncement,
    complete = completeAnnouncement,
    defer = setImmediate,
    now = () => new Date(),
  } = deps;

  return async function saleAnnouncementHandler(req, res) {
    const fields = extractSaleFields(req.body || {});

    // ── Auth first. A rejected request writes NO row. ────────────
    const auth = deps.auth ? deps.auth(req) : checkSaleBearer(req);
    if (!auth.ok) {
      const fp = auth.fingerprint || {};
      logger.warn?.(
        `[SaleAnnounce] AUTH FAILED (${auth.reason}) contact=${fields.contact_id || '(none)'} ` +
        `header_present=${fp.header_present} scheme=${fp.scheme} ` +
        `provided_len=${fp.provided_len} expected_len=${fp.expected_len}` +
        (fp.token_configured === false
          ? ' — SALE_ANNOUNCE_TOKEN IS NOT SET on this service; the endpoint is fail-closed and will reject every request until it is'
          : fp.provided_len === 0
            ? ' — EMPTY BEARER: the GHL custom value did not resolve'
            : ''),
      );
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const amount = parseSaleAmount(fields.lp_gross_sale_amount);
    const repOk = isUsableRepName(fields.rep_display_name);

    // ── Resolve the lead. Always yields a usable key. ────────────
    let resolved;
    try {
      resolved = await resolve(fields, deps);
    } catch (err) {
      // resolveLeadId is contracted never to throw; if it somehow does, fall
      // back to a contact-day key rather than dropping the sale.
      logger.warn?.(`[SaleAnnounce] resolution threw (${err.message}) — contact fallback`);
      resolved = {
        lead_id: null,
        key_source: 'contact_fallback',
        key_input: fields.contact_id ? `contact:${fields.contact_id}:${new Date(now()).toISOString().slice(0, 10)}` : null,
        corrected_from: fields.lp_lead_id,
        degraded: true,
      };
    }

    if (!resolved.key_input) {
      logger.warn?.('[SaleAnnounce] no contact_id, lp_lead_id or lp_prospect_id — nothing to key on');
      return res.status(400).json({ ok: false, error: 'no_identifier' });
    }

    // ── Decide the terminal status before writing ────────────────
    let status = STATUSES.PENDING;
    let errorMessage = null;

    if (!featureEnabled()) {
      status = STATUSES.DISABLED;
      errorMessage = 'SALE_ANNOUNCE_ENABLED is not true';
    } else if (!repOk) {
      status = STATUSES.SKIPPED_INVALID;
      errorMessage = `unusable rep_display_name: "${fields.rep_display_name ?? '(absent)'}"`;
      logger.warn?.(
        `[SaleAnnounce] SKIPPED — rep_display_name is "${fields.rep_display_name ?? '(absent)'}" ` +
        `for contact=${fields.contact_id || '(none)'}. Check the GHL webhook mapping: this field must be ` +
        'Contact . Custom Fields . Rep Display Name, not Last Name. Nothing was posted.',
      );
    } else if (amount == null) {
      status = STATUSES.SKIPPED_INVALID;
      errorMessage = `unusable lp_gross_sale_amount: "${fields.lp_gross_sale_amount ?? '(absent)'}"`;
      logger.warn?.(
        `[SaleAnnounce] SKIPPED — lp_gross_sale_amount is "${fields.lp_gross_sale_amount ?? '(absent)'}" ` +
        `for contact=${fields.contact_id || '(none)'}. Nothing was posted.`,
      );
    }

    const row = {
      lp_lead_id: resolved.lead_id,
      lp_prospect_id: fields.lp_prospect_id,
      ghl_contact_id: fields.contact_id,
      rep_display_name: fields.rep_display_name,
      gross_sale_amount: amount,
      idempotency_key: idempotencyKey(resolved.key_input, amount),
      key_source: resolved.key_source,
      status,
      error_message: errorMessage,
      completed_at: status === STATUSES.PENDING ? null : new Date(now()).toISOString(),
    };

    let claimResult;
    try {
      claimResult = await claim(row, deps);
    } catch (err) {
      logger.error?.(`[SaleAnnounce] claim threw: ${err.message}`);
      return res.status(500).json({ ok: false, error: 'claim_failed' });
    }

    if (claimResult.error && !claimResult.duplicate) {
      logger.error?.(`[SaleAnnounce] claim failed: ${claimResult.error.message}`);
      return res.status(500).json({ ok: false, error: 'claim_failed' });
    }

    if (claimResult.duplicate) {
      logger.log?.(
        `[SaleAnnounce] replay ignored — key already owned by row=${claimResult.row?.id ?? '(unknown)'} ` +
        `key_source=${resolved.key_source}`,
      );
      return res.status(200).json({
        ok: true,
        duplicate: true,
        announcement_id: claimResult.row?.id ?? null,
        status: claimResult.row?.status ?? null,
      });
    }

    const rowId = claimResult.row?.id ?? null;

    // ── Terminal already? Answer and stop. ───────────────────────
    if (status !== STATUSES.PENDING) {
      return res.status(200).json({ ok: true, announcement_id: rowId, status });
    }

    // ── 200 NOW. Compose after. ──────────────────────────────────
    res.status(200).json({ ok: true, announcement_id: rowId, status: STATUSES.PENDING });

    // The callback RETURNS the promise on purpose. setImmediate ignores a
    // return value, so production behaviour is unchanged fire-and-forget — but a
    // test that substitutes `defer` can await the completion instead of racing
    // it. Without this the work is unobservable and every assertion about the
    // finished row is a coin flip.
    defer(() => complete({
      rowId,
      repDisplayName: fields.rep_display_name,
      amount,
      leadId: resolved.lead_id,
      keySource: resolved.key_source,
    }, deps).catch((err) => {
      logger.error?.(`[SaleAnnounce] detached completion rejected for row=${rowId}: ${err.message}`);
    }));

    return undefined;
  };
}

/** Mount the route. Called from src/rest-api.js. */
export function registerSaleAnnouncementRoutes(app, deps = {}) {
  app.post(ROUTE_PATH, makeSaleAnnouncementHandler(deps));
}
