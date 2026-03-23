-- Web sections: subdivisions of a web page by heading/section, with vector embedding
CREATE TABLE IF NOT EXISTS web_sections (
    id              SERIAL PRIMARY KEY,
    source_id       INTEGER NOT NULL REFERENCES web_sources(id) ON DELETE CASCADE,
    section_index   INTEGER NOT NULL,
    heading         TEXT,
    section_text    TEXT NOT NULL,
    embedding       vector(384),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(source_id, section_index)
);

-- HNSW index for fast nearest-neighbor search on section embeddings
CREATE INDEX IF NOT EXISTS idx_web_sections_embedding
    ON web_sections USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_web_sections_source_id ON web_sections(source_id);
