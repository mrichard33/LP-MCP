/**
 * DNC-lift result → Slack, posted by the SERVER — src/consent/dnc-lift-report.js
 *
 * 2026-10-02. Mark approved 41 #dnc-lift-approval cards in two minutes. The
 * decision route ran each batch while n8n held the HTTP request open; under
 * that load every batch took 2–2.5 minutes, n8n's 120s timeout fired on 40 of
 * 41, and those cards sat on "⏳ Lifting" with no thread reply, although every
 * lift had in fact gone through (GHL, Five9, consent; LP is a known manual
 * step). So the route now answers n8n at once (202) and the result is posted
 * from here, when the work is done:
 *   - the card is updated in place (chat.update), buttons already gone;
 *   - the per-system result goes into the card's thread (postToSlack).
 * A step the executor is still retrying is shown as "⏳ retrying"; the sweep
 * below posts one follow-up once it settles, and corrects the request's
 * status, which used to stay 'failed' after a retry succeeded.
 *
 * Only rows marked batch_result.report_mode = 'server' are reported here. A
 * click from the older n8n flow (which prints the result itself) is never
 * double-posted.
 */

import supabase from '../supabase.js';
import { postToSlack, updateSlackMessage } from '../slack.js';
import { summarizeBatch, lpClearOutcome } from './dnc-lift-decision.js';
import { runJob } from '../job-runner.js';

export const REPORT_MODE_SERVER = 'server';
// A step still retrying after this long is reported as it stands.
export const REPORT_FINAL_AFTER_MS = 2 * 60 * 60 * 1000;
export const REPORT_LOOKBACK_MS = 48 * 60 * 60 * 1000;
// The sweep leaves a just-finished request to the background report.
export const SWEEP_MIN_AGE_MS = 2 * 60 * 1000;
const ACTIVE = new Set(['pending', 'executing']);
const MARK_SLACK_ID = 'U0BU7TZPY82';

const LABEL = { ghl: 'GHL', lp: 'LP', five9: 'Five9', consent: 'Consent record', audit: 'Audit event' };
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** agent_actions rows → the executor's result shape. Pure. */
export function resultsFromRows(rows) {
  return (rows || []).map((r) => ({
    action_id: r.id,
    action_type: r.action_type,
    status: r.status,
    result: r.execution_result || null,
    error: r.error_message || null,
  }));
}

/**
 * Per-system state for the thread: failed > retrying > done. A row the
 * executor will retry is 'retrying', not 'failed' — 37 of 41 GHL steps on
 * 2026-10-02 timed out once and completed on the retry. Pure.
 */
export function systemRollup(results) {
  const { actions } = summarizeBatch(results);
  const systems = {};
  for (const a of actions) {
    const cur = systems[a.system] || { status: 'done', errors: [] };
    if (ACTIVE.has(a.status)) {
      if (cur.status === 'done') cur.status = 'retrying';
    } else if (a.outcome === 'failed') {
      cur.status = 'failed';
      cur.errors.push(`${a.action_type}: ${a.error || a.status}`);
    }
    systems[a.system] = cur;
  }
  return systems;
}

/**
 * Card headline + thread text. Pure. The LP row is the manual-clear line
 * whenever LP still shows DNC, and an LP failure that is only the known broken
 * clear does NOT page Mark — 41 pings for one expected step is noise.
 */
export function formatLiftThread({ decision, slackUserId, decidedAtIso, systems, smsWarning, lpManual, lpProspectId, final, escalateId = MARK_SLACK_ID }) {
  const at = decidedAtIso
    ? new Date(decidedAtIso).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) + ' ET'
    : '';
  const by = slackUserId ? `<@${slackUserId}>` : 'someone';
  const approve = decision === 'approve';
  const retrying = Object.values(systems || {}).some((s) => s.status === 'retrying');
  let headline = approve ? `✅ Approved by ${by}${at ? ` at ${at}` : ''}` : `⛔ Kept blocked by ${by}${at ? ` at ${at}` : ''}`;
  if (retrying && !final) headline += ' — finishing a few steps';

  const lines = [approve ? '*Lift result*' : '*Keep-blocked result*'];
  let hardFailure = false;
  for (const key of Object.keys(LABEL)) {
    const s = systems?.[key];
    if (!s) continue;
    if (key === 'lp' && approve && lpManual) {
      lines.push(`• LP: :warning: still shows DNC — clear it manually in Lead Perfection (${lpProspectId ? `Prospect #${esc(lpProspectId)}` : 'find the prospect by phone'})`);
      continue;
    }
    if (s.status === 'failed') {
      hardFailure = true;
      lines.push(`• ${LABEL[key]}: ❌ failed — ${esc((s.errors || []).join('; ').slice(0, 400))}`);
    } else if (s.status === 'retrying') {
      lines.push(`• ${LABEL[key]}: ⏳ retrying automatically — an update will follow here`);
    } else {
      lines.push(`• ${LABEL[key]}: ✅ done`);
    }
  }
  if (smsWarning) lines.push(`:warning: ${smsWarning}`);
  if (hardFailure) lines.push(`<@${escalateId}> something did not complete — please check this lead.`);
  return { headline, threadText: lines.join('\n'), hardFailure, retrying };
}

