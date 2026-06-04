// ─── HTTP Request Admin MCP Tool ─────────────────────────────────
// A generic outbound HTTP client exposed as an MCP tool so the assistant
// can call REST endpoints / webhooks that don't have a dedicated tool yet
// (LP REST, decision-engine reload, GHL API, n8n webhooks, arbitrary JSON).
//
// SCHEMA NOTE (v2): input schema uses ONLY primitive zod types
// (string / number / boolean), matching the other admin tools. An earlier
// version used z.record / z.union / z.array / z.enum, which this MCP SDK
// could not serialize to JSON Schema — that broke the entire tools/list
// response and made ALL tools disappear on reconnect. Object-shaped inputs
// (headers, query) are now passed as JSON strings and parsed in the handler.
//
// SECURITY MODEL
//   • Secrets never travel inline. Credentials are injected server-side via
//     named auth profiles defined in the HTTP_TOOL_PROFILES env var. The tool
//     never reflects the request headers it sent back to the caller.
//   • Mutating methods (POST/PUT/PATCH/DELETE) require confirm:true, mirroring
//     the write-gate convention used by the Railway admin tools.
//   • Private / link-local / metadata targets are blocked by default
//     (override with HTTP_TOOL_ALLOW_PRIVATE=true). Optional strict allowlist
//     via HTTP_TOOL_ALLOWED_HOSTS.
//
// ENV
//   HTTP_TOOL_PROFILES       JSON map of profile name -> { base_url?, headers }.
//     Example:
//     {"ghl":{"base_url":"https://services.leadconnectorhq.com",
//             "headers":{"Authorization":"Bearer pit-xxxx","Version":"2021-07-28"}},
//      "lp":{"headers":{"X-Api-Key":"xxxx"}}}
//   HTTP_TOOL_ALLOWED_HOSTS  Comma-separated hostnames. If set, only these pass.
//   HTTP_TOOL_ALLOW_PRIVATE  "true" to permit private/link-local targets.

import { z } from 'zod';

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_BODY_CHARS = 100_000;
const DEFAULT_TIMEOUT = 30_000;
const MAX_TIMEOUT = 120_000;

function loadProfiles() {
  const raw = process.env.HTTP_TOOL_PROFILES;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Parse a JSON-object string param; throws a clear error on bad JSON.
function parseJsonObject(str, label) {
  if (str === undefined || str === null || str === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(str);
  } catch {
    throw new Error(`${label} must be a valid JSON object string. Received: ${String(str).slice(0, 80)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object (key/value map), not an array or scalar.`);
  }
  return parsed;
}

function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;            // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  if (h === '::1' || h.startsWith('fd') || h.startsWith('fe80')) return true; // IPv6 loopback/ULA/link-local
  return false;
}

function checkHost(urlObj) {
  const allowPrivate = String(process.env.HTTP_TOOL_ALLOW_PRIVATE).toLowerCase() === 'true';
  if (!allowPrivate && isPrivateHost(urlObj.hostname)) {
    throw new Error(
      `Blocked private/link-local host: ${urlObj.hostname}. Set HTTP_TOOL_ALLOW_PRIVATE=true to override.`
    );
  }
  const allow = (process.env.HTTP_TOOL_ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allow.length && !allow.includes(urlObj.hostname.toLowerCase())) {
    throw new Error(`Host ${urlObj.hostname} is not in the HTTP_TOOL_ALLOWED_HOSTS allowlist.`);
  }
}

function fail(message) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }] };
}

