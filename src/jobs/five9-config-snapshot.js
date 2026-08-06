// ─── Five9 config snapshot + change log — src/jobs/five9-config-snapshot.js ───
//
// Captures a DAILY snapshot of every Five9 configuration object and emits a
// field-level change log when a value differs from the previous snapshot.
//
// WHY THIS EXISTS
//   five9.admin_write audit events capture writes made THROUGH LP MCP. They
//   capture NOTHING done in the Five9 admin UI by a human, and there is no
//   record of what the config looked like on any past day. The `Data Leads`
//   profile sat at numberOfAttempts=100 for an unknown length of time and
//   nobody could say when it got that way. This table answers "what changed,
//   and when" for the whole dialer, regardless of who changed it or how.
//
// READ-ONLY, ALWAYS (binding). This job never repairs drift it finds. Detecting
//   drift and acting on it are separate concerns; acting stays on the gated
//   write path (create_agent_action → approve_action → admin-writes.js).
//
// HASHING RULE (the piece most likely to go wrong)
//   config_hash is sha256 over canonicalJson(config) — object keys sorted
//   recursively — so key-order jitter in the SOAP parse never registers as a
//   change. Array ORDER is deliberately preserved and NOT sorted: order is
//   meaningful in includeNumbers and in list priority, so sorting would hide
//   real changes. The cost of that choice is that if Five9 ever returns an
//   array in unstable order, the change log fires daily on that entity — which
//   is worse than no change log at all. UNSTABLE-HASH DETECTION below is the
//   canary for exactly that, and it is why a same-day re-run is worth running.
//
// VOLATILE FIELDS
//   `size` is stripped from `list` configs BEFORE hashing (record counts change
//   every day by design — lists repopulate at 6 AM ET) but is KEPT in the
//   stored config jsonb. Campaign `state` is deliberately NOT volatile: a
//   campaign silently going NOT_RUNNING is exactly what this table exists to
//   catch, so routine daily state-flip noise is expected and accepted.
//
// ENDPOINTS (registerFive9SnapshotRoutes):
//   POST /admin/five9/config-snapshot   — run now (manual + n8n)
//   GET  /admin/five9/config-snapshot/status — resolved config + last run
//
// SCHEDULER (startFive9ConfigSnapshotScheduler):
//   Gated on FIVE9_CONFIG_SNAPSHOT_ENABLED (default OFF — ships dark).
//   Fires once daily at FIVE9_CONFIG_SNAPSHOT_HOUR_ET (default 04:00 ET),
//   via the house 5-minute-tick idiom.

import crypto from 'node:crypto';
import supabase from '../supabase.js';
import { emitEvent } from '../event-emitter.js';
import { hourET, todayET } from './lp-report-common.js';
import {
  getCampaigns,
  getOutboundCampaign,
  getInboundCampaign,
  getCampaignProfiles,
  getListsInfo,
  getDispositions,
  getSkills,
} from '../five9-admin.js';
import { getUsersFullInfo } from '../five9-users-info.js';

const SNAPSHOT_ENABLED = process.env.FIVE9_CONFIG_SNAPSHOT_ENABLED === 'true';
const SNAPSHOT_HOUR_ET = parseInt(process.env.FIVE9_CONFIG_SNAPSHOT_HOUR_ET || '4', 10);
const SOAP_DELAY_MS = Math.max(0, parseInt(process.env.FIVE9_SNAPSHOT_DELAY_MS || '250', 10));
const UPSERT_CHUNK = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------------- *
 * Pure helpers — exported so tests need no Supabase, no Five9, no network.
 * ---------------------------------------------------------------------- */

/**
 * Canonical JSON: object keys sorted recursively, arrays left in place.
 * Two configs differing only in key insertion order serialize identically.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** Fields excluded from the hash (but kept in the stored config), per entity type. */
export const VOLATILE_FIELDS = { list: ['size'] };

