# document-search

Semantic search, RAG chat, and a member-facing benefits assistant over synthetic benefits content. The full documentation lives in [docs/README.md](docs/README.md).

## Quick Start

```bash
npm run setup
```

When setup completes:

| Service | URL | Purpose |
|---|---|---|
| Search UI | `http://localhost:3000` | Semantic search across documents and web content |
| Admin dashboard | `http://localhost:3000/admin.html` | Manage indexed documents and web sources |
| GenAI chat UI | `http://localhost:3000/chat` | RAG-powered chat with analytics dashboard (`/chat/analytics.html`) |
| Member benefits UI | `http://localhost:3000/member` | Claims, plan details, enrollment comparison, and document generation |
| Ollama | `http://localhost:11434` | Local LLM runtime |
| PostgreSQL | `localhost:5433` | PostgreSQL 15 + pgvector |

All three experiences are served by the single `portal` service/container (`services/portal`); only Postgres and Ollama run as separate containers.

## Teardown

```bash
npm run teardown
```

## Documentation

| Document | Description |
|---|---|
| [docs/README.md](docs/README.md) | Full setup, API reference, data-flow diagrams, and environment variable reference |
| [docs/TECH_STACK.md](docs/TECH_STACK.md) | Current technology stack — runtime, frameworks, database, models, and tooling |
| [docs/AWS_PRODUCTION_ARCHITECTURE.md](docs/AWS_PRODUCTION_ARCHITECTURE.md) | AWS migration path: PoC-to-production mapping with service recommendations and cost estimates |
| [docs/AWS_COST_PROJECTION.md](docs/AWS_COST_PROJECTION.md) | Detailed monthly/annual AWS cost projection, alternate configurations, and key cost decisions |
| [docs/diagrams/](docs/diagrams/) | Mermaid diagrams: system architecture, database schema, RAG chat sequence, ETL pipeline |
| [docs/AI_RAG_REVIEW.md](docs/AI_RAG_REVIEW.md) | Review of the embedding model, chunking strategy, RAG pipeline, and prompt engineering |
| [docs/DATA_REVIEW.md](docs/DATA_REVIEW.md) | Schema design, pgvector configuration, stored-procedure analysis, and ETL patterns |
| [docs/CODE_QUALITY_REVIEW.md](docs/CODE_QUALITY_REVIEW.md) | Code quality findings: service structure, Docker, error handling, and test coverage |
| [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md) | OWASP Top 10 security analysis across all services and infrastructure |
