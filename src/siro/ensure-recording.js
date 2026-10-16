/**
 * Ensure-on-demand — src/siro/ensure-recording.js (2026-10-16, Siro PR 1)
 *
 * For a post-demo / rehash lead with no stored recording yet: ONE user-scoped
 * list call by phone, dateCreated within ±3 days of the demo, at most 2
 * seconds. The outcome ("row" or "none") is cached per lead for 15 minutes
 * so a busy thread does not ask Siro on every turn. Any failure is "nothing"
 * (CANON.K.070): the caller goes on without the visit.
 *
 * SIRO_ENSURE_MODE off (default) | live. The reply path still reads only
 * Supabase; this writes the row there first.
 */
import * as siroDefault from './client.js';
import { listRows } from './client.js';
import { processRecording } from './ingest.js';
import { siroModes, siroConfig } from './config.js';
import { normalizePhone10 } from '../lead-leak-classify.js';

const CACHE_MS = 15 * 60_000;
const BUDGET_MS = 2000;
const WINDOW_MS = 3 * 86_400_000;
const cache = new Map(); // ensure:<lp_lead_id> → { at, result }

export function _resetEnsureCacheForTests() { cache.clear(); }

/**
 * @param {{lp_lead_id, phone, demo_date, appointment_date}} lead
 * @returns {Promise<'row'|'none'|'off'|'cached_row'|'cached_none'>}
 */
export async function ensureRecordingForLead(lead, { env = process.env, deps = {}, nowMs = Date.now() } = {}) {
  if (siroModes(env).ensure !== 'live') return 'off';
  const key = `ensure:${lead?.lp_lead_id || ''}`;
  const hit = cache.get(key);
  if (hit && nowMs - hit.at < CACHE_MS) return hit.result === 'row' ? 'cached_row' : 'cached_none';
  const remember = (result) => { cache.set(key, { at: nowMs, result }); return result; };

  const phone = normalizePhone10(lead?.phone);
  const demoMs = Date.parse(lead?.demo_date || lead?.appointment_date || '');
  if (!lead?.lp_lead_id || !phone || !Number.isFinite(demoMs)) return remember('none');

  const siro = deps.siro || siroDefault;
  const work = (async () => {
    const res = await siro.listRecordingsUserScoped({
      'dateCreated:gt': new Date(demoMs - WINDOW_MS).toISOString(),
      'dateCreated:lt': new Date(demoMs + WINDOW_MS).toISOString(),
      conversationType: siroConfig(env).presentationConversationType || undefined,
      limit: 100,
    }, { env });
    if (!res.ok) return 'none';
    const match = listRows(res.data).find(r => {
      const c = r?.crmCustomer || {};
      return normalizePhone10(c.phone || c.phoneNumber || r?.contactPhone) === phone;
    });
    if (!match?.id) return 'none';
    const out = await processRecording(String(match.id), { source: 'ensure', mode: 'shadow', env, deps });
    return out.row?.lp_lead_id ? 'row' : 'none';
  })().catch(() => 'none');
  const timeout = new Promise(r => setTimeout(() => r('none'), BUDGET_MS).unref?.());
  return remember(await Promise.race([work, timeout]));
}
