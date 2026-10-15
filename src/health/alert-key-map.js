/**
 * alert-key-map.js — legacy alert_conditions rows → incidents
 * (System Health Phase 1.4, 2026-10-15).
 *
 * The watchdogs that predate the platform keep posting exactly as they do
 * (alert_conditions + their own cards). This maps the keys that belong to a
 * registry check onto an incident, so the command center shows them in one
 * place, and sets alert_conditions.incident_id:
 *
 *   drift:ghl_closed_lp_active:<contact>      → sync.appt_parity, ONE incident
 *                                               for the whole set (members in detail)
 *   ci:recording_archive_unreachable          → ci.recording_archive
 *   capacity_ranker:campaign_not_running:<c>  → dialer.campaign_running, one per
 *                                               campaign (same fingerprint the
 *                                               health-checks job writes)
 *
 * Polled by the incident notifier every minute (it also adopts rows that were
 * already firing before this shipped), and nudged from reportAlertCondition on
 * a mapped key. A set that stops firing goes to verifying, and resolves once it
 * has stayed clear LEGACY_CLEAR_MS. Nothing here sends anything.
 *
 * LEGACY_ALERT_SUPPRESS_MAPPED=true (only with INCIDENT_NOTIFIER_MODE=live)
 * silences the legacy card for a mapped key so the incident card takes over.
 */

import supabase from '../supabase.js';
import { loadHealthChecks } from './registry.js';
import { openOrTouchIncident, transition, NON_TERMINAL } from './incidents.js';

export const LEGACY_CLEAR_MS = 10 * 60_000;
const MEMBERS_CAP = 200;

export const LEGACY_MAP = Object.freeze([
  Object.freeze({ prefix: 'drift:ghl_closed_lp_active:', check_id: 'sync.appt_parity', severity: 'P2', set_valued: true,
    fingerprint: 'sync.appt_parity:drift_ghl_closed_lp_active', title: 'Appointments closed in GHL but still open in Lead Perfection',
    summaryOf: (n) => `${n} contact${n === 1 ? ' has' : 's have'} an appointment closed in GHL that is still open in Lead Perfection.` }),
  Object.freeze({ prefix: 'ci:recording_archive_unreachable', check_id: 'ci.recording_archive', severity: 'P3', set_valued: false, exact: true,
    fingerprint: 'ci.recording_archive', title: "Can't reach the call recordings",
    summaryOf: () => "The call recordings can't be reached, so phone calls aren't being analyzed." }),
  Object.freeze({ prefix: 'capacity_ranker:campaign_not_running:', check_id: 'dialer.campaign_running', severity: 'P1', set_valued: false,
    fingerprintOf: (key) => `dialer.campaign_running:${key.slice('capacity_ranker:campaign_not_running:'.length)}` }),
]);

/** The mapping for one alert key, or null. Pure. */
export function mapAlertKey(key) {
  const k = String(key || '');
  const m = LEGACY_MAP.find((x) => (x.exact ? k === x.prefix : k.startsWith(x.prefix)));
  if (!m) return null;
  return { ...m, fingerprint: m.fingerprint || m.fingerprintOf(k) };
}

/** Should the legacy card for this key stay quiet (the incident card took over)? Pure. */
export function legacyPostSuppressed(key, env = process.env) {
  return String(env.LEGACY_ALERT_SUPPRESS_MAPPED || 'false').toLowerCase() === 'true'
    && String(env.INCIDENT_NOTIFIER_MODE || '').toLowerCase() === 'live'
    && !!mapAlertKey(key);
}

/**
 * Bring every mapped legacy condition up to date. Returns
 * { opened, touched, verifying, resolved, linked }. Throws only on a failed
 * alert_conditions read (the notifier records it and carries on).
 */
