-- ============================================================
-- Stored Procedures for Web Content Search
-- ============================================================

-- Upsert a web source
CREATE OR REPLACE FUNCTION sp_upsert_web_source(
    p_url TEXT,
    p_domain TEXT,
    p_title TEXT,
    p_category TEXT,
    p_section_count INTEGER,
    p_total_chars INTEGER,
    p_content_hash TEXT
) RETURNS INTEGER AS $$
DECLARE
    v_id INTEGER;
BEGIN
    INSERT INTO web_sources (url, domain, title, category, section_count, total_chars, content_hash, last_crawled_at, updated_at)
    VALUES (p_url, p_domain, p_title, p_category, p_section_count, p_total_chars, p_content_hash, NOW(), NOW())
    ON CONFLICT (url) DO UPDATE
        SET title = EXCLUDED.title,
            domain = EXCLUDED.domain,
            category = EXCLUDED.category,
            section_count = EXCLUDED.section_count,
            total_chars = EXCLUDED.total_chars,
            content_hash = EXCLUDED.content_hash,
            last_crawled_at = NOW(),
            updated_at = NOW()
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- Insert a web section with embedding
CREATE OR REPLACE FUNCTION sp_upsert_web_section(
    p_source_id INTEGER,
    p_section_index INTEGER,
    p_heading TEXT,
    p_section_text TEXT,
    p_embedding vector(384)
) RETURNS INTEGER AS $$
DECLARE
    v_id INTEGER;
BEGIN
    INSERT INTO web_sections (source_id, section_index, heading, section_text, embedding)
    VALUES (p_source_id, p_section_index, p_heading, p_section_text, p_embedding)
    ON CONFLICT (source_id, section_index) DO UPDATE
        SET heading = EXCLUDED.heading,
            section_text = EXCLUDED.section_text,
            embedding = EXCLUDED.embedding
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- Insert a web chunk with embedding
CREATE OR REPLACE FUNCTION sp_upsert_web_chunk(
    p_source_id INTEGER,
    p_section_id INTEGER,
    p_chunk_index INTEGER,
    p_chunk_text TEXT,
    p_embedding vector(384)
) RETURNS VOID AS $$
BEGIN
    INSERT INTO web_chunks (source_id, section_id, chunk_index, chunk_text, embedding)
    VALUES (p_source_id, p_section_id, p_chunk_index, p_chunk_text, p_embedding)
    ON CONFLICT (section_id, chunk_index) DO UPDATE
        SET chunk_text = EXCLUDED.chunk_text,
            embedding = EXCLUDED.embedding;
END;
$$ LANGUAGE plpgsql;

