# Documentation Review Report — document-search

**Date**: March 16, 2026  
**Scope**: README, AWS Production Architecture doc, code comments, API documentation, setup instructions, environment variables

---

## Executive Summary

The README reflects an earlier version of the project that had only **two services** (app + etl-documents). The project has since grown to **five services** (app, etl-documents, etl-webcrawl, genai-search, ollama), but the README has not been updated to match. The AWS Production Architecture doc is thorough and largely accurate. Major gaps are in the README — the GenAI chat service, web crawl pipeline, and half the API surface are completely undocumented.

---

## 1. README Completeness

### 1.1 Opening description — Inaccurate

> "Semantic search over benefits documents — containerized app with a **single ETL pipeline** and PostgreSQL + pgvector."

There are now **two** ETL pipelines (documents + web crawl) and a **GenAI chat service** backed by Ollama. The description should reflect all three capabilities: semantic search, web content search, and RAG-powered chat.

### 1.2 Architecture table — Stale (shows 3 of 6 containers)

| Documented | Actual |
|---|---|
| postgres (5433→5432) | postgres (5433→5432) |
| app (3000) | app (3000) |
| etl-documents | etl-documents |
| — | **etl-webcrawl** (missing) |
| — | **ollama** (11434) (missing) |
| — | **genai-search** (3001) (missing) |

### 1.3 Data Flow — Incomplete

The documented flow only covers PDFs:
```
1,500 PDFs → ETL (pdf-parse + SBERT) → PostgreSQL → Search API
```

Missing the parallel web content flow:
```
700 HTML pages → ETL (SBERT) → PostgreSQL → Search API
```

And the GenAI flow:
```
User question → embed → pgvector retrieval → Ollama LLM → streamed answer
```

### 1.4 "pdf-parse" claim — Inaccurate

The README lists `pdf-parse` in both the Data Flow and Technology Stack table. However:
- `etl-documents/package.json` has **no `pdf-parse` dependency**
- `etl-documents/vectorize.js` reads pre-extracted text from `manifest.json`, not from PDF files
- The synthetic generator (`generate_synthetic.py`) creates both PDFs (for UI viewing) and a manifest with text already extracted

The ETL does not parse PDFs — the manifest is the input.

### 1.5 API Endpoints table — Shows 6 of 14 endpoints

| Endpoint | Documented? |
|---|---|
| `GET /api/search?q=` | Yes |
| `GET /api/search/pages?q=` | Yes |
| `GET /api/search/web?q=` | **No** |
| `GET /api/search/all?q=` | **No** |
| `GET /api/documents` | Yes |
| `GET /api/documents/:filename` | Yes |
| `GET /api/web-sources` | **No** |
| `GET /api/web-pages/:filename` | **No** |
| `GET /api/pdfs/:filename` | **No** |
| `GET /api/etl-jobs` | Yes |
| `GET /health` (app) | Yes |
| `POST /api/chat` (genai-search, SSE streaming) | **No** |
| `POST /api/ask` (genai-search, non-streaming) | **No** |
| `GET /health` (genai-search, includes Ollama status) | **No** |

Additionally, documented endpoints omit query parameters: `limit` and `offset` for `/api/documents` and `/api/web-sources` are not mentioned.

### 1.6 Query Examples — Only covers document search

No examples for:
- Web content search (`/api/search/web?q=...`)
- Unified search (`/api/search/all?q=...`)
- GenAI chat (`POST /api/chat` or `POST /api/ask`)
- Web sources listing (`/api/web-sources`)
- PDF serving (`/api/pdfs/:filename`)

### 1.7 Quick Start "What setup does" list — Incomplete

README says setup will:
1. Create `.env` from `.env.example`
2. Generate 1,500 synthetic benefit PDFs
3. Build all Docker images in parallel
4. Start PostgreSQL, wait for healthy
5. Start the search app and ETL service

Actual `startup/setup.sh` also does (not documented):
- Generate 700 synthetic web pages (`generate_synthetic_web.py`)
- Verify database schema
- Pull Ollama model (`qwen2.5:3b`) — can take several minutes on first run
- Print URLs for both services (3000 and 3001) plus Ollama (11434)

### 1.8 Commands section — Missing one command

`npm run generate-web-data` is defined in the root `package.json` but not listed in the README's Commands section.

### 1.9 Project Structure — Significantly outdated

