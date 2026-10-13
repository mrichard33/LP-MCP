/**
 * Vendor matching — src/marketing/vendors.js (pure).
 *
 * Who sent the invoice? Rules first, free: the sender's domain against
 * marketing_vendors.sender_domains, then any alias printed in the extracted
 * text. The AI (invoice-analyzer.js) only gets to pick when both miss, and it
 * picks from the SAME list — a vendor it invents is "unknown vendor" and goes
 * to review (handoff §7.1).
 */

export function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The registrable-ish domain of an address: "Billing <ar@mail.leadgurus.com>" → "mail.leadgurus.com". */
export function senderDomain(fromAddress) {
  const m = /@([a-z0-9.-]+)/i.exec(String(fromAddress || ''));
  return m ? m[1].toLowerCase() : null;
}

function domainMatches(sender, vendorDomain) {
  const v = String(vendorDomain || '').toLowerCase().trim();
  if (!v || !sender) return false;
  return sender === v || sender.endsWith(`.${v}`);
}

/**
 * @param {object} p
 * @param {string} [p.fromAddress]
 * @param {string} [p.text]        extracted invoice text
 * @param {Array}  p.vendors       marketing_vendors rows (active)
 * @returns {{vendor: object|null, method: 'sender_domain'|'alias'|null, alias?: string}}
 */
export function matchVendor({ fromAddress = '', text = '', vendors = [] }) {
  const active = (vendors || []).filter((v) => v && v.is_active !== false);
  const byDomainOf = (domain) => active.find((v) => (v.sender_domains || []).some((d) => domainMatches(domain, d)));
  // 2026-10-13: the first real invoice was FORWARDED by a person
  // (m.richard@reecewindows.com), so the sender domain says nothing about the
  // vendor. An internal sender is ignored, and the e-mail addresses printed in
  // the invoice text itself are tried next (the JMJ PDF prints
  // jmjdigitalmarketingppc@gmail.com; a public mailbox domain is never a match).
  const sender = senderDomain(fromAddress);
  if (sender && !isInternalMailDomain(sender)) {
    const byDomain = byDomainOf(sender);
    if (byDomain) return { vendor: byDomain, method: 'sender_domain' };
  }
  for (const d of emailDomainsIn(text)) {
    if (PUBLIC_MAIL_DOMAINS.has(d) || isInternalMailDomain(d)) continue;
    const byDomain = byDomainOf(d);
    if (byDomain) return { vendor: byDomain, method: 'text_domain' };
  }
  const haystack = normalizeName(text);
  if (haystack) {
    let best = null;
    for (const v of active) {
      const names = [v.vendor_name, ...(v.aliases || [])].map(normalizeName).filter((n) => n.length >= 3);
      for (const n of names) {
        if (new RegExp(`(^| )${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(haystack)) {
          if (!best || n.length > best.alias.length) best = { vendor: v, alias: n };
        }
      }
    }
    if (best) return { vendor: best.vendor, method: 'alias', alias: best.alias };
  }
  return { vendor: null, method: null };
}

/**
 * Learn from a correction on the Slack card (§8 "On edit"): the alias the
 * invoice printed and/or the sender domain go onto the vendor so the next
 * invoice matches by rules. Returns the patch to write, or null when nothing
 * is new.
 */
export function vendorLearnPatch(vendor, { alias = null, fromAddress = null } = {}) {
  const aliases = [...(vendor.aliases || [])];
  const domains = [...(vendor.sender_domains || [])];
  let changed = false;
  const a = String(alias || '').trim();
  if (a && !aliases.some((x) => normalizeName(x) === normalizeName(a))) { aliases.push(a); changed = true; }
  const d = senderDomain(fromAddress);
  // Never learn a mailbox provider as a vendor domain: every forwarded invoice
  // would then match the first vendor that learnt it. Never learn OUR domain
  // either (2026-10-13: a person forwarding an invoice is not the vendor).
  if (d && !PUBLIC_MAIL_DOMAINS.has(d) && !isInternalMailDomain(d) && !domains.some((x) => domainMatches(d, x))) { domains.push(d); changed = true; }
  return changed ? { aliases, sender_domains: domains } : null;
}

export const PUBLIC_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'aol.com',
  'reecewindowsmail.com', 'reecewindows.com',
]);

/** Our own mail domains: a forward from one of these never identifies a vendor. `MKT_INTERNAL_MAIL_DOMAINS` adds more. */
export const INTERNAL_MAIL_DOMAINS = ['reecewindows.com', 'reecewindowsmail.com'];

export function isInternalMailDomain(domain, env = process.env) {
  const d = String(domain || '').toLowerCase();
  if (!d) return false;
  const extra = String(env?.MKT_INTERNAL_MAIL_DOMAINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [...INTERNAL_MAIL_DOMAINS, ...extra].some((x) => d === x || d.endsWith(`.${x}`));
}

/** Every distinct e-mail domain printed in a text, in order of appearance. */
export function emailDomainsIn(text) {
  const out = [];
  const rx = /[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/gi;
  let m;
  while ((m = rx.exec(String(text || ''))) !== null) {
    const d = m[1].toLowerCase();
    if (!out.includes(d)) out.push(d);
  }
  return out;
}
