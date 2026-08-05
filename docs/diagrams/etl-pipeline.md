# ETL Pipelines

All three ETL services share the same structural pattern: read source data → chunk text → generate BGE embeddings → upsert into PostgreSQL via a stored procedure → log the job result. They differ in their source format and target schema.

## Overview

```mermaid
flowchart LR
    subgraph src["Data Sources"]
        pdfs[("manifest.json\n+ PDF text")]
        html[("web_manifest.json\n+ HTML files")]
        claims_data[("primary.json\n+ logs.json")]
    end

    subgraph shared["Shared — lib/embedding.js"]
        embed_fn["embed() / embedBatch()\nXenova BGE-small-en-v1.5\n384d ONNX"]
        chunk_fn["chunkText()\n500 chars / 50-char overlap"]
    end

    subgraph etl_docs["etl-documents (node-cron)"]
        d1["Read manifest.json\n(title, category, pages[])"]
        d2["chunkText per page"]
        d3["embedBatch (64 chunks/batch)"]
        d4["sp_upsert_document_page\nsp_upsert_document_chunk\nON CONFLICT UPDATE"]
    end

    subgraph etl_web["etl-webcrawl (node-cron)"]
        w1["Parse web_manifest.json\n+ section HTML"]
        w2["chunkText per section"]
        w3["embedBatch (64 chunks/batch)"]
        w4["sp_upsert_web_source\nsp_upsert_web_section\nsp_upsert_web_chunk\nON CONFLICT UPDATE"]
    end

    subgraph etl_claims["etl-claims-line (node-cron)"]
        c1["Read primary.json (claims)\n+ logs.json (activity)"]
        c2["Diff against existing rows\n(field-level change detection)"]
        c3["embed claim text\n(type + provider + status)"]
        c4["sp_upsert_claim\nsp_etl_log_change\nON CONFLICT UPDATE"]
    end

    subgraph pg["PostgreSQL"]
        doc_tables[("document_chunks\ndocument_pages\ndocuments")]
        web_tables[("web_chunks\nweb_sections\nweb_sources")]
        claims_tables[("claims\nclaims_logs")]
        job_logs[("etl_job_logs")]
    end

    pdfs --> d1 --> d2 --> d3 --> d4
    html --> w1 --> w2 --> w3 --> w4
    claims_data --> c1 --> c2 --> c3 --> c4

    d2 -.-> chunk_fn
    w2 -.-> chunk_fn
    d3 -.-> embed_fn
    w3 -.-> embed_fn
    c3 -.-> embed_fn

    d4 --> doc_tables
    w4 --> web_tables
    c4 --> claims_tables

    d4 --> job_logs
    w4 --> job_logs
    c4 --> job_logs
```

## Document ETL Detail

```mermaid
flowchart TD
    A["node-cron fires\n(default: hourly)"] --> B["sp_etl_start_job\n→ job_id"]
    B --> C["Read manifest.json\n(array of document entries)"]
    C --> D{"For each document entry"}
    D --> E["sp_upsert_document\n(filename, title, category)\n→ document_id"]
    E --> F{"For each page in entry.pages"}
    F --> G["chunkText(pageText)\n→ chunks[]"]
    G --> H["embedBatch(chunks, batchSize=64)\n→ embeddings[]"]
    H --> I["sp_upsert_document_page\n(document_id, page_number, text, embedding)"]
    I --> J["sp_upsert_document_chunk\n(page_id, chunk_index, text, embedding)"]
    J --> F
    F -- "all pages done" --> D
    D -- "all docs done" --> K["sp_etl_complete_job\n(processed, created, updated, deleted)"]
    K --> L["Sleep until next cron tick"]
```

## Claims ETL Detail

The claims ETL has an additional field-level **change detection** step that the document and web ETLs omit. This lets it produce an audit log of exactly which fields changed for each claim.

```mermaid
flowchart TD
    A["node-cron fires\n(default: hourly)"] --> B["sp_etl_start_job → job_id"]
    B --> C["sp_get_existing_claims()\n→ existing map keyed by claim_id"]
    C --> D["Read primary.json\n→ incoming claims array"]
    D --> E{"For each incoming claim"}
    E --> F{"claim_id in\nexisting map?"}
    F -- "No (new)" --> G["embed claimText\n(type + provider + status)"]
    F -- "Yes (existing)" --> H["Compare PRIMARY_COMPARE_FIELDS\nfield by field"]
    H --> I{"Fields changed?"}
    I -- "Yes" --> J["sp_etl_log_change\n(field, old_value, new_value)"]
    J --> G
    I -- "No" --> E
    G --> K["sp_upsert_claim\n(all fields + embedding)"]
    K --> E
    E -- "all claims done" --> L["Read logs.json → activity events"]
    L --> M["embed logText per event"]
    M --> N["sp_upsert_claim_log\nON CONFLICT UPDATE"]
    N --> O["sp_etl_complete_job"]
```
