/**
 * I.STITCH — Visitor Identity Stitch & Enrichment — src/site-stitch.js
 *
 * Turns raw `site_events` (Visitor Identity Tracking Build v1.0) into enriched
 * GHL contact intelligence. A thin n8n cron (every 5 min) POSTs to
 * /n8n/site/stitch-batch; all the work happens here, reusing the LP-MCP
 * service-role Supabase client, run_sql, emitEvent, and the tag-safe GHL
 * helpers in ghl.js.
 *
 * Pipeline per batch:
 *   1. ensureSchema()  — idempotent DDL (sql/025) via run_sql.
 *   2. ensureGhlFields() — resolve/create the 4 GHL custom field IDs.
 *   3. Claim a batch of unprocessed `identify` events (FOR UPDATE SKIP LOCKED).
 *   4. Resolve GHL contact, match-only: raw.cid > email > phone. Never creates.
 *      Misses → unmatched_identities (+attempts) with re-queue backoff.
 *   5. Aggregate cross-domain history via visitor_links.
 *   6. Score intent 0–100 (recency ×2 within 7d, cap 100) — one editable rubric.
 *   7. Enrich GHL: updateGHLContactFields (customFields ONLY — never tags) +
 *      addGHLNote (deduped). NO tag writes whatsoever.
 *   8. Upsert visitor_identity_map for every linked visitor_id.
 *   9. emitEvent (bypass_filter) site.identity_stitched always; site.high_intent_signal
 *      when score >= threshold.
 *
 * Scope guardrail: ENRICH + SIGNAL ONLY. No messaging, no routing, no
 * stage/buyer/active-entry tag writes. The consuming agent_rule + event-intake
 * allowlist + Decision Engine reload are a separate post-deploy step (Mark).
 */

import supabase from './supabase.js';
import { runSQL } from './admin/supabase-admin.js';
import { emitEvent } from './event-emitter.js';
import { updateGHLContactFields, addGHLNote } from './ghl.js';
import { withGhlToken } from './ghl-rate-limiter.js';

// ─── Config (env with safe fallbacks — no n8n env dependency) ──────────────
const BATCH_SIZE = parseInt(process.env.STITCH_BATCH_SIZE || '50', 10);
const MAX_MATCH_ATTEMPTS = parseInt(process.env.STITCH_MAX_MATCH_ATTEMPTS || '3', 10);
const HIGH_THRESHOLD = parseInt(process.env.SITE_INTENT_HIGH_THRESHOLD || '50', 10);
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';
const GHL_API_KEY = process.env.GHL_API_KEY || '';
const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_HEADERS = {
  Authorization: `Bearer ${GHL_API_KEY}`,
  Version: '2021-07-28',
  'Content-Type': 'application/json',
};

// Intent rubric — kept in ONE editable object so it can later align to FT/Lead
// Gurus journey segments + the eight-pillar framework.
const RUBRIC = {
  high:   { weight: 25, paths: ['/financing', '/pricing', '/estimate', '/quote', '/free-quote', '/book', '/schedule'] },
  medium: { weight: 10, paths: ['/impact-windows', '/impact-doors', '/windows', '/doors', '/gallery'] },
  low:    { weight: 3,  paths: ['/about', '/blog', '/reviews'] },
  ignore: { weight: 0,  paths: ['/careers', '/privacy', '/terms'] },
  recency_days: 7,
  recency_multiplier: 2,
  cap: 100,
};

// The 4 custom fields I.STITCH writes. dataType per GHL v2.
const SITE_FIELDS = [
  { name: 'last_site_visit',   dataType: 'DATE' },
  { name: 'site_intent_score', dataType: 'NUMERICAL' },
  { name: 'site_pages_viewed', dataType: 'NUMERICAL' },
  { name: 'first_touch_source', dataType: 'TEXT' },
];

