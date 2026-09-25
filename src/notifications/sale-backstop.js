/**
 * Sale Announcements — the backstop
 * src/notifications/sale-backstop.js
 *
 * ONE question: did a sale close in LP that never reached the board?
 *
 * WHY THIS EXISTS (2026-09-25)
 * ----------------------------
 * A sale only reaches the board when LP's outbound webhook tells GHL workflow
 * I.LP-IN (7f24f79d) the lead is a Sale; its Sold branch then posts to GroupMe
 * and calls POST /notifications/sale-announcement. That webhook does not retry
 * (see src/services/lp-contact-backstop.js), and from 2026-09-24 it all but
 * stopped delivering: announced vs sold, by day —
 *
 *   09-17..23   87 announced / 94 sold
 *   09-24        0 announced /  9 sold
 *   09-25        1 announced /  7 sold
 *
 * Every missed sale was in lp_leads as closed_won with a GHL contact, and our
 * own polling sync had emitted lp.disposition_changed:Sale for it — the data
 * was here; only LP's push was missing. So the backstop reads OUR copy: a Sale
 * event older than the grace period with no sale_announcements row gets
 * announced from here, through the same completeAnnouncement() the GHL path
 * uses (same message, rankings, threads, market channel).
 *
 * WHY 30 MINUTES OF GRACE
 * -----------------------
 * When the GHL path works it is fast: Bugbee's sale (09-25) was seen by our
 * sync at 18:49:05 and announced at 18:49:42. Waiting 30 minutes means the
 * backstop never races a healthy GHL path — it only speaks when GHL has
 * clearly not. The idempotency key is the same one the endpoint builds for a
 * lead_id sale (lp_lead_id + rounded amount), so a GHL call that arrives even
 * later is a replay, not a second Slack post. (GroupMe is posted by GHL's own
 * steps, which we cannot dedupe; that late double is the accepted cost.)
 *
 * STALE SALES GO IN ONE DIGEST, NOT N CELEBRATIONS
 * ------------------------------------------------
 * A sale first seen more than STALE_MS ago is not "just closed", and a burst of
 * fifteen day-old celebrations reads as a malfunction. Those are claimed and
 * posted together as one catch-up message. That is also how the 09-24/25 gap
 * is cleared on the first pass after deploy — no manual repost.
 *
 * ONLY A REAL TRANSITION INTO SALE, ON A RECENT APPOINTMENT
 * --------------------------------------------------------
 * The first dry run against live data (2026-09-25) found 46 "Sale" events with
 * no announcement — 25 of them were OLD sales (appointments back to 2017) that
 * LP re-sent with the disposition unchanged (Sale → Sale) or that our sync saw
 * for the first time (no previous state). Announcing those would tell the floor
 * a 2017 job just closed. So a sale counts only when the first Sale event in
 * the window moved FROM another disposition (or from nothing on a brand-new
 * lead), and the lead's appointment is within RECENT_APPT_MS.
 *
 * GROUPME
 * -------
 * Sent only when GROUPME_SALES_BOT_ID is set: the 'sales' GroupMe channel
 * otherwise falls back to the MAIN bot, which is not the sales board. Sent
 * with noSlackMirror, because the Slack side is already posted here.
 */

import supabaseDefault from '../supabase.js';
import { postToSlack, salesRollupChannelId } from '../slack.js';
import { sendGroupMeMessage } from '../groupme.js';
import { branchName } from '../approval-card.js';
import { officeMarketCode } from '../slack.js';
import { displayRepName } from './office-ranking.js';
import {
  STATUSES,
  claimAnnouncement,
  completeAnnouncement,
  idempotencyKey,
  isUsableRepName,
} from './sale-announcement.js';

