/**
 * I.STITCH — pure helpers — src/site-stitch-core.js
 *
 * Kept dependency-free (no supabase, no GHL, no fetch) so the decisions that
 * caused the 2026-10-01 overwrite can be unit-tested: which visitors a
 * contact's totals cover, which GHL fields get written, and which contact an
 * identity resolves to when GHL holds duplicates. site-stitch.js owns the I/O.
 */

const q = (s) => String(s ?? '').replace(/'/g, "''");
const digits = (s) => String(s || '').replace(/[^0-9]/g, '');

/**
 * SQL that totals a contact's site history.
 *
 * 2026-10-01: the visitor set used to be "this visitor + its visitor_links
 * partners" only. A known contact who came back on a new browser or device
 * (new _reece_vid cookie) therefore had their GHL totals REPLACED by the new
 * visitor's alone — Mark Test went from 31 pages / score 100 to 5 / 30. The
 * set now also seeds from every visitor already mapped to this contact in
 * visitor_identity_map (plus their links), so totals only ever grow.
 */
export function buildAggregateSql({ visitorId, contactId, maxEventId, recencyDays }) {
  const vid = q(visitorId);
  const cid = q(contactId);
  return `
    with seed as (
      select '${vid}'::text as vid
      union
      select visitor_id from public.visitor_identity_map where contact_id = '${cid}'
    ),
    linked as (
      select vid from seed
      union
      select unnest(array[l.id_a, l.id_b]) from public.visitor_links l
      where l.id_a in (select vid from seed) or l.id_b in (select vid from seed)
    ),
    ev as (
      select * from public.site_events
      where visitor_id in (select vid from linked) and event_type = 'pageview'
    ),
    perpage as (
      select page_path,
             count(*) as cnt,
             count(*) filter (where created_at >= now() - interval '${Number(recencyDays) || 7} days') as recent_cnt
      from ev where page_path is not null group by page_path
    )
    select
      '${cid}'::text as contact_id,
      ${Number(maxEventId)}::bigint as max_site_event_id,
      (select array_agg(vid) from linked) as visitor_ids,
      (select string_agg(vid, ',') from linked) as visitor_ids_csv,
      (select count(*) from ev) as pageviews,
      (select count(distinct session_id) from ev) as sessions,
      (select min(created_at) from ev) as first_visit,
      (select max(created_at) from ev) as last_visit,
      (select coalesce(utm_source, fbclid) from ev where coalesce(utm_source, fbclid) is not null order by created_at asc limit 1) as first_touch_source,
      coalesce((select jsonb_object_agg(page_path, cnt) from perpage), '{}'::jsonb) as page_counts,
      coalesce((select jsonb_object_agg(page_path, recent_cnt) from perpage where recent_cnt > 0), '{}'::jsonb) as recent_page_counts`;
}

/**
 * The customFields payload for one stitched contact.
 *
 * first_touch_source is written ONLY when there is one. It used to be sent as
 * '' whenever the visitors in hand had no utm_source/fbclid, which erased a
 * first touch GHL already held (2026-10-01). Unknown means "leave it alone".
 */
export function buildSiteFieldUpdates(fields, agg, score) {
  const cf = [];
  if (!fields || !agg) return cf;
  if (fields.last_site_visit && agg.last_visit) cf.push({ id: fields.last_site_visit, field_value: agg.last_visit });
  if (fields.site_intent_score) cf.push({ id: fields.site_intent_score, field_value: score });
  if (fields.site_pages_viewed) cf.push({ id: fields.site_pages_viewed, field_value: Number(agg.pageviews) || 0 });
  const ft = agg.first_touch_source == null ? '' : String(agg.first_touch_source).trim();
  if (fields.first_touch_source && ft) cf.push({ id: fields.first_touch_source, field_value: ft });
  return cf;
}

/**
 * Exact matches only: contacts whose email equals `email`, or (when no email
 * is given) whose phone ends in the same 10 digits as `phone`.
 */
export function exactMatches(contacts, { email, phone } = {}) {
  const list = Array.isArray(contacts) ? contacts : [];
  if (email) {
    const want = String(email).trim().toLowerCase();
    return list.filter(c => (c?.email || '').trim().toLowerCase() === want);
  }
  const want = digits(phone).slice(-10);
  if (want.length < 10) return [];
  return list.filter(c => digits(c?.phone).endsWith(want));
}

/**
 * Pick ONE contact from exact matches. GHL search order is not a ranking, and
 * duplicates are common (the Mark Test email matched 7 contacts on 2026-10-01,
 * six of them bare risk-report shells), so "first hit" could attach a
 * visitor's history to an empty duplicate. Preference, strongest first:
 *   1. the contact this visitor is already stitched to
 *   2. a contact whose phone matches the submitted phone
 *   3. a contact some other visitor is already stitched to
 *   4. the most complete record (has a phone, has a name)
 *   5. the most recently updated
 */
export function pickContact(candidates, { phone, visitorContactId, mappedContactIds } = {}) {
  const list = (Array.isArray(candidates) ? candidates : []).filter(c => c && c.id);
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  const wantPhone = digits(phone).slice(-10);
  const mapped = new Set(mappedContactIds || []);
  const rank = (c) => [
    c.id === visitorContactId ? 1 : 0,
    wantPhone.length === 10 && digits(c.phone).endsWith(wantPhone) ? 1 : 0,
    mapped.has(c.id) ? 1 : 0,
    c.phone ? 1 : 0,
    (c.firstName || c.lastName || (c.contactName && !String(c.contactName).includes('@'))) ? 1 : 0,
    Date.parse(c.dateUpdated || c.dateAdded || '') || 0,
  ];
  return list.slice().sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return rb[i] - ra[i];
    return 0;
  })[0];
}

