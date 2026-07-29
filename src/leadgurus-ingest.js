/**
 * I.LG — Lead Gurus Daily Pull — src/leadgurus-ingest.js
 *
 * Lead Gurus is the paid-media agency platform (clients.leadgurus.com, client
 * id 91) that holds Reece Windows' FB ad spend, leads, and revenue. A thin n8n
 * cron (daily ~06:00 ET) POSTs to /n8n/leadgurus/daily-pull; all the work
 * happens here, reusing the LP-MCP service-role Supabase client and the
 * tag-safe GHL helpers in ghl.js.
 *
 * Per pull (a date window):
 *   1. GET /api/v1/summary/client|territory|channel/ → upsert ft_daily_summary,
 *      ft_summary_territory, ft_summary_channel (revenue/spend attribution).
 *   2. GET /api/v1/leads/?client=91 (paginate `next`) → upsert ft_leads.
 *   3. (gated, default OFF) per upserted lead, match a GHL contact by email then
 *      phone and write the ft_* customFields — customFields ONLY, never tags,
 *      never creating a contact.
 *
 * Auth: header X-API-Key: process.env.LEAD_GURUS_API_KEY (set on the LP-MCP
 * Railway service — never inline). Schema lives in sql/027_leadgurus_ingest.sql.
 */

import { createHash } from 'node:crypto';
import supabase from './supabase.js';
import { searchGHLContact, updateGHLContactFields } from './ghl.js';

// ─── Config (env with safe fallbacks — no n8n env dependency) ──────────────
const LG_BASE = 'https://clients.leadgurus.com';
const LG_CLIENT_ID = process.env.LEAD_GURUS_CLIENT_ID || '91';
const LG_API_KEY = process.env.LEAD_GURUS_API_KEY || '';
const LEADS_PAGE_SIZE = parseInt(process.env.LEAD_GURUS_LEADS_PAGE_SIZE || '500', 10);   // API max 500
const BACKFILL_START = process.env.LEAD_GURUS_BACKFILL_START || '2026-01-01';

// Enrichment is OFF until Mark creates the 5 GHL custom fields and sets their
// IDs below. It runs only when LEAD_GURUS_ENRICH_ENABLED=true AND every field
// id is present — so the branch ships disabled and harmless.
const ENRICH_FIELD_IDS = {
  ft_campaign_id:  process.env.GHL_CF_FT_CAMPAIGN_ID || '',
  ft_credit_score: process.env.GHL_CF_FT_CREDIT_SCORE || '',
  ft_project_type: process.env.GHL_CF_FT_PROJECT_TYPE || '',
  ft_self_book_dt: process.env.GHL_CF_FT_SELF_BOOK_DT || '',
  ft_territory:    process.env.GHL_CF_FT_TERRITORY || '',
};
const ENRICH_ENABLED =
  process.env.LEAD_GURUS_ENRICH_ENABLED === 'true' &&
  Object.values(ENRICH_FIELD_IDS).every(Boolean);

// ─── Small helpers ──────────────────────────────────────────────────────────
const digits = (s) => String(s || '').replace(/[^0-9]/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// First defined value among the candidate keys (the Lead Gurus payload field
// names are mapped defensively so a rename doesn't silently null a column).
function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return null;
}

function toInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// YYYY-MM-DD for "today + offsetDays" in America/New_York.
function etDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Add N months to a YYYY-MM-DD string, clamped to the 1st.
function addMonths(ymd, n) {
  const [y, m] = ymd.split('-').map(Number);
  const d = new Date(Date.UTC(y, (m - 1) + n, 1));
  return d.toISOString().slice(0, 10);
}

// Normalize any list-ish API body to an array of items. Tolerant of the
// wrapper key (results/data/<custom>) and one level of nesting, since the
// Lead Gurus leads feed wraps its list differently from the summary feeds.
const isArrayOfObjects = (v) => Array.isArray(v) && (v.length === 0 || (typeof v[0] === 'object' && v[0] !== null));
function asArray(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.results)) return body.results;
  if (Array.isArray(body?.data)) return body.data;
  if (!body || typeof body !== 'object') return [];
  // First top-level array of objects (e.g. { count, next, leads: [...] }).
  for (const v of Object.values(body)) {
    if (isArrayOfObjects(v)) return v;
  }
  // One level deep (e.g. { next, data: { leads: [...] } }).
  for (const v of Object.values(body)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const vv of Object.values(v)) {
        if (isArrayOfObjects(vv)) return vv;
      }
    }
  }
  return [];
}