export const GRACE_MS = 30 * 60 * 1000;
export const STALE_MS = 6 * 60 * 60 * 1000;
export const LOOKBACK_MS = 48 * 60 * 60 * 1000;
export const EVENT_ROW_LIMIT = 1000;
/** A sale whose appointment is older than this is not today's news. */
export const RECENT_APPT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * When this process started. Anything already waiting at startup is a backlog,
 * not a sale that just closed, so it goes in the one catch-up digest rather
 * than N back-to-back celebrations (the first deploy clears the 09-23..25 gap
 * as a single message, as requested).
 */
const PROCESS_STARTED_AT = Date.now();

export function backstopEnabled() {
  return String(process.env.SALE_ANNOUNCE_BACKSTOP_ENABLED || 'true').toLowerCase() !== 'false';
}

function salesBoardGroupMeConfigured() {
  return Boolean(process.env.GROUPME_SALES_BOT_ID);
}

function money(n) {
  return `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
}

/** Post to the GroupMe sales board, never the main group, never mirrored to Slack. */
export async function sendSalesBoardGroupMe(text, deps = {}) {
  const { send = sendGroupMeMessage, logger = console, configured = salesBoardGroupMeConfigured() } = deps;
  if (!configured) {
    logger.warn?.('[SaleBackstop] GROUPME_SALES_BOT_ID unset — GroupMe sales board not posted');
    return { mirrored: false, reason: 'no_sales_bot' };
  }
  try {
    await send(text, { channel: 'sales', noSlackMirror: true, noDedup: true });
    return { mirrored: true, reason: null };
  } catch (err) {
    logger.warn?.(`[SaleBackstop] GroupMe post failed: ${err.message}`);
    return { mirrored: false, reason: err.message };
  }
}

// ─── Reads (each a deps seam) ────────────────────────────────────

async function readSaleEvents({ supabase, sinceIso, untilIso }) {
  const res = await supabase
    .from('system_events')
    .select('lp_lead_id, created_at, previous_state')
    .eq('event_type', 'lp.disposition_changed')
    .eq('event_subtype', 'Sale')
    .gte('created_at', sinceIso)
    .lte('created_at', untilIso)
    .order('created_at', { ascending: true })
    .limit(EVENT_ROW_LIMIT);
  if (res.error) throw new Error(`sale events: ${res.error.message}`);
  return res.data || [];
}

async function readAnnouncedLeadIds({ supabase, leadIds }) {
  const res = await supabase.from('sale_announcements').select('lp_lead_id').in('lp_lead_id', leadIds);
  if (res.error) throw new Error(`announced: ${res.error.message}`);
  return new Set((res.data || []).map((r) => String(r.lp_lead_id)));
}

async function readLeads({ supabase, leadIds }) {
  const res = await supabase
    .from('lp_leads')
    .select('lp_lead_id, lp_prospect_id, ghl_contact_id, rep_name, job_value, lp_branch_id, closed_won, appointment_date')
    .in('lp_lead_id', leadIds);
  if (res.error) throw new Error(`leads: ${res.error.message}`);
  return res.data || [];
}

/**
 * Sales LP shows as won that nobody announced, oldest first. Each is
 * { leadId, prospectId, contactId, repDisplayName, amount, branch, firstSeenAt }.
 * Throws on a failed read — the caller must not guess.
 */
export async function findMissedSales(deps = {}) {
  const {
    supabase = supabaseDefault,
    now = () => new Date(),
    graceMs = GRACE_MS,
    lookbackMs = LOOKBACK_MS,
    recentApptMs = RECENT_APPT_MS,
    readEvents = readSaleEvents,
    readAnnounced = readAnnouncedLeadIds,
    readLeadRows = readLeads,
  } = deps;

  const at = new Date(now()).getTime();
  const events = await readEvents({
    supabase,
    sinceIso: new Date(at - lookbackMs).toISOString(),
    untilIso: new Date(at - graceMs).toISOString(),
  });

  // The FIRST Sale event per lead in the window decides: a Sale → Sale event
  // is LP re-sending an old sale, not a new one (see the header).
  const firstSeen = new Map();
  const reSent = new Set();
  for (const e of events) {
    const id = e?.lp_lead_id != null ? String(e.lp_lead_id) : null;
    if (!id || firstSeen.has(id) || reSent.has(id)) continue;
    const prev = e?.previous_state?.disposition_code ?? null;
    if (String(prev || '').toLowerCase() === 'sale') reSent.add(id);
    else firstSeen.set(id, e.created_at);
  }
  if (!firstSeen.size) return [];

  const ids = [...firstSeen.keys()];
  const announced = await readAnnounced({ supabase, leadIds: ids });
  const pending = ids.filter((id) => !announced.has(id));
  if (!pending.length) return [];

  const leads = await readLeadRows({ supabase, leadIds: pending });
  const out = [];
  for (const l of leads) {
    const repDisplayName = displayRepName(l.rep_name);
    const amount = Number(l.job_value) || 0;
    // Only what LP still calls a won sale, with a name and a number worth
    // putting on the board. A sale reversed since the event is not announced.
    if (!l.closed_won || amount <= 0 || !isUsableRepName(repDisplayName)) continue;
    // Old lead, new Sale event: our sync seeing a years-old sale for the first
    // time. Only a recent appointment makes it today's sale.
    const appt = l.appointment_date ? new Date(l.appointment_date).getTime() : NaN;
    if (!Number.isFinite(appt) || appt < at - recentApptMs) continue;
    out.push({
      leadId: String(l.lp_lead_id),
      prospectId: l.lp_prospect_id != null ? String(l.lp_prospect_id) : null,
      contactId: l.ghl_contact_id || null,
      repDisplayName,
      amount,
      branch: l.lp_branch_id || null,
      firstSeenAt: firstSeen.get(String(l.lp_lead_id)),
    });
  }
  return out.sort((a, b) => String(a.firstSeenAt).localeCompare(String(b.firstSeenAt)));
}

/** The row the endpoint would have written for this sale, so keys match exactly. */
export function backstopRow(sale, { status = STATUSES.PENDING, source = 'backstop' } = {}) {
  return {
    lp_lead_id: sale.leadId,
    lp_prospect_id: sale.prospectId,
    ghl_contact_id: sale.contactId,
    rep_display_name: sale.repDisplayName,
    gross_sale_amount: sale.amount,
    idempotency_key: idempotencyKey(sale.leadId, sale.amount),
    key_source: 'lead_id',
    announce_source: source,
    status,
    error_message: null,
  };
}

/** Pure: the one catch-up message for sales that are too old to celebrate one by one. */
export function formatDigest(sales) {
  if (!sales?.length) return null;
  const lines = [
    `📋 ${sales.length === 1 ? 'A sale' : `${sales.length} sales`} that didn't reach the board when ${sales.length === 1 ? 'it' : 'they'} closed:`,
  ];
  for (const s of sales) {
    const office = branchName(officeMarketCode(s.branch));
    const day = new Date(s.firstSeenAt).toLocaleDateString('en-US', {
      timeZone: 'America/New_York', month: 'short', day: 'numeric',
    });
    lines.push(`• ${s.repDisplayName} — ${money(s.amount)}${office ? ` (${office})` : ''} · ${day}`);
  }
  lines.push('Congratulations to all of you. 🎉');
  return lines.join('\n');
}

