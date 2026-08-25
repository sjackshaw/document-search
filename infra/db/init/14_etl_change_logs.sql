-- Field-level change log for the claims-line ETL's change-detection step.
-- Documented in docs/TECH_STACK.md ("change log written to etl_change_logs")
-- and docs/diagrams/etl-pipeline.md, but the table/procedure were missing
-- from the schema migrations. Added here to match services/etl-claims-line/
-- vectorize.js's logChange() -> CALL sp_etl_log_change(...) usage.

CREATE TABLE IF NOT EXISTS etl_change_logs (
  id            SERIAL PRIMARY KEY,
  source_table  TEXT NOT NULL,
  member_email  TEXT NOT NULL,
  change_type   TEXT NOT NULL, -- 'created' | 'updated' | 'deleted'
  field_name    TEXT,
  old_value     TEXT,
  new_value     TEXT,
  job_id        INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS etl_change_logs_source_table_idx
  ON etl_change_logs (source_table, created_at DESC);

CREATE INDEX IF NOT EXISTS etl_change_logs_member_email_idx
  ON etl_change_logs (member_email);

CREATE INDEX IF NOT EXISTS etl_change_logs_job_id_idx
  ON etl_change_logs (job_id);

CREATE OR REPLACE PROCEDURE sp_etl_log_change(
  p_source_table TEXT,
  p_member_email TEXT,
  p_change_type  TEXT,
  p_field_name   TEXT,
  p_old_value    TEXT,
  p_new_value    TEXT,
  p_job_id       INTEGER
) AS $$
  INSERT INTO etl_change_logs
    (source_table, member_email, change_type, field_name, old_value, new_value, job_id)
  VALUES
    (p_source_table, p_member_email, p_change_type, p_field_name, p_old_value, p_new_value, p_job_id);
$$ LANGUAGE sql;
