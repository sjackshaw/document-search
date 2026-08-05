# Data Layer Review — document-search

**Date**: March 16, 2026  
**Scope**: Schema design, pgvector configuration, stored procedures, ETL pipelines, query patterns, connection pooling, data integrity, migration strategy

> **Diagrams:** [Database Schema ER Diagram](diagrams/database-schema.md) · [ETL Pipeline](diagrams/etl-pipeline.md)

---

## 1. Schema Design

### Strengths
- Clean normalized 3-tier hierarchy for both pipelines: `documents` → `document_pages` → `document_chunks` and `web_sources` → `web_sections` → `web_chunks`.
- Proper use of `SERIAL PRIMARY KEY`, `TIMESTAMPTZ`, and `TEXT` types throughout.
- Good use of `ON DELETE CASCADE` on all child tables, ensuring orphan-free deletes.
- `UNIQUE` constraints on natural keys: `(document_id, page_number)`, `(page_id, chunk_index)`, `(source_id, section_index)`, `(section_id, chunk_index)`.

### Findings

**[F1] MEDIUM — `documents.category` and `web_sources.category` are unconstrained TEXT**

Categories are string literals with no `CHECK` constraint or FK to a reference table. Misspelled categories (e.g., `"retirment"`) would silently succeed and never match filtered searches. The app layer has `CATEGORY_ALIASES` in `queryParser.js` but nothing enforces this at the DB level.

**Recommendation:** Add a `CHECK (category IN ('health_insurance','dental','vision',...))` constraint or create a `categories` reference table.

**[F2] LOW — No `updated_at` trigger**

`updated_at` is set to `NOW()` in the upsert stored procedure, but direct `UPDATE` statements bypass this. A `BEFORE UPDATE` trigger would be more robust.

**[F3] LOW — `etl_job_logs` has no FK constraints or TTL**

`target_table` and `service_name` are free-text. `phase` allows any value — no `CHECK` constraint for `('extract','transform','load','complete')`, no `CHECK` on `status` for `('running','completed','failed')`. Over time this table will grow unbounded; no partition or retention policy.

---

## 2. pgvector Configuration

### Findings

**[F4] MEDIUM — HNSW parameters are conservative for production**

All four HNSW indexes use identical parameters:
```sql
WITH (m = 16, ef_construction = 64)
```
- `m=16` is the pgvector default; reasonable for ~10k vectors. At 100k+ vectors, `m=24-32` improves recall.
- `ef_construction=64` is low. For quality retrieval, `ef_construction=128-200` is standard.
- **`ef_search` is never set.** At query time, the default `ef_search=40` is used. For RAG, `ef_search=100-200` significantly improves recall with marginal latency cost.

**Recommendation:** Add `SET hnsw.ef_search = 100;` in the search stored procedures, or set it as a session default. Increase `ef_construction` to 128+ when you rebuild indexes.

**[F5] INFO — vector(384) is correct for `bge-small-en-v1.5`**

All tables and stored procedure signatures use `vector(384)`, matching the 384-dimensional output of the model. Consistent.

**[F6] INFO — `vector_cosine_ops` distance metric is correct**

BGE models are normalized, so cosine distance ≡ inner product. Using `vector_cosine_ops` with the `<=>` operator is correct and consistent across all four indexes and all search procedures.

---

## 3. Stored Procedures

### Strengths
- All search functions are parameterized with typed `vector(384)` inputs — no SQL injection risk.
- Upsert functions use `ON CONFLICT ... DO UPDATE` — idempotent by design.
- Unified `sp_search_all` / `sp_search_all_filtered` cleanly use `UNION ALL` across both content pipelines.

### Findings

**[F7] HIGH — `sp_search_all` and `sp_search_all_filtered` cannot use HNSW indexes efficiently**

