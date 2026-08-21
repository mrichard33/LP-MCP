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
//   is worse than no change log at all. The SAME-DAY DELTA canary below exists
//   for exactly that, and it is why a same-day re-run is worth running.
//   role_permissions was the one array caught this way (see sortUnorderedArrays).
//
// SAME-DAY DELTAS (formerly "unstable hashes")
//   A config that differs between two runs on ONE day is a same-day delta, and
//   that is ALL it is. Serialization noise and a real admin-UI edit both look
//   like this; the only discriminator is path shape — noise lands on
//   bracket-indexed siblings, a real edit on a named scalar.
//
//   The job used to count these and DISCARD the diff. That suppressed real
//   edits: action 283639 (previewDialImmediately on DIAL ASAP, 2026-08-06
//   19:44:50Z) landed between two runs and left five9_config_changes empty for
//   a change attributable to the second. Every delta is now written and tagged
//   `detection = 'same_day' | 'cross_day'` (sql/056); separating noise from
//   edits is a query, not a decision made before persistence. The count stays
//   as a canary — it is how the 11 admin users were found — but gates nothing.
//
//   This also means the CHANGE LOG, not the snapshot table, is the system of
//   record for intra-day history: five9_config_snapshots is UNIQUE per
//   (snapshot_date, entity_type, entity_name) and same-day runs upsert, so a
//   day can structurally hold only one snapshot row per entity.
//
// LOCKED ENTITIES
//   An object held open in the Five9 admin UI reads back as a SOAP fault
//   ("... is already locked"). That is a transient, expected condition, so it
//   is its own state (`locked` / `entities_locked`) rather than an error — a
//   frequently-edited campaign would otherwise be a permanent error in every
//   run, and a permanently-red benign signal just teaches people to ignore the
//   field. It is still a capture GAP for that entity that day: no snapshot row
//   is written, so the next successful run diffs against the last good one.
//
// CREDENTIALS ARE NEVER PERSISTED (vcc_configuration, added 2026-08-21)
//   The domain VCC config is the one snapshotted entity that carries
//   passwords — recordingsServer, reportsServer and transcriptsServer each
//   hold one, and each block appears twice in the reader's output (promoted
//   to the top level, and again under `raw`). getVCCConfiguration redacts
//   them at the source via redactPasswords(), so what reaches this job is
//   already [REDACTED] and there is no second redaction step here to forget.
//
//   Empty passwords stay empty rather than becoming [REDACTED]: Reece runs no
//   Reports Server by design, and that blank is a legitimate posture worth
//   having on record, not an anomaly to paper over. The useful consequence is
//   that a blank→configured transition still shows up in the change log; the
//   accepted cost is that a password ROTATION does not, since both sides read
//   [REDACTED]. Storing the credential to make rotations diffable is exactly
//   what this must not do.
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
  getVCCConfiguration,
  timerToSeconds,
} from '../five9-admin.js';
import { getUsersFullInfo } from '../five9-users-info.js';

const SNAPSHOT_ENABLED = process.env.FIVE9_CONFIG_SNAPSHOT_ENABLED === 'true';
const SNAPSHOT_HOUR_ET = parseInt(process.env.FIVE9_CONFIG_SNAPSHOT_HOUR_ET || '4', 10);
const SOAP_DELAY_MS = Math.max(0, parseInt(process.env.FIVE9_SNAPSHOT_DELAY_MS || '250', 10));
const UPSERT_CHUNK = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Composite-key separator for priorByKey. NUL cannot occur in a Five9 entity
// name, so it can never collide. Exported so callers build the same key.
export const NUL_SEP = '\u0000';
export const priorKey = (entity_type, entity_name) => `${entity_type}${NUL_SEP}${entity_name}`;

/**
 * entity_name for the vcc_configuration singleton.
 *
 * Every other entity type is a collection keyed by its own Five9 name. VCC
 * config is one object per domain, so it needs a name chosen rather than read.
 * A FIXED literal, deliberately — not domainName or domainId. Those are
 * fields OF the config, and using one as the row key would mean a domain
 * rename reads as "the old entity vanished and a new one appeared" instead of
 * as the one-field diff it actually is, breaking continuity of the change log
 * at exactly the moment it matters most.
 */
export const VCC_ENTITY_NAME = 'domain';

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

