-- Document pages: one row per page, with extracted text and vector embedding
CREATE TABLE IF NOT EXISTS document_pages (
    id              SERIAL PRIMARY KEY,
    document_id     INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_number     INTEGER NOT NULL,
    page_text       TEXT NOT NULL,
    embedding       vector(384),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(document_id, page_number)
);

-- HNSW index for fast nearest-neighbor search on page embeddings
CREATE INDEX IF NOT EXISTS idx_document_pages_embedding
    ON document_pages USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_document_pages_document_id ON document_pages(document_id);
