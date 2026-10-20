/**
 * A small in-memory stand-in for the supabase-js client — scripts/lib/fake-supabase.js
 *
 * Enough of the query builder for the marketing ledger tests: from().select /
 * insert / upsert / update / delete with eq / neq / in / gte / lte / is / not /
 * order / limit / maybeSingle / single, rpc(), and storage.from().upload /
 * createSignedUrl. Thenable like the real builder, so `await` works.
 * Not a general mock: it exists so the ledger's I/O modules run offline.
 */
import { randomUUID } from 'node:crypto';

/** NOT NULL columns mirrored from the migrations, for the tables whose inserts the ledger tests exercise. */
export const NOT_NULL = Object.freeze({
  marketing_expenses: ['amount', 'period_start', 'period_end', 'lp_sub_sources', 'eligible_markets', 'cost_type'],
  marketing_invoice_documents: ['sha256'],
  marketing_invoice_skips: ['sha256', 'reason'],
  // 2026-10-16: supabase/migrations/20261016180000_confirmation_pipeline.sql.
  confirmation_opportunities: ['lp_lead_id', 'ghl_contact_id', 'stage_key', 'last_moved_by'],
  // 2026-10-19: supabase/migrations/20261019200000_revin_contact_messages.sql.
  revin_events_raw: ['payload_hash', 'process_status'],
  contact_messages: ['source', 'channel', 'direction', 'dedupe_key'],
  // 2026-10-20: supabase/migrations/20261020200000_partner_owner_sync.sql.
  partner_owner_log: ['reason'],
  partner_owner_map: ['partner_name', 'lp_branch_id', 'ghl_user_id'],
  // 2026-10-20: supabase/migrations/20261020230000_partner_owner_assignments.sql.
  partner_owner_assignments: ['ghl_contact_id', 'ghl_user_id'],
});

function notNullViolation(table, rows) {
  const cols = NOT_NULL[table];
  if (!cols) return null;
  for (const r of rows) {
    for (const c of cols) {
      if (r[c] === null || r[c] === undefined) return `null value in column "${c}" of relation "${table}" violates not-null constraint`;
    }
  }
  return null;
}

