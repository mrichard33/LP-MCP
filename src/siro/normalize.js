/**
 * Siro recording → siro_recordings row — src/siro/normalize.js (2026-10-16)
 *
 * Pure. No model call. `moments` reuses the call-moments shape from
 * src/knowledge/ci-moments-core.js so the same consumers can read a phone
 * call and an in-home visit alike:
 *   [{ kind: 'objection'|'question'|'buying_signal', objection_type,
 *      customer_said, agent_said, resolved, confidence }]
 * built from Siro's entity extractions (and summary sections) by name:
 *   /objection|concern|hesitat/i → objection
 *   /question/i                  → question
 *   /interest|priorit|want|ready|next step/i → buying_signal
 *
 * Every Siro string is customer-authored and untrusted (CANON.K.082): it
 * passes scrubPii, is capped, and is data the bot reads, never instructions.
 * Field names are read defensively: Siro's per-endpoint schemas are only
 * partly documented (docs/siro-reference.md, note at the end).
 */
import { scrubPii, OBJECTION_TYPES } from '../knowledge/ci-moments-core.js';
import { normalizePhone10 } from '../lead-leak-classify.js';

const OBJECTION_NAME_RX = /objection|concern|hesitat/i;
const QUESTION_NAME_RX = /question/i;
const SIGNAL_NAME_RX = /interest|priorit|want|ready|next\s*step/i;
const PHONE_NAME_RX = /phone|mobile|cell/i;

// Which objection type a piece of text is about. Order matters: a price
// sentence that mentions a spouse is still a price objection first.
const OBJECTION_TYPE_RULES = [
  ['price', /\b(?:price|cost|expensive|afford|budget|money|financ|payment|cheaper|\$)/i],
  ['spouse', /\b(?:spouse|wife|husband|partner|talk\s+(?:it\s+)?over|discuss\s+with)/i],
  ['timing', /\b(?:timing|time|wait|later|next\s+(?:year|month)|not\s+ready|think\s+about)/i],
  ['competitor', /\b(?:competitor|other\s+(?:compan|quote|bid|estimate)|shopping|compare)/i],
  ['trust', /\b(?:trust|review|reputation|warranty|pushy|sure\s+about)/i],
  ['diy', /\b(?:diy|myself|handyman|install\s+(?:it\s+)?ourselves)/i],
];
export function objectionTypeOf(text) {
  for (const [type, rx] of OBJECTION_TYPE_RULES) if (rx.test(String(text || ''))) return type;
  return 'other';
}

const cap = (s, n) => {
  const t = scrubPii(String(s ?? '').replace(/\s+/g, ' ').trim());
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

function asIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// An extraction value may be a string, a list, or an object with text.
function valueText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(valueText).filter(Boolean).join('; ');
  if (typeof v === 'object') return String(v.text ?? v.value ?? v.content ?? JSON.stringify(v));
  return String(v);
}
// A list-like value becomes one moment per item.
function valueItems(v) {
  if (Array.isArray(v)) return v.map(valueText).filter(Boolean);
  const t = valueText(v);
  if (!t) return [];
  const parts = t.split(/\n+|;\s+|•\s*/).map(s => s.replace(/^[-*\d.)\s]+/, '').trim()).filter(Boolean);
  return parts.length ? parts : [t];
}

function kindForName(name) {
  if (OBJECTION_NAME_RX.test(name)) return 'objection';
  if (QUESTION_NAME_RX.test(name)) return 'question';
  if (SIGNAL_NAME_RX.test(name)) return 'buying_signal';
  return null;
}

