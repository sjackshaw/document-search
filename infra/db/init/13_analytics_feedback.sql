-- Chat query logging, answer quality feedback, and escalation tracking.
-- Supports:
--   #2  Deflection Analytics Dashboard  – query volume, unanswered topics, gap identification
--   #3  Escalation & Frustration Signal Detection – flag queries containing legal/regulatory language
--   #6  Answer Quality Feedback Loop – per-response thumbs-up / thumbs-down ratings

-- ── Chat Logs ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chat_logs (
  id                 SERIAL       PRIMARY KEY,
  service            TEXT         NOT NULL,            -- 'genai' | 'member-bot'
  session_id         TEXT,
  question           TEXT         NOT NULL,
  sources_count      INT          NOT NULL DEFAULT 0,
  answer_length      INT          NOT NULL DEFAULT 0,
  escalation_flagged BOOLEAN      NOT NULL DEFAULT FALSE,
  escalation_signals TEXT[]       NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_logs_service_created_idx
  ON chat_logs (service, created_at DESC);

-- Partial index — only escalated rows; keeps the full table scans fast
CREATE INDEX IF NOT EXISTS chat_logs_escalation_idx
  ON chat_logs (created_at DESC)
  WHERE escalation_flagged = TRUE;

-- ── Chat Feedback ────────────────────────────────────────────────────────────

-- One feedback entry per chat interaction (enforced by unique index)
CREATE TABLE IF NOT EXISTS chat_feedback (
  id          SERIAL       PRIMARY KEY,
  chat_log_id INT          NOT NULL REFERENCES chat_logs(id) ON DELETE CASCADE,
  rating      TEXT         NOT NULL CHECK (rating IN ('up', 'down')),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Prevent duplicate ratings for the same interaction
CREATE UNIQUE INDEX IF NOT EXISTS chat_feedback_one_per_log_idx
  ON chat_feedback (chat_log_id);

-- ── Analytics Summary Function ───────────────────────────────────────────────

-- Returns aggregate counters for a rolling window of p_days days.
-- Used by the deflection analytics dashboard.
CREATE OR REPLACE FUNCTION sp_analytics_summary(p_days INT DEFAULT 7)
RETURNS TABLE (
  period_start          TIMESTAMPTZ,
  total_queries         BIGINT,
  escalations           BIGINT,
  feedback_up           BIGINT,
  feedback_down         BIGINT,
  no_source_queries     BIGINT,
  short_answer_queries  BIGINT
) AS $$
  SELECT
    (now() - (p_days || ' days')::INTERVAL)::TIMESTAMPTZ          AS period_start,
    COUNT(*)                                                        AS total_queries,
    COUNT(*) FILTER (WHERE cl.escalation_flagged)                  AS escalations,
    COUNT(*) FILTER (WHERE f.rating = 'up')                        AS feedback_up,
    COUNT(*) FILTER (WHERE f.rating = 'down')                      AS feedback_down,
    COUNT(*) FILTER (WHERE cl.sources_count = 0)                   AS no_source_queries,
    COUNT(*) FILTER (
      WHERE cl.answer_length < 80 AND cl.answer_length > 0
    )                                                               AS short_answer_queries
  FROM chat_logs cl
  LEFT JOIN chat_feedback f ON f.chat_log_id = cl.id
  WHERE cl.created_at >= now() - (p_days || ' days')::INTERVAL
$$ LANGUAGE SQL STABLE;
