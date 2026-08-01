# Document Search

Semantic search, RAG chat, and a member-facing benefits assistant over synthetic benefits content. The stack runs locally with Docker Compose, uses PostgreSQL + pgvector for retrieval, Ollama for local chat generation, and three ETL services to keep documents, web content, and claims data indexed.

## Prerequisites

- Docker with Docker Compose
- Python 3 with `pip3`
- Roughly 2 GB of free disk for the initial Ollama model pull
- Enough RAM to run PostgreSQL, Ollama, and the Node.js services together

## Quick Start

```bash
npm run setup
```

The setup script will:

1. Create `.env` from `.env.example` if it is missing
2. Generate 1,500 synthetic benefits PDFs and `services/etl-documents/data/manifest.json`
3. Generate about 700 synthetic benefits web pages and `services/etl-webcrawl/data/web_manifest.json`
4. Generate synthetic member benefits claims and activity logs
5. Build all Docker images in parallel
6. Start PostgreSQL and wait for its health check
7. Verify that the schema has been initialized
8. Start all application and ETL services
9. Pull the configured Ollama model (default `qwen2.5:3b`)

When setup completes, the local entry points are:

- Search UI and API: `http://localhost:3000`
- GenAI chat UI and API: `http://localhost:3001`
- Member benefits UI and API: `http://localhost:3002`
- Ollama: `http://localhost:11434`
- PostgreSQL: `localhost:5433`

## Running Services

| Service | Port | Purpose |
|---|---|---|
| `postgres` | `5433 -> 5432` | PostgreSQL 15 with pgvector; stores document, web, and claims search data |
| `app` | `3000` | Search UI and Express API for documents, web content, and unified retrieval |
| `genai-search` | `3001` | RAG chat UI and API; retrieves context from pgvector and calls Ollama |
| `member-benefits-app` | `3002` | Member-facing benefits assistant for claims, plan details, deductible status, and generated documents |
| `ollama` | `11434` | Local LLM runtime used by `genai-search` |
| `etl-documents` | none | Loads synthetic document manifests into PostgreSQL and creates embeddings |
| `etl-webcrawl` | none | Loads synthetic web-page manifests into PostgreSQL and creates embeddings |
| `etl-claims-line` | none | Loads synthetic claims and claim activity logs into PostgreSQL |

## Data Flow

### Search and Chat

```text
Synthetic PDFs + manifest.json ----> etl-documents ---
                                                 \
                                                  --> PostgreSQL + pgvector --> Search API/UI (3000)
                                                 /
Synthetic HTML + web_manifest.json -> etl-webcrawl ---                           \
                                                                                  --> GenAI chat API/UI (3001) -> Ollama
```

- The document ETL does not parse PDFs at runtime. It reads `services/etl-documents/data/manifest.json`, which is generated alongside the PDFs.
- The web ETL reads `services/etl-webcrawl/data/web_manifest.json` and indexes sectioned HTML content.
- Both ETL pipelines chunk text, generate BGE embeddings through `@xenova/transformers`, and load records into pgvector-backed tables.
- The chat service embeds the incoming question, retrieves the top matching chunks from both document and web sources, and sends grounded context to Ollama.

### Member Benefits Assistant

```text
Synthetic claims JSON -> etl-claims-line -> PostgreSQL claims tables -> member-benefits-app (3002)
                                                              \
                                                               -> generated member documents on local disk
```

- The member assistant is separate from RAG chat. It uses structured claims and plan data rather than the document/web retrieval pipeline.
- Generated documents such as EOBs, SPDs, enrollment forms, and beneficiary forms are written to `data-output/member-benefits-docs` on the host.

## API Reference

### Search API (`http://localhost:3000`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/search?q=...` | Semantic search across indexed document chunks |
| `GET` | `/api/search/pages?q=...` | Coarser page-level document search |
| `GET` | `/api/search/web?q=...` | Semantic search across indexed web-content chunks |
| `GET` | `/api/search/all?q=...` | Unified semantic search across documents and web content |
| `GET` | `/api/documents` | Paginated document list; supports `category`, `limit`, and `offset` |
| `GET` | `/api/documents/:filename` | Document lookup with page text |
| `GET` | `/api/web-sources` | Paginated web-source list; supports `category`, `limit`, and `offset` |
| `GET` | `/api/pdfs/:filename` | Serve a generated PDF inline |
| `GET` | `/api/web-pages/:filename` | Serve a generated HTML page inline |
| `GET` | `/api/etl-jobs` | ETL job history |
| `GET` | `/health` | Service health check |

### GenAI Chat API (`http://localhost:3001`)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/chat` | Streaming SSE chat response with `X-Session-Id` and `X-Sources` headers |
| `POST` | `/api/ask` | Non-streaming JSON chat response |
| `GET` | `/health` | Service health check, including Ollama reachability |

