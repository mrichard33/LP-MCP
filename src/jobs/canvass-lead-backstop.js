/**
 * Canvass lead backstop — src/jobs/canvass-lead-backstop.js
 *
 * Every 15 minutes: canvass leads whose GHL webhook to
 * POST /webhooks/canvassing-lead never arrived are sent through the webhook's
 * own pipeline (validateCanvassingPayload + processCanvassingLead). Selection
 * and the WHY live in src/canvass-lead-backstop.js.
 *
 * ONCE PER CONTACT
 *   Every attempt, successful or not, writes `canvass-backstop:<contactId>` to
 *   lp_appointment_sync_marks. A failed LP post has already carded the canvass
 *   channel from inside the handler; re-posting it every 15 minutes would only
 *   repeat that card.
 *
 * FAIL CLOSED
 *   Any failed read (mirror, lp_leads, marks) sends nobody. A live GHL read
 *   that returns nothing skips that one contact (getGHLContact cannot tell
 *   "not found" from "GHL down", so neither is a reason to post).
 *
 * MODE  CANVASS_BACKSTOP_MODE = off | shadow (code default) | live
 *   shadow logs who it WOULD send and touches nothing.
 */

import { runJob } from '../job-runner.js';
import {
  backstopMode, buildCanvassCandidatesSql, selectCanvassLeads, liveHasLpId,
  buildPayloadFromContact, formatBackstopCard, markKey,
  MIN_AGE_MIN, LOOKBACK_DAYS, MAX_PER_PASS,
} from '../canvass-lead-backstop.js';
import { normalizePhone10 } from '../lead-leak-classify.js';

export const JOB_ID = 'canvass-lead-backstop';
export const INTERVAL_MS = 15 * 60 * 1000;
const MARKS_TABLE = 'lp_appointment_sync_marks';
const CANVASS_MARKS_TABLE = 'canvassing_intake_marks';
const CHUNK = 500;

const asRows = (data, what) => {
  if (!Array.isArray(data)) throw new Error(`${what}: read returned no row set`);
  return data;
};
const sqlList = (xs) => xs.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(',');

async function defaultDeps() {
  const [{ runSQL }, { hlRunSQL }, supabaseMod, { getGHLContact }, handler, { sendGroupMeMessage }] = await Promise.all([
    import('../admin/supabase-admin.js'),
    import('../admin/hl-client.js'),
    import('../supabase.js'),
    import('../ghl.js'),
    import('../canvassing-lead-handler.js'),
    import('../groupme.js'),
  ]);
  return {
    runSQL, hlRunSQL, supabase: supabaseMod.default, getContact: getGHLContact,
    validate: handler.validateCanvassingPayload, process: handler.processCanvassingLead,
    send: sendGroupMeMessage,
  };
}

/** Phones (phone10) already in lp_leads. Same expression as idx_lp_leads_phone10. */
async function readLpPhones(runSQL, phones) {
  const out = new Set();
  for (let i = 0; i < phones.length; i += CHUNK) {
    const rows = asRows(await runSQL(`
      SELECT DISTINCT right(regexp_replace(coalesce(phone, ''::text), '[^0-9]'::text, ''::text, 'g'::text), 10) AS phone10
        FROM lp_leads
       WHERE right(regexp_replace(coalesce(phone, ''::text), '[^0-9]'::text, ''::text, 'g'::text), 10) IN (${sqlList(phones.slice(i, i + CHUNK))})
    `), 'lp phone check');
    for (const r of rows) out.add(String(r.phone10));
  }
  return out;
}

/**
 * Contact ids another path already sent (a create_lp_lead action that is queued,
 * running or done). Throws on a bad read so the pass fails CLOSED.
 */
async function readAgenticSent(runSQL, ids) {
  const out = new Set();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = asRows(await runSQL(`
      SELECT DISTINCT target_id
        FROM agent_actions
       WHERE action_type = 'create_lp_lead'
         AND status IN ('pending','pending_approval','approved','executing','completed')
         AND target_id IN (${sqlList(ids.slice(i, i + CHUNK))})
    `), 'agentic sent check');
    for (const r of rows) if (r.target_id) out.add(String(r.target_id));
  }
  return out;
}

/** Contact ids present in `table` under `keyFor(id)`, any age. */
async function readKeys(db, table, ids, keyFor, what) {
  const out = new Set();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const byKey = new Map(slice.map((id) => [keyFor(id), id]));
    const { data, error } = await db.from(table).select('dedup_key').in('dedup_key', [...byKey.keys()]);
    if (error) throw new Error(`${what}: ${error.message}`);
    for (const r of data || []) if (byKey.has(r.dedup_key)) out.add(byKey.get(r.dedup_key));
  }
  return out;
}

