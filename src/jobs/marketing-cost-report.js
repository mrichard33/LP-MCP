/**
 * Marketing cost report run — src/jobs/marketing-cost-report.js (handoff §9).
 *
 * `POST /n8n/admin/marketing-report/run { month?: 'YYYY-MM' }` is what the n8n
 * cron `OPS.MCRP Marketing Cost Report` calls Monday 07:30 ET and on the 2nd
 * of the month (the prior month). It builds one XLSX per market plus the
 * company (src/marketing/report.js + report-xlsx.js), stores them in the
 * private bucket marketing-reports/<yyyy-mm>/<market>.xlsx, posts one card
 * with 7-day links to #marketing-invoice-review, and answers with the links
 * and MKT_REPORT_EMAIL_TO so n8n's Gmail node can send the email (LP-MCP has
 * no mail sender; n8n stays a transport).
 */
import express from 'express';
import supabaseDefault from '../supabase.js';
import { runJob } from '../job-runner.js';
import { refuseIngest, FAIL_CLOSED, todayET } from './lp-report-common.js';
import { postToSlack } from '../slack.js';
import { buildReportModels } from '../marketing/report.js';
import { buildWorkbook } from '../marketing/report-xlsx.js';
import { reviewChannelId } from '../marketing/review-actions.js';

export const JOB_ID = 'marketing-cost-report';
export const REPORTS_BUCKET = 'marketing-reports';
const LOG = '[MktReport]';
const SIGNED_TTL_S = 7 * 24 * 3600;

export function defaultReportMonth(today = todayET()) {
  // On the 1st–3rd the report is about the month that just closed; otherwise the current month.
  const day = +today.slice(8, 10);
  if (day <= 3) {
    const d = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 2, 1));
    return d.toISOString().slice(0, 7);
  }
  return today.slice(0, 7);
}

export async function runMarketingReport({ month = defaultReportMonth(), post = true } = {}, deps = {}) {
  const supabase = deps.supabase || supabaseDefault;
  const ym = String(month).slice(0, 7);
  const models = await buildReportModels({ month: ym }, { supabase });
  const files = [];
  for (const model of models) {
    const buffer = await (deps.buildWorkbook || buildWorkbook)(model);
    const path = `${ym}/${model.market}.xlsx`;
    const { error } = await supabase.storage.from(REPORTS_BUCKET).upload(path, buffer, { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', upsert: true });
    if (error) throw new Error(`upload ${path} failed: ${error.message}`);
    const { data: signed } = await supabase.storage.from(REPORTS_BUCKET).createSignedUrl(path, SIGNED_TTL_S);
    files.push({ market: model.market, label: model.title, path, url: signed?.signedUrl || null, bytes: buffer.length, campaigns: model.campaign.length, held: model.held });
  }
  const emailTo = String(deps.env?.MKT_REPORT_EMAIL_TO ?? process.env.MKT_REPORT_EMAIL_TO ?? '').trim();
  const label = models[0]?.monthLabel || ym;
  const text = [
    `*Marketing cost report — ${label}* (cost per issued lead by market × sub-source, Brad's format)`,
    ...files.map((f) => (f.url ? `• <${f.url}|${f.label}>` : `• ${f.label} (no link)`)),
    `Links are good for 7 days. Net/Working $ from report 133; † = provisional Lead Gurus feed.`,
  ].join('\n');
  let posted = false;
  if (post) {
    const channel = reviewChannelId(deps.env);
    if (channel) {
      const r = await (deps.postToSlack || postToSlack)(text, channel);
      posted = !!r.ok;
      if (!r.ok) console.error(`${LOG} card not posted: ${r.error}`);
    }
  }
  console.log(`${LOG} ${ym}: ${files.length} file(s)${posted ? ', card posted' : ''}`);
  return { ok: true, month: ym, label, files, email_to: emailTo, slack_text: text, posted };
}

export function registerMarketingReportRoutes(app, deps = {}) {
  const json = express.json({ limit: '1mb' });
  app.post('/n8n/admin/marketing-report/run', json, async (req, res) => {
    try {
      if (refuseIngest(req, res, 'marketing-report', FAIL_CLOSED)) return;
      const month = req.body?.month ? String(req.body.month) : defaultReportMonth();
      const out = await runJob(JOB_ID, () => runMarketingReport({ month, post: req.body?.post !== false }, deps));
      res.status(out.status === 'failed' ? 500 : 200).json({ status: out.status, ...(out.value || {}), error: out.error || undefined });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
  console.log('[REST API] Registered: POST /n8n/admin/marketing-report/run');
}