export function registerHttpTools(server) {
  // Tool: http_request [READ on GET/HEAD, WRITE on POST/PUT/PATCH/DELETE]
  server.tool(
    'http_request',
    'Make an outbound HTTP request to a REST endpoint or webhook. Use for APIs without a dedicated tool ' +
      '(LP REST, decision-engine reload, GHL API, n8n webhooks, arbitrary JSON). Secrets are injected ' +
      'server-side via auth_profile — never pass tokens inline. Mutating methods (POST/PUT/PATCH/DELETE) ' +
      'require confirm:true.',
    {
      url: z
        .string()
        .describe(
          'Full URL, or a path if auth_profile defines a base_url. ' +
            'Example: "https://lp-mcp-production.up.railway.app/n8n/decision-engine/reload-rules"'
        ),
      method: z
        .string()
        .optional()
        .describe('HTTP method: GET (default), POST, PUT, PATCH, DELETE, or HEAD.'),
      headers_json: z
        .string()
        .optional()
        .describe('Request headers as a JSON object string, e.g. {"Accept":"application/json"}. Do not put secrets here — use auth_profile.'),
      query_json: z
        .string()
        .optional()
        .describe('Query params as a JSON object string, e.g. {"limit":"50"}. Appended to the URL.'),
      body: z
        .string()
        .optional()
        .describe('Raw request body string. For JSON, pass a JSON string and set content_type to "application/json".'),
      content_type: z
        .string()
        .optional()
        .describe('Convenience: sets the Content-Type header (e.g. "application/json"). Overridden by headers_json if both set it.'),
      auth_profile: z
        .string()
        .optional()
        .describe('Named credential profile from HTTP_TOOL_PROFILES env (e.g. "ghl", "lp"). Injects base_url + headers server-side.'),
      timeout_ms: z
        .number()
        .optional()
        .describe('Request timeout in ms (default 30000, max 120000).'),
      confirm: z
        .boolean()
        .optional()
        .describe('Required true for POST/PUT/PATCH/DELETE. Ignored for GET/HEAD.'),
    },
    async ({ url, method, headers_json, query_json, body, content_type, auth_profile, timeout_ms, confirm }) => {
      const m = (method || 'GET').toUpperCase();
      const timeout = Math.min(timeout_ms || DEFAULT_TIMEOUT, MAX_TIMEOUT);

      try {
        if (!ALLOWED_METHODS.has(m)) {
          return fail(`Unsupported method "${m}". Allowed: GET, POST, PUT, PATCH, DELETE, HEAD.`);
        }

        // Write-gate for mutating methods
        if (MUTATING.has(m) && confirm !== true) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    preview: true,
                    method: m,
                    url,
                    auth_profile: auth_profile || null,
                    warning: `${m} is a mutating request. Re-call with confirm: true to execute.`,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // Parse object-shaped inputs (passed as JSON strings)
        const reqHeaders = parseJsonObject(headers_json, 'headers_json');
        const reqQuery = parseJsonObject(query_json, 'query_json');

        // Resolve auth profile
        const profiles = loadProfiles();
        const profile = auth_profile ? profiles[auth_profile] : null;
        if (auth_profile && !profile) {
          return fail(
            `Unknown auth_profile "${auth_profile}". Defined profiles: ${Object.keys(profiles).join(', ') || '(none)'}`
          );
        }

        // Resolve URL — support profile base_url + relative path
        let finalUrl;
        if (profile?.base_url && !/^https?:\/\//i.test(url)) {
          finalUrl = new URL(url.replace(/^\//, ''), profile.base_url.replace(/\/?$/, '/'));
        } else {
          finalUrl = new URL(url);
        }
        for (const [k, v] of Object.entries(reqQuery)) finalUrl.searchParams.append(k, String(v));

        // SSRF / allowlist guard
        checkHost(finalUrl);

        // Headers: profile first, content_type convenience, explicit overrides win
        const hdrs = { ...(profile?.headers || {}) };
        if (content_type) hdrs['Content-Type'] = content_type;
        for (const [k, v] of Object.entries(reqHeaders)) hdrs[k] = String(v);

        // Body (string only; caller pre-serializes JSON)
        let payload;
        if (body !== undefined && body !== '' && m !== 'GET' && m !== 'HEAD') {
          payload = body;
        }

        // Fire with timeout
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        const started = Date.now();
        let res;
        try {
          res = await fetch(finalUrl, { method: m, headers: hdrs, body: payload, signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
        const elapsed = Date.now() - started;

        // Response headers
        const respHeaders = {};
        res.headers.forEach((v, k) => {
          respHeaders[k] = v;
        });

        // Response body (truncated, JSON-parsed when possible)
        let text = await res.text();
        let truncated = false;
        if (text.length > MAX_BODY_CHARS) {
          text = text.slice(0, MAX_BODY_CHARS);
          truncated = true;
        }
        let parsed;
        if ((respHeaders['content-type'] || '').includes('application/json')) {
          try {
            parsed = JSON.parse(text);
          } catch {
            /* fall back to raw text */
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  ok: res.ok,
                  status: res.status,
                  status_text: res.statusText,
                  method: m,
                  url: finalUrl.toString(),
                  elapsed_ms: elapsed,
                  truncated,
                  headers: respHeaders,
                  body: parsed !== undefined ? parsed : text,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        const aborted = err && err.name === 'AbortError';
        return fail(aborted ? `Request timed out after ${timeout}ms` : err.message);
      }
    }
  );
}
