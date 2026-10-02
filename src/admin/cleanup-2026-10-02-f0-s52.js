// One-time F.0 / S5.2 cleanup — src/admin/cleanup-2026-10-02-f0-s52.js
//
// 2026-10-02 (Mark). Run ONCE after the S5.2 entry gate deploys, report first,
// then apply. CLI wrapper: scripts/cleanup-2026-10-02-f0-s52.js. Route:
// POST /admin/cleanup/2026-10-02-f0-s52?mode=report|apply (authenticated),
// GET  /admin/cleanup/2026-10-02-f0-s52 for the last run's summary.
//
//   a) F.0 — every active-f.0 contact whose current lead is not OPPFDN, who has
//      no real demo, or who has no LP lead (the audit's flagF0Contact, judged on
//      LP LIVE + cache) → removed from F.0 and the active-f.0 tag removed.
//   b) S5.2 — every active-s5.2 / active-w5.2 contact the entry gate would
//      refuse (demo on any lead, live appointment, current lead Issue, current
//      lead No Demo/ND/NOC, or an ACTIVE canvassing entry — cancel or no-show,
//      user ruling 2026-10-02) → removed from both S5.2 workflows and the tags
//      active-s5.2, active-w5.2, s52-task-created removed. A contact in S5.2 for
//      a pre-demo worry (APPOINTMENT_FRICTION other than ghost) is left alone:
//      it belongs there with a live appointment.
//   c) Gaby (zPSEN55i7yCjbjlnSoKu) — F.0 webhook only if she still lacks
//      active-f.0 and her current lead 579452 is OPPFDN with a demo in the last
//      14 days.
//
// It never enrolls anyone else. A contact whose live read fails is skipped,
// never changed. GHL calls are paced to at most 5 a second. Every contact is
// logged to system_events as 'cleanup.2026-10-02'.
import { pickCurrentLead } from '../current-lead.js';
import { contactHadDemo } from '../demo-truth.js';
import { lpStoredToUtcMs } from '../lp-dates.js';
import { flagF0Contact, F0_ACTIVE_TAG } from '../jobs/f0-integrity-audit.js';
import {
  evaluateS52Entry, isGatedState, loadS52GateInputs, S52_WORKFLOW_IDS, S52_TAGS,
} from '../s52-entry-gate.js';

export const CLEANUP_EVENT = 'cleanup.2026-10-02';
export const F0_WORKFLOW_ID = '15f47572-9ffc-453d-995d-a1890441f290';
export const F0_WEBHOOK_URL = 'https://services.leadconnectorhq.com/hooks/SsBG7j5KQAIP1SFP2Sca/webhook-trigger/4e3a9178-6f67-4889-b3bb-02cc35aca17d';
export const GABY_CONTACT_ID = 'zPSEN55i7yCjbjlnSoKu';
export const GABY_LEAD_ID = '579452';
const GHL_MIN_INTERVAL_MS = 200; // ≤ 5 GHL calls a second
const CHUNK = 200;

const lower = (tags) => (tags || []).map((t) => String(t).trim().toLowerCase());

/**
 * Pure. Should this S5.2 contact come out? Mirrors the gate exactly; a
 * pre-demo friction contact is the one exception (it is kept).
 * @returns {{ remove: boolean, reason: string }}
 */
export function planS52Contact({ leads, tags, stateCode, nowMs = Date.now() }) {
  if (stateCode && !isGatedState(stateCode)) return { remove: false, reason: 'friction_state_kept' };
  const verdict = evaluateS52Entry({ leads, tags, nowMs });
  if (verdict.allow) return { remove: false, reason: 'passes_gate' };
  // 2026-10-02 (user ruling): an ACTIVE canvassing entry comes out whether it
  // is a cancel or a no-show; older canvassing markers alone do not (the gate's
  // CANVASSING_TAGS is active-entry:canvassing only).
  return { remove: true, reason: verdict.reason };
}

/** Pure. Should Gaby be put into F.0? */
export function planGaby({ leads, tags, nowMs = Date.now() }) {
  if (lower(tags).includes(F0_ACTIVE_TAG)) return { enroll: false, reason: 'already_has_active_f0' };
  const current = pickCurrentLead(leads || []);
  if (String(current?.lp_lead_id ?? '') !== GABY_LEAD_ID) return { enroll: false, reason: `current_lead_is_${current?.lp_lead_id ?? 'none'}` };
  if (String(current.disposition_code ?? '').trim() !== 'OPPFDN') return { enroll: false, reason: `current_disposition_${current.disposition_code ?? 'none'}` };
  if (!contactHadDemo(leads)) return { enroll: false, reason: 'no_real_demo' };
  const apptMs = lpStoredToUtcMs(current.appointment_date);
  if (!Number.isFinite(apptMs) || apptMs > nowMs || nowMs - apptMs > 14 * 86_400_000) return { enroll: false, reason: 'demo_not_in_last_14_days' };
  return { enroll: true, reason: 'oppfdn_demo_within_14_days' };
}

