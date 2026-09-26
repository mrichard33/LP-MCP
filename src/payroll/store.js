// ─── Payroll store — src/payroll/store.js ────────────────────────────────────
//
// Every database read and write the payroll engine makes, behind one object so
// the engine and the tools take it as a `deps.store` seam and the tests hand in
// a plain fake. Nothing here decides pay — that is src/payroll/rules.js.
//
// Every method THROWS on a database error (with the PostgREST code attached),
// so the caller can tell "the tables are not there yet" (sql/132 unapplied)
// from "there were no rows". A read that failed must never be reported as a
// quiet week.

import defaultSupabase from '../supabase.js';
import { lpStoredBounds, monthsTouched, CANVASS_SOURCES } from './rules.js';

const PAGE = 1000;
const IN_CHUNK = 200;

const LEAD_COLS = 'lp_lead_id, lp_prospect_id, lead_source, created_at_lp, set_date, confirmed_date, demo_date, set_by_name, confirmed_by_name, ever_sat, closed_won';

function fail(what, error) {
  const e = new Error(`${what}: ${error?.message || error}`);
  e.code = error?.code;
  return e;
}

/** True when an error means a payroll table does not exist yet. */
export function isMissingTableError(err) {
  const code = String(err?.code || '');
  const msg = String(err?.message || '');
  return code === '42P01' || code === 'PGRST205'
    || /does not exist|Could not find the table/i.test(msg);
}

