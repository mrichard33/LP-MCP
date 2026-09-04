// ─── LP-driven source reconciler — src/jobs/source-reconcile.js ──────────────
//
// WHAT
//   Daily job that mirrors LP's authoritative source list into
//   lp_source_catalog and reports three diffs against lp_source_mapping:
//
//     unmapped — in LP's catalog, absent from lp_source_mapping. The real
//                "sources needing a decision" number.
//     orphaned — in lp_source_mapping, absent from LP's catalog. A mapping
//                pointing at a source LP no longer recognises.
//     dormant  — in the catalog, mapped, zero leads in the last 90 days.
//
//   It NEVER writes lp_source_mapping. Bucket and entry tag are Mark's call;
//   this job reports, it does not classify.
//
// WHY
//   lp_unmapped_sources was built by discovering sources one lead at a time,
//   and it drifted badly: on 2026-09-04 it held 552 unreviewed rows of which
//   372 were already mapped and 175 were duplicate NULL rows from a unique
//   index that treated NULLs as distinct. Five rows were real work. A queue
//   that is wrong 547 times out of 552 is a queue nobody reads.
//
//   LP publishes the list. POST /api/Leads/GetLeadsSourceSubPromoter (type=s)
//   returned 417 sources on 2026-09-04, verified live. Reading it directly
//   replaces lead-by-lead discovery with a diff against the source of truth.
//
// PAYLOAD SHAPE (verified live 2026-09-04, not assumed)
//   [ { key: "871", value: "871 - Events 2026 - Great American Home Show" }, … ]
//
//   `value` is "<lp_source_id> - <source_raw> - <source_subdetail>". The
//   subdetail itself may contain " - " ("Fort Myers Boat Show - January",
//   "NBC WFLA OTT - East"), so only the first two separators are split on and
//   the remainder is the subdetail. LP truncates source_raw to 15 characters
//   ("Concrete Digita", "Everett's Marke") — that is LP's own storage, not a
//   parsing artifact. The keys are logged on first run all the same, via the
//   same loggedFirstKeys pattern the sync modules use, so a shape change shows
//   up in the logs instead of silently producing an empty catalog.
//
// ALERTING — quiet by default
//   At most one lp.source_mapping_gap event per gap per ISO week
//   (idempotency_key source_gap_<subdetail>_<iso_week>), and only when the
//   source is BOTH unmapped AND over SOURCE_GAP_MIN_LEADS_30D (default 25)
//   leads in the last 30 days. An event nobody booked a lead from is not an
//   alert. Orphaned and dormant sources are reported through
//   get_source_catalog_health and never alert.
//
// SCHEDULER  daily at 05:30 ET — after lp-name-drift (05:00), before the 06:00
//            scorecard jobs.
// ENDPOINT   GET|POST /api/lp/source-reconcile  → run now, return the report.
//
// TESTS  scripts/test-source-reconcile.js drives every pure function and the
//        full run through an injected deps seam, so no database is required.

import supabase from '../supabase.js';
import { getSources } from '../lp-client.js';
import { emitEvent } from '../event-emitter.js';
import { loggedFirstKeys } from '../sync-utils.js';

const TIMEZONE = 'America/New_York';

export const ENABLED = () => (process.env.SOURCE_RECONCILE_ENABLED || 'true') === 'true';
export const MIN_LEADS_30D = () => parseInt(process.env.SOURCE_GAP_MIN_LEADS_30D || '25', 10);

// WO-7 (B3): a second, lower floor for event-class sources.
//
// The 25-lead floor makes event sources structurally invisible, not quiet.
// Home shows, fairs and seasonal promos are short-lived and low-volume by
// nature — they run for a weekend and produce a dozen leads total, so they
// can never clear a floor tuned for always-on channels. Measured 2026-09-04,
// every one of these is genuinely unmapped and none would ever alert:
//
//   Great American Home Show        16 / 30d    16 / 90d
//   Angie                           13 / 30d    44 / 90d
//   Point2Web                        0 / 30d    25 / 90d
//   Fort Myers Arts & Crafts Show    3 / 30d    12 / 90d
//   Fort Myers Beat the Heat         3 / 30d     7 / 90d
//
// A floor that a whole class of source cannot reach is not a threshold, it
// is an exclusion.
export const MIN_LEADS_30D_EVENTS = () =>
  parseInt(process.env.SOURCE_GAP_MIN_LEADS_30D_EVENTS || '5', 10);

