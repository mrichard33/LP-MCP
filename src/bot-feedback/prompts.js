/**
 * Prompt editor — service — src/bot-feedback/prompts.js
 *
 * v1.0 — 2026-09-11. BOT REVIEW — PROMPT EDITOR.
 *
 * The write surface for the live nurture prompts. The dashboard never touches
 * agentic_messaging_prompts itself — same rule as feedback.js — so the
 * permission re-check and the change log cannot be skipped by a client that
 * forgets them.
 *
 * WHAT MAKES THIS DIFFERENT FROM EVERY OTHER WRITE IN THIS SERVER.
 *   nurture-prompt-selector.js reads this table LIVE on every generation:
 *     .from('agentic_messaging_prompts').select('*').eq('active', true)
 *   No cache, no restart. An UPDATE here is in front of a customer on the next
 *   nurture send. So:
 *     · Editing writes to agentic_messaging_prompt_drafts (sql/107), never to
 *       the live row. Drafts are invisible to the selector by construction.
 *     · Only activate() touches the live row, and only after the MERGED row
 *       passes validateActivation() — stricter than the table's CHECKs.
 *     · Every live change writes bot_change_log with before AND after, so
 *       rollback() has something real to restore rather than a guess.
 *
 * Every mutating call:
 *   · requires an `x-actor-email` header
 *   · RE-CHECKS permission server-side via resolveActor(). The dashboard's own
 *     gate is a courtesy; this is the gate.
 *   · returns { ok, data | error, status }
 *
 * Degrades on a missing relation (sql/107 not applied) with a clear message
 * rather than a 500 — the dashboard renders "needs migration".
 */

import supabase from '../supabase.js';
import { isMissingRelation } from './fingerprint-core.js';
import { resolveActor, logChange } from './feedback.js';
import {
  EDITABLE_COLUMNS,
  NON_EDITABLE_COLUMNS,
  validateDraftPatch,
  validateActivation,
  mergeDraft,
  diffFields,
  canViewPrompts,
  canEditPrompts,
} from './prompts-core.js';

const LIVE_TABLE = 'agentic_messaging_prompts';
const DRAFT_TABLE = 'agentic_messaging_prompt_drafts';

/** Columns the list view needs — never the prompt bodies, which are large. */
const SUMMARY_COLUMNS =
  'id, prompt_code, workflow_code, channel, sequence_position, buyer_stage_target, ' +
  'story_arc, active, version, variant_label, variant_weight, updated_at';

const NOT_MIGRATED =
  'The prompt editor is not migrated yet — apply sql/107_prompt_drafts.sql in the LP Supabase SQL editor.';

function fail(error, status = 400, field = null) {
  return field ? { ok: false, error, status, field } : { ok: false, error, status };
}

/** Resolve the caller and check they may at least look. */
async function gate(actorEmail, { write }) {
  const who = await resolveActor(actorEmail);
  if (!who.ok) return fail(who.error, 401);
  const actor = who.actor;

  if (!canViewPrompts(actor)) {
    return fail('You do not have access to the bot prompts.', 403);
  }
  if (write && !canEditPrompts(actor)) {
    return fail(
      'Editing the live bot prompts is limited to operators — these changes reach customers on the next message.',
      403,
    );
  }
  return { ok: true, actor };
}

/** One live prompt by id, every column. */
async function readLive(id) {
  const { data, error } = await supabase
    .from(LIVE_TABLE)
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) return { error };
  return { row: data ?? null };
}

/** The open draft for a prompt, or null. */
async function readDraft(id) {
  const { data, error } = await supabase
    .from(DRAFT_TABLE)
    .select('*')
    .eq('prompt_id', id)
    .maybeSingle();
  if (error) return { error };
  return { row: data ?? null };
}

