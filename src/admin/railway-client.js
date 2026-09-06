// ─── Railway GraphQL API Client — src/admin/railway-client.js ─────
//
// Wrapper for Railway's GraphQL API (backboard.railway.app).
// Requires RAILWAY_API_TOKEN env var scoped to the Reece project.

const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';

// Railway's API stalls intermittently. Without a timeout a stalled request
// hangs the MCP tool call forever and the caller sees a bare "Failed" with
// no error text. Bound it so a stall becomes a readable error instead.
const TIMEOUT_MS = Number(process.env.RAILWAY_API_TIMEOUT_MS) || 20000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const attempt = async (query, variables) => {
  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) throw new Error('RAILWAY_API_TOKEN not configured');

  let res;
  try {
    res = await fetch(RAILWAY_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = err?.name || '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      const e = new Error(`Railway API did not respond within ${TIMEOUT_MS}ms (backboard.railway.app may be degraded).`);
      e.retryable = true;
      throw e;
    }
    const e = new Error(`Railway API request failed: ${err?.message || String(err)}`);
    e.retryable = true;
    throw e;
  }

  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 500);
    const e = new Error(`Railway API ${res.status}: ${text || res.statusText}`);
    e.retryable = res.status >= 500 || res.status === 429;
    throw e;
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('Railway API returned a non-JSON response.');
  }

  if (data.errors?.length) {
    throw new Error(`Railway GQL: ${data.errors.map((e) => e.message).join('; ')}`);
  }

  return data.data;
};

export const railwayQuery = async (query, variables = {}) => {
  try {
    return await attempt(query, variables);
  } catch (err) {
    if (!err?.retryable) throw err;
    await sleep(1000);
    return await attempt(query, variables);
  }
};

export const getServiceId = () => {
  const id = process.env.RAILWAY_SERVICE_ID;
  if (!id) throw new Error('RAILWAY_SERVICE_ID not configured');
  return id;
};
