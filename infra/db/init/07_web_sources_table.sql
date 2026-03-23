-- Web sources table: one row per crawled web page
CREATE TABLE IF NOT EXISTS web_sources (
    id              SERIAL PRIMARY KEY,
    url             TEXT NOT NULL UNIQUE,
    domain          TEXT NOT NULL,
    title           TEXT NOT NULL,
    category        TEXT NOT NULL,
    section_count   INTEGER NOT NULL DEFAULT 0,
    total_chars     INTEGER NOT NULL DEFAULT 0,
    content_hash    TEXT,                    -- SHA-256 for change detection
    last_crawled_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_web_sources_category ON web_sources(category);
CREATE INDEX IF NOT EXISTS idx_web_sources_url ON web_sources(url);
CREATE INDEX IF NOT EXISTS idx_web_sources_domain ON web_sources(domain);
