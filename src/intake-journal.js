/**
 * Intake journal — src/intake-journal.js
 *
 * A write-ahead log for every lead-carrying request, so a lost lead becomes
 * VISIBLE instead of silent.
 *
 * WHY
 * ───
 * Several intake routes ack before doing the work: `res.json(...)` followed by
 * an un-awaited handler. A container kill in between discards the work and
 * nothing anywhere records it — the sender already got its 200, so the request
 * counts as a success in every metric we have. Part A's graceful drain makes
 * that window small; it cannot make it provably zero. An error rate of 0 is
 * not evidence of zero loss. A write-ahead journal is.
 *
 * THE MECHANISM
 * ─────────────
 *   1. Before the handler runs, insert one row: route, payload, headers, query.
 *   2. On res 'finish', stamp the outcome — done (2xx/3xx), rejected (4xx),
 *      failed (5xx) — with the status code and completion time.
 *   3. A connection that closes WITHOUT finishing leaves the row at 'received'.
 *      That row is the orphan signal: a request that started and never ended.
 *
 * FAIL-OPEN IS NON-NEGOTIABLE
 * ───────────────────────────
 * The insert is awaited with a hard 1500ms timeout, and ANY failure — timeout,
 * network, a missing table — logs a warning and calls next() regardless. An
 * observability layer that can drop a lead is worse than no observability
 * layer, so a lead is never blocked, and never delayed past 1.5s, by this file.
 *
 * ONE ALERT PER INCIDENT, NOT A STREAM AND NOT A ONE-SHOT
 * ───────────────────────────────────────────────────────
 * The sweeper routes through the existing edge-triggered alert state
 * (src/alert-state.js), using its SET-valued API: one condition key per
 * orphaned row under the prefix 'intake_journal:unfinished:'. Each sweep
 * claims the whole set and announces ONE card naming only the rows that have
 * never been announced. Already-announced rows stay silent for as long as they
 * sit in the backlog; new ones still get a card. Never one message per row,
 * never a repeat for the same row. Mark's standing rule.
 *
 * This replaced a single-key version that could only ever fire once — see the
 * ALERT_PREFIX comment below for why that was a real defect, not a nicety.
 *
 * MODES (INTAKE_JOURNAL_MODE)
 * ───────────────────────────
 *   off    — middleware and sweeper are no-ops.
 *   shadow — rows are written, the sweeper logs its summary, NOTHING is sent.
 *            THIS IS THE DEFAULT and how the feature ships.
 *   live   — rows are written and the sweeper alerts on the firing edge.
 */

import supabase from './supabase.js';
import { sendGroupMeMessage } from './groupme.js';
import { claimAlertConditionSet, confirmAlertSend } from './alert-state.js';
import { trackBackground, isShuttingDown } from './graceful-shutdown.js';

const TABLE = 'intake_journal';

/**
 * Alert-key namespace. ONE KEY PER ORPHANED ROW, not one key for the condition.
 *
 * v1.1 (2026-09-13) — the original used a single key whose `active` was
 * `orphans > 0`. That was wrong in a way the 24h shadow soak proved:
 * orphan rows are kept for 90 days, so the count NEVER returns to zero once
 * anything lands in it. A single edge-triggered key would therefore fire once,
 * then stay 'firing' forever — and reportAlertCondition is deliberately silent
 * while firing, so no later incident could ever be announced. One alert, then
 * permanent deafness.
 *
 * Measured on the real soak: 30 unfinished rows accrued over 48h and the count
 * never once fell to 0. Going live on the old logic would have sent exactly one
 * card — reading "30 lead requests started and never finished", which also
 * badly overstated it (all 26 appointment rows had completed their work; only
 * the HTTP ack was lost) — and then nothing, ever again.
 *
 * So each orphan row is its own condition, and claimAlertConditionSet hands
 * back only the rows never announced before. One card per sweep naming ONLY
 * what is new; silence when nothing is new; a fresh card when more appear.
 */
