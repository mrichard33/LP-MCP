import { z } from 'zod';
import { syncAppointmentToLP } from '../lp-appointment-sync.js';
import { enrollLpLeadCreation } from '../admin/lp-force-addlead.js';
import { lpPost } from '../lp-client.js';

// ─── helpers ─────────────────────────────────────────────────────

// Format a Date as MM/DD/YYYY (LP's required date format).
function mmddyyyy(d) {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

function ok(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}
function err(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }] };
}

/**
 * LP appointment write + verify tools (v6.7 — 2026-06-04).
 *
 * These expose existing, production-proven LP logic to the MCP. They add
 * NO new LP write behavior — set_lp_appointment and force_lp_lead_creation
 * call the same functions the webhook path uses, and check_lp_inbound is a
 * read against LP's inbound-queue endpoint.
 *
 * DOCTRINE: the two write tools are confirm-gated. Without confirm:true they
 * return a dry-run preview describing what WOULD happen and execute nothing.
 * This keeps them safe to expose to read-and-report ops sweeps — the sweep
 * surfaces "ready to set", a human authorizes with confirm:true.
 */
export function registerLPAppointmentTools(server) {

  // ───────────────────────────────────────────────────
  // Tool: set_lp_appointment  (WRITE — confirm-gated)
  // ───────────────────────────────────────────────────
  server.tool(
    'set_lp_appointment',
    'Set a Lead Perfection appointment for a GHL contact via the proven syncAppointmentToLP orchestrator. ' +
    'Resolves the LP lead through the 5-step chain (Supabase+lognumber, GHL field, prospect, phone, email); ' +
    'if a lead is found it runs LP SetAppointment (with full duplicate-guarding), and if NO lead is found it ' +
    'self-heals by enrolling the contact in workflow 8e30ff37 ("Send Lead to Lead Perfection"), which does ' +
    'addlead-WITH-appointment + inbound-id writeback, with LP\'s ~60s callback filling lp_lead_id/lp_prospect_id. ' +
    'CONFIRM-GATED: without confirm:true this returns a dry-run preview and executes nothing. ' +
    'RETURN CONTRACT (the `action` field): "lp_appointment_set" = set now; "already_in_lp"/"already_set_in_lp"/' +
    '"duplicate_sync_suppressed" = LP already had it, no-op; "lp_lead_creation_enrolled" = ASYNC — lead+appt are ' +
    'being created in the workflow, NOT yet confirmed (verify with check_lp_inbound after ~60s); ' +
    '"skipped_no_valid_lead_id"/"duplicate_failure_suppressed" = could not resolve and fell to the manual-action card. ' +
    'appt_date/appt_time are required when a lead already exists (SetAppointment needs them); for the no-lead enroll ' +
    'path the workflow reads date/time off the contact, but pass them when known for the best result.',
    {
      ghl_contact_id: z.string().describe('GHL contact ID (used as lognumber for resolution and lead matchback)'),
      appt_date: z.string().optional().describe('Appointment date. Accepts MM/DD/YYYY, YYYY-MM-DD, ISO, or "Month D, YYYY". Required if an LP lead already exists.'),
      appt_time: z.string().optional().describe('Appointment time. Accepts 24h "HH:MM" or 12h "H:MM AM/PM". Required if an LP lead already exists.'),
      calendar_name: z.string().optional().describe('Calendar name for the notification (e.g. "Window Estimate", "MV", "HPA").'),
      confirm: z.boolean().optional().describe('Must be true to execute. Omit or false for a dry-run preview (no write).'),
    },
    async (params) => {
      if (!params.ghl_contact_id) return err('ghl_contact_id is required');

      if (params.confirm !== true) {
        return ok({
          dry_run: true,
          would_execute: 'set_lp_appointment',
          ghl_contact_id: params.ghl_contact_id,
          appt_date: params.appt_date || '(will read from contact / required if lead exists)',
          appt_time: params.appt_time || '(will read from contact / required if lead exists)',
          calendar_name: params.calendar_name || null,
          behavior: 'Resolve LP lead → SetAppointment if found; else enroll in wf 8e30ff37 (addlead+appt, async ~60s callback).',
          note: 'Re-call with confirm:true to execute. No write performed.',
        });
      }

      try {
        const result = await syncAppointmentToLP({
          contactId: params.ghl_contact_id,
          appointmentDate: params.appt_date,
          appointmentTime: params.appt_time,
          calendarName: params.calendar_name,
        });
        return ok(result);
      } catch (e) {
        return err(e.message);
      }
    }
  );

  // ───────────────────────────────────────────────────
  // Tool: force_lp_lead_creation  (WRITE — confirm-gated)
  // ───────────────────────────────────────────────────
  server.tool(
    'force_lp_lead_creation',
    'Force-create an LP lead (with its appointment) for a GHL contact by enrolling it in workflow 8e30ff37 ' +
    '("Send Lead to Lead Perfection") — the canonical addlead-with-appointment + inbound-id writeback path. ' +
    'Use when a contact has no usable LP lead (only an in1_id, or none at all) and you want to drive lead creation ' +
    'directly rather than via set_lp_appointment. The workflow reads address/phone/srs_id/appt date+time off the ' +
    'contact; LP\'s ~60s callback then writes lp_prospect_id/lp_lead_id back. ASYNC — returns immediately after ' +
    'enrollment, NOT after the lead exists; verify with check_lp_inbound. Dedup-guarded (create-lead:<contact>) ' +
    'within the window unless force:true. CONFIRM-GATED: without confirm:true this returns a dry-run preview.',
    {
      ghl_contact_id: z.string().describe('GHL contact ID to enroll in the lead-creation workflow'),
      calendar_name: z.string().optional().describe('Calendar name for the notification card'),
      force: z.boolean().optional().describe('Bypass the dedup marker and re-enroll even if recently enrolled (default false)'),
      confirm: z.boolean().optional().describe('Must be true to execute. Omit or false for a dry-run preview (no write).'),
    },
    async (params) => {
      if (!params.ghl_contact_id) return err('ghl_contact_id is required');

      if (params.confirm !== true) {
        return ok({
          dry_run: true,
          would_execute: 'force_lp_lead_creation',
          ghl_contact_id: params.ghl_contact_id,
          force: params.force === true,
          behavior: 'Enroll contact in wf 8e30ff37 (addlead+appt JSON, inbound-id writeback, LP ~60s callback).',
          note: 'Re-call with confirm:true to execute. No write performed.',
        });
      }

      try {
        const result = await enrollLpLeadCreation({
          contactId: params.ghl_contact_id,
          calendarName: params.calendar_name || null,
          force: params.force === true,
        });
        return ok(result);
      } catch (e) {
        return err(e.message);
      }
    }
  );

  // ───────────────────────────────────────────────────
  // Tool: check_lp_inbound  (READ — no confirm gate)
  // ───────────────────────────────────────────────────
  server.tool(
    'check_lp_inbound',
    'Read-only: query LP\'s inbound-lead queue via /api/Leads/GetInboundLeadInfo by lognumber (= GHL contact ID). ' +
    'This is the live confirmation read for the async enroll path — after set_lp_appointment returns ' +
    '"lp_lead_creation_enrolled" or after force_lp_lead_creation, call this (give it ~60s) to verify the lead ' +
    'actually entered LP\'s inbound queue. Because workflow 8e30ff37 stamps lognumber = GHL contact ID, the contact ' +
    'ID is the match key. Returns the raw LP inbound rows. NOTE: this reads the INBOUND QUEUE, not issued leads — ' +
    'an empty result after ~60s suggests the enroll did not reach LP; rows present confirm it landed.',
    {
      ghl_contact_id: z.string().describe('GHL contact ID — sent as lognumber to match the inbound lead'),
      start_date: z.string().optional().describe('Range start MM/DD/YYYY (default: 14 days ago)'),
      end_date: z.string().optional().describe('Range end MM/DD/YYYY (default: today)'),
      page_size: z.number().optional().describe('Max rows to return (default 50)'),
    },
    async (params) => {
      if (!params.ghl_contact_id) return err('ghl_contact_id is required');

      const today = new Date();
      const fourteenAgo = new Date(today.getTime() - 14 * 24 * 60 * 60 * 1000);
      const startdate = params.start_date || mmddyyyy(fourteenAgo);
      const enddate = params.end_date || mmddyyyy(today);

      try {
        const result = await lpPost('/api/Leads/GetInboundLeadInfo', {
          startdate,
          enddate,
          lognumber: String(params.ghl_contact_id),
          PageSize: String(params.page_size || 50),
          StartIndex: '1',
        });

        const rows = Array.isArray(result)
          ? result
          : (result?.data || result?.leads || result?.results || result?.items || []);

        return ok({
          lognumber: params.ghl_contact_id,
          range: { startdate, enddate },
          inbound_row_count: Array.isArray(rows) ? rows.length : 0,
          landed_in_inbound_queue: Array.isArray(rows) && rows.length > 0,
          rows,
        });
      } catch (e) {
        return err(e.message);
      }
    }
  );

}
