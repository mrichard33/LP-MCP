// ─── LP setter/confirmer name drift detection — src/jobs/lp-name-drift-check.js ───
//
// WHAT
//   Nightly watchdog that detects when lp_leads is carrying a STALE version of an
//   LP user's name. Alert-only: never writes to lp_leads.
//
// WHY (root cause)
//   lp_leads stores set_by_name / confirmed_by_name / verified_by_name as
//   DENORMALIZED TEXT captured at sync time. The sync engine writes them on insert
//   and never back-fills them. When an LP user record is renamed, every row synced
//   before the rename keeps the OLD string and every row after gets the NEW one, so
//   one person's history silently splits across two names.
//
//   This is not hypothetical. On 2026-07-28 ~14:00 ET the six Lightfire Partners
//   setters were renamed in LP to carry a " - LF" tag. Nothing alerted. The split
//   was found four weeks later only because a partner-facing report disagreed with
//   LP's own Appointment Statistics by Setter:
//
//     "Deer, Craig"        25 rows   (synced before the rename)
//     "Deer - LF, Craig"   30 rows   (synced after)
//
//   Reporting by setter name undercounted Craig Deer by 44% and Carla Wright by
//   42%. 100 stale values across 43 leads were repaired by hand. This job exists so
//   the next rename is caught in a day instead of a month.
//
// USER-VISIBLE IMPACT
//   A GroupMe alert when a name splits, naming the two variants and the row counts,
//   so the back-fill happens before anyone reports off the split. No behaviour change
//   to sync, routing, or messaging.
//
// WHAT THIS DOES NOT FIX
//   The underlying sync defect. Names still are not re-synced on update — that fix
//   lives in src/sync-leads.js (~line 349) and needs a separate change. This job is
//   detection only, deliberately: an automatic rename back-fill would be guessing at
//   which variant is current, and a legitimate rehire of a same-surname person would
//   be silently merged. A human should rule on every split.
//
// DETECTION
//   Compares the distinct name strings present in lp_leads against the LP user list.
//   Two independent signals, either of which fires:
//
//     1. SURNAME COLLISION — two distinct strings share a normalised
//        "surname|firstname" key but differ in full text (the rename signature).
//        Catches tag additions, spelling corrections, suffix changes.
//
//     2. ORPHANED STRING — a name present in lp_leads that no longer appears on any
//        row synced in the last ORPHAN_WINDOW_DAYS, while a sibling variant does.
//        Catches a rename whose old rows are old enough that only one side is live.
//
//   Signal 1 is the primary. Signal 2 catches the long tail.
//
// ENDPOINT (registerLpNameDriftRoutes):
//   GET|POST /api/lp/name-drift          → run now, return findings (no alert)
// SCHEDULER (startLpNameDriftScheduler):  daily at 05:00 ET, before the 06:00 jobs.

import supabase from '../supabase.js';
import { sendGroupMeMessage } from '../groupme.js';

const TIMEZONE = 'America/New_York';
const ENABLED = (process.env.LP_NAME_DRIFT_ENABLED || 'true') === 'true';
const REALERT_MS = 24 * 60 * 60 * 1000; // one alert per fingerprint per day
const ORPHAN_WINDOW_DAYS = 14;
const NAME_COLUMNS = ['set_by_name', 'confirmed_by_name', 'verified_by_name'];

// Rows LP uses for unattributed or system-generated activity. Never a person.
const NON_PERSON_NAMES = new Set([
  'No, Setter',
  'Unknown, Unknown',
  'Integration, GoHighLevel',
  'Affiliate, MVP Marketing',
  'Internet, Lead Gurus',
]);

/**
 * Reduce an LP display name to a comparison key.
 *
 * LP renders names "Surname, Firstname" and inserts partner tags before the
 * comma ("Deer - LF, Craig"). Stripping any " - XX" tag and lowercasing gives a
 * key that is stable across a tag being added or removed, which is exactly the
 * mutation we are hunting for.
 *
 *   "Deer - LF, Craig"  → "deer|craig"
 *   "Deer, Craig"       → "deer|craig"     ← same key, different text = drift
 *   "Wright - LF, Carla" → "wright|carla"
 */
