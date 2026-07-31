// src/services/backstop-notify.js
//
// Backstop notification module.
//
// ─── STATE (2026-07-31) ──────────────────────────────────────────────
// This file currently holds ONLY summarizeSources (handoff addendum §B1).
// The rest of the module — buildBackstopCard, notifyBackstopRun,
// notifyBackstopFailure, the exception gate and severity computation —
// comes from the PRIOR handoff (feat/backstop-exception-notifications),
// which is not present on any branch of this repo. Rather than invent a
// base layer that would collide with it on merge, the addendum's pure,
// self-contained helper landed here at its specified path and export name
// so the notify module can be dropped in around it unchanged.
//
// Wiring still outstanding, all of it §B2-§B4 / §D of the addendum:
//   - buildBackstopCard must pass summarizeSources(results) as
//     lpSource / lpSourceDetail UNCONDITIONALLY (not gated on `solo`).
//   - per-lead `•` detail lines must carry formatLpSource(...) || 'Unknown'.
//   - notifyBackstopRun must call generateBackstopInsight AFTER gate.send
//     and use its result as the narrative, deterministic template as fallback.
//
// NOTE: summarizeSources reads r.lead_source / r.lead_source_detail off the
// per-lead result objects. processOneLead in lp-contact-backstop.js does NOT
// currently carry those fields (its `base` is { lp_lead_id, name }), and
// executeOverScan returns formatted `lines`, not raw results. Both need to
// change for source to reach this helper with real values — see the PR body.

import { formatLpSource } from '../format-helpers.js';

/**
 * Source line for the card header, covering BOTH the single-lead and
 * multi-lead cases. The classifier renders `📋 Src:` from
 * formatLpSource(lpSource, lpSourceDetail), so:
 *   - one distinct source  → pass parent + detail, rendering "Parent > Detail"
 *   - several              → pass a pre-joined summary as lpSource with no
 *                            detail, rendering "Internet > Modernize (2), Iheart > Simpletext (1)"
 * Never returns null — an unresolvable source renders "Unknown", which is
 * itself signal (same doctrine as Prospect: NONE).
 */
export function summarizeSources(results = []) {
  const touched = results.filter((r) => r && (r.action === 'created' || r.action === 'linked'));
  if (touched.length === 0) return { lpSource: undefined, lpSourceDetail: undefined };

  const counts = new Map(); // display string -> { n, source, detail }
  for (const r of touched) {
    const display = formatLpSource(r.lead_source, r.lead_source_detail) || 'Unknown';
    const cur = counts.get(display) || { n: 0, source: r.lead_source || null, detail: r.lead_source_detail || null };
    cur.n++;
    counts.set(display, cur);
  }

  if (counts.size === 1) {
    const [, only] = [...counts.entries()][0];
    return { lpSource: only.source || 'Unknown', lpSourceDetail: only.detail || undefined };
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1].n - a[1].n);
  const shown = ranked.slice(0, 3).map(([display, v]) => `${display} (${v.n})`);
  const rest = ranked.slice(3).reduce((sum, [, v]) => sum + v.n, 0);
  if (rest > 0) shown.push(`+${rest} more`);
  return { lpSource: shown.join(', '), lpSourceDetail: undefined };
}