/** SQL listing which of `ids` are already in visitor_identity_map, and for which visitor. */
export function buildMappedContactsSql(ids, visitorId) {
  const list = (ids || []).filter(Boolean).map(id => `'${q(id)}'`);
  if (list.length === 0) return null;
  return `select contact_id, bool_or(visitor_id = '${q(visitorId)}') as this_visitor
          from public.visitor_identity_map
          where contact_id in (${list.join(',')})
          group by contact_id`;
}

// ─── One row per lead: site_lead_summary (sql/142, 2026-10-01) ──────────────
// site_events is one row per page view and visitor_identity_map one row per
// browser; nothing held one row per LEAD. I.STITCH now upserts this row from
// the same aggregate it writes to GHL, so the two always agree.

const sqlText = (v) => (v == null || String(v).trim() === '' ? 'null' : `'${q(String(v).trim())}'`);
// 2026-10-01: an ISO string from Postgres is passed through untouched.
// site_events.created_at has MICROsecond precision and a JS Date keeps only
// milliseconds, so round-tripping last_visit through Date stored
// 14:59:18.650 for a page view at 14:59:18.650182 — and the refresh check
// (page view newer than last_visit) then matched every lead on every batch.
const ISO_TS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/;
const sqlTs = (v) => {
  if (v == null || v === '') return 'null';
  const str = String(v).trim();
  // Digits and separators only, so it is safe to quote as-is; Postgres parses it.
  if (ISO_TS.test(str)) return `'${str}'::timestamptz`;
  const t = Date.parse(str);
  return Number.isFinite(t) ? `'${new Date(t).toISOString()}'::timestamptz` : 'null';
};
const sqlInt = (v) => (Number.isFinite(Number(v)) ? String(Math.trunc(Number(v))) : '0');
const sqlTextArray = (arr) => {
  const list = (Array.isArray(arr) ? arr : []).filter(x => x != null && String(x) !== '');
  return list.length ? `array[${list.map(x => `'${q(x)}'`).join(',')}]::text[]` : `'{}'::text[]`;
};

/**
 * Upsert for one contact's summary row. A first touch already stored is kept
 * when this aggregate has none — the same "unknown never erases" rule the GHL
 * field follows (buildSiteFieldUpdates).
 */
export function buildSummaryUpsertSql({ contactId, agg, score, topPages }) {
  const a = agg || {};
  const pageCounts = (a.page_counts && typeof a.page_counts === 'object') ? a.page_counts : {};
  return `insert into public.site_lead_summary
      (contact_id, visitor_ids, pages_viewed, sessions, first_visit, last_visit,
       first_touch_source, intent_score, top_pages, page_counts, updated_at)
    values ('${q(contactId)}', ${sqlTextArray(a.visitor_ids)}, ${sqlInt(a.pageviews)}, ${sqlInt(a.sessions)},
       ${sqlTs(a.first_visit)}, ${sqlTs(a.last_visit)}, ${sqlText(a.first_touch_source)}, ${sqlInt(score)},
       ${sqlTextArray(topPages)}, '${q(JSON.stringify(pageCounts))}'::jsonb, now())
    on conflict (contact_id) do update set
      visitor_ids = excluded.visitor_ids,
      pages_viewed = excluded.pages_viewed,
      sessions = excluded.sessions,
      first_visit = excluded.first_visit,
      last_visit = excluded.last_visit,
      first_touch_source = coalesce(excluded.first_touch_source, public.site_lead_summary.first_touch_source),
      intent_score = excluded.intent_score,
      top_pages = excluded.top_pages,
      page_counts = excluded.page_counts,
      updated_at = now()`;
}