// ─── Idempotent schema bootstrap (sql/025 mirror) ──────────────────────────
const DDL_STATEMENTS = [
  `create table if not exists public.site_events (
     id bigint generated always as identity primary key,
     event_type text not null, visitor_id text not null, session_id text,
     page_path text, utm_source text, fbclid text,
     identity_email text, identity_phone text,
     raw jsonb not null default '{}', created_at timestamptz not null default now(),
     processed_at timestamptz)`,
  `create index if not exists idx_site_events_unprocessed on public.site_events (created_at)
     where event_type = 'identify' and processed_at is null`,
  `create index if not exists idx_site_events_visitor on public.site_events (visitor_id, created_at)`,
  `create table if not exists public.visitor_links (
     id bigint generated always as identity primary key,
     id_a text not null, id_b text not null, created_at timestamptz not null default now())`,
  `create index if not exists idx_visitor_links_a on public.visitor_links (id_a)`,
  `create index if not exists idx_visitor_links_b on public.visitor_links (id_b)`,
  `create table if not exists public.visitor_identity_map (
     visitor_id text primary key, contact_id text not null,
     stitched_at timestamptz not null default now(), last_enriched_at timestamptz)`,
  `create index if not exists idx_vim_contact on public.visitor_identity_map (contact_id)`,
  `create table if not exists public.unmatched_identities (
     id bigint generated always as identity primary key,
     site_event_id bigint, visitor_id text, identity_email text, identity_phone text,
     attempts int not null default 1, first_seen timestamptz not null default now(),
     last_attempt timestamptz not null default now())`,
  `create unique index if not exists uq_unmatched_visitor on public.unmatched_identities (visitor_id)`,
  // Atomic claim encapsulated in a function: a data-modifying CTE is only legal at
  // the top level of a statement, so it cannot live inside run_sql's SELECT-wrapper.
  // Wrapping it in a SQL function lets us call `select * from claim_site_identify_events(n)`
  // (a plain SELECT, safe to wrap) while the FOR UPDATE SKIP LOCKED + UPDATE run inside.
  `create or replace function public.claim_site_identify_events(p_limit int)
   returns setof public.site_events
   language sql
   as $claim$
     with claimed as (
       select id from public.site_events
       where event_type = 'identify' and processed_at is null
       order by created_at
       limit p_limit
       for update skip locked
     )
     update public.site_events s set processed_at = now()
     from claimed c where s.id = c.id
     returning s.*;
   $claim$`,
];

let schemaEnsured = false;
async function ensureSchema() {
  if (schemaEnsured) return;
  for (const stmt of DDL_STATEMENTS) {
    await runSQL(stmt);
  }
  schemaEnsured = true;
  console.log('[I.STITCH] schema ensured (site_events, visitor_links, visitor_identity_map, unmatched_identities)');
}

// ─── GHL custom field resolution (resolve by name, create if missing) ──────
let fieldIdCache = null; // { last_site_visit: id, ... }

