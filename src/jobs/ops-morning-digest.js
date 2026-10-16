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
//   (2026-10-03) Sales the Sale → P2 backstop put into P2 in the last 24h, and
//   the ones it could not (no price yet) — src/p2-sale-backstop.js.
//   (2026-10-07, Mark: move the #ops summaries in) the nightly tag sweep
//   (03:00) and the inbound-caller capture summary (07:15) no longer post their
//   own line; their job_runs rows are read here. Each count is listed only when
//   it ROSE past the last one posted (the sweep said "545 need review" every
//   night), and a run that did not finish is always listed.
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
import { duration } from '../health/plain.js';
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
// 2026-10-16 (handoff v3.4): the watchdog now CREATES a missing GHL appointment
// itself (Fix 3), so a Class B line here means the create failed or needs a
// person's call (a DNC contact, two estimate objects) — never "add it to GHL".
// A bad LP date/hour is its own section ("LP date/time looks wrong", Fix 4).
const PARITY_TEXT = {
  ghl_missing_appointment: ['LP has an appointment GHL could not create on its own', 'look at the contact in GHL and decide'],
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

// 2026-10-03: what the Sale → P2 backstop (src/p2-sale-backstop.js) did in the
// last 24h, and the sales it could not place on its own. A fix is an event, not
// a problem, so fixes are counted every day; a needs-review sale is named once.
const P2_BACKSTOP_FIXES = {
  tagged_deal_won: 'deal-won added (C.0 builds the card)',
  created_open: 'card created',
  created_won: 'card created as Won',
  created_lost: 'card created as Lost',
};

async function p2BackstopSection(deps, nowMs) {
  const since = new Date(nowMs - DAY_MS).toISOString();
  const { data, error } = await deps.supabase.from('system_events')
    .select('ghl_contact_id, event_subtype, payload')
    .eq('event_type', 'p2.sale_backstop')
    .gte('created_at', since);
  if (error) throw new Error(`P2 backstop read failed: ${error.message}`);
  const rows = data || [];
  const lines = [];
  // 2026-10-16 (handoff v3.4 Fix 7): what the backstop FIXED needs nobody — it
  // is one "Auto-fixed" line (autoFixedSection). Only its failures and the
  // sales it could not place are listed here.
  const { data: runs, error: runErr } = await deps.supabase.from('job_runs')
    .select('status').eq('job_id', 'sale-p2-backstop').gte('started_at', since).in('status', ['failed', 'unknown']);
  if (!runErr && runs?.length) lines.push(`the Sale → P2 backstop itself failed ${runs.length} time${runs.length === 1 ? '' : 's'} in 24h · check its job runs`);
  if (!rows.length && !lines.length) return null;
  const review = rows.filter((r) => r.event_subtype === 'needs_review')
    .map((r) => ({ key: r.ghl_contact_id, reason: `needs_review:${r.payload?.job_id ?? ''}`, job: r.payload || {} }));
  let record = null;
  if (review.length) {
    const { fresh } = await deps.filterNew({ audit: 'p2_sale_backstop', items: review, ttlDays: 30, nowMs, deps: { supabase: deps.supabase } });
    if (fresh.length) {
      const names = await loadNames(deps, fresh.map((i) => i.key));
      // [what's wrong, what to do] per backstop report reason (src/p2-sale-backstop.js).
      const REVIEW_TEXT = {
        no_price_yet: ['LP job has no price yet', 'price the job in LP'],
        possible_duplicate_of_paid_job: ['looks like an old quote a paid job replaced', 'close it in LP if it is dead'],
        repeat_customer_one_card_limit: ['repeat customer: GHL allows one P2 card per person and the old one is closed', 'decide by hand; do not reopen the old card'],
      };
      const text = (r) => REVIEW_TEXT[r] || [r || 'needs a look', 'check the job in LP'];
      lines.push(...capLines(fresh.map((i) => {
        const [wrong, todo] = text(i.job.reason);
        return `${nameOf(names, i.key)} (${i.key}) · LP job ${i.job.job_id} "${i.job.job_status}" · ${wrong} — not in P2 · ${todo}`;
      }), SECTION_MAX));
      record = { audit: 'p2_sale_backstop', items: fresh };
    }
  }
  if (!lines.length) return null;
  return { title: `Sale → P2 backstop: needs a person`, lines, record };
}

// 2026-10-04: sales the sale-contact backstop (src/services/lp-sale-contact-backstop.js)
// gave a GHL contact in the last 24h. Their P2 card follows on the Sale → P2 pass.
async function saleContactSection(deps, nowMs) {
  const since = new Date(nowMs - DAY_MS).toISOString();
  const { data, error } = await deps.supabase.from('system_events')
    .select('ghl_contact_id, event_subtype, payload')
    .eq('event_type', 'lp.sale_contact_backstop')
    .gte('created_at', since);
  if (error) throw new Error(`sale contact backstop read failed: ${error.message}`);
  const rows = data || [];
  if (!rows.length) return null;
  const names = await loadNames(deps, rows.map((r) => r.ghl_contact_id));
  const lines = [];
  for (const [sub, label] of [['created', 'contact created'], ['linked', 'linked to an existing contact']]) {
    const who = [...new Set(rows.filter((r) => r.event_subtype === sub).map((r) => nameOf(names, r.ghl_contact_id)))];
    if (who.length) lines.push(`${label}: ${who.length} — ${who.slice(0, SECTION_MAX).join(', ')}${who.length > SECTION_MAX ? ` +${who.length - SECTION_MAX} more` : ''}`);
  }
  if (!lines.length) return null;
  return { title: 'Sales given a GHL contact (24h)', lines };
}

// 2026-10-09 (Mark: limit how often a person enters a lead). A post-issue
// rebook (src/lp-post-issue-rebook.js) sends the new LP lead itself, with no
// promoter when the issued lead's could not be matched and with a fallback
// Sub-Source when its own was blank. Nobody has to act, so it is a digest line,
// never a #contact-center card.
async function postIssueSection(deps, nowMs) {
  const since = new Date(nowMs - DAY_MS).toISOString();
  const { data, error } = await deps.supabase.from('system_events')
    .select('ghl_contact_id, payload')
    .eq('event_type', 'lp.post_issue_rebook')
    .eq('event_subtype', 'post_issue_new_lead_sent')
    .gte('created_at', since);
  if (error) throw new Error(`post-issue rebook read failed: ${error.message}`);
  const rows = data || [];
  if (!rows.length) return null;
  const names = await loadNames(deps, rows.map((r) => r.ghl_contact_id).filter(Boolean));
  const who = (r) => (r.ghl_contact_id ? nameOf(names, r.ghl_contact_id) : `LP lead ${r.payload?.issued_lead_id}`);
  const lines = [`new LP leads sent for issued leads: ${rows.length}`];
  const noPromoter = rows.filter((r) => r.payload?.promoter_status && r.payload.promoter_status !== 'matched');
  if (noPromoter.length) lines.push(`sent without a promoter: ${noPromoter.map((r) => `${who(r)} (${r.payload.promoter_status})`).slice(0, SECTION_MAX).join(', ')}`);
  const fallback = rows.filter((r) => r.payload?.srs_source && r.payload.srs_source !== 'lead');
  if (fallback.length) lines.push(`Sub-Source from a fallback: ${fallback.map((r) => `${who(r)} (${r.payload.srs_source} ${r.payload.srs_id})`).slice(0, SECTION_MAX).join(', ')}`);
  return { title: 'Post-issue rebooks (24h)', lines };
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
  // 2026-10-16 (Fix 5/7): an auto-enrolled demo is fixed — counted in the
  // Auto-fixed line, never listed. Only leads still not enrolled are named.
  const all = value.items || [];
  if (deps.autoFixed) deps.autoFixed.f0 = all.filter((i) => i.reason === 'f0_autoenrolled').length;
  const items = all.filter((i) => i.reason !== 'f0_autoenrolled').map((i) => ({ ...i, key: i.contact_id }));
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

// 2026-10-07: the nightly summaries that used to post on their own. Read from
// job_runs (the jobs keep their own schedules; the sweep is too heavy to run at
// 08:00). The newest row in the last 24h wins.
const NOT_FINISHED = new Set(['failed', 'unknown', 'interrupted']);

async function latestRuns(deps, nowMs) {
  const since = new Date(nowMs - DAY_MS).toISOString();
  const { data, error } = await deps.supabase.from('job_runs')
    .select('job_id, status, summary, detail, occurrence_key, started_at')
    .in('job_id', ['tag-hygiene-sweep', 'inbound-caller-capture', 'rule-target-check'])
    .gte('started_at', since)
    .order('started_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(`job_runs read failed: ${error.message}`);
  const rows = data || [];
  return {
    tag: rows.find((r) => r.job_id === 'tag-hygiene-sweep' && r.status !== 'running' && r.status !== 'skipped') || null,
    // Only the 07:15 summary pass; the hourly capture passes are their own thing.
    capture: rows.find((r) => r.job_id === 'inbound-caller-capture' && String(r.occurrence_key || '').endsWith('-summary')
      && r.status !== 'running' && r.status !== 'skipped') || null,
    ruleTarget: rows.find((r) => r.job_id === 'rule-target-check' && r.status !== 'running' && r.status !== 'skipped') || null,
  };
}

// 2026-10-12 (F-L): the nightly rule-target check (02:10). One line per rule
// whose workflow route goes nowhere (HIGH), each only the first time it is seen
// (30 days, keyed on rule + status + target). LOW findings never post. A run
// that did not finish (status unknown = the HL mirror was unreadable or stale)
// is always listed: a check that could not look must never read as "no dead
// routes".
async function ruleTargetSection(deps, run, nowMs) {
  const title = 'Rules pointing at dead workflows (02:10 check)';
  // No run in 24h is left to the job registry (a silent job shows as stale on
  // the dashboard), like the tag sweep above.
  if (!run) return null;
  if (NOT_FINISHED.has(run.status)) {
    return { title, lines: [`The rule target check did not finish (${run.status}): ${String(run.summary || 'no summary').slice(0, 160)} · check job_runs`] };
  }
  const items = (run.detail?.high_findings || [])
    .filter((f) => f && f.rule_id != null && f.line)
    .map((f) => ({ key: String(f.rule_id), reason: String(f.reason || 'high'), line: f.line }));
  if (!items.length) return null;
  const { fresh } = await deps.filterNew({ audit: 'rule_target', items, nowMs, deps: { supabase: deps.supabase } });
  if (!fresh.length) return null;
  return { title, lines: capLines(fresh.map((i) => i.line), SECTION_MAX), record: { audit: 'rule_target', items: fresh } };
}

async function summaryRunSection(deps, run, { audit, title, label, key, count, render, nowMs }) {
  if (!run) return null;
  if (NOT_FINISHED.has(run.status)) {
    return { title, lines: [`${label} did not finish (${run.status}): ${String(run.summary || 'no summary').slice(0, 160)} · check job_runs`] };
  }
  return countSection(deps, { audit, title, counts: { [key]: count }, render, nowMs });
}

async function nightlySummarySections(deps, nowMs) {
  const runs = await latestRuns(deps, nowMs);
  const tag = runs.tag?.detail || {};
  const cap = runs.capture?.detail || {};
  return [
    await summaryRunSection(deps, runs.tag, {
      audit: 'tag_sweep', title: 'Tag sweep (03:00)', label: 'The tag sweep', key: 'needs_review',
      count: Number(tag.needs_review), nowMs,
      render: (_k, n, last) => `${n} contact(s) need a tag review${last ? ` (was ${last})` : ''}`
        + `${tag.mode === 'report' && tag.fixed ? ` · ${tag.fixed} would be fixed in apply mode` : ''} · see tag_hygiene_log`,
    }),
    await summaryRunSection(deps, runs.capture, {
      audit: 'inbound_capture', title: 'Inbound callers with no LP lead (30 days)', label: 'The inbound-caller summary',
      key: 'candidates', count: Number(cap.counts?.candidates), nowMs,
      render: (_k, n, last) => `${n} caller(s) to capture${last ? ` (was ${last})` : ''} · capture mode ${cap.mode || '?'}`,
    }),
    await ruleTargetSection(deps, runs.ruleTarget, nowMs),
  ];
}
// 2026-10-12 (Fix 2). Features sat in shadow for weeks with nobody looking.
// Mondays only: ONE section naming how many flags are in shadow and the ones
// waiting longest, pointing at the dashboard's /modes page. It changes no
// flag; a flip stays Mark's (or the user's) call.
export const SHADOW_REVIEW_DAYS = 14;

/** Pure. Days in shadow per flag, longest first; counts from state_changed_at, else since. */
export function shadowReviewLines(rows, nowMs) {
  const shadow = (rows || []).filter((r) => r.current_state === 'shadow');
  if (!shadow.length) return [];
  const days = (r) => {
    const from = Date.parse(r.state_changed_at || `${r.since}T00:00:00Z`);
    return Number.isFinite(from) ? Math.max(0, Math.floor((nowMs - from) / DAY_MS)) : 0;
  };
  const waiting = shadow.map((r) => ({ name: r.name, d: days(r), ruled: r.go_live && !/needs a ruling/.test(r.go_live) }))
    .filter((r) => r.d >= SHADOW_REVIEW_DAYS)
    .sort((a, b) => b.d - a.d || a.name.localeCompare(b.name));
  const lines = [`${shadow.length} flags in shadow; ${waiting.length} for ${SHADOW_REVIEW_DAYS}+ days. Review on the dashboard's /modes page.`];
  if (waiting.length) {
    lines.push(`waiting longest: ${waiting.slice(0, SECTION_MAX).map((r) => `${r.name} (${r.d}d${r.ruled ? '' : ', no go-live test yet'})`).join(', ')}${waiting.length > SECTION_MAX ? ` +${waiting.length - SECTION_MAX} more` : ''}`);
  }
  return lines;
}

function isMondayET(nowMs) {
  return new Date(`${todayET(new Date(nowMs))}T12:00:00Z`).getUTCDay() === 1;
}

async function shadowModesSection(deps, nowMs) {
  if (!isMondayET(nowMs)) return null;
  const { data, error } = await deps.supabase.from('feature_modes')
    .select('name, current_state, state_changed_at, since, go_live')
    .eq('current_state', 'shadow');
  if (error) throw new Error(`feature_modes read failed: ${error.message}`);
  const lines = shadowReviewLines(data, nowMs);
  return lines.length ? { title: 'Shadow-mode review (Mondays)', lines } : null;
}

// 2026-10-15 (System Health 1.10). One section, only when it has something:
// checks yellow for more than 24h, shadow checks that WOULD have fired
// yesterday (count per check), and incidents resolved yesterday with their
// time to acknowledge and to resolve. A clean day adds nothing.

/** Pure. Lines for the System health section; [] when there is nothing. */
export function systemHealthLines({ stuckYellow = [], shadowFails = [], resolved = [] } = {}) {
  const lines = [];
  // 2026-10-15: plain words, no check ids or "3h 12m" shorthand.
  const mins = (ms) => (Number.isFinite(ms) ? duration(ms / 60_000) : 'an unknown time');
  if (stuckYellow.length) {
    lines.push(`Needed a look for more than a day: ${stuckYellow.slice(0, SECTION_MAX).map((c) => c.label).join(', ')}${stuckYellow.length > SECTION_MAX ? `, and ${stuckYellow.length - SECTION_MAX} more` : ''}`);
  }
  if (shadowFails.length) {
    lines.push(`Test-mode checks that turned red yesterday: ${shadowFails.slice(0, SECTION_MAX).map((c) => `${c.label || c.check_id} (${c.fails} time${c.fails === 1 ? '' : 's'})`).join(', ')}${shadowFails.length > SECTION_MAX ? `, and ${shadowFails.length - SECTION_MAX} more` : ''}`);
  }
  for (const i of resolved.slice(0, SECTION_MAX)) {
    const opened = Date.parse(i.opened_at);
    const ack = i.acknowledged_at ? `picked up after ${mins(Date.parse(i.acknowledged_at) - opened)}` : 'nobody picked it up';
    lines.push(`Fixed: ${i.title}: ${ack}, fixed after ${mins(Date.parse(i.resolved_at) - opened)}`);
  }
  return lines;
}

async function systemHealthSection(deps, nowMs) {
  const db = deps.supabase;
  const dayAgo = new Date(nowMs - DAY_MS).toISOString();
  const { data: latest, error } = await db.from('v_health_check_latest')
    .select('check_id, label, color, mode, last_observed_at');
  if (error) throw new Error(`v_health_check_latest read failed: ${error.message}`);
  const yellow = (latest || []).filter((c) => c.color === 'yellow');
  // Yellow for 24h+ = yellow now and not one pass in the last 24h.
  const stuckYellow = [];
  for (const c of yellow) {
    const { data: passes } = await db.from('health_results').select('id').eq('check_id', c.check_id)
      .eq('status', 'pass').gte('observed_at', dayAgo).limit(1);
    if (!passes?.length) stuckYellow.push(c);
  }
  // 2026-10-16 (handoff v3.4 Fix 7): test-mode (shadow) check counts are no
  // longer in the morning message — nobody acts on them there; the dashboard
  // keeps them. systemHealthLines still renders them for any other caller.
  const { data: resolved, error: e3 } = await db.from('incidents').select('id, title, opened_at, acknowledged_at, resolved_at')
    .eq('status', 'resolved').gte('resolved_at', dayAgo);
  if (e3) throw new Error(`incidents read failed: ${e3.message}`);
  const lines = systemHealthLines({ stuckYellow, resolved: resolved || [] });
  return lines.length ? { title: 'System health', lines } : null;
}

// 2026-10-16 (the user: "Count dialer calls only but I want to track the number of
// violations caused by manual calls"). Yesterday's Eastern day from
// v_call_journey_cap_daily: dialer calls over the 3-in-24 cap, manual calls that were
// a 4th+ call (by campaign), and two campaigns dialing one lead within 4 hours (the
// designed DIAL ASAP → After DIAL ASAP hand-off excluded). Informational, so it lives
// here and not on its own card; a day with all three at zero adds nothing.
const n0 = (v) => Number(v) || 0;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Pure. Lines for the call-cap section from one v_call_journey_cap_daily row; [] when all zero. */
export function callCapLines(row) {
  if (!row) return [];
  const dialer = n0(row.dialer_violations);
  const manual = n0(row.manual_violations);
  const clashes = n0(row.clashes);
  if (!dialer && !manual && !clashes) return [];
  const lines = [];
  if (dialer) lines.push(`Dialer: ${plural(dialer, 'call')} over the 3-calls-in-24-hours cap, on ${plural(n0(row.leads_over_cap), 'lead')}`);
  if (manual) {
    const by = Object.entries(row.manual_by_campaign || {}).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(', ');
    lines.push(`Manual: ${plural(manual, 'call')} that were a 4th call or more in 24 hours${by ? ` (${by})` : ''}`);
  }
  if (clashes) lines.push(`Two campaigns dialed the same lead within 4 hours ${plural(clashes, 'time')} (Data - Hot and After DIAL ASAP: ${n0(row.hot_after_clashes)})`);
  return lines;
}

async function callCapSection(deps, nowMs) {
  const yesterday = todayET(new Date(nowMs - DAY_MS));
  const { data, error } = await deps.supabase.from('v_call_journey_cap_daily')
    .select('call_date_et, dialer_violations, manual_violations, leads_over_cap, clashes, hot_after_clashes, manual_by_campaign')
    .eq('call_date_et', yesterday).limit(1);
  if (error) throw new Error(`v_call_journey_cap_daily read failed: ${error.message}`);
  const lines = callCapLines(data?.[0]);
  return lines.length ? { title: `Five9 call cap, ${yesterday} (Eastern)`, lines } : null;
}

// ── 2026-10-16 (handoff v3.4 Fix 7) — only what needs a person ────────────

/** Pure. The one "Auto-fixed" section from the counts; null when nothing was fixed. */
export function autoFixedLines(c = {}) {
  const lines = [];
  if (c.p2) lines.push(`P2 backstop added ${plural(c.p2, 'sale')} — auto-fixed`);
  if (c.ghl_created) lines.push(`${plural(c.ghl_created, 'LP appointment')} created in GHL (LP had it, GHL did not)`);
  if (c.same_slot_restored) lines.push(`${plural(c.same_slot_restored, 'cancelled appointment')} restored (a duplicate LP lead's cancel)`);
  if (c.drift) lines.push(`${plural(c.drift, 'GHL estimate')} corrected to LP's date/time`);
  if (c.disqualified) lines.push(`${plural(c.disqualified, 'ND / No Demo lead')} cleaned up (appointment invalid, out of every sequence)`);
  if (c.f0) lines.push(`${plural(c.f0, 'demoed lead')} enrolled in F.0`);
  return lines;
}

async function autoFixedCounts(deps, nowMs) {
  const since = new Date(nowMs - DAY_MS).toISOString();
  const counts = {};
  const { data: p2, error: e1 } = await deps.supabase.from('system_events')
    .select('ghl_contact_id, event_subtype').eq('event_type', 'p2.sale_backstop').gte('created_at', since);
  if (e1) throw new Error(`P2 backstop read failed: ${e1.message}`);
  counts.p2 = new Set((p2 || []).filter((r) => P2_BACKSTOP_FIXES[r.event_subtype]).map((r) => r.ghl_contact_id)).size;
  const { data: fixes, error: e2 } = await deps.supabase.from('system_events')
    .select('event_subtype').eq('event_type', 'appointment.parity_auto_fixed').gte('created_at', since);
  if (e2) throw new Error(`parity auto-fix read failed: ${e2.message}`);
  for (const r of fixes || []) {
    const k = String(r.event_subtype || '').startsWith('drift_') ? 'drift' : r.event_subtype;
    counts[k] = (counts[k] || 0) + 1;
  }
  const { data: dq, error: e3 } = await deps.supabase.from('agent_actions')
    .select('target_id').eq('action_type', 'disqualified_cleanup').eq('status', 'completed').gte('executed_at', since);
  if (e3) throw new Error(`disqualified cleanup read failed: ${e3.message}`);
  counts.disqualified = new Set((dq || []).map((r) => r.target_id)).size;
  return counts;
}

// Fix 4: one line per lead whose LP date/time looked wrong in the last 24h (the
// per-lead card's claim in lp_sync_failure_notices is the source).
async function lpLooksWrongSection(deps, nowMs) {
  const since = new Date(nowMs - DAY_MS).toISOString();
  const { data, error } = await deps.supabase.from('lp_sync_failure_notices')
    .select('notice_key, contact_id, appt_date, appt_time, created_at')
    .like('notice_key', 'lp-looks-wrong:%').gte('created_at', since);
  if (error) throw new Error(`lp_sync_failure_notices read failed: ${error.message}`);
  const rows = data || [];
  if (!rows.length) return null;
  const names = await loadNames(deps, rows.map((r) => r.contact_id));
  const lines = rows.map((r) => {
    const lead = String(r.notice_key).split(':')[1] || '?';
    return `${nameOf(names, r.contact_id)} · LP lead ${lead} · ${r.appt_date || '?'}${r.appt_time ? ` ${r.appt_time}` : ''} · confirmation team fixes it in LP`;
  });
  return { title: `LP date/time looks wrong: ${rows.length}`, lines: capLines(lines, SECTION_MAX) };
}

// Fix 1.6: contacts with 2+ LP leads holding appointments within 7 days of each
// other. One line per contact per day (dedupe audit lp_duplicate_leads, 1 day).
async function duplicateLeadsSection(deps, nowMs) {
  const { findDuplicateLeadGroups } = await import('../same-slot-sibling.js');
  const from = new Date(nowMs - DAY_MS).toISOString().slice(0, 10);
  const { data, error } = await deps.supabase.from('lp_leads')
    .select('ghl_contact_id, lp_lead_id, disposition_code, appointment_date, lp_branch_id, first_name, last_name, lp_deleted_at')
    .eq('appointment_set', true).gte('appointment_date', from).not('ghl_contact_id', 'is', null).is('lp_deleted_at', null).limit(5000);
  if (error) throw new Error(`lp_leads duplicate read failed: ${error.message}`);
  const groups = findDuplicateLeadGroups(data || []);
  if (!groups.length) return null;
  const items = groups.map((g) => ({ key: g.contactId, reason: 'lp_duplicate_leads', leads: g.leads }));
  const { fresh } = await deps.filterNew({ audit: 'lp_duplicate_leads', items, ttlDays: 1, nowMs, deps: { supabase: deps.supabase } });
  if (!fresh.length) return null;
  const names = await loadNames(deps, fresh.map((i) => i.key));
  const lines = fresh.map((i) => `${nameOf(names, i.key)} · ${i.leads.map((l) => `${l.lp_lead_id}/${l.lp_branch_id || '?'}/${l.disposition_code || '?'}/${String(l.appointment_date || '').slice(0, 16).replace('T', ' ')}`).join(' vs ')} · clean up in LP`);
  return { title: `Duplicate LP leads to clean up: ${fresh.length}`, lines: capLines(lines, SECTION_MAX), record: { audit: 'lp_duplicate_leads', items: fresh } };
}

// Fix 2: Five9 removals for disqualified leads waiting on a person's approval
// (only while DISQUALIFIED_FIVE9_AUTO_REMOVE is not true).
async function disqualifiedFive9Section(deps) {
  if (String(deps.env?.DISQUALIFIED_FIVE9_AUTO_REMOVE ?? process.env.DISQUALIFIED_FIVE9_AUTO_REMOVE ?? '').trim().toLowerCase() === 'true') return null;
  const { data, error } = await deps.supabase.from('agent_actions')
    .select('id').eq('action_type', 'five9_delete_record_from_list').eq('rule_applied', 'LP_DISP_DISQUALIFIED').eq('status', 'pending_approval');
  if (error) throw new Error(`disqualified Five9 removal read failed: ${error.message}`);
  const n = (data || []).length;
  return n ? { title: 'Five9 removals for ND / No Demo leads', lines: [`waiting on approval: ${n} · approve in Slack`] } : null;
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

  deps.autoFixed = {};
  for (const [label, build] of [['P2 won/lost summary', p2Section], ['Sale → P2 backstop summary', p2BackstopSection], ['Sale → contact backstop summary', saleContactSection], ['Appointment parity summary', paritySection], ['LP date/time looks wrong', lpLooksWrongSection], ['Duplicate LP leads', duplicateLeadsSection], ['Disqualified Five9 removals', disqualifiedFive9Section], ['Post-issue rebook summary', postIssueSection], ['Shadow-mode review', shadowModesSection], ['System health', systemHealthSection], ['Five9 call cap', callCapSection]]) {
    try { sections.push(await build(deps, nowMs)); } catch (err) { await couldNotRun(label, err.message); }
  }
  try { sections.push(...await nightlySummarySections(deps, nowMs)); } catch (err) { await couldNotRun('Nightly summaries (tag sweep, inbound callers, rule targets)', err.message); }

  for (const j of JOB_SECTIONS) {
    const out = await deps.runJob(j.id, () => deps[j.run](), { occurrence: today });
    if (out.status === 'skipped') continue;
    if (out.status === 'failed' || out.status === 'unknown' || out.status === 'interrupted') {
      await couldNotRun(j.label, out.error || out.summary || out.status);
      continue;
    }
    try { sections.push(await j.build(deps, out.value || {}, nowMs)); } catch (err) { await couldNotRun(j.label, err.message); }
  }

  // One "Auto-fixed: N (no action)" section, first: what a fallback fixed needs nobody.
  try {
    const counts = { ...(await autoFixedCounts(deps, nowMs)), f0: deps.autoFixed.f0 || 0 };
    const lines = autoFixedLines(counts);
    if (lines.length) {
      const n = Object.values(counts).reduce((t, v) => t + (Number(v) || 0), 0);
      sections.unshift({ title: `Auto-fixed: ${n} (no action)`, lines });
    }
  } catch (err) { await couldNotRun('Auto-fixed summary', err.message); }

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