const ALERT_PREFIX = 'intake_journal:unfinished:';

/** off | shadow | live. Anything unrecognized reads as shadow — the safe mode. */
export function journalMode() {
  const m = String(process.env.INTAKE_JOURNAL_MODE || 'shadow').toLowerCase().trim();
  return ['off', 'shadow', 'live'].includes(m) ? m : 'shadow';
}

/** Hard ceiling on how long a lead may wait on the journal insert. */
const INSERT_TIMEOUT_MS = parseInt(process.env.INTAKE_JOURNAL_INSERT_TIMEOUT_MS || '1500', 10);

/** Age at which an unfinished row counts as orphaned. */
const ORPHAN_AFTER_MIN = parseInt(process.env.INTAKE_ORPHAN_AFTER_MIN || '10', 10);

/** Postgres jsonb is happy far past this; the cap exists to bound write cost. */
const MAX_BODY_BYTES = 256 * 1024;

const SWEEP_FIRST_DELAY_MS = 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Rows whose work demonstrably completed are cheap to forget. */
const DONE_RETENTION_DAYS = 30;
/** Anything that did NOT cleanly complete is evidence — keep it far longer. */
const OPEN_RETENTION_DAYS = 90;

/**
 * The lead-carrying routes, matching the Part A ack-then-process inventory.
 *
 * DELIBERATELY ABSENT:
 *   /webhooks/ghl-tag  — already durable via ghl_tag_inbox + startGhlTagProcessor
 *                        (40,176 events / 7 days, 0 stuck). At ~40k/week it would
 *                        also dominate the write load for no added safety.
 *   /mcp, /sse, /messages, /health, /n8n/site/collect, /board/*, /admin/*, /sync/*
 *                      — not lead intake.
 */
export const DEFAULT_ROUTES = [
  '/webhook/lp',
  '/webhook/ghl/contact-created',
  '/webhook/ghl/appointment',
  '/webhook/ghl/reply',
  '/webhook/ghl/entry',
  '/webhook/ghl/branch-fired',
  '/webhook/ghl/canvassing-intake',
  '/webhook/ghl/lp-addlead-proxy',
  '/webhook/ghl/set-lp-appointment',
  '/webhook/ghl/book-appointment',
  '/webhook/lp-lead-refresh',
  '/webhook/five9-event',
  '/webhooks/canvassing-lead',
  '/webhooks/canvass-confirmation',
  '/webhooks/affiliate-lead',
  '/ghl/inbound-message',
  '/api/lookup/lp-lead-and-update-ghl-contact',
  '/n8n/leadgurus/daily-pull',
  '/n8n/leadgurus/backfill',
];

/**
 * Comma-separated override, else the built-in list.
 *
 * Memoized on the raw env string rather than computed once at import, so a
 * test (or a future runtime toggle) can change the list without a reload while
 * the hot path still does one Map lookup per request instead of rebuilding a
 * Set on every POST.
 */
let _routesCache = { raw: null, set: null };
export function journalRoutes() {
  const raw = process.env.INTAKE_JOURNAL_ROUTES || '';
  if (_routesCache.raw === raw && _routesCache.set) return _routesCache.set;
  const set = raw.trim()
    ? new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
    : new Set(DEFAULT_ROUTES);
  _routesCache = { raw, set };
  return set;
}

// ─── Secret stripping ────────────────────────────────────────────────
//
// The journal stores raw payloads so a lost lead can be re-submitted by hand.
// That makes it a place secrets would otherwise come to rest, so they are
// removed on the way in — never redacted after the fact.

const SECRET_HEADER_RE = /authorization|secret|token|cookie|signature|api[-_]?key/i;
const SECRET_QUERY_KEYS = new Set(['secret', 'token', 'key', 'api_key']);

export function stripHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (SECRET_HEADER_RE.test(k)) continue;
    out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

