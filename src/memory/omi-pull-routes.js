/**
 * Omi pull routes — src/memory/omi-pull-routes.js
 *
 * Admin controls for the puller. Note the difference from omi-routes.js: that
 * file is an INBOUND webhook from a third party, so it carries its own three
 * secrets and never reads a query parameter. These are ordinary operator
 * endpoints, so they sit behind the same `authenticate` middleware as every
 * other /admin route.
 *
 *   POST /admin/omi/pull         { dry_run?, deep?, kinds? }  run one pull now
 *   GET  /admin/omi/pull/status                               where each kind stands
 *
 * dry_run forces shadow behaviour: the run pages the API, plans every row and
 * writes nothing but a validation-log entry. It is the step Mark uses to read
 * the planned rows and check the titles against his own Omi list before
 * anything reaches claude_pending_items.
 *
 * deep walks the whole window instead of stopping at the first conversation
 * already ingested — the only way to reach a conversation that saved late.
 *
 * v1.0 — 2026-09-14 (sql/112).
 * v1.1 — 2026-09-15: deep sweep.
 */

import { runOmiPull, getOmiPullStatus, PULL_KINDS } from '../jobs/omi-pull.js';

export const OMI_PULL_PATH = '/admin/omi/pull';
export const OMI_PULL_STATUS_PATH = '/admin/omi/pull/status';

export function registerOmiPullRoutes(app, authenticate, deps = {}) {
  const guard = typeof authenticate === 'function' ? [authenticate] : [];

  app.post(OMI_PULL_PATH, ...guard, async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const kinds = Array.isArray(body.kinds)
        ? body.kinds.filter((k) => PULL_KINDS.includes(k))
        : null;
      if (Array.isArray(body.kinds) && !kinds.length) {
        return res.status(400).json({
          error: 'kinds must be a subset of ' + PULL_KINDS.join(', '),
        });
      }
      const result = await runOmiPull({
        dry_run: body.dry_run === true,
        // deep skips the stop-at-first-known break so a conversation that saved
        // late — and therefore sits below everything already ingested — is still
        // reached. Safe to run any time: the checkpoint key makes a re-read a
        // no-op. This is the manual form of the nightly catch-up.
        deep: body.deep === true,
        kinds,
        deps: deps.pullDeps || {},
      });
      // A run that hit errors still returns 200 with ok:false. The run happened;
      // reporting it as a transport failure would hide which step failed.
      return res.json(result);
    } catch (err) {
      console.error(`[OmiPull] route failed: ${err.message}`);
      return res.status(500).json({ error: 'omi pull failed', detail: err.message });
    }
  });

  app.get(OMI_PULL_STATUS_PATH, ...guard, async (_req, res) => {
    try {
      return res.json(await getOmiPullStatus(deps.statusDeps || {}));
    } catch (err) {
      return res.status(500).json({ error: 'omi pull status failed', detail: err.message });
    }
  });
}

export default { registerOmiPullRoutes, OMI_PULL_PATH, OMI_PULL_STATUS_PATH };
