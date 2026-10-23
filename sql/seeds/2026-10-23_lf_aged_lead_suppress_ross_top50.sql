-- 2026-10-23 — LightFire aged leads: Ross's top 50 One-Leg prospects (picked 2026-10-22) never go to LightFire.
-- ALREADY APPLIED to LP Supabase by hand (Mark, 2026-10-23, n8n/sql/lf_aged_lead_suppress.sql): 50 prospects,
-- 52 phones. Recorded here so it can be reproduced; the NOT EXISTS guard makes a re-run add nothing.
-- Schema: supabase/migrations/20261023110000_lf_aged_lead_suppress.sql.

insert into public.lf_aged_lead_suppress (prospect_id, phone10, reason, origin_lp_lead_id)
select distinct o.lp_prospect_id, right(regexp_replace(p,'\D','','g'),10), 'ROSS_RFED_TOP50_2026-10-22', o.lp_lead_id
from lp_leads o
join lp_leads a on a.lp_prospect_id = o.lp_prospect_id
cross join lateral unnest(array[a.phone, a.phone_alt]) p
where o.lp_lead_id = any(string_to_array('564157,569515,568736,575860,561890,562554,571740,571080,573089,565402,561125,571412,576060,567518,572649,574343,570620,572979,565074,564015,548342,576068,566668,556763,569064,564527,576682,559659,555512,574232,420011,571373,564738,541511,571520,562094,573782,558514,561530,549842,569069,556000,550689,558342,557755,561690,511563,546802,570995,566607',','))
  and p is not null and length(regexp_replace(p,'\D','','g')) >= 10
  and not exists (
    select 1 from public.lf_aged_lead_suppress s
    where s.reason = 'ROSS_RFED_TOP50_2026-10-22'
      and s.prospect_id is not distinct from o.lp_prospect_id
      and s.phone10 = right(regexp_replace(p,'\D','','g'),10)
  );
