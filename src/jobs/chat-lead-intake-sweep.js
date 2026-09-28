/**
 * Chat lead intake sweep — src/jobs/chat-lead-intake-sweep.js
 *
 * Every 15 minutes, all hours: chat leads (GHL contacts from the chatbot or
 * chat widget) that are at least MIN_AGE_HOURS old (3h default) and still have no LP id are sent
 * to LP through enrollLpLeadCreation — the same canonical path
 * force_lp_lead_creation uses (workflow 8e30ff37 → addlead → inbound-id
 * writeback → LP callback fills the lead id). Selection rules and the WHY live
 * in src/chat-lead-intake.js.
 *
 * WHAT IT DEFENDS AGAINST (2026-09-28)
 *   A chat lead that talked to the bot but never booked had no path into LP,
 *   so it was never dialled. 13 of that morning's 18 "never reached LP"
 *   contacts were exactly that. Backfilling them by hand fixes one morning;
 *   this sweep is the path.
 *
 * ONCE PER CONTACT
 *   A successful send writes a `chat-intake:<contactId>` row to
 *   lp_appointment_sync_marks, and any contact with that row is never sent
 *   again — whatever LP did with it. enrollLpLeadCreation's own 24h
 *   `create-lead:` mark is the second guard if the chat mark failed to write.
 *
 * MODE  CHAT_LP_INTAKE_MODE = off | shadow (code default) | live
 *   shadow reads and decides every pass and logs who it WOULD send; it enrolls
 *   nobody, writes no mark and posts no card (a card every 15 minutes naming
 *   the same people would be noise).
 *   live   enrolls up to MAX_PER_PASS per pass and posts ONE ops card per pass
 *          that sent or failed anyone.
 *
 * Address: sent without one (ruling 2026-09-28). The LP address backfill job
 * (LP_ADDRESS_BACKFILL_ENABLED) repairs a blank LP address once GHL has it.
 */

import { runJob } from '../job-runner.js';
import {
  chatIntakeMode, buildChatCandidatesSql, selectChatLeads, formatChatIntakeCard,
  markKey, MIN_AGE_HOURS, LOOKBACK_DAYS, MAX_PER_PASS,
} from '../chat-lead-intake.js';
import { normalizePhone10 } from '../lead-leak-classify.js';

export const JOB_ID = 'chat-lead-intake';
export const INTERVAL_MS = 15 * 60 * 1000;
const MARKS_TABLE = 'lp_appointment_sync_marks';
const LEAD_CHUNK = 500;

const asRows = (data, what) => {
  if (!Array.isArray(data)) throw new Error(`${what}: read returned no row set`);
  return data;
};
const sqlList = (xs) => xs.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(',');

async function defaultDeps() {
  const [{ runSQL }, { hlRunSQL }, supabaseMod, { enrollLpLeadCreation }, { sendGroupMeMessage }] = await Promise.all([
    import('../admin/supabase-admin.js'),
    import('../admin/hl-client.js'),
    import('../supabase.js'),
    import('../admin/lp-force-addlead.js'),
    import('../groupme.js'),
  ]);
  return { runSQL, hlRunSQL, supabase: supabaseMod.default, enroll: enrollLpLeadCreation, send: sendGroupMeMessage };
}

/** Phones (phone10) that already have an lp_leads row. Same expression as idx_lp_leads_phone10. */
async function readLpPhones(runSQL, phones) {
  const out = new Set();
  for (let i = 0; i < phones.length; i += LEAD_CHUNK) {
    const rows = asRows(await runSQL(`
      SELECT DISTINCT right(regexp_replace(coalesce(phone, ''::text), '[^0-9]'::text, ''::text, 'g'::text), 10) AS phone10
        FROM lp_leads
       WHERE right(regexp_replace(coalesce(phone, ''::text), '[^0-9]'::text, ''::text, 'g'::text), 10) IN (${sqlList(phones.slice(i, i + LEAD_CHUNK))})
    `), 'lp phone check');
    for (const r of rows) out.add(String(r.phone10));
  }
  return out;
}

/**
 * Contact ids that already have a create_lp_lead action (queued, running or
 * done) — i.e. the primary chat path or the booking path already sent them.
 * Throws on a bad read so the pass fails CLOSED and sends nobody.
 */
async function readAgenticSent(runSQL, ids) {
  const out = new Set();
  for (let i = 0; i < ids.length; i += LEAD_CHUNK) {
    const rows = asRows(await runSQL(`
      SELECT DISTINCT target_id
        FROM agent_actions
       WHERE action_type = 'create_lp_lead'
         AND status IN ('pending','pending_approval','approved','executing','completed')
         AND target_id IN (${sqlList(ids.slice(i, i + LEAD_CHUNK))})
    `), 'agentic sent check');
    for (const r of rows) if (r.target_id) out.add(String(r.target_id));
  }
  return out;
}

