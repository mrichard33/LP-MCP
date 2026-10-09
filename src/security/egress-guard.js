/**
 * egress-guard — default-deny outbound HTTP for the http_request MCP tool
 * (2026-10-07, AI OS CANON.SEC.007 least-privilege allowlists).
 *
 * WHY. The 2026-09-23 IT/GoCloud review asked for default-deny egress.
 * http_request already blocks private hosts BY NAME (isPrivateHost in
 * src/tools/admin/http-tools.js) and has an opt-in exact-host allowlist
 * (HTTP_TOOL_ALLOWED_HOSTS, unset in production). Three holes remain:
 *   1. a public hostname that RESOLVES to 169.254.169.254 / 10.x / ::1 passes
 *      the by-name check (DNS rebinding, or just an attacker's A record);
 *   2. redirects are followed blindly, so https://ok.example → 302 →
 *      http://169.254.169.254/ reaches the metadata endpoint;
 *   3. with no allowlist, any host on the internet is reachable — an
 *      exfiltration channel for anything a prompt-injected agent can read.
 *
 * HTTP_EGRESS_MODE:
 *   off      — none of this runs (the old checks still do).
 *   shadow   — DEFAULT. Every check runs and a failure logs
 *              `[EgressGuard] would_deny` + a tool_audit_log row, but the
 *              request goes ahead exactly as before. Use the audit rows to
 *              build the allowlist.
 *   enforce  — refuse a host not on HTTP_EGRESS_ALLOWLIST (empty list = refuse
 *              everything), refuse any private / link-local / metadata
 *              address however it was reached (literal or resolved), and
 *              follow redirects by hand, re-checking each hop (max 5) and
 *              dropping the profile's credentials on a cross-host hop.
 *
 * HTTP_EGRESS_ALLOWLIST: comma-separated. `api.five9.com` matches exactly;
 * `.gohighlevel.com` matches the domain and every subdomain.
 *
 * DNS REBINDING, HONESTLY. The host is resolved and every address checked
 * before the request, but Node's fetch resolves again when it connects, and
 * pinning the address needs an undici dispatcher this repo does not ship. A
 * DNS server that answers public then private within the same second can
 * still win that race. In enforce mode the host must ALSO be on the
 * allowlist, so the attacker would need to control DNS for one of our own
 * vendors' domains. Pure apart from the injected `lookup`.
 */

import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

export function httpEgressMode(env = process.env) {
  const v = String(env.HTTP_EGRESS_MODE || '').trim().toLowerCase();
  return v === 'off' || v === 'enforce' ? v : 'shadow';
}

export function parseEgressAllowlist(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Does `host` match an allowlist entry (exact, or `.suffix`)? */
export function hostAllowed(host, list) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  for (const e of list) {
    if (e.startsWith('.')) {
      if (h === e.slice(1) || h.endsWith(e)) return true;
    } else if (h === e) {
      return true;
    }
  }
  return false;
}

function v4ToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}
function inV4(ip, base, bits) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
}

const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], ['192.0.0.0', 24],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

/** Expand an IPv6 literal to 8 groups of numbers, or null. */
function v6Groups(ip) {
  let s = ip.toLowerCase();
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct);
  // Embedded IPv4 tail (::ffff:1.2.3.4)
  const v4tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4tail) {
    const n = v4ToInt(v4tail[1]);
    s = s.slice(0, -v4tail[1].length) + ((n >>> 16).toString(16)) + ':' + ((n & 0xffff).toString(16));
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = parts.length === 2 ? 8 - head.length - tail.length : 0;
  const all = [...head, ...Array(Math.max(0, fill)).fill('0'), ...tail];
  if (all.length !== 8) return null;
  return all.map((g) => parseInt(g || '0', 16));
}

/**
 * Is this IP literal one we never call? Loopback, private, link-local (incl.
 * the 169.254.169.254 metadata endpoint), CGNAT (Railway's private network
 * range), multicast, unspecified, IPv6 ::1, fc00::/7, fe80::/10, and any
 * IPv4-mapped/compatible IPv6 form of the above. Non-IP input → false.
 */