Missing from the tree:
- `services/etl-webcrawl/` (entire service)
- `services/genai-search/` (entire service)
- `docker-compose.etl-webcrawl.yml`
- `docker-compose.genai-search.yml`
- `generate_synthetic_web.py`
- `docs/` directory (where the README itself lives)
- SQL init scripts: `07_web_sources_table.sql` through `10_web_stored_procedures.sql`

### 1.10 Technology Stack table — Incomplete

Missing entries:
- **LLM**: Ollama + Qwen 2.5 3B
- **LLM framework**: Ollama (local inference server)
- **Session store**: In-memory Map (30-min TTL)
- **Web content**: Synthetic HTML pages

The `pdf-parse` entry is inaccurate (see 1.4).

---

## 2. AWS Production Architecture Document

### What's good

This is a **well-written, comprehensive** document. Specific strengths:

- **PoC vs Production table** correctly lists all 6 PoC components (including Ollama + Qwen 2.5 3B, web content source)
- **Embedding model section** gives informed recommendations with dimension trade-offs
- **LLM section** has good model comparisons with cost estimates
- **SharePoint connector design** is detailed and security-conscious (`Sites.Selected` over `Sites.Read.All`)
- **Umbraco integration** covers three approaches (API, crawl, webhook) with clear recommendations
- **ETL error handling** is practical and specific
- **Migration phases** are well-sequenced (5 phases: data → ETL → search → GenAI → hardening)
- **ASCII architecture diagram** is clear and covers both ETL pipelines + both API services
- **Cost estimates** cover multiple tiers with totals

### Issues found

| # | Issue | Detail |
|---|---|---|
| 1 | Container count wording | Section 4 says "Four Node.js containers" — accurate for Node.js services, but could confuse readers since the full stack is 6 containers including postgres and ollama. |
| 2 | Missing frontend detail | Doesn't note that the PoC has two separate HTML frontends served by two different Express apps at different ports. |
| 3 | Claude model reference | May reference older Claude model versions — verify against current Bedrock availability. |
| 4 | Missing Cohere Rerank cost | Cost table estimates LLM and embedding costs but doesn't include Cohere Rerank. |

### Overall assessment: **Strong** — no significant inaccuracies or gaps.

---

## 3. Code Comments

### `services/app/src/index.js`
- **Adequate structure**: Section comments like `// Static UI`, `// Health check`, `// ── Web content routes ──` provide good navigation
- **Missing**: No JSDoc on any function. The `embed()` function's BGE query prefix isn't explained
- **Missing**: No explanation of `sp_search_documents_filtered` vs `sp_search_documents`

### `services/genai-search/src/index.js`
- **Good structure**: Clean section dividers (`// ── Embedding ──`, `// ── Session store ──`, etc.)
- **SYSTEM_PROMPT** is well-defined and visible
- **Missing**: `retrieveContext()` context-building logic (truncating to `MAX_CONTEXT_CHARS`) isn't documented
- **Missing**: Why `slice(-20)` for recent history (10 exchanges × 2 messages each) isn't explained
- **Missing**: SSE streaming protocol for `/api/chat` isn't documented

### `services/app/src/queryParser.js`
- **No comments at all** — the category alias table and noise word stripping should have brief explanations
- The parsing order matters but isn't explained

### ETL scripts
- Good: `CHUNK_SIZE = 500` and `CHUNK_OVERLAP = 50` are defined as constants
- Missing: No explanation of why these chunk/overlap values were chosen
- Good: Thorough `[ETL]` log prefixes for all operations

---

## 4. API Documentation

### Request/Response formats — Not documented anywhere

No endpoint has its request body, query parameters, or response schema documented. Key examples:

**`POST /api/chat`** (genai-search, streaming):
- Request: `{ "question": string, "sessionId"?: string }`
- Response: SSE stream — `data: {"token": "..."}\n\n` per chunk, `data: {"done": true}\n\n` at end
- Headers: `X-Session-Id`, `X-Sources` (base64-encoded JSON array)

**`POST /api/ask`** (genai-search, non-streaming):
- Request: `{ "question": string, "sessionId"?: string }`
- Response: `{ "sessionId": string, "answer": string, "sources": [...] }`

**`GET /api/search?q=`** (app):
- Response: `{ "query": string, "parsed": { "rawQuery", "cleanedQuery", "category" }, "results": [...], "count": number }`