/** Contact ids that already carry a chat-intake mark (any age). */
async function readMarked(db, ids) {
  const out = new Set();
  for (let i = 0; i < ids.length; i += LEAD_CHUNK) {
    const keys = ids.slice(i, i + LEAD_CHUNK).map(markKey);
    const { data, error } = await db.from(MARKS_TABLE).select('dedup_key').in('dedup_key', keys);
    if (error) throw new Error(`marks read: ${error.message}`);
    for (const r of data || []) out.add(String(r.dedup_key).slice(markKey('').length));
  }
  return out;
}

export async function runChatLeadIntakeSweep({ env = process.env, nowMs = Date.now(), deps = {} } = {}) {
  const mode = chatIntakeMode(env);
  if (mode === 'off') return { skipped: true, reason: 'CHAT_LP_INTAKE_MODE=off', mode };
  const d = { ...(deps.runSQL && deps.hlRunSQL && deps.supabase && deps.enroll && deps.send ? {} : await defaultDeps()), ...deps };

  const errors = [];
  const out = { mode, candidates: 0, would_send: 0, sent: 0, failed: 0, skipped: {}, errors };
  const finish = () => ({ ok: errors.length === 0, ...out });

  // Fail closed: a read that fails sends nobody. Sending on a partial picture
  // could push a contact that is already in LP or already sent.
  let picked;
  try {
    const sinceIso = new Date(nowMs - LOOKBACK_DAYS * 86_400_000).toISOString();
    const untilIso = new Date(nowMs - MIN_AGE_HOURS * 3_600_000).toISOString();
    const candidates = asRows(await d.hlRunSQL(buildChatCandidatesSql({ sinceIso, untilIso })), 'hl chat contacts');
    out.candidates = candidates.length;
    const phones = [...new Set(candidates.map((c) => normalizePhone10(c.phone)).filter(Boolean))];
    const ids = [...new Set(candidates.map((c) => String(c.ghl_contact_id)))];
    const [lpPhones, marked, sentElsewhere] = await Promise.all([
      phones.length ? readLpPhones(d.runSQL, phones) : new Set(),
      ids.length ? readMarked(d.supabase, ids) : new Set(),
      ids.length ? readAgenticSent(d.runSQL, ids) : new Set(),
    ]);
    picked = selectChatLeads(candidates, { lpPhones, marked, sentElsewhere, nowMs, max: MAX_PER_PASS });
  } catch (err) {
    errors.push(`read: ${err.message}`);
    return finish();
  }
  out.skipped = picked.skipped;
  out.would_send = picked.send.length;

  if (mode !== 'live') {
    if (picked.send.length) {
      console.log(`[ChatIntake] shadow: would send ${picked.send.length} → ${picked.send.map((r) => r.ghl_contact_id).join(', ')}`);
    }
    return finish();
  }

  const sent = [];
  const failed = [];
  for (const r of picked.send) {
    try {
      const res = await d.enroll({ contactId: r.ghl_contact_id, notify: false });
      if (!res?.success) throw new Error(res?.error || 'enroll returned no success');
      sent.push(r);
      const { error } = await d.supabase.from(MARKS_TABLE).upsert(
        { dedup_key: markKey(r.ghl_contact_id), contact_id: r.ghl_contact_id, created_at: new Date(nowMs).toISOString() },
        { onConflict: 'dedup_key' });
      // Not fatal: enroll's own 24h create-lead mark stops an immediate re-send.
      if (error) errors.push(`mark ${r.ghl_contact_id}: ${error.message}`);
    } catch (err) {
      failed.push({ ...r, error: err.message });
    }
  }
  out.sent = sent.length;
  out.failed = failed.length;
  if (failed.length) errors.push(`enroll failed for ${failed.length}: ${failed.map((f) => f.ghl_contact_id).join(', ')}`);

  if (sent.length || failed.length) {
    try {
      await d.send(formatChatIntakeCard({ mode, sent, failed }), { channel: 'ops' });
    } catch (err) {
      errors.push(`card: ${err.message}`);
    }
  }
  return finish();
}

/* --- scheduler ---------------------------------------------------------- */

let timer = null;
let running = false;

export function startChatLeadIntakeScheduler(env = process.env) {
  if (timer) return timer;
  if (chatIntakeMode(env) === 'off') {
    console.log('[ChatIntake] scheduler not started (CHAT_LP_INTAKE_MODE=off)');
    return null;
  }
  const tick = async () => {
    if (running) return; // a slow pass must not overlap itself
    running = true;
    try {
      const { value: res } = await runJob(JOB_ID, () => runChatLeadIntakeSweep());
      if (res && !res.skipped) {
        const line = `[ChatIntake] ${res.mode}: candidates=${res.candidates} would_send=${res.would_send} sent=${res.sent} failed=${res.failed}`;
        if (res.ok === false) console.warn(`${line} errors: ${res.errors.join('; ')}`);
        else console.log(line);
      }
    } catch (err) {
      console.error(`[ChatIntake] pass threw: ${err.message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[ChatIntake] scheduler started — mode ${chatIntakeMode(env)}, every 15m`);
  return timer;
}

export function stopChatLeadIntakeScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
