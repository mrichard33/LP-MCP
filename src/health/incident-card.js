/**
 * incident-card.js — the ONE Slack card for an incident (pure).
 *
 * Built once here and edited in place on every state change
 * (src/jobs/incident-notifier.js), so there is no second copy of the format.
 * Plain English: what is wrong, what it costs, who is affected, and a link to
 * the incident page. Customer phones are the full 10 digits (the user,
 * 2026-10-13), via slackPhone.
 */

import { slackPhone } from '../format-helpers.js';
import { duration, etWhen, severityWord } from './plain.js';

export const SEVERITY_ICON = Object.freeze({ P1: '🔴', P2: '🟠', P3: '🟡', P4: '⚪' });
export const STATUS_LABEL = Object.freeze({
  open: 'Open',
  acknowledged: 'Acknowledged',
  investigating: 'Investigating',
  fix_proposed: 'Fix proposed',
  approved: 'Fix approved',
  fixing: 'Fixing',
  verifying: 'Checking it stays fixed',
  resolved: 'Resolved',
  closed_no_action: 'Closed (no action)',
  snoozed: 'Snoozed',
});

const MAX_LEADS = 10;

export function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  return `$${Math.round(v).toLocaleString('en-US')}`;
}

/** "45 minutes", "about 3 hours", "2 days" (2026-10-15: no "3h 12m" shorthand). */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'an unknown time';
  return duration(ms / 60_000);
}

/** One affected-lead line: "Pat Q. · 3525550188 · Google PPC · waiting 42 minutes · about $2,500". */
export function leadLine(l) {
  const parts = [
    l.name || 'No name',
    slackPhone(l.phone10) || null,
    l.source || null,
    Number.isFinite(l.waiting_min) ? `waiting ${formatDuration(l.waiting_min * 60_000)}` : null,
    money(l.est_value) ? `about ${money(l.est_value)}` : null,
  ].filter(Boolean);
  return `• ${parts.join(' · ')}`;
}

export function incidentUrl(id, baseUrl) {
  return `${String(baseUrl || 'https://dashboard.getreecewindows.com').replace(/\/$/, '')}/incidents/${id}`;
}

/** { text, blocks } for an incident. Pure. */
export function buildIncidentCard(incident, { dashboardBaseUrl, nowMs = Date.now() } = {}) {
  const icon = SEVERITY_ICON[incident.severity] || '⚪';
  const status = STATUS_LABEL[incident.status] || incident.status;
  const terminal = incident.status === 'resolved' || incident.status === 'closed_no_action';
  const header = `${terminal ? '✅' : icon} ${severityWord(incident.severity)}: ${incident.title}`;
  const leads = Array.isArray(incident.data?.detail?.leads) ? incident.data.detail.leads : [];
  const value = money(incident.est_value_at_risk);
  const url = incidentUrl(incident.id, dashboardBaseUrl);

  const lines = [
    `*${header}*`,
    `Status: *${status}*${incident.acknowledged_by ? ` (acknowledged by ${incident.acknowledged_by})` : ''} · open for ${formatDuration(nowMs - Date.parse(incident.opened_at))}`
      + (incident.occurrence_count > 1 ? ` · has come back ${incident.occurrence_count - 1} time${incident.occurrence_count === 2 ? '' : 's'}` : ''),
    incident.summary ? incident.summary : null,
    incident.business_impact ? `Why it matters: ${incident.business_impact}${value ? ` (about ${value} at risk)` : ''}` : (value ? `About ${value} at risk` : null),
  ].filter(Boolean);
  if (leads.length) {
    lines.push(`Leads affected (${leads.length}${leads.length > MAX_LEADS ? `, first ${MAX_LEADS} shown` : ''}):`);
    for (const l of leads.slice(0, MAX_LEADS)) lines.push(leadLine(l));
  }
  if (incident.snooze_until && incident.status === 'snoozed') lines.push(`Snoozed until ${etWhen(Date.parse(incident.snooze_until))}`);
  lines.push(`<${url}|Open in dashboard> · ref: ${incident.check_id} #${incident.id}`);
  const text = lines.join('\n');

  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } }];
  const actions = [{ type: 'button', text: { type: 'plain_text', text: 'Open in dashboard' }, url, action_id: 'incident_open' }];
  if (!terminal) {
    if (!incident.acknowledged_at) actions.push({ type: 'button', text: { type: 'plain_text', text: 'Acknowledge' }, style: 'primary', action_id: 'incident_ack', value: String(incident.id) });
    if (incident.status !== 'snoozed') actions.push({ type: 'button', text: { type: 'plain_text', text: 'Snooze 2h' }, action_id: 'incident_snooze', value: String(incident.id) });
  }
  blocks.push({ type: 'actions', elements: actions });
  return { text, blocks };
}

/** The one thread reply when an incident resolves. */
export function resolvedReply(incident, nowMs = Date.now()) {
  const opened = Date.parse(incident.opened_at);
  const at = Date.parse(incident.resolved_at || new Date(nowMs).toISOString());
  return `✅ Fixed after ${formatDuration(at - opened)}${incident.verified_by ? ` (checked by ${incident.verified_by})` : ''}.`;
}
