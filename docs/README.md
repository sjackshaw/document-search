# Document Search

Semantic search and RAG-powered AI chat over benefits documents — containerized with dual ETL pipelines, Ollama-backed GenAI, and PostgreSQL + pgvector.

## Quick Start

```bash
# One command to set up everything (generates data, builds images, starts stack)
npm run setup
```

The setup script will:
1. Create `.env` from `.env.example` if missing
2. Generate 1,500 synthetic benefit PDFs (requires Python 3 + `fpdf2`)
3. Generate ~700 synthetic benefits web pages
4. Generate synthetic member benefits claims
5. Build all Docker images in parallel
6. Start PostgreSQL, wait for healthy
7. Start all services (search app, GenAI chat, member benefits bot, all ETL pipelines, Ollama)

## Architecture

| Container | Port | Description |
|---|---|---|
| **postgres** | 5433 → 5432 | PostgreSQL 15 + pgvector — documents, web pages, chunks, embeddings |
| **app** | 3000 | Express search API — semantic search via SBERT embeddings |
| **genai-search** | 3001 | RAG-powered AI chat — streams answers from Ollama with cited sources |
| **ollama** | 11434 | Local LLM inference server (default model: `qwen2.5:3b`) |
| **etl-documents** | — | ETL pipeline — extracts PDF text, chunks, vectorises, loads to Postgres |
| **etl-webcrawl** | — | ETL pipeline — processes HTML pages, chunks, vectorises, loads to Postgres |
| **member-benefits-app** | 3002 | Separate member-facing benefits bot — member-scoped claims, plan details, and generated benefit documents |
| **etl-claims-line** | — | ETL pipeline — vectorises synthetic member claims + claims activity logs, loads to Postgres (isolated from document search/GenAI) |

The Member Benefits Bot pairs with document search: it lets an authenticated member ask a GenAI-style bot about their own benefits, claims, and plan details, and request generation of key benefit documents (EOB, SPD, enrollment/beneficiary forms) on demand. It runs independently on its own port and Postgres tables (`claims`, `claims_logs`), isolated from the document search schema.

### Data Flow

```
1,500 PDFs    →  ETL-documents (pdf-parse + SBERT)  ─┐
                                                      ├→  PostgreSQL (pgvector)  →  Search API (port 3000)
~700 Web pages →  ETL-webcrawl (HTML + SBERT)        ─┘                          →  GenAI Chat (port 3001) → Ollama LLM
```

- **Extract (PDFs):** `pdf-parse` reads each PDF, splits into pages
- **Extract (Web):** HTML pages are parsed and split into sections
- **Transform:** Content is split into overlapping text chunks (500 chars, 50 overlap); each chunk is embedded with BGE (`Xenova/bge-small-en-v1.5`, 384 dims)
- **Load:** Documents, pages, and chunks upserted into Postgres via stored procedures with HNSW vector indexes
- **GenAI:** User questions are embedded, top-K relevant chunks retrieved, and fed as context to Ollama for grounded, cited answers

## API Endpoints

### Search API (port 3000)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/search?q=...` | Semantic search across document chunks |
| `GET` | `/api/search/pages?q=...` | Coarser page-level search |
| `GET` | `/api/documents` | List all documents (with `?category=` filter) |
| `GET` | `/api/documents/:filename` | Lookup a document by filename |
| `GET` | `/api/etl-jobs` | ETL job history |
| `GET` | `/health` | Health check |

### GenAI Chat API (port 3001)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/chat` | Streaming RAG chat — SSE response with cited sources |
| `POST` | `/api/ask` | Non-streaming RAG chat — JSON response with answer + sources |
| `GET` | `/health` | Health check (includes Ollama connectivity) |

The chat endpoints accept `{ "question": "...", "sessionId": "..." }`. Sessions maintain conversation history for multi-turn dialogue (30-minute TTL). Sources are returned via `X-Sources` header (base64 JSON) for streaming, or in the response body for `/api/ask`.

### Query Examples

```bash
# Basic semantic search
curl "http://localhost:3000/api/search?q=401k%20matching%20contributions"

# Category-filtered search
curl "http://localhost:3000/api/search?q=category:dental%20how%20to%20file%20a%20claim"

# List dental documents
curl "http://localhost:3000/api/documents?category=dental"

# GenAI chat (non-streaming)
curl -X POST http://localhost:3001/api/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "What is the 401k employer match?"}'

# GenAI chat (streaming)
curl -N -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{"question": "How do I enroll in dental insurance?"}'
```

## Document Categories

The 1,500 synthetic PDFs span 14 benefits categories:

| Category | Weight | Approx Count |
|---|---|---|
| Health Insurance | 15% | ~225 |
| Retirement / 401(k) | 12% | ~180 |
| Dental | 10% | ~150 |
| Vision | 8% | ~120 |
| Life Insurance | 8% | ~120 |
| Disability (STD/LTD) | 8% | ~120 |
| Paid Time Off | 8% | ~120 |
| FMLA | 7% | ~105 |
| COBRA | 5% | ~75 |
| HSA | 5% | ~75 |
| FSA | 4% | ~60 |
| Wellness / EAP | 4% | ~60 |
| Tuition Reimbursement | 4% | ~60 |
| Open Enrollment | 2% | ~30 |

