/**
 * Sim job store — src/simulator/sim-job-store.js  (2026-10-23)
 *
 * WHY. simulate_bot_conversation and run_bot_eval run inside the LP-MCP
 * service, the same service as the live chatbot, and their jobs lived only in
 * memory. A gate run takes 20-30 minutes, and any LP-MCP deploy (a push to
 * main, a redeploy, an env var, a rollback) killed it. Now every finished
 * conversation is saved in sim_jobs (supabase/migrations/20261023180000) and a
 * new instance picks up a job whose heartbeat stopped
 * (AIOS CANON.IMP.068, CANON.SK.063, CANON.TBL.015).
 *
 * This module holds the pure rules (keys, staleness, the resume cap, what may
 * be stored) and two stores with one interface: the Supabase store production
 * uses, and an in-memory store the tests use. Nothing here touches a live
 * chat, SMS or send path.
 *
 * SIM_JOB_PERSIST_MODE: live (default, unset) | off. off = in-memory jobs
 * exactly as before (the easy undo).
 */

export const HEARTBEAT_MS = 15_000;
export const STALE_MS = 45_000;
export const RESUME_DELAY_MS = 30_000;   // after the 20 s deploy overlap
export const RESUME_POLL_MS = 30_000;
export const MAX_RESUMES = 3;
export const MAX_JOB_AGE_MS = 2 * 3600_000;
export const RETENTION_DAYS = 30;

export function simJobPersistMode(env = process.env) {
  return String(env.SIM_JOB_PERSIST_MODE ?? '').trim().toLowerCase() === 'off' ? 'off' : 'live';
}

/** Who owns a job: the Railway deployment, or this process when run locally. */
let localOwner = null;
export function ownerId(env = process.env) {
  if (env.RAILWAY_DEPLOYMENT_ID) return String(env.RAILWAY_DEPLOYMENT_ID);
  localOwner ||= `local-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return localOwner;
}

/** The stable key of one conversation in a job: `run#/scenario_key/channel` (run is 1-based). Pure. */
export function resultKey(run, scenarioKey, channel) {
  return `${run}/${scenarioKey}/${channel}`;
}

/** True when a heartbeat is older than the stale window (or missing). Pure. */
export function isStale(heartbeatAt, nowMs = Date.now(), staleMs = STALE_MS) {
  const t = Date.parse(heartbeatAt || '');
  return !Number.isFinite(t) || nowMs - t > staleMs;
}

/**
 * May a claimed job be resumed? `row.resume_count` is the count BEFORE this
 * resume: three resumes already spent, or a job older than two hours, is
 * marked error instead (a gate that keeps dying is a finding, not a retry). Pure.
 */
export function resumeVerdict(row, nowMs = Date.now()) {
  if ((Number(row?.resume_count) || 0) >= MAX_RESUMES) return { resume: false, reason: `resume limit reached (${MAX_RESUMES} resumes)` };
  const created = Date.parse(row?.created_at || '');
  if (Number.isFinite(created) && nowMs - created > MAX_JOB_AGE_MS) return { resume: false, reason: 'job older than 2 hours; not resumed' };
  return { resume: true };
}

/** The units not yet finished, in plan order. Pure. */
export function pendingUnits(units, completed = {}) {
  return (units || []).filter(u => !Object.prototype.hasOwnProperty.call(completed || {}, u.key));
}

// The would_do fields that can carry a real contact's details (an address the
// lane read from the record, a captured name). Personas are simulated and keep
// them; a run on a real contact_id stores the id only.
const CONTACT_FIELDS = ['address', 'contact_name', 'capture'];

/** What may be stored for one conversation's results. Pure. */
export function persistableResult(results) {
  return (results || []).map((r) => {
    if (!r?.contact_id || !Array.isArray(r.would_do)) return r;
    return { ...r, would_do: r.would_do.map((w) => { const o = { ...w }; for (const f of CONTACT_FIELDS) delete o[f]; return o; }) };
  });
}

/**
 * Did the job change build or prompt between segments? `versions` is one
 * { git_sha, prompt_version, deployment } per segment. Pure.
 */
export function versionSummary(versions = []) {
  const list = (versions || []).filter(Boolean);
  const distinct = new Set(list.map(v => `${v.git_sha || ''}|${v.prompt_version || ''}`));
  return { resumed_across_versions: distinct.size > 1, versions: list };
}

// ── Supabase store ──────────────────────────────────────────────────────────
async function client() {
  const { default: supabase } = await import('../supabase.js');
  return supabase;
}

export const supabaseSimJobStore = {
  async insert(row) {
    const sb = await client();
    const { error } = await sb.from('sim_jobs').insert(row);
    if (error) throw new Error(error.message);
  },
  async record(id, owner, key, result) {
    const sb = await client();
    const { data, error } = await sb.rpc('sim_job_record', { p_id: id, p_owner: owner, p_key: key, p_result: result });
    if (error) throw new Error(error.message);
    return data === true;
  },
  /** Owner-checked patch; true when the row was ours and was updated. */
  async update(id, owner, patch, { statuses = null } = {}) {
    const sb = await client();
    let q = sb.from('sim_jobs').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).eq('owner_deployment_id', owner);
    if (statuses) q = q.in('status', statuses);
    const { data, error } = await q.select('id');
    if (error) throw new Error(error.message);
    return (data || []).length > 0;
  },
  async get(id) {
    const sb = await client();
    const { data, error } = await sb.from('sim_jobs').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
  },
  async claimStale(owner, staleMs = STALE_MS) {
    const sb = await client();
    const { data, error } = await sb.rpc('sim_job_claim', { p_owner: owner, p_stale_seconds: Math.round(staleMs / 1000) });
    if (error) throw new Error(error.message);
    return (Array.isArray(data) ? data[0] : data) || null;
  },
  async listOpen() {
    const sb = await client();
    const { data, error } = await sb.from('sim_jobs').select('id, kind, status, total_units, done_units, resume_count, heartbeat_at, created_at')
      .in('status', ['running', 'interrupted']).order('created_at', { ascending: true }).limit(20);
    if (error) throw new Error(error.message);
    return data || [];
  },
  async prune(days = RETENTION_DAYS) {
    const sb = await client();
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const { error } = await sb.from('sim_jobs').delete().in('status', ['done', 'error']).lt('updated_at', cutoff);
    if (error) throw new Error(error.message);
  },
};