/** The card the approver clicked, minus buttons, plus the headline. Pure. */
export function buildResultCard({ cardBlocks, reviewPayload, requestId, headline }) {
  const base = Array.isArray(cardBlocks) && cardBlocks.length
    ? cardBlocks.filter((b) => b && b.type !== 'actions' && !(b.type === 'context' && /⏳|Lifting|Keeping blocked/.test(JSON.stringify(b))))
    : [
      { type: 'header', text: { type: 'plain_text', text: 'DNC lift review' } },
      { type: 'section', text: { type: 'mrkdwn', text: [
        `*${esc(reviewPayload?.contact_name || 'Unknown')}* · ${reviewPayload?.phone_full ? `*${esc(reviewPayload.phone_full)}*` : `phone ending *${esc(reviewPayload?.phone_last4 || '????')}*`}`,
        reviewPayload?.ghl_contact_url ? `<${reviewPayload.ghl_contact_url}|Open in GHL>` : '',
      ].filter(Boolean).join('\n') } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `request ${esc(requestId)}` }] },
    ];
  return [...base, { type: 'context', elements: [{ type: 'mrkdwn', text: headline }] }];
}

async function defaultFallbackChannel(db, env) {
  if (env.SLACK_CHANNEL_DNC_LIFT) return String(env.SLACK_CHANNEL_DNC_LIFT).trim();
  const { data } = await db.from('dnc_lift_requests').select('batch_result')
    .not('batch_result->>slack_channel', 'is', null)
    .order('decided_at', { ascending: false }).limit(1);
  return (data || [])[0]?.batch_result?.slack_channel || null;
}

/**
 * Post (or follow up on) one decided request's result. Idempotent through
 * batch_result.slack_reported_at / slack_report_final. Never throws.
 */
