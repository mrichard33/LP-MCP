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
// v1.1 (Phase 1) — the human-review write surface.
// v1.2 (Increment 2) — retraction, dismissals, the Completed list.
import {
  submitFeedback, undoFeedback, editFeedback, stopBot, calibrationNext,
  retractFeedback, dismissReview, undoDismissal, listCompleted,
} from './feedback.js';
import {
  listPrompts, getPrompt, saveDraft, activatePrompt,
  rollbackPrompt, togglePrompt, discardDraft,
} from './prompts.js';

/**
 * Count rows. Returns null when the relation is absent (sql/103 not applied) or
 * unreadable — the caller renders null as "table not present", which is exactly
 * what Mark needs to see from /health before applying the SQL.
 *
 * 2026-09-11 (same-day fix) — this used `head: true`, which reported a MISSING
 * table as present. A HEAD request carries no response body, so PostgREST's JSON
 * error for an unknown relation had nothing to travel in: supabase-js returned
 * `{ count: null, error: null }`, `count ?? 0` made that a 0, and /health said
 * `bot_message_context: true` while the table did not exist. Caught against
 * production the moment the endpoint went live — `tables` said true while
 * `coverage` (which uses an ordinary select, so it DOES see the error) said
 * null. The two disagreeing was the tell.
 *
 * Two changes, either of which alone would fix it, kept together because this
 * function's whole job is to answer "is the table there?" honestly:
 *   1. `.limit(1)` instead of `head: true` — a real body, so a real parsed
 *      error. Costs at most one row.
 *   2. a null count is null, never 0 — absence and emptiness are different
 *      answers and must never collapse into each other.
 */
