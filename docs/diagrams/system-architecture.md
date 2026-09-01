# System Architecture

All services run locally under Docker Compose. The three ETL containers are short-lived batch jobs. Search, RAG chat, and the member benefits assistant are unified into a single `portal` service/container; PostgreSQL and Ollama are the only other long-running containers.

```mermaid
graph LR
    subgraph Sources["Data Sources (local)"]
        pdfs[("Synthetic PDFs\n+ manifest.json")]
        html[("Synthetic HTML\n+ web_manifest.json")]
        claims_json[("Synthetic Claims\nprimary.json / logs.json")]
    end

    subgraph ETL["ETL Services (batch, no port)"]
        etl_docs["etl-documents"]
        etl_web["etl-webcrawl"]
        etl_claims["etl-claims-line"]
    end

    subgraph DB["Data Layer"]
        postgres[("PostgreSQL 15\n+ pgvector\nlocalhost:5433")]
    end

    subgraph LLM["LLM Runtime"]
        ollama["Ollama\nlocalhost:11434"]
    end

    subgraph Portal["portal (single container) — localhost:3000"]
        search_ui["/search\nDocument + web search UI"]
        chat_ui["/chat\nRAG chat UI (+ member dropdown)"]
        member_ui["/member\nMember benefits UI"]
        admin_ui["/admin.html\nContent admin"]
        shell["/\nTab shell (embeds the three UIs via iframe)"]
    end

    subgraph Users["Users"]
        browser(("Browser"))
    end

    pdfs --> etl_docs
    html --> etl_web
    claims_json --> etl_claims

    etl_docs -- "upsert document chunks\n(HNSW embeddings)" --> postgres
    etl_web -- "upsert web chunks\n(HNSW embeddings)" --> postgres
    etl_claims -- "upsert claims + claims_logs\n(HNSW embeddings)" --> postgres

    search_ui -- "vector search\n(sp_search_documents, sp_search_web,\nsp_search_all)" --> postgres
    chat_ui -- "vector search\n(sp_search_all)\n+ member claims lookup (optional)\nchat logs + feedback" --> postgres
    member_ui -- "claims queries\nchat_logs (bot)" --> postgres

    chat_ui -- "stream chat\n(qwen2.5:3b)" --> ollama

    browser --> shell
    shell --> search_ui
    shell --> chat_ui
    shell --> member_ui
    browser --> admin_ui
```

## Port Reference

| Container | Host Port | Notes |
|---|---|---|
| `postgres` | `5433` (`${POSTGRES_HOST_PORT}`) | Maps to container port `5432` |
| `portal` | `3000` (`${PORTAL_HOST_PORT}`) | Single container serving all three UIs and their APIs — see paths below |
| `ollama` | `11434` (`${OLLAMA_HOST_PORT}`) | Internal; used only by the chat routes in `portal` |
| `etl-documents` | — | Batch job; exits after each cron run |
| `etl-webcrawl` | — | Batch job; exits after each cron run |
| `etl-claims-line` | — | Batch job; exits after each cron run |

All three host ports are parameterized via environment variables (defaulting to the values above) so a second `portal` stack can be run side-by-side on alternate ports for review/demo purposes without editing the Compose files.

### `portal` paths

| Path | Purpose |
|---|---|
| `/` | Unified tab shell — embeds `/search`, `/chat`, and `/member` via same-origin iframes |
| `/search` | Document + web search UI (pure vector search, no personalization) |
| `/chat` | RAG chat UI; includes a "Chatting as" member dropdown for demo personalization |
| `/member` | Member benefits UI (claims, plan details, deductible, document generation, rule-based bot) |
| `/admin.html` | Content admin (documents + web sources), gated by `X-Admin-Key` when `ADMIN_KEY` is set |
| `/api/*` | Search + admin API |
| `/api/chat`, `/api/ask`, `/api/feedback`, `/api/analytics/*`, `/api/chat/members` | Chat API |
| `/api/member/*` | Member-scoped API, gated by `X-API-Key` when `API_KEY` is set and by member resolution |

## Service Dependencies

```mermaid
graph TD
    postgres["postgres\n(healthcheck)"]
    ollama["ollama\n(healthcheck)"]
    portal["portal"] --> postgres
    portal --> ollama
    etl_docs["etl-documents"] --> postgres
    etl_web["etl-webcrawl"] --> postgres
    etl_claims["etl-claims-line"] --> postgres
```