export async function syncLegacyIncidents({ client = supabase, registry, nowMs = Date.now(), only = null } = {}) {
  const reg = registry || (await loadHealthChecks({ client, nowMs }));
  const out = { opened: 0, touched: 0, verifying: 0, resolved: 0, linked: 0, health: [] };
  for (const m of only ? LEGACY_MAP.filter((x) => x === only) : LEGACY_MAP) {
    const q = m.exact
      ? client.from('alert_conditions').select('alert_key, state, incident_id, first_seen_at').eq('alert_key', m.prefix)
      : client.from('alert_conditions').select('alert_key, state, incident_id, first_seen_at').like('alert_key', `${m.prefix}%`);
    const { data: rows, error } = await q;
    if (error) throw new Error(`alert_conditions read (${m.prefix}): ${error.message}`);
    // PostgREST `like` treats `_` as a wildcard; re-filter exactly.
    const mine = (rows || []).filter((r) => (m.exact ? r.alert_key === m.prefix : String(r.alert_key).startsWith(m.prefix)));

    const groups = new Map();
    for (const r of mine) {
      const fp = m.fingerprint || m.fingerprintOf(r.alert_key);
      if (!groups.has(fp)) groups.set(fp, []);
      groups.get(fp).push(r);
    }
    // An incident whose rows all disappeared (pruned) still needs closing out.
    const { data: openIncs } = await client.from('incidents').select('*').eq('check_id', m.check_id).in('status', NON_TERMINAL);
    for (const inc of openIncs || []) {
      if (inc.data?.source === 'legacy' && !groups.has(inc.fingerprint)) groups.set(inc.fingerprint, []);
    }

    // A check that exists only through its legacy alert (ci.recording_archive)
    // gets its result from the alert row, so the board is not blank for it.
    if (m.exact && reg.get(m.check_id) && !reg.get(m.check_id).owner_job_id) {
      const firing = mine.some((r) => r.state === 'firing');
      out.health.push({
        check_id: m.check_id, status: mine.length ? (firing ? 'fail' : 'pass') : 'pass',
        summary: firing ? (m.summaryOf ? m.summaryOf(firing) : 'A problem is open.') : (m.check_id === 'ci.recording_archive' ? 'The call recordings can be reached.' : 'No problem open.'),
        fingerprint: m.fingerprint,
      });
    }

    for (const [fp, list] of groups) {
      const firing = list.filter((r) => r.state === 'firing');
      const row = reg.get(m.check_id);
      if (firing.length) {
        const member = m.set_valued ? null : fp.slice(fp.indexOf(':') + 1);
        const res = await openOrTouchIncident({
          check_id: m.check_id, fingerprint: fp, severity: m.severity, system: row?.system || 'webhooks',
          title: m.title || `${row?.label || m.check_id}${member ? ` — ${member}` : ''}`,
          // 2026-10-15: plain words, never the alert key.
          summary: m.summaryOf ? m.summaryOf(firing.length) : `${row?.label || m.check_id}: a problem is open (${firing.length} alert${firing.length === 1 ? '' : 's'}).`,
          business_impact: row?.business_impact || null,
          detail: { members: firing.slice(0, MEMBERS_CAP).map((r) => r.alert_key), members_total: firing.length, source: 'alert_conditions' },
          nowMs: Math.min(nowMs, ...firing.map((r) => Date.parse(r.first_seen_at) || nowMs)),
        }, { client });
        const inc = res.incident;
        if (!inc) continue;
        if (res.created) out.opened += 1; else out.touched += 1;
        if (inc.data?.source !== 'legacy' || inc.data?.legacy_cleared_at) {
          const data = { ...(inc.data || {}), source: 'legacy', legacy_cleared_at: null };
          await client.from('incidents').update({ data, last_seen_at: new Date(nowMs).toISOString() }).eq('id', inc.id);
          inc.data = data;
        }
        // A cleared set that came back: verifying → investigating (a reopen).
        if (inc.status === 'verifying') {
          await transition(inc.id, 'investigating', { actor: 'system', body: 'The problem came back.', nowMs }, { client });
        }
        const unlinked = firing.filter((r) => r.incident_id !== inc.id).map((r) => r.alert_key);
        for (let i = 0; i < unlinked.length; i += 200) {
          const chunk = unlinked.slice(i, i + 200);
          const up = await client.from('alert_conditions').update({ incident_id: inc.id }).in('alert_key', chunk).select('alert_key');
          if (!up.error) out.linked += (up.data || []).length;
        }
        continue;
      }
      // Nothing firing: move the open legacy incident toward resolved.
      const { data: incs } = await client.from('incidents').select('*').eq('fingerprint', fp).in('status', NON_TERMINAL).limit(1);
      const inc = incs?.[0];
      if (!inc || inc.data?.source !== 'legacy') continue;
      if (['open', 'acknowledged', 'investigating', 'fixing'].includes(inc.status)) {
        await transition(inc.id, 'verifying', { actor: 'system', body: 'The problem cleared; checking that it stays fixed.', nowMs, data: { legacy_cleared_at: new Date(nowMs).toISOString() } }, { client });
        out.verifying += 1;
      } else if (inc.status === 'verifying') {
        const since = Date.parse(inc.data?.legacy_cleared_at || '') || nowMs;
        if (nowMs - since >= LEGACY_CLEAR_MS) {
          await transition(inc.id, 'resolved', { actor: 'system', verified_by: 'system', body: `Stayed clear for ${Math.round((nowMs - since) / 60000)} minutes.`, nowMs }, { client });
          out.resolved += 1;
        }
      }
    }
  }
  return out;
}

/** Fire-and-forget nudge from reportAlertCondition for a mapped key. Never throws. */
export function nudgeLegacyKey(key, { client, nowMs } = {}) {
  const m = mapAlertKey(key);
  if (!m) return false;
  const base = LEGACY_MAP.find((x) => x.prefix === m.prefix);
  Promise.resolve()
    .then(() => syncLegacyIncidents({ client: client || supabase, nowMs: nowMs ?? Date.now(), only: base }))
    .catch((err) => console.warn(`[LegacyIncidents] ${key}: ${err.message}`));
  return true;
}