-- Search across all web chunks by vector similarity
CREATE OR REPLACE FUNCTION sp_search_web(
    p_query_embedding vector(384),
    p_top_k INTEGER DEFAULT 20
) RETURNS TABLE (
    chunk_id        INTEGER,
    source_id       INTEGER,
    section_id      INTEGER,
    url             TEXT,
    domain          TEXT,
    title           TEXT,
    category        TEXT,
    section_index   INTEGER,
    heading         TEXT,
    chunk_index     INTEGER,
    chunk_text      TEXT,
    distance        DOUBLE PRECISION
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        wc.id AS chunk_id,
        ws.id AS source_id,
        wse.id AS section_id,
        ws.url,
        ws.domain,
        ws.title,
        ws.category,
        wse.section_index,
        wse.heading,
        wc.chunk_index,
        wc.chunk_text,
        (wc.embedding <=> p_query_embedding)::DOUBLE PRECISION AS distance
    FROM web_chunks wc
    JOIN web_sections wse ON wc.section_id = wse.id
    JOIN web_sources ws ON wc.source_id = ws.id
    ORDER BY wc.embedding <=> p_query_embedding
    LIMIT p_top_k;
END;
$$ LANGUAGE plpgsql;

-- Search web chunks with category filter
CREATE OR REPLACE FUNCTION sp_search_web_filtered(
    p_query_embedding vector(384),
    p_top_k INTEGER DEFAULT 20,
    p_category TEXT DEFAULT NULL
) RETURNS TABLE (
    chunk_id        INTEGER,
    source_id       INTEGER,
    section_id      INTEGER,
    url             TEXT,
    domain          TEXT,
    title           TEXT,
    category        TEXT,
    section_index   INTEGER,
    heading         TEXT,
    chunk_index     INTEGER,
    chunk_text      TEXT,
    distance        DOUBLE PRECISION
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        wc.id AS chunk_id,
        ws.id AS source_id,
        wse.id AS section_id,
        ws.url,
        ws.domain,
        ws.title,
        ws.category,
        wse.section_index,
        wse.heading,
        wc.chunk_index,
        wc.chunk_text,
        (wc.embedding <=> p_query_embedding)::DOUBLE PRECISION AS distance
    FROM web_chunks wc
    JOIN web_sections wse ON wc.section_id = wse.id
    JOIN web_sources ws ON wc.source_id = ws.id
    WHERE (p_category IS NULL OR ws.category = p_category)
    ORDER BY wc.embedding <=> p_query_embedding
    LIMIT p_top_k;
END;
$$ LANGUAGE plpgsql;

-- Unified search across document chunks AND web chunks
CREATE OR REPLACE FUNCTION sp_search_all(
    p_query_embedding vector(384),
    p_top_k INTEGER DEFAULT 20
) RETURNS TABLE (
    source_type     TEXT,
    chunk_id        INTEGER,
    title           TEXT,
    category        TEXT,
    ref             TEXT,
    section_label   TEXT,
    chunk_index     INTEGER,
    chunk_text      TEXT,
    distance        DOUBLE PRECISION
) AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM (
        SELECT
            'document'::TEXT AS source_type,
            dc.id AS chunk_id,
            d.title,
            d.category,
            d.filename AS ref,
            ('Page ' || dp.page_number)::TEXT AS section_label,
            dc.chunk_index,
            dc.chunk_text,
            (dc.embedding <=> p_query_embedding)::DOUBLE PRECISION AS distance
        FROM document_chunks dc
        JOIN document_pages dp ON dc.page_id = dp.id
        JOIN documents d ON dc.document_id = d.id

        UNION ALL

        SELECT
            'web'::TEXT AS source_type,
            wc.id AS chunk_id,
            ws.title,
            ws.category,
            ws.url AS ref,
            COALESCE(wse.heading, 'Section ' || wse.section_index)::TEXT AS section_label,
            wc.chunk_index,
            wc.chunk_text,
            (wc.embedding <=> p_query_embedding)::DOUBLE PRECISION AS distance
        FROM web_chunks wc
        JOIN web_sections wse ON wc.section_id = wse.id
        JOIN web_sources ws ON wc.source_id = ws.id
    ) combined
    ORDER BY distance
    LIMIT p_top_k;
END;
$$ LANGUAGE plpgsql;

-- Unified search with category filter
CREATE OR REPLACE FUNCTION sp_search_all_filtered(
    p_query_embedding vector(384),
    p_top_k INTEGER DEFAULT 20,
    p_category TEXT DEFAULT NULL
) RETURNS TABLE (
    source_type     TEXT,
    chunk_id        INTEGER,
    title           TEXT,
    category        TEXT,
    ref             TEXT,
    section_label   TEXT,
    chunk_index     INTEGER,
    chunk_text      TEXT,
    distance        DOUBLE PRECISION
) AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM (
        SELECT
            'document'::TEXT AS source_type,
            dc.id AS chunk_id,
            d.title,
            d.category,
            d.filename AS ref,
            ('Page ' || dp.page_number)::TEXT AS section_label,
            dc.chunk_index,
            dc.chunk_text,
            (dc.embedding <=> p_query_embedding)::DOUBLE PRECISION AS distance
        FROM document_chunks dc
        JOIN document_pages dp ON dc.page_id = dp.id
        JOIN documents d ON dc.document_id = d.id
        WHERE (p_category IS NULL OR d.category = p_category)

        UNION ALL

        SELECT
            'web'::TEXT AS source_type,
            wc.id AS chunk_id,
            ws.title,
            ws.category,
            ws.url AS ref,
            COALESCE(wse.heading, 'Section ' || wse.section_index)::TEXT AS section_label,
            wc.chunk_index,
            wc.chunk_text,
            (wc.embedding <=> p_query_embedding)::DOUBLE PRECISION AS distance
        FROM web_chunks wc
        JOIN web_sections wse ON wc.section_id = wse.id
        JOIN web_sources ws ON wc.source_id = ws.id
        WHERE (p_category IS NULL OR ws.category = p_category)
    ) combined
    ORDER BY distance
    LIMIT p_top_k;
END;
$$ LANGUAGE plpgsql;

-- Lookup a web source by URL
CREATE OR REPLACE FUNCTION sp_lookup_web_source(
    p_url TEXT
) RETURNS TABLE (
    source_id       INTEGER,
    url             TEXT,
    domain          TEXT,
    title           TEXT,
    category        TEXT,
    section_count   INTEGER,
    total_chars     INTEGER,
    content_hash    TEXT,
    last_crawled_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        ws.id AS source_id,
        ws.url,
        ws.domain,
        ws.title,
        ws.category,
        ws.section_count,
        ws.total_chars,
        ws.content_hash,
        ws.last_crawled_at,
        ws.created_at
    FROM web_sources ws
    WHERE ws.url = p_url;
END;
$$ LANGUAGE plpgsql;