// The Lead Gurus leads feed returns NO server id (verified from the live
// payload: client_name…full_name,email,phone,…,campaign_id,ad_id,…). So if no
// real id is present we synthesize a stable surrogate by hashing the lead's
// identity fields — deterministic across re-runs (uses date_created, not the
// volatile date_updated) so the upsert stays idempotent.
function leadId(it) {
  const real = pick(it, 'id', 'lead_id', 'leadId', 'pk', 'uuid', 'lead_pk', 'external_id');
  if (real != null && String(real).trim() !== '') return String(real).trim();
  const parts = [
    pick(it, 'date_created', 'created_at', 'created') || '',
    String(pick(it, 'email') || '').toLowerCase().trim(),
    digits(pick(it, 'phone', 'phone_number')),
    pick(it, 'ad_id') || '',
    pick(it, 'campaign_id', 'campaign') || '',
    pick(it, 'self_book_appointment_datetime', 'self_book_datetime') || '',
    String(pick(it, 'full_name', 'name') || '').toLowerCase().trim(),
  ];
  // Empty identity → no usable key (skip rather than collapse onto a blank hash).
  if (parts.every((p) => p === '' || p === null)) return '';
  return 'lg_' + createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 24);
}

// Keep the LAST row per conflict key so a batch never contains the same key
// twice — Postgres rejects ON CONFLICT DO UPDATE touching a row twice in one
// statement (PostgREST sends the whole upsert as a single statement).
function dedupeByKey(rows, keyFn) {
  const m = new Map();
  for (const r of rows) m.set(keyFn(r), r);
  return [...m.values()];
}

// Every metric/date key the summary mapping consumes. Used to locate the one
// remaining "dimension" field (territory/channel name) generically, so the
// ingest doesn't depend on the exact key Lead Gurus happens to use for it.
const METRIC_SRC_KEYS = new Set([
  'total_leads', 'leads', 'lead_count',
  'total_spend', 'spend', 'ad_spend',
  'cost_per_lead', 'cpl',
  'accepted_count', 'accepted',
  'success_count', 'success', 'success_post_count',
  'self_book_count', 'self_books', 'self_booked',
  'cost_per_self_book', 'cost_per_self_booked', 'cpsb',
  'booked', 'booked_count', 'scheduled', 'scheduled_count',
  'demos', 'demo_count', 'issues', 'issue_count',
  'gross_sales', 'gross_sale_count', 'gross_amount', 'gross_revenue', 'gross',
  'net_sales', 'net_sale_count', 'net_amount', 'net_revenue', 'net',
]);
const DATE_KEYS = new Set(['date', 'day', 'date_after', 'date_before', 'pulled_at']);

// The dimension value for a territory/channel row: try the expected names, then
// fall back to the first non-metric, non-date string field on the item.
function detectDimension(item, preferred) {
  for (const k of preferred) {
    const v = item?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  for (const [k, v] of Object.entries(item || {})) {
    if (METRIC_SRC_KEYS.has(k) || DATE_KEYS.has(k)) continue;
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return 'unknown';
}

// ─── Lead Gurus HTTP ────────────────────────────────────────────────────────
async function lgGet(pathOrUrl, params = null) {
  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : `${LG_BASE}${pathOrUrl}${params ? '?' + new URLSearchParams(params).toString() : ''}`;
  // Retry on 429, honouring Retry-After (the API throttles bursty backfills).
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { 'X-API-Key': LG_API_KEY, Accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 429 && attempt < 5) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2 ** attempt, 60) * 1000;
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Lead Gurus GET ${url} → HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json();
  }
}

