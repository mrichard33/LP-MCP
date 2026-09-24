/**
 * Service Request Card — src/actions/service-card.js
 *
 * 2026-09-24. A plain-English card for the call center when a customer needs
 * service. Built for people who have never seen the contact: who, phone, what
 * they need, and where to click. No scores, no source codes.
 *
 * ROUTING (Mark, 2026-09-24):
 *   - Record lists the Lakeland office  → LAKE  (#service-lakeland)
 *   - Otherwise                         → the contact's own market (ORL → #service-orlando)
 *   - No market at all                  → SLACK_CHANNEL_SERVICE (#contact-center), via src/slack.js
 *
 * ONE CARD PER CONTACT PER WINDOW: the chat flow usually adds
 * customer-service-request AND needs-human-followup in the same second, which
 * is two events and two actions. The claim below (groupme_notification_marks,
 * GROUPME_DEDUP_WINDOW_MIN, default 60) lets exactly one through. Fail-open.
 */
import { sendGroupMeMessage, _isDuplicateCard } from '../groupme.js';
import { formatDateTimeUS } from '../format-helpers.js';
import { branchName } from '../approval-card.js';
import { ghlFetch } from './helpers.js';

export const FIELD = {
  MARKET: 'z0MV6mXi0w9WwdCOFThh',            // LP Market code: ORL, LAKE, FTMYR, …
  SERVICING_OFFICE: 'Y1x4byRyOqNC5uUsGWtR',  // e.g. "5110 S Florida Ave, Suite 105, Lakeland 33813"
  CHAT_SUMMARY: 'hveTpGaEGu37Rq4skTgx',      // summary of the latest chat
  AI_SHORT_SUMMARY: 'dDFaBRpRn2aHVZTboUeB',  // one-paragraph AI summary
  CHAT_TRANSCRIPT: 'RF710H9k39oLl9TsQIy4',   // raw chat transcript (last resort)
};

const TAG_LABELS = {
  'customer-service-request': 'Customer service request',
  'needs-human-followup': 'Needs a person to follow up',
};

const SOLD_TAGS = ['deal-won', 'customer', 'closed-won', 'lp-status:closed-won', 'sw-customer'];
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'SsBG7j5KQAIP1SFP2Sca';
const ISSUE_MAX_CHARS = 450;
const NO_ISSUE_TEXT = 'No details were saved. Read the conversation in GHL before calling.';

/** Read a GHL custom field whatever shape the snapshot uses. '' when absent. */
export function getCustomField(contact, id) {
  if (!contact || !id) return '';
  for (const list of [contact.customFields, contact.customField, contact.custom_fields]) {
    if (Array.isArray(list)) {
      const hit = list.find((f) => f && (f.id === id || f.fieldId === id || f.key === id));
      if (hit && hit.value != null && String(hit.value).trim() !== '') return String(hit.value).trim();
    } else if (list && typeof list === 'object' && list[id] != null && String(list[id]).trim() !== '') {
      return String(list[id]).trim();
    }
  }
  return '';
}

/**
 * Lakeland office wins; otherwise the known market code; otherwise null.
 *
 * The raw market field is only a last resort (the caller's validated code
 * comes first), and it must be ONE code. ~135 contacts still hold joined
 * values like "LAKE, FTMYR" (see normalizeMarketCode in enrichment.js), which
 * match no Slack channel; null sends them to #contact-center instead.
 */
export function resolveServiceMarket(contact, fallbackCode) {
  const office = getCustomField(contact, FIELD.SERVICING_OFFICE);
  if (/lakeland/i.test(office)) return 'LAKE';
  const code = String(fallbackCode || getCustomField(contact, FIELD.MARKET) || '').trim().toUpperCase();
  return /^[A-Z]+$/.test(code) ? code : null;
}

