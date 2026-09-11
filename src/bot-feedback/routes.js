/**
 * Bot Review — REST routes — src/bot-feedback/routes.js
 *
 * v1.0 — 2026-09-11. BOT REVIEW PHASE 0.
 *   Two endpoints:
 *     GET  /api/bot-feedback/health        — coverage counts, flag modes, table presence
 *     POST /api/bot-feedback/jobs/outcomes — n8n calls this every 30 min
 *
 * Both sit behind the existing bearer middleware (`authenticate`, Bearer
 * MCP_AUTH_TOKEN), the same way routes/admin-memory.js does. Every response is
 * `{ ok, data | error }` (handoff §5).
 *
 * Phase 0 has no mutating endpoint that changes bot behavior, so the
 * `x-actor-email` + permission re-check contract in §5 does not bite yet;
 * /jobs/outcomes is a machine job and writes only bot_outcomes. Phase 1's
 * feedback endpoints are the first to need it.
 */

import supabase from '../supabase.js';
import { syncOutcomes } from './outcomes.js';
import { getFingerprintMode, getJudgePersistMode, isMissingRelation } from './fingerprint-core.js';

/**
 * Count rows. Returns null when the relation is absent (sql/103 not applied) or
 * unreadable — the caller renders null as "table not present", which is exactly
 * what Mark needs to see from /health before applying the SQL.
 */
async function safeCount(table, apply = (q) => q) {
  if (!supabase) return null;
  try {
    const { count, error } = await apply(supabase.from(table).select('*', { count: 'exact', head: true }));
    if (error) {
      if (!isMissingRelation(error)) console.warn(`[BotFeedback] count(${table}) failed: ${error.message}`);
      return null;
    }
    return count ?? 0;
  } catch (err) {
    console.warn(`[BotFeedback] count(${table}) threw: ${err.message}`);
    return null;
  }
}

/**
 * Coverage: sends in the last 48h that have NO fingerprint. These are the
 * three numbers the Phase 0 acceptance check (handoff §12) requires to be 0.
 * Computed here so Mark can read them from the endpoint instead of the SQL
 * editor, and so a monitor can watch them.
 */
async function coverage() {
  if (!supabase) return null;
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const refsFor = async (type) => {
    const { data, error } = await supabase
      .from('bot_message_context')
      .select('message_ref')
      .eq('message_type', type)
      .gte('generated_at', since);
    if (error) return null;
    return new Set((data ?? []).map((r) => r.message_ref));
  };

  const [replyRefs, skipRefs, nurtureRefs] = await Promise.all([refsFor('reply'), refsFor('skip'), refsFor('nurture')]);
  if (replyRefs === null || skipRefs === null || nurtureRefs === null) return null;

  const actionsFor = async (status) => {
    const { data, error } = await supabase
      .from('agent_actions')
      .select('id')
      .eq('action_type', 'send_message')
      .eq('status', status)
      .gte('created_at', since);
    return error ? null : (data ?? []).map((r) => String(r.id));
  };

  const [completed, skipped] = await Promise.all([actionsFor('completed'), actionsFor('skipped')]);

  const { data: nurtures } = await supabase
    .from('agentic_messages')
    .select('id')
    .gte('generated_at', since);

  return {
    window_hours: 48,
    replies_missing: completed === null ? null : completed.filter((id) => !replyRefs.has(id)).length,
    skips_missing: skipped === null ? null : skipped.filter((id) => !skipRefs.has(id)).length,
    nurture_missing: (nurtures ?? []).filter((r) => !nurtureRefs.has(String(r.id))).length,
    replies_total: completed?.length ?? null,
    skips_total: skipped?.length ?? null,
    nurture_total: nurtures?.length ?? null,
  };
}

export function registerBotFeedbackRoutes(app, authenticate) {
  const guards = typeof authenticate === 'function' ? [authenticate] : [];

  // ── GET /api/bot-feedback/health ─────────────────────────────────
  app.get('/api/bot-feedback/health', ...guards, async (_req, res) => {
    try {
      const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

      const [contexts48h, contextsTotal, outcomesTotal, outcomesFinal, scores48h, cov] = await Promise.all([
        safeCount('bot_message_context', (q) => q.gte('generated_at', since48h)),
        safeCount('bot_message_context'),
        safeCount('bot_outcomes'),
        safeCount('bot_outcomes', (q) => q.eq('final', true)),
        safeCount('message_scores', (q) => q.gte('created_at', since48h)),
        coverage(),
      ]);

      return res.json({
        ok: true,
        data: {
          flags: {
            BOT_FINGERPRINT_MODE: getFingerprintMode(),
            BOT_JUDGE_PERSIST: getJudgePersistMode(),
          },
          tables: {
            bot_message_context: contextsTotal !== null,
            bot_outcomes: outcomesTotal !== null,
            message_scores: scores48h !== null,
          },
          counts: {
            contexts_48h: contexts48h,
            contexts_total: contextsTotal,
            outcomes_total: outcomesTotal,
            outcomes_final: outcomesFinal,
            message_scores_48h: scores48h,
          },
          coverage: cov,
          checked_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      console.error(`[BotFeedback] /health threw: ${err.message}`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /api/bot-feedback/jobs/outcomes ─────────────────────────
  app.post('/api/bot-feedback/jobs/outcomes', ...guards, async (_req, res) => {
    try {
      const summary = await syncOutcomes();
      // A skip (no HL credentials, tables absent) is a 200 with ok:false — the
      // n8n cron should not go red for a condition Mark has to fix by hand.
      return res.json({ ok: summary.ok !== false, data: summary });
    } catch (err) {
      console.error(`[BotFeedback] /jobs/outcomes threw: ${err.message}`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  console.log(
    '[BotFeedback] Routes: GET /api/bot-feedback/health | POST /api/bot-feedback/jobs/outcomes' +
    `${guards.length ? ' (authenticated)' : ' (UNAUTHENTICATED — no middleware passed)'}`,
  );
}

export default { registerBotFeedbackRoutes };