// ─── Summary mapping (shared metric columns) ────────────────────────────────
function mapMetrics(item) {
  return {
    total_leads:        toInt(pick(item, 'total_leads', 'leads', 'lead_count')),
    total_spend:        toNum(pick(item, 'total_spend', 'spend', 'ad_spend')),
    cost_per_lead:      toNum(pick(item, 'cost_per_lead', 'cpl')),
    accepted_count:     toInt(pick(item, 'accepted_count', 'accepted')),
    success_count:      toInt(pick(item, 'success_count', 'success', 'success_post_count')),
    self_book_count:    toInt(pick(item, 'self_book_count', 'self_books', 'self_booked')),
    cost_per_self_book: toNum(pick(item, 'cost_per_self_book', 'cost_per_self_booked', 'cpsb')),
    booked:             toInt(pick(item, 'booked', 'booked_count')),
    scheduled:          toInt(pick(item, 'scheduled', 'scheduled_count')),
    demos:              toInt(pick(item, 'demos', 'demo_count')),
    issues:             toInt(pick(item, 'issues', 'issue_count')),
    gross_sales:        toInt(pick(item, 'gross_sales', 'gross_sale_count')),
    gross_amount:       toNum(pick(item, 'gross_amount', 'gross_revenue', 'gross')),
    net_sales:          toInt(pick(item, 'net_sales', 'net_sale_count')),
    net_amount:         toNum(pick(item, 'net_amount', 'net_revenue', 'net')),
  };
}

async function upsertSummary({ date_after, date_before }) {
  const params = { client: LG_CLIENT_ID, date_after, date_before, page_size: '1000' };
  const out = { daily: 0, territory: 0, channel: 0, dimensions: {}, errors: [] };

  // client (daily) — one row per date.
  try {
    const client = asArray(await lgGet('/api/v1/summary/client/', params));
    const rows = dedupeByKey(
      client
        .map((it) => ({ date: pick(it, 'date', 'day', 'date_after') || date_after, ...mapMetrics(it) }))
        .filter((r) => r.date),
      (r) => r.date,
    );
    if (rows.length) {
      const { error } = await supabase.from('ft_daily_summary').upsert(rows, { onConflict: 'date' });
      if (error) throw new Error(error.message);
    }
    out.daily = rows.length;
  } catch (e) {
    out.errors.push(`daily: ${e.message}`);
  }

  // territory — one row per (date, territory). Dimension field name detected
  // generically so we don't depend on the exact key the API uses.
  try {
    const territory = asArray(await lgGet('/api/v1/summary/territory/', params));
    const rows = dedupeByKey(
      territory
        .map((it) => ({
          date: pick(it, 'date', 'day') || date_after,
          territory: detectDimension(it, ['territory', 'territory_name', 'name', 'region', 'market', 'office']),
          ...mapMetrics(it),
        }))
        .filter((r) => r.date && r.territory),
      (r) => `${r.date}|${r.territory}`,
    );
    if (rows.length) {
      const { error } = await supabase.from('ft_summary_territory').upsert(rows, { onConflict: 'date,territory' });
      if (error) throw new Error(error.message);
    }
    out.territory = rows.length;
    out.dimensions.territory = [...new Set(rows.map((r) => r.territory))].slice(0, 12);
  } catch (e) {
    out.errors.push(`territory: ${e.message}`);
  }

  // channel — one row per (date, channel).
  try {
    const channel = asArray(await lgGet('/api/v1/summary/channel/', params));
    const rows = dedupeByKey(
      channel
        .map((it) => ({
          date: pick(it, 'date', 'day') || date_after,
          channel: detectDimension(it, ['channel', 'channel_name', 'name', 'medium', 'source']),
          ...mapMetrics(it),
        }))
        .filter((r) => r.date && r.channel),
      (r) => `${r.date}|${r.channel}`,
    );
    if (rows.length) {
      const { error } = await supabase.from('ft_summary_channel').upsert(rows, { onConflict: 'date,channel' });
      if (error) throw new Error(error.message);
    }
    out.channel = rows.length;
    out.dimensions.channel = [...new Set(rows.map((r) => r.channel))].slice(0, 12);
  } catch (e) {
    out.errors.push(`channel: ${e.message}`);
  }

  return out;
}

// ─── Leads mapping + paginated pull ─────────────────────────────────────────
function mapLead(it) {
  const full_name =
    pick(it, 'full_name', 'name') ||
    [pick(it, 'first_name'), pick(it, 'last_name')].filter(Boolean).join(' ') ||
    null;
  return {
    lead_id:    leadId(it),
    full_name,
    email:      pick(it, 'email'),
    phone:      pick(it, 'phone', 'phone_number'),
    address:    pick(it, 'address', 'address1', 'street'),
    city:       pick(it, 'city'),
    state:      pick(it, 'state', 'region'),
    zip_code:   pick(it, 'zip_code', 'zip', 'postal_code'),
    territory:  pick(it, 'territory', 'territory_name'),
    vertical:   pick(it, 'vertical'),
    campaign_id: pick(it, 'campaign_id', 'campaign'),
    ad_set_id:  pick(it, 'ad_set_id', 'adset_id'),
    ad_id:      pick(it, 'ad_id'),
    source:     pick(it, 'source', 'utm_source'),
    medium:     pick(it, 'medium', 'utm_medium'),
    credit_score: pick(it, 'credit_score') != null ? String(pick(it, 'credit_score')) : null,
    project_type: pick(it, 'project_type'),
    windows_count: toInt(pick(it, 'windows_count', 'window_count', 'num_windows')),
    success_post: pick(it, 'success_post') != null ? Boolean(pick(it, 'success_post')) : null,
    self_book_appointment_datetime: pick(it, 'self_book_appointment_datetime', 'self_book_datetime'),
    created_at: pick(it, 'date_created', 'created_at', 'created'),
    raw: it,
  };
}

