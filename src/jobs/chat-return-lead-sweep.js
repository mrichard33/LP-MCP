/**
 * Chat return sweep — src/jobs/chat-return-lead-sweep.js
 *
 * Every 15 minutes, all hours: a returning lead (GHL contact added 15+ days
 * before the chat, newest LP lead 15+ days old or none) who talked to the
 * website chatbot gets a NEW LP lead with source Reece ChatBot (830 / 5574).
 * The rules and the WHY live in src/chat-return-lead.js (the user, 2026-10-19).
 *
 * THE WRITES, in order, each one read back before the next (the inbound-call
 * capture's proven path, src/jobs/inbound-caller-capture.js):
 *   1. LP Source ID / Pro ID → 830 / 5574, OVERWRITING the old lead's source,
 *      read back. Not landed → stop: enrollLpLeadCreation only fills BLANK
 *      fields, so the new lead would be credited to the old channel.
 *   2. The old LP Lead ID cleared, read back, a GHL note names it: workflow
 *      8e30ff37 skips any contact whose LP Lead ID is filled.
 *   3. enrollLpLeadCreation (8e30ff37 → addlead → in1 writeback → LP callback).
 *
 * ONCE: a send writes `chat-return:<contactId>` (not sent again for 15 days),
 * and every decided chat writes `chat-return-seen:<contactId>:<last turn>` so a
 * chat is never re-read every pass. A read that could not tell marks nothing
 * and the next pass asks again; a failed read sends nobody.
 *
 * MODE  CHAT_RETURN_LP_MODE = off | shadow | live (default live, the user's ruling)
 *   shadow decides and logs who it WOULD send; writes nothing.
 * It posts no card: the system did the work and nobody acts (Mark, 2026-10-07).
 * Every decision is in job_runs.detail (by_reason, sent).
 */

import { runJob } from '../job-runner.js';
import { todayET } from './lp-report-common.js';
import {
  chatReturnMode, buildChatEngagementsSql, buildContactsSql, buildLeadStatusSql, selectChats,
  leadStatusBlock, decideChat, clearNote, sentKey, seenKey, CHATBOT_LP_SOURCE,
  RETURN_DAYS, QUIET_MIN, LOOKBACK_HOURS, MAX_PER_PASS,
} from '../chat-return-lead.js';
import { LP_LEAD_ID_FIELD } from '../inbound-capture-match.js';

export const JOB_ID = 'chat-return-lead';
export const INTERVAL_MS = 15 * 60 * 1000;
const MARKS_TABLE = 'lp_appointment_sync_marks';
const DAY_MS = 86_400_000;

const asRows = (data, what) => {
  if (!Array.isArray(data)) throw new Error(`${what}: read returned no row set`);
  return data;
};
const sqlList = (xs) => xs.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(',');

async function defaultDeps() {
  const [{ runSQL }, { hlRunSQL }, supabaseMod, { enrollLpLeadCreation }, { ghlFetch }, capture, { readLeadMatch }] = await Promise.all([
    import('../admin/supabase-admin.js'),
    import('../admin/hl-client.js'),
    import('../supabase.js'),
    import('../admin/lp-force-addlead.js'),
    import('../actions/helpers.js'),
    import('./inbound-caller-capture.js'),
    import('../inbound-capture-match.js'),
  ]);
  const findExistingLpLead = async (phone10) => (await import('../actions/handlers/lp-lead.js')).findExistingLpLead(phone10);
  return {
    runSQL, hlRunSQL, supabase: supabaseMod.default, enroll: enrollLpLeadCreation, ghlFetch,
    matchLead: (p) => readLeadMatch(p, { runSQL, findExistingLpLead }),
    stampSource: (contactId) => capture.stampLpSource(contactId, CHATBOT_LP_SOURCE, { ghlFetch }),
    clearLeadId: (contactId, lead) => capture.clearOldLeadId(contactId, lead, { ghlFetch }, { note: clearNote }),
  };
}

