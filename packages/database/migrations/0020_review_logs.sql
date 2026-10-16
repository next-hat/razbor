CREATE TABLE review_logs (
  review_id uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES review_attempts(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0),
  event jsonb NOT NULL CHECK (jsonb_typeof(event) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (review_id, sequence)
);
--> statement-breakpoint
CREATE INDEX review_logs_attempt ON review_logs(attempt_id);