export function isBlockedIp(ip) {
  const s = String(ip || '').replace(/^\[|\]$/g, '');
  const fam = net.isIP(s.split('%')[0]);
  if (fam === 4) return V4_BLOCKED.some(([b, bits]) => inV4(s, b, bits)) || s === '255.255.255.255';
  if (fam === 6) {
    const g = v6Groups(s);
    if (!g) return true; // unparseable v6 literal: fail closed
    const allZero = g.every((x) => x === 0);
    if (allZero) return true;                                   // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
    if ((g[0] & 0xfe00) === 0xfc00) return true;                 // fc00::/7
    if ((g[0] & 0xffc0) === 0xfe80) return true;                 // fe80::/10
    if ((g[0] & 0xff00) === 0xff00) return true;                 // multicast
    // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible) → check the v4
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
      const v4 = `${g[6] >>> 8}.${g[6] & 0xff}.${g[7] >>> 8}.${g[7] & 0xff}`;
      return isBlockedIp(v4);
    }
    // 64:ff9b::/96 NAT64 of a private v4
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
      return isBlockedIp(`${g[6] >>> 8}.${g[6] & 0xff}.${g[7] >>> 8}.${g[7] & 0xff}`);
    }
    return false;
  }
  return false;
}

/**
 * Check one URL. Never throws.
 * @returns {Promise<{ ok: boolean, reasons: string[], host: string, addresses: string[] }>}
 *   ok=false means enforce mode would refuse it; reasons say why.
 */
export async function checkEgress(urlObj, { env = process.env, lookup = dnsLookup } = {}) {
  const reasons = [];
  const host = String(urlObj?.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  const addresses = [];
  if (!host) return { ok: false, reasons: ['no_host'], host, addresses };
  const proto = String(urlObj.protocol || '');
  if (proto !== 'https:' && proto !== 'http:') reasons.push(`bad_scheme:${proto}`);

  const list = parseEgressAllowlist(env.HTTP_EGRESS_ALLOWLIST);
  if (!hostAllowed(host, list)) reasons.push(list.length ? 'host_not_allowlisted' : 'allowlist_empty');

  if (net.isIP(host)) {
    addresses.push(host);
    if (isBlockedIp(host)) reasons.push('private_ip_literal');
  } else {
    try {
      const res = await lookup(host, { all: true, verbatim: true });
      for (const r of [].concat(res || [])) addresses.push(r.address);
      if (addresses.some(isBlockedIp)) reasons.push('resolves_to_private_ip');
      if (addresses.length === 0) reasons.push('dns_no_answer');
    } catch (err) {
      reasons.push(`dns_error:${err?.code || 'unknown'}`);
    }
  }
  return { ok: reasons.length === 0, reasons, host, addresses };
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);
export const MAX_REDIRECTS = 5;

/**
 * Enforce-mode fetch: check, fetch with redirect:'manual', re-check each hop.
 * A 301/302/303 becomes a body-less GET (as browsers do); 307/308 keep method
 * and body. A hop to a different host drops `credentialHeaders` (the auth
 * profile's), so a vendor redirect cannot carry our API key elsewhere.
 *
 * @returns {Promise<{ res?: Response, denied?: { url: string, reasons: string[] }, hops: string[] }>}
 */
export async function fetchWithEgressChecks(url, init, { fetchImpl = fetch, check = checkEgress, env = process.env, credentialHeaders = [] } = {}) {
  let current = new URL(String(url));
  let reqInit = { ...init, redirect: 'manual' };
  const firstHost = current.hostname;
  const hops = [];
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const c = await check(current, { env });
    if (!c.ok) return { denied: { url: current.toString(), reasons: c.reasons }, hops };
    hops.push(current.toString());
    const res = await fetchImpl(current, reqInit);
    if (!REDIRECT.has(res.status)) return { res, hops };
    const loc = res.headers?.get?.('location');
    if (!loc) return { res, hops };
    const nextUrl = new URL(loc, current);
    const headers = { ...(reqInit.headers || {}) };
    if (nextUrl.hostname !== firstHost) {
      for (const k of Object.keys(headers)) {
        if (credentialHeaders.some((h) => h.toLowerCase() === k.toLowerCase()) || k.toLowerCase() === 'authorization') delete headers[k];
      }
    }
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && reqInit.method && reqInit.method !== 'GET' && reqInit.method !== 'HEAD')) {
      reqInit = { ...reqInit, method: 'GET', body: undefined, headers };
    } else {
      reqInit = { ...reqInit, headers };
    }
    current = nextUrl;
  }
  return { denied: { url: current.toString(), reasons: ['too_many_redirects'] }, hops };
}
