# Database Schema

The database has three independent content pipelines (documents, web content, claims) and two cross-cutting support tables (chat logging and ETL job history).

```mermaid
erDiagram
    documents {
        serial id PK
        text filename UK
        text title
        text category
        int page_count
        int total_chars
        timestamptz created_at
        timestamptz updated_at
    }
    document_pages {
        serial id PK
        int document_id FK
        int page_number
        text page_text
        int char_count
        vector_384 embedding
        timestamptz created_at
    }
    document_chunks {
        serial id PK
        int page_id FK
        int chunk_index
        text chunk_text
        vector_384 embedding
        timestamptz created_at
    }

    web_sources {
        serial id PK
        text url UK
        text title
        text category
        timestamptz crawled_at
        timestamptz created_at
        timestamptz updated_at
    }
    web_sections {
        serial id PK
        int source_id FK
        int section_index
        text section_label
        text section_text
        int char_count
        timestamptz created_at
    }
    web_chunks {
        serial id PK
        int section_id FK
        int chunk_index
        text chunk_text
        vector_384 embedding
        timestamptz created_at
    }

    claims {
        serial id PK
        text member_id
        text member_email
        text claim_id UK
        text claim_type
        date service_date
        text provider
        numeric amount_billed
        numeric amount_paid
        int plan_year
        text status
        vector_384 embedding
        timestamptz created_at
        timestamptz updated_at
    }
    claims_logs {
        serial id PK
        text claim_id FK
        text event_type
        jsonb payload
        timestamptz event_at
        timestamptz created_at
    }

    chat_logs {
        serial id PK
        text service
        text session_id
        text question
        int sources_count
        int answer_length
        boolean escalation_flagged
        text_array escalation_signals
        timestamptz created_at
    }
    chat_feedback {
        serial id PK
        int chat_log_id FK
        text rating
        timestamptz created_at
    }

    etl_job_logs {
        serial id PK
        text service_name
        text phase
        text target_table
        text status
        int records_processed
        int records_created
        int records_updated
        int records_deleted
        text error_message
        timestamptz started_at
        timestamptz completed_at
    }

    documents ||--o{ document_pages : "has pages"
    document_pages ||--o{ document_chunks : "has chunks"
    web_sources ||--o{ web_sections : "has sections"
    web_sections ||--o{ web_chunks : "has chunks"
    claims ||--o{ claims_logs : "has activity log"
    chat_logs ||--o| chat_feedback : "has feedback"
```

## Index Summary

| Table | Index type | Column(s) | Purpose |
|---|---|---|---|
| `document_pages` | HNSW cosine | `embedding` | Semantic page-level search |
| `document_chunks` | HNSW cosine | `embedding` | Semantic chunk-level search |
| `web_chunks` | HNSW cosine | `embedding` | Semantic web-content search |
| `claims` | HNSW cosine | `embedding` | Semantic claims search |
| `claims` | B-tree | `(member_id, service_date DESC)` | Member claim lookups |
| `claims` | B-tree | `member_email` | Email-based member resolution |
| `claims` | B-tree | `status` | Open/closed claim filtering |
| `chat_logs` | B-tree | `(service, created_at DESC)` | Analytics time-window queries |
| `chat_logs` | Partial B-tree | `created_at DESC WHERE escalation_flagged` | Fast escalation dashboard queries |
| `chat_feedback` | Unique B-tree | `chat_log_id` | Prevent duplicate ratings |

## Search Stored Procedures

| Procedure | Input | Searches |
|---|---|---|
| `sp_search_documents(embedding, top_k)` | 384d vector | `document_chunks` |
| `sp_search_documents_filtered(embedding, top_k, category)` | 384d vector + category | `document_chunks` WHERE category |
| `sp_search_pages(embedding, top_k)` | 384d vector | `document_pages` |
| `sp_search_web(embedding, top_k)` | 384d vector | `web_chunks` |
| `sp_search_all(embedding, top_k)` | 384d vector | `document_chunks` UNION ALL `web_chunks` |
| `sp_search_all_filtered(embedding, top_k, category)` | 384d vector + category | Both, filtered by category |
| `sp_analytics_summary(days)` | int | `chat_logs` LEFT JOIN `chat_feedback` |
