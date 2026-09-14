/**
 * Omi DB guard — src/memory/omi-db.js
 *
 * The read-only boundary for the Omi path, enforced in CODE rather than in a
 * prompt. Omi hears everything Mark says — including customer names, prices and
 * phone numbers — so the module that processes it must be structurally unable
 * to touch a lead, a contact, a dialer record or a message queue. Two things
 * make that true:
 *
 *   1. src/memory/omi-ingest.js imports no CRM / Five9 / messaging module.
 *      scripts/test-omi-ingest.js fails the build if one ever appears.
 *   2. omi-ingest.js never holds the real Supabase client. It is handed the
 *      proxy below, which allows a named handful of verbs on six memory tables
 *      and throws OmiScopeError on everything else — including a SELECT on
 *      lp_leads, and including an INSERT on claude_decision_log (Omi proposes;
 *      it never decides).
 *
 * The proxy guards the TABLE and the top-level VERB. Chained PostgREST methods
 * (.eq / .limit / .maybeSingle / …) are the ordinary builder — there is nothing
 * to guard there, because the table is already fixed by the time they run.
 *
 * v1.0 — 2026-09-11. Initial (sql/101).
 * v1.1 — 2026-09-14. The pull path (sql/112): claude_omi_sync, the memory
 *        upsert RPC, and the one-column update described above.
 */

export class OmiScopeError extends Error {
  constructor(message) { super(message); this.name = 'OmiScopeError'; }
}

/** The only stored procedures the Omi path may call. */
export const ALLOWED_RPC = Object.freeze([
  'claude_omi_ingest',        // sql/101 — the atomic write for one conversation
  'match_memory_embeddings',  // sql/094 — dedupe + conflict lookups (read-only)
  'claude_omi_memory_upsert', // sql/112 — the atomic write for Omi memories
]);

/**
 * table -> the verbs allowed on it. Deliberately minimal:
 *   claude_session_logs           select    idempotency lookup by checkpoint_key
 *   claude_transcript_ledger      select    idempotency lookup for no-content replays
 *                                 upsert    the 'no_content' disposition row
 *   claude_pending_items          select    exact-text dedupe against open items
 *                                 update    stamp omi_action_item_id ONLY (see below)
 *   claude_memory_validation_log  insert    shadow output + failure records
 *   claude_memory_embeddings      upsert    best-effort embed of the new items
 *   claude_omi_sync               select    where the last pull stopped
 *                                 upsert    where this pull stopped
 * Everything the ingest WRITES to memory goes through rpc('claude_omi_ingest')
 * or rpc('claude_omi_memory_upsert') instead, so there is no insert verb on the
 * session or item tables here.
 *
 * 2026-09-14 (sql/112): claude_pending_items gained `update`, which is a real
 * widening of this boundary and is worth being uncomfortable about. It exists
 * for ONE column — omi_action_item_id, the write-back loop guard. The guard has
 * to be written the instant Omi accepts a task, or the row and the task cannot
 * be told apart afterwards and the two systems push the same to-do at each
 * other forever. The verb guard cannot police WHICH column an update sets, so
 * this is the honest note in its place: src/memory/omi-tasks.js is the only
 * caller, and it sets omi_action_item_id and updated_at. Anything else updating
 * a pending item from the Omi path is a bug, not a feature.
 */
export const ALLOWED_TABLES = Object.freeze({
  claude_session_logs: ['select'],
  claude_transcript_ledger: ['select', 'upsert'],
  claude_pending_items: ['select', 'update'],
  claude_memory_validation_log: ['insert'],
  claude_memory_embeddings: ['upsert'],
  claude_omi_sync: ['select', 'upsert'],
});

function listAllowed() {
  return Object.entries(ALLOWED_TABLES).map(([t, ops]) => `${t}.{${ops.join('|')}}`).join(', ');
}

/**
 * Wrap a Supabase client in the Omi allowlist.
 * @param {object} db  the real client (or a fake, in tests)
 * @returns {{ rpc: Function, from: Function }}
 */
export function guardedDb(db) {
  if (!db) throw new OmiScopeError('omi: no Supabase client configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  return {
    rpc(name, args) {
      if (!ALLOWED_RPC.includes(name)) {
        throw new OmiScopeError(`omi: rpc('${name}') is outside the Omi scope — allowed: ${ALLOWED_RPC.join(', ')}`);
      }
      return db.rpc(name, args);
    },
    from(table) {
      const ops = ALLOWED_TABLES[table];
      if (!ops) {
        throw new OmiScopeError(`omi: table '${table}' is outside the Omi scope — allowed: ${listAllowed()}`);
      }
      const guard = {};
      for (const op of ops) {
        // A fresh builder per call: PostgREST builders are single-use.
        guard[op] = (...args) => db.from(table)[op](...args);
      }
      // Any other verb is a programming error, not a runtime condition — name it.
      return new Proxy(guard, {
        get(target, prop) {
          if (prop in target) return target[prop];
          if (typeof prop === 'symbol') return undefined;
          throw new OmiScopeError(`omi: ${table}.${String(prop)}() is outside the Omi scope — allowed on this table: ${ops.join(', ')}`);
        },
      });
    },
  };
}

export default { guardedDb, OmiScopeError, ALLOWED_RPC, ALLOWED_TABLES };