/**
 * Is this an event-class source?
 *
 * Matched on `lp_source_raw` against the two shapes LP actually uses: the
 * "Events " prefix its catalog applies, and a name containing "Show".
 * Deliberately narrow — a broad pattern would drag always-on sources under
 * the lower floor and turn the event exception into a global threshold cut,
 * which is not what was asked for and would make the job noisy.
 */
export function isEventSource(source = {}) {
  const raw = String(source.lp_source_raw || '');
  return /^events\s/i.test(raw) || /\bshow\b/i.test(raw);
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** Comparison key for a source. Mapping lookups are case/whitespace-tolerant. */
export function normKey(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().toLowerCase();
  return s === '' ? null : s;
}

/**
 * ISO-8601 week label, e.g. "2026-W36". Used only for alert idempotency, so
 * the exact week boundary matters less than it being stable and monotonic.
 */
export function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // ISO weeks run Mon–Sun and week 1 contains the year's first Thursday.
  const dayNum = d.getUTCDay() || 7;          // Sunday 0 → 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);  // shift to that week's Thursday
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Parse one LP catalog row into { lp_source_id, lp_source_raw,
 * lp_source_subdetail }, or null if it is not a usable source line.
 */
export function parseCatalogRow(row) {
  if (!row || typeof row !== 'object') return null;
  const id = row.key !== undefined && row.key !== null ? String(row.key).trim() : null;
  const label = row.value !== undefined && row.value !== null ? String(row.value) : '';
  if (!label.trim()) return null;

  // Drop the leading "<id> - " when LP repeats the key inside the label, then
  // split the FIRST remaining separator only: everything after it is the
  // subdetail, which legitimately contains " - " of its own.
  let rest = label;
  if (id && rest.startsWith(`${id} - `)) {
    rest = rest.slice(id.length + 3);
  } else {
    const m = rest.match(/^(\d+)\s-\s(.*)$/s);
    if (m) rest = m[2];
  }

  const sep = rest.indexOf(' - ');
  const raw = (sep === -1 ? rest : rest.slice(0, sep)).trim();
  const subdetail = (sep === -1 ? '' : rest.slice(sep + 3)).trim();

  if (!raw && !subdetail) return null;
  return {
    lp_source_id: id,
    lp_source_raw: raw || null,
    lp_source_subdetail: subdetail || null,
  };
}

/** Parse the whole LP response. Tolerates a bare array or a wrapped object. */
export function parseCatalog(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : (payload?.d ?? payload?.data ?? payload?.rows ?? payload?.Table ?? []);
  if (!Array.isArray(rows)) return [];

  if (rows.length && !loggedFirstKeys.has('lp_source_catalog')) {
    loggedFirstKeys.add('lp_source_catalog');
    console.log('[SourceReconcile] LP source row keys:', Object.keys(rows[0]).join(', '),
      '| sample:', JSON.stringify(rows[0]));
  }

  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const parsed = parseCatalogRow(row);
    if (!parsed) continue;
    // LP ships genuine duplicates (two rows both "Everett's Marketing"); the
    // catalog is keyed on (raw, subdetail), so collapse them here too.
    const key = `${normKey(parsed.lp_source_raw) || ''}|${normKey(parsed.lp_source_subdetail) || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }
  return out;
}

/**
 * The three diffs.
 *
 * @param catalog  parsed LP catalog entries
 * @param mappings lp_source_mapping rows
 * @param volume   v_source_volume_90d rows
 *
 * A catalog entry counts as MAPPED when its subdetail matches a mapping's
 * lp_source_subdetail, or when a subdetail-less mapping matches its raw source
 * — the same two-step resolveSourceBucket() performs. Placeholder mappings
 * (ghl_intent_bucket = 'unmapped', written by the auto-discovery backfill) do
 * NOT count: resolveSourceBucket skips them and falls through to entry:other,
 * so treating them as mapped would hide exactly the leads that are misrouted.
 */
export function computeDiffs({ catalog = [], mappings = [], volume = [] } = {}) {
  const live = mappings.filter((m) => m.ghl_intent_bucket !== 'unmapped');

  const mappedSubdetails = new Set(live.map((m) => normKey(m.lp_source_subdetail)).filter(Boolean));
  const mappedRawOnly = new Set(
    live.filter((m) => !normKey(m.lp_source_subdetail))
      .map((m) => normKey(m.lp_source_raw)).filter(Boolean)
  );

  const volumeBy = new Map();
  for (const v of volume) {
    const k = normKey(v.lead_source_detail);
    if (k) volumeBy.set(k, { leads_30d: Number(v.leads_30d || 0), leads_90d: Number(v.leads_90d || 0) });
  }
  const vol = (k) => volumeBy.get(k) || { leads_30d: 0, leads_90d: 0 };

  const catalogSubdetails = new Set(catalog.map((c) => normKey(c.lp_source_subdetail)).filter(Boolean));

  const unmapped = [];
  const dormant = [];
  for (const entry of catalog) {
    const sub = normKey(entry.lp_source_subdetail);
    const raw = normKey(entry.lp_source_raw);
    const isMapped = (sub && mappedSubdetails.has(sub)) || (raw && mappedRawOnly.has(raw));
    const counts = vol(sub);
    const record = { ...entry, ...counts };
    if (!isMapped) unmapped.push(record);
    else if (counts.leads_90d === 0) dormant.push(record);
  }

  const orphaned = live
    .filter((m) => {
      const sub = normKey(m.lp_source_subdetail);
      return sub && !catalogSubdetails.has(sub);
    })
    .map((m) => {
      const sub = normKey(m.lp_source_subdetail);
      return {
        lp_source_subdetail: m.lp_source_subdetail,
        lp_source_raw: m.lp_source_raw,
        ghl_intent_bucket: m.ghl_intent_bucket,
        ghl_entry_tag: m.ghl_entry_tag,
        // WO-7 (B2): null until 083 flags the row. Reported, never acted on.
        mapping_status: m.mapping_status ?? null,
        ...vol(sub),
      };
    });

  // WO-7 (B2): rows flagged as not-a-source at all. These are a subset of
  // `orphaned` — every one of them is orphaned too — pulled out separately
  // because "LP retired this source" and "this was never a source" are
  // different problems with different fixes, and lumping them together is
  // what let eight market codes sit in the mapping table looking mapped.
  const suspectedNonSource = live
    .filter((m) => m.mapping_status === 'suspected_non_source')
    .map((m) => ({
      lp_source_subdetail: m.lp_source_subdetail,
      lp_source_raw: m.lp_source_raw,
      ghl_intent_bucket: m.ghl_intent_bucket,
      ghl_entry_tag: m.ghl_entry_tag,
      mapping_status: m.mapping_status,
      ...vol(normKey(m.lp_source_subdetail)),
    }));

  const byVolume = (a, b) => (b.leads_90d - a.leads_90d) || (b.leads_30d - a.leads_30d);
  unmapped.sort(byVolume);
  orphaned.sort(byVolume);
  dormant.sort((a, b) => String(a.lp_source_subdetail || '').localeCompare(String(b.lp_source_subdetail || '')));

  suspectedNonSource.sort(byVolume);

  return { unmapped, orphaned, dormant, suspectedNonSource };
}

/**
 * Which unmapped sources clear their volume floor and therefore deserve an alert.
 *
 * WO-7 (B3): two floors. Event-class sources are held to `minLeads30dEvents`
 * (default 5), everything else to `minLeads30d` (default 25). The event floor
 * only ever LOWERS the bar — an event source above the standard floor still
 * alerts, so adding this can never silence something that used to fire.
 *
 * Idempotency is untouched: the caller still keys one event per source per
 * ISO week, exactly as before.
 *
 * `minLeads30dEvents` defaults to `minLeads30d` — i.e. NO event exception
 * unless a caller asks for one. A two-argument call therefore behaves
 * exactly as it did before this change, which keeps the single-floor
 * contract the existing suite pins. The scheduled job passes both floors
 * explicitly from env.
 */
export function selectGapAlerts(unmapped = [], minLeads30d = 25, minLeads30dEvents = minLeads30d) {
  return unmapped.filter((u) => {
    const leads = Number(u.leads_30d || 0);
    const floor = isEventSource(u) ? Math.min(minLeads30dEvents, minLeads30d) : minLeads30d;
    return leads >= floor;
  });
}

// ─── Default deps (the seam the tests replace) ───────────────────────────────

const defaultDeps = {
  fetchCatalog: () => getSources('s'),

  readMappings: async () => {
    const { data, error } = await supabase
      .from('lp_source_mapping')
      // WO-7 (B2): mapping_status rides along so the diff can separate rows
      // that are orphaned because LP retired the source from rows that were
      // never a source in the first place.
      .select('lp_source_subdetail, lp_source_raw, ghl_intent_bucket, ghl_entry_tag, mapping_status');
    if (error) throw new Error(`lp_source_mapping read failed: ${error.message}`);
    return data || [];
  },

  readVolume: async () => {
    const { data, error } = await supabase
      .from('v_source_volume_90d')
      .select('lead_source_detail, leads_30d, leads_90d');
    if (error) throw new Error(`v_source_volume_90d read failed: ${error.message}`);
    return data || [];
  },

  readSampleLead: async (subdetail) => {
    if (!subdetail) return null;
    const { data } = await supabase
      .from('lp_leads')
      .select('lp_lead_id')
      .eq('lead_source_detail', subdetail)
      .order('created_at_lp', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data?.lp_lead_id || null;
  },

  writeCatalog: async (entries) => {
    if (!entries.length) return 0;
    const now = new Date().toISOString();
    const rows = entries.map((e) => ({ ...e, active: true, last_seen: now }));
    const { error } = await supabase
      .from('lp_source_catalog')
      .upsert(rows, { onConflict: 'lp_source_raw,lp_source_subdetail' });
    if (error) throw new Error(`lp_source_catalog upsert failed: ${error.message}`);
    // Anything LP stopped publishing is marked inactive rather than deleted —
    // an orphaned mapping needs the history to be explainable.
    await supabase
      .from('lp_source_catalog')
      .update({ active: false })
      .lt('last_seen', now)
      .eq('active', true);
    return rows.length;
  },

  writeRun: async (summary) => {
    const { error } = await supabase.from('lp_source_reconcile_runs').insert(summary);
    if (error) console.warn('[SourceReconcile] run summary insert failed:', error.message);
  },

  emit: (opts) => emitEvent(opts),

  now: () => new Date(),
};

// ─── The job ─────────────────────────────────────────────────────────────────

/**
 * Run one reconciliation pass.
 *
 * @param {Object} [deps]      test seam; every field defaults to the live one
 * @param {Object} [options]
 * @param {boolean} [options.alert=true]  emit gap events (false = report only)
 */
export async function runSourceReconcile(deps = {}, { alert = true } = {}) {
  const d = { ...defaultDeps, ...deps };
  const startedAt = d.now();

  const [payload, mappings, volume] = await Promise.all([
    d.fetchCatalog(),
    d.readMappings(),
    d.readVolume(),
  ]);

  const catalog = parseCatalog(payload);
  if (!catalog.length) {
    // An empty catalog would make every mapping look orphaned. Refuse to
    // report on it rather than publish a diff built on nothing.
    const msg = 'LP returned no parseable sources — reconciliation skipped';
    console.warn(`[SourceReconcile] ${msg}`);
    return {
      ok: false, skipped: true, reason: msg,
      catalog_count: 0, unmapped: [], orphaned: [], dormant: [], events_emitted: 0,
    };
  }

  const { unmapped, orphaned, dormant, suspectedNonSource } = computeDiffs({ catalog, mappings, volume });

  await d.writeCatalog(catalog);

  // ── Alerting ──────────────────────────────────────────────────────────────
  const floor = MIN_LEADS_30D();
  const eventFloor = MIN_LEADS_30D_EVENTS();
  const week = isoWeek(startedAt);
  const candidates = alert ? selectGapAlerts(unmapped, floor, eventFloor) : [];
  let emitted = 0;

  for (const gap of candidates) {
    const sampleLeadId = await d.readSampleLead(gap.lp_source_subdetail);
    const result = await d.emit({
      event_type: 'lp.source_mapping_gap',
      source: 'source-reconcile',
      entity_type: 'lp_source',
      entity_id: gap.lp_source_id || gap.lp_source_subdetail,
      lp_lead_id: sampleLeadId || undefined,
      priority: 'normal',
      idempotency_key: `source_gap_${gap.lp_source_subdetail}_${week}`,
      // No decision rule consumes this — it is an ops report for the MCP tools
      // and for Mark. The intake allowlist would otherwise drop it.
      bypass_filter: true,
      payload: {
        lp_source_id: gap.lp_source_id,
        source_subdetail: gap.lp_source_subdetail,
        source_raw: gap.lp_source_raw,
        leads_30d: gap.leads_30d,
        leads_90d: gap.leads_90d,
        sample_lp_lead_id: sampleLeadId,
        // Report the floor this source was actually judged against, not the
        // global one — an event alert at 6 leads against a stated threshold
        // of 25 would read as a bug.
        threshold_30d: isEventSource(gap) ? Math.min(eventFloor, floor) : floor,
        source_class: isEventSource(gap) ? 'event' : 'standard',
        iso_week: week,
        action: 'Classify in lp_source_mapping — bucket and entry tag are a human decision.',
      },
    });
    if (result) emitted++;   // emitEvent returns null on an idempotency hit
  }

  const report = {
    ok: true,
    ran_at: startedAt.toISOString(),
    catalog_count: catalog.length,
    mapping_count: mappings.length,
    threshold_30d: floor,
    threshold_30d_events: eventFloor,
    iso_week: week,
    unmapped,
    orphaned,
    dormant,
    // WO-7 (B2): flagged as not-a-source. Subset of `orphaned`, reported so
    // it is visible; nothing routes on it and nothing is removed.
    suspected_non_source: suspectedNonSource,
    events_emitted: emitted,
  };

  await d.writeRun({
    ran_at: report.ran_at,
    catalog_count: catalog.length,
    unmapped_count: unmapped.length,
    orphaned_count: orphaned.length,
    dormant_count: dormant.length,
    suspected_non_source_count: suspectedNonSource.length,
    events_emitted: emitted,
    detail: { unmapped, orphaned, dormant: dormant.slice(0, 100), suspected_non_source: suspectedNonSource, threshold_30d: floor, threshold_30d_events: eventFloor },
  });

  console.log(
    `[SourceReconcile] catalog=${catalog.length} unmapped=${unmapped.length} ` +
    `orphaned=${orphaned.length} (${suspectedNonSource.length} suspected non-source) ` +
    `dormant=${dormant.length} events=${emitted}`
  );
  return report;
}

// ─── HTTP route ──────────────────────────────────────────────────────────────

export function registerSourceReconcileRoutes(app) {
  const handler = async (req, res) => {
    try {
      const alert = String(req.query?.alert ?? 'false') === 'true';
      const result = await runSourceReconcile({}, { alert });
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  };
  app.get('/api/lp/source-reconcile', handler);
  app.post('/api/lp/source-reconcile', handler);
  console.log('[SourceReconcile] Route registered: GET+POST /api/lp/source-reconcile');
}

// ─── Scheduler — daily at 05:30 ET ───────────────────────────────────────────

let reconcileTimer = null;
let lastRunKey = null;

export function startSourceReconcileScheduler() {
  if (reconcileTimer) return;
  if (!ENABLED()) {
    console.log('[SourceReconcile] disabled (SOURCE_RECONCILE_ENABLED!=true)');
    return;
  }
  console.log('[SourceReconcile] Scheduler started — daily run at 05:30 ET');

  const checkAndRun = async () => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? -1);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? -1);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    if (hour === 5 && minute >= 30 && lastRunKey !== today) {
      lastRunKey = today;
      try {
        await runSourceReconcile();
      } catch (err) {
        console.error('[SourceReconcile] run failed:', err.message);
      }
    }
  };

  reconcileTimer = setInterval(checkAndRun, 5 * 60 * 1000);
}

export function stopSourceReconcileScheduler() {
  if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
}

export const _internal = { defaultDeps };
