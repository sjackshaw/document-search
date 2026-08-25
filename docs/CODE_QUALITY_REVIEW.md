# Code Quality Review — document-search

**Date**: March 16, 2026  
**2026-08-24 update**: `app`, `genai-search`, and `member-benefits-app` were merged into a single `portal` service (`services/portal/`, one `package.json`/`Dockerfile`, three route modules under `src/routes/`). This resolves finding **9c (monolithic route files)** — the ~320-line `app` and ~230-line `genai-search` index files are now split into `search.js`, `chat.js`, and `member.js`. It also further reduces the code-duplication surface beyond the original `lib/embedding.js` extraction (item 1): there is now one `package.json`, one `Dockerfile`, and one `escalation.js` (previously duplicated verbatim across `genai-search` and `member-benefits-app`, now a single file). Finding **17 (unused `BATCH_SIZE`)** is now resolved for `etl-documents`/`etl-webcrawl`. Two real, previously-undetected bugs were also found and fixed in `etl-claims-line` during this work — see the new item 4e below.  
**Scope**: All application services, ETL pipelines, Docker configuration, testing, and Express patterns

---

## Executive Summary

The project is well-structured at the macro level with clean service separation, solid SQL schema design, and correct pgvector usage. The most impactful issues are: **massive code duplication** across 4 services, **missing `.dockerignore` files**, an **unused `uuid` dependency** and **dead `API_KEY` config**, a **race condition** in the embedder singleton, **near-zero test coverage**, and an **ESLint config that doesn't match the CommonJS source**.

---

## 1. ~~Code Duplication~~ — ✅ RESOLVED

**Resolution:** Extracted shared embedding logic into `lib/embedding.js`. All 4 services now import `getEmbedder()`, `embed()`, `embedQuery()`, `embedBatch()`, and `chunkText()` from the shared module. The singleton race condition (item 4a) was also resolved by using a Promise-based lock instead of a TOCTOU check. Search services use `embedQuery()` (with BGE query prefix) while ETL services use `embed()` (raw text). Docker build contexts updated to root so `lib/` is accessible during image builds.

---

## 2. ~~ESLint Config Mismatch~~ — ✅ RESOLVED

**Resolution:** Changed `sourceType` from `'module'` to `'commonjs'` in `eslint.config.mjs`. Added `require`, `module`, `exports`, and `global` to the globals list. Added a test file override block (`**/test/**/*.js`) with Jest globals (`describe`, `test`, `expect`, `it`, `beforeEach`, `afterEach`, `beforeAll`, `afterAll`, `jest`).

---

## 3. ~~Docker Best Practices~~ — ✅ RESOLVED (3a)

### ~~3a. No `.dockerignore` files~~ — ✅ RESOLVED

**Resolution:** Added `.dockerignore` to each service directory (`services/app/`, `services/genai-search/`, `services/etl-documents/`, `services/etl-webcrawl/`) excluding `node_modules`, `test`, `data`, and `*.md`. Added a root `.dockerignore` excluding `.git`, `node_modules`, `*.md`, `docs/`, `.env*`, and `*.py`. Dockerfiles updated to use targeted `COPY` paths instead of `COPY . .`.

**August 4, 2026 — Extended:** Two new services added since the original resolution also include `.dockerignore` files: `services/etl-claims-line/.dockerignore` and `services/member-benefits-app/.dockerignore`. All six service directories are now covered.

**2026-08-24 — Consolidated:** `services/app/.dockerignore`, `services/genai-search/.dockerignore`, and `services/member-benefits-app/.dockerignore` were replaced by a single `services/portal/.dockerignore` as part of the merge. Four service directories are now covered: `services/portal/`, `services/etl-documents/`, `services/etl-webcrawl/`, `services/etl-claims-line/`.

### 3b. No multi-stage builds — MEDIUM

All Dockerfiles are single-stage. Since `npm install` pulls build dependencies (native addons for ONNX runtime inside `@xenova/transformers`), a multi-stage build separating the install stage from the runtime stage would reduce final image size.

