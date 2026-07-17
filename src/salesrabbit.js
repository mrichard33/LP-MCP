/**
 * SalesRabbit client — src/salesrabbit.js
 *
 * First server-side SalesRabbit integration. Replaces the I.CC inline
 * Custom Webhook whose API token sat in plaintext workflow JSON (that
 * token must be rotated at cutover; the replacement lives in the
 * SALESRABBIT_API_TOKEN Railway env var).
 *
 * Request shape mirrors the live I.CC webhook step (captured 2026-07-15):
 * PUT https://api.salesrabbit.com/leads/{id} with a { data: {...} }
 * envelope. propertyType is deliberately omitted (dropped from the v2
 * form in pilot v1.3; the SalesRabbit field tolerates empty).
 *
 * Never throws — canvassing intake must not fail because SalesRabbit is
 * down. Callers get { ok, status?, reason? } and decide how loudly to log.
 */

const SALESRABBIT_BASE_URL = process.env.SALESRABBIT_BASE_URL || 'https://api.salesrabbit.com';

/**
 * Mark a SalesRabbit lead "Appointment Set" and sync the door-captured
 * counts/spouse custom fields.
 *
 * @param {string|number} salesrabbitId — SalesRabbit lead ID
 * @param {object} fields
 * @param {string} [fields.windowCount]
 * @param {string} [fields.doorCount]
 * @param {string} [fields.sliderCount]
 * @param {string} [fields.spouseName]
 * @param {string} [fields.proId] — included as customFields.proID only when present
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] — injectable fetch for tests
 * @param {string} [opts.token] — defaults to SALESRABBIT_API_TOKEN
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok: boolean, status?: number, reason?: string}>}
 */
export async function updateSalesRabbitLead(salesrabbitId, fields = {}, opts = {}) {
  const {
    fetchImpl = fetch,
    token = process.env.SALESRABBIT_API_TOKEN,
    timeoutMs = 10000,
  } = opts;

  if (!salesrabbitId) return { ok: false, reason: 'no_salesrabbit_id' };
  if (!token) {
    console.warn('[SalesRabbit] SALESRABBIT_API_TOKEN unset — skipping lead update (log-only)');
    return { ok: false, reason: 'no_token' };
  }

  const { windowCount, doorCount, sliderCount, spouseName, proId } = fields;
  const body = {
    data: {
      status: 'Appointment Set',
      customFields: {
        windowCount: windowCount ?? '',
        doorCount: doorCount ?? '',
        sliderCount: sliderCount ?? '',
        spouseName: spouseName ?? '',
        ...(proId ? { proID: String(proId) } : {}),
      },
    },
  };

  try {
    const res = await fetchImpl(`${SALESRABBIT_BASE_URL}/leads/${encodeURIComponent(String(salesrabbitId))}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[SalesRabbit] PUT leads/${salesrabbitId} failed: ${res.status} ${text.slice(0, 200)}`);
      return { ok: false, status: res.status, reason: `http_${res.status}` };
    }

    console.log(`[SalesRabbit] lead ${salesrabbitId} → Appointment Set (counts synced)`);
    return { ok: true, status: res.status };
  } catch (err) {
    console.warn(`[SalesRabbit] PUT leads/${salesrabbitId} error: ${err.message}`);
    return { ok: false, reason: err.message };
  }
}
