# Technology Stack

This document describes the current technology choices for the document-search project. Update it whenever dependencies, infrastructure, or tooling changes.

**Last updated:** August 24, 2026 — `app`, `genai-search`, and `member-benefits-app` were merged into a single `portal` service (see "Application Services" and "Containerization" below).

---

## Runtime

| Item | Value |
|---|---|
| **Node.js** | 22 (base image: `node:22-slim` for `portal`; `node:22` for `etl-claims-line`) |
| **Python** | 3 (used for synthetic data generation scripts only) |

---

## Application Services

| Service | Port | Framework | Key Dependencies |
|---|---|---|---|
| `portal` | 3000 (`${PORTAL_HOST_PORT}`) | Express 4.x | `pg`, `@xenova/transformers` |

`portal` (`services/portal/`) is a single Node.js process serving three logical concerns through separate Express routers, all mounted on one app and one container:

| Router | Mounted at | Responsibility |
|---|---|---|
| `src/routes/search.js` | `/api/*` | Document/web search, admin content management, ETL job history (formerly `app`) |
| `src/routes/chat.js` | `/api/chat`, `/api/ask`, `/api/feedback`, `/api/analytics/*`, `/api/chat/members` | RAG chat + analytics (formerly `genai-search`); optionally personalizes answers with a member's claims context |
| `src/routes/member.js` | `/api/member/*` | Claims, plan details, deductible, document generation, rule-based bot, enrollment comparison (formerly `member-benefits-app`) |

Static UI is served from `services/portal/public/`: a tab shell at `/`, the search UI at `/search`, the chat UI at `/chat` (+ `/chat/analytics.html`), the member UI at `/member`, and the admin dashboard at `/admin.html`.

---

## ETL Services

| Service | Schedule | Key Dependencies |
|---|---|---|
| `etl-documents` | `node-cron` (hourly by default) | `@xenova/transformers`, `pg`, `node-cron` |
| `etl-webcrawl` | `node-cron` (hourly by default) | `@xenova/transformers`, `pg`, `node-cron` |
| `etl-claims-line` | `node-cron` (hourly by default) | `@xenova/transformers`, `pg`, `node-cron` |

---

## Database

| Item | Value |
|---|---|
| **Engine** | PostgreSQL 15 |
| **Image** | `pgvector/pgvector:pg15` |
| **Extension** | `pgvector` (HNSW vector indexing) |
| **Vector dimensions** | 384 (matching `bge-small-en-v1.5`) |
| **Distance metric** | Cosine similarity (`vector_cosine_ops`, `<=>` operator) |
| **Connection pooling** | `node-postgres` (`pg`) Pool per service (`portal` uses a single shared pool across all three routers) |
| **Port mapping** | `5433 → 5432` (host → container), overridable via `POSTGRES_HOST_PORT` |
| **Schema init** | `infra/db/init/` — 14 SQL scripts executed in order on first start |

### Schema overview

| Schema object | Purpose |
|---|---|
| `documents`, `document_pages`, `document_chunks` | PDF document hierarchy and chunks |
| `web_sources`, `web_sections`, `web_chunks` | Web page hierarchy and chunks |
| `claims`, `claims_logs` | Member claims and activity log (both have unused `vector(384)` embedding columns — no search procedure reads them yet) |
| `chat_logs`, `chat_feedback` | RAG chat query history, escalation signals, and thumbs ratings |
| `etl_job_logs` | ETL run history |
| `etl_change_logs` | Field-level change log for the claims ETL's change-detection step (added 2026-08-24; was documented here previously but the table/procedure didn't actually exist until this date) |
| Stored procedures (`sp_*`) | Search, upsert, ETL job logging, and analytics aggregation |

---

## Embedding Model

| Item | Value |
|---|---|
| **Model** | `Xenova/bge-small-en-v1.5` |
| **Parameters** | ~33M |
| **Dimensions** | 384 |
| **Runtime** | ONNX via `@xenova/transformers` (Node.js, CPU-only) |
| **Shared module** | `lib/embedding.js` — `embedQuery()`, `embed()`, `embedBatch()`, `chunkText()` |
| **Query prefix** | `"Represent this sentence for searching relevant passages: "` applied at query time only (asymmetric BGE design) |
| **Chunking** | 500 characters, 50-character overlap |

