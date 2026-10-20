// ─── Partner owner routes — src/partners/routes.js ───────────────────────────
//
// POST /n8n/admin/partner-owner/run    { lp_lead_id?, dry_run = true }
//   With lp_lead_id: decides that lead now (dry run by default: the plan, no write,
//   no log). A lead created before go-live reports skipped_pre_golive plus
//   would_assign_if_eligible, so the RFED test lead shows Ross. Without lp_lead_id
//   and dry_run false: one fast-poll tick.
// GET  /n8n/admin/partner-owner/status
//   enabled, last tick, cursor, average lag (LP change → GHL write) over 24 h, the
//   last 20 log rows, and the contacts THIS code assigned and has not handed back
//   (partner_owner_assignments, handoff v3: only those are ever returned).
//
// These write GHL owners, so they take a STRICT operator check (no soft launch):
// production runs AUTH_SOFT_LAUNCH=true, which would let a token-less request in.

import { syncPartnerOwner, partnerSyncConfig } from './owner-sync.js';
import { loadPartnerMap } from './owner-resolver.js';
import { CURSOR_ID, runPartnerFastPollTick, tickState, pollIntervalMs } from '../jobs/partner-fast-poll.js';
import { denyAll } from '../auth.js';

const LEAD_COLUMNS = 'lp_lead_id, lp_prospect_id, lp_branch_id, rep_name, ghl_contact_id, created_at_lp, updated_at_lp';

/** Pure: mean seconds from LP's change to our write, over write rows. */
export function averageLagSeconds(rows) {
  const lags = (rows || [])
    .map((r) => (Date.parse(r.created_at) - Date.parse(r.lp_changed_at)) / 1000)
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (!lags.length) return null;
  return Math.round(lags.reduce((a, b) => a + b, 0) / lags.length);
}

export function registerPartnerOwnerRoutes(app, { authenticate = denyAll, deps = {} } = {}) {
  const db = async () => deps.supabase || (await import('../supabase.js')).default;

  app.post('/n8n/admin/partner-owner/run', authenticate, async (req, res) => {
    const body = req.body || {};
    const dryRun = body.dry_run !== false;
    const leadId = body.lp_lead_id != null ? String(body.lp_lead_id).trim() : '';
    try {
      if (!leadId) {
        if (dryRun) return res.status(400).json({ ok: false, error: 'lp_lead_id is required for a dry run' });
        const tick = await runPartnerFastPollTick();
        return res.json({ ok: true, tick });
      }
      const { data: lead, error } = await (await db()).from('lp_leads').select(LEAD_COLUMNS).eq('lp_lead_id', leadId).maybeSingle();
      if (error) return res.status(500).json({ ok: false, error: error.message });
      if (!lead) return res.status(404).json({ ok: false, error: `no lp_leads row ${leadId}` });
      const result = await syncPartnerOwner(lead, { dryRun, deps });
      return res.json({ ok: true, dry_run: dryRun, lead: { lp_branch_id: lead.lp_branch_id, rep_name: lead.rep_name, ghl_contact_id: lead.ghl_contact_id }, result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/n8n/admin/partner-owner/status', authenticate, async (_req, res) => {
    try {
      const client = await db();
      const cfg = partnerSyncConfig(deps.env || process.env);
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const [cursor, writes, recent, map, open] = await Promise.all([
        client.from('partner_owner_cursor').select('last_changed_at, updated_at').eq('id', CURSOR_ID).maybeSingle(),
        client.from('partner_owner_log').select('created_at, lp_changed_at')
          .gte('created_at', since).in('reason', ['assigned', 'reassigned', 'returned']).limit(1000),
        client.from('partner_owner_log').select('*').order('created_at', { ascending: false }).limit(20),
        loadPartnerMap({ supabase: client }).catch((e) => ({ error: e.message })),
        client.from('partner_owner_assignments').select('ghl_contact_id, partner_name, ghl_user_id, assigned_at')
          .is('released_at', null).order('assigned_at', { ascending: false }).limit(200),
      ]);
      return res.json({
        ok: true,
        enabled: cfg.enabled,
        disabled_reason: cfg.reason,
        go_live_at: Number.isFinite(cfg.goLiveMs) ? new Date(cfg.goLiveMs).toISOString() : null,
        default_owner: cfg.defaultOwner,
        poll_interval_ms: pollIntervalMs(deps.env || process.env),
        last_tick_at: tickState.lastTickAt,
        last_tick: tickState.lastResult,
        cursor: cursor.data || null,
        writes_24h: (writes.data || []).length,
        average_lag_seconds_24h: averageLagSeconds(writes.data),
        mappings: map,
        open_assignments_count: (open.data || []).length,
        open_assignments: open.error ? { error: open.error.message } : (open.data || []),
        recent: recent.data || [],
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });
}
