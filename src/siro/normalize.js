/**
 * Siro recording → siro_recordings row — src/siro/normalize.js (2026-10-16)
 *
 * Pure. No model call. Every Siro string is customer-authored and untrusted
 * (CANON.K.082): it passes scrubPii, is capped, and is data the bot reads,
 * never instructions.
 *
 * What we keep, and why (the user, 2026-10-16: "the most useful information
 * and not everything"). A read of the first 118 live records showed the whole
 * Siro record in `raw`: the home's GPS position, the customer's email, every
 * quote, Siro's drafted follow-up email and text, and its long "thinking".
 * Now:
 *   - raw       a small whitelist (ids, title, times, result, duration, the
 *               follow-up's type / score / status / rep / team). Never GPS,
 *               emails, phones, prices, drafts or thinking.
 *   - summary   Siro's four fixed sections, cleaned of citation marks [1] and
 *               markdown **.
 *   - moments   the call-moments shape (src/knowledge/ci-moments-core.js), read
 *               BY SECTION: "Customer Objections" → objection (one per bullet),
 *               "Customer Need & Motivation" → buying_signal (what they want).
 *               "Key Outcomes & Next Steps" is the next step, not an interest.
 *   - insights  Siro's follow-up fields the bot can use (main / secondary
 *               objection, the objection and follow-up summaries, follow-up
 *               timing, emotional tie, scope, commitment, team).
 *   - pricing   the quotes and financing as Siro wrote them.
 * Prices are KEPT everywhere (the user, 2026-10-16: "I do not want to strip
 * money"): stored as written, saved to GHL in the demo note, and shown to the
 * bot in the PRESENTATION block. What stops a price reaching a customer is the
 * reply guard (presentation-guard.js, checkReply presentation_quoted_price),
 * not missing data.
 */
import { scrubPii, OBJECTION_TYPES } from '../knowledge/ci-moments-core.js';
import { normalizePhone10 } from '../lead-leak-classify.js';

const OBJECTION_NAME_RX = /objection|concern|hesitat/i;
const QUESTION_NAME_RX = /question/i;
const NEED_NAME_RX = /need|motivation|interest|priorit|want/i;
const NEXT_STEP_NAME_RX = /outcome|next\s*step/i;
const PHONE_NAME_RX = /phone|mobile|cell/i;

// Which objection type a piece of text is about. Order matters: a price
// sentence that mentions a spouse is still a price objection first.
// 2026-10-16: ROI / resale / sticker shock / paying upfront read as price, and
// "not ready to decide" as timing (26 of the first objections fell to "other").
const OBJECTION_TYPE_RULES = [
  ['price', /\b(?:price|pricing|cost|expensive|afford|budget|money|financ|payment|pay(?:ing)?\s+(?:the\s+)?(?:full|upfront)|upfront|cheaper|sticker|return\s+on\s+investment|roi\b|resale|investment)|\$/i],
  ['spouse', /\b(?:spouse|wife|husband|partner|talk\s+(?:it\s+)?over|discuss\s+with)/i],
  ['competitor', /\b(?:competitor|other\s+(?:compan|quote|bid|estimate)|multiple\s+(?:estimates|quotes|bids)|shopping|compare|comparing)/i],
  ['timing', /\b(?:timing|time|wait|later|next\s+(?:year|month|week)|not\s+ready|think\s+(?:about|it\s+over)|decide|decision|revisit)/i],
  ['trust', /\b(?:trust|review|reputation|warranty|pushy|sure\s+about)/i],
  ['diy', /\b(?:diy|myself|handyman|install\s+(?:it\s+)?ourselves)/i],
];
export function objectionTypeOf(text) {
  for (const [type, rx] of OBJECTION_TYPE_RULES) if (rx.test(String(text || ''))) return type;
  return 'other';
}

