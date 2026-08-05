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

See [diagrams/system-architecture.md](diagrams/system-architecture.md) for the full service dependency graph.

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

See the [diagrams/](diagrams/) folder for full visual diagrams:

| Diagram | Description |
|---|---|
| [diagrams/system-architecture.md](diagrams/system-architecture.md) | All Docker services, ports, and their connections |
| [diagrams/etl-pipeline.md](diagrams/etl-pipeline.md) | All three ETL pipelines from source data to PostgreSQL |
| [diagrams/rag-chat-sequence.md](diagrams/rag-chat-sequence.md) | RAG chat request sequence, escalation detection, feedback loop, and analytics |
| [diagrams/database-schema.md](diagrams/database-schema.md) | Full ER diagram — all tables, columns, and relationships |

### Search and Chat

- The document ETL does not parse PDFs at runtime. It reads `services/etl-documents/data/manifest.json`, which is generated alongside the PDFs.
- The web ETL reads `services/etl-webcrawl/data/web_manifest.json` and indexes sectioned HTML content.
- Both ETL pipelines chunk text, generate BGE embeddings through `@xenova/transformers`, and load records into pgvector-backed tables.
- The chat service embeds the incoming question, retrieves the top matching chunks from both document and web sources, and sends grounded context to Ollama.

### Member Benefits Assistant

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
| `PATCH` | `/api/documents/:id` | Update a document's title or category; requires `X-Admin-Key` when `ADMIN_KEY` is set |
| `DELETE` | `/api/documents/:id` | Remove a document and all its chunks from the index; requires `X-Admin-Key` when `ADMIN_KEY` is set |
| `GET` | `/health` | Service health check |

The admin UI is served at `http://localhost:3000/admin.html`.

### GenAI Chat API (`http://localhost:3001`)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/chat` | Streaming SSE chat response; see headers below |
| `POST` | `/api/ask` | Non-streaming JSON chat response; returns `chatLogId` and `escalationFlagged` |
| `POST` | `/api/feedback` | Submit thumbs-up or thumbs-down rating for a response |
| `GET` | `/api/analytics/summary` | Aggregated stats for a rolling window; supports `days` query parameter |
| `GET` | `/api/analytics/questions` | Low-confidence and negatively-rated questions; supports `days` and `limit` |
| `GET` | `/api/analytics/escalations` | Recent escalation-flagged questions; supports `days` and `limit` |
| `GET` | `/health` | Service health check, including Ollama reachability |

The analytics dashboard is served at `http://localhost:3001/analytics.html`.

**Streaming response headers** (`POST /api/chat`):

| Header | Value |
|---|---|
| `X-Session-Id` | Session identifier for multi-turn conversations |
| `X-Sources` | Base64-encoded JSON array of retrieved source references |
| `X-Chat-Log-Id` | Database ID of the chat log row (used for feedback submission) |
| `X-Escalation-Flagged` | `"true"` when the question contains legal or regulatory language |

Request body for chat endpoints:

```json
{
  "question": "What is the 401k employer match?",
  "sessionId": "optional-existing-session-id"
}
```

Feedback request body:

```json
{
  "chatLogId": 42,
  "rating": "up"
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
| `GET` | `/api/enrollment/compare` | Open-enrollment plan comparison; projects costs for standard and HDHP/economy tiers based on the member's claims history; optional `planYear` (defaults to prior year) |
| `POST` | `/api/documents/:type` | Generate member-specific documents such as `eob`, `spd`, `enrollment_form`, or `beneficiary_form` |
| `POST` | `/api/bot` | Rule-based assistant endpoint; detects escalation signals and returns `escalationFlagged` when legal or regulatory language is present |
| `GET` | `/health` | Service health check |

## Escalation Detection

Queries sent to both the GenAI chat (`/api/ask`, `/api/chat`) and the member benefits bot (`/api/bot`) are scanned for language that indicates a member may need direct support-desk involvement. Detected signals include:

| Signal label | Trigger examples |
|---|---|
| `legal_representation` | "attorney", "lawyer", "legal counsel" |
| `litigation_threat` | "lawsuit", "sue", "litigation" |
| `formal_grievance` | "grievance", "formal complaint" |
| `state_regulator` | "insurance commissioner", "state board" |
| `federal_regulator` | "DOL", "Department of Labor", "ERISA" |
| `bbb_complaint` | "BBB", "Better Business Bureau" |
| `wrongful_denial` | "wrongful denial", "illegal denial" |
| `discrimination_claim` | "discrimination" |
| `compliance_violation` | "compliance violation", "regulation violation" |
| `class_action` | "class action" |

When a signal is detected:
- The chat UI shows a support-desk notice below the answer
- The `escalationFlagged` flag is returned in API responses
- The flag and detected signal labels are stored in `chat_logs` for dashboard reporting

## Open Enrollment Comparison

`GET /api/enrollment/compare` returns a plan-by-plan comparison for the upcoming open enrollment period. For each plan type (medical, dental, vision, rx, mental_health), it:

1. Reads the member's actual out-of-pocket spend from the reference plan year
2. Estimates projected cost under both the **standard** and **HDHP/economy** tier
3. Returns a `recommendation` (`standard`, `hdhp`/`economy`, or `similar`) with a plain-language `reasoning` field

Example request:

```bash
curl "http://localhost:3002/api/enrollment/compare?planYear=2025" \
  -H "x-api-key: dev-key-please-change" \
  -H "x-member-email: alex.member@example.com"
