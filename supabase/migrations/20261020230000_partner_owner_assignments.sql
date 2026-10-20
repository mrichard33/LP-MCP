-- 20261020230000_partner_owner_assignments.sql
--
-- WHAT: (1) partner_owner_assignments: one row per GHL contact whose owner THIS code (src/partners/owner-sync.js) set to
--       a partner; released_at is set when the code hands it back to the Reece team user.
--       (2) partner_owner_log.reason gains 'skipped_not_ours' (a partner owns the contact, but GHL put them there, not us).
--       (3) objection_state_policies APPOINTMENT_DISRUPTION.one_leg: recovery_cadence → days 0, 3, 5, 8
--       (sms, sms, email, sms). recovery_touch_count is NOT changed: fetchPolicy reads it and the S5.2 enrollment
--       payload carries it to GHL, so changing it could change the workflow.
-- WHY: handoff v3 (Mark, 2026-10-20). GHL S5.2 Appointment Rescue v2, branch "I. 1 Leg", assigns 1 Leg leads to Ross
--      itself. The return-to-Reece rule must touch only contacts this code assigned, never those (skipped_not_ours).
--      recovery_cadence is informational: nothing in src/ reads it (fetchPolicy selects an explicit list without it, and
--      the S5.2 enrollment payload does not carry it); the real timing lives in the GHL workflow. This keeps the record
--      in step with the workflow's I. 1 Leg branch.
-- NOT: no backfill (partner_owner_log held 0 writes when this shipped); no change to the S5.2 trigger, enrollment,
--      webhook url, window or workflow id.
-- ROLLBACK: drop table partner_owner_assignments; restore the check without 'skipped_not_ours'; cadence back to
--      [{"day":1,"channel":"sms"},{"day":4,"channel":"email"},{"day":8,"channel":"sms"}].
-- destructive: approved by Mark Richard 2026-10-20 (drops and re-adds only the reason CHECK, to widen it)

create table if not exists public.partner_owner_assignments (
  ghl_contact_id text primary key,
  lp_lead_id text,
  partner_name text,
  ghl_user_id text not null,
  assigned_at timestamptz not null default now(),
  released_at timestamptz
);

create index if not exists partner_owner_assignments_open_idx
  on public.partner_owner_assignments (ghl_contact_id) where released_at is null;

alter table public.partner_owner_assignments enable row level security;

alter table public.partner_owner_log drop constraint if exists partner_owner_log_reason_chk;
alter table public.partner_owner_log add constraint partner_owner_log_reason_chk check (reason in
  ('assigned', 'reassigned', 'returned', 'noop', 'skipped_pre_golive', 'skipped_not_ours', 'no_ghl_contact', 'failed'));

update public.objection_state_policies
   set recovery_cadence = '[{"day":0,"channel":"sms"},{"day":3,"channel":"sms"},{"day":5,"channel":"email"},{"day":8,"channel":"sms"}]'::jsonb
 where state_code = 'APPOINTMENT_DISRUPTION.one_leg';

notify pgrst, 'reload schema';