### 3c. All Dockerfiles identical — LOW

The four Dockerfiles are nearly identical. Consider a shared Dockerfile with `ARG` for the entrypoint.

---

## 4. Error Handling & Resilience — HIGH

### 4a. Embedder singleton race condition — HIGH

In all 4 services, `getEmbedder()` has a TOCTOU race:

```js
async function getEmbedder() {
  if (!embedder) {                // Thread A checks: null
    embedder = await pipeline(…); // Thread A awaits... meanwhile Thread B checks: still null
  }                               // Thread B also calls pipeline()
  return embedder;
}
```

If two concurrent requests arrive before the model is loaded, `pipeline()` is called twice, loading the ~100MB model into memory twice.

**Fix:** Use a Promise-based lock:
```js
let embedderPromise = null;
function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5');
  }
  return embedderPromise;
}
```

### 4b. No graceful shutdown — HIGH

No service calls `pool.end()` or `server.close()` on `SIGTERM`/`SIGINT`. In Docker, this means:
- Connections to PostgreSQL are abruptly terminated
- In-flight requests are dropped
- ETL jobs mid-processing won't be marked as failed

**Affected:** All 4 services.

### 4c. ETL-documents cron missing `.catch()` — MEDIUM

`services/etl-documents/vectorize.js`:
```js
cron.schedule(CRON_SCHEDULE, async () => {
    await runEtl();
});
```

vs `services/etl-webcrawl/vectorize.js`:
```js
cron.schedule(CRON_SCHEDULE, () => {
    runEtl().catch(err => console.error('[ETL] Cron run failed:', err));
});
```

The documents ETL has an unhandled promise rejection if `runEtl()` throws. The webcrawl version correctly handles this.

### 4d. Sync filesystem calls in request handlers — MEDIUM

`services/app/src/index.js` uses `fs.existsSync()` in request handlers, blocking the event loop. Use `fs.promises.access()` or `fs.stat` with a callback instead.

**2026-08-24:** This code now lives in `services/portal/src/routes/search.js` (`GET /api/pdfs/:filename`, `GET /api/web-pages/:filename`) — the finding still applies, just at a new file path.

### 4e. NEW (2026-08-24) — `etl-claims-line` shipped with two undetected bugs that made every run fail

Found while deploying the merged `portal` service for review, not by static review:

1. **Wrong invocation convention**: `sp_etl_complete_job`/`sp_etl_fail_job` are SQL **functions**, but `services/etl-claims-line/vectorize.js` called them with `CALL` (valid only for `PROCEDURE`s), raising PostgreSQL error `42809` (`... is not a procedure`).
2. **Missing schema**: `sp_etl_log_change` (also called via `CALL`) had no backing procedure or table (`etl_change_logs`) anywhere in `infra/db/init/`, despite being documented as existing in `docs/TECH_STACK.md`.

Both bugs meant the claims ETL failed on every run, leaving the `claims` and `claims_logs` tables empty. Fixed by correcting the `CALL`/`SELECT` usage and adding `infra/db/init/14_etl_change_logs.sql`. This highlights a gap in the near-zero test coverage noted in Section 8 — a single integration test that ran the claims ETL against a real (or test) database would have caught this immediately.

**Also fixed in the same pass**: `services/etl-claims-line/Dockerfile` was missing the `@xenova/transformers/.cache` `mkdir`/`chown` step present in the other three service Dockerfiles, causing `EACCES` on model download.

---

## 5. Memory Management — HIGH

### 5a. Session store has no upper bound — HIGH

`services/genai-search/src/index.js`: The `sessions` Map grows without limit. The cleanup interval only prunes expired sessions. A burst of unique sessions (e.g., bot traffic) can OOM the process.

**Fix:** Add a max session count with LRU eviction.

### 5b. Session message history grows without bound — MEDIUM