async function pullLeads({ date_after, date_before }) {
  // Bound the window on both ends — the leads endpoint caps a query at 90 days,
  // so an open-ended date_after spans to "now" and 400s on older windows.
  const qs = { client: LG_CLIENT_ID, date_after, page_size: String(LEADS_PAGE_SIZE) };
  if (date_before) qs.date_before = date_before;
  let url = `${LG_BASE}/api/v1/leads/?` + new URLSearchParams(qs).toString();

  let upserted = 0;
  let enriched = 0;
  let pages = 0;
  const guard = 200; // hard cap on pages (200 × 500 = 100k leads)

  let diagLogged = false;
  while (url && pages < guard) {
    const body = await lgGet(url);
    const items = asArray(body);
    pages++;
    // One-time diagnostic: if the first page yields no usable rows, log the
    // body/item shape so the real wrapper key + id field are visible in logs.
    if (!diagLogged && (!items.length || !leadId(items[0]))) {
      diagLogged = true;
      console.warn(
        `[I.LG] leads shape: bodyKeys=${JSON.stringify(Object.keys(body || {}))} ` +
        `items=${items.length} firstItemKeys=${JSON.stringify(items[0] ? Object.keys(items[0]) : [])}`,
      );
    }
    if (items.length) {
      const rows = dedupeByKey(items.map(mapLead).filter((r) => r.lead_id), (r) => r.lead_id);
      if (rows.length) {
        const { error } = await supabase.from('ft_leads').upsert(rows, { onConflict: 'lead_id' });
        if (error) throw new Error(`ft_leads upsert: ${error.message}`);
        upserted += rows.length;
        if (ENRICH_ENABLED) enriched += await enrichLeads(rows);
      }
    }
    url = body?.next || null; // DRF-style cursor; absolute URL when present
    if (url) await sleep(250); // gentle pacing to stay under the rate limit
  }
  return { upserted, enriched, pages };
}

// ─── GHL enrichment (gated; email then phone; customFields ONLY) ────────────
async function matchContact(lead) {
  if (lead.email) {
    const want = String(lead.email).toLowerCase();
    const c = await searchGHLContact({ email: want });
    if (c && (c.email || '').toLowerCase() === want) return c;
  }
  if (lead.phone) {
    const want = digits(lead.phone).slice(-10);
    if (want.length >= 10) {
      const c = await searchGHLContact({ phone: lead.phone });
      if (c && digits(c.phone).endsWith(want)) return c;
    }
  }
  return null;
}

function buildCustomFields(lead) {
  const cf = [];
  const add = (id, v) => { if (id && v !== null && v !== undefined && v !== '') cf.push({ id, field_value: v }); };
  add(ENRICH_FIELD_IDS.ft_campaign_id,  lead.campaign_id);
  add(ENRICH_FIELD_IDS.ft_credit_score, lead.credit_score);
  add(ENRICH_FIELD_IDS.ft_project_type, lead.project_type);
  add(ENRICH_FIELD_IDS.ft_self_book_dt, lead.self_book_appointment_datetime);
  add(ENRICH_FIELD_IDS.ft_territory,    lead.territory);
  return cf;
}

