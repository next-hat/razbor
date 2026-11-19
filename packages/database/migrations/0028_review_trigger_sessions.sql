ALTER TABLE pull_requests
  ADD COLUMN draft boolean,
  ADD COLUMN merge_base text,
  ADD COLUMN start_sha text,
  ADD COLUMN continuous_review_since timestamptz,
  ADD COLUMN review_session_reset_at timestamptz,
  ADD COLUMN trigger_generation integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE review_triggers
  ADD COLUMN origin text NOT NULL DEFAULT 'manual',
  ALTER COLUMN comment_id DROP NOT NULL,
  ADD CONSTRAINT trigger_origin_identity CHECK (
    (origin = 'manual' AND comment_id IS NOT NULL) OR
    (origin = 'automatic' AND comment_id IS NULL)
  );
--> statement-breakpoint
CREATE INDEX trigger_revision ON review_triggers
  (repository_id, (change->>'number'), (change->>'headSha'), (change->>'baseSha'));