function shorten(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (lastStop > max * 0.5) return cut.slice(0, lastStop + 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 0 ? lastSpace : max)}…`;
}

/** Best plain-English description of the issue, newest source first. */
export function pickIssueText(contact, context = {}) {
  const candidates = [
    getCustomField(contact, FIELD.CHAT_SUMMARY),
    getCustomField(contact, FIELD.AI_SHORT_SUMMARY),
    context.message_text,
    context.message_preview,
    getCustomField(contact, FIELD.CHAT_TRANSCRIPT),
  ];
  const raw = candidates.map((v) => String(v || '').replace(/\s+/g, ' ').trim()).find(Boolean);
  return raw ? shorten(raw, ISSUE_MAX_CHARS) : NO_ISSUE_TEXT;
}

export function formatPhone(p) {
  const digits = String(p || '').replace(/\D/g, '');
  const n = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (n.length !== 10) return p ? String(p) : 'No phone on file';
  return `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`;
}

export function isSoldCustomer(contact) {
  if (!contact) return false;
  if (String(contact.type || '').toLowerCase() === 'customer') return true;
  const tags = (contact.tags || []).map((t) => String(t).toLowerCase());
  return SOLD_TAGS.some((t) => tags.includes(t));
}

export function buildServiceCard(o) {
  const marketName = branchName(o.marketCode) || 'Market not set';
  const address = [o.contact?.address1, o.contact?.city].filter(Boolean).join(', ');
  const sold = isSoldCustomer(o.contact);
  const lines = [
    `🛠️ SERVICE REQUEST · ${marketName}`,
    `Customer: ${o.name || 'Name not on file'}`,
    `Phone: ${formatPhone(o.phone)}`,
    `What they need: ${o.issue || NO_ISSUE_TEXT}`,
    '',
  ];
  if (address) lines.push(`Address: ${address}`);
  lines.push(`Sold customer: ${sold ? 'Yes' : 'No (may be a sales lead)'}${o.repName ? ` · Sales rep: ${o.repName}` : ''}`);
  lines.push(`Flagged: ${TAG_LABELS[o.tag] || 'Needs follow-up'}${o.when ? ` · ${o.when}` : ''}`);
  lines.push('Next step: Call them today.');
  lines.push(`Open contact: https://app.gohighlevel.com/v2/location/${GHL_LOCATION_ID}/contacts/detail/${o.contactId}`);
  if (o.refHash) lines.push(`ref: ${o.refHash}`);
  return lines.join('\n');
}

/**
 * Full GHL contact (with custom fields) when the resolver's slim snapshot
 * lacks them — in practice only for an LP-lead-id target, since
 * resolveContactInfo's GHL snapshot already carries customFields. Goes
 * through the shared ghlFetch so it draws from the GHL rate budget.
 * Never throws; null on any failure.
 */
async function fetchGhlContact(contactId) {
  if (!contactId) return null;
  try {
    const body = await ghlFetch('GET', `/contacts/${encodeURIComponent(contactId)}`);
    return body?.contact || null;
  } catch (err) {
    console.warn(`[ServiceCard] GHL contact fetch ${contactId} failed: ${err.message}`);
    return null;
  }
}

async function ensureCustomFields(contactId, snapshot) {
  if (snapshot && (Array.isArray(snapshot.customFields) || Array.isArray(snapshot.customField))) return snapshot;
  const full = await fetchGhlContact(contactId);
  return full ? { ...(snapshot || {}), ...full } : (snapshot || {});
}

/** For any channel:"service" card (e.g. AGENTIC_REPLY_SLA_SERVICE_ROUTE). */
export async function resolveServiceMarketForContact(contactId, snapshot, fallbackCode) {
  const contact = await ensureCustomFields(contactId, snapshot);
  return resolveServiceMarket(contact, fallbackCode);
}

export async function sendServiceCard({ action, context = {}, contactId, name, phone, ghlContact, enrichment = {} }) {
  if (await _isDuplicateCard(`service-request:${contactId}`, 'service-claim')) {
    console.log(`[ServiceCard] one card per window — suppressed repeat for ${contactId} (rule ${action.rule_applied})`);
    return { action: 'duplicate_suppressed', skipped: true, card: 'service' };
  }

  const contact = await ensureCustomFields(contactId, ghlContact);
  const marketCode = resolveServiceMarket(contact, enrichment.marketCode);
  const tag = context.tag || context.event_subtype || context.payload?.tag || null;

  const text = buildServiceCard({
    name,
    phone: phone || contact.phone,
    contact,
    marketCode,
    repName: enrichment.repName,
    tag,
    issue: pickIssueText(contact, context),
    contactId,
    when: formatDateTimeUS(new Date()) || '',
    refHash: `a${action.id}`,
  });

  const sendResult = await sendGroupMeMessage(text, {
    channel: 'service',
    market: marketCode || undefined,
    flushNow: true,
    noDedup: true, // the per-contact claim above is this path's dedup
  });
  if (!sendResult?.sent) console.warn(`[ServiceCard] GroupMe send not confirmed for ${contactId}: ${sendResult?.reason}`);

  return {
    action: 'service_card_sent',
    card: 'service',
    market: marketCode,
    send_result: sendResult,
    message: text.slice(0, 600),
    ref_footer: `a${action.id}`,
  };
}
