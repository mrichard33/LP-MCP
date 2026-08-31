/**
 * Complete Supabase Reads — src/supabase-page.js
 *
 * ONE question: did this read return EVERY matching row, or just the first
 * page pretending to be every row?
 *
 * WHY THIS EXISTS
 * ---------------
 * PostgREST caps every response at a server-configured maximum — 1,000 rows on
 * this project — and says nothing about it. No error, no flag, no truncation
 * marker. `.limit(100000)` does not raise the cap; it only lowers it. Measured
 * 2026-08-31: `supabase.from('lp_jobs').select('lp_job_id').limit(100000)`
 * returns exactly 1000 of 5,892 rows.
 *
 * The failure mode is the dangerous one: not a crash, but a smaller number
 * that still looks like an answer. scripts/reconcile-p2-stages.js read one
 * lp_job_milestones row in six on its first run, planned 2 stage moves instead
 * of 597, and reported 770 jobs as having no completed milestone. Every line of
 * that summary was plausible. It was caught only because the handoff supplied
 * independently-measured expected counts to check against, which is not a
 * safety net any future script should have to rely on.
 *
 * src/admin/hl-client.js refuses a truncated HL result loudly for exactly this
 * reason — "a wrong number that looks right is worse than an outage". This is
 * the LP-side equivalent, and it is a shared module rather than a third copy of
 * the same loop because the copies are how the bug spread in the first place.
 *
 * THREE THINGS THIS GETS RIGHT THAT A HAND-ROLLED PAGER USUALLY DOES NOT
 * ---------------------------------------------------------------------
 * 1. IT ADVANCES BY WHAT ARRIVED, NOT BY WHAT WAS ASKED FOR. A pager that
 *    requests .range(from, from+999) and then treats `rows.length < 1000` as
 *    "last page" is correct ONLY while the server's cap is exactly 1,000. Point
 *    it at an instance configured with max-rows 500 and every chunk stops after
 *    one page, silently, having read half the data — the identical bug in a new
 *    costume. The cursor here moves by rows actually received, so the loop is
 *    correct for any cap, including one changed underneath it.
 *
 * 2. IT VERIFIES, IT DOES NOT ASSUME. Every read asks for an exact count and
 *    asserts that the rows collected match it. A short read throws instead of
 *    returning. This is the assertion the reconciler did not have.
 *
 * 3. IT REFUSES TO GUESS AT THE ORDER. `orderBy` is required and has no
 *    default. Range pagination over an unordered result is undefined — rows can
 *    repeat across pages and others never appear. The obvious default, 'id',
 *    is also wrong often enough to matter: lp_prospects has no `id` column at
 *    all (its key is lp_prospect_id), so a hardcoded default throws on some
 *    tables and, worse, would silently order by a non-unique column on others.
 *    The caller names a unique, stable key or gets an error.
 *
 * A NOTE ON WHAT THE ASSERTION WILL CATCH THAT YOU DID NOT EXPECT
 * --------------------------------------------------------------
 * Offset pagination over a table being WRITTEN underneath you is unsound: the
 * count is taken on the first page, and every insert after that shifts the
 * later pages, so rows can be collected twice or missed entirely. The count
 * assertion surfaces this as a mismatch rather than letting it pass — on
 * 2026-08-31 an unbounded scan of lp_leads collected 235,811 rows against a
 * count of 235,808 taken seconds earlier, because the LP sync was running.
 *
 * That is the assertion working, not a false alarm, and the fix is NOT to relax
 * it. It is to stop doing a full-table scan of a live table: key the read to
 * the rows that can actually affect the answer (selectAllIn over a bounded key
 * list), which is both stable and far cheaper. Reach for selectAllPaged only
 * where the filtered set is small or the table is quiescent.
 */

const DEFAULT_PAGE_ROWS = 1000;
// Keys per IN() chunk. Kept well under the page size so the URL stays a sane
// length; the pager handles a chunk spanning many pages regardless.
const DEFAULT_CHUNK_KEYS = 200;

/**
 * Page one filtered query to completion, asserting the row count.
 *
 * @param {object} builder  a fresh PostgrestFilterBuilder, already carrying
 *   select(columns, {count:'exact'}) and every filter. Fresh matters — a
 *   builder is single-use, so the caller passes a factory, not an instance.
 */
