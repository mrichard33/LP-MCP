-- 20261023110000_lf_aged_lead_suppress — LightFire aged leads: block Ross/RFED partner leads and One-Leg leads.
-- applied by hand first: Mark 2026-10-23
--
-- 2026-10-23: Mark applied n8n/sql/lf_aged_lead_suppress.sql (n8n commit 79e5537) to LP Supabase by
-- hand at 09:14 ET, before this file existed. Every LP-MCP PR's Ledger check then failed its drift
-- step on 18 statements (the table, its sequence, indexes, RLS, grants and the new function body).
-- This file records that schema so the repo matches the database again (sql/README.md rules 4-5:
-- other repos' LP-project DDL lives here). It is idempotent: `db push` replays it as a no-op against
-- the objects already there.
--
-- Used by n8n "05 LF Daily Aged Leads Delivery" (KQpmuov6oNBpmQ85), node "Build final CSV": before a
-- send it calls lf_aged_already_sent(p_ids, p_phones), which now also returns the partner (Ross /
-- RFED) prospects and phones in lf_aged_lead_suppress or partner_rfed_batch, and every prospect or
-- phone whose LP lead is One-Leg, so none of them reach LightFire. The CSV "id" (and
-- lf_aged_lead_sent_log.lp_lead_id) is the LP PROSPECT id.
--
-- The 50-prospect seed is data, not schema: sql/seeds/2026-10-23_lf_aged_lead_suppress_ross_top50.sql.
--
-- ROLLBACK: restore lf_aged_already_sent from 20261012164849_baseline_dump.sql (the three-key body),
-- then DROP TABLE lf_aged_lead_suppress (a later migration with a destructive marker).

CREATE TABLE IF NOT EXISTS public.lf_aged_lead_suppress (
  id bigserial PRIMARY KEY,
  prospect_id text,
  phone10 text,
  reason text NOT NULL,
  origin_lp_lead_id text,
  added_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lf_aged_lead_suppress_prosp_idx ON public.lf_aged_lead_suppress (prospect_id);
CREATE INDEX IF NOT EXISTS lf_aged_lead_suppress_phone_idx ON public.lf_aged_lead_suppress (phone10);
ALTER TABLE public.lf_aged_lead_suppress ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lf_aged_lead_suppress FROM anon, authenticated;
GRANT ALL ON TABLE public.lf_aged_lead_suppress TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.lf_aged_lead_suppress_id_seq TO service_role;

-- The live body, as pg_get_functiondef printed it on 2026-10-23.
CREATE OR REPLACE FUNCTION public.lf_aged_already_sent(p_ids text[], p_phones text[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  select jsonb_build_object(
    'ids', coalesce((select jsonb_agg(distinct lp_lead_id) from public.lf_aged_lead_sent_log where lp_lead_id = any(p_ids)), '[]'::jsonb),
    'phones', coalesce((select jsonb_agg(distinct phone10) from public.lf_aged_lead_sent_log where phone10 = any(p_phones)), '[]'::jsonb),
    'log_rows', (select count(*) from public.lf_aged_lead_sent_log),
    -- Partner (Ross / RFED) leads: never send to LightFire. Mark, 2026-10-23.
    'partner_ids', coalesce((select jsonb_agg(distinct x) from (
        select prospect_id x from public.lf_aged_lead_suppress where prospect_id = any(p_ids)
        union select lp_prospect_id from public.partner_rfed_batch where lp_prospect_id = any(p_ids)) q), '[]'::jsonb),
    'partner_phones', coalesce((select jsonb_agg(distinct phone10) from public.lf_aged_lead_suppress where phone10 = any(p_phones)), '[]'::jsonb),
    -- One-Leg: any LP lead for this prospect/phone is 1Leg. Mark, 2026-10-23.
    'oneleg_ids', coalesce((select jsonb_agg(distinct lp_prospect_id) from public.lp_leads
        where disposition_code = '1Leg' and lp_deleted_at is null and lp_prospect_id = any(p_ids)), '[]'::jsonb),
    'oneleg_phones', coalesce((select jsonb_agg(distinct ph) from (
        select right(regexp_replace(p,'\D','','g'),10) ph from public.lp_leads l
        cross join lateral unnest(array[l.phone, l.phone_alt]) p
        where l.disposition_code = '1Leg' and l.lp_deleted_at is null and p is not null) q
        where ph = any(p_phones)), '[]'::jsonb)
  );
$function$;
REVOKE ALL ON FUNCTION public.lf_aged_already_sent(text[], text[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lf_aged_already_sent(text[], text[]) TO service_role;

NOTIFY pgrst, 'reload schema';