// ═══════════════════════════════════════════════════════════════════
// GET /api/bot-feedback/prompts
// ═══════════════════════════════════════════════════════════════════
export async function listPrompts(actorEmail) {
  const g = await gate(actorEmail, { write: false });
  if (!g.ok) return g;

  const { data, error } = await supabase
    .from(LIVE_TABLE)
    .select(SUMMARY_COLUMNS)
    .order('workflow_code', { ascending: true })
    .order('sequence_position', { ascending: true, nullsFirst: true });

  if (error) {
    if (isMissingRelation(error)) {
      return fail('The prompt registry is missing — apply sql/agentic_messaging_prompts.sql.', 503);
    }
    return fail(error.message, 500);
  }

  /*
   * Which prompts have an unsaved draft, in ONE query rather than one per row.
   * A missing drafts table is not an error here: the list is still useful
   * read-only before sql/107 is applied, and `needsMigration` tells the UI to
   * explain that rather than to hide the page.
   */
  let draftsByPrompt = new Map();
  let needsMigration = false;
  const drafts = await supabase.from(DRAFT_TABLE).select('prompt_id, updated_at, updated_by, created_by');
  if (drafts.error) {
    if (isMissingRelation(drafts.error)) needsMigration = true;
    else return fail(drafts.error.message, 500);
  } else {
    draftsByPrompt = new Map((drafts.data ?? []).map((d) => [d.prompt_id, d]));
  }

  const rows = (data ?? []).map((p) => {
    const d = draftsByPrompt.get(p.id) ?? null;
    return {
      ...p,
      has_draft: d != null,
      draft_updated_at: d?.updated_at ?? null,
      draft_updated_by: d?.updated_by ?? d?.created_by ?? null,
      // Live / Draft / Off — the three states the list badges.
      state: p.active ? 'live' : 'off',
    };
  });

  return { ok: true, data: { prompts: rows, needsMigration, canEdit: canEditPrompts(g.actor) } };
}