// ── In-memory store (tests; same semantics, the claim included) ─────────────
export function createMemorySimJobStore({ now = () => Date.now() } = {}) {
  const rows = new Map();
  const iso = () => new Date(now()).toISOString();
  const clone = (r) => (r ? JSON.parse(JSON.stringify(r)) : null);
  return {
    rows,
    async insert(row) {
      if (rows.has(row.id)) throw new Error('duplicate key');
      rows.set(row.id, { completed: {}, versions: [], resume_count: 0, done_units: 0, total_units: 0, created_at: iso(), heartbeat_at: iso(), ...clone(row), updated_at: iso() });
    },
    async record(id, owner, key, result) {
      const r = rows.get(id);
      if (!r || r.owner_deployment_id !== owner || r.status !== 'running') return false;
      r.completed = { ...r.completed, [key]: clone(result) };
      r.done_units = Object.keys(r.completed).length;
      r.heartbeat_at = r.updated_at = iso();
      return true;
    },
    async update(id, owner, patch, { statuses = null } = {}) {
      const r = rows.get(id);
      if (!r || r.owner_deployment_id !== owner || (statuses && !statuses.includes(r.status))) return false;
      Object.assign(r, clone(patch), { updated_at: iso() });
      return true;
    },
    async get(id) { return clone(rows.get(id)); },
    // Synchronous between the pick and the write, so two claimers racing on
    // the same tick cannot both win (the SQL does it with SKIP LOCKED).
    async claimStale(owner, staleMs = STALE_MS) {
      const pick = [...rows.values()]
        .filter(r => ['running', 'interrupted'].includes(r.status) && isStale(r.heartbeat_at, now(), staleMs))
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
      if (!pick) return null;
      Object.assign(pick, { owner_deployment_id: owner, status: 'running', heartbeat_at: iso(), updated_at: iso() });
      return clone(pick);
    },
    async listOpen() { return [...rows.values()].filter(r => ['running', 'interrupted'].includes(r.status)).map(clone); },
    async prune(days = RETENTION_DAYS) {
      const cutoff = now() - days * 86_400_000;
      for (const [id, r] of rows) if (['done', 'error'].includes(r.status) && Date.parse(r.updated_at) < cutoff) rows.delete(id);
    },
  };
}