export function fakeSupabase(seed = {}, { rpc = {}, files = {} } = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  const calls = [];
  const storageLog = { uploads: [], signed: [], removed: [] };
  // Stored objects by `bucket/path` (seeded with `files`, kept by upload) so download() can read them back.
  const objects = new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));

  const ensure = (t) => (tables[t] ||= []);

  function exec(q) {
    const rows = ensure(q.table);
    const match = (r) => q.filters.every((f) => f(r));
    let data = null;
    let error = null;
    if (q.op === 'select') {
      let out = rows.filter(match);
      if (q.order) out = [...out].sort((a, b) => (a[q.order[0]] > b[q.order[0]] ? 1 : a[q.order[0]] < b[q.order[0]] ? -1 : 0) * (q.order[1] ? 1 : -1));
      if (q.limit != null) out = out.slice(q.offset || 0, (q.offset || 0) + q.limit);
      data = out.map((r) => ({ ...r }));
    } else if (q.op === 'insert') {
      const list = (Array.isArray(q.payload) ? q.payload : [q.payload]).map((r) => ({ id: randomUUID(), created_at: new Date().toISOString(), ...r }));
      // 2026-10-13: the real database refused amount NULL on marketing_expenses
      // and this fake took it, so the tests were green while production was
      // not. The NOT NULL columns that bit are enforced here, the same way.
      const violated = notNullViolation(q.table, list);
      if (violated) {
        calls.push({ table: q.table, op: q.op, payload: q.payload, count: 0, error: violated });
        return { data: null, error: { message: violated, code: '23502' } };
      }
      rows.push(...list);
      data = list.map((r) => ({ ...r }));
    } else if (q.op === 'upsert') {
      const keys = String(q.onConflict || 'id').split(',').map((s) => s.trim());
      const list = Array.isArray(q.payload) ? q.payload : [q.payload];
      data = [];
      for (const p of list) {
        const found = rows.find((r) => keys.every((k) => r[k] === p[k]));
        if (found) { Object.assign(found, p); data.push({ ...found }); }
        else { const n = { id: randomUUID(), created_at: new Date().toISOString(), ...p }; rows.push(n); data.push({ ...n }); }
      }
    } else if (q.op === 'update') {
      const hit = rows.filter(match);
      for (const r of hit) Object.assign(r, q.payload);
      data = hit.map((r) => ({ ...r }));
    } else if (q.op === 'delete') {
      const keep = rows.filter((r) => !match(r));
      data = rows.filter(match);
      tables[q.table] = keep;
    }
    calls.push({ table: q.table, op: q.op, payload: q.payload, count: Array.isArray(data) ? data.length : 0 });
    if (q.single === 'one') {
      if (!data || data.length !== 1) return { data: null, error: { message: `single() expected 1 row, got ${data?.length ?? 0}` } };
      return { data: data[0], error };
    }
    if (q.single === 'maybe') return { data: data?.[0] ?? null, error };
    return { data, error, count: data?.length ?? 0 };
  }

  function from(table) {
    const q = { table, op: 'select', filters: [], order: null, limit: null, single: null, payload: null, onConflict: null };
    const chain = {
      select() { return chain; },
      insert(p) { q.op = 'insert'; q.payload = p; return chain; },
      upsert(p, o) { q.op = 'upsert'; q.payload = p; q.onConflict = o?.onConflict; return chain; },
      update(p) { q.op = 'update'; q.payload = p; return chain; },
      delete() { q.op = 'delete'; return chain; },
      eq(c, v) { q.filters.push((r) => r[c] === v); return chain; },
      neq(c, v) { q.filters.push((r) => r[c] !== v); return chain; },
      in(c, vs) { q.filters.push((r) => vs.includes(r[c])); return chain; },
      gte(c, v) { q.filters.push((r) => r[c] >= v); return chain; },
      lte(c, v) { q.filters.push((r) => r[c] <= v); return chain; },
      gt(c, v) { q.filters.push((r) => r[c] > v); return chain; },
      lt(c, v) { q.filters.push((r) => r[c] < v); return chain; },
      is(c, v) { q.filters.push((r) => r[c] == v); return chain; },
      not(c, op, v) { q.filters.push((r) => (op === 'is' ? r[c] != v : r[c] !== v)); return chain; },
      like(c, pat) { const rx = new RegExp('^' + String(pat).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$'); q.filters.push((r) => rx.test(String(r[c] ?? ''))); return chain; },
      order(c, o) { q.order = [c, o?.ascending !== false]; return chain; },
      limit(n) { q.limit = n; return chain; },
      // 2026-10-16: range() pages like the real client; not(c, 'is', null) only.
      range(a, b) { q.offset = a; q.limit = b - a + 1; return chain; },
      not(c, op, v) { q.filters.push(op === 'is' ? (r) => r[c] != v : (r) => r[c] !== v); return chain; },
      maybeSingle() { q.single = 'maybe'; return chain; },
      single() { q.single = 'one'; return chain; },
      then(res, rej) { try { return Promise.resolve(exec(q)).then(res, rej); } catch (e) { return Promise.reject(e).then(res, rej); } },
    };
    return chain;
  }

  return {
    tables, calls, storageLog, objects,
    from,
    rpc: async (name, args) => {
      const fn = rpc[name];
      if (!fn) return { data: null, error: { message: `no rpc ${name}` } };
      try { return { data: await fn(args), error: null }; } catch (e) { return { data: null, error: { message: e.message } }; }
    },
    storage: {
      from: (bucket) => ({
        upload: async (path, bytes, opts) => { storageLog.uploads.push({ bucket, path, bytes: bytes.length, body: bytes, opts }); objects.set(`${bucket}/${path}`, Buffer.from(bytes)); return { data: { path }, error: null }; },
        download: async (path) => {
          const b = objects.get(`${bucket}/${path}`);
          return b ? { data: { text: async () => b.toString('utf8') }, error: null } : { data: null, error: { message: 'Object not found' } };
        },
        createSignedUrl: async (path, ttl) => { storageLog.signed.push({ bucket, path, ttl }); return { data: { signedUrl: `https://signed.example/${bucket}/${path}` }, error: null }; },
        remove: async (paths) => { storageLog.removed.push({ bucket, paths }); return { data: paths, error: null }; },
      }),
    },
  };
}