Each PDF is 3–10 pages long with realistic benefits language.

## Commands

```bash
npm run setup           # Full bootstrap (generate data + build + start)
npm run teardown        # Stop containers and remove volumes
npm run dev:up          # Start all services
npm run dev:down        # Stop all services
npm run dev:build       # Rebuild images
npm run dev:logs        # Tail logs from all services
npm run dev:ps          # Show running containers
npm run generate-data        # Regenerate synthetic PDFs
npm run generate-web-data    # Regenerate synthetic web pages
npm run generate-claims-data # Regenerate synthetic member benefits claims
```

## Project Structure

```
document-search/
├── services/
│   ├── app/                          # Express search API (port 3000)
│   │   ├── src/
│   │   │   ├── index.js              # Routes, search, document endpoints
│   │   │   └── queryParser.js        # Query preprocessing, category detection
│   │   ├── test/
│   │   ├── Dockerfile
│   │   └── package.json
│   ├── genai-search/                 # RAG-powered GenAI chat (port 3001)
│   │   ├── src/
│   │   │   └── index.js              # Chat endpoints, RAG retrieval, Ollama streaming
│   │   ├── public/
│   │   │   └── index.html            # Chat UI
│   │   ├── test/
│   │   ├── Dockerfile
│   │   └── package.json
│   ├── etl-documents/                # PDF ETL pipeline
│   │   ├── vectorize.js              # Extract → chunk → embed → load
│   │   ├── data/pdfs/                # Generated PDFs (git-ignored)
│   │   ├── Dockerfile
│   │   └── package.json
│   ├── etl-webcrawl/                 # Web page ETL pipeline
│   │   ├── vectorize.js              # Extract → chunk → embed → load
│   │   ├── data/pages/               # Generated HTML pages (git-ignored)
│   │   ├── Dockerfile
│   │   └── package.json
│   ├── member-benefits-app/          # Member benefits bot (port 3002)
│   │   ├── src/
│   │   │   ├── index.js              # Routes, member resolution, document generation
│   │   │   └── member-benefits.js    # Claims/plan queries, HTML document rendering
│   │   ├── test/
│   │   ├── Dockerfile
│   │   └── package.json
│   └── etl-claims-line/              # Claims ETL pipeline (isolated from doc search)
│       ├── vectorize.js              # Extract → embed → load claims + claims_logs
│       ├── data/                     # primary.json + logs.json (committed seed data)
│       ├── Dockerfile
│       └── package.json
├── lib/
│   └── embedding.js                  # Shared embedding utilities (BGE model)
├── infra/db/init/                    # PostgreSQL init scripts
│   ├── 01_create_schema.sql          # pgvector extension
│   ├── 02_documents_table.sql        # documents table
│   ├── 03_document_pages_table.sql   # pages + HNSW index
│   ├── 04_document_chunks_table.sql  # chunks + HNSW index
│   ├── 05_etl_job_logs.sql           # ETL job tracking
│   ├── 06_stored_procedures.sql      # Document query + ETL procedures
│   ├── 07_web_sources_table.sql      # Web sources table
│   ├── 08_web_sections_table.sql     # Web sections table
│   ├── 09_web_chunks_table.sql       # Web chunks + HNSW index
│   ├── 10_web_stored_procedures.sql  # Web query + ETL procedures
│   ├── 11_claims.sql                 # claims table + HNSW index + procedures
│   └── 12_claims_logs.sql            # claims_logs table + HNSW index + procedures
├── startup/
│   ├── setup.sh                      # Bootstrap script
│   └── teardown.sh                   # Cleanup script
├── docker-compose.postgres.yml
├── docker-compose.app.yml
├── docker-compose.etl-documents.yml
├── docker-compose.etl-webcrawl.yml
├── docker-compose.genai-search.yml   # GenAI chat + Ollama
├── docker-compose.etl-claims-line.yml
├── docker-compose.member-benefits-app.yml
├── generate_synthetic.py             # PDF generation (1,500 docs)
├── generate_synthetic_web.py         # Web page generation (~700 pages)
├── generate_synthetic_claims.py      # Synthetic member benefits claims generation
├── seed_claims.py / seed_claims.sql  # Manual claims seed helper (alternative to etl-claims-line)
├── package.json
├── eslint.config.mjs
├── .env.example
└── .gitignore
```

## Technology Stack

| Component | Technology |
|---|---|
| Runtime | Node.js 22 |
| Framework | Express 4.x |
| Database | PostgreSQL 15 + pgvector |
| LLM Inference | Ollama (default: qwen2.5:3b) |
| Embedding Model | BGE (Xenova/bge-small-en-v1.5, 384 dims) |
| PDF Parsing | pdf-parse |
| Vectorisation | @xenova/transformers (ONNX) |
| Scheduling | node-cron |
| Containers | Docker Compose |
