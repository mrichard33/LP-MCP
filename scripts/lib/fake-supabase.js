/**
 * A small in-memory stand-in for the supabase-js client — scripts/lib/fake-supabase.js
 *
 * Enough of the query builder for the marketing ledger tests: from().select /
 * insert / upsert / update / delete with eq / neq / in / gte / lte / is /
 * order / limit / maybeSingle / single, rpc(), and storage.from().upload /
 * createSignedUrl. Thenable like the real builder, so `await` works.
 * Not a general mock: it exists so the ledger's I/O modules run offline.
 */
import { randomUUID } from 'node:crypto';

export function fakeSupabase(seed = {}, { rpc = {} } = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  const calls = [];
  const storageLog = { uploads: [], signed: [] };

  const ensure = (t) => (tables[t] ||= []);

  function exec(q) {
    const rows = ensure(q.table);
    const match = (r) => q.filters.every((f) => f(r));
    let data = null;
    let error = null;
    if (q.op === 'select') {
      let out = rows.filter(match);
      if (q.order) out = [...out].sort((a, b) => (a[q.order[0]] > b[q.order[0]] ? 1 : a[q.order[0]] < b[q.order[0]] ? -1 : 0) * (q.order[1] ? 1 : -1));
      if (q.limit != null) out = out.slice(0, q.limit);
      data = out.map((r) => ({ ...r }));
    } else if (q.op === 'insert') {
      const list = (Array.isArray(q.payload) ? q.payload : [q.payload]).map((r) => ({ id: randomUUID(), created_at: new Date().toISOString(), ...r }));
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
      like(c, pat) { const rx = new RegExp('^' + String(pat).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$'); q.filters.push((r) => rx.test(String(r[c] ?? ''))); return chain; },
      order(c, o) { q.order = [c, o?.ascending !== false]; return chain; },
      limit(n) { q.limit = n; return chain; },
      maybeSingle() { q.single = 'maybe'; return chain; },
      single() { q.single = 'one'; return chain; },
      then(res, rej) { try { return Promise.resolve(exec(q)).then(res, rej); } catch (e) { return Promise.reject(e).then(res, rej); } },
    };
    return chain;
  }

  return {
    tables, calls, storageLog,
    from,
    rpc: async (name, args) => {
      const fn = rpc[name];
      if (!fn) return { data: null, error: { message: `no rpc ${name}` } };
      try { return { data: await fn(args), error: null }; } catch (e) { return { data: null, error: { message: e.message } }; }
    },
    storage: {
      from: (bucket) => ({
        upload: async (path, bytes, opts) => { storageLog.uploads.push({ bucket, path, bytes: bytes.length, opts }); return { data: { path }, error: null }; },
        createSignedUrl: async (path, ttl) => { storageLog.signed.push({ bucket, path, ttl }); return { data: { signedUrl: `https://signed.example/${bucket}/${path}` }, error: null }; },
      }),
    },
  };
}
