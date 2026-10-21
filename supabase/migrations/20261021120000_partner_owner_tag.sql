-- 20261021120000_partner_owner_tag.sql
--
-- WHAT: partner_owner_map gains ghl_tag: the GHL tag our partner owner sync adds once it makes the partner the
--       contact owner (and removes on a return of a contact it assigned). Ross Erstling / RFED → 'phone-team'.
-- WHY: the user, 2026-10-21: "When a lead has the tag applied phone-team this is what triggers the lead being assigned
--      to Ross and a notification sent to Ross. We should make sure when our system syncs a lead from Lead Perfection
--      because it was assigned to the market RFED it adds that tag in GHL." GHL "U.RFED Lead Assigned to Phone Team"
--      fires on the tag being added. src/partners/owner-sync.js reads the column (owner-resolver selects '*').
-- NOT: no backfill of tags; no other partner row changes.
-- ROLLBACK: alter table public.partner_owner_map drop column ghl_tag;

alter table public.partner_owner_map add column if not exists ghl_tag text;

update public.partner_owner_map
   set ghl_tag = 'phone-team'
 where ghl_user_id = 'TxbMrITSVyTJtJvGD9vk' and lp_branch_id = 'RFED';

notify pgrst, 'reload schema';