export async function safeCount(table, apply = (q) => q) {
  if (!supabase) return null;
  try {
    const { count, error } = await apply(
      supabase.from(table).select('*', { count: 'exact' }).limit(1),
    );
    if (error) {
      if (!isMissingRelation(error)) console.warn(`[BotFeedback] count(${table}) failed: ${error.message}`);
      return null;
    }
    return typeof count === 'number' ? count : null;
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

  // ══ Phase 1 — human review (handoff §5.2) ════════════════════════
  //
  // Every one of these re-checks the actor server-side from the
  // `x-actor-email` header against dashboard_users + executives. The dashboard
  // hiding a button is the courtesy; resolveActor() is the gate.
  //
  // `send` maps a service result onto the wire: the service owns the status
  // code, so a 403 stays a 403 and the UI can tell "not allowed" from "broke".
  const send = (res, out) => {
    const status = out.ok ? 200 : (out.status || 500);
    const payload = out.ok
      ? { ok: true, data: out.data }
      : { ok: false, error: out.error, ...(out.field ? { field: out.field } : {}) };
    return res.status(status).json(payload);
  };
  const actorOf = (req) => req.get('x-actor-email') || req.headers['x-actor-email'] || '';

  app.post('/api/bot-feedback/feedback', ...guards, async (req, res) => {
    try {
      return send(res, await submitFeedback(actorOf(req), req.body || {}));
    } catch (err) {
      console.error(`[BotFeedback] POST /feedback threw: ${err.message}`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/bot-feedback/feedback/:id/undo', ...guards, async (req, res) => {
    try {
      return send(res, await undoFeedback(actorOf(req), req.params.id));
    } catch (err) {
      console.error(`[BotFeedback] POST /feedback/:id/undo threw: ${err.message}`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/bot-feedback/feedback/:id/edit', ...guards, async (req, res) => {
    try {
      return send(res, await editFeedback(actorOf(req), req.params.id, req.body || {}));
    } catch (err) {
      console.error(`[BotFeedback] POST /feedback/:id/edit threw: ${err.message}`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/bot-feedback/lead/:contactId/stop-bot', ...guards, async (req, res) => {
    try {
      return send(res, await stopBot(actorOf(req), req.params.contactId, (req.body || {}).reason));
    } catch (err) {
      console.error(`[BotFeedback] POST /lead/:contactId/stop-bot threw: ${err.message}`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/bot-feedback/calibration/next', ...guards, async (req, res) => {
    try {
      return send(res, await calibrationNext(actorOf(req)));
    } catch (err) {
      console.error(`[BotFeedback] GET /calibration/next threw: ${err.message}`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ══ Increment 2 — retraction, dismissals, Completed (handoff §5) ══
  //
  // Same contract as everything above it: x-actor-email, a server-side
  // permission re-check inside the service, a bot_change_log row on every
  // mutation, and { ok, data | error } on the wire.

  app.post('/api/bot-feedback/feedback/:id/retract', ...guards, async (req, res) => {
    try {
      return send(res, await retractFeedback(actorOf(req), req.params.id, req.body || {}));
    } catch (err) {
      console.error(`[BotFeedback] POST /feedback/:id/retract threw: ${err.message}`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/bot-feedback/dismiss', ...guards, async (req, res) => {
    try {
      return send(res, await dismissReview(actorOf(req), req.body || {}));
    } catch (err) {
      console.error(`[BotFeedback] POST /dismiss threw: ${err.message}`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/bot-feedback/dismiss/:id/undo', ...guards, async (req, res) => {
    try {
      return send(res, await undoDismissal(actorOf(req), req.params.id));
    } catch (err) {
      console.error(`[BotFeedback] POST /dismiss/:id/undo threw: ${err.message}`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/bot-feedback/completed', ...guards, async (req, res) => {
    try {
      return send(res, await listCompleted(actorOf(req), req.query || {}));
    } catch (err) {
      console.error(`[BotFeedback] GET /completed threw: ${err.message}`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ══ Prompt editor — the live nurture prompts ═════════════════════
  //
  // Reads are open to anyone who may see Bot Review; every write is
  // operator-and-above and re-checked in the service. These endpoints are the
  // ONLY way the dashboard touches agentic_messaging_prompts, which the
  // nurture selector reads live on every generation.

  app.get('/api/bot-feedback/prompts', ...guards, async (req, res) => {
    try {
      return send(res, await listPrompts(actorOf(req)));
    } catch (err) {
      console.error(`[BotFeedback] GET /prompts threw: ${err.message}`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/bot-feedback/prompts/:id', ...guards, async (req, res) => {
    try {
      return send(res, await getPrompt(actorOf(req), req.params.id));
    } catch (err) {
      console.error(`[BotFeedback] GET /prompts/:id threw: ${err.message}`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/bot-feedback/prompts/:id/draft', ...guards, async (req, res) => {
    try {
      return send(res, await saveDraft(actorOf(req), req.params.id, req.body || {}));
    } catch (err) {
      console.error(`[BotFeedback] POST /prompts/:id/draft threw: ${err.message}`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.delete('/api/bot-feedback/prompts/:id/draft', ...guards, async (req, res) => {
    try {
      return send(res, await discardDraft(actorOf(req), req.params.id));
    } catch (err) {
      console.error(`[BotFeedback] DELETE /prompts/:id/draft threw: ${err.message}`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/bot-feedback/prompts/:id/activate', ...guards, async (req, res) => {
    try {
      return send(res, await activatePrompt(actorOf(req), req.params.id, req.body || {}));
    } catch (err) {
      console.error(`[BotFeedback] POST /prompts/:id/activate threw: ${err.message}`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/bot-feedback/prompts/:id/rollback', ...guards, async (req, res) => {
    try {
      return send(res, await rollbackPrompt(actorOf(req), req.params.id, req.body || {}));
    } catch (err) {
      console.error(`[BotFeedback] POST /prompts/:id/rollback threw: ${err.message}`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/bot-feedback/prompts/:id/toggle', ...guards, async (req, res) => {
    try {
      return send(res, await togglePrompt(actorOf(req), req.params.id, req.body || {}));
    } catch (err) {
      console.error(`[BotFeedback] POST /prompts/:id/toggle threw: ${err.message}`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  console.log(
    '[BotFeedback] Routes: GET /health | POST /jobs/outcomes | POST /feedback | ' +
    'POST /feedback/:id/undo | POST /feedback/:id/edit | POST /feedback/:id/retract | ' +
    'POST /dismiss | POST /dismiss/:id/undo | GET /completed | ' +
    'POST /lead/:contactId/stop-bot | GET /calibration/next | ' +
    'GET /prompts | GET /prompts/:id | POST+DELETE /prompts/:id/draft | ' +
    'POST /prompts/:id/activate | POST /prompts/:id/rollback | POST /prompts/:id/toggle' +
    `${guards.length ? ' (authenticated)' : ' (UNAUTHENTICATED — no middleware passed)'}`,
  );
}

export default { registerBotFeedbackRoutes, safeCount };
