/**
 * auth — the standard operator bearer-token middleware.
 *
 * Moved out of src/index.js unchanged (2026-09-23) so a route module can be
 * tested against the REAL check rather than a stand-in. index.js builds the
 * one instance every authenticated route uses; behaviour is identical:
 *
 *   - no MCP_AUTH_TOKEN configured → open (local dev)
 *   - `Authorization: Bearer <token>` → allowed
 *   - AUTH_SOFT_LAUNCH=true → logged and allowed ("would reject")
 *   - otherwise → 401
 *
 * @param {{ token?: string|null, softLaunch?: boolean, log?: (msg: string) => void }} opts
 * @returns {(req, res, next) => void}
 */
export function makeAuthenticate({ token = null, softLaunch = false, log = (m) => console.warn(m) } = {}) {
  return function authenticate(req, res, next) {
    if (!token) return next();

    const authHeader = req.headers.authorization;
    if (authHeader === `Bearer ${token}`) return next();

    if (softLaunch) {
      log(`[Auth] SOFT_LAUNCH: unauthenticated ${req.method} ${req.path} from ${req.ip} ua="${req.headers['user-agent'] || 'none'}" — would reject in enforce mode`);
      return next();
    }

    return res.status(401).json({ error: 'Unauthorized' });
  };
}

/**
 * Fail-closed stand-in for a route module that was registered without an
 * auth middleware. A route that spends money or rewrites data must never go
 * open because a caller forgot to pass one.
 */
export function denyAll(_req, res) {
  return res.status(401).json({ error: 'Unauthorized' });
}
