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