/**
 * Contacts the returning-visit refresh should rebuild, one row each:
 *  - stitched contacts with no summary row yet (this IS the backfill), and
 *  - contacts whose mapped browsers have a page view newer than the row's
 *    last_visit — a known lead browsing again without submitting a form,
 *    which before 2026-10-01 never reached GHL at all.
 * Carries the previous score and page counts so the caller can decide
 * whether the change deserves a GHL note.
 */
export function buildRefreshCandidatesSql(limit) {
  const n = Math.max(1, Math.min(500, Math.trunc(Number(limit)) || 50));
  return `select distinct on (m.contact_id)
        m.contact_id, m.visitor_id,
        (s.contact_id is not null) as has_summary,
        s.intent_score as prev_score, s.page_counts as prev_page_counts,
        s.pages_viewed as prev_pages, s.last_visit as prev_last_visit
      from public.visitor_identity_map m
      left join public.site_lead_summary s on s.contact_id = m.contact_id
      where s.contact_id is null
         or exists (select 1 from public.site_events e
                    where e.visitor_id = m.visitor_id and e.event_type = 'pageview'
                      -- truncated so a row stored at millisecond precision
                      -- (every row before 2026-10-01's fix) cannot re-match forever
                      and date_trunc('milliseconds', e.created_at) > coalesce(s.last_visit, '-infinity'::timestamptz))
      order by m.contact_id
      limit ${n}`;
}

/**
 * Does a refreshed total deserve a GHL note? A note on every return visit
 * would bury the contact's timeline, so only when something a rep would act
 * on changed. Never for a backfill (no previous row): those contacts already
 * got their note when they were first stitched.
 */
export function refreshNoteReason(prev, next, { threshold = 50, highPaths = [] } = {}) {
  if (!prev || !prev.has_summary || !next) return null;
  const before = Number(prev.prev_score) || 0;
  const after = Number(next.score) || 0;
  if (before < threshold && after >= threshold) return 'crossed_high_intent';
  const seen = (prev.prev_page_counts && typeof prev.prev_page_counts === 'object') ? prev.prev_page_counts : {};
  const isHigh = (p) => highPaths.some(h => String(p || '').startsWith(h));
  const newHigh = Object.keys(next.page_counts || {}).find(p => isHigh(p) && !(p in seen));
  if (newHigh) return 'new_high_intent_page';
  if (after - before >= 20) return 'score_jump';
  return null;
}

/**
 * One batch of the 180-day cleanup (Mark, 2026-10-01). Only page views and
 * custom events from browsers that never identified — a stitched lead keeps
 * its whole history, and identify rows are never touched.
 */
export function buildRetentionDeleteSql(days, batch) {
  const d = Math.trunc(Number(days));
  const b = Math.max(1, Math.min(20000, Math.trunc(Number(batch)) || 5000));
  if (!(d >= 30)) throw new Error(`site_events retention: refusing ${days} days (minimum 30)`);
  const where = `e.event_type <> 'identify'
        and e.created_at < now() - interval '${d} days'
        and not exists (select 1 from public.visitor_identity_map m where m.visitor_id = e.visitor_id)`;
  return {
    count: `select count(*)::int as n from (select e.id from public.site_events e where ${where} limit ${b}) x`,
    delete: `delete from public.site_events where id in (select e.id from public.site_events e where ${where} limit ${b})`,
  };
}

/**
 * Did a refresh change anything GHL shows? If pages, score and last visit are
 * all the same as the stored row, the GHL write is skipped — a refresh must
 * never touch a contact (and wake any "contact changed" workflow) for nothing.
 * A backfill (no stored row) always counts as a change.
 */
export function refreshChanged(prev, next) {
  if (!prev || !prev.has_summary) return true;
  const ms = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
  return Number(prev.prev_pages) !== Number(next.pageviews)
    || Number(prev.prev_score) !== Number(next.score)
    || ms(prev.prev_last_visit) !== ms(next.last_visit);
}