```

## Analytics Dashboard

The analytics dashboard at `http://localhost:3001/analytics.html` shows:

- **Summary stats** — total queries, escalation count, positive/negative feedback, no-source queries, and satisfaction rate for a configurable rolling window (1 day to 90 days)
- **Self-service gaps** — questions where the bot returned no sources, gave a short answer, or received a thumbs-down rating; used to identify content gaps to fill
- **Escalation flags** — flagged questions with the triggering signal labels, for support-desk triage

## Content Admin

The admin panel at `http://localhost:3000/admin.html` allows content owners to manage the document index without developer involvement:

- Browse all indexed documents with title, category, page count, and index date
- Edit a document's title or category in-line
- Remove a document from the index (cascades to all associated pages and chunks)
- Review ETL job history

Set the `ADMIN_KEY` environment variable to protect write operations in shared environments.

## Example Requests

```bash
# Document search
curl "http://localhost:3000/api/search?q=401k%20matching%20contributions"

# Web-content search
curl "http://localhost:3000/api/search/web?q=dental%20claim%20appeal"

# Non-streaming RAG chat
curl -X POST http://localhost:3001/api/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"How do I enroll in dental insurance?"}'

# Submit feedback on a chat answer
curl -X POST http://localhost:3001/api/feedback \
  -H "Content-Type: application/json" \
  -d '{"chatLogId":42,"rating":"up"}'

# Analytics summary for the last 30 days
curl "http://localhost:3001/api/analytics/summary?days=30"

# Open enrollment plan comparison
curl "http://localhost:3002/api/enrollment/compare" \
  -H "x-api-key: dev-key-please-change" \
  -H "x-member-email: alex.member@example.com"

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

# Admin: update a document category
curl -X PATCH http://localhost:3000/api/documents/12 \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: your-admin-key" \
  -d '{"category":"retirement"}'

# Admin: remove a document from the index
curl -X DELETE http://localhost:3000/api/documents/12 \
  -H "X-Admin-Key: your-admin-key"
```

## Configuration

The default `.env.example` covers the shared PostgreSQL and ETL settings used by every Compose file. These optional overrides are also supported by the running services:

| Variable | Used By | Default | Purpose |
|---|---|---|---|
| `OLLAMA_MODEL` | `genai-search`, setup script | `qwen2.5:3b` | Ollama model pulled and used for chat |
| `RAG_TOP_K` | `genai-search` | `10` | Number of chunks retrieved before answer generation |
| `MAX_CONTEXT_CHARS` | `genai-search` | `6000` | Maximum retrieved context sent to the LLM |
| `DOCUMENT_DIR` | `member-benefits-app` | `/usr/src/app/generated-docs` | Output directory for generated member documents inside the container |
| `ADMIN_KEY` | `app` | _(none)_ | When set, the `X-Admin-Key` header is required for `PATCH`/`DELETE` document admin endpoints |

## Running Tests

```bash
# From the workspace root — runs all unit tests across services
npm test

# From the genai-search service — includes RAG regression suite
# (requires the full stack to be running via npm run dev:up)
cd services/genai-search && npm test
```

The RAG regression suite (`services/genai-search/test/rag-regression.test.js`) calls the live `/api/ask` endpoint with ten golden question-and-keyword pairs. If the service is unreachable, all regression tests are skipped rather than failing, making the suite safe to run in CI pipelines that don't include the full stack.

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
|  |- app/                   # Search UI, API, and admin panel
|  |- genai-search/          # RAG chat UI, API, analytics dashboard
|  |- member-benefits-app/   # Member-facing claims assistant, enrollment comparison, document generation
|  |- etl-documents/         # Document ETL over manifest.json
|  |- etl-webcrawl/          # Web-content ETL over web_manifest.json
|  \- etl-claims-line/       # Claims and activity-log ETL
|- infra/db/init/            # PostgreSQL schema, indexes, and stored procedures
|  \- 13_analytics_feedback.sql  # chat_logs, chat_feedback, sp_analytics_summary
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
| Tests | Jest (unit + RAG regression integration) |
