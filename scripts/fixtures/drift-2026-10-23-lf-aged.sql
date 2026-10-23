create sequence "public"."lf_aged_lead_suppress_id_seq";


  create table "public"."lf_aged_lead_suppress" (
    "id" bigint not null default nextval('public.lf_aged_lead_suppress_id_seq'::regclass),
    "prospect_id" text,
    "phone10" text,
    "reason" text not null,
    "origin_lp_lead_id" text,
    "added_at" timestamp with time zone not null default now()
      );


alter table "public"."lf_aged_lead_suppress" enable row level security;

alter sequence "public"."lf_aged_lead_suppress_id_seq" owned by "public"."lf_aged_lead_suppress"."id";

CREATE INDEX lf_aged_lead_suppress_phone_idx ON public.lf_aged_lead_suppress USING btree (phone10);

CREATE UNIQUE INDEX lf_aged_lead_suppress_pkey ON public.lf_aged_lead_suppress USING btree (id);

CREATE INDEX lf_aged_lead_suppress_prosp_idx ON public.lf_aged_lead_suppress USING btree (prospect_id);

alter table "public"."lf_aged_lead_suppress" add constraint "lf_aged_lead_suppress_pkey" PRIMARY KEY using index "lf_aged_lead_suppress_pkey";

set check_function_bodies = off;

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
$function$
;

grant delete on table "public"."lf_aged_lead_suppress" to "service_role";

grant insert on table "public"."lf_aged_lead_suppress" to "service_role";

grant references on table "public"."lf_aged_lead_suppress" to "service_role";

grant select on table "public"."lf_aged_lead_suppress" to "service_role";

grant trigger on table "public"."lf_aged_lead_suppress" to "service_role";

grant truncate on table "public"."lf_aged_lead_suppress" to "service_role";

grant update on table "public"."lf_aged_lead_suppress" to "service_role";