export async function runCanvassLeadBackstop({ env = process.env, nowMs = Date.now(), deps = {} } = {}) {
  const mode = backstopMode(env);
  if (mode === 'off') return { skipped: true, reason: 'CANVASS_BACKSTOP_MODE=off', mode };
  const need = ['runSQL', 'hlRunSQL', 'supabase', 'getContact', 'validate', 'process', 'send'];
  const d = { ...(need.every((k) => deps[k]) ? {} : await defaultDeps()), ...deps };

  const errors = [];
  const out = { mode, candidates: 0, would_send: 0, sent: 0, failed: 0, live_has_lp: 0, skipped: {}, errors };
  const finish = () => ({ ok: errors.length === 0, ...out });

  let picked;
  try {
    const sinceIso = new Date(nowMs - LOOKBACK_DAYS * 86_400_000).toISOString();
    const untilIso = new Date(nowMs - MIN_AGE_MIN * 60_000).toISOString();
    const candidates = asRows(await d.hlRunSQL(buildCanvassCandidatesSql({ sinceIso, untilIso })), 'hl canvass contacts');
    out.candidates = candidates.length;
    const ids = [...new Set(candidates.map((c) => String(c.ghl_contact_id)))];
    const phones = [...new Set(candidates.map((c) => normalizePhone10(c.phone)).filter(Boolean))];
    const [lpPhones, arrived, tried, sentElsewhere] = await Promise.all([
      phones.length ? readLpPhones(d.runSQL, phones) : new Set(),
      ids.length ? readKeys(d.supabase, CANVASS_MARKS_TABLE, ids, (id) => id, 'canvass marks read') : new Set(),
      ids.length ? readKeys(d.supabase, MARKS_TABLE, ids, markKey, 'backstop marks read') : new Set(),
      ids.length ? readAgenticSent(d.runSQL, ids) : new Set(),
    ]);
    picked = selectCanvassLeads(candidates, { lpPhones, arrived, tried, sentElsewhere, nowMs, max: MAX_PER_PASS });
  } catch (err) {
    errors.push(`read: ${err.message}`);
    return finish();
  }
  out.skipped = picked.skipped;
  out.would_send = picked.send.length;

  if (mode !== 'live') {
    if (picked.send.length) {
      console.log(`[CanvassBackstop] shadow: would send ${picked.send.length} → ${picked.send.map((r) => r.ghl_contact_id).join(', ')}`);
    }
    return finish();
  }

  const sent = [];
  const failed = [];
  for (const r of picked.send) {
    let attempted = false;
    try {
      const contact = await d.getContact(r.ghl_contact_id);
      if (!contact) throw new Error('live GHL read returned nothing');
      if (liveHasLpId(contact)) { out.live_has_lp += 1; continue; }
      const v = d.validate(buildPayloadFromContact(contact));
      if (!v.ok) throw new Error(`payload invalid: ${v.errors.join('; ')}`);
      attempted = true;
      const res = await d.process(v.normalized);
      if (res?.outcome === 'ok' || res?.outcome === 'duplicate_suppressed') sent.push({ ...r, outcome: res.outcome === 'ok' ? `LP ok in1_id=${res.in1_id ?? '?'}` : 'already in progress' });
      else failed.push({ ...r, error: `${res?.outcome ?? 'no result'}${res?.error ? `: ${res.error}` : ''}` });
    } catch (err) {
      failed.push({ ...r, error: err.message });
    }
    if (attempted) {
      const { error } = await d.supabase.from(MARKS_TABLE).upsert(
        { dedup_key: markKey(r.ghl_contact_id), contact_id: r.ghl_contact_id, created_at: new Date(nowMs).toISOString() },
        { onConflict: 'dedup_key' });
      if (error) errors.push(`mark ${r.ghl_contact_id}: ${error.message}`);
    }
  }
  out.sent = sent.length;
  out.failed = failed.length;
  if (failed.length) errors.push(`not sent: ${failed.map((f) => f.ghl_contact_id).join(', ')}`);

  if (sent.length || failed.length) {
    try {
      await d.send(formatBackstopCard({ sent, failed }), { channel: 'ops' });
    } catch (err) {
      errors.push(`card: ${err.message}`);
    }
  }
  return finish();
}

/* --- scheduler ---------------------------------------------------------- */

let timer = null;
let running = false;

export function startCanvassBackstopScheduler(env = process.env) {
  if (timer) return timer;
  if (backstopMode(env) === 'off') {
    console.log('[CanvassBackstop] scheduler not started (CANVASS_BACKSTOP_MODE=off)');
    return null;
  }
  const tick = async () => {
    if (running) return; // a slow pass must not overlap itself
    running = true;
    try {
      const { value: res } = await runJob(JOB_ID, () => runCanvassLeadBackstop());
      if (res && !res.skipped) {
        const line = `[CanvassBackstop] ${res.mode}: candidates=${res.candidates} would_send=${res.would_send} sent=${res.sent} failed=${res.failed}`;
        if (res.ok === false) console.warn(`${line} errors: ${res.errors.join('; ')}`);
        else console.log(line);
      }
    } catch (err) {
      console.error(`[CanvassBackstop] pass threw: ${err.message}`);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[CanvassBackstop] scheduler started — mode ${backstopMode(env)}, every 15m`);
  return timer;
}

export function stopCanvassBackstopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