// ═══════════════════════════════════════════════════════════════════
// GET /api/bot-feedback/prompts/:id
// ═══════════════════════════════════════════════════════════════════
export async function getPrompt(actorEmail, id) {
  const g = await gate(actorEmail, { write: false });
  if (!g.ok) return g;

  const live = await readLive(id);
  if (live.error) {
    if (isMissingRelation(live.error)) return fail(NOT_MIGRATED, 503);
    return fail(live.error.message, 500);
  }
  if (!live.row) return fail('That prompt does not exist.', 404);

  const draft = await readDraft(id);
  if (draft.error && !isMissingRelation(draft.error)) {
    return fail(draft.error.message, 500);
  }
  const needsMigration = Boolean(draft.error && isMissingRelation(draft.error));

  // History comes from the append-only change log — the same table the rest of
  // Bot Review writes to. `before` is what rollback() restores.
  const { data: history } = await supabase
    .from('bot_change_log')
    .select('id, at, actor, action, reason, before, after')
    .eq('target_table', LIVE_TABLE)
    .eq('target_id', String(id))
    .order('at', { ascending: false })
    .limit(50);

  const patch = draft.row?.fields ?? null;

  return {
    ok: true,
    data: {
      prompt: live.row,
      draft: draft.row
        ? {
            fields: patch,
            note: draft.row.note,
            updated_at: draft.row.updated_at,
            updated_by: draft.row.updated_by ?? draft.row.created_by,
          }
        : null,
      // What Activate would change, so the UI can show it without recomputing
      // the rules the server will apply anyway.
      changes: patch ? diffFields(live.row, patch) : [],
      history: history ?? [],
      editable: EDITABLE_COLUMNS,
      locked: NON_EDITABLE_COLUMNS,
      canEdit: canEditPrompts(g.actor),
      needsMigration,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// POST /api/bot-feedback/prompts/:id/draft
// ═══════════════════════════════════════════════════════════════════
export async function saveDraft(actorEmail, id, body = {}) {
  const g = await gate(actorEmail, { write: true });
  if (!g.ok) return g;
  const actor = g.actor;

  const v = validateDraftPatch(body.fields);
  if (!v.ok) return fail(v.error, 400, v.field);

  const live = await readLive(id);
  if (live.error) {
    if (isMissingRelation(live.error)) return fail(NOT_MIGRATED, 503);
    return fail(live.error.message, 500);
  }
  if (!live.row) return fail('That prompt does not exist.', 404);

  const note = typeof body.note === 'string' ? body.note : null;

  /*
   * Upsert on prompt_id — the UNIQUE constraint from sql/107 makes this
   * "update the open draft, or open one". Two operators editing the same
   * prompt therefore share one draft rather than silently forking it; the
   * second save wins and updated_by records who.
   */
  const { data, error } = await supabase
    .from(DRAFT_TABLE)
    .upsert(
      {
        prompt_id: id,
        fields: v.value,
        note,
        created_by: actor.email,
        updated_by: actor.email,
      },
      { onConflict: 'prompt_id' },
    )
    .select('id, fields, note, updated_at, updated_by')
    .maybeSingle();

  if (error) {
    if (isMissingRelation(error)) return fail(NOT_MIGRATED, 503);
    return fail(error.message, 500);
  }

  /*
   * Deliberately NOT logged to bot_change_log. That log is the record of what
   * reached customers; a draft by definition has not. Logging saves would bury
   * the promoted_live entries that rollback depends on finding.
   */
  return {
    ok: true,
    data: {
      draft: data,
      changes: diffFields(live.row, v.value),
      live: false,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// POST /api/bot-feedback/prompts/:id/activate
// ═══════════════════════════════════════════════════════════════════
export async function activatePrompt(actorEmail, id, body = {}) {
  const g = await gate(actorEmail, { write: true });
  if (!g.ok) return g;
  const actor = g.actor;

  const live = await readLive(id);
  if (live.error) {
    if (isMissingRelation(live.error)) return fail(NOT_MIGRATED, 503);
    return fail(live.error.message, 500);
  }
  if (!live.row) return fail('That prompt does not exist.', 404);

  const draft = await readDraft(id);
  if (draft.error) {
    if (isMissingRelation(draft.error)) return fail(NOT_MIGRATED, 503);
    return fail(draft.error.message, 500);
  }
  if (!draft.row) return fail('There is no draft to activate for this prompt.', 404);

  const patch = draft.row.fields ?? {};
  const changes = diffFields(live.row, patch);
  if (changes.length === 0) {
    return fail('This draft is identical to what is already live.', 400);
  }

  // The merged row is what customers get — validate THAT, not just the patch.
  const merged = mergeDraft(live.row, patch);
  const v = validateActivation(merged);
  if (!v.ok) return fail(v.error, 400, v.field);

  const nextVersion = (live.row.version ?? 1) + 1;
  const update = {};
  for (const { field, to } of changes) update[field] = to;
  update.version = nextVersion;
  update.updated_at = new Date().toISOString();

  const { data: after, error } = await supabase
    .from(LIVE_TABLE)
    .update(update)
    .eq('id', id)
    // Optimistic concurrency: if someone else activated while this draft was
    // open, the version has moved and this matches nothing rather than
    // overwriting their change.
    .eq('version', live.row.version ?? 1)
    .select('*')
    .maybeSingle();

  if (error) return fail(error.message, 500);
  if (!after) {
    return fail(
      'Someone else changed this prompt while your draft was open. Reload to see their version before activating yours.',
      409,
    );
  }

  /*
   * `before` is the full live row as it was. rollback() re-applies it, so it
   * has to be the whole row and not just the changed keys — a later rollback
   * must not depend on what the row happens to look like then.
   */
  await logChange({
    actor: actor.email,
    action: 'promoted_live',
    targetTable: LIVE_TABLE,
    targetId: id,
    reason: typeof body.note === 'string' && body.note ? body.note : draft.row.note ?? null,
    before: live.row,
    after,
  });

  // The draft has served its purpose; leaving it would show as a pending change
  // that is already live.
  const { error: delError } = await supabase.from(DRAFT_TABLE).delete().eq('prompt_id', id);
  if (delError) {
    console.warn(`[Prompts] draft cleanup after activate failed: ${delError.message}`);
  }

  return { ok: true, data: { prompt: after, version: nextVersion, changed: changes.map((c) => c.field) } };
}

// ═══════════════════════════════════════════════════════════════════
// POST /api/bot-feedback/prompts/:id/rollback
// ═══════════════════════════════════════════════════════════════════
export async function rollbackPrompt(actorEmail, id, body = {}) {
  const g = await gate(actorEmail, { write: true });
  if (!g.ok) return g;
  const actor = g.actor;

  const logId = body.log_id;
  if (logId == null) return fail('Which change should be rolled back?', 400, 'log_id');

  const { data: entry, error: logError } = await supabase
    .from('bot_change_log')
    .select('id, at, actor, action, target_id, before')
    .eq('id', logId)
    .eq('target_table', LIVE_TABLE)
    .eq('target_id', String(id))
    .maybeSingle();

  if (logError) return fail(logError.message, 500);
  if (!entry) return fail("That change is not in this prompt's history.", 404);
  if (!entry.before || typeof entry.before !== 'object') {
    return fail('That history entry has no previous version recorded, so it cannot be rolled back.', 400);
  }

  const live = await readLive(id);
  if (live.error) return fail(live.error.message, 500);
  if (!live.row) return fail('That prompt does not exist.', 404);

  // Restore only the editable columns. The stored `before` is a whole row, and
  // writing its id/created_at/version back would rewrite history rather than
  // undo a change.
  const restore = {};
  for (const col of EDITABLE_COLUMNS) {
    if (col in entry.before) restore[col] = entry.before[col];
  }
  if (Object.keys(restore).length === 0) {
    return fail('That change did not touch anything that can be restored.', 400);
  }

  const merged = mergeDraft(live.row, restore);
  const v = validateActivation(merged);
  if (!v.ok) {
    return fail(`That version cannot go live as-is: ${v.error}`, 400, v.field);
  }

  restore.version = (live.row.version ?? 1) + 1;
  restore.updated_at = new Date().toISOString();

  const { data: after, error } = await supabase
    .from(LIVE_TABLE)
    .update(restore)
    .eq('id', id)
    .eq('version', live.row.version ?? 1)
    .select('*')
    .maybeSingle();

  if (error) return fail(error.message, 500);
  if (!after) {
    return fail('Someone else changed this prompt just now. Reload and try again.', 409);
  }

  await logChange({
    actor: actor.email,
    action: 'rolled_back',
    targetTable: LIVE_TABLE,
    targetId: id,
    reason: `Rolled back to the version before change #${entry.id} (${entry.actor}, ${entry.at}).`,
    before: live.row,
    after,
  });

  return { ok: true, data: { prompt: after, version: restore.version } };
}

// ═══════════════════════════════════════════════════════════════════
// POST /api/bot-feedback/prompts/:id/toggle
// ═══════════════════════════════════════════════════════════════════
export async function togglePrompt(actorEmail, id, body = {}) {
  const g = await gate(actorEmail, { write: true });
  if (!g.ok) return g;
  const actor = g.actor;

  if (typeof body.active !== 'boolean') {
    return fail('Say whether the prompt should be on or off.', 400, 'active');
  }

  const live = await readLive(id);
  if (live.error) return fail(live.error.message, 500);
  if (!live.row) return fail('That prompt does not exist.', 404);
  if (live.row.active === body.active) {
    return fail(`That prompt is already ${body.active ? 'on' : 'off'}.`, 400);
  }

  /*
   * Turning a prompt ON puts it in front of customers immediately, so it has
   * to clear the same bar as Activate. Turning one OFF is always allowed — a
   * kill switch that could be refused by a validation rule would be useless in
   * exactly the moment it is needed.
   */
  if (body.active) {
    const v = validateActivation(live.row);
    if (!v.ok) return fail(`This prompt cannot be turned on: ${v.error}`, 400, v.field);
  }

  const { data: after, error } = await supabase
    .from(LIVE_TABLE)
    .update({ active: body.active, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .maybeSingle();

  if (error) return fail(error.message, 500);

  await logChange({
    actor: actor.email,
    action: body.active ? 'promoted_live' : 'retired',
    targetTable: LIVE_TABLE,
    targetId: id,
    reason: typeof body.reason === 'string' ? body.reason : null,
    before: live.row,
    after,
  });

  return { ok: true, data: { prompt: after } };
}

// ═══════════════════════════════════════════════════════════════════
// DELETE /api/bot-feedback/prompts/:id/draft
// ═══════════════════════════════════════════════════════════════════
export async function discardDraft(actorEmail, id) {
  const g = await gate(actorEmail, { write: true });
  if (!g.ok) return g;

  const { error } = await supabase.from(DRAFT_TABLE).delete().eq('prompt_id', id);
  if (error) {
    if (isMissingRelation(error)) return fail(NOT_MIGRATED, 503);
    return fail(error.message, 500);
  }
  return { ok: true, data: { discarded: true } };
}