async function drain(makeBuilder, { table, orderBy, pageRows, describeFilter }) {
  const rows = [];
  let expected = null;

  for (let from = 0; ;) {
    const { data, error, count } = await makeBuilder()
      .order(orderBy, { ascending: true })
      .range(from, from + pageRows - 1);
    if (error) throw new Error(`${table} read failed: ${error.message}`);

    if (expected === null) expected = typeof count === 'number' ? count : null;
    const page = data || [];
    rows.push(...page);

    if (page.length === 0) break;
    // By what ARRIVED. See note 1 in the header.
    from += page.length;
    if (expected !== null && rows.length >= expected) break;
  }

  if (expected === null) {
    throw new Error(
      `${table} read returned no exact row count, so completeness cannot be verified. `
      + 'Refusing to continue rather than act on a possibly-truncated read '
      + `(${describeFilter}).`,
    );
  }
  if (rows.length !== expected) {
    throw new Error(
      `${table} read incomplete: collected ${rows.length} of ${expected} rows `
      + `(${describeFilter}). A partial read yields a plausible-looking wrong answer, `
      + 'so this refuses instead of returning.',
    );
  }
  return rows;
}

/**
 * Every row matching a filter, however many pages that takes.
 *
 * @param {object} client            a Supabase client
 * @param {string} table
 * @param {object} opts
 * @param {string} opts.columns      select list
 * @param {string} opts.orderBy      REQUIRED unique, stable column to page by
 * @param {(q: object) => object} [opts.refine]  extra filters
 * @param {number} [opts.pageRows]
 * @returns {Promise<object[]>}
 */
export async function selectAllPaged(client, table, {
  columns, orderBy, refine = (q) => q, pageRows = DEFAULT_PAGE_ROWS,
} = {}) {
  if (!orderBy) throw new Error(`selectAllPaged(${table}) needs an orderBy — range pagination over an unordered result is undefined.`);
  return drain(
    () => refine(client.from(table).select(columns, { count: 'exact' })),
    { table, orderBy, pageRows, describeFilter: 'unchunked' },
  );
}

/**
 * Every row whose `column` is in `values`, chunked over the key list and paged
 * within each chunk. Both loops are needed: chunking keeps the URL short, and
 * a single chunk of 200 keys routinely spans several pages (200 jobs carry
 * ~2,000 milestone rows).
 *
 * @param {object} client
 * @param {string} table
 * @param {object} opts
 * @param {string} opts.columns
 * @param {string} opts.orderBy      REQUIRED unique, stable column to page by
 * @param {string} opts.column       the column filtered with IN
 * @param {Array<string|number>} opts.values
 * @param {(q: object) => object} [opts.refine]
 * @returns {Promise<object[]>}
 */
export async function selectAllIn(client, table, {
  columns, orderBy, column, values, refine = (q) => q,
  chunkKeys = DEFAULT_CHUNK_KEYS, pageRows = DEFAULT_PAGE_ROWS,
} = {}) {
  if (!orderBy) throw new Error(`selectAllIn(${table}) needs an orderBy — range pagination over an unordered result is undefined.`);
  const keys = values || [];
  if (keys.length === 0) return [];

  const out = [];
  for (let i = 0; i < keys.length; i += chunkKeys) {
    const chunk = keys.slice(i, i + chunkKeys);
    const rows = await drain(
      () => refine(client.from(table).select(columns, { count: 'exact' }).in(column, chunk)),
      {
        table,
        orderBy,
        pageRows,
        describeFilter: `${column} IN (${chunk.length} keys, offset ${i})`,
      },
    );
    out.push(...rows);
  }
  return out;
}

/**
 * Assert that an un-paged read was not truncated.
 *
 * For reads small enough that paging is overkill — agent_rules' P2_MILESTONE_*
 * family is a dozen rows — but where silence on truncation is still
 * unacceptable. Cheap insurance: if that family ever grows past the cap, this
 * throws instead of quietly deciding from a partial mapping.
 *
 * @param {string} table
 * @param {object[]} rows
 * @param {number|null|undefined} count  the `count` from a {count:'exact'} select
 */
export function assertComplete(table, rows, count) {
  const got = (rows || []).length;
  if (typeof count !== 'number') {
    throw new Error(`${table} read returned no exact row count; cannot verify completeness.`);
  }
  if (got !== count) {
    throw new Error(
      `${table} read truncated: got ${got} of ${count} rows. PostgREST caps responses `
      + 'silently; page this read with selectAllPaged/selectAllIn from src/supabase-page.js.',
    );
  }
  return rows;
}