export async function reportDncLiftResult(requestId, deps = {}) {
  const env = deps.env || process.env;
  const db = deps.supabase || supabase;
  const now = deps.now ? deps.now() : Date.now();
  const post = deps.postToSlack || postToSlack;
  const update = deps.updateSlackMessage || updateSlackMessage;
  try {
    const { data: row, error } = await db.from('dnc_lift_requests').select('*').eq('request_id', requestId).maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!row || !row.decision) return { ok: true, skipped: 'not_decided' };
    const br = row.batch_result || {};
    if (br.report_mode !== REPORT_MODE_SERVER) return { ok: true, skipped: 'not_server_reported' };
    if (br.slack_report_final) return { ok: true, skipped: 'already_final' };

    const acts = await db.from('agent_actions')
      .select('id, action_type, status, execution_result, error_message')
      .eq('batch_id', requestId);
    if (acts.error) return { ok: false, error: acts.error.message };
    if (!(acts.data || []).length) return { ok: true, skipped: 'no_actions' };

    const results = resultsFromRows(acts.data);
    const systems = systemRollup(results);
    const retrying = Object.values(systems).some((s) => s.status === 'retrying');
    const aged = now - Date.parse(row.decided_at || row.completed_at || now) > REPORT_FINAL_AFTER_MS;
    const final = !retrying || aged;
    // Already told the approver; nothing new until the retries settle.
    if (br.slack_reported_at && !final) return { ok: true, skipped: 'still_retrying' };

    const channel = br.slack_channel || (await (deps.fallbackChannel || defaultFallbackChannel)(db, env));
    if (!channel || !row.slack_ts) return { ok: false, error: 'no_channel_or_ts' };

    const lp = row.decision === 'approve' ? lpClearOutcome(results, { env, reviewPayload: row.review_payload }) : {};
    const fmt = formatLiftThread({
      decision: row.decision,
      slackUserId: row.slack_user_id,
      decidedAtIso: row.decided_at,
      systems,
      smsWarning: br.sms_warning || null,
      lpManual: !!lp.lp_manual_clear_required,
      lpProspectId: lp.lp_prospect_id || null,
      final,
    });

    const card = buildResultCard({ cardBlocks: br.card_blocks, reviewPayload: row.review_payload, requestId, headline: fmt.headline });
    const upd = await update(channel, row.slack_ts, fmt.headline, { blocks: card });
    const text = br.slack_reported_at ? `*Update:* every step has now finished.\n${fmt.threadText}` : fmt.threadText;
    const reply = await post(text, channel, { threadTs: row.slack_ts });
    if (!reply.ok) {
      console.warn(`[DncLiftReport] thread reply failed for ${requestId}: ${reply.error}`);
      return { ok: false, error: `thread reply: ${reply.error}`, card_updated: upd.ok };
    }

    // A known-broken LP clear (lpManual) is not a reason to call the lift failed.
    const hard = Object.entries(systems).some(([k, s]) => s.status === 'failed' && !(k === 'lp' && lp.lp_manual_clear_required));
    const status = !final ? row.status
      : hard ? 'failed' : (row.decision === 'approve' ? 'approved' : 'kept_blocked');
    await db.from('dnc_lift_requests').update({
      status,
      batch_result: {
        ...br,
        systems,
        any_failed: hard,
        ...lp,
        slack_reported_at: br.slack_reported_at || new Date(now).toISOString(),
        slack_report_final: final,
      },
    }).eq('request_id', requestId);
    console.log(`[DncLiftReport] ${final ? 'final' : 'interim'} result posted for ${requestId} (card ${upd.ok ? 'updated' : `not updated: ${upd.error}`})`);
    return { ok: true, posted: true, final, card_updated: upd.ok };
  } catch (err) {
    console.warn(`[DncLiftReport] ${requestId} failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Safety net, every 5 minutes: any server-reported request decided in the
 * last 48h whose result is not final — never posted (a deploy killed the
 * background run), or posted while steps were still retrying.
 */
export async function runDncLiftReportSweep(deps = {}) {
  const db = deps.supabase || supabase;
  const now = deps.now ? deps.now() : Date.now();
  const since = new Date(now - REPORT_LOOKBACK_MS).toISOString();
  const { data, error } = await db.from('dnc_lift_requests')
    .select('request_id, status, decided_at, completed_at, batch_result')
    .gte('decided_at', since)
    .neq('status', 'processing')
    .eq('batch_result->>report_mode', REPORT_MODE_SERVER)
    .limit(200);
  if (error) return { ok: false, error: error.message };
  const due = (data || []).filter((r) => !r.batch_result?.slack_report_final
    && now - Date.parse(r.completed_at || r.decided_at) >= SWEEP_MIN_AGE_MS);
  let posted = 0;
  const errors = [];
  for (const r of due) {
    const out = await (deps.report || reportDncLiftResult)(r.request_id, deps);
    if (out.posted) posted += 1;
    else if (!out.ok) errors.push(`${r.request_id}: ${out.error}`);
  }
  return { ok: errors.length === 0, checked: due.length, posted, errors };
}

let timer = null;
let running = false;
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
export const JOB_ID = 'dnc-lift-report-sweep';

export function startDncLiftReportScheduler() {
  if (timer) return timer;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { value: res } = await runJob(JOB_ID, () => runDncLiftReportSweep());
      if (res?.checked) console.log(`[DncLiftReport] sweep: checked=${res.checked} posted=${res.posted}${res.errors?.length ? ` errors: ${res.errors.slice(0, 3).join('; ')}` : ''}`);
    } catch (err) {
      console.error(`[DncLiftReport] sweep threw: ${err.message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  const first = setTimeout(tick, 90 * 1000);
  if (typeof first.unref === 'function') first.unref();
  console.log('[DncLiftReport] sweep started — every 5m');
  return timer;
}
