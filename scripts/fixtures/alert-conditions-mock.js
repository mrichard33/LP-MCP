/**
 * In-memory stand-in for the `alert_conditions` table.
 * scripts/fixtures/alert-conditions-mock.js
 *
 * 2026-09-05. Extracted from scripts/test-alert-state.js when a second and
 * third suite needed it. Shared rather than copied on purpose: this mock's
 * value is entirely in the PostgreSQL semantics it reproduces, and three
 * drifting copies of those semantics would test three different databases.
 *
 * What it models, and why each one matters:
 *
 *   insert()  — a second insert for the same alert_key returns 23505 instead
 *               of overwriting. That collision IS the serialization mechanism
 *               in src/alert-state.js; without it a test cannot tell a claim
 *               from an overwrite, and two concurrent sweeps would look safe
 *               when they are not.
 *
 *   upsert({ ignoreDuplicates: true }) — ON CONFLICT DO NOTHING with RETURNING:
 *               `.select()` resolves to only the rows actually INSERTED. This
 *               is what lets claimAlertConditionSet claim a whole set in one
 *               round trip and still know which keys are new.
 *
 *   update()  — a guarded UPDATE ... RETURNING: `.select()` resolves to only
 *               the rows that matched every filter. That is what makes the
 *               clear / re-arm / remind transitions compare-and-swap rather
 *               than read-modify-write, so exactly one caller can win each.
 *
 * `fail` forces an error onto one operation: 'insert', 'update', 'select',
 * 'upsert', or 'throw' for a client that explodes outright.
 */

export function mockAlertConditions(rows = new Map(), { fail = null } = {}) {
  const match = (row, filters) => filters.every(([op, col, val]) => {
    const v = row[col];
    if (op === 'eq') return v === val;
    if (op === 'lt') return v != null && String(v) < String(val);
    if (op === 'in') return val.includes(v);
    // PostgREST .like() with a trailing % — the prefix scan the set API uses.
    if (op === 'like') return typeof v === 'string' && v.startsWith(String(val).replace(/%$/, ''));
    return false;
  });

  const builder = (kind, patch) => {
    const filters = [];
    const run = () => {
      if (fail === 'throw') throw new Error('client exploded');
      if (fail === kind) return { data: null, error: { message: `${kind} boom` } };
      const hits = [...rows.values()].filter((r) => match(r, filters));
      if (kind === 'delete') for (const r of hits) rows.delete(r.alert_key);
      else if (kind === 'update') for (const r of hits) Object.assign(r, patch);
      return { data: hits.map((r) => ({ ...r })), error: null };
    };
    const self = {
      eq: (c, v) => { filters.push(['eq', c, v]); return self; },
      lt: (c, v) => { filters.push(['lt', c, v]); return self; },
      in: (c, v) => { filters.push(['in', c, v]); return self; },
      like: (c, v) => { filters.push(['like', c, v]); return self; },
      select: () => self,
      then: (res, rej) => {
        try { return Promise.resolve(run()).then(res, rej); } catch (e) { return Promise.reject(e).catch(rej); }
      },
    };
    return self;
  };

  return {
    from: () => ({
      insert: (row) => Promise.resolve().then(() => {
        if (fail === 'throw') throw new Error('client exploded');
        if (fail === 'insert') return { error: { message: 'insert boom', code: '42P01' } };
        if (rows.has(row.alert_key)) return { error: { code: '23505', message: 'duplicate key' } };
        rows.set(row.alert_key, { ...row });
        return { error: null };
      }),
      upsert: (batch, opts = {}) => {
        const inserted = [];
        const run = () => {
          if (fail === 'throw') throw new Error('client exploded');
          if (fail === 'upsert') return { data: null, error: { message: 'upsert boom' } };
          for (const row of batch) {
            if (rows.has(row.alert_key)) {
              // ON CONFLICT DO NOTHING: the existing row is left alone and is
              // NOT returned, so the caller correctly reads it as "not mine".
              if (opts.ignoreDuplicates) continue;
              Object.assign(rows.get(row.alert_key), row);
              inserted.push(row);
              continue;
            }
            rows.set(row.alert_key, { ...row });
            inserted.push(row);
          }
          return { data: inserted.map((r) => ({ alert_key: r.alert_key })), error: null };
        };
        const self = {
          select: () => self,
          then: (res, rej) => {
            try { return Promise.resolve(run()).then(res, rej); } catch (e) { return Promise.reject(e).catch(rej); }
          },
        };
        return self;
      },
      select: () => builder('select'),
      update: (patch) => builder('update', patch),
      delete: () => builder('delete'),
    }),
  };
}

export default mockAlertConditions;
