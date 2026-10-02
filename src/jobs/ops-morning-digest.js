// ─── Ops morning digest — src/jobs/ops-morning-digest.js ───────────────────
//
// 2026-10-02 (Mark, alert noise cut). ONE post to #ops-alerts at 08:00 ET in
// place of a dozen cards. Before this, a week held 179 "routed to S5.2" cards,
// 141 per-contact P2 Won/Lost cards and five morning check cards that
// re-listed the same backlog every day; the cards that needed action were
// lost in them.
//
// Sections, each listing only what has NEVER been posted before
// (audit_posted_items via src/alert-posted.js), max 10 lines then "+N more",
// one line per item: name · what's wrong · what to do.
//   1. P2 Won / Lost in the last 24h — counts and names. These are events,
//      not problems, so they are listed every day without dedupe; the
//      per-contact cards are dropped at queue time (src/alert-noise.js).
//   2. Appointment parity — appt_parity keys first seen in the last 24h and
//      never posted. No count of older open gaps (Mark). The watchdog still
//      tracks state in alert_conditions; it no longer posts per key.
//   3. F.0 / S5.2 integrity  (f0-integrity-audit, incl. its S5.2 section)
//   4. Lead leak + never-reached-LP  (lead-leak-monitor daily pass)
//   5. LP↔GHL link leak  (link-leak-monitor)
//   6. P2 with no LP job  (p2-unresolvable-monitor)
// Sections 3–6 run their job here, each under its own runJob so job_runs keeps
// one row per job. A job that FAILS posts its own "could not run" card
// straight away — silence must never hide a failure — and its section is left
// out. Counts-only jobs (5, 6) list a line only when its count ROSE past the
// last count posted.
//
// A clean day is one line: "All clear."
//
// ALERT_DIGEST_ENABLED=false turns this job off and every folded job goes
// back to posting its own card.

import { runJob as defaultRunJob } from '../job-runner.js';
import { hourET, todayET } from './lp-report-common.js';
import {
  alertDigestEnabled, capLines, filterNew as defaultFilterNew, recordPosted as defaultRecordPosted,
  lastPostedCount as defaultLastPostedCount,
} from '../alert-posted.js';

export const JOB_ID = 'ops-morning-digest';
export const RUN_HOUR_ET = 8;
export const SECTION_MAX = 10;
const DAY_MS = 86_400_000;
const LEAD_TTL_DAYS = 7;
const P2_RULES = { P2_JOB_TERMINAL_WON: 'won', P2_JOB_TERMINAL_LOST: 'lost' };
const PARITY_PREFIX = 'appt_parity:gap:';
const PARITY_TEXT = {
  ghl_missing_appointment: ['LP has an appointment GHL does not', 'add it to the GHL calendar or fix LP'],
  cancellation_drift: ['cancelled on one side only', 'cancel it in the other system'],
  lp_cancelled_ghl_active: ['LP cancelled, GHL still booked', 'cancel the GHL appointment'],
};

async function defaultDeps() {
  const [{ default: supabase }, { hlRunSQL, esc }, { sendAlertMessage }, f0, leak, link, p2] = await Promise.all([
    import('../supabase.js'),
    import('../admin/hl-client.js'),
    import('../alert-state.js'),
    import('./f0-integrity-audit.js'),
    import('./lead-leak-monitor.js'),
    import('./link-leak-monitor.js'),
    import('./p2-unresolvable-monitor.js'),
  ]);
  return {
    supabase, hlRunSQL, esc, sendAlertMessage,
    runJob: defaultRunJob,
    runF0Audit: () => f0.runF0IntegrityAudit({ post: false }),
    runLeadLeak: () => leak.runLeadLeakForDigest(),
    runLinkLeak: () => link.runLinkLeakMonitor({ post: false }),
    runP2Unresolvable: () => p2.runP2UnresolvableMonitor({ post: false }),
  };
}

const nameOf = (names, id) => names.get(id) || '(no name)';
const fullName = (first, last) => [first, last].map((x) => String(x ?? '').trim()).filter(Boolean).join(' ');