export function stripQuery(query = {}) {
  const out = {};
  for (const [k, v] of Object.entries(query || {})) {
    if (SECRET_QUERY_KEYS.has(String(k).toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Serialize the body, replacing anything over MAX_BODY_BYTES with a marker.
 * A body that cannot be serialized at all (a cycle, a BigInt) must not take
 * the request down with it.
 */
export function prepareBody(body) {
  if (body === undefined || body === null) return { body: null, truncated: false };
  let size;
  try {
    size = Buffer.byteLength(JSON.stringify(body) ?? 'null', 'utf8');
  } catch {
    return { body: { _unserializable: true }, truncated: true };
  }
  if (size > MAX_BODY_BYTES) return { body: { _truncated: true, size }, truncated: true };
  return { body, truncated: false };
}

/** Reject a hung insert rather than let it hold a lead. */
function withTimeout(promise, ms, label) {
  let timer;
  const ceiling = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([Promise.resolve(promise), ceiling]).finally(() => clearTimeout(timer));
}

function statusForCode(code) {
  if (code >= 500) return 'failed';
  if (code >= 400) return 'rejected';
  return 'done';
}

/**
 * Write-ahead middleware. Mount immediately after app.use(trackInflight).
 *
 * @param {object} [deps]
 * @param {object} [deps.client]  Injectable supabase (tests).
 * @param {Function} [deps.track] Injectable background tracker (tests).
 */
export function intakeJournal({ client: clientArg, track = trackBackground } = {}) {
  return async function intakeJournalMiddleware(req, res, next) {
    if (journalMode() === 'off') return next();
    if (req.method !== 'POST') return next();
    if (!journalRoutes().has(req.path)) return next();

    const client = clientArg ?? supabase;
    if (!client) return next();

    const { body, truncated } = prepareBody(req.body);

    let id = null;
    try {
      const { data, error } = await withTimeout(
        client.from(TABLE).insert({
          route: req.path,
          method: req.method,
          deployment_id: process.env.RAILWAY_DEPLOYMENT_ID || null,
          headers: stripHeaders(req.headers),
          query: stripQuery(req.query),
          body,
          body_truncated: truncated,
          status: 'received',
        }).select('id').single(),
        INSERT_TIMEOUT_MS,
        'intake_journal insert',
      );
      if (error) throw new Error(error.message);
      id = data?.id ?? null;
    } catch (err) {
      // FAIL-OPEN. The lead proceeds; we simply have no journal row for it.
      console.warn(`[IntakeJournal] insert failed for ${req.path} (fail-open): ${err.message}`);
      return next();
    }

    if (id != null) {
      let stamped = false;
      res.on('finish', () => {
        if (stamped) return;
        stamped = true;
        const code = res.statusCode;
        // Tracked so Part A's drain waits for it — otherwise a deploy during
        // the stamp leaves a completed request looking like an orphan.
        track(
          Promise.resolve(
            client.from(TABLE).update({
              status: statusForCode(code),
              response_status: code,
              completed_at: new Date().toISOString(),
            }).eq('id', id),
          ).then(({ error } = {}) => {
            if (error) console.warn(`[IntakeJournal] stamp failed for id=${id}: ${error.message}`);
          }).catch((err) => console.warn(`[IntakeJournal] stamp threw for id=${id}: ${err.message}`)),
        );
      });
      // NOTE: no 'close' handler on purpose. A close without a finish is
      // exactly the orphan this table exists to surface, so the row is left
      // at 'received' for the sweeper to find.
    }

    return next();
  };
}

// ─── Sweeper ─────────────────────────────────────────────────────────

/**
 * One sweep: count orphans and recent failures, then drive the edge-triggered
 * alert. Exported so tests can run it directly with a stub client.
 *
 * @returns {Promise<{orphans:number, failures:number, routes:string[], oldest:string|null, action:string}>}
 */
/**
 * The status a row takes when its container disappeared mid-request.
 *
 * NOTE (2026-09-16): the `status` column carries a CHECK constraint that must
 * list this value. The first release of the reclassifier shipped without the
 * matching DDL, so every UPDATE was rejected and swallowed by the fail-open
 * catch — the feature looked live and wrote nothing. isStatusConstraintError()
 * below exists so that can never be a silent outcome again.
 */
const INTERRUPTED = 'interrupted';

/** Named so the remediation log can print the exact constraint to alter. */
const STATUS_CHECK_CONSTRAINT = 'intake_journal_status_check';

/** Postgres check_violation. */
const PG_CHECK_VIOLATION = '23514';

/** One error line per process, not one per sweep. */
let warnedStatusConstraint = false;

/** Is this the schema rejecting our status value, rather than a transient fault? */
export function isStatusConstraintError(err) {
  if (!err) return false;
  if (err.code === PG_CHECK_VIOLATION) return true;
  return String(err.message || '').includes(STATUS_CHECK_CONSTRAINT);
}

/** The deployment this process belongs to, or null when unset (local dev). */
export function currentDeploymentId() {
  return process.env.RAILWAY_DEPLOYMENT_ID || null;
}

/**
 * Retire orphans left behind by containers that no longer exist.
 *
 * WHY (2026-09-16): two `intake_journal:unfinished:` keys had been firing since
 * 2026-09-14 and could never clear, because orphan rows are retained 90 days
 * and the condition is keyed per row. Looking at the data, the orphans were not
 * stalls: 75 rows spread across 19 DIFFERENT deployments, one bad deploy alone
 * accounting for 27, and only 2 on the container then running. They are
 * requests that were in flight when a container was replaced — concentrated on
 * the slowest routes (/webhook/ghl/set-lp-appointment 13.2%, contact-created
 * 4.5%, versus 0.4% on the fast ones), exactly as you would expect.
 *
 * That is the alarm firing on the healthy case, which CLAUDE.md names as how a
 * muted alarm starts. So classify instead of thresholding, using the outcome
 * this codebase already has for it: runJob treats `interrupted` (a deploy
 * killed the pass) as distinct from `failed`, and a pass that could not tell as
 * `unknown`. A row whose container is gone can never finish; its outcome is
 * unknowable, not failed, and unknowable must not page.
 *
 * AT STARTUP, NOT AT SHUTDOWN. A hard kill never runs shutdown code, so a
 * drain-time write would miss precisely the cases that produce these rows. On
 * boot, anything still 'received' from another deployment is by definition
 * interrupted.
 *
 * FAILS OPEN: any error logs and returns; a journal that cannot reclassify must
 * never block boot.
 */
export async function reclassifyInterruptedRows({ client: clientArg, deploymentId } = {}) {
  if (journalMode() === 'off') return { reclassified: 0, action: 'disabled' };
  const client = clientArg ?? supabase;
  if (!client) return { reclassified: 0, action: 'no_client' };

  const current = deploymentId !== undefined ? deploymentId : currentDeploymentId();
  // With no deployment id we cannot tell our own rows from a dead container's,
  // and guessing would retire live ones. Do nothing — that is the safe read.
  if (!current) return { reclassified: 0, action: 'no_deployment_id' };

  try {
    const { data, error } = await client.from(TABLE)
      .update({ status: INTERRUPTED })
      .eq('status', 'received')
      .or(`deployment_id.is.null,deployment_id.neq.${current}`)
      .select('id');
    if (error) {
      const e = new Error(error.message);
      e.code = error.code;          // 23514 on a CHECK violation
      throw e;
    }
    const n = (data || []).length;
    if (n > 0) {
      console.log(
        `[IntakeJournal] reclassified ${n} orphan(s) from prior deployments as interrupted `
        + `(container gone — outcome unknowable, not failed)`,
      );
    }
    return { reclassified: n, action: 'ok' };
  } catch (err) {
    // A CHECK-constraint rejection is not a transient fault — it means the
    // column does not accept 'interrupted' yet and NEVER will until the schema
    // changes. Shipped 2026-09-16 without that DDL, so every pass failed
    // silently behind the fail-open catch and no row was ever reclassified.
    // That is the failure this module exists to prevent, so name it and name
    // the remedy rather than logging it as one more non-blocking warning.
    if (isStatusConstraintError(err)) {
      if (!warnedStatusConstraint) {
        warnedStatusConstraint = true;
        console.error(
          `[IntakeJournal] SCHEMA BLOCKED: '${INTERRUPTED}' is not permitted by `
          + `${STATUS_CHECK_CONSTRAINT}, so orphans from dead containers cannot be `
          + `reclassified. Sweep scoping still suppresses the false alarm, but rows stay `
          + `labelled 'received'. Fix (Supabase dashboard, DDL): ALTER TABLE ${TABLE} `
          + `DROP CONSTRAINT ${STATUS_CHECK_CONSTRAINT}, ADD CONSTRAINT `
          + `${STATUS_CHECK_CONSTRAINT} CHECK (status IN ('received','done','rejected',`
          + `'failed','${INTERRUPTED}'));`,
        );
      }
      return { reclassified: 0, action: 'schema_blocked' };
    }
    console.warn(`[IntakeJournal] reclassify failed (non-blocking): ${err.message}`);
    return { reclassified: 0, action: 'failed' };
  }
}

export async function sweepIntakeJournal({ client: clientArg, send = sendGroupMeMessage, nowMs } = {}) {
  const mode = journalMode();
  const idle = { orphans: 0, failures: 0, routes: [], oldest: null, action: 'skipped' };
  if (mode === 'off') return idle;

  // A shutting-down container must not open new work, and must never clear a
  // live alert on the strength of a sweep it could not finish.
  if (isShuttingDown()) return { ...idle, action: 'shutting_down' };

  const client = clientArg ?? supabase;
  if (!client) return idle;

  const now = nowMs ?? Date.now();
  const orphanCutoff = new Date(now - ORPHAN_AFTER_MIN * 60 * 1000).toISOString();
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  let orphanRows = [];
  let failureCount = 0;
  try {
    // Scope to THIS deployment. A 'received' row from a dead container is an
    // interrupted request, not a stall, and reclassifyInterruptedRows() retires
    // those at boot; this filter is the belt to that braces, so a reclassify
    // that failed cannot resurrect the old false alarm.
    let orphanQuery = client.from(TABLE)
      .select('id, route, received_at')
      .eq('status', 'received')
      .lt('received_at', orphanCutoff)
      .gt('received_at', weekAgo);
    const deployId = currentDeploymentId();
    if (deployId) orphanQuery = orphanQuery.eq('deployment_id', deployId);
    const { data, error } = await orphanQuery
      .order('received_at', { ascending: true })
      .limit(500);
    if (error) throw new Error(error.message);
    orphanRows = data || [];

    const { data: failed, error: failErr } = await client.from(TABLE)
      .select('id')
      .eq('status', 'failed')
      .gt('received_at', dayAgo)
      .limit(500);
    if (failErr) throw new Error(failErr.message);
    failureCount = (failed || []).length;
  } catch (err) {
    // A failed read is NOT evidence of health. Report nothing and touch no
    // alert state — clearing here would be a false all-clear.
    console.warn(`[IntakeJournal] sweep read failed (no alert change): ${err.message}`);
    return { ...idle, action: 'read_failed' };
  }

  const orphans = orphanRows.length;
  const routes = [...new Set(orphanRows.map((r) => r.route))].sort();
  const oldest = orphanRows.length ? orphanRows[0].received_at : null;

  const summary = orphans > 0
    ? `[IntakeJournal] ${orphans} unfinished intake request(s) — routes=[${routes.join(', ')}] `
      + `oldest=${oldest} failures_24h=${failureCount} — payloads saved in intake_journal`
    : `[IntakeJournal] sweep clean (0 unfinished, failures_24h=${failureCount})`;

  if (mode === 'shadow') {
    // Shadow logs the same line it would have sent. Nothing leaves the process.
    console.log(`${summary} [shadow — not alerting]`);
    return { orphans, failures: failureCount, routes, oldest, action: 'shadow' };
  }

  // LIVE. Claim the whole orphan set at once; the claim returns only the rows
  // that have never been announced. Everything already announced stays silent
  // however long it sits in the backlog, and a genuinely new orphan still gets
  // a card — which is the property the single-key version could not provide.
  const claim = await claimAlertConditionSet({
    prefix: ALERT_PREFIX,
    activeKeys: orphanRows.map((r) => `${ALERT_PREFIX}${r.id}`),
    label: 'Intake journal — unfinished lead request',
    detail: `routes=[${routes.join(',')}] oldest=${oldest}`,
    client,
    nowMs: now,
  });

  // ok:false is "I could not tell" — the claim layer degraded. Announce
  // nothing rather than risk a duplicate or a bogus card.
  if (!claim.ok) {
    console.warn(`[IntakeJournal] alert claim unavailable (${claim.reason}) — not alerting this sweep`);
    return { orphans, failures: failureCount, routes, oldest, action: 'claim_failed' };
  }

  if (claim.newlyFiring.length === 0) {
    console.log(`${summary} [no new unfinished requests — silent]`);
    return { orphans, failures: failureCount, routes, oldest, action: 'silent', newly: 0 };
  }

  // Name only what is new. The backlog total rides along as context so the
  // card is honest about scale without implying all of it just happened.
  const newIds = new Set(claim.newlyFiring.map((k) => k.slice(ALERT_PREFIX.length)));
  const newRows = orphanRows.filter((r) => newIds.has(String(r.id)));
  const newRoutes = [...new Set(newRows.map((r) => r.route))].sort();
  const newOldest = newRows.length ? newRows[0].received_at : oldest;

  const text =
    `🚨 SYSTEM — ${newRows.length} new lead request(s) started and never finished.\n`
    + `Routes: ${newRoutes.join(', ')}\n`
    + `Oldest of these: ${newOldest}\n`
    + `Unfinished backlog: ${orphans} total | failures (24h): ${failureCount}\n`
    + `Payloads saved in intake_journal — the request did not complete, but check\n`
    + `whether the work landed anyway before treating these as lost.`;

  let sent = false;
  try {
    const r = await send(text, { noDedup: true });
    sent = r?.sent !== false;
  } catch (err) {
    console.error(`[IntakeJournal] alert send failed: ${err.message}`);
  }

  if (sent) {
    await confirmAlertSend(claim.newlyFiring, { client, nowMs: now });
  } else {
    // The claim already marked these announced, so without this they would
    // never be retried — a silently swallowed page. Release them so the next
    // sweep re-claims and tries again: bounded at one attempt per sweep, the
    // same posture alert-state.js takes when a send fails mid-transition.
    await Promise.resolve(
      client.from('alert_conditions').delete().in('alert_key', claim.newlyFiring),
    ).catch((err) => console.warn(`[IntakeJournal] claim release failed: ${err.message}`));
  }

  console.log(`${summary} [alerted on ${newRows.length} new]`);
  return {
    orphans, failures: failureCount, routes, oldest,
    action: sent ? 'fired' : 'send_failed', newly: newRows.length,
  };
}

/**
 * Daily retention. Completed rows are forgotten after 30 days; anything that
 * did not cleanly complete is kept for 90, because those are the rows that
 * answer "did we lose a lead".
 */
export async function pruneIntakeJournal({ client: clientArg, nowMs } = {}) {
  const client = clientArg ?? supabase;
  if (!client || journalMode() === 'off') return { done: 0, open: 0, skipped: true };

  const now = nowMs ?? Date.now();
  const doneCutoff = new Date(now - DONE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const openCutoff = new Date(now - OPEN_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  try {
    const { error: e1 } = await client.from(TABLE)
      .delete().eq('status', 'done').lt('received_at', doneCutoff);
    if (e1) throw new Error(e1.message);

    const { error: e2 } = await client.from(TABLE)
      .delete().in('status', ['received', 'failed', 'rejected', 'interrupted'])
      .lt('received_at', openCutoff);
    if (e2) throw new Error(e2.message);
  } catch (err) {
    console.warn(`[IntakeJournal] retention prune failed (ignored): ${err.message}`);
    return { skipped: false, error: err.message };
  }
  return { skipped: false };
}

let sweepTimer = null;
let pruneTimer = null;

export function startIntakeJournalSweeper() {
  const mode = journalMode();
  if (mode === 'off') {
    console.log('[IntakeJournal] disabled (INTAKE_JOURNAL_MODE=off)');
    return;
  }
  console.log(
    `[IntakeJournal] sweeper starting (mode=${mode}, orphan_after=${ORPHAN_AFTER_MIN}m, `
    + `routes=${journalRoutes().size})`,
  );

  const tick = () => {
    sweepIntakeJournal().catch((e) => console.error(`[IntakeJournal] sweep error: ${e.message}`));
  };
  setTimeout(() => {
    // Retire prior-deployment orphans BEFORE the first sweep, so the sweep sees
    // only rows this container is actually responsible for.
    reclassifyInterruptedRows()
      .catch((e) => console.warn(`[IntakeJournal] reclassify error: ${e.message}`))
      .finally(tick);
    sweepTimer = setInterval(tick, SWEEP_INTERVAL_MS);
  }, SWEEP_FIRST_DELAY_MS);

  pruneTimer = setInterval(() => {
    pruneIntakeJournal().catch((e) => console.error(`[IntakeJournal] prune error: ${e.message}`));
  }, RETENTION_INTERVAL_MS);
}

export function stopIntakeJournalSweeper() {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
}

// ─── Admin route ─────────────────────────────────────────────────────

/**
 * GET /admin/intake-journal/summary — counts by route x status for 24h and 7d,
 * plus the 20 most recent non-done rows.
 *
 * NEVER returns bodies or headers. The stored payloads are lead PII and the
 * point of this route is triage, not export — read the table directly for a
 * body you actually need to re-submit.
 */
export function registerIntakeJournalRoutes(app, authenticate, { client: clientArg } = {}) {
  app.get('/admin/intake-journal/summary', authenticate, async (req, res) => {
    const client = clientArg ?? supabase;
    if (!client) return res.status(503).json({ error: 'no_database' });

    const now = Date.now();
    const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

    try {
      const { data: rows, error } = await client.from(TABLE)
        .select('route, status, received_at')
        .gt('received_at', since7d)
        .limit(10000);
      if (error) throw new Error(error.message);

      const tally = (list) => {
        const out = {};
        for (const r of list) {
          out[r.route] ??= {};
          out[r.route][r.status] = (out[r.route][r.status] || 0) + 1;
        }
        return out;
      };

      const all = rows || [];
      const { data: recent, error: recErr } = await client.from(TABLE)
        .select('id, route, status, response_status, received_at')
        .neq('status', 'done')
        .order('received_at', { ascending: false })
        .limit(20);
      if (recErr) throw new Error(recErr.message);

      return res.json({
        mode: journalMode(),
        orphan_after_min: ORPHAN_AFTER_MIN,
        routes_watched: journalRoutes().size,
        last_24h: tally(all.filter((r) => r.received_at > since24h)),
        last_7d: tally(all),
        recent_non_done: recent || [],
      });
    } catch (err) {
      console.error(`[IntakeJournal] summary failed: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  });

  console.log('[IntakeJournal] route registered: GET /admin/intake-journal/summary');
}

export default {
  intakeJournal,
  startIntakeJournalSweeper,
  stopIntakeJournalSweeper,
  sweepIntakeJournal,
  pruneIntakeJournal,
  registerIntakeJournalRoutes,
  journalMode,
  journalRoutes,
  reclassifyInterruptedRows,
  currentDeploymentId,
  isStatusConstraintError,
  DEFAULT_ROUTES,
};
