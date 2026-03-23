-- ============================================================
-- Stored Procedures for Document Search
-- ============================================================

-- ETL: Start a job
CREATE OR REPLACE FUNCTION sp_etl_start_job(
    p_service TEXT,
    p_phase TEXT,
    p_target_table TEXT
) RETURNS INTEGER AS $$
DECLARE
    v_id INTEGER;
BEGIN
    INSERT INTO etl_job_logs (service_name, phase, target_table, status, started_at)
    VALUES (p_service, p_phase, p_target_table, 'running', NOW())
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- ETL: Complete a job
CREATE OR REPLACE FUNCTION sp_etl_complete_job(
    p_job_id INTEGER,
    p_processed INTEGER,
    p_created INTEGER,
    p_updated INTEGER,
    p_deleted INTEGER
) RETURNS VOID AS $$
BEGIN
    UPDATE etl_job_logs
    SET status = 'completed',
        records_processed = p_processed,
        records_created = p_created,
        records_updated = p_updated,
        records_deleted = p_deleted,
        completed_at = NOW()
    WHERE id = p_job_id;
END;
$$ LANGUAGE plpgsql;

-- ETL: Fail a job
CREATE OR REPLACE FUNCTION sp_etl_fail_job(
    p_job_id INTEGER,
    p_error TEXT
) RETURNS VOID AS $$
BEGIN
    UPDATE etl_job_logs
    SET status = 'failed',
        error_message = p_error,
        completed_at = NOW()
    WHERE id = p_job_id;
END;
$$ LANGUAGE plpgsql;

-- Upsert a document
CREATE OR REPLACE FUNCTION sp_upsert_document(
    p_filename TEXT,
    p_title TEXT,
    p_category TEXT,
    p_page_count INTEGER,
    p_total_chars INTEGER
) RETURNS INTEGER AS $$
DECLARE
    v_id INTEGER;
BEGIN
    INSERT INTO documents (filename, title, category, page_count, total_chars, updated_at)
    VALUES (p_filename, p_title, p_category, p_page_count, p_total_chars, NOW())
    ON CONFLICT (filename) DO UPDATE
        SET title = EXCLUDED.title,
            category = EXCLUDED.category,
            page_count = EXCLUDED.page_count,
            total_chars = EXCLUDED.total_chars,
            updated_at = NOW()
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- Insert a document page with embedding
CREATE OR REPLACE FUNCTION sp_upsert_document_page(
    p_document_id INTEGER,
    p_page_number INTEGER,
    p_page_text TEXT,
    p_embedding vector(384)
) RETURNS INTEGER AS $$
DECLARE
    v_id INTEGER;
BEGIN
    INSERT INTO document_pages (document_id, page_number, page_text, embedding)
    VALUES (p_document_id, p_page_number, p_page_text, p_embedding)
    ON CONFLICT (document_id, page_number) DO UPDATE
        SET page_text = EXCLUDED.page_text,
            embedding = EXCLUDED.embedding
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- Insert a document chunk with embedding
CREATE OR REPLACE FUNCTION sp_upsert_document_chunk(
    p_document_id INTEGER,
    p_page_id INTEGER,
    p_chunk_index INTEGER,
    p_chunk_text TEXT,
    p_embedding vector(384)
) RETURNS VOID AS $$
BEGIN
    INSERT INTO document_chunks (document_id, page_id, chunk_index, chunk_text, embedding)
    VALUES (p_document_id, p_page_id, p_chunk_index, p_chunk_text, p_embedding)
    ON CONFLICT (page_id, chunk_index) DO UPDATE
        SET chunk_text = EXCLUDED.chunk_text,
            embedding = EXCLUDED.embedding;
END;
$$ LANGUAGE plpgsql;