/** Which of these dedup keys already exist (any age, or since `sinceIso`). */
async function readKeys(db, keys, sinceIso = null) {
  const out = new Set();
  for (let i = 0; i < keys.length; i += 500) {
    let q = db.from(MARKS_TABLE).select('dedup_key').in('dedup_key', keys.slice(i, i + 500));
    if (sinceIso) q = q.gte('created_at', sinceIso);
    const { data, error } = await q;
    if (error) throw new Error(`marks read: ${error.message}`);
    for (const r of data || []) out.add(String(r.dedup_key));
  }
  return out;
}

/** Contact ids another path already sent to LP (a create_lp_lead in the last 15 days). */
async function readRecentCreates(runSQL, ids, sinceIso) {
  const rows = asRows(await runSQL(`
    SELECT DISTINCT target_id FROM agent_actions
     WHERE action_type = 'create_lp_lead'
       AND status IN ('pending','pending_approval','approved','executing','completed')
       AND created_at >= '${sinceIso}'
       AND target_id IN (${sqlList(ids)})
  `), 'recent create_lp_lead');
  return new Set(rows.map((r) => String(r.target_id)));
}

async function writeMark(db, key, contactId, nowMs) {
  const { error } = await db.from(MARKS_TABLE).upsert(
    { dedup_key: key, contact_id: contactId, created_at: new Date(nowMs).toISOString() }, { onConflict: 'dedup_key' });
  return error ? error.message : null;
}

