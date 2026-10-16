ALTER TABLE review_attempts
  ADD COLUMN metrics jsonb,
  ADD CONSTRAINT attempt_metrics_object CHECK (metrics IS NULL OR jsonb_typeof(metrics) = 'object');
