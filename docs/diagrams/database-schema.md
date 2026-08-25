# Database Schema

The database has three independent content pipelines (documents, web content, claims) and three cross-cutting support tables (chat logging, ETL job history, and per-field ETL change logging).

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
        timestamptz log_timestamp
        text member_id
        text member_email
        text claim_id
        text event_type
        text notes
        vector_384 embedding
        timestamptz created_at
    }

    etl_change_logs {
        serial id PK
        text source_table
        text member_email
        text change_type
        text field_name
        text old_value
        text new_value
        int job_id
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
    claims ||--o{ claims_logs : "has activity log\n(by claim_id, not enforced by FK)"
    etl_job_logs ||--o{ etl_change_logs : "has field-level changes\n(by job_id, not enforced by FK)"
    chat_logs ||--o| chat_feedback : "has feedback"
```

## Index Summary

| Table | Index type | Column(s) | Purpose |
|---|---|---|---|
| `document_pages` | HNSW cosine | `embedding` | Semantic page-level search |
| `document_chunks` | HNSW cosine | `embedding` | Semantic chunk-level search |
| `web_chunks` | HNSW cosine | `embedding` | Semantic web-content search |
| `claims` | HNSW cosine | `embedding` | Semantic claims search (index exists; no search procedure uses it yet) |
| `claims` | B-tree | `(member_id, service_date DESC)` | Member claim lookups |
| `claims` | B-tree | `member_email` | Email-based member resolution |
| `claims` | B-tree | `status` | Open/closed claim filtering |
| `claims_logs` | HNSW cosine | `embedding` | Semantic claim-activity search (index exists; no search procedure uses it yet) |
| `claims_logs` | B-tree | `(member_id, log_timestamp DESC)` | Member activity lookups |
| `claims_logs` | B-tree | `claim_id` | Per-claim activity lookups |
| `etl_change_logs` | B-tree | `(source_table, created_at DESC)` | Change-log time-window queries |
| `etl_change_logs` | B-tree | `member_email` | Per-member change lookups |
| `etl_change_logs` | B-tree | `job_id` | Per-job change lookups |
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

Note: `claims` and `claims_logs` have embeddings and HNSW indexes but no semantic search procedure exists yet. The chat routes' member-context feature (`services/portal/src/routes/chat.js`) reads claims with plain SQL (`getOpenClaims`, `getClaimsSummary`, `getDeductibleStatus`), not vector search. See the "Merge the member bot into chat" discussion for the tradeoffs of adding a `sp_search_claims`.

## Claims ETL Procedures

| Procedure | Type | Purpose |
|---|---|---|
| `sp_upsert_claim(...)` | PROCEDURE (`CALL`) | Insert/update a claim row |
| `sp_get_existing_claims()` | FUNCTION (`SELECT`) | Fetch all claims for change-detection diffing |
| `sp_delete_claim(claim_id)` | PROCEDURE (`CALL`) | Remove a claim no longer present in the source |
| `sp_insert_claim_log(...)` | PROCEDURE (`CALL`) | Insert a claims activity-log row |
| `sp_truncate_claims_logs()` | PROCEDURE (`CALL`) | Clear `claims_logs` before a full reload |
| `sp_etl_log_change(...)` | PROCEDURE (`CALL`) | Insert a field-level change record into `etl_change_logs` |
| `sp_etl_start_job(service, phase, target_table)` | FUNCTION (`SELECT`) | Start an `etl_job_logs` row, returns `job_id` |
| `sp_etl_complete_job(job_id, ...)` | FUNCTION (`SELECT`) | Mark an ETL job completed with counts |
| `sp_etl_fail_job(job_id, error)` | FUNCTION (`SELECT`) | Mark an ETL job failed with an error message |

**Note on `CALL` vs `SELECT`:** `sp_etl_start_job`, `sp_etl_complete_job`, and `sp_etl_fail_job` are SQL **functions**, not procedures, so they must be invoked with `SELECT`. All other procedures in this table (`sp_upsert_claim`, `sp_delete_claim`, `sp_insert_claim_log`, `sp_truncate_claims_logs`, `sp_etl_log_change`) are real `PROCEDURE`s and must be invoked with `CALL`. Mixing these up raises `... is not a procedure` (PostgreSQL error code `42809`) — a real bug found and fixed in `services/etl-claims-line/vectorize.js` on 2026-08-24.