-- Search across all document chunks by vector similarity
CREATE OR REPLACE FUNCTION sp_search_documents(
    p_query_embedding vector(384),
    p_top_k INTEGER DEFAULT 20
) RETURNS TABLE (
    chunk_id        INTEGER,
    document_id     INTEGER,
    page_id         INTEGER,
    filename        TEXT,
    title           TEXT,
    category        TEXT,
    page_number     INTEGER,
    chunk_index     INTEGER,
    chunk_text      TEXT,
    distance        DOUBLE PRECISION
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        dc.id AS chunk_id,
        d.id AS document_id,
        dp.id AS page_id,
        d.filename,
        d.title,
        d.category,
        dp.page_number,
        dc.chunk_index,
        dc.chunk_text,
        (dc.embedding <=> p_query_embedding)::DOUBLE PRECISION AS distance
    FROM document_chunks dc
    JOIN document_pages dp ON dc.page_id = dp.id
    JOIN documents d ON dc.document_id = d.id
    ORDER BY dc.embedding <=> p_query_embedding
    LIMIT p_top_k;
END;
$$ LANGUAGE plpgsql;

-- Search with category filter
CREATE OR REPLACE FUNCTION sp_search_documents_filtered(
    p_query_embedding vector(384),
    p_top_k INTEGER DEFAULT 20,
    p_category TEXT DEFAULT NULL
) RETURNS TABLE (
    chunk_id        INTEGER,
    document_id     INTEGER,
    page_id         INTEGER,
    filename        TEXT,
    title           TEXT,
    category        TEXT,
    page_number     INTEGER,
    chunk_index     INTEGER,
    chunk_text      TEXT,
    distance        DOUBLE PRECISION
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        dc.id AS chunk_id,
        d.id AS document_id,
        dp.id AS page_id,
        d.filename,
        d.title,
        d.category,
        dp.page_number,
        dc.chunk_index,
        dc.chunk_text,
        (dc.embedding <=> p_query_embedding)::DOUBLE PRECISION AS distance
    FROM document_chunks dc
    JOIN document_pages dp ON dc.page_id = dp.id
    JOIN documents d ON dc.document_id = d.id
    WHERE (p_category IS NULL OR d.category = p_category)
    ORDER BY dc.embedding <=> p_query_embedding
    LIMIT p_top_k;
END;
$$ LANGUAGE plpgsql;

-- Search at the page level (coarser grain)
CREATE OR REPLACE FUNCTION sp_search_pages(
    p_query_embedding vector(384),
    p_top_k INTEGER DEFAULT 10
) RETURNS TABLE (
    page_id         INTEGER,
    document_id     INTEGER,
    filename        TEXT,
    title           TEXT,
    category        TEXT,
    page_number     INTEGER,
    page_text       TEXT,
    distance        DOUBLE PRECISION
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        dp.id AS page_id,
        d.id AS document_id,
        d.filename,
        d.title,
        d.category,
        dp.page_number,
        dp.page_text,
        (dp.embedding <=> p_query_embedding)::DOUBLE PRECISION AS distance
    FROM document_pages dp
    JOIN documents d ON dp.document_id = d.id
    ORDER BY dp.embedding <=> p_query_embedding
    LIMIT p_top_k;
END;
$$ LANGUAGE plpgsql;

-- Lookup a document by filename
CREATE OR REPLACE FUNCTION sp_lookup_document(
    p_filename TEXT
) RETURNS TABLE (
    document_id     INTEGER,
    filename        TEXT,
    title           TEXT,
    category        TEXT,
    page_count      INTEGER,
    total_chars     INTEGER,
    created_at      TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT d.id, d.filename, d.title, d.category,
           d.page_count, d.total_chars, d.created_at, d.updated_at
    FROM documents d
    WHERE d.filename = p_filename;
END;
$$ LANGUAGE plpgsql;

-- List ETL job history
CREATE OR REPLACE FUNCTION sp_etl_job_history(
    p_limit INTEGER DEFAULT 50
) RETURNS TABLE (
    id              INTEGER,
    service_name    TEXT,
    phase           TEXT,
    target_table    TEXT,
    status          TEXT,
    records_processed INTEGER,
    records_created   INTEGER,
    records_updated   INTEGER,
    records_deleted   INTEGER,
    error_message   TEXT,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT j.id, j.service_name, j.phase, j.target_table, j.status,
           j.records_processed, j.records_created, j.records_updated, j.records_deleted,
           j.error_message, j.started_at, j.completed_at
    FROM etl_job_logs j
    ORDER BY j.started_at DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;