async function defaultDeps() {
  const [{ default: supabase }, { hlRunSQL }, { ghlFetch }, { emitEvent }, { applyTagsToSnapshot }] = await Promise.all([
    import('../supabase.js'),
    import('./hl-client.js'),
    import('../actions/helpers.js'),
    import('../event-emitter.js'),
    import('../services/tag-snapshot.js'),
  ]);
  return { supabase, hlRunSQL, ghlFetch, emitEvent, applyTagsToSnapshot, fetch: globalThis.fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
}

function pace(fn, sleep, minMs = GHL_MIN_INTERVAL_MS) {
  let last = 0;
  return async (...args) => {
    const wait = last + minMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    return fn(...args);
  };
}

async function hlContactsWithTags(deps, tags) {
  const list = tags.map((t) => `'${t}'`).join(',');
  const rows = await deps.hlRunSQL(
    `SELECT ghl_contact_id FROM contacts
      WHERE deleted_at IS NULL AND ghl_contact_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM unnest(contacts.tags) t WHERE lower(t) IN (${list}))`,
  );
  return [...new Set((rows || []).map((r) => r.ghl_contact_id).filter(Boolean))].sort();
}

async function latestOpenStates(deps, ids) {
  const latest = new Map();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await deps.supabase.from('contact_objection_states')
      .select('contact_id, state_code, entered_at')
      .in('contact_id', ids.slice(i, i + CHUNK))
      .is('exited_at', null);
    if (error) throw new Error(`contact_objection_states read failed: ${error.message}`);
    for (const r of data || []) {
      const prev = latest.get(r.contact_id);
      if (!prev || String(r.entered_at) > String(prev.entered_at)) latest.set(r.contact_id, r);
    }
  }
  return latest;
}

/**
 * @param {{ mode?: 'report'|'apply', limit?: number, deps?: object, onProgress?: Function }} opts
 */
// 2026-10-02 — resumable. Railway redeploys LP-MCP every ~20 minutes on a busy
// day (other sessions' merges), and each one killed the in-process run: three
// apply runs died inside F.0 and never reached S5.2. A contact already logged
// as `removed` or `ok` in this mode in the last 24h is skipped, and `groups`
// runs only some of a/b/c.
const RESUME_WINDOW_MS = 24 * 3_600_000;

async function loadDone(deps, mode, nowMs) {
  const done = new Set();
  try {
    const { data, error } = await deps.supabase.from('system_events')
      .select('ghl_contact_id, event_subtype, payload')
      .eq('event_type', CLEANUP_EVENT)
      .gte('created_at', new Date(nowMs - RESUME_WINDOW_MS).toISOString())
      .limit(5000);
    if (error) throw new Error(error.message);
    for (const r of data || []) {
      const p = r.payload || {};
      if (p.mode === mode && ['removed', 'ok'].includes(p.action)) done.add(`${r.event_subtype}|${r.ghl_contact_id}`);
    }
  } catch (err) {
    console.warn(`[Cleanup20261002] resume list unreadable — checking every contact: ${err.message}`);
  }
  return done;
}