/**
 * Claim the stale sales, post them as one message, and record the result on
 * each row. Claim FIRST so two replicas can never both post the digest.
 */
export async function postDigest(stale, deps = {}) {
  const {
    supabase = supabaseDefault,
    claim = claimAnnouncement,
    post = postToSlack,
    channelId = salesRollupChannelId(),
    groupMe = sendSalesBoardGroupMe,
    logger = console,
    now = () => new Date(),
  } = deps;

  const claimed = [];
  for (const s of stale) {
    const c = await claim(backstopRow(s, { source: 'backstop_digest' }), { supabase });
    if (c.claimed && c.row?.id != null) claimed.push({ ...s, rowId: c.row.id });
  }
  if (!claimed.length) return { ok: true, posted: 0 };

  const text = formatDigest(claimed);
  const res = channelId ? await post(text, channelId) : { ok: false, error: 'no_channel' };
  const at = new Date(now()).toISOString();
  for (const s of claimed) {
    const patch = res.ok
      ? { status: STATUSES.POSTED, slack_ts: res.ts, slack_channel: res.channel || channelId, message_text: text, completed_at: at }
      : { status: STATUSES.SLACK_FAILED, error_message: `slack:${res.error} (backstop digest)`, message_text: text, completed_at: at };
    const u = await supabase.from('sale_announcements').update(patch).eq('id', s.rowId);
    if (u.error) logger.warn?.(`[SaleBackstop] digest row ${s.rowId} update failed: ${u.error.message}`);
  }
  if (!res.ok) {
    logger.error?.(`[SaleBackstop] digest of ${claimed.length} sales failed to post: ${res.error}`);
    return { ok: false, posted: 0, error: res.error };
  }
  await groupMe(text, { logger });
  logger.log?.(`[SaleBackstop] digest posted — ${claimed.length} sales ts=${res.ts}`);
  return { ok: true, posted: claimed.length, ts: res.ts };
}