function chunks(arr, n = IN_CHUNK) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export function createPayrollStore({ supabase = defaultSupabase } = {}) {
  if (!supabase) throw new Error('supabase client unavailable (SUPABASE_URL / key unset)');

  async function pageAll(what, build) {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await build().range(from, from + PAGE - 1);
      if (error) throw fail(what, error);
      rows.push(...(data || []));
      if (!data || data.length < PAGE) return rows;
    }
  }

  return {
    async loadPartner(slug) {
      const { data, error } = await supabase.from('lf_partners')
        .select('id, slug, display_name, active').eq('slug', slug).maybeSingle();
      if (error) throw fail('lf_partners', error);
      return data || null;
    },

    async loadRules() {
      const { data, error } = await supabase.from('pay_rules').select('*').eq('active', true);
      if (error) throw fail('pay_rules', error);
      return data || [];
    },

    async loadExcluded() {
      const { data, error } = await supabase.from('pay_excluded_agents').select('agent_name, reason');
      if (error) throw fail('pay_excluded_agents', error);
      return new Set((data || []).map((r) => String(r.agent_name).trim()));
    },

    async loadCanvassConfirms(period) {
      const b = lpStoredBounds(period);
      return pageAll('lp_leads canvass confirms', () => supabase.from('lp_leads').select(LEAD_COLS)
        .in('lead_source', CANVASS_SOURCES)
        .gte('confirmed_date', b.gte).lt('confirmed_date', b.lt)
        .order('lp_lead_id'));
    },

    async loadDemos(period) {
      const b = lpStoredBounds(period);
      return pageAll('lp_leads demos', () => supabase.from('lp_leads').select(LEAD_COLS)
        .eq('ever_sat', true)
        .gte('demo_date', b.gte).lt('demo_date', b.lt)
        .order('lp_lead_id'));
    },

    /**
     * 134 rows with an RTP date in the period. 134 arrives as a month-to-date
     * snapshot, so a week that crosses a month end needs the latest snapshot of
     * EACH month it touches. `coverage` reports how far each month's snapshot
     * reaches, so a week the report does not yet cover is said out loud.
     */
    async load134(period) {
      const rows = [];
      const coverage = [];
      for (const month of monthsTouched(period)) {
        const { data: snaps, error } = await supabase.from('scorecard_report_snapshots')
          .select('id, period_start, period_end, as_of_date')
          .eq('report_type', 'jobs_by_milestone').eq('period_start', month)
          .not('finalized_at', 'is', null).is('abandoned_at', null)
          .order('as_of_date', { ascending: false }).limit(1);
        if (error) throw fail('scorecard_report_snapshots', error);
        const snap = snaps?.[0];
        coverage.push({ month, snapshot_id: snap?.id || null, through: snap?.period_end || null });
        if (!snap) continue;
        const part = await pageAll('scorecard_report_rows_a', () => supabase.from('scorecard_report_rows_a')
          .select('job_number, rtp_date, net_cents, market')
          .eq('snapshot_id', snap.id).gte('rtp_date', period.start).lte('rtp_date', period.end)
          .order('job_number'));
        rows.push(...part);
      }
      return { rows, coverage };
    },

    /**
     * 134 contract number → lp_leads row, via lp_jobs.raw_lp_data->>'contractid'
     * (the join src/admin/lp-rtp-job-backfill.js uses). A contract whose jobs
     * point at two different leads is ambiguous and is NOT guessed.
     */
    async matchJobsToLeads(jobNumbers) {
      const ids = [...new Set(jobNumbers.filter(Boolean).map(String))];
      const leadByContract = new Map();
      for (const part of chunks(ids)) {
        const { data, error } = await supabase.from('lp_jobs')
          .select('lp_lead_id, contractid:raw_lp_data->>contractid')
          .in('raw_lp_data->>contractid', part);
        if (error) throw fail('lp_jobs', error);
        for (const j of data || []) {
          const c = String(j.contractid);
          if (!j.lp_lead_id) continue;
          const prev = leadByContract.get(c);
          leadByContract.set(c, prev && prev !== String(j.lp_lead_id) ? 'AMBIGUOUS' : String(j.lp_lead_id));
        }
      }
      const leadIds = [...new Set([...leadByContract.values()].filter((v) => v !== 'AMBIGUOUS'))];
      const leads = new Map();
      for (const part of chunks(leadIds)) {
        const { data, error } = await supabase.from('lp_leads').select(LEAD_COLS).in('lp_lead_id', part);
        if (error) throw fail('lp_leads', error);
        for (const l of data || []) leads.set(String(l.lp_lead_id), l);
      }
      const out = new Map();
      for (const c of ids) {
        const leadId = leadByContract.get(c);
        if (!leadId) out.set(c, { reason: 'no LP job with this contract id' });
        else if (leadId === 'AMBIGUOUS') out.set(c, { reason: 'contract maps to more than one lead' });
        else if (!leads.has(leadId)) out.set(c, { reason: `lead ${leadId} not in lp_leads` });
        else out.set(c, { lead: leads.get(leadId) });
      }
      return out;
    },

    /** line_key → run id, for keys already PAID in a run other than `runId`. */
    async findPaidElsewhere(keys, runId = null) {
      const out = new Map();
      for (const part of chunks([...new Set(keys)])) {
        let q = supabase.from('payroll_ledger').select('line_key, run_id').in('line_key', part).eq('status', 'paid');
        if (runId) q = q.neq('run_id', runId);
        const { data, error } = await q;
        if (error) throw fail('payroll_ledger paid lookup', error);
        for (const r of data || []) out.set(r.line_key, r.run_id);
      }
      return out;
    },

    /** The run for this payee/period/mode, created if absent. Never duplicated. */
    async ensureRun({ payeeType, partnerId = null, period, mode }) {
      const find = async () => {
        let q = supabase.from('payroll_runs').select('*')
          .eq('payee_type', payeeType).eq('period_start', period.start)
          .eq('period_end', period.end).eq('mode', mode);
        q = partnerId ? q.eq('partner_id', partnerId) : q.is('partner_id', null);
        const { data, error } = await q.limit(1);
        if (error) throw fail('payroll_runs', error);
        return data?.[0] || null;
      };
      const existing = await find();
      if (existing) return { run: existing, created: false };
      const { error } = await supabase.from('payroll_runs').insert({
        payee_type: payeeType, partner_id: partnerId, period_start: period.start, period_end: period.end, mode,
      });
      // 23505 = a concurrent pass created it first; the re-read picks it up.
      if (error && error.code !== '23505') throw fail('payroll_runs insert', error);
      const run = await find();
      if (!run) throw new Error('payroll_runs: run vanished after insert');
      return { run, created: !error };
    },

    /** Insert lines; an existing (run_id, line_key) is left untouched. Returns the rows inserted. */
    async insertLines(runId, lines) {
      const inserted = [];
      for (const part of chunks(lines, 500)) {
        const { data, error } = await supabase.from('payroll_ledger')
          .upsert(part.map((l) => ({ ...l, run_id: runId })), { onConflict: 'run_id,line_key', ignoreDuplicates: true })
          .select('id, line_key, status, flag_reason, amount_cents');
        if (error) throw fail('payroll_ledger insert', error);
        inserted.push(...(data || []));
      }
      return inserted;
    },

    async getRun(runId) {
      const { data, error } = await supabase.from('payroll_runs').select('*').eq('id', runId).maybeSingle();
      if (error) throw fail('payroll_runs', error);
      return data || null;
    },

    async listRuns({ limit = 10 } = {}) {
      const { data, error } = await supabase.from('payroll_runs').select('*')
        .order('period_start', { ascending: false }).limit(limit);
      if (error) throw fail('payroll_runs', error);
      return data || [];
    },

    async getLines(runId, { status = null } = {}) {
      return pageAll('payroll_ledger', () => {
        let q = supabase.from('payroll_ledger').select('*').eq('run_id', runId);
        if (status) q = q.eq('status', status);
        return q.order('event_date').order('lp_lead_id');
      });
    },

    async getLine(lineId) {
      const { data, error } = await supabase.from('payroll_ledger').select('*').eq('id', lineId).maybeSingle();
      if (error) throw fail('payroll_ledger', error);
      return data || null;
    },

    /**
     * Conditional update: only rows still in `fromStatuses` change, so two
     * clicks (or a click racing a tool call) cannot both win. Returns rows changed.
     */
    async updateLines(filter, patch) {
      let q = supabase.from('payroll_ledger').update(patch);
      if (filter.id) q = q.eq('id', filter.id);
      if (filter.runId) q = q.eq('run_id', filter.runId);
      if (filter.fromStatuses) q = q.in('status', filter.fromStatuses);
      const { data, error } = await q.select('id');
      if (error) throw fail('payroll_ledger update', error);
      return data || [];
    },

    async updateRun(runId, fromStatus, patch) {
      const { data, error } = await supabase.from('payroll_runs').update(patch)
        .eq('id', runId).eq('status', fromStatus).select('*');
      if (error) throw fail('payroll_runs update', error);
      return data?.[0] || null;
    },

    async setRunTotal(runId, totalCents) {
      const { error } = await supabase.from('payroll_runs').update({ total_cents: totalCents }).eq('id', runId);
      if (error) throw fail('payroll_runs total', error);
    },

    async audit(rows) {
      const list = [].concat(rows).filter(Boolean);
      for (const part of chunks(list, 500)) {
        const { error } = await supabase.from('payroll_audit').insert(part);
        if (error) throw fail('payroll_audit', error);
      }
    },

    async listExcludedAgents() {
      const { data, error } = await supabase.from('pay_excluded_agents').select('*').order('agent_name');
      if (error) throw fail('pay_excluded_agents', error);
      return data || [];
    },

    async listAllRules() {
      const { data, error } = await supabase.from('pay_rules').select('*')
        .order('payee_type').order('event_type').order('effective_from', { ascending: false });
      if (error) throw fail('pay_rules', error);
      return data || [];
    },

    async findActiveApprover(email) {
      const { data, error } = await supabase.from('lf_report_approvers')
        .select('email, name, active').ilike('email', String(email)).eq('active', true).limit(1);
      if (error) throw fail('lf_report_approvers', error);
      return data?.[0] || null;
    },

    /**
     * Report 135 (Lead Disposition) vs lp_leads, by lead id. The latest current
     * month-to-date 135 snapshot lists every lead with an appointment (set) or
     * a gross sale (sold); each is looked up in lp_leads by lp_lead_id OR
     * lp_prospect_id — 135 prints the prospect id for most leads.
     *
     * By id rather than by comparing totals: 135 repeats a lead once per
     * entry-date row (up to 12 times), so its row totals overcount and a count
     * comparison would cry "missing" every single week.
     */
    async missingLeadCheck() {
      const { data: snaps, error } = await supabase.from('scorecard_report_snapshots')
        .select('id, period_start, period_end')
        .eq('report_type', 'lead_disposition').eq('scope', 'mtd').eq('is_current', true)
        .order('period_end', { ascending: false }).limit(1);
      if (error) throw fail('scorecard_report_snapshots (135)', error);
      const snap = snaps?.[0];
      if (!snap) return { error: 'no current report 135 snapshot' };
      const rows = await pageAll('lp_lead_disposition_history', () => supabase.from('lp_lead_disposition_history')
        .select('lp_lead_id, appt_date, gsa_cents').eq('snapshot_id', snap.id).order('lp_lead_id'));
      const set = new Set();
      const sold = new Set();
      for (const r of rows) {
        const id = String(r.lp_lead_id || '').trim();
        if (!id) continue;
        if (r.appt_date != null) set.add(id);
        if (Number(r.gsa_cents) > 0) sold.add(id);
      }
      const ids = [...new Set([...set, ...sold])];
      const found = new Set();
      for (const part of chunks(ids)) {
        for (const col of ['lp_lead_id', 'lp_prospect_id']) {
          const { data, error: e2 } = await supabase.from('lp_leads').select(col).in(col, part);
          if (e2) throw fail(`lp_leads by ${col}`, e2);
          for (const r of data || []) found.add(String(r[col]));
        }
      }
      const missing = (s) => [...s].filter((id) => !found.has(id));
      const ms = missing(set);
      const mo = missing(sold);
      return {
        window: { start: snap.period_start, end: snap.period_end },
        sets: set.size, sold: sold.size,
        missingSets: ms.length, missingSold: mo.length,
        sampleMissing: [...new Set([...mo, ...ms])].slice(0, 10),
      };
    },
  };
}