export async function runCleanup({ mode = 'report', limit = Infinity, groups = ['f0', 's52', 'gaby'], resume = true, deps: depsArg, onProgress } = {}) {
  const apply = mode === 'apply';
  const deps = { ...(depsArg?.__noDefaults ? {} : await defaultDeps()), ...(depsArg || {}) };
  const nowMs = deps.nowMs ?? Date.now();
  const ghl = pace(deps.ghlFetch, deps.sleep);
  const loaderDeps = { ...deps, ghlFetch: ghl };
  const summary = {
    mode, started_at: new Date(nowMs).toISOString(),
    f0: { candidates: 0, checked: 0, flagged: 0, removed: 0, failed: 0, read_failed: 0, by_reason: {} },
    s52: { candidates: 0, checked: 0, flagged: 0, removed: 0, failed: 0, read_failed: 0, by_reason: {}, kept: {} },
    gaby: null,
    contacts: [],
  };
  const bump = (obj, k) => { obj[k] = (obj[k] || 0) + 1; };
  const done = resume ? await loadDone(deps, mode, nowMs) : new Set();
  summary.resumed_skipped = { f0: 0, s52: 0 };

  const log = async (group, contactId, data) => {
    summary.contacts.push({ group, contact_id: contactId, ...data });
    try {
      await deps.emitEvent({
        event_type: CLEANUP_EVENT,
        event_subtype: group,
        source: 'cleanup_2026_10_02',
        entity_type: 'contact',
        entity_id: String(contactId),
        ghl_contact_id: String(contactId),
        payload: { mode, group, ...data },
        priority: 'low',
        bypass_filter: true,
        idempotency_key: `${CLEANUP_EVENT}_${mode}_${group}_${contactId}`,
      });
    } catch (err) {
      console.warn(`[Cleanup20261002] event log failed for ${contactId}: ${err.message}`);
    }
    onProgress?.(summary);
  };

  // GHL answers 400/404/422 when the contact is not in that workflow; that is
  // "already out", not a failure.
  const removeFromWorkflow = async (contactId, wfId) => {
    try {
      await ghl('DELETE', `/contacts/${contactId}/workflow/${wfId}`);
      return 'removed';
    } catch (err) {
      if (/→ (400|404|422)\b|\b(400|404|422)\b/.test(String(err.message))) return 'not_enrolled';
      throw err;
    }
  };
  const removeTags = async (contactId, liveTags, tags) => {
    const present = tags.filter((t) => lower(liveTags).includes(t));
    if (!present.length) return [];
    await ghl('DELETE', `/contacts/${contactId}/tags`, { tags: present });
    await deps.applyTagsToSnapshot?.(contactId, { remove: present });
    return present;
  };

  // ── a) F.0 ────────────────────────────────────────────────────────
  const f0Ids = groups.includes('f0') ? await hlContactsWithTags(deps, [F0_ACTIVE_TAG]) : [];
  summary.f0.candidates = f0Ids.length;
  for (const id of f0Ids.slice(0, limit)) {
    if (done.has(`f0|${id}`)) { summary.resumed_skipped.f0++; continue; }
    summary.f0.checked++;
    const inputs = await loadS52GateInputs(id, loaderDeps);
    if (inputs.error) { summary.f0.read_failed++; await log('f0', id, { action: 'skipped', reason: inputs.error }); continue; }
    const flag = flagF0Contact(inputs.leads);
    if (!flag) { await log('f0', id, { action: 'ok' }); continue; }
    summary.f0.flagged++;
    const reasonKey = flag.reason.startsWith('current disposition') ? `not_oppfdn:${flag.disposition || 'empty'}` : flag.reason.replace(/\s+/g, '_');
    bump(summary.f0.by_reason, reasonKey);
    if (!apply) { await log('f0', id, { action: 'would_remove', reason: reasonKey, detail: flag.reason }); continue; }
    try {
      const wf = await removeFromWorkflow(id, F0_WORKFLOW_ID);
      const tags = await removeTags(id, inputs.tags, [F0_ACTIVE_TAG]);
      summary.f0.removed++;
      await log('f0', id, { action: 'removed', reason: reasonKey, workflow: wf, tags_removed: tags });
    } catch (err) {
      summary.f0.failed++;
      await log('f0', id, { action: 'failed', reason: reasonKey, error: err.message });
    }
  }

  // ── b) S5.2 ───────────────────────────────────────────────────────
  const s52Ids = groups.includes('s52') ? await hlContactsWithTags(deps, ['active-s5.2', 'active-w5.2']) : [];
  summary.s52.candidates = s52Ids.length;
  const states = s52Ids.length ? await latestOpenStates(deps, s52Ids) : new Map();
  for (const id of s52Ids.slice(0, limit)) {
    if (done.has(`s52|${id}`)) { summary.resumed_skipped.s52++; continue; }
    summary.s52.checked++;
    const stateCode = states.get(id)?.state_code || null;
    if (stateCode && !isGatedState(stateCode)) { bump(summary.s52.kept, 'friction_state_kept'); continue; }
    const inputs = await loadS52GateInputs(id, loaderDeps);
    if (inputs.error) { summary.s52.read_failed++; await log('s52', id, { action: 'skipped', reason: inputs.error, state_code: stateCode }); continue; }
    const plan = planS52Contact({ leads: inputs.leads, tags: inputs.tags, stateCode, nowMs });
    if (!plan.remove) { bump(summary.s52.kept, plan.reason); await log('s52', id, { action: 'ok', reason: plan.reason }); continue; }
    summary.s52.flagged++;
    bump(summary.s52.by_reason, plan.reason);
    if (!apply) { await log('s52', id, { action: 'would_remove', reason: plan.reason, state_code: stateCode }); continue; }
    try {
      const wf = {};
      for (const wfId of S52_WORKFLOW_IDS) wf[wfId] = await removeFromWorkflow(id, wfId);
      const tags = await removeTags(id, inputs.tags, [...S52_TAGS]);
      summary.s52.removed++;
      await log('s52', id, { action: 'removed', reason: plan.reason, state_code: stateCode, workflows: wf, tags_removed: tags });
    } catch (err) {
      summary.s52.failed++;
      await log('s52', id, { action: 'failed', reason: plan.reason, error: err.message });
    }
  }

  // ── c) Gaby ───────────────────────────────────────────────────────
  const g = groups.includes('gaby') ? await loadS52GateInputs(GABY_CONTACT_ID, loaderDeps) : { error: 'group_not_selected' };
  if (g.error === 'group_not_selected') {
    summary.gaby = { action: 'not_run' };
  } else if (g.error) {
    summary.gaby = { action: 'skipped', reason: g.error };
  } else {
    const plan = planGaby({ leads: g.leads, tags: g.tags, nowMs });
    if (!plan.enroll) summary.gaby = { action: 'none', reason: plan.reason };
    else if (!apply) summary.gaby = { action: 'would_enroll_f0', reason: plan.reason };
    else {
      try {
        // rate-limiter-exempt: a /hooks webhook trigger, not the GHL v2 API budget
        const res = await deps.fetch(F0_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ contact_id: GABY_CONTACT_ID, source: 'f0_agentic', entry_route_rule: 'F0_ENROLL_CURRENT_OPPFDN' }).toString(),
        });
        summary.gaby = res.ok
          ? { action: 'enrolled_f0', reason: plan.reason, status: res.status }
          : { action: 'failed', reason: plan.reason, status: res.status, error: (await res.text().catch(() => '')).slice(0, 300) };
      } catch (err) {
        summary.gaby = { action: 'failed', reason: plan.reason, error: err.message };
      }
    }
  }
  if (summary.gaby.action !== 'not_run') await log('gaby', GABY_CONTACT_ID, summary.gaby);

  summary.finished_at = new Date().toISOString();
  console.log(`[Cleanup20261002] ${mode}: F.0 ${summary.f0.flagged} flagged / ${summary.f0.removed} removed; S5.2 ${summary.s52.flagged} flagged / ${summary.s52.removed} removed; Gaby ${summary.gaby?.action}`);
  return summary;
}

