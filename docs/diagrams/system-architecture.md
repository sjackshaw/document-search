# System Architecture

All services run locally under Docker Compose. The three ETL containers are short-lived batch jobs; the five long-running services (PostgreSQL, Ollama, and the three application servers) stay up after `npm run setup`.

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

    subgraph Apps["Application Services"]
        app["app\nSearch UI + API\nlocalhost:3000"]
        genai["genai-search\nRAG Chat + Analytics\nlocalhost:3001"]
        member["member-benefits-app\nMember Benefits\nlocalhost:3002"]
    end

    subgraph Users["Users"]
        browser(("Browser"))
    end

    pdfs --> etl_docs
    html --> etl_web
    claims_json --> etl_claims

    etl_docs -- "upsert document chunks\n(HNSW embeddings)" --> postgres
    etl_web -- "upsert web chunks\n(HNSW embeddings)" --> postgres
    etl_claims -- "upsert claims\n(HNSW embeddings)" --> postgres

    app -- "vector search\n(sp_search_documents,\nsp_search_web)" --> postgres
    genai -- "vector search\n(sp_search_all)\nchat logs + feedback" --> postgres
    member -- "claims queries\nchat logs" --> postgres

    genai -- "stream chat\n(qwen2.5:3b)" --> ollama

    browser --> app
    browser --> genai
    browser --> member
```

## Port Reference

| Container | Host Port | Notes |
|---|---|---|
| `postgres` | `5433` | Maps to container port `5432` |
| `app` | `3000` | Search UI served at `/`; Admin UI at `/admin.html` |
| `genai-search` | `3001` | Chat UI at `/`; Analytics dashboard at `/analytics.html` |
| `member-benefits-app` | `3002` | Member UI at `/`; all `/api/*` routes require `x-api-key` |
| `ollama` | `11434` | Internal; used only by `genai-search` |
| `etl-documents` | — | Batch job; exits after each cron run |
| `etl-webcrawl` | — | Batch job; exits after each cron run |
| `etl-claims-line` | — | Batch job; exits after each cron run |

## Service Dependencies

```mermaid
graph TD
    postgres["postgres\n(healthcheck)"]
    ollama["ollama\n(healthcheck)"]
    app["app"] --> postgres
    genai["genai-search"] --> postgres
    genai --> ollama
    member["member-benefits-app"] --> postgres
    etl_docs["etl-documents"] --> postgres
    etl_web["etl-webcrawl"] --> postgres
    etl_claims["etl-claims-line"] --> postgres
```
