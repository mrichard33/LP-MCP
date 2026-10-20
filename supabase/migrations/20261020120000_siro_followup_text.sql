-- Siro's drafted follow-up TEXT, cleaned, as a reference for the bot (Mark, 2026-10-19).
--
-- Ruling 2 of the 2026-10-19 handoff: keep Siro's suggested follow-up text (never
-- the email draft, never Siro's "thinking"), cleaned, so the bot can read it for
-- topic and tone. It is never sent as written. src/siro/normalize.js fills it:
-- HTML out, PII scrubbed, discount / money / financing talk and any sensitive
-- detail (a death, an illness, money trouble) dropped, capped at 400 characters.
-- Null when Siro wrote none or SIRO_FOLLOWUP_TEXT_MODE=off.
--
-- Shipped alone, before the code that writes it: migrations apply on the same
-- push to main that deploys Railway, and an upsert naming a column that does not
-- exist yet would stop every Siro recording from being stored.

alter table public.siro_recordings add column if not exists followup_text text;