/** Pure. Counts per group, for the PR and the route. */
export function summarize(summary) {
  const { contacts, ...rest } = summary;
  return rest;
}

// ── Route: start in the background, read the result with GET ──────────
let current = null; // { run_id, mode, status, summary, error }

export function registerCleanup20261002Routes(app, authenticate) {
  const guards = typeof authenticate === 'function' ? [authenticate] : [];
  const path = '/admin/cleanup/2026-10-02-f0-s52';
  app.post(path, ...guards, (req, res) => {
    const mode = String(req.body?.mode ?? req.query.mode ?? 'report').toLowerCase();
    if (!['report', 'apply'].includes(mode)) return res.status(400).json({ ok: false, error: 'mode must be report or apply' });
    if (current?.status === 'running') return res.status(409).json({ ok: false, error: 'a run is already in progress', run_id: current.run_id });
    const limitRaw = Number(req.body?.limit ?? req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : Infinity;
    const groupsRaw = String(req.body?.groups ?? req.query.groups ?? 'f0,s52,gaby');
    const groups = groupsRaw.split(',').map((g) => g.trim()).filter((g) => ['f0', 's52', 'gaby'].includes(g));
    const resume = String(req.body?.resume ?? req.query.resume ?? 'true') !== 'false';
    current = { run_id: `${mode}-${Date.now()}`, mode, status: 'running', summary: null, error: null };
    const run = current;
    runCleanup({ mode, limit, groups, resume, onProgress: (s) => { run.summary = s; } })
      .then((s) => { run.summary = s; run.status = 'done'; })
      .catch((err) => { run.status = 'failed'; run.error = err.message; console.error(`[Cleanup20261002] ${mode} failed: ${err.message}`); });
    res.status(202).json({ ok: true, run_id: run.run_id, mode, poll: `GET ${path}` });
  });
  app.get(path, ...guards, (req, res) => {
    if (!current) return res.json({ ok: true, status: 'never_run' });
    const full = String(req.query.full || '') === '1';
    res.json({
      ok: true, run_id: current.run_id, mode: current.mode, status: current.status, error: current.error,
      summary: current.summary ? (full ? current.summary : summarize(current.summary)) : null,
    });
  });
  console.log(`[Cleanup20261002] Route: POST ${path}?mode=report|apply&groups=f0,s52,gaby&resume=true, GET ${path}${guards.length ? ' (authenticated)' : ' (UNAUTHENTICATED)'}`);
}
