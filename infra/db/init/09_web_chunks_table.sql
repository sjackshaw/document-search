-- Web chunks: subdivisions of sections into smaller text segments for finer-grained search
CREATE TABLE IF NOT EXISTS web_chunks (
    id              SERIAL PRIMARY KEY,
    source_id       INTEGER NOT NULL REFERENCES web_sources(id) ON DELETE CASCADE,
    section_id      INTEGER NOT NULL REFERENCES web_sections(id) ON DELETE CASCADE,
    chunk_index     INTEGER NOT NULL,
    chunk_text      TEXT NOT NULL,
    embedding       vector(384),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(section_id, chunk_index)
);

-- HNSW index for chunk-level nearest-neighbor search
CREATE INDEX IF NOT EXISTS idx_web_chunks_embedding
    ON web_chunks USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_web_chunks_source_id ON web_chunks(source_id);
CREATE INDEX IF NOT EXISTS idx_web_chunks_section_id ON web_chunks(section_id);