export function nameKey(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const [surnamePart, ...rest] = raw.split(',');
  if (!surnamePart) return null;
  const surname = surnamePart
    .replace(/\s+-\s+[A-Za-z0-9]{1,6}\s*$/, '') // drop a trailing " - LF" style tag
    .trim()
    .toLowerCase();
  const first = rest.join(',').trim().toLowerCase();
  if (!surname) return null;
  return `${surname}|${first}`;
}

/**
 * Group distinct name observations by nameKey and return only the keys with more
 * than one distinct raw string. Pure — exported for tests.
 *
 * @param {Array<{name: string, column: string, rows: number, last_synced: string|null}>} observations
 */
export function findCollisions(observations) {
  const byKey = new Map();
  for (const obs of observations) {
    if (!obs.name || NON_PERSON_NAMES.has(obs.name)) continue;
    const key = nameKey(obs.name);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, new Map());
    const variants = byKey.get(key);
    const existing = variants.get(obs.name) || { name: obs.name, rows: 0, columns: new Set(), last_synced: null };
    existing.rows += obs.rows;
    existing.columns.add(obs.column);
    if (obs.last_synced && (!existing.last_synced || obs.last_synced > existing.last_synced)) {
      existing.last_synced = obs.last_synced;
    }
    variants.set(obs.name, existing);
  }

  const collisions = [];
  for (const [key, variants] of byKey) {
    if (variants.size < 2) continue;
    const list = [...variants.values()]
      .map((v) => ({ ...v, columns: [...v.columns].sort() }))
      .sort((a, b) => String(b.last_synced || '').localeCompare(String(a.last_synced || '')));
    // Most recently synced variant is almost certainly the current LP name.
    collisions.push({
      key,
      likely_current: list[0].name,
      likely_stale: list.slice(1).map((v) => v.name),
      variants: list,
      total_rows: list.reduce((a, v) => a + v.rows, 0),
      stale_rows: list.slice(1).reduce((a, v) => a + v.rows, 0),
    });
  }
  return collisions.sort((a, b) => b.stale_rows - a.stale_rows);
}

/** Stable fingerprint so the same unresolved split does not re-alert every night. */
export function fingerprint(collisions) {
  return collisions
    .map((c) => `${c.key}:${c.variants.map((v) => v.name).sort().join('~')}`)
    .sort()
    .join('||');
}

/**
 * Pull the distinct name strings per column out of lp_leads.
 *
 * Uses an RPC when available (single grouped scan) and falls back to a bounded
 * client-side aggregation. lp_leads is ~100K rows, so the fallback selects only
 * the three name columns plus synced_at and groups in memory rather than pulling
 * whole rows.
 */
