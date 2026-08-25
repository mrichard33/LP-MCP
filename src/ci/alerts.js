/**
 * Call Intelligence — exception alerts — src/ci/alerts.js
 *
 * §10: GroupMe carries EXCEPTIONS ONLY — a review backlog, a spike in sync
 * failures, reconciliation gaps (PR 6). There are deliberately no success
 * alerts. A channel that pings on every healthy call gets muted within a week,
 * and then the one message that mattered is muted too.
 *
 * Alerts are also DEBOUNCED per kind. A pipeline in trouble produces the same
 * condition on every tick; re-sending it every five minutes turns a signal
 * into noise and buries the next distinct problem.
 *
 * §10 also governs content: alerts carry counts and ci_calls ids, never
 * transcript text, note bodies, customer names, or full phone numbers.
 */

import { getConfig } from './config.js';

const LOG = '[CIAlerts]';

/** Backlog above this many review-queue rows is worth a human's attention. */
export const REVIEW_BACKLOG_THRESHOLD = 20;
/** Failed syncs in the recent window that constitute a spike. */
export const SYNC_FAILURE_THRESHOLD = 5;
/** Minimum gap between two alerts OF THE SAME KIND. */
export const ALERT_DEBOUNCE_MS = 60 * 60 * 1000;

/**
 * The kind for "a recording folder held .wav files and we could not read a
 * single filename".
 *
 * ONE kind for the whole condition, not one per folder. A vendor format change
 * hits every campaign at once — 25 folders in a morning — and 25 messages is
 * how a channel gets muted. Debounced like every other kind, so the condition
 * says so once an hour with the first folder that hit it named as the example.
 */
export const UNREADABLE_FOLDER_KIND = 'filename_unparseable';

/** kind → last sent epoch ms. Process-local; a restart re-alerts, which is fine. */
const lastSent = new Map();

export function shouldSend(kind, now = Date.now(), debounceMs = ALERT_DEBOUNCE_MS) {
  const prev = lastSent.get(kind);
  if (prev != null && now - prev < debounceMs) return false;
  return true;
}

export function markSent(kind, now = Date.now()) {
  lastSent.set(kind, now);
}

/** Test-only: forget the debounce state. */
export function __resetAlertsForTest() {
  lastSent.clear();
}

/**
 * Send one exception alert, honouring the debounce and the bot-id gate.
 *
 * Never throws: an alerting failure must not fail the pipeline stage that
 * noticed the problem. The problem is already bad enough without the
 * notification path taking the worker down with it.
 */
export async function sendAlert(kind, text, { cfg = getConfig(), send, now = Date.now() } = {}) {
  if (!cfg.groupmeCiBotId) return { sent: false, reason: 'no_ci_bot_id' };
  if (!shouldSend(kind, now)) return { sent: false, reason: 'debounced' };
  try {
    const sender = send || (await import('../groupme.js')).sendGroupMeMessage;
    const res = await sender(text, { flushNow: true });
    markSent(kind, now);
    return { sent: true, res };
  } catch (err) {
    console.warn(`${LOG} alert '${kind}' failed to send: ${err.message}`);
    return { sent: false, reason: 'send_failed', error: err.message };
  }
}

/**
 * Check the pipeline's exception conditions and alert on any that fire.
 * Returns what it found either way, so /ci/health can report the same numbers
 * without a second query.
 */
export async function checkAndAlert({ db, cfg = getConfig(), send, now = Date.now() } = {}) {
  const findings = {};

  const { count: reviewCount, error: rErr } = await db
    .from('ci_calls')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'review');
  if (rErr) console.warn(`${LOG} review backlog query failed: ${rErr.message}`);
  findings.review_backlog = reviewCount ?? null;

  const since = new Date(now - 60 * 60 * 1000).toISOString();
  const { count: failCount, error: fErr } = await db
    .from('ci_syncs')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'failed')
    .gte('created_at', since);
  if (fErr) console.warn(`${LOG} sync failure query failed: ${fErr.message}`);
  findings.sync_failures_1h = failCount ?? null;

  const alerts = [];
  if ((findings.review_backlog ?? 0) > REVIEW_BACKLOG_THRESHOLD) {
    alerts.push(await sendAlert(
      'review_backlog',
      `⚠️ Call Intelligence: ${findings.review_backlog} calls waiting in review (threshold ${REVIEW_BACKLOG_THRESHOLD}). GET /ci/review`,
      { cfg, send, now },
    ));
  }
  if ((findings.sync_failures_1h ?? 0) >= SYNC_FAILURE_THRESHOLD) {
    alerts.push(await sendAlert(
      'sync_failures',
      `⚠️ Call Intelligence: ${findings.sync_failures_1h} CRM note syncs failed in the last hour (threshold ${SYNC_FAILURE_THRESHOLD}).`,
      { cfg, send, now },
    ));
  }

  return { findings, alerts };
}

/**
 * Alert that a folder full of recordings could not be read at all.
 *
 * ══ WHY THIS ALERT EXISTS ══
 * On 2026-08-22 Five9 began appending a session id to every recording
 * filename. The parser could not read the new shape, so adapter.list() dropped
 * every file and each folder returned the same empty array an empty folder
 * returns. Nothing threw, nothing logged, and 332 calls were parked
 * 'recording_missing' against folders holding hundreds of files. It ran for
 * three days because the only thing watching the archive was the code with the
 * bug in it.
 *
 * ══ WHY IT FIRES ONLY ON ZERO OF N ══
 * A folder where SOME names parse is a curiosity — one odd file, a partial
 * rollout — and paging on it would make this alert noise, which §10 says is
 * the same as no alert at all. A folder holding .wav files where NOT ONE name
 * parses cannot be anything but a format change. That condition is unambiguous
 * and it is the one that costs a day of recordings per day it goes unnoticed.
 *
 * ══ NO FILENAMES IN THE MESSAGE ══
 * §10: alerts carry counts and ci_calls ids, never customer names or full
 * phone numbers. A recording filename BEGINS with the customer's full number,
 * so the sample names stay behind auth — the message points at
 * GET /ci/trace-fetch, which returns them to someone who has a token.
 */
export async function alertUnreadableFolder({
  campaign, dateDir, wav, cfg = getConfig(), send, now = Date.now(),
} = {}) {
  const text =
    `🚨 Call Intelligence: recording filenames are UNREADABLE. `
    + `'${campaign}' / ${dateDir} holds ${wav} .wav file(s) and not one parsed, `
    + `so the fetch stage sees an empty folder and will park every call for that day. `
    + `This is what a Five9 export format change looks like. `
    + `Run GET /ci/trace-fetch?call_id=<id> for the verbatim filenames.`;
  return sendAlert(UNREADABLE_FOLDER_KIND, text, { cfg, send, now });
}

export default {
  checkAndAlert, sendAlert, shouldSend, alertUnreadableFolder,
  REVIEW_BACKLOG_THRESHOLD, SYNC_FAILURE_THRESHOLD, UNREADABLE_FOLDER_KIND,
};