async function enrichLeads(rows) {
  let n = 0;
  let notFound = 0;
  for (const lead of rows) {
    try {
      const contact = await matchContact(lead);     // skip on no match — never create
      if (!contact) continue;
      const cf = buildCustomFields(lead);
      if (!cf.length) continue;
      // 2026-07-29: was `if (cf.length && (await updateGHLContactFields(...))) n++`.
      // updateGHLContactFields returns the TRUTHY string 'not_found' when the
      // contact is unreachable, so bare truthiness counted a failed write as a
      // successful enrichment. Strict === true is the only success.
      const result = await updateGHLContactFields(contact.id, cf); // customFields ONLY
      if (result === true) {
        n++;
      } else if (result === 'not_found') {
        // No stored link to clear — contact.id came from a live searchGHLContact
        // against GHL_LOCATION_ID moments ago, so an unreachable contact here
        // means the search and the write disagree about location. That is a
        // configuration fault, not a dead contact; surface it loudly.
        notFound++;
        console.warn(`[I.LG] enrich lead ${lead.lead_id}: GHL contact ${contact.id} unreachable (search-derived id rejected on write) — not counted`);
      } else {
        console.warn(`[I.LG] enrich lead ${lead.lead_id}: GHL field write returned ${result} for ${contact.id} — not counted`);
      }
    } catch (err) {
      console.warn(`[I.LG] enrich lead ${lead.lead_id} failed: ${err.message}`);
    }
  }
  if (notFound > 0) {
    console.error(`[I.LG] ${notFound}/${rows.length} enrichment targets were unreachable — check GHL_LOCATION_ID and token scope`);
  }
  return n;
}

// ─── Pull orchestration ─────────────────────────────────────────────────────
export async function runPull({ date_after, date_before } = {}) {
  if (!supabase) return { ok: false, error: 'supabase_not_configured' };
  if (!LG_API_KEY) return { ok: false, error: 'LEAD_GURUS_API_KEY_not_set' };
  const startedAt = Date.now();
  date_after = date_after || etDate(-1);
  date_before = date_before || etDate(0);

  const summary = await upsertSummary({ date_after, date_before });
  const leads = await pullLeads({ date_after, date_before });

  const result = {
    ok: true, date_after, date_before, summary, leads,
    enrich_enabled: ENRICH_ENABLED, elapsed_ms: Date.now() - startedAt,
  };
  console.log(`[I.LG] pull: ${JSON.stringify(result)}`);
  return result;
}

// Manual backfill: walk monthly windows from start_date forward to end_date.
export async function runBackfill({ start_date, end_date } = {}) {
  if (!supabase) return { ok: false, error: 'supabase_not_configured' };
  if (!LG_API_KEY) return { ok: false, error: 'LEAD_GURUS_API_KEY_not_set' };
  const startedAt = Date.now();
  const start = start_date || BACKFILL_START;
  const end = end_date || etDate(0);

  const windows = [];
  let cursor = start;
  while (cursor < end) {
    const next = addMonths(cursor, 1);
    windows.push({ date_after: cursor, date_before: next < end ? next : end });
    cursor = next;
  }

  const results = [];
  for (const w of windows) {
    try {
      results.push(await runPull(w));
    } catch (err) {
      console.error(`[I.LG] backfill window ${w.date_after}..${w.date_before} failed: ${err.message}`);
      results.push({ ok: false, ...w, error: err.message });
    }
  }
  const out = {
    ok: true, start, end, windows: windows.length,
    leads_upserted: results.reduce((a, r) => a + (r?.leads?.upserted || 0), 0),
    elapsed_ms: Date.now() - startedAt,
    windows_detail: results,
  };
  console.log(`[I.LG] backfill: ${windows.length} windows, ${out.leads_upserted} leads`);
  return out;
}

// ─── Routes ────────────────────────────────────────────────────────────────
export function registerLeadGurusRoutes(app) {
  // POST /n8n/leadgurus/daily-pull — daily n8n cron target. No auth, matches /n8n/* surface.
  // Body (optional): { date_after, date_before } (YYYY-MM-DD). Defaults yesterday→today ET.
  app.post('/n8n/leadgurus/daily-pull', async (req, res) => {
    try {
      const result = await runPull(req.body || {});
      res.status(result.ok ? 200 : 500).json(result);
    } catch (err) {
      console.error(`[I.LG] daily-pull unhandled: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /n8n/leadgurus/backfill — manual history seed. Body (optional):
  // { start_date='2026-01-01', end_date=today }. Walks monthly windows.
  app.post('/n8n/leadgurus/backfill', async (req, res) => {
    try {
      const result = await runBackfill(req.body || {});
      res.status(result.ok ? 200 : 500).json(result);
    } catch (err) {
      console.error(`[I.LG] backfill unhandled: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  console.log('[REST API] Registered: POST /n8n/leadgurus/daily-pull | POST /n8n/leadgurus/backfill');
}