---

## LLM Runtime

| Item | Value |
|---|---|
| **Runtime** | Ollama (container: `ollama/ollama:latest`) |
| **Default model** | `qwen2.5:3b` |
| **Port** | `11434` |
| **Context** | Rolling conversation history per session (30-minute TTL) |
| **Override** | `OLLAMA_MODEL` environment variable |

---

## ETL Pipeline

| Item | Value |
|---|---|
| **Scheduling** | `node-cron` inside each ETL container |
| **Default schedule** | `0 * * * *` (hourly, overridable via `CRON_SCHEDULE`) |
| **Document source** | Synthetic PDFs + `services/etl-documents/data/manifest.json` |
| **Web source** | Synthetic HTML + `services/etl-webcrawl/data/web_manifest.json` |
| **Claims source** | Synthetic JSON (`services/etl-claims-line/data/primary.json`, `logs.json`) |
| **Upsert strategy** | Idempotent `ON CONFLICT ... DO UPDATE`; change log written to `etl_change_logs` |

---

## Containerization

| Item | Value |
|---|---|
| **Orchestration** | Docker Compose (split into per-service compose files) |
| **Build contexts** | Root context for services using `lib/` (`portal`, ETL services) |
| **Compose files** | `docker-compose.postgres.yml`, `docker-compose.ollama.yml`, `docker-compose.portal.yml`, `docker-compose.etl-documents.yml`, `docker-compose.etl-webcrawl.yml`, `docker-compose.etl-claims-line.yml` |
| **Host ports** | Parameterized via `POSTGRES_HOST_PORT` (default `5433`), `OLLAMA_HOST_PORT` (default `11434`), `PORTAL_HOST_PORT` (default `3000`) — lets a second stack run side-by-side on alternate ports for review/demo |
| **Volumes** | `pgdata` (PostgreSQL data), `ollama-models` (downloaded LLM weights), `model-cache` (ONNX embedding model cache, one per service that embeds) |
| **Generated docs** | `data-output/member-benefits-docs` → `/repo/services/portal/generated-docs` (bind mount) |

---

## Frontend

| Path (all served by `portal`) | Static files | Notes |
|---|---|---|
| `/` | `services/portal/public/index.html` | Tab shell — embeds `/search`, `/chat`, `/member` via same-origin iframes |
| `/search` | `services/portal/public/search/` | Search UI (`index.html`) |
| `/admin.html` | `services/portal/public/admin.html` | Admin UI |
| `/chat` | `services/portal/public/chat/` | Chat UI (`index.html`, includes a member-selection dropdown) and Analytics Dashboard (`analytics.html`) |
| `/member` | `services/portal/public/member/` | Member benefits UI (`index.html`) |

---

## Security Tooling

| Tool | Type | Config |
|---|---|---|
| `eslint` + `@eslint/js` | SAST / linting | `eslint.config.mjs` — CommonJS source type, Jest globals for test files |
| `jest` | Unit testing | Per-service `package.json`; root `jest` in `package.json` |
| `npm audit` | Dependency vulnerability scanning | Run manually or in CI |

---

## Dev Scripts

| Script | Command |
|---|---|
| `npm run setup` | Full first-run setup (data generation, image build, schema verification, Ollama pull) |
| `npm run teardown` | Stop all containers and remove volumes |
| `npm run dev:up` | Start all services (assumes images already built) |
| `npm run dev:down` | Stop all services |
| `npm run dev:build` | Rebuild all images in parallel |
| `npm run dev:logs` | Follow logs for all services |
| `npm run dev:ps` | Show container status |
| `npm run lint` | Run ESLint across all JavaScript |
| `npm test` | Run Jest tests across all services |
| `npm run generate-data` | Regenerate synthetic PDFs and manifest |
| `npm run generate-web-data` | Regenerate synthetic web pages and manifest |
| `npm run generate-claims-data` | Regenerate synthetic claims and activity logs |