async function loadNames(deps, ids) {
  const names = new Map();
  const list = [...new Set(ids.filter(Boolean))];
  const esc = deps.esc || ((s) => String(s).replace(/'/g, "''"));
  for (let i = 0; i < list.length; i += 200) {
    try {
      const rows = await deps.hlRunSQL(
        `SELECT ghl_contact_id, first_name, last_name FROM contacts WHERE ghl_contact_id IN (${list.slice(i, i + 200).map((id) => `'${esc(id)}'`).join(',')})`,
      );
      for (const r of rows || []) names.set(r.ghl_contact_id, fullName(r.first_name, r.last_name));
    } catch (err) {
      console.warn(`[OpsDigest] name lookup failed (ids shown instead): ${err.message}`);
    }
  }
  return names;
}

// ── section builders (each returns { title, lines, record? }) ────────────

async function p2Section(deps, nowMs) {
  const since = new Date(nowMs - DAY_MS).toISOString();
  const { data, error } = await deps.supabase.from('agent_actions')
    .select('target_id, rule_applied, execution_result, executed_at')
    .in('rule_applied', Object.keys(P2_RULES))
    .eq('action_type', 'update_opportunity')
    .eq('status', 'completed')
    .gte('executed_at', since);
  if (error) throw new Error(`P2 closes read failed: ${error.message}`);
  const rows = (data || []).filter((r) => !String(r.execution_result?.action || '').startsWith('skipped'));
  const byKind = { won: new Set(), lost: new Set() };
  for (const r of rows) byKind[P2_RULES[r.rule_applied]].add(r.target_id);
  if (!byKind.won.size && !byKind.lost.size) return null;
  const names = await loadNames(deps, [...byKind.won, ...byKind.lost]);
  const lines = [];
  for (const [kind, label] of [['won', '🏆 Won'], ['lost', '❌ Lost']]) {
    if (!byKind[kind].size) continue;
    const who = [...byKind[kind]].map((id) => nameOf(names, id));
    const shown = who.slice(0, SECTION_MAX).join(', ');
    lines.push(`${label}: ${byKind[kind].size} — ${shown}${who.length > SECTION_MAX ? ` +${who.length - SECTION_MAX} more` : ''}`);
  }
  return { title: `P2 closed in the last 24h (${byKind.won.size} won, ${byKind.lost.size} lost)`, lines };
}

async function paritySection(deps, nowMs) {
  const since = new Date(nowMs - DAY_MS).toISOString();
  const { data, error } = await deps.supabase.from('alert_conditions')
    .select('alert_key, first_seen_at, state')
    .like('alert_key', `${PARITY_PREFIX}%`)
    .eq('state', 'firing')
    .gte('first_seen_at', since);
  if (error) throw new Error(`appointment parity read failed: ${error.message}`);
  const items = (data || []).map((r) => {
    const [cls, contactId] = r.alert_key.slice(PARITY_PREFIX.length).split(':');
    return { key: contactId, reason: `parity:${cls}`, cls };
  }).filter((i) => i.key);
  if (!items.length) return null;
  const { fresh } = await deps.filterNew({ audit: 'appt_parity', items, ttlDays: 30, nowMs, deps: { supabase: deps.supabase } });
  if (!fresh.length) return null;
  const names = await loadNames(deps, fresh.map((i) => i.key));
  const lines = fresh.map((i) => {
    const [wrong, todo] = PARITY_TEXT[i.cls] || [i.cls, 'check both calendars'];
    return `${nameOf(names, i.key)} (${i.key}) · ${wrong} · ${todo}`;
  });
  return { title: `Appointment parity — ${fresh.length} new gap(s)`, lines: capLines(lines, SECTION_MAX), record: { audit: 'appt_parity', items: fresh } };
}

async function f0Section(deps, value, nowMs) {
  const items = (value.items || []).map((i) => ({ ...i, key: i.contact_id }));
  if (!items.length) return null;
  const { fresh } = await deps.filterNew({ audit: 'f0-s52-integrity', items, ttlDays: 30, nowMs, deps: { supabase: deps.supabase } });
  if (!fresh.length) return null;
  const lines = fresh.map((i) => `${i.name} (${i.contact_id}) · ${i.wrong} · ${i.todo}`);
  return { title: `F.0 / S5.2 integrity — ${fresh.length} new`, lines: capLines(lines, SECTION_MAX), record: { audit: 'f0-s52-integrity', items: fresh } };
}

async function leadLeakSection(deps, value, nowMs) {
  const d = value.digestItems || {};
  const items = [
    ...(d.intakeMissing || []).map((g) => ({ key: g.ghl_contact_id, reason: 'never_reached_lp',
      line: `${fullName(g.first_name, g.last_name) || '(no name)'} (GHL ${g.ghl_contact_id}) · in GHL since ${String(g.date_added ?? '').slice(0, 10)}, never reached LP · push the lead into LP` })),
    ...(d.retired || []).map((l) => ({ key: String(l.lp_lead_id), reason: 'retired_code',
      line: `${fullName(l.first_name, l.last_name) || '(no name)'} (LP ${l.lp_lead_id}) · coded ${l.disposition_code}, a retired code · re-code it in LP` })),
    ...(d.speedSlow || []).map((o) => ({ key: String(o.lp_lead_id), reason: 'slow_first_call',
      line: `${fullName(o.first_name, o.last_name) || '(no name)'} (LP ${o.lp_lead_id}) · still waiting for a first call · get it dialed` })),
  ].filter((i) => i.key && i.key !== 'undefined');
  if (!items.length) return null;
  const { fresh } = await deps.filterNew({ audit: 'lead_leak', items, ttlDays: LEAD_TTL_DAYS, nowMs, deps: { supabase: deps.supabase } });
  if (!fresh.length) return null;
  return { title: `Lead leak — ${fresh.length} new`, lines: capLines(fresh.map((i) => i.line), SECTION_MAX), record: { audit: 'lead_leak', items: fresh } };
}

// Counts-only monitors: a line appears only when its count ROSE past the last
// count posted (so a standing backlog is not re-listed every morning).
async function countSection(deps, { audit, title, counts, render, nowMs }) {
  const lines = [];
  const items = [];
  for (const [key, n] of Object.entries(counts)) {
    if (!Number.isFinite(n) || n <= 0) continue;
    let last = 0;
    try { last = await deps.lastPostedCount({ audit, key, nowMs, deps: { supabase: deps.supabase } }); } catch { last = 0; }
    if (n > last) { lines.push(render(key, n, last)); items.push({ key, reason: `count:${n}` }); }
  }
  if (!lines.length) return null;
  return { title, lines: capLines(lines, SECTION_MAX), record: { audit, items } };
}

function linkLeakSection(deps, value, nowMs) {
  if (value.verdict !== 'alert') return null;
  const counts = {};
  for (const o of value.offenders || []) counts[o.table] = o.count;
  return countSection(deps, {
    audit: 'link_leak', title: 'LP↔GHL link leak', counts, nowMs,
    render: (t, n, last) => `${t} · ${n} new row(s) with no GHL link${last ? ` (was ${last})` : ''} · run the link repair`,
  });
}

function p2UnresolvableSection(deps, value, nowMs) {
  if (value.verdict !== 'alert') return null;
  const s = value.sample || {};
  return countSection(deps, {
    audit: 'p2_unresolvable', title: 'P2 opportunities with no LP job', counts: { unresolvable: s.unresolvable }, nowMs,
    render: (_k, n, last) => `${n} open P2 opportunit${n === 1 ? 'y has' : 'ies have'} no LP job${last ? ` (was ${last})` : ''} · run scripts/repair-p2-missing-lp-jobs.js`,
  });
}

/** Pure. The digest text. */
export function formatDigest(sections, { date } = {}) {
  const live = sections.filter(Boolean);
  if (!live.length) return `✅ Ops morning check${date ? ` ${date}` : ''} — All clear.`;
  const out = [`☀️ Ops morning check ${date || ''}`.trim()];
  for (const s of live) out.push('', `*${s.title}*`, ...s.lines.map((l) => (l.startsWith('+') ? l : `• ${l}`)));
  return out.join('\n');
}

const JOB_SECTIONS = [
  { id: 'f0-integrity-audit', label: 'F.0 / S5.2 integrity audit', run: 'runF0Audit', build: f0Section },
  { id: 'lead-leak-monitor', label: 'Lead leak monitor', run: 'runLeadLeak', build: leadLeakSection },
  { id: 'link-leak-monitor', label: 'LP↔GHL link leak monitor', run: 'runLinkLeak', build: linkLeakSection },
  { id: 'p2-unresolvable-monitor', label: 'P2 unresolvable monitor', run: 'runP2Unresolvable', build: p2UnresolvableSection },
];

/**
 * Build and (post=true) send the digest. Returns { ok, sections, failures, text, posted }.
 */
export async function runOpsMorningDigest({ post = true, deps: depsArg } = {}) {
  const deps = {
    filterNew: defaultFilterNew, recordPosted: defaultRecordPosted, lastPostedCount: defaultLastPostedCount,
    ...(depsArg?.__noDefaults ? {} : await defaultDeps()), ...(depsArg || {}),
  };
  const nowMs = deps.nowMs ?? Date.now();
  const today = deps.today || todayET(new Date(nowMs));
  const sections = [];
  const failures = [];
  const couldNotRun = async (label, error) => {
    failures.push({ label, error });
    console.warn(`[OpsDigest] ${label} could not run: ${error}`);
    if (post) await deps.sendAlertMessage(`⚠️ ${label} could not run: ${error}`, { channel: 'ops' });
  };

  for (const [label, build] of [['P2 won/lost summary', p2Section], ['Appointment parity summary', paritySection]]) {
    try { sections.push(await build(deps, nowMs)); } catch (err) { await couldNotRun(label, err.message); }
  }

  for (const j of JOB_SECTIONS) {
    const out = await deps.runJob(j.id, () => deps[j.run](), { occurrence: today });
    if (out.status === 'skipped') continue;
    if (out.status === 'failed' || out.status === 'unknown' || out.status === 'interrupted') {
      await couldNotRun(j.label, out.error || out.summary || out.status);
      continue;
    }
    try { sections.push(await j.build(deps, out.value || {}, nowMs)); } catch (err) { await couldNotRun(j.label, err.message); }
  }

  const live = sections.filter(Boolean);
  const text = formatDigest(live, { date: today });
  let posted = false;
  if (post) {
    const res = await deps.sendAlertMessage(text, { channel: 'ops' });
    posted = res?.sent !== false;
    if (posted) {
      for (const s of live) if (s.record) await deps.recordPosted({ ...s.record, nowMs, deps: { supabase: deps.supabase } });
    }
  }
  console.log(`[OpsDigest] ${live.length} section(s), ${failures.length} failure(s)${posted ? ' — posted' : ''}`);
  return {
    ok: !post || posted,
    sections: live.map((s) => ({ title: s.title, lines: s.lines.length })),
    failures,
    text,
    posted,
    summary: `${live.length} section(s), ${failures.length} could not run${posted ? ', posted' : ''}`,
  };
}

// ── Scheduler — daily at 08:00 ET ─────────────────────────────────────────
let timer = null;
let lastRunSlot = null;

export function startOpsMorningDigestScheduler() {
  if (timer) return;
  if (!alertDigestEnabled()) {
    console.log('[OpsDigest] disabled (ALERT_DIGEST_ENABLED=false) — the morning checks post their own cards');
    return;
  }
  console.log('[OpsDigest] Scheduler started — daily post at 08:00 ET');
  const checkAndRun = async () => {
    const today = todayET();
    if (hourET() === RUN_HOUR_ET && lastRunSlot !== today) {
      lastRunSlot = today;
      try {
        await defaultRunJob(JOB_ID, () => runOpsMorningDigest({ post: true }), { occurrence: today });
      } catch (err) {
        console.error('[OpsDigest] run failed:', err.message);
      }
    }
  };
  timer = setInterval(checkAndRun, 5 * 60 * 1000);
  timer.unref?.();
}

export function stopOpsMorningDigestScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
