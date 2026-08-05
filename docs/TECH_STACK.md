# Technology Stack

This document describes the current technology choices for the document-search project. Update it whenever dependencies, infrastructure, or tooling changes.

**Last updated:** August 4, 2026

---

## Runtime

| Item | Value |
|---|---|
| **Node.js** | 20 LTS (Alpine base image: `node:20-alpine`) |
| **Python** | 3 (used for synthetic data generation scripts only) |

---

## Application Services

| Service | Port | Framework | Key Dependencies |
|---|---|---|---|
| `app` | 3000 | Express 4.x | `pg`, `@xenova/transformers` |
| `genai-search` | 3001 | Express 4.x | `pg`, `@xenova/transformers`, `uuid` |
| `member-benefits-app` | 3002 | Express 4.x | `pg` |

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
| **Connection pooling** | `node-postgres` (`pg`) Pool per service |
| **Port mapping** | `5433 → 5432` (host → container) |
| **Schema init** | `infra/db/init/` — 13 SQL scripts executed in order on first start |

### Schema overview

| Schema object | Purpose |
|---|---|
| `documents`, `document_pages`, `document_chunks` | PDF document hierarchy and chunks |
| `web_sources`, `web_sections`, `web_chunks` | Web page hierarchy and chunks |
| `claims`, `claims_logs` | Member claims and activity log |
| `chat_logs`, `chat_feedback` | RAG chat query history, escalation signals, and thumbs ratings |
| `etl_job_logs` | ETL run history |
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
| **Build contexts** | Root context for services using `lib/` (`app`, `genai-search`, ETL services) |
| **Compose files** | `docker-compose.postgres.yml`, `docker-compose.app.yml`, `docker-compose.etl-documents.yml`, `docker-compose.etl-webcrawl.yml`, `docker-compose.genai-search.yml`, `docker-compose.etl-claims-line.yml`, `docker-compose.member-benefits-app.yml` |
| **Volumes** | `pgdata` (PostgreSQL data), `ollama-models` (downloaded LLM weights), `genai-model-cache` (ONNX embedding model cache) |
| **Generated docs** | `data-output/member-benefits-docs` → `/usr/src/app/generated-docs` (bind mount) |

---

## Frontend

| Service | Static files | Notes |
|---|---|---|
| `app` | `services/app/public/` | Search UI (`index.html`) and Admin UI (`admin.html`) |
| `genai-search` | `services/genai-search/public/` | Chat UI (`index.html`) and Analytics Dashboard (`analytics.html`) |
| `member-benefits-app` | `services/member-benefits-app/src/public/` | Member benefits UI (`index.html`) |

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