Request body for both chat endpoints:

```json
{
  "question": "What is the 401k employer match?",
  "sessionId": "optional-existing-session-id"
}
```

### Member Benefits API (`http://localhost:3002`)

All `/api/*` routes require the `x-api-key` header when `API_KEY` is set. Member resolution uses one of:

- `x-member-email` header
- `memberEmail` query parameter
- `memberEmail` in the JSON request body

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/session` | Resolve the active member and return sample members |
| `GET` | `/api/claims/open` | List open claims for the resolved member |
| `GET` | `/api/claims/summary` | Claims summary; optional `planYear` |
| `GET` | `/api/claims/search?q=...` | Search structured claims for the resolved member |
| `GET` | `/api/plan?type=medical` | Plan details for `medical`, `dental`, `vision`, or `rx` |
| `GET` | `/api/deductible` | Current deductible status; optional `planYear` |
| `POST` | `/api/documents/:type` | Generate member-specific documents such as `eob`, `spd`, `enrollment_form`, or `beneficiary_form` |
| `POST` | `/api/bot` | Rule-based assistant endpoint over claims and plan data |
| `GET` | `/health` | Service health check |

## Example Requests

```bash
# Document search
curl "http://localhost:3000/api/search?q=401k%20matching%20contributions"

# Web-content search
curl "http://localhost:3000/api/search/web?q=dental%20claim%20appeal"

# Unified search across documents and web content
curl "http://localhost:3000/api/search/all?q=category:dental%20out-of-pocket%20maximum"

# Non-streaming RAG chat
curl -X POST http://localhost:3001/api/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"How do I enroll in dental insurance?"}'

# Member session lookup
curl http://localhost:3002/api/session \
  -H "x-api-key: dev-key-please-change" \
  -H "x-member-email: alex.member@example.com"

# Generate a member EOB document
curl -X POST http://localhost:3002/api/documents/eob \
  -H "Content-Type: application/json" \
  -H "x-api-key: dev-key-please-change" \
  -H "x-member-email: alex.member@example.com" \
  -d '{"claimId":"CLM-10001","planYear":2026}'
```

## Configuration

The default `.env.example` covers the shared PostgreSQL and ETL settings used by every Compose file. These optional overrides are also supported by the running services:

| Variable | Used By | Default | Purpose |
|---|---|---|---|
| `OLLAMA_MODEL` | `genai-search`, setup script | `qwen2.5:3b` | Ollama model pulled and used for chat |
| `RAG_TOP_K` | `genai-search` | `10` | Number of chunks retrieved before answer generation |
| `MAX_CONTEXT_CHARS` | `genai-search` | `6000` | Maximum retrieved context sent to the LLM |
| `DOCUMENT_DIR` | `member-benefits-app` | `/usr/src/app/generated-docs` | Output directory for generated member documents inside the container |

## Common Commands

```bash
npm run setup                # Full bootstrap: data generation, image build, start, Ollama pull
npm run teardown             # Stop containers and remove volumes
npm run dev:up               # Start all services
npm run dev:down             # Stop all services
npm run dev:build            # Rebuild images
npm run dev:logs             # Tail logs from all services
npm run dev:ps               # Show running containers
npm run generate-data        # Regenerate synthetic PDFs and manifest
npm run generate-web-data    # Regenerate synthetic web pages and manifest
npm run generate-claims-data # Regenerate synthetic claims data
```

## Repository Layout

```text
document-search/
|- services/
|  |- app/                   # Search UI and API
|  |- genai-search/          # RAG chat UI and API
|  |- member-benefits-app/   # Member-facing claims assistant and document generation
|  |- etl-documents/         # Document ETL over manifest.json
|  |- etl-webcrawl/          # Web-content ETL over web_manifest.json
|  \- etl-claims-line/       # Claims and activity-log ETL
|- infra/db/init/            # PostgreSQL schema, indexes, and stored procedures
|- lib/                      # Shared embedding helpers
|- startup/                  # Local setup and teardown scripts
|- docs/                     # Supporting architecture and review notes
|- data-output/              # Generated member document output on host
\- docker-compose.*.yml     # Per-service Compose definitions
```

## Technology Stack

| Area | Technology |
|---|---|
| Runtime | Node.js 22 |
| APIs | Express 4 |
| Database | PostgreSQL 15 + pgvector |
| Embeddings | `Xenova/bge-small-en-v1.5` via `@xenova/transformers` |
| Chat LLM | Ollama with `qwen2.5:3b` by default |
| ETL Scheduling | `node-cron` |
| Data Generation | Python 3 plus `fpdf2` |
| Containers | Docker Compose |
