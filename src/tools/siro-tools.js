/**
 * Siro MCP tools — src/tools/siro-tools.js (2026-10-16, Siro PR 1)
 *
 * Exactly seven, siro_ prefix (CANON.K.032 / K.034: few, narrow, each says
 * when to use it and what NOT to conclude). Read-only, except siro_sync_run,
 * which is a dry run unless dry_run=false. Nothing Siro-related lives in
 * HL-MCP.
 */
import { z } from 'zod';
import supabase from '../supabase.js';
import * as siro from '../siro/client.js';
import { listRows } from '../siro/client.js';
import { normalizeRecording } from '../siro/normalize.js';
import { buildPresentationFacts, renderPresentationBlock } from '../siro/presentation-facts.js';
import { buildDemoNote } from '../siro/demo-note.js';
import { siroConfig, siroModes } from '../siro/config.js';
import { previewF0Generation } from '../siro/f0-preview.js';
import { runSiroRecordingSync } from '../jobs/siro-recording-sync.js';
import { resolveOrganizationId, monthStartIso } from '../jobs/siro-rep-scorecard-sync.js';
import { normalizePhone10 } from '../lead-leak-classify.js';

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const ROW_COLS = 'recording_id, rep_name, rep_email, result, recorded_at, updated_at_siro, deleted, processed, linked, match_method, lp_lead_id, lp_prospect_id, ghl_contact_id, customer_phone, followup_score, followup_status, followup_action, summary, moments, source, event_emitted_at, ghl_note_action_id, context_ready';