export function buildMoments({ extractions = [], summary = [] } = {}) {
  const out = [];
  const seen = new Set();
  const push = (kind, text) => {
    const said = cap(text, 280);
    if (!said || /^(?:none|n\/a|no|null|not\s+(?:mentioned|discussed|applicable))\.?$/i.test(said)) return;
    const key = `${kind}|${said.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    const type = kind === 'objection' ? objectionTypeOf(said) : null;
    out.push({
      kind,
      objection_type: type && OBJECTION_TYPES.has(type) ? type : (kind === 'objection' ? 'other' : null),
      customer_said: said,
      agent_said: null,
      resolved: null,
      confidence: null,
    });
  };
  for (const e of Array.isArray(extractions) ? extractions : []) {
    const kind = kindForName(String(e?.name || ''));
    if (!kind) continue;
    for (const item of valueItems(e?.value)) push(kind, item);
  }
  for (const s of Array.isArray(summary) ? summary : []) {
    const kind = kindForName(String(s?.name || ''));
    if (!kind) continue;
    for (const item of valueItems(s?.content)) push(kind, item);
  }
  return out.slice(0, 20);
}

function phoneFrom(raw) {
  const c = raw?.crmCustomer || raw?.crm_customer || raw?.customer || null;
  const fromCustomer = normalizePhone10(c?.phone || c?.phoneNumber || (Array.isArray(c?.phoneNumbers) ? c.phoneNumbers[0]?.number || c.phoneNumbers[0] : null));
  if (fromCustomer) return fromCustomer;
  for (const e of Array.isArray(raw?.entityExtractions) ? raw.entityExtractions : []) {
    if (PHONE_NAME_RX.test(String(e?.name || ''))) {
      const p = normalizePhone10(valueText(e.value));
      if (p) return p;
    }
  }
  return normalizePhone10(raw?.contactPhone) || null;
}

function followupFrom(raw) {
  const f = raw?.followups ?? raw?.followup ?? null;
  const one = Array.isArray(f) ? f[0] : f;
  const score = Number(one?.score ?? raw?.followupScore);
  return {
    score: Number.isFinite(score) && score >= 1 && score <= 5 ? Math.round(score) : null,
    status: one?.status ? String(one.status) : null,
    action: one?.followupAction ? cap(valueText(one.followupAction), 500) : null,
  };
}

function summaryFrom(raw) {
  const s = raw?.summary ?? raw?.summaries;
  if (!Array.isArray(s)) return null;
  return s.map(x => ({ id: x?.id ?? null, name: String(x?.name || ''), content: cap(valueText(x?.content), 4000) }))
    .filter(x => x.content);
}

function userFrom(raw) {
  const u = raw?.user || raw?.siroUser || {};
  const name = u.name || [u.firstName, u.lastName].filter(Boolean).join(' ') || raw?.userName || null;
  return {
    siro_user_id: raw?.siroUserId || raw?.userId || u.id || null,
    rep_email: (u.email || raw?.userEmail || '').toLowerCase() || null,
    rep_name: name ? String(name).trim() : null,
  };
}

const extId = (o) => (o && o.externalId != null && String(o.externalId).trim() ? String(o.externalId).trim() : null);

/**
 * @param {object} raw     a Siro recording (org GET /core/recordings/{id} with all four flags)
 * @param {{source:'webhook'|'poll'|'ensure', storeRaw?:boolean, flags?:{processed?:boolean, linked?:boolean}}} opts
 */
export function normalizeRecording(raw, { source = 'poll', storeRaw = true, flags = {} } = {}) {
  const r = raw?.data && raw.data.id ? raw.data : raw;
  if (!r || !r.id) return null;
  const crm = r.crm && typeof r.crm === 'object' ? r.crm : null;
  const summary = summaryFrom(r);
  const extractions = Array.isArray(r.entityExtractions) ? r.entityExtractions : null;
  const fu = followupFrom(r);
  const user = userFrom(r);
  const duration = Number(r.duration ?? r.durationSeconds ?? r.durationSec);
  const status = String(r.status || r.processingStatus || '').toLowerCase();
  const processed = flags.processed === true || r.recordingProcessed === true
    || /^(?:processed|complete|completed|done)$/.test(status) || (Array.isArray(summary) && summary.length > 0);
  // Raw is kept for debugging; the transcript never rides along in it.
  const rawKept = storeRaw ? { ...r, utterances: undefined, transcript: undefined } : null;
  return {
    recording_id: String(r.id),
    siro_user_id: user.siro_user_id,
    siro_team_id: r.siroTeamId || r.teamId || null,
    rep_email: user.rep_email,
    rep_name: user.rep_name,
    conversation_type: r.conversationType || r.conversationTypeId || null,
    recorded_at: asIso(r.dateCreated || r.recordedAt || r.createdAt),
    updated_at_siro: asIso(r.updatedAt),
    deleted: r.deleted === true || !!r.deletedAt,
    result: r.result ? String(r.result).toLowerCase() : null,
    duration_sec: Number.isFinite(duration) ? Math.round(duration) : null,
    summary,
    entity_extractions: extractions,
    moments: buildMoments({ extractions: extractions || [], summary: summary || [] }),
    followup_score: fu.score,
    followup_status: fu.status,
    followup_action: fu.action,
    crm,
    engagement_external_id: extId(crm?.engagement),
    opportunity_external_id: extId(crm?.opportunity),
    account_external_id: extId(crm?.account),
    customer_phone: phoneFrom(r),
    processed,
    linked: flags.linked === true || r.recordingLinked === true || !!crm,
    source,
    raw: rawKept,
  };
}
