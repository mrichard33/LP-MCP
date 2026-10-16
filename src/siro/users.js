/**
 * Siro user names — src/siro/users.js (2026-10-16)
 *
 * Siro's recording carries a userId, not the rep's name (all 118 first rows
 * had rep_name empty). The follow-up block names the rep when Siro wrote one;
 * otherwise this map (GET /core/users, user-scoped, needs the client app) does.
 * Cached for a day; a failed read is an empty map, never an error.
 */
import * as siroDefault from './client.js';
import { listRows } from './client.js';

const DAY_MS = 86_400_000;
let cache = { at: 0, map: null };
export function _resetSiroUsersForTests() { cache = { at: 0, map: null }; }

export async function siroUserNames({ siro = siroDefault, nowMs = Date.now() } = {}) {
  if (cache.map && nowMs - cache.at < DAY_MS) return cache.map;
  const map = new Map();
  try {
    const res = await siro.listUsers();
    if (res?.ok) {
      for (const u of listRows(res.data)) {
        if (!u?.id) continue;
        const name = u.name || u.displayName || [u.firstName, u.lastName].filter(Boolean).join(' ') || null;
        map.set(String(u.id), { name: name ? String(name).trim() : null, email: u.email ? String(u.email).toLowerCase() : null });
      }
      cache = { at: nowMs, map };
    }
  } catch { /* an empty map: the follow-up's repName still names most reps */ }
  return map;
}