`session.messages.push(...)` appends forever — only the last 20 messages are *used*, but all messages are *retained*. A chatty user could accumulate large arrays.

**Fix:** Trim to the last 20 messages after each push, or cap at push time.

### 5c. `setInterval` not cleaned up — LOW

The session-purge interval is never cleared, keeping the process alive even after `server.close()`. Call `.unref()` on the interval or clear it on shutdown.

---

## 6. Package.json Hygiene — MEDIUM

### 6a. ~~Unused `uuid` dependency~~ — ✅ RESOLVED (2026-08-24)

`services/genai-search/package.json` listed `"uuid": "^9.0.0"` but the code used `crypto.randomUUID()`. The `uuid` package was never imported. Resolved by the merge into `services/portal` — `portal/package.json` never listed it.

### 6b. ~~Dead `BATCH_SIZE` variable~~ — ✅ RESOLVED (2026-08-24)

`BATCH_SIZE` was declared in both `etl-documents` and `etl-webcrawl` vectorize files, set via docker-compose env, but never referenced anywhere in the code logic. Removed the unused variable from both files and the corresponding `BATCH_SIZE` env line from `docker-compose.etl-documents.yml`/`docker-compose.etl-webcrawl.yml`. `services/etl-claims-line/vectorize.js` genuinely uses `BATCH_SIZE` for real batching (`for (let index = 0; index < records.length; index += BATCH_SIZE)`) and was left unchanged; it is also still documented in `.env.example`.

### 6c. `@xenova/transformers` deprecation notice — LOW

`@xenova/transformers` has been superseded by `@huggingface/transformers`. Not broken today, but worth tracking for future upgrades.

---

## 7. Security — HIGH

### 7a. Dead `API_KEY` configuration — HIGH

`docker-compose.app.yml` sets `API_KEY: ${API_KEY:-dev-key-please-change}` but the app's `index.js` **never reads or checks it**. Authentication appears intended but was never implemented. All endpoints are completely open.

### 7b. No security middleware — MEDIUM

Neither Express app uses:
- `helmet` for security headers
- Rate limiting (embedding is CPU-expensive — a DoS vector)
- CORS configuration
- Request body size limits (uses Express default 100kb, which is fine but implicit)

### 7c. Default database credentials — LOW (dev context)

All compose files use `postgres/postgres` as default credentials. Acceptable for local dev, but should be flagged for production.

---

## 8. Testing — HIGH

### 8a. Near-zero test coverage

| Service | Tests | Coverage |
|---|---|---|
| `portal` | 20 unit tests (`queryParser.test.js`, `member-benefits.test.js`) + RAG regression suite (`rag-regression.test.js`, skips if service unreachable) | `queryParser.js` and `member-benefits.js` only |
| `etl-documents` | 0 | **0%** |
| `etl-webcrawl` | 0 | **0%** |
| `etl-claims-line` | 0 | **0%** — see item 4e; a basic integration test would have caught two real bugs before they shipped |

**Not tested at all:**
- Any Express route handler
- `embed()` / `getEmbedder()` 
- `chunkText()` logic (boundary conditions, overlap behavior)
- Session management (creation, expiry, cleanup)
- Ollama streaming and error handling
- ETL pipeline orchestration

### 8b. `--passWithNoTests` hides missing tests

All `package.json` test scripts use `--passWithNoTests`, meaning running `npm test` succeeds silently even when there are zero tests. This masks the problem.

### 8c. Missing test infrastructure

No test coverage configuration (Istanbul/c8), no integration test setup (supertest for HTTP endpoints), no test fixtures for SQL procedures.

---

## 9. Express Best Practices — MEDIUM

### 9a. No centralized error-handling middleware — MEDIUM

Each route handler has its own `try/catch` with inline `console.error` + `res.status(500).json(...)`. A global Express error handler would reduce duplication and ensure consistent error responses.

### 9b. Repeated validation pattern — LOW

