-- ─── 046 — LP↔GHL link corroboration + identity-sync columns ────────────────
--
-- Defect: lp_leads.ghl_contact_id was adopted from LP lognumber on a shape
-- check alone (/^[A-Za-z0-9]{20}$/), binding real customers to arbitrary GHL
-- contacts (reference: lp_lead_id 560362 → four unrelated contact ids across
-- lp_call_logs). This migration adds the columns/tables the corroboration
-- resolver (src/services/link-corroboration.js) needs.
--
-- ghl_identity_synced_at / ghl_identity_hash are added now (one migration per
-- the rollout plan) but are only written by Part B (identity writeback),
-- which ships separately after the observe-mode soak.
--
-- Idempotent — additive DDL mirrored in runMigrations() (src/index.js).
-- The legacy_unverified backfill UPDATE is applied here only (not mirrored).

alter table lp_leads
  add column if not exists ghl_link_source text,
  add column if not exists ghl_identity_synced_at timestamptz,
  add column if not exists ghl_identity_hash text;

create index if not exists lp_leads_ghl_link_source_idx
  on lp_leads (ghl_link_source);

-- One row per distinct (lead, candidate-pair, resolution). Recurrence is
-- signal — a single link flapping repeatedly is a different problem from many
-- links flapping once — so re-detections increment seen_count / last_seen_at
-- instead of inserting duplicates or being suppressed.
create table if not exists lp_link_conflicts (
  id                bigserial primary key,
  lp_lead_id        text not null,
  lp_prospect_id    text,
  lognumber_ghl_id  text,
  verified_ghl_id   text,
  existing_ghl_id   text,
  resolution        text not null,
  reason            text,
  lp_phone          text,
  lp_email          text,
  ghl_phone         text,
  ghl_email         text,
  detail            jsonb not null default '{}',
  seen_count        integer not null default 1,
  detected_at       timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  resolved_at       timestamptz
);

create index if not exists lp_link_conflicts_lead_idx
  on lp_link_conflicts (lp_lead_id, detected_at desc);

create unique index if not exists lp_link_conflicts_natural_key_idx
  on lp_link_conflicts (
    lp_lead_id,
    coalesce(lognumber_ghl_id, ''),
    coalesce(verified_ghl_id, ''),
    resolution
  );

-- Verification verdict cache. verify_source distinguishes HL-contacts-cache
-- verdicts (observe mode, cheap) from live GHL reads (enforce mode): enforce
-- only trusts 'ghl_live' rows within TTL and re-verifies cache verdicts live
-- before any link change. detail carries cache_synced_at for cache verdicts
-- so cache staleness can be measured against the rejection distribution.
create table if not exists lp_link_verifications (
  lp_lead_id      text not null,
  ghl_contact_id  text not null,
  verdict         text not null check (verdict in ('pass', 'fail', 'no_identity')),
  verify_source   text not null default 'ghl_live',
  detail          jsonb not null default '{}',
  verified_at     timestamptz not null default now(),
  primary key (lp_lead_id, ghl_contact_id)
);

-- Distinguish untriaged pre-existing links from resolver-classified ones.
update lp_leads
   set ghl_link_source = 'legacy_unverified'
 where ghl_contact_id is not null
   and ghl_link_source is null;