/**
 * One pass. Never throws: failure is { ok: false }, so runJob can classify it
 * from the return value (CLAUDE.md, "a job that never throws must still be
 * able to fail").
 */
export async function runSaleBackstop(deps = {}) {
  const {
    logger = console,
    now = () => new Date(),
    staleMs = STALE_MS,
    startedAt = PROCESS_STARTED_AT,
    find = findMissedSales,
    claim = claimAnnouncement,
    complete = completeAnnouncement,
    digest = postDigest,
    groupMe = sendSalesBoardGroupMe,
    supabase = supabaseDefault,
  } = deps;

  if (String(process.env.SALE_ANNOUNCE_ENABLED || 'false') !== 'true') {
    return { ok: true, skipped: 'SALE_ANNOUNCE_ENABLED is not true' };
  }

  let missed;
  try {
    missed = await find({ ...deps, supabase, now });
  } catch (err) {
    logger.error?.(`[SaleBackstop] could not read missed sales: ${err.message}`);
    return { ok: false, error: err.message };
  }
  if (!missed.length) return { ok: true, missed: 0 };

  const at = new Date(now()).getTime();
  const isStale = (s) => {
    const seen = new Date(s.firstSeenAt).getTime();
    return at - seen > staleMs || seen < startedAt;
  };
  const fresh = missed.filter((s) => !isStale(s));
  const stale = missed.filter(isStale);
  logger.warn?.(
    `[SaleBackstop] ${missed.length} sale(s) LP shows as won with no announcement — `
    + `${fresh.length} announcing now, ${stale.length} in a catch-up digest. `
    + 'LP did not notify GHL I.LP-IN for these.',
  );

  let announced = 0;
  let failed = 0;
  for (const s of fresh) {
    const c = await claim(backstopRow(s), { supabase });
    if (!c.claimed) continue; // another replica or a late GHL call owns it
    const r = await complete({
      rowId: c.row.id,
      repDisplayName: s.repDisplayName,
      amount: s.amount,
      leadId: s.leadId,
      keySource: 'lead_id',
    }, { supabase, logger, now, mirror: (text) => groupMe(text, { logger }) });
    if (r?.ok) announced += 1; else failed += 1;
  }

  let digestResult = { ok: true, posted: 0 };
  if (stale.length) digestResult = await digest(stale, { supabase, logger, now, groupMe });

  const ok = failed === 0 && digestResult.ok !== false;
  return { ok, missed: missed.length, announced, failed, digested: digestResult.posted || 0 };
}