**`GET /api/documents`** (app):
- Query params: `category`, `limit` (max 200), `offset`
- Response: `{ "documents": [...], "total": number, "limit": number, "offset": number }`

---

## 5. Setup Instructions

### Prerequisites — Not listed

The README jumps straight to `npm run setup` without listing:
- Docker + Docker Compose (required)
- Python 3 (required for data generation)
- `pip3` / `fpdf2` (installed automatically by setup.sh, but worth noting)
- ~2 GB free disk for Ollama model download
- Sufficient RAM for running all containers + Ollama + embedding model

### Ollama model pulling — Not documented

The setup script pulls `qwen2.5:3b` automatically but this can fail silently. The README should note:
- First run downloads ~1.9 GB model
- Manual fallback: `docker exec document-search-ollama ollama pull qwen2.5:3b`
- The `OLLAMA_MODEL` env var can override the default model

### Teardown — Accurate but underdocumented

`teardown.sh` runs `docker compose down --remove-orphans` then `down -v` (removes volumes). The README's `npm run teardown` description says "Stop containers and remove volumes" which is accurate.

---

## 6. Environment Variables

### `.env.example` — Incomplete

Missing from `.env.example` (these are used in docker-compose files with defaults):

| Variable | Used By | Default | Purpose |
|---|---|---|---|
| `OLLAMA_MODEL` | genai-search | `qwen2.5:3b` | LLM model name |
| `RAG_TOP_K` | genai-search | `10` | Number of chunks to retrieve |
| `MAX_CONTEXT_CHARS` | genai-search | `6000` | Max context fed to LLM |

### Environment variable documentation — None

The README has no environment variable reference table. The `.env.example` has no comments.

### `API_KEY` — Unused in code

`API_KEY` is set in `docker-compose.app.yml` and in `.env.example`, but the app's `index.js` **never reads or enforces it**. This is misleading — it suggests the API is protected when it isn't.

---

## 7. Missing Documentation Summary

### High priority (functional gaps)

| # | Gap | Impact |
|---|---|---|
| 1 | **GenAI chat service** — no mention in README | Users won't know the chat feature exists or how to access it (port 3001) |
| 2 | **Web crawl pipeline** — no mention in README | Users won't know about the web content search capability |
| 3 | **8 undocumented API endpoints** | Over half the API surface is invisible to readers |
| 4 | **Session management** — not documented | In-memory sessions, 30-min TTL, auto-purge, `X-Session-Id` header — all undiscoverable |
| 5 | **Streaming protocol** — not documented | The `POST /api/chat` SSE event format is required for client integration |
| 6 | **Environment variable reference** | No comprehensive list; genai-search vars missing from `.env.example` |

### Medium priority (accuracy/usability)

| # | Gap | Impact |
|---|---|---|
| 7 | **pdf-parse listed but not used** | Misleading technology stack |
| 8 | **`API_KEY` set but unenforced** | False sense of security |
| 9 | **Prerequisites not listed** | Setup may fail without Python 3 or Docker |
| 10 | **Project structure outdated** | Doesn't reflect actual repository layout |
| 11 | **Ollama model requirements** | No mention of ~2 GB download, RAM needs, or manual pull fallback |

### Low priority (nice-to-have)

| # | Gap |
|---|---|
| 12 | No response schema examples for any endpoint |
| 13 | No troubleshooting section (Ollama failures, port conflicts) |
| 14 | `generate_synthetic_web.py` not mentioned in README |
| 15 | Database schema overview not referenced |

---

## Summary Scorecard

| Area | Rating | Notes |
|---|---|---|
| README completeness | **Poor** | Reflects ~50% of the project; genai-search and web crawl pipeline entirely missing |
| AWS architecture doc | **Excellent** | Comprehensive, accurate, well-structured |
| Code comments | **Adequate** | Good section markers; lacks JSDoc and algorithmic explanations |
| API documentation | **Poor** | 8 of 14 endpoints undocumented; no request/response schemas |
| Setup instructions | **Fair** | Works for `npm run setup` but missing prerequisites and Ollama details |
| Project structure | **Poor** | Missing 3 services, 2 compose files, and several other paths |
| Environment variables | **Poor** | Incomplete `.env.example`; no reference table; `API_KEY` is dead code |
| AWS doc internal consistency | **Excellent** | PoC descriptions match actual code; migration phases logically ordered |