/**
 * Sort the arrays Five9 returns in NO GUARANTEED ORDER.
 *
 * Deliberately narrow. The general rule (see HASHING RULE in the header) is
 * that array order is preserved and never sorted, because order is meaningful
 * in includeNumbers and in list priority — sorting those would hide real
 * changes. `role_permissions` is the documented exception: it is a permission
 * SET, its order carries no information, and getUsersInfo demonstrably returns
 * it shuffled between calls.
 *
 * Measured 2026-08-06: all 11 users holding the ADMIN role hashed differently
 * across two runs 30s apart, every one of them differing only on consecutive
 * bracket-indexed siblings of role_permissions.admin. Left alone, the change
 * log would have fired on those 11 users every single day forever.
 *
 * Applied at CAPTURE, not just before hashing, so the stored config, the hash,
 * and the field-level diff all agree. Sorting only for the hash would stop the
 * false firing but leave the change log emitting a wall of bogus reordering
 * rows on the day a permission genuinely changes.
 *
 * All role keys are sorted, not just `admin`. Only `admin` was observed
 * unstable, but `agent` (41 users), `reporting` (16) and `supervisor` (14) are
 * multi-element too and carry order no more meaningfully; sorting an already
 * stable array is a no-op, so this costs nothing and closes the same trap.
 */
export function sortUnorderedArrays(entityType, config) {
  if (entityType !== 'user') return config;
  const rp = config?.role_permissions;
  if (!rp || typeof rp !== 'object' || Array.isArray(rp)) return config;
  // type is the natural key; canonicalJson is appended so equal types (or
  // elements with no type at all) still order deterministically.
  const sortKey = (p) => `${p?.type ?? ''}${NUL_SEP}${canonicalJson(p)}`;
  const sorted = {};
  for (const [role, perms] of Object.entries(rp)) {
    sorted[role] = Array.isArray(perms)
      ? [...perms].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
      : perms;
  }
  return { ...config, role_permissions: sorted };
}

const TIMER_KEYS = ['days', 'hours', 'minutes', 'seconds'];

/** A tns:timer struct: only timer keys, all values whole numbers. */
export function isTimerStruct(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length > 0
    && keys.every((k) => TIMER_KEYS.includes(k))
    && keys.every((k) => /^\d+$/.test(String(v[k])));
}

/**
 * Collapse every tns:timer struct to its total in seconds, recursively.
 *
 * HASH-ONLY (like stripVolatile): the stored config keeps the struct, which is
 * the shape Five9 actually returned. This makes the hash immune to Five9
 * representing one duration two ways — {minutes:1,seconds:0} and
 * {minutes:0,seconds:60} are both 60.
 *
 * NOTE ON WHY THIS IS HERE: it is defensive, not a diagnosed fix. The one
 * timer entity flagged unstable (campaign_outbound/After DIAL ASAP, on
 * raw.maxPreviewTime.minutes and .seconds) does NOT appear to be a
 * representation flap — two consecutive live reads returned an identical
 * {minutes:0,seconds:20}, and every stored campaign normalizes consistently
 * (120s is always {minutes:2,seconds:0}, never {seconds:120}). That one looks
 * like a real admin-UI edit landing between two same-day runs. This transform
 * would not have suppressed it, and should not have: 20 and 120 still differ.
 *
 * Uses timerToSeconds from five9-admin.js — the same struct arithmetic behind
 * maxQueueTimeSeconds on the read path and timerStructToSeconds in the
 * write-side read-back verifier. One normalization, three call sites.
 */
