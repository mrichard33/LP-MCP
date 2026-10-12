create or replace view "public"."v_supabase_freshness" as  WITH parts AS (
         SELECT 'lp_leads'::text AS table_name,
            lp_leads.lp_verified_at AS verified_at
           FROM public.lp_leads
          WHERE (lp_leads.created_at_lp >= (now() - '365 days'::interval))
        UNION ALL
         SELECT 'lp_prospects'::text,
            lp_prospects.verified_at
           FROM public.lp_prospects
          WHERE (lp_prospects.synced_at >= (now() - '365 days'::interval))
        UNION ALL
         SELECT 'lp_notes'::text,
            lp_notes.verified_at
           FROM public.lp_notes
          WHERE (lp_notes.created_at_lp >= (now() - '365 days'::interval))
        UNION ALL
         SELECT 'lp_jobs'::text,
            lp_jobs.verified_at
           FROM public.lp_jobs
          WHERE (lp_jobs.synced_at >= (now() - '365 days'::interval))
        UNION ALL
         SELECT 'lp_job_milestones'::text,
            lp_job_milestones.verified_at
           FROM public.lp_job_milestones
          WHERE (lp_job_milestones.synced_at >= (now() - '365 days'::interval))
        )
 SELECT table_name,
    count(*) AS active_rows,
    count(*) FILTER (WHERE (verified_at >= (now() - '1 day'::interval))) AS verified_24h,
    count(*) FILTER (WHERE (verified_at >= (now() - '7 days'::interval))) AS verified_7d,
    count(*) FILTER (WHERE (verified_at IS NULL)) AS never_verified,
    round(((100.0 * (count(*) FILTER (WHERE (verified_at >= (now() - '7 days'::interval))))::numeric) / (GREATEST(count(*), (1)::bigint))::numeric), 2) AS pct_verified_7d
   FROM parts
  GROUP BY table_name
  ORDER BY (count(*)) DESC;




