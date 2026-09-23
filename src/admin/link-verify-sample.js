// ─── Pre-enforce link-verification sampling ──────────────────────
//
// Observe-mode link classification verifies lognumber candidates against the
// HL Supabase contacts cache. A stale cache systematically overstates
// rejections — and the rejection rate is the number the enforce decision
// rests on. This route live-verifies a random sample of cache-classified
// rows against GHL so the cache-derived rejection rate can be compared to a
// live baseline before LP_LINK_CORROBORATION_MODE is flipped to enforce.
//
//   POST /admin/verify-link-sample { sample_size?: 50, sources?: [...] }
//     → { ok, job_id, status_url } (background job, guest-visitor pattern)
//   GET  /admin/verify-link-sample/:jobId → job status + results
//
// Read-only against GHL and lp_leads: verdicts land in lp_link_verifications
// (verify_source='ghl_live'), classifications are NOT rewritten. Also reports
// the cache-staleness distribution (cache_synced_at vs verification time) of
// the sampled rows' hl_cache verdicts.

import supabase from '../supabase.js';
import { verifyLognumberCandidate } from '../services/link-corroboration.js';

const INTER_CONTACT_DELAY_MS = 600; // ≤ 2 req/sec pacing on top of the token bucket
const DEFAULT_SAMPLE_SIZE = 50;
const MAX_SAMPLE_SIZE = 500;
const CANDIDATE_POOL_LIMIT = 5000;
const DEFAULT_SOURCES = ['rejected_uncorroborated', 'rejected_conflict'];
const SAMPLEABLE_SOURCES = new Set([...DEFAULT_SOURCES, 'lognumber_verified', 'user1_verified']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jobs = new Map();
const generateJobId = () => `lvs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

// Expected live verdict for each stored cache-derived classification.
const EXPECTED_VERDICT = {
  rejected_uncorroborated: 'no_identity',
  rejected_conflict: 'fail',
  lognumber_verified: 'pass',
  user1_verified: 'pass',
};

function summarizeAges(ageDays) {
  if (ageDays.length === 0) return null;
  const sorted = [...ageDays].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    count: sorted.length,
    min_days: Number(sorted[0].toFixed(2)),
    median_days: Number(pick(0.5).toFixed(2)),
    p90_days: Number(pick(0.9).toFixed(2)),
    max_days: Number(sorted[sorted.length - 1].toFixed(2)),
  };
}

async function runSampleJob(job, { sampleSize, sources }) {
  const stats = {
    sampled: 0,
    agree: 0,
    disagree: 0,
    unknown: 0,
    by_source: {},
    disagreements: [],
    cache_staleness: null,
    live_reads: 0,
  };

  const { data: pool, error } = await supabase
    .from('lp_leads')
    .select('lp_lead_id, ghl_contact_id, ghl_link_source, phone, phone_alt, email')
    .in('ghl_link_source', sources)
    .not('ghl_contact_id', 'is', null)
    .limit(CANDIDATE_POOL_LIMIT);
  if (error) throw new Error(`pool query failed: ${error.message}`);
  if (!pool || pool.length === 0) {
    job.status = 'complete';
    job.results = { ...stats, note: 'no rows with the requested ghl_link_source values' };
    return;
  }

  // Fisher–Yates on the pool, then take the sample from the front.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const sample = pool.slice(0, sampleSize);
  job.progress = { total: sample.length, done: 0 };

  const cacheAges = [];
  for (const row of sample) {
    // Age of the hl_cache verdict this row was classified from, if recorded.
    const { data: cacheVerdict } = await supabase
      .from('lp_link_verifications')
      .select('verified_at, detail')
      .eq('lp_lead_id', row.lp_lead_id)
      .eq('ghl_contact_id', row.ghl_contact_id)
      .eq('verify_source', 'hl_cache')
      .maybeSingle();
    if (cacheVerdict?.detail?.cache_synced_at) {
      const ageMs = new Date(cacheVerdict.verified_at) - new Date(cacheVerdict.detail.cache_synced_at);
      if (Number.isFinite(ageMs) && ageMs >= 0) cacheAges.push(ageMs / 86400000);
    }

    const verification = await verifyLognumberCandidate({
      lpIdentity: { phone: row.phone || null, phoneAlt: row.phone_alt || null, email: row.email || null },
      candidateId: row.ghl_contact_id,
      allowLive: true,
      lpLeadId: row.lp_lead_id,
    });
    stats.sampled++;
    if (verification.source === 'ghl_live') stats.live_reads++;

    const bySource = stats.by_source[row.ghl_link_source]
      || (stats.by_source[row.ghl_link_source] = { sampled: 0, agree: 0, disagree: 0, unknown: 0 });
    bySource.sampled++;

    if (verification.verdict === 'unknown') {
      stats.unknown++;
      bySource.unknown++;
    } else if (verification.verdict === EXPECTED_VERDICT[row.ghl_link_source]) {
      stats.agree++;
      bySource.agree++;
    } else {
      stats.disagree++;
      bySource.disagree++;
      if (stats.disagreements.length < 50) {
        stats.disagreements.push({
          lp_lead_id: row.lp_lead_id,
          ghl_contact_id: row.ghl_contact_id,
          stored_link_source: row.ghl_link_source,
          live_verdict: verification.verdict,
          live_detail: verification.detail || null,
        });
      }
    }

    job.progress.done++;
    await sleep(INTER_CONTACT_DELAY_MS);
  }

  stats.cache_staleness = summarizeAges(cacheAges);
  job.status = 'complete';
  job.results = stats;
  console.log(
    `[LinkVerifySample] ${job.id}: ${stats.sampled} sampled — ${stats.agree} agree, `
    + `${stats.disagree} disagree, ${stats.unknown} unknown (${stats.live_reads} live reads)`,
  );
}

export function registerLinkVerifySampleRoutes(app) {
  app.post('/admin/verify-link-sample', (req, res) => {
    const body = req.body || {};
    const sampleSize = Math.max(1, Math.min(MAX_SAMPLE_SIZE, parseInt(body.sample_size, 10) || DEFAULT_SAMPLE_SIZE));
    const requested = Array.isArray(body.sources) && body.sources.length > 0 ? body.sources : DEFAULT_SOURCES;
    const sources = requested.filter((s) => SAMPLEABLE_SOURCES.has(s));
    if (sources.length === 0) {
      return res.status(400).json({ ok: false, error: `sources must be among: ${[...SAMPLEABLE_SOURCES].join(', ')}` });
    }

    const job = { id: generateJobId(), status: 'running', started_at: new Date().toISOString(), progress: null, results: null };
    jobs.set(job.id, job);

    setImmediate(() => {
      runSampleJob(job, { sampleSize, sources }).catch((err) => {
        job.status = 'failed';
        job.error = err.message;
        console.error(`[LinkVerifySample] ${job.id} failed:`, err.message);
      });
    });

    res.json({
      ok: true,
      mode: 'background',
      job_id: job.id,
      sample_size: sampleSize,
      sources,
      status_url: `/admin/verify-link-sample/${job.id}`,
      message: `Live-verifying up to ${sampleSize} rows classified from the HL cache (${sources.join(', ')})`,
    });
  });

  app.get('/admin/verify-link-sample/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, error: 'job_not_found' });
    res.json({ ok: true, ...job });
  });
}