async function collectObservations() {
  const observations = [];

  const { data: rpcData, error: rpcError } = await supabase.rpc('lp_name_variant_counts');
  if (!rpcError && Array.isArray(rpcData)) {
    for (const r of rpcData) {
      observations.push({
        name: r.name,
        column: r.column_name,
        rows: Number(r.row_count) || 0,
        last_synced: r.last_synced || null,
      });
    }
    return { observations, source: 'rpc' };
  }

  // Fallback — bounded scan, three columns only.
  const PAGE = 10000;
  const counters = new Map(); // `${column}\u0000${name}` → { rows, last_synced }
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from('lp_leads')
      .select('set_by_name, confirmed_by_name, verified_by_name, synced_at')
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`lp_leads scan failed at offset ${offset}: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) {
      for (const col of NAME_COLUMNS) {
        const name = row[col];
        if (!name) continue;
        const k = `${col}\u0000${name}`;
        const cur = counters.get(k) || { rows: 0, last_synced: null };
        cur.rows += 1;
        if (row.synced_at && (!cur.last_synced || row.synced_at > cur.last_synced)) {
          cur.last_synced = row.synced_at;
        }
        counters.set(k, cur);
      }
    }
    if (data.length < PAGE) break;
  }
  for (const [k, v] of counters) {
    const [column, name] = k.split('\u0000');
    observations.push({ name, column, rows: v.rows, last_synced: v.last_synced });
  }
  return { observations, source: 'fallback_scan' };
}

/** Variants whose rows have all gone quiet while a sibling variant is still active. */
export function findOrphans(collisions, windowDays = ORPHAN_WINDOW_DAYS) {
  const cutoff = new Date(Date.now() - windowDays * 86400 * 1000).toISOString();
  const orphans = [];
  for (const c of collisions) {
    for (const v of c.variants) {
      if (v.last_synced && v.last_synced < cutoff) {
        orphans.push({ key: c.key, name: v.name, rows: v.rows, last_synced: v.last_synced });
      }
    }
  }
  return orphans;
}

export async function checkLpNameDrift() {
  if (!supabase) return { ok: false, error: 'supabase unavailable' };
  const startedAt = Date.now();

  const { observations, source } = await collectObservations();
  const collisions = findCollisions(observations);
  const orphans = findOrphans(collisions);

  return {
    ok: collisions.length === 0,
    source,
    distinct_names_seen: observations.length,
    collisions,
    orphaned_variants: orphans,
    checked_columns: NAME_COLUMNS,
    elapsed_ms: Date.now() - startedAt,
  };
}

export function formatAlert(result) {
  const lines = result.collisions.slice(0, 6).map((c) => {
    const variants = c.variants.map((v) => `"${v.name}" ${v.rows}`).join(' vs ');
    return `• ${variants} — likely current: "${c.likely_current}"`;
  });
  const more = result.collisions.length > 6 ? `\n…and ${result.collisions.length - 6} more` : '';
  return (
    `🚨 SYSTEM — LP name drift: ${result.collisions.length} setter/confirmer name(s) split across variants ` +
    `(${result.collisions.reduce((a, c) => a + c.stale_rows, 0)} stale rows)\n` +
    `${lines.join('\n')}${more}\n\n` +
    `Cause: lp_leads stores these names as text frozen at sync time and never back-fills them, ` +
    `so an LP user rename splits one person's history. Reporting by setter name is undercounting ` +
    `until this is reconciled. Do NOT auto-merge — confirm against LP's user list first.`
  );
}

// ── HTTP route ───────────────────────────────────────────────────────────────
export function registerLpNameDriftRoutes(app) {
  const handler = async (req, res) => {
    try {
      const result = await checkLpNameDrift();
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  };
  app.get('/api/lp/name-drift', handler);
  app.post('/api/lp/name-drift', handler);
  console.log('[LpNameDrift] Route registered: GET+POST /api/lp/name-drift');
}

// ── Scheduler — daily at 05:00 ET, ahead of the 06:00 scorecard jobs ─────────
let driftTimer = null;
let lastRunDate = null;
let lastAlert = { fingerprint: null, at: 0 };

async function tick() {
  const result = await checkLpNameDrift();
  if (result.ok || !result.collisions?.length) {
    console.log('[LpNameDrift] clean — no name splits detected');
    return;
  }
  const fp = fingerprint(result.collisions);
  const now = Date.now();
  if (fp === lastAlert.fingerprint && now - lastAlert.at < REALERT_MS) {
    console.log('[LpNameDrift] same unresolved split within re-alert window — suppressed');
    return;
  }
  lastAlert = { fingerprint: fp, at: now };
  try {
    await sendGroupMeMessage(formatAlert(result));
  } catch (e) {
    console.error('[LpNameDrift] alert send failed:', e.message);
  }
}

export function startLpNameDriftScheduler() {
  if (driftTimer) return;
  if (!ENABLED) {
    console.log('[LpNameDrift] disabled (LP_NAME_DRIFT_ENABLED!=true)');
    return;
  }
  console.log('[LpNameDrift] Scheduler started — daily run at 05:00 ET');
  const checkAndRun = async () => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE, hour: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? -1);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    if (hour === 5 && lastRunDate !== today) {
      lastRunDate = today;
      try { await tick(); } catch (err) { console.error('[LpNameDrift] run failed:', err.message); }
    }
  };
  driftTimer = setInterval(checkAndRun, 5 * 60 * 1000);
}

export function stopLpNameDriftScheduler() {
  if (driftTimer) { clearInterval(driftTimer); driftTimer = null; }
}