/** Siro's citation marks and markdown out, whitespace collapsed. Pure. */
// 2026-10-16: some Siro sections arrive as HTML ("<ul><li>The strongest
// objection…"); a tag or an entity must never reach a prompt or a note.
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
export function cleanSiroText(s) {
  return String(s ?? '')
    .replace(/<(?:li|p|br|div)\b[^>]*>/gi, ' - ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m])
    .replace(/\[\d+\]/g, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/(?:\s-(?=\s|$))+(?=\s-\s)/g, '') // " - - - A" → " - A"
    .replace(/\s+-\s*$/, '')                   // a dangling bullet at the end
    .trim();
}

// Siro sometimes opens a bullet with a bare answer word ("Yes. The clearest
// need is …"): the word answers a question nobody here asked.
const BARE_ANSWER_RX = /^(?:yes|no|yeah|correct)[.,!]\s+(?=\S)/i;

const cap = (s, n) => {
  const t = scrubPii(cleanSiroText(s));
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

/** One item per bullet: Siro writes "- A. [1] - B. [2]". Pure. */
export function bulletsOf(v) {
  if (Array.isArray(v)) return v.map(valueText).map(cleanSiroText).filter(Boolean);
  const t = cleanSiroText(valueText(v));
  if (!t) return [];
  // Bullets when Siro wrote them; only a bullet-less list splits on "; ", so a
  // sentence with a semicolon inside a bullet stays whole.
  const split = (rx) => t.split(rx).map(x => x.trim()).filter(Boolean);
  const bullets = split(/(?:^|\s)[-•]\s+(?=\S)/).map(b => b.replace(BARE_ANSWER_RX, '')).filter(Boolean);
  if (bullets.length > 1 || /^[-•]\s/.test(t)) return bullets;
  const parts = split(/\n+|;\s+/);
  return parts.length ? parts : [t];
}

function kindForName(name) {
  if (OBJECTION_NAME_RX.test(name)) return 'objection';
  if (QUESTION_NAME_RX.test(name)) return 'question';
  if (NEXT_STEP_NAME_RX.test(name)) return null; // the next step, kept in insights
  if (NEED_NAME_RX.test(name)) return 'buying_signal';
  return null;
}

export const NONE_RX = /^(?:none|n\/a|na|no|null|unknown|not\s+(?:mentioned|discussed|applicable|provided|quoted|given))\.?$/i;

export function buildMoments({ extractions = [], summary = [] } = {}) {
  const out = [];
  const seen = new Set();
  const push = (kind, text) => {
    const said = cap(text, 280);
    if (!said || NONE_RX.test(said)) return;
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
    for (const item of bulletsOf(e?.value)) push(kind, item);
  }
  for (const s of Array.isArray(summary) ? summary : []) {
    const kind = kindForName(String(s?.name || ''));
    if (!kind) continue;
    for (const item of bulletsOf(s?.content)) push(kind, item);
  }
  return out.slice(0, 20);
}

/** The follow-up Siro wrote for this visit (REHASH first when several). */
function pickFollowup(raw) {
  const f = raw?.followups ?? raw?.followup ?? null;
  const list = Array.isArray(f) ? f.filter(Boolean) : (f ? [f] : []);
  return list.find(x => String(x?.followupType || '').toUpperCase() === 'REHASH') || list[0] || null;
}

function contextMap(fu) {
  const out = {};
  for (const c of Array.isArray(fu?.context) ? fu.context : []) {
    if (c && c.header) out[String(c.header)] = c.value;
  }
  return out;
}

// Siro's follow-up context fields the bot reads.
const INSIGHT_FIELDS = ['main_objection', 'secondary_objection', 'objection_summary', 'follow_up_summary',
  'follow_up_time', 'emotional_tie', 'scope', 'commitment'];
// The quotes and financing, kept in their own column for the note and the block.
const PRICING_FIELDS = ['first_price_quote', 'final_price_quote', 'overall_cost', 'financing', 'scope_cost_summary'];

function insightsFrom(fu, nextSteps) {
  const ctx = contextMap(fu);
  const out = {};
  for (const k of INSIGHT_FIELDS) {
    const v = ctx[k];
    if (v == null || !String(v).trim()) continue;
    const t = cap(valueText(v), 500);
    if (t && !NONE_RX.test(t)) out[k] = t;
  }
  if (nextSteps.length) out.next_steps = nextSteps.map(s => cap(s, 300)).slice(0, 4);
  if (fu?.teamName) out.team = String(fu.teamName).slice(0, 60);
  if (fu?.followupType) out.followup_type = String(fu.followupType).slice(0, 30);
  return Object.keys(out).length ? out : null;
}

function pricingFrom(fu) {
  const ctx = contextMap(fu);
  const out = {};
  for (const k of PRICING_FIELDS) {
    const v = ctx[k];
    if (v == null || !String(v).trim()) continue;
    const t = cap(valueText(v), 400);
    if (t && !NONE_RX.test(t)) out[k] = t; // "N/A" when no quote was given

  }
  return Object.keys(out).length ? out : null;
}

function phoneFrom(raw, fu) {
  const c = raw?.crmCustomer || fu?.crmCustomer || raw?.customer || null;
  const acctPhones = c?.opportunity?.account?.phoneNumbers;
  const fromCustomer = normalizePhone10(c?.phone || c?.phoneNumber
    || (Array.isArray(c?.phoneNumbers) ? c.phoneNumbers[0]?.number || c.phoneNumbers[0] : null)
    || (Array.isArray(acctPhones) ? acctPhones[0]?.number || acctPhones[0] : null));
  if (fromCustomer) return fromCustomer;
  for (const e of Array.isArray(raw?.entityExtractions) ? raw.entityExtractions : []) {
    if (PHONE_NAME_RX.test(String(e?.name || ''))) {
      const p = normalizePhone10(valueText(e.value));
      if (p) return p;
    }
  }
  return normalizePhone10(raw?.contactPhone) || null;
}

function summaryFrom(raw) {
  const s = raw?.summary ?? raw?.summaries;
  if (!Array.isArray(s)) return null;
  return s.map(x => ({ id: x?.id ?? null, name: String(x?.name || ''), content: cap(valueText(x?.content), 2000) }))
    .filter(x => x.content);
}

function userFrom(raw, fu, userNames) {
  const u = raw?.user || raw?.siroUser || {};
  const id = raw?.siroUserId || raw?.userId || u.id || fu?.repId || null;
  const known = id && userNames ? userNames.get?.(String(id)) || userNames[String(id)] || null : null;
  const name = fu?.repName || u.name || [u.firstName, u.lastName].filter(Boolean).join(' ')
    || raw?.userName || known?.name || null;
  return {
    siro_user_id: id,
    rep_email: (u.email || raw?.userEmail || known?.email || '').toLowerCase() || null,
    rep_name: name ? String(name).replace(/\s+/g, ' ').trim() : null,
  };
}

/** What we keep of the Siro record for debugging; nothing sensitive. Pure. */
export function rawWhitelist(r, fu) {
  return {
    id: r.id ?? null,
    title: r.title ?? null,
    createdAt: r.createdAt ?? r.dateCreated ?? null,
    updatedAt: r.updatedAt ?? null,
    result: r.result ?? null,
    durationInMilliseconds: r.durationInMilliseconds ?? null,
    userId: r.userId ?? r.siroUserId ?? null,
    conversationType: r.conversationType ?? null,
    link: r?.links?.web?.self ?? null,
    followup: fu ? {
      followupType: fu.followupType ?? null, score: fu.score ?? null, status: fu.status ?? null,
      repName: fu.repName ?? null, teamName: fu.teamName ?? null,
    } : null,
  };
}

const extId = (o) => (o && o.externalId != null && String(o.externalId).trim() ? String(o.externalId).trim() : null);

/**
 * @param {object} raw     a Siro recording (org GET /core/recordings/{id} with all four flags)
 * @param {{source:'webhook'|'poll'|'ensure', storeRaw?:boolean, flags?:{processed?:boolean, linked?:boolean},
 *          userNames?: Map<string,{name,email}>}} opts
 */
export function normalizeRecording(raw, { source = 'poll', storeRaw = true, flags = {}, userNames = null } = {}) {
  const r = raw?.data && raw.data.id ? raw.data : raw;
  if (!r || !r.id) return null;
  const crm = r.crm && typeof r.crm === 'object' ? r.crm : null;
  const summary = summaryFrom(r);
  const extractions = Array.isArray(r.entityExtractions) && r.entityExtractions.length ? r.entityExtractions : null;
  const fu = pickFollowup(r);
  const user = userFrom(r, fu, userNames);
  const nextSteps = (summary || []).filter(s => NEXT_STEP_NAME_RX.test(s.name)).flatMap(s => bulletsOf(s.content));
  const insights = insightsFrom(fu, nextSteps);
  const score = Number(fu?.score ?? r.followupScore);
  const durMs = Number(r.durationInMilliseconds);
  const durS = Number(r.duration ?? r.durationSeconds ?? r.durationSec);
  const status = String(r.status || r.processingStatus || '').toLowerCase();
  const processed = flags.processed === true || r.recordingProcessed === true
    || /^(?:processed|complete|completed|done)$/.test(status) || (Array.isArray(summary) && summary.length > 0);
  const followAction = insights?.follow_up_summary
    || (fu?.followupAction ? cap(valueText(fu.followupAction), 500) : null);
  return {
    recording_id: String(r.id),
    siro_user_id: user.siro_user_id,
    siro_team_id: r.siroTeamId || r.teamId || fu?.teamId || null,
    rep_email: user.rep_email,
    rep_name: user.rep_name,
    conversation_type: r.conversationType || r.conversationTypeId || null,
    recorded_at: asIso(r.dateCreated || r.recordedAt || r.createdAt),
    updated_at_siro: asIso(r.updatedAt),
    deleted: r.deleted === true || !!r.deletedAt,
    result: r.result ? String(r.result).toLowerCase() : null,
    duration_sec: Number.isFinite(durMs) && durMs > 0 ? Math.round(durMs / 1000) : (Number.isFinite(durS) ? Math.round(durS) : null),
    summary,
    entity_extractions: extractions,
    moments: buildMoments({ extractions: extractions || [], summary: summary || [] }),
    insights,
    pricing: pricingFrom(fu),
    followup_score: Number.isFinite(score) && score >= 1 && score <= 5 ? Math.round(score) : null,
    followup_status: fu?.status ? String(fu.status) : null,
    followup_action: followAction || null,
    crm,
    engagement_external_id: extId(crm?.engagement),
    opportunity_external_id: extId(crm?.opportunity),
    account_external_id: extId(crm?.account),
    customer_phone: phoneFrom(r, fu),
    processed,
    linked: flags.linked === true || r.recordingLinked === true || !!crm,
    source,
    raw: storeRaw ? rawWhitelist(r, fu) : null,
  };
}