export async function runChatReturnLeadSweep({ env = process.env, nowMs = Date.now(), deps = {} } = {}) {
  const mode = chatReturnMode(env);
  if (mode === 'off') return { skipped: true, reason: 'CHAT_RETURN_LP_MODE=off', mode };
  const need = ['runSQL', 'hlRunSQL', 'supabase', 'ghlFetch', 'enroll', 'matchLead', 'stampSource', 'clearLeadId'];
  const d = { ...(need.every((k) => deps[k]) ? {} : await defaultDeps()), ...deps };

  const errors = [];
  const byReason = {};
  const count = (r) => { byReason[r] = (byReason[r] || 0) + 1; };
  const out = { mode, chats: 0, checked: 0, would_send: 0, sent: 0, failed: 0, skipped: {}, by_reason: byReason, sent_ids: [], errors };
  const finish = () => ({ ok: errors.length === 0, ...out });

  // Fail closed: any read that fails sends nobody this pass.
  let picked;
  try {
    const sinceIso = new Date(nowMs - LOOKBACK_HOURS * 3_600_000).toISOString();
    const quietBeforeIso = new Date(nowMs - QUIET_MIN * 60_000).toISOString();
    const chats = asRows(await d.runSQL(buildChatEngagementsSql({ sinceIso, quietBeforeIso })), 'live chat turns');
    out.chats = chats.length;
    if (!chats.length) return finish();
    const ids = [...new Set(chats.map((c) => String(c.ghl_contact_id)))];
    const windowIso = new Date(nowMs - RETURN_DAYS * DAY_MS).toISOString();
    const [contactRows, sent, seen, recentCreate] = await Promise.all([
      d.hlRunSQL(buildContactsSql(ids)),
      readKeys(d.supabase, ids.map(sentKey), windowIso),
      readKeys(d.supabase, chats.map((c) => seenKey(c.ghl_contact_id, c.last_chat_at))),
      readRecentCreates(d.runSQL, ids, windowIso),
    ]);
    const contacts = new Map(asRows(contactRows, 'hl contacts').map((c) => [String(c.ghl_contact_id), c]));
    const sentRecently = new Set([...sent].map((k) => k.slice(sentKey('').length)));
    picked = selectChats(chats, { contacts, sentRecently, seen, recentCreate, max: MAX_PER_PASS });
  } catch (err) {
    errors.push(`read: ${err.message}`);
    return finish();
  }
  out.skipped = picked.skipped;
  out.checked = picked.check.length;
  if (!picked.check.length) return finish();

  let statusRows;
  try {
    statusRows = asRows(await d.runSQL(buildLeadStatusSql([...new Set(picked.check.map((r) => r.phone10))])), 'lp_leads status');
  } catch (err) {
    errors.push(`read: ${err.message}`);
    return finish();
  }
  const todayEt = todayET(new Date(nowMs));

  const sentRows = [];
  const failed = [];
  for (const r of picked.check) {
    const leads = statusRows.filter((l) => l.phone10 === r.phone10 || l.alt10 === r.phone10);
    let match;
    try {
      // The contact's LP Lead ID is one of the match's sources. A failed GHL
      // read throws into `unverified`: never decide without it.
      const full = await d.ghlFetch('GET', `/contacts/${r.ghl_contact_id}`);
      const contact = full?.contact || full;
      if (!contact) throw new Error('GHL contact read returned nothing');
      const hit = (contact.customFields || []).find((f) => f?.id === LP_LEAD_ID_FIELD);
      const ghlLeadId = String(hit?.value ?? hit?.field_value ?? '').trim();
      match = await d.matchLead({ phone10: r.phone10, callAtMs: Date.parse(r.chat_started_at), ghlLeadId });
    } catch (err) {
      match = { verdict: 'unverified', why: err.message };
    }
    const decision = decideChat({ match, statusBlock: leadStatusBlock(leads, { nowMs, todayEt }) });
    count(decision.decision === 'send' ? (decision.returning ? 'send_returning' : 'send_no_lp_lead') : decision.reason);
    if (decision.decision === 'retry') continue;

    const seenK = seenKey(r.ghl_contact_id, r.last_chat_at);
    if (decision.decision === 'skip') {
      if (mode === 'live') {
        const e = await writeMark(d.supabase, seenK, r.ghl_contact_id, nowMs);
        if (e) errors.push(`mark ${r.ghl_contact_id}: ${e}`);
      }
      continue;
    }

    out.would_send += 1;
    if (mode !== 'live') {
      console.log(`[ChatReturn] shadow: would send ${r.ghl_contact_id} to LP as Reece ChatBot (${decision.reason})`);
      continue;
    }

    try {
      const stamped = await d.stampSource(r.ghl_contact_id);
      if (!stamped?.ok) throw new Error(`LP source not set: ${stamped?.detail || 'no answer'}`);
      const cleared = await d.clearLeadId(r.ghl_contact_id, match.lead);
      if (!cleared?.ok) throw new Error(`old LP Lead ID not cleared: ${cleared?.detail || 'no answer'}`);
      const res = await d.enroll({ contactId: r.ghl_contact_id, calendarName: 'Website chat · returning lead', notify: false });
      if (!res?.success) throw new Error(res?.error || 'enroll returned no success');
      const markErrs = [
        res.action === 'create_lead_already_enrolled' ? null : await writeMark(d.supabase, sentKey(r.ghl_contact_id), r.ghl_contact_id, nowMs),
        await writeMark(d.supabase, seenK, r.ghl_contact_id, nowMs),
      ].filter(Boolean);
      for (const e of markErrs) errors.push(`mark ${r.ghl_contact_id}: ${e}`);
      sentRows.push(r.ghl_contact_id);
      console.log(`[ChatReturn] ✅ ${r.ghl_contact_id} → LP as Reece ChatBot (${decision.reason}; ${res.action})`);
    } catch (err) {
      failed.push(r.ghl_contact_id);
      errors.push(`${r.ghl_contact_id}: ${err.message}`);
    }
  }
  out.sent = sentRows.length;
  out.sent_ids = sentRows;
  out.failed = failed.length;
  return finish();
}

/* --- scheduler ---------------------------------------------------------- */

let timer = null;
let running = false;

export function startChatReturnLeadScheduler(env = process.env) {
  if (timer) return timer;
  if (chatReturnMode(env) === 'off') {
    console.log('[ChatReturn] scheduler not started (CHAT_RETURN_LP_MODE=off)');
    return null;
  }
  const tick = async () => {
    if (running) return; // a slow pass must not overlap itself
    running = true;
    try {
      const { value: res } = await runJob(JOB_ID, () => runChatReturnLeadSweep());
      if (res && !res.skipped) {
        const line = `[ChatReturn] ${res.mode}: chats=${res.chats} checked=${res.checked} would_send=${res.would_send} sent=${res.sent} failed=${res.failed}`;
        if (res.ok === false) console.warn(`${line} errors: ${res.errors.join('; ')}`);
        else if (res.checked) console.log(line);
      }
    } catch (err) {
      console.error(`[ChatReturn] pass threw: ${err.message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[ChatReturn] scheduler started — mode ${chatReturnMode(env)}, every 15m`);
  return timer;
}

export function stopChatReturnLeadScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