export function normalizeTimers(value) {
  if (Array.isArray(value)) return value.map(normalizeTimers);
  if (value && typeof value === 'object') {
    if (isTimerStruct(value)) return timerToSeconds(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalizeTimers(v);
    return out;
  }
  return value;
}

export function configHash(entityType, config) {
  return crypto.createHash('sha256')
    .update(canonicalJson(normalizeTimers(stripVolatile(entityType, config))))
    .digest('hex');
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

/**
 * A Five9 entity held open in the admin UI reads back as a SOAP fault
 * ("... is already locked"), not as data. That is a TRANSIENT, EXPECTED
 * condition — somebody is editing the campaign — and it is categorically
 * different from a read that failed.
 *
 * It gets its own state rather than living in errors[] because a campaign that
 * is edited often would otherwise show up as a permanent error in every single
 * run. A permanently-red signal that is actually benign is the same failure
 * mode as a `verified` flag that is always false: it trains everyone to stop
 * reading the field. Locked entities are reported, counted separately, and
 * kept out of the degraded-event denominator.
 */
export function isLockedError(message) {
  return /\balready locked\b/i.test(String(message ?? ''));
}

/** Cap on paths reported per same-day delta. The total count is always exact. */
export const SAME_DAY_PATH_CAP = 25;

/**
 * Summarize an entity whose config changed between two runs on the SAME DAY.
 *
 * This was called an "unstable hash" and the name did the thinking. What the
 * branch detects is a same-day delta — nothing more. Serialization noise and a
 * real admin-UI edit both produce one, and the ONLY discriminator is the shape
 * of the paths: noise lands on bracket-indexed siblings
 * (role_permissions.admin[0].type), a real edit on a named scalar
 * (raw.previewDialImmediately). That is a reading of the data, not a property
 * the job can decide before persisting, which is why this summary is now a
 * canary only and no longer gates whether change rows get written.
 *
 * The count alone is unactionable: "11 of 272" gives no way to find the eleven.
 * Both configs are already in hand at the call site, so the paths cost nothing.
 *
 * Values are deliberately NOT included — they are recorded on the change rows
 * themselves, and this summary travels into an event payload.
 */
export function sameDayDeltaEntry(entity_type, entity_name, diffRows, cap = SAME_DAY_PATH_CAP) {
  const paths = (diffRows || []).map((d) => d.field_path);
  const entry = {
    entity_type,
    entity_name,
    differing_paths: paths.slice(0, cap),
    differing_path_count: paths.length,
    // Reordering noise is all bracket-indexed; a named scalar path means
    // something was actually edited. Surfaced so the canary is readable at a
    // glance without re-deriving it from the path list every time.
    has_named_path: paths.some((p) => !/\[\d+\]/.test(p)),
  };
  // Never truncate silently — a capped list must say so, or it reads as complete.
  if (paths.length > cap) entry.truncated = true;
  return entry;
}

/**
 * Build the change rows for one run, plus the same-day canary entries.
 *
 * A same-day prior row used to short-circuit the whole thing: the delta was
 * counted as an "unstable hash" and the diff thrown away, on the theory that a
 * same-day delta meant serialization noise. It threw away real edits too. On
 * 2026-08-06 action 283639 set previewDialImmediately false -> true on DIAL
 * ASAP at 19:44:50Z; the preceding snapshot ran 19:42:40Z holding `false`. The
 * next run saw the delta, called it unstable, and dropped it — leaving
 * five9_config_changes empty for a change attributable to the second.
 *
 * Detecting a change and declining to record it is the one behavior a change
 * log cannot have. Every delta is written and TAGGED with how it was found;
 * telling noise from real edits is a query over field_path, not a decision made
 * before persistence.
 *
 * Pure and exported so that decision is testable without Supabase — it is the
 * function that decides whether a real edit survives.
 */
export function buildChangeRows(entities, priorByKey, snapshot_date) {
  const changeRows = [];
  const same_day_delta_entities = [];

  for (const e of entities || []) {
    const prior = priorByKey.get(priorKey(e.entity_type, e.entity_name));
    if (!prior) continue;                                   // first sighting
    if (prior.config_hash === e.config_hash) continue;       // unchanged

    const same_day = prior.snapshot_date >= snapshot_date;
    const diffs = diffConfigs(prior.config, e.config);

    // Canary bookkeeping ONLY — it no longer gates whether rows are written.
    if (same_day) same_day_delta_entities.push(sameDayDeltaEntry(e.entity_type, e.entity_name, diffs));

    for (const d of diffs) {
      changeRows.push({
        entity_type: e.entity_type,
        entity_name: e.entity_name,
        field_path: d.field_path,
        previous_value: d.previous_value,
        new_value: d.new_value,
        // NULL on same-day rows: five9_config_snapshots is UNIQUE per
        // (date, type, name) and this run's upsert already overwrote that row
        // with the NEW config, so the id would resolve to the wrong value. A
        // foreign key pointing at the wrong thing is worse than no foreign key
        // — previous_value carries the truth.
        previous_snapshot_id: same_day ? null : prior.id,
        detection: same_day ? 'same_day' : 'cross_day',
      });
    }
  }
  return { changeRows, same_day_delta_entities };
}

/* ---------------------------------------------------------------------- *
 * Collection — every reader already exists; this only sequences them.
 * ---------------------------------------------------------------------- */

async function collectEntities(errors, locked) {
  const entities = [];
  const push = (entity_type, entity_name, config) => {
    // Normalize at capture so the stored config, the hash, and the diff agree.
    if (entity_name) entities.push({ entity_type, entity_name: String(entity_name), config: sortUnorderedArrays(entity_type, config) });
  };
  // One entity failing must never abort the run.
  const attempt = async (label, fn) => {
    try {
      await fn();
    } catch (err) {
      // A lock is somebody editing in the admin UI, not a failure — see
      // isLockedError. It is still a capture GAP for that entity today, so it
      // is reported, just not as an error.
      if (isLockedError(err.message)) {
        console.warn(`[Five9Snapshot] ${label} LOCKED in the Five9 admin UI — not captured this run: ${err.message}`);
        locked.push({ entity: label, reason: err.message });
      } else {
        console.warn(`[Five9Snapshot] ${label} failed: ${err.message}`);
        errors.push({ entity: label, error: err.message });
      }
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
  await attempt('vcc_configuration', async () => {
    const vcc = await getVCCConfiguration();
    // The reader returns { error } instead of throwing when the SOAP body
    // carries no <return> block. Throw so it lands in errors[] like any other
    // failed read — persisting the error object as a config would write a
    // junk snapshot row AND emit a change-log entry for every field of the
    // real config "disappearing".
    if (vcc?.error) throw new Error(vcc.error);
    push('vcc_configuration', VCC_ENTITY_NAME, vcc);
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
  const locked = [];

  if (!supabase) {
    const summary = { snapshot_date, entities_captured: 0, changes_detected: 0, same_day_deltas: 0, same_day_delta_entities: [], unstable_hashes: 0, entities_locked: 0, locked: [], errors: [{ entity: 'supabase', error: 'Supabase not configured' }] };
    console.error('[Five9Snapshot] Supabase not configured — aborting');
    lastRun = { ...summary, finished_at: new Date().toISOString() };
    return summary;
  }

  const entities = await collectEntities(errors, locked);
  console.log(`[Five9Snapshot] collected ${entities.length} entities (${errors.length} read errors, ${locked.length} locked)`);

  let changes_detected = 0;
  const same_day_delta_entities = [];
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
      const key = priorKey(row.entity_type, row.entity_name);
      const existing = priorByKey.get(key);
      // Re-derive the prior side under the CURRENT rules rather than trusting
      // the stored hash. A stored hash was computed under whatever rules were in
      // force that day, and comparing an old-rules hash against a new-rules hash
      // is meaningless — it reports "changed" for every entity the moment
      // hashing changes. Normalizing both sides means a rules change (like the
      // role_permissions sort landing here) migrates silently instead of dumping
      // a day of phantom rows into the change log.
      if (!existing || row.snapshot_date > existing.snapshot_date) {
        const config = sortUnorderedArrays(row.entity_type, row.config);
        priorByKey.set(key, { ...row, config, config_hash: configHash(row.entity_type, config) });
      }
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
    const summary = { snapshot_date, entities_captured: 0, changes_detected: 0, same_day_deltas: 0, same_day_delta_entities: [], unstable_hashes: 0, entities_locked: locked.length, locked, errors, elapsed_ms: Date.now() - startedAt };
    lastRun = { ...summary, finished_at: new Date().toISOString() };
    return summary;
  }

  const { changeRows, same_day_delta_entities: sameDay } = buildChangeRows(entities, priorByKey, snapshot_date);
  same_day_delta_entities.push(...sameDay);
  for (const entry of sameDay) {
    console.warn(`[Five9Snapshot] SAME-DAY DELTA — ${entry.entity_type}/${entry.entity_name} changed within ${snapshot_date} at ${entry.differing_path_count} path(s): ${entry.differing_paths.join(', ')}${entry.truncated ? ', …' : ''} — ${entry.has_named_path ? 'a named path means something was edited' : 'all bracket-indexed, consistent with unstable array order'}`);
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
    same_day_deltas: same_day_delta_entities.length,
    // The identities behind the count. Without these the count is unactionable.
    same_day_delta_entities,
    // Deprecated alias, kept so existing eyes and queries do not break
    // silently. `unstable` was always the wrong word: a same-day delta is just
    // as often a real edit, and it no longer decides anything.
    unstable_hashes: same_day_delta_entities.length,
    entities_locked: locked.length,
    locked,
    errors,
    elapsed_ms: Date.now() - startedAt,
  };
  console.log(`[Five9Snapshot] ${snapshot_date}: ${summary.entities_captured} captured, ${changes_detected} changes, ${summary.same_day_deltas} same-day delta(s), ${locked.length} locked, ${errors.length} errors (${summary.elapsed_ms}ms)`);

  // Degraded when more than half the reads failed. Locked entities are NOT
  // errors and stay out of this count — an admin holding a campaign open is a
  // capture gap, not a broken job, and must not drift the run toward a
  // degraded alert. bypass_filter is required: applyIntakeFilter drops event
  // types with no active rule consumer, and this type has none — without it
  // the degraded signal disappears silently.
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