async function ensureGhlFields() {
  if (fieldIdCache) return fieldIdCache;
  const map = {};
  // List existing
  let existing = [];
  try {
    const res = await withGhlToken(() => fetch(`${GHL_BASE}/locations/${GHL_LOCATION_ID}/customFields?model=contact`, {
      headers: GHL_HEADERS, signal: AbortSignal.timeout(15000),
    }));
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      existing = data.customFields || data.customField || [];
    } else {
      console.warn(`[I.STITCH] customFields list HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`[I.STITCH] customFields list failed: ${err.message}`);
  }

  const findByName = (n) => existing.find(f => {
    const name = (f.name || '').toLowerCase();
    const key = (f.fieldKey || '').toLowerCase();
    return name === n.toLowerCase() || key.endsWith('.' + n.toLowerCase()) || key === n.toLowerCase();
  });

  for (const f of SITE_FIELDS) {
    const hit = findByName(f.name);
    if (hit?.id) { map[f.name] = hit.id; continue; }
    // Create
    try {
      const res = await withGhlToken(() => fetch(`${GHL_BASE}/locations/${GHL_LOCATION_ID}/customFields`, {
        method: 'POST', headers: GHL_HEADERS,
        body: JSON.stringify({ name: f.name, dataType: f.dataType, model: 'contact' }),
        signal: AbortSignal.timeout(15000),
      }));
      const data = await res.json().catch(() => ({}));
      const id = data?.customField?.id || data?.id || null;
      if (id) {
        map[f.name] = id;
        console.log(`[I.STITCH] created GHL custom field ${f.name} → ${id}`);
      } else {
        console.warn(`[I.STITCH] could not create/resolve GHL field ${f.name}: ${JSON.stringify(data).slice(0, 200)}`);
      }
    } catch (err) {
      console.warn(`[I.STITCH] create field ${f.name} failed: ${err.message}`);
    }
  }
  // Cache only if all four resolved, so a transient miss can retry next run.
  if (SITE_FIELDS.every(f => map[f.name])) fieldIdCache = map;
  return map;
}

// ─── GHL contact resolution (match-only, exact) ────────────────────────────
const digits = (s) => String(s || '').replace(/[^0-9]/g, '');

async function ghlSearchContacts(query) {
  try {
    const url = `${GHL_BASE}/contacts/?locationId=${encodeURIComponent(GHL_LOCATION_ID)}&query=${encodeURIComponent(query)}&limit=20`;
    const res = await withGhlToken(() => fetch(url, { headers: GHL_HEADERS, signal: AbortSignal.timeout(15000) }));
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return data.contacts || [];
  } catch (err) {
    console.warn(`[I.STITCH] GHL search failed for "${query}": ${err.message}`);
    return [];
  }
}

async function resolveContactId(ev) {
  const raw = ev.raw || {};
  if (raw.cid) return raw.cid; // (1) highest confidence — no search

  if (ev.identity_email) {       // (2) exact email
    const want = String(ev.identity_email).toLowerCase();
    const hit = (await ghlSearchContacts(ev.identity_email)).find(c => (c.email || '').toLowerCase() === want);
    if (hit) return hit.id;
  }
  if (ev.identity_phone) {       // (3) normalized phone (last 10)
    const want = digits(ev.identity_phone).slice(-10);
    if (want.length >= 10) {
      const hit = (await ghlSearchContacts(ev.identity_phone)).find(c => digits(c.phone).endsWith(want));
      if (hit) return hit.id;
    }
  }
  return null;
}

// ─── Unmatched backoff ─────────────────────────────────────────────────────
// Split into separate statements: data-modifying CTEs can't be SELECT-wrapped by
// run_sql, so we upsert (non-SELECT), read attempts (SELECT), then conditionally
// re-queue (non-SELECT).
async function recordUnmatched(ev) {
  const email = ev.identity_email ? `'${String(ev.identity_email).replace(/'/g, "''")}'` : 'null';
  const phone = ev.identity_phone ? `'${String(ev.identity_phone).replace(/'/g, "''")}'` : 'null';
  const vid = String(ev.visitor_id).replace(/'/g, "''");

  await runSQL(`
    insert into public.unmatched_identities
      (site_event_id, visitor_id, identity_email, identity_phone, attempts, first_seen, last_attempt)
    values (${Number(ev.id)}, '${vid}', ${email}, ${phone}, 1, now(), now())
    on conflict (visitor_id) do update
      set attempts = public.unmatched_identities.attempts + 1, last_attempt = now()`);

  const rows = await runSQL(`select attempts from public.unmatched_identities where visitor_id = '${vid}'`);
  const attempts = Array.isArray(rows) && rows[0] ? Number(rows[0].attempts) : 1;

  let requeued = false;
  if (attempts < MAX_MATCH_ATTEMPTS) {
    await runSQL(`update public.site_events set processed_at = null where id = ${Number(ev.id)}`);
    requeued = true;
  }
  return { attempts, requeued };
}

// ─── Cross-domain aggregation (visitor_links + site_events) ────────────────
async function aggregateHistory(visitorId, contactId, maxEventId) {
  const vid = String(visitorId).replace(/'/g, "''");
  const cid = String(contactId).replace(/'/g, "''");
  const sql = `
    with linked as (
      select distinct unnest(array[id_a, id_b]) as vid from public.visitor_links
      where id_a = '${vid}' or id_b = '${vid}'
      union select '${vid}'
    ),
    ev as (
      select * from public.site_events
      where visitor_id in (select vid from linked) and event_type = 'pageview'
    ),
    perpage as (
      select page_path,
             count(*) as cnt,
             count(*) filter (where created_at >= now() - interval '${RUBRIC.recency_days} days') as recent_cnt
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
  const rows = await runSQL(sql);
  return Array.isArray(rows) ? rows[0] : null;
}

// ─── Intent scoring ────────────────────────────────────────────────────────
function tierWeight(path) {
  for (const t of ['high', 'medium', 'low', 'ignore']) {
    if (RUBRIC[t].paths.some(p => String(path || '').startsWith(p))) return RUBRIC[t].weight;
  }
  return RUBRIC.low.weight; // unknown pages default to low
}

function scoreIntent(agg) {
  const counts = agg.page_counts || {};
  const recent = agg.recent_page_counts || {};
  let score = 0;
  for (const [path, c] of Object.entries(counts)) score += tierWeight(path) * Number(c);
  for (const [path, c] of Object.entries(recent)) score += tierWeight(path) * Number(c) * (RUBRIC.recency_multiplier - 1);
  score = Math.min(Math.round(score), RUBRIC.cap);
  const top_pages = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => x[0]);
  return { score, top_pages };
}

// ─── Persist mapping ───────────────────────────────────────────────────────
async function persistMap(visitorIdsCsv, contactId) {
  if (!visitorIdsCsv) return;
  const csv = String(visitorIdsCsv).replace(/'/g, "''");
  const cid = String(contactId).replace(/'/g, "''");
  await runSQL(`
    insert into public.visitor_identity_map (visitor_id, contact_id, last_enriched_at)
    select trim(v), '${cid}', now()
    from unnest(string_to_array('${csv}', ',')) as v
    where trim(v) <> ''
    on conflict (visitor_id) do update
      set contact_id = excluded.contact_id, last_enriched_at = now()`);
}

// ─── Per-item processing ───────────────────────────────────────────────────
async function processEvent(ev, fields) {
  const contactId = await resolveContactId(ev);
  if (!contactId) {
    const u = await recordUnmatched(ev);
    return { matched: false, requeued: !!(u && Number(u.requeued) > 0), attempts: u?.attempts };
  }

  const agg = await aggregateHistory(ev.visitor_id, contactId, ev.id) || {
    contact_id: contactId, max_site_event_id: ev.id, visitor_ids: [ev.visitor_id],
    visitor_ids_csv: ev.visitor_id, pageviews: 0, sessions: 0, last_visit: null,
    first_touch_source: null, page_counts: {}, recent_page_counts: {},
  };
  const { score, top_pages } = scoreIntent(agg);

  // Enrich GHL — customFields ONLY (never tags) + deduped note.
  const cf = [];
  if (fields.last_site_visit && agg.last_visit) cf.push({ id: fields.last_site_visit, field_value: agg.last_visit });
  if (fields.site_intent_score) cf.push({ id: fields.site_intent_score, field_value: score });
  if (fields.site_pages_viewed) cf.push({ id: fields.site_pages_viewed, field_value: Number(agg.pageviews) || 0 });
  if (fields.first_touch_source) cf.push({ id: fields.first_touch_source, field_value: agg.first_touch_source || '' });
  if (cf.length) await updateGHLContactFields(contactId, cf);

  const note = `Site activity: ${agg.pageviews || 0} pageviews / ${agg.sessions || 0} sessions. `
    + `Last visit ${agg.last_visit || 'n/a'}. Top pages: ${(top_pages || []).join(', ') || 'n/a'}. `
    + `First touch: ${agg.first_touch_source || 'unknown'}. Intent score ${score}.`;
  await addGHLNote(contactId, note, { dedupe: true });

  // Persist mapping for every linked visitor_id.
  await persistMap(agg.visitor_ids_csv || ev.visitor_id, contactId);

  // Emit to the agentic brain (bypass the intake filter — consumers are a
  // documented post-deploy step; we want these to land now).
  const visitorIds = Array.isArray(agg.visitor_ids) ? agg.visitor_ids : [ev.visitor_id];
  let high = false;
  await emitEvent({
    event_type: 'site.identity_stitched', source: 'i_stitch',
    entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
    priority: 'normal', bypass_filter: true,
    payload: { contact_id: contactId, visitor_ids: visitorIds, site_intent_score: score, pageviews: Number(agg.pageviews) || 0, first_touch_source: agg.first_touch_source || null },
    idempotency_key: `site.identity_stitched:${contactId}:${agg.max_site_event_id}`,
  });
  if (score >= HIGH_THRESHOLD) {
    high = true;
    await emitEvent({
      event_type: 'site.high_intent_signal', source: 'i_stitch',
      entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
      priority: 'high', bypass_filter: true,
      payload: { contact_id: contactId, score, top_pages, first_touch_source: agg.first_touch_source || null },
      idempotency_key: `site.high_intent_signal:${contactId}:${agg.max_site_event_id}`,
    });
  }
  return { matched: true, contact_id: contactId, score, high };
}

// ─── Batch handler ─────────────────────────────────────────────────────────
export async function stitchBatch() {
  if (!supabase) return { ok: false, error: 'supabase_not_configured' };
  const startedAt = Date.now();
  await ensureSchema();
  const fields = await ensureGhlFields();

  // The data modification lives inside the function; calling it is a plain SELECT
  // that run_sql can safely wrap and return as rows.
  const claimed = await runSQL(`select * from public.claim_site_identify_events(${BATCH_SIZE})`);
  const rows = Array.isArray(claimed) ? claimed : [];
  if (rows.length === 0) {
    return { ok: true, claimed: 0, matched: 0, unmatched: 0, emitted: 0, high_intent: 0, elapsed_ms: Date.now() - startedAt };
  }

  let matched = 0, unmatched = 0, high = 0;
  for (const ev of rows) {
    try {
      const r = await processEvent(ev, fields);
      if (r.matched) { matched++; if (r.high) high++; } else { unmatched++; }
    } catch (err) {
      console.error(`[I.STITCH] event ${ev.id} failed: ${err.message}`);
    }
  }
  const summary = { ok: true, claimed: rows.length, matched, unmatched, emitted: matched, high_intent: high, elapsed_ms: Date.now() - startedAt };
  console.log(`[I.STITCH] batch: ${JSON.stringify(summary)}`);
  return summary;
}

// ─── Smoke-test seed ───────────────────────────────────────────────────────
export async function seedTest({ contact_id = '0kk3xz6XatILy8jajymX', visitor_id, identity_email = null, pages } = {}) {
  await ensureSchema();
  const vid = visitor_id || `vtest_${Date.now()}`;
  const session = `s_${Date.now()}`;
  const pagePaths = Array.isArray(pages) && pages.length ? pages : ['/pricing', '/estimate'];
  const cidLit = contact_id ? `'${String(contact_id).replace(/'/g, "''")}'` : 'null';
  const emailLit = identity_email ? `'${String(identity_email).replace(/'/g, "''")}'` : 'null';
  const vidLit = String(vid).replace(/'/g, "''");

  // identify event (raw.cid drives highest-confidence resolution)
  await runSQL(`insert into public.site_events (event_type, visitor_id, session_id, identity_email, raw)
    values ('identify', '${vidLit}', '${session}', ${emailLit}, jsonb_build_object('cid', ${cidLit}))`);
  // a couple of high-intent pageviews
  for (const p of pagePaths) {
    await runSQL(`insert into public.site_events (event_type, visitor_id, session_id, page_path, utm_source)
      values ('pageview', '${vidLit}', '${session}', '${String(p).replace(/'/g, "''")}', 'seed_test')`);
  }
  return { ok: true, seeded_visitor_id: vid, contact_id, pages: pagePaths };
}

// ─── Routes ────────────────────────────────────────────────────────────────
export function registerSiteStitchRoutes(app) {
  // POST /n8n/site/stitch-batch — main worker (n8n 5-min cron). No auth, matches /n8n/* surface.
  app.post('/n8n/site/stitch-batch', async (req, res) => {
    try {
      const result = await stitchBatch();
      res.status(result.ok ? 200 : 500).json(result);
    } catch (err) {
      console.error(`[I.STITCH] stitch-batch unhandled: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /n8n/site/seed-test — one-shot smoke-test seeder.
  app.post('/n8n/site/seed-test', async (req, res) => {
    try {
      const result = await seedTest(req.body || {});
      res.status(200).json(result);
    } catch (err) {
      console.error(`[I.STITCH] seed-test error: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  console.log('[REST API] Registered: POST /n8n/site/stitch-batch | POST /n8n/site/seed-test');
}
