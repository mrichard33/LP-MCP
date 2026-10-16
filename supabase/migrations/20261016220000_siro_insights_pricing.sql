-- Siro: keep the useful parts, drop the rest (2026-10-16, follow-up to the Siro PR).
--
-- A read of the first 118 live rows showed the whole Siro record in `raw`: the
-- home's GPS position, the customer's email, every quote, Siro's drafted
-- follow-up email and text, and its internal "thinking". None of it is read.
--   insights  Siro's follow-up fields the bot reads (src/siro/normalize.js).
--   pricing   the quotes and financing as Siro wrote them: saved to GHL in the
--             demo note and shown to the bot (the user, 2026-10-16). The reply
--             guard still keeps a price out of any text.
-- The UPDATE trims every stored `raw` to the same whitelist normalize.js now
-- writes, so nothing sensitive stays behind even for a recording Siro never
-- sends again.

alter table public.siro_recordings add column if not exists insights jsonb;
alter table public.siro_recordings add column if not exists pricing jsonb;

update public.siro_recordings
set raw = jsonb_build_object(
  'id', raw->'id',
  'title', raw->'title',
  'createdAt', coalesce(raw->'createdAt', raw->'dateCreated'),
  'updatedAt', raw->'updatedAt',
  'result', raw->'result',
  'durationInMilliseconds', raw->'durationInMilliseconds',
  'userId', coalesce(raw->'userId', raw->'siroUserId'),
  'conversationType', raw->'conversationType',
  'link', raw#>'{links,web,self}',
  'followup', case when jsonb_typeof(raw->'followups') = 'array' and jsonb_array_length(raw->'followups') > 0
    then jsonb_build_object(
      'followupType', raw#>'{followups,0,followupType}',
      'score', raw#>'{followups,0,score}',
      'status', raw#>'{followups,0,status}',
      'repName', raw#>'{followups,0,repName}',
      'teamName', raw#>'{followups,0,teamName}')
    else null end
)
where raw is not null and (raw ? 'followups' or raw ? 'latitude' or raw ? 'summary' or raw ? 'crm');