/** Strip volatile fields for hashing purposes only. Never mutates the input. */
export function stripVolatile(entityType, config) {
  const volatile = VOLATILE_FIELDS[entityType];
  if (!volatile || !config || typeof config !== 'object') return config;
  const copy = { ...config };
  for (const f of volatile) delete copy[f];
  return copy;
}

export function configHash(entityType, config) {
  return crypto.createHash('sha256').update(canonicalJson(stripVolatile(entityType, config))).digest('hex');
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Walk two configs and return one entry per differing LEAF.
 * field_path is dotted for objects, bracketed for arrays: dialingSchedule.dialASAPTimeout,
 * includeNumbers[0]. An added or removed key yields a row with the missing side null.
 */
export function diffConfigs(prev, next, prefix = '') {
  const rows = [];
  const bothObjects = isPlainObject(prev) && isPlainObject(next);
  const bothArrays = Array.isArray(prev) && Array.isArray(next);

  if (bothArrays) {
    const len = Math.max(prev.length, next.length);
    for (let i = 0; i < len; i++) {
      rows.push(...diffConfigs(prev[i], next[i], `${prefix}[${i}]`));
    }
    return rows;
  }

  if (bothObjects) {
    const keys = [...new Set([...Object.keys(prev), ...Object.keys(next)])].sort();
    for (const k of keys) {
      const path = prefix ? `${prefix}.${k}` : k;
      rows.push(...diffConfigs(prev[k], next[k], path));
    }
    return rows;
  }

  // Leaf (or a type change, e.g. object -> scalar) — compare canonically.
  if (canonicalJson(prev) !== canonicalJson(next)) {
    rows.push({
      field_path: prefix || '(root)',
      previous_value: prev === undefined ? null : prev,
      new_value: next === undefined ? null : next,
    });
  }
  return rows;
}

/* ---------------------------------------------------------------------- *
 * Collection — every reader already exists; this only sequences them.
 * ---------------------------------------------------------------------- */

async function collectEntities(errors) {
  const entities = [];
  const push = (entity_type, entity_name, config) => {
    if (entity_name) entities.push({ entity_type, entity_name: String(entity_name), config });
  };
  // One entity failing must never abort the run.
  const attempt = async (label, fn) => {
    try {
      await fn();
    } catch (err) {
      console.warn(`[Five9Snapshot] ${label} failed: ${err.message}`);
      errors.push({ entity: label, error: err.message });
    }
    if (SOAP_DELAY_MS) await sleep(SOAP_DELAY_MS);
  };

  let outbound = [];
  let inbound = [];
  await attempt('campaigns', async () => {
    const res = await getCampaigns();
    for (const c of res?.campaigns || []) {
      if (String(c.type).toUpperCase() === 'OUTBOUND') outbound.push(c.name);
      else if (String(c.type).toUpperCase() === 'INBOUND') inbound.push(c.name);
    }
  });

  for (const name of outbound) {
    await attempt(`campaign_outbound:${name}`, async () => {
      push('campaign_outbound', name, await getOutboundCampaign(name));
    });
  }
  for (const name of inbound) {
    await attempt(`campaign_inbound:${name}`, async () => {
      push('campaign_inbound', name, await getInboundCampaign(name));
    });
  }

  await attempt('campaign_profiles', async () => {
    for (const p of (await getCampaignProfiles())?.profiles || []) push('campaign_profile', p.name, p);
  });
  await attempt('lists', async () => {
    for (const l of (await getListsInfo())?.lists || []) push('list', l.name, l);
  });
  await attempt('skills', async () => {
    for (const s of (await getSkills())?.skills || []) push('skill', s.name, s);
  });
  await attempt('dispositions', async () => {
    for (const d of (await getDispositions())?.dispositions || []) push('disposition', d.name, d);
  });
  await attempt('users', async () => {
    for (const u of (await getUsersFullInfo('.*'))?.users || []) push('user', u.userName, u);
  });

  return entities;
}

/* ---------------------------------------------------------------------- *
 * Runner.
 * ---------------------------------------------------------------------- */

let lastRun = null;

export async function runFive9ConfigSnapshot() {
  const startedAt = Date.now();
  const snapshot_date = todayET();
  const errors = [];

  if (!supabase) {
    const summary = { snapshot_date, entities_captured: 0, changes_detected: 0, unstable_hashes: 0, errors: [{ entity: 'supabase', error: 'Supabase not configured' }] };
    console.error('[Five9Snapshot] Supabase not configured — aborting');
    lastRun = { ...summary, finished_at: new Date().toISOString() };
    return summary;
  }

  const entities = await collectEntities(errors);
  console.log(`[Five9Snapshot] collected ${entities.length} entities (${errors.length} read errors)`);

  let changes_detected = 0;
  let unstable_hashes = 0;
  const snapshotRows = [];

  for (const e of entities) {
    e.config_hash = configHash(e.entity_type, e.config);
    snapshotRows.push({
      snapshot_date,
      entity_type: e.entity_type,
      entity_name: e.entity_name,
      config: e.config,
      config_hash: e.config_hash,
    });
  }

  // Prior snapshots: the most recent row per entity, whatever its date. We need
  // today's row too, because a same-day re-run with a different hash is the
  // unstable-ordering canary (see HASHING RULE in the header).
  const priorByKey = new Map();
  try {
    const { data, error } = await supabase
      .from('five9_config_snapshots')
      .select('id, snapshot_date, entity_type, entity_name, config, config_hash')
      .order('snapshot_date', { ascending: false })
      .limit(1000);
    if (error) throw new Error(error.message);
    for (const row of data || []) {
      const key = `${row.entity_type} ${row.entity_name}`;
      const existing = priorByKey.get(key);
      if (!existing || row.snapshot_date > existing.snapshot_date) priorByKey.set(key, row);
    }
  } catch (err) {
    // Tables absent (DDL lagging the merge) or the read failed — log, do not crash.
    console.error(`[Five9Snapshot] prior-snapshot read failed: ${err.message}`);
    errors.push({ entity: 'prior_snapshots', error: err.message });
  }

  // Upsert snapshots. Same-day re-run refreshes rather than duplicating.
  try {
    for (let i = 0; i < snapshotRows.length; i += UPSERT_CHUNK) {
      const { error } = await supabase
        .from('five9_config_snapshots')
        .upsert(snapshotRows.slice(i, i + UPSERT_CHUNK), { onConflict: 'snapshot_date,entity_type,entity_name' });
      if (error) throw new Error(error.message);
    }
  } catch (err) {
    console.error(`[Five9Snapshot] snapshot upsert failed: ${err.message}`);
    errors.push({ entity: 'snapshot_upsert', error: err.message });
    const summary = { snapshot_date, entities_captured: 0, changes_detected: 0, unstable_hashes: 0, errors, elapsed_ms: Date.now() - startedAt };
    lastRun = { ...summary, finished_at: new Date().toISOString() };
    return summary;
  }

  // Change detection. Only against an EARLIER snapshot_date — a same-day prior
  // row means this is a re-run, which must not double-log.
  const changeRows = [];
  for (const e of entities) {
    const prior = priorByKey.get(`${e.entity_type} ${e.entity_name}`);
    if (!prior) continue;                                   // first sighting
    if (prior.config_hash === e.config_hash) continue;       // unchanged

    if (prior.snapshot_date >= snapshot_date) {
      // Same-day re-run produced a DIFFERENT hash. Either a real change landed
      // between runs, or an array came back in a different order. The latter
      // would make the change log fire on everything from tomorrow onward, so
      // it is worth a loud line rather than a silent skip.
      unstable_hashes += 1;
      console.warn(`[Five9Snapshot] UNSTABLE HASH — ${e.entity_type}/${e.entity_name} changed within ${snapshot_date}; if this is not a real edit, an array is coming back in unstable order`);
      continue;
    }

    for (const d of diffConfigs(prior.config, e.config)) {
      changeRows.push({
        entity_type: e.entity_type,
        entity_name: e.entity_name,
        field_path: d.field_path,
        previous_value: d.previous_value,
        new_value: d.new_value,
        previous_snapshot_id: prior.id,
      });
    }
  }

  if (changeRows.length) {
    try {
      for (let i = 0; i < changeRows.length; i += UPSERT_CHUNK) {
        const { error } = await supabase.from('five9_config_changes').insert(changeRows.slice(i, i + UPSERT_CHUNK));
        if (error) throw new Error(error.message);
      }
      changes_detected = changeRows.length;
    } catch (err) {
      console.error(`[Five9Snapshot] change insert failed: ${err.message}`);
      errors.push({ entity: 'change_insert', error: err.message });
    }
  }

  const summary = {
    snapshot_date,
    entities_captured: snapshotRows.length,
    changes_detected,
    unstable_hashes,
    errors,
    elapsed_ms: Date.now() - startedAt,
  };
  console.log(`[Five9Snapshot] ${snapshot_date}: ${summary.entities_captured} captured, ${changes_detected} changes, ${unstable_hashes} unstable, ${errors.length} errors (${summary.elapsed_ms}ms)`);

  // Degraded when more than half the reads failed. bypass_filter is required:
  // applyIntakeFilter drops event types with no active rule consumer, and this
  // type has none — without it the degraded signal disappears silently.
  if (errors.length && errors.length > Math.max(1, snapshotRows.length) / 2) {
    await emitEvent({
      event_type: 'five9.config_snapshot_degraded',
      source: 'five9_config_snapshot',
      entity_type: 'system',
      entity_id: `five9_config_snapshot_${snapshot_date}`,
      priority: 'high',
      payload: summary,
      bypass_filter: true,
    });
  }

  lastRun = { ...summary, finished_at: new Date().toISOString() };
  return summary;
}

/* ---------------------------------------------------------------------- *
 * Route + scheduler.
 * ---------------------------------------------------------------------- */

export function registerFive9SnapshotRoutes(app, authenticate) {
  const guards = typeof authenticate === 'function' ? [authenticate] : [];

  app.post('/admin/five9/config-snapshot', ...guards, async (req, res) => {
    try {
      res.json(await runFive9ConfigSnapshot());
    } catch (err) {
      console.error('[Five9Snapshot] POST /admin/five9/config-snapshot failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/admin/five9/config-snapshot/status', ...guards, (req, res) => {
    res.json({
      enabled: SNAPSHOT_ENABLED,
      hour_et: SNAPSHOT_HOUR_ET,
      soap_delay_ms: SOAP_DELAY_MS,
      last_run: lastRun,
    });
  });

  console.log('[Five9Snapshot] Routes: POST /admin/five9/config-snapshot, GET /admin/five9/config-snapshot/status');
}

let snapshotTimer = null;
let lastSnapshotDate = null;

export function startFive9ConfigSnapshotScheduler() {
  if (snapshotTimer) return;
  if (!SNAPSHOT_ENABLED) {
    console.log('[Five9Snapshot] Scheduler disabled (set FIVE9_CONFIG_SNAPSHOT_ENABLED=true to enable the daily run)');
    return;
  }
  console.log(`[Five9Snapshot] Scheduler started — daily run at ${String(SNAPSHOT_HOUR_ET).padStart(2, '0')}:00 ET`);
  const checkAndRun = async () => {
    const today = todayET();
    if (hourET() === SNAPSHOT_HOUR_ET && lastSnapshotDate !== today) {
      lastSnapshotDate = today; // claim before awaiting (avoids double-fire)
      try {
        await runFive9ConfigSnapshot();
      } catch (err) {
        console.error('[Five9Snapshot] daily run failed:', err.message);
      }
    }
  };
  snapshotTimer = setInterval(checkAndRun, 5 * 60 * 1000);
}

export function stopFive9ConfigSnapshotScheduler() {
  if (snapshotTimer) { clearInterval(snapshotTimer); snapshotTimer = null; }
}
