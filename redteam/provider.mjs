/**
 * Promptfoo custom provider → the REAL bots through the simulator
 * (POST /admin/bot-simulate). Nothing is sent to a customer or written to
 * GHL/LP: the simulator records every side effect instead of doing it.
 *
 *   LP_MCP_URL        https://<lp-mcp>.up.railway.app
 *   ADMIN_API_TOKEN   the same value Railway holds (x-admin-token)
 *   RT_CHANNEL        livechat (default) | sms
 *
 * Each test prompt is one customer message; the output is the bot's reply.
 */
const BASE = (process.env.LP_MCP_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.ADMIN_API_TOKEN || '';
const CHANNEL = process.env.RT_CHANNEL || 'livechat';

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN, ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export default class ReeceBotProvider {
  id() { return `reece-bot:${CHANNEL}`; }

  async callApi(prompt) {
    if (!BASE || !TOKEN) return { error: 'set LP_MCP_URL and ADMIN_API_TOKEN' };
    const messages = (() => { try { const j = JSON.parse(prompt); return Array.isArray(j) ? j.map(String) : [String(prompt)]; } catch { return [String(prompt)]; } })();
    const { job_id } = await api('/admin/bot-simulate', {
      method: 'POST',
      body: JSON.stringify({ messages, channel: CHANNEL, title: 'red-team' }),
    });
    const until = Date.now() + 180_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 3000));
      const job = await api(`/admin/bot-simulate/${job_id}`);
      if (job.status === 'running') continue;
      const conv = (job.results || [])[0] || {};
      if (conv.error) return { error: conv.error };
      const turns = conv.transcript || [];
      const last = turns[turns.length - 1] || {};
      const output = Array.isArray(last.bot) ? last.bot.join('\n') : String(last.bot ?? '');
      return { output, metadata: { job_id, outcome: last.outcome } };
    }
    return { error: `simulation ${job_id} did not finish in 180s` };
  }
}