These functions do `UNION ALL` of two `ORDER BY embedding <=> ...` subqueries, then `ORDER BY distance LIMIT p_top_k` on the combined result. PostgreSQL cannot push the `LIMIT` into the subqueries of a `UNION ALL` — it must fetch **all rows** from both sides, sort the combined result, then limit. This defeats the HNSW index entirely for the subqueries (they'll fall back to sequential scan).

**Recommendation:** Wrap each half with its own `LIMIT`:
```sql
SELECT * FROM (
    SELECT ... FROM document_chunks ORDER BY embedding <=> $1 LIMIT p_top_k
    UNION ALL
    SELECT ... FROM web_chunks ORDER BY embedding <=> $1 LIMIT p_top_k
) combined ORDER BY distance LIMIT p_top_k;
```
This lets each leg use its HNSW index and limits intermediate rows to `2*p_top_k`.

**[F8] MEDIUM — Category filter on filtered search may not use HNSW index optimally**

The `WHERE (p_category IS NULL OR d.category = p_category)` filter is applied **after** the vector scan. The `OR ... IS NULL` pattern for optional filtering prevents the planner from choosing the optimal path.

**Recommendation:** Keep the current approach (it's functionally correct), but consider partial indexes per category for high-cardinality workloads, or split into two code paths.

**[F9] LOW — No `SECURITY DEFINER` or `SECURITY INVOKER` declaration**

All functions default to `SECURITY INVOKER`. Fine since all services connect as the same `postgres` superuser, but in production with role separation, explicit `SECURITY DEFINER` with `SET search_path` would be safer.

---

## 4. ETL Pipeline

### Findings

**[F10] HIGH — Delete-then-reinsert destroys and rebuilds HNSW index entries unnecessarily**

Both ETL pipelines:
1. Upsert the parent record
2. `DELETE FROM document_chunks WHERE document_id = $1` (or `DELETE FROM web_sections WHERE source_id = $1`)
3. Re-insert all chunks

This is not idempotent in the HNSW sense — every run deletes and rebuilds index entries for every document, even if nothing changed. HNSW deletions create "tombstones" that degrade performance until `VACUUM` reclaims them.

**Recommendation:** Use `content_hash` (already present in `web_sources`) to detect changes and skip unchanged documents. For the document pipeline, add a similar hash column to `documents`. Only delete/reinsert chunks when content actually changed.

**[F11] HIGH — `BATCH_SIZE` is defined but never used**

`const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 64;` is declared but never referenced. The `embedBatch` function embeds sequentially one-at-a-time in a for-loop:
```js
async function embedBatch(texts) {
  const results = [];
  for (const text of texts) {
    results.push(await embed(text));
  }
  return results;
}
```
This provides no actual batching to the model.

**Recommendation:** Implement true batch embedding or at minimum use `Promise.all` with a concurrency limiter. Also batch the DB inserts using a single multi-row INSERT or `COPY` instead of one `SELECT sp_upsert_*()` call per chunk.

**[F12] MEDIUM — Page embeddings truncate to first 512 chars; chunks use full text**

```js
const pageEmbedding = await embed(pageText.slice(0, 512));
```
The page embedding only captures the first 512 characters. If critical content appears later on the page, page-level search will miss it.

**Recommendation:** Either embed by averaging chunk embeddings for the page, or use a representative summary. Document this design decision.

**[F13] MEDIUM — No transaction wrapping per-document load**

`loadDocument` issues multiple queries (1 upsert + 1 delete + N page upserts + N×M chunk inserts) without wrapping them in a transaction. If the process crashes mid-document, the DB will have a partially loaded document with some chunks missing.

**Recommendation:** Wrap `loadDocument` and `loadWebSource` in `pool.query('BEGIN')` / `pool.query('COMMIT')` with a `ROLLBACK` in the catch block.

**[F14] MEDIUM — Entire manifest loaded into memory**

`manifest.json` is 8MB and `web_manifest.json` is 1.7MB. Both are loaded entirely via `JSON.parse(fs.readFileSync(...))`. The `manifest[i] = null` pattern helps GC individual entries, but the initial parse peak memory includes the full parsed object.

**Recommendation:** For the current scale this is fine. If manifests grow significantly, switch to streaming JSON parsing (e.g., `JSONStream`).

**[F15] INFO — ETL embedding uses no query prefix; app search does**

ETL `embed()` does not use a prefix. App/GenAI `embed()` uses `BGE_QUERY_PREFIX`. This is **actually correct** for BGE models: documents should be embedded without the prefix, and queries should use the prefix. However, it's a subtle asymmetry that isn't documented. If someone adds the prefix to ETL (or removes it from search), recall will degrade silently.

**Recommendation:** Add a comment in both ETL files explaining why no prefix is used.

**[F16] LOW — Cron re-entrancy risk**

If an ETL run takes longer than the cron interval (default: 1 hour), `node-cron` will trigger a second overlapping run. There's no lock or "already running" guard.

**Recommendation:** Add a simple in-memory flag (`let running = false`) or use a DB advisory lock.

---

## 5. Query Patterns

### Strengths
- All SQL queries use parameterized inputs (`$1, $2, ...`) — no SQL injection risk.
- Search endpoints properly cap `topK` with `Math.min(...)`.
- Pagination in list endpoints uses parameterized `LIMIT/OFFSET`.

### Findings

**[F17] MEDIUM — Two-query pattern for document list + count**

Every paginated list request issues two separate queries. These could be combined using `COUNT(*) OVER()` as a window function to avoid the second round-trip.

**Recommendation:** Use `SELECT *, COUNT(*) OVER() AS total_count FROM documents ... LIMIT $1 OFFSET $2`.

**[F18] LOW — No `pool.end()` or graceful shutdown**

None of the services call `pool.end()` on `SIGTERM`/`SIGINT`. With 4 services × 10 default connections = 40 potential connections against a single PostgreSQL instance.

**Recommendation:** Add `process.on('SIGTERM', () => pool.end())` to all services.

**[F19] LOW — `path.basename` for file serving is good but no extension validation**

`path.basename` strips directory traversal (`../`), which is good. But the route serves arbitrary files from the data directory without validating extensions.

---

## 6. Connection Pooling

### Findings

**[F20] MEDIUM — pg Pool uses all defaults; no explicit configuration**

All four services use `const pool = new Pool()` with zero configuration:
- `max: 10` connections per pool (default)
- `idleTimeoutMillis: 10000` (10s)
- `connectionTimeoutMillis: 0` (no timeout — hangs forever if DB is unreachable)
- No `statement_timeout`

With 4 services × 10 = 40 potential connections against a single PostgreSQL container with default `max_connections=100`, this leaves limited headroom.

**Recommendation:** Explicitly configure:
```js
const pool = new Pool({
  max: 5,                        // reduce for ETL, keep 10 for app
  connectionTimeoutMillis: 5000, // fail fast if DB is down
  idleTimeoutMillis: 30000,
  statement_timeout: 30000,      // kill runaway queries
});
```

**[F21] LOW — No PgBouncer layer; PostgreSQL shared_buffers not tuned**

The PostgreSQL container uses stock `pgvector/pgvector:pg15` with no custom config. For vector workloads, `shared_buffers`, `work_mem`, and `maintenance_work_mem` (important for HNSW index builds) should be tuned.

**Recommendation:** Add a custom config via `command:` args:
```yaml
command: postgres -c shared_buffers=256MB -c work_mem=64MB -c maintenance_work_mem=512MB
```

---

## 7. Data Integrity

### Findings

**[F22] HIGH — Stale pages survive when page count decreases**

The ETL deletes chunks (`DELETE FROM document_chunks WHERE document_id = $1`) but **does not delete pages**. It upserts pages via `sp_upsert_document_page` which uses `ON CONFLICT (document_id, page_number) DO UPDATE`. If a document previously had 10 pages and now has 6, pages 7-10 remain in the database with stale text and embeddings. These ghost pages will contaminate page-level search results.

**Recommendation:** Add `DELETE FROM document_pages WHERE document_id = $1 AND page_number > $2` after processing, passing the new `page_count`. Or delete all pages before re-inserting (cascading will handle chunks).

**[F23] MEDIUM — `web_sources.content_hash` exists but is never checked**

The `web_sources` table stores `content_hash` (SHA-256), and the ETL computes and stores it. But the ETL never **reads** the existing hash to decide whether to skip processing. Every run unconditionally deletes and rebuilds all sections/chunks regardless of whether content changed.

**[F24] LOW — `document_chunks` has FK to both `documents(id)` and `document_pages(id)` — denormalized but acceptable**

`document_id` on `document_chunks` is redundant (derivable from `page_id → document_pages.document_id`), but it avoids a JOIN in the delete path. Acceptable denormalization for performance.

---

## 8. Migration Strategy

### Strengths
- Numbered scripts (`01_` through `10_`) ensure deterministic ordering.
- All use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` — idempotent for initial setup.
- Functions use `CREATE OR REPLACE FUNCTION` — idempotent.

### Findings

**[F25] MEDIUM — Init scripts run only once; no migration framework**

`docker-entrypoint-initdb.d` runs scripts only on first initialization of a fresh volume. After that, schema changes require manual intervention. There's no migration tool (Flyway, node-pg-migrate, etc.) to track applied changes.

**Recommendation:** For production, adopt a migration tool.

**[F26] LOW — No `search_path` or schema qualification**

All tables are created in the default `public` schema. Functions don't set `search_path`. Fine for a single-schema application but could cause issues at scale.

---

## Summary by Severity

| Severity | # | Key Findings |
|----------|---|---|
| **HIGH** | 3 | F7 (UNION ALL defeats HNSW), F10 (delete-rebuild index churn), F22 (stale pages survive) |
| **MEDIUM** | 8 | F1 (unconstrained categories), F4 (HNSW tuning), F8 (category filter path), F11 (unused BATCH_SIZE), F12 (page embedding truncation), F13 (no transaction wrapping), F17 (extra count query), F20 (Pool defaults), F23 (content_hash unused), F25 (no migration framework) |
| **LOW** | 7 | F2, F3, F9, F14, F16, F18, F19, F21, F24, F26 |
| **INFO** | 2 | F5 (vector dims correct), F6 (cosine ops correct), F15 (BGE prefix asymmetry — correct but undocumented) |

---

## Top 5 Actionable Recommendations

1. **Fix `sp_search_all`** — Add `LIMIT p_top_k` to each UNION branch so HNSW indexes are actually used (F7)
2. **Add change detection** — Check `content_hash` before re-processing; skip unchanged documents/sources (F10, F23)
3. **Clean stale pages** — Delete pages exceeding the new page count after upsert (F22)
4. **Wrap ETL loads in transactions** — `BEGIN` / `COMMIT` per document to prevent partial loads (F13)
5. **Tune HNSW** — Set `ef_search=100` at session/function level; increase `ef_construction` to 128+ on next rebuild (F4)