async function rowsFor({ lp_lead_id, lp_prospect_id, ghl_contact_id }, limit = 10) {
  let q = supabase.from('siro_recordings').select(ROW_COLS).order('recorded_at', { ascending: false }).limit(limit);
  if (lp_lead_id) q = q.eq('lp_lead_id', String(lp_lead_id));
  else if (lp_prospect_id) q = q.eq('lp_prospect_id', String(lp_prospect_id));
  else if (ghl_contact_id) q = q.eq('ghl_contact_id', String(ghl_contact_id));
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

export function registerSiroTools(server) {
  server.tool(
    'siro_whoami',
    'Check the Siro credential and setup: caller identity on BOTH Siro APIs, the integration connections (is Lead_Perfection connected?), the conversation types, the user count, and whether the webhook secrets are set (never their values). Use it first when anything Siro looks wrong. A 401 means the credential is refused, not that Siro is down.',
    {},
    async () => {
      const org = await siro.getCallerIdentity('org');
      const user = await siro.getCallerIdentity('user');
      const conns = await siro.listConnections();
      const orgId = await resolveOrganizationId({ siro });
      const types = orgId ? await siro.listConversationConfigurations(orgId) : null;
      const users = await siro.listUsers();
      const cfg = siroConfig();
      return ok({
        org_api: { status: org.status, ok: org.ok, error: org.error },
        user_api: { status: user.status, ok: user.ok, error: user.error },
        auth: cfg.clientId && cfg.clientSecret ? 'client_credentials' : (cfg.legacyToken ? 'legacy_org_token' : 'none'),
        organization_id: orgId,
        connections: listRows(conns.data).map(c => ({ id: c.id, platform: c.platform || c.type, name: c.name })),
        conversation_types: types ? listRows(types.data).map(t => ({ name: t.name || t.title || t.displayName || t.label || null, conversationType: t.conversationType, id: t.id || null })) : 'organization id unknown',
        connections_error: conns.ok ? null : `${conns.status} ${conns.error}`,
        users: users.ok ? listRows(users.data).length : users.error,
        webhook_secret: cfg.webhookSecret ? 'set' : 'NOT SET',
        modes: siroModes(),
      });
    },
  );

  server.tool(
    'siro_get_recording',
    'One Siro recording: the stored siro_recordings row plus a live fetch from Siro (normalized: summary, moments, follow-up, CRM links). include_audio_url adds a short-lived link to the REDACTED audio (never stored). Use it to see what we hold for a recording and how it matched.',
    { recording_id: z.string().min(1), include_audio_url: z.boolean().optional() },
    async ({ recording_id, include_audio_url }) => {
      const { data: stored } = await supabase.from('siro_recordings').select(ROW_COLS).eq('recording_id', recording_id).maybeSingle();
      const live = await siro.getRecording(recording_id);
      const normalized = live.ok ? normalizeRecording(live.data?.data?.id ? live.data.data : live.data, { source: 'ensure', storeRaw: false }) : null;
      let audio = null;
      if (include_audio_url) {
        const a = await siro.getRecordingAudioUrl(recording_id);
        audio = a.ok ? (a.data?.url || a.data?.signedUrl || a.data) : { error: a.error };
      }
      return ok({ stored: stored || null, live: normalized || { status: live.status, error: live.error }, audio_url: audio });
    },
  );

  server.tool(
    'siro_find_recordings',
    'Find stored Siro recordings by LP lead, LP prospect, GHL contact, phone, rep email or date range. "No rows" means we hold no recording matched to that key, NOT that there was no visit (the recording may be unmatched, not yet processed, or in Siro only: try siro_sync_run or siro_whoami).',
    {
      lp_lead_id: z.string().optional(), lp_prospect_id: z.string().optional(), ghl_contact_id: z.string().optional(),
      phone: z.string().optional(), rep_email: z.string().optional(),
      since: z.string().optional().describe('ISO date'), until: z.string().optional().describe('ISO date'),
      limit: z.number().int().positive().max(200).optional(),
    },
    async (a) => {
      let q = supabase.from('siro_recordings').select('recording_id, rep_name, rep_email, result, recorded_at, match_method, lp_lead_id, lp_prospect_id, ghl_contact_id, customer_phone, followup_score, processed, deleted, context_ready')
        .order('recorded_at', { ascending: false }).limit(a.limit || 25);
      if (a.lp_lead_id) q = q.eq('lp_lead_id', a.lp_lead_id);
      if (a.lp_prospect_id) q = q.eq('lp_prospect_id', a.lp_prospect_id);
      if (a.ghl_contact_id) q = q.eq('ghl_contact_id', a.ghl_contact_id);
      if (a.phone) q = q.eq('customer_phone', normalizePhone10(a.phone) || a.phone);
      if (a.rep_email) q = q.eq('rep_email', a.rep_email.toLowerCase());
      if (a.since) q = q.gte('recorded_at', a.since);
      if (a.until) q = q.lte('recorded_at', a.until);
      const { data, error } = await q;
      return ok(error ? { error: error.message } : { count: (data || []).length, recordings: data || [] });
    },
  );

  server.tool(
    'siro_lead_presentation',
    'The PRESENTATION block exactly as the reply writer sees it for a lead (from the newest matched Siro recording), optionally the GHL demo-note text (include_note) and a DRY RUN of the F.0 v2 text for one position 1-5 (preview_f0_position: prompt selected, text, copy-check result, interrupt; nothing is written to GHL or agentic_messages; needs ghl_contact_id). Mark\'s evidence before flipping SIRO_CONTEXT_MODE, SIRO_DEMO_NOTE_MODE or F.0. An empty block means no matched, processed recording, not that there was no visit.',
    {
      lp_lead_id: z.string().optional(), lp_prospect_id: z.string().optional(), ghl_contact_id: z.string().optional(),
      include_note: z.boolean().optional(),
      preview_f0_position: z.number().int().min(1).max(5).optional(),
    },
    async (a) => {
      if (!a.lp_lead_id && !a.lp_prospect_id && !a.ghl_contact_id) return ok({ error: 'give lp_lead_id, lp_prospect_id or ghl_contact_id' });
      const rows = await rowsFor(a);
      const facts = buildPresentationFacts(rows);
      const out = {
        recordings_found: rows.length,
        recording_id: facts?.recording_id || null,
        presentation_block: facts ? renderPresentationBlock(facts).join('\n') : '',
      };
      if (a.include_note) out.demo_note = facts ? buildDemoNote(facts) : null;
      if (a.preview_f0_position) {
        const contactId = a.ghl_contact_id || rows.find(r => r.ghl_contact_id)?.ghl_contact_id;
        out.f0_preview = contactId ? await previewF0Generation(contactId, a.preview_f0_position) : { error: 'no GHL contact for this lead' };
      }
      return ok(out);
    },
  );

  server.tool(
    'siro_rehash_priority',
    'Unsold post-demo leads ranked by Siro\'s follow-up score (5 = most worth a call), newest first within a score (v_siro_rehash_priority). Use it to pick who the rehash team calls. A missing lead was not recorded or not matched; it is not "low priority".',
    { limit: z.number().int().positive().max(200).optional(), min_score: z.number().int().min(1).max(5).optional() },
    async ({ limit, min_score }) => {
      let q = supabase.from('v_siro_rehash_priority').select('*').limit(limit || 25);
      if (min_score) q = q.gte('followup_score', min_score);
      const { data, error } = await q;
      return ok(error ? { error: error.message } : { count: (data || []).length, leads: data || [] });
    },
  );

  server.tool(
    'siro_rep_scorecard',
    'A rep\'s Siro scorecard metrics (and coaching spotlights) for a period: the stored nightly pull, else a live read for this month. Use it for coaching and rep reviews. An empty result means Siro evaluated no recordings for that rep and period.',
    {
      rep_email: z.string().optional(), siro_user_id: z.string().optional(),
      period_start: z.string().optional().describe('YYYY-MM-DD'), period_end: z.string().optional().describe('YYYY-MM-DD'),
    },
    async (a) => {
      if (!a.rep_email && !a.siro_user_id) return ok({ error: 'give rep_email or siro_user_id' });
      let q = supabase.from('siro_rep_scorecards').select('*').order('pulled_at', { ascending: false }).limit(20);
      if (a.siro_user_id) q = q.eq('siro_user_id', a.siro_user_id);
      else q = q.eq('rep_email', a.rep_email.toLowerCase());
      if (a.period_start) q = q.gte('period_start', a.period_start);
      if (a.period_end) q = q.lte('period_end', a.period_end);
      const { data, error } = await q;
      if (!error && data?.length) return ok({ source: 'stored', scorecards: data });
      // Live: find the user, then every active instance, month to date.
      let userId = a.siro_user_id;
      if (!userId) {
        const users = await siro.listUsers();
        userId = listRows(users.data).find(u => String(u.email || '').toLowerCase() === a.rep_email.toLowerCase())?.id;
      }
      if (!userId) return ok({ source: 'live', error: 'no Siro user with that email' });
      const orgId = await resolveOrganizationId({ siro });
      const inst = orgId ? await siro.listScorecardInstances(orgId, { isActive: true }) : { ok: false, error: 'organization id unknown' };
      if (!inst.ok) return ok({ source: 'live', error: inst.error });
      const startAt = a.period_start ? new Date(a.period_start).toISOString() : monthStartIso(Date.now());
      const endAt = a.period_end ? new Date(a.period_end).toISOString() : new Date().toISOString();
      const out = [];
      for (const i of listRows(inst.data)) {
        const r = await siro.getEvaluatedInstance(i.id, { startAt, endAt, filterBy: 'USER', filterByIds: userId });
        out.push({ instance_id: i.id, name: i.name, ok: r.ok, data: r.ok ? (r.data?.data || r.data) : r.error });
      }
      return ok({ source: 'live', siro_user_id: userId, startAt, endAt, scorecards: out });
    },
  );

  server.tool(
    'siro_sync_run',
    'Run one Siro poll pass now (the 10-minute backstop). dry_run (default true) lists what it would process and writes nothing; dry_run=false stores and matches at the current SIRO_SYNC_MODE (shadow: store only). since overrides the watermark (ISO time).',
    { since: z.string().optional(), dry_run: z.boolean().optional() },
    async ({ since, dry_run }) => ok(await runSiroRecordingSync({ since: since || null, dryRun: dry_run !== false })),
  );
}
