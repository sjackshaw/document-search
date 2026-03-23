-- ETL job tracking
CREATE TABLE IF NOT EXISTS etl_job_logs (
    id              SERIAL PRIMARY KEY,
    service_name    TEXT NOT NULL,
    phase           TEXT NOT NULL,          -- 'extract', 'transform', 'load', 'complete'
    target_table    TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'running',  -- 'running', 'completed', 'failed'
    records_processed INTEGER DEFAULT 0,
    records_created   INTEGER DEFAULT 0,
    records_updated   INTEGER DEFAULT 0,
    records_deleted   INTEGER DEFAULT 0,
    error_message   TEXT,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_etl_job_logs_service ON etl_job_logs(service_name);
CREATE INDEX IF NOT EXISTS idx_etl_job_logs_status ON etl_job_logs(status);