The `q` parameter validation block is identical across 4 search routes in `services/app/src/index.js`. Extract to a `validateQuery` middleware.

### 9c. ~~Monolithic route files~~ — ✅ RESOLVED (2026-08-24)

`services/app/src/index.js` was ~320 lines with 9 route handlers, and `services/genai-search/src/index.js` was ~230 lines mixing session management, embedding, Ollama communication, and HTTP routes. Both are now split into `services/portal/src/routes/search.js`, `chat.js`, and `member.js` (plus a thin `services/portal/src/index.js` that just wires up middleware and static serving), as part of the `app`/`genai-search`/`member-benefits-app` merge into `portal`.

---

## 10. SQL Quality — LOW-MEDIUM

### 10a. Redundant indexes — LOW

`infra/db/init/02_documents_table.sql`: `idx_documents_filename` is redundant — the `UNIQUE` constraint on `filename` already creates a unique index. Same for `idx_web_sources_url` in `07_web_sources_table.sql`.

### 10b. `sp_search_all` performance — MEDIUM

`infra/db/init/10_web_stored_procedures.sql`: The `UNION ALL` in `sp_search_all` materializes both full subquery results before sorting and limiting. At scale, adding `LIMIT` to each subquery (e.g., `LIMIT p_top_k * 2`) would significantly reduce work.

### 10c. No ETL log retention — LOW

`etl_job_logs` grows unbounded. No cleanup policy, partitioning, or retention stored procedure.

### 10d. No `updated_at` trigger — LOW

`updated_at` is managed manually in stored procedures. A `BEFORE UPDATE` trigger would be more reliable.

---

## Summary Table

| # | Finding | Severity | Category |
|---|---|---|---|
| 1 | ~~Embedding logic duplicated across 4 services~~ | ~~HIGH~~ ✅ | Duplication |
| 2 | ~~ESLint `sourceType: 'module'` vs CommonJS reality~~ | ~~HIGH~~ ✅ | Config |
| 3 | ~~No `.dockerignore` in any service~~ | ~~HIGH~~ ✅ | Docker |
| 4 | Embedder singleton race condition | **HIGH** | Correctness |
| 5 | No graceful shutdown (pool/server close) | **HIGH** | Resilience |
| 6 | Session store unbounded growth | **HIGH** | Memory |
| 7 | Dead `API_KEY` — auth intended but not implemented | **HIGH** | Security |
| 8 | Near-zero test coverage (5 real tests, 1 placeholder) | **HIGH** | Testing |
| 9 | ETL-documents cron missing `.catch()` | **MEDIUM** | Error handling |
| 10 | Sync `fs.existsSync()` in request handlers | **MEDIUM** | Performance |
| 11 | Session messages grow without bound | **MEDIUM** | Memory |
| 12 | `sp_search_all` UNION ALL without sub-limits | **MEDIUM** | SQL perf |
| 13 | ~~Unused `uuid` dependency in genai-search~~ | ~~MEDIUM~~ ✅ | Dependencies |
| 14 | No security headers / rate limiting | **MEDIUM** | Security |
| 15 | No centralized error-handling middleware | **MEDIUM** | Express |
| 16 | No multi-stage Docker builds | **MEDIUM** | Docker |
| 17 | ~~Unused `BATCH_SIZE` variable in both ETL services~~ | ~~LOW~~ ✅ | Dead code |
| 18 | Redundant SQL indexes on UNIQUE columns | **LOW** | SQL |
| 19 | `--passWithNoTests` masks missing tests | **LOW** | Testing |
| 20 | `setInterval` for session cleanup never unref'd | **LOW** | Memory |
| 21 | Repeated query validation pattern (4 routes) | **LOW** | Duplication |
| 22 | ~~Monolithic route files~~ | ~~LOW~~ ✅ | Structure |
| 23 | Default `postgres/postgres` credentials | **LOW** | Security (dev) |
| 24 | No ETL log retention policy | **LOW** | SQL |
