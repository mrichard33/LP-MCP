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
  const sender = senderDomain(fromAddress);
  if (sender) {
    const byDomain = active.find((v) => (v.sender_domains || []).some((d) => domainMatches(sender, d)));
    if (byDomain) return { vendor: byDomain, method: 'sender_domain' };
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
  // would then match the first vendor that learnt it.
  if (d && !PUBLIC_MAIL_DOMAINS.has(d) && !domains.some((x) => domainMatches(d, x))) { domains.push(d); changed = true; }
  return changed ? { aliases, sender_domains: domains } : null;
}

export const PUBLIC_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'aol.com',
  'reecewindowsmail.com', 'reecewindows.com',
]);
