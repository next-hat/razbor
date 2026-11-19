ALTER TABLE dispatch_outbox
  ADD COLUMN status_comment jsonb,
  ADD COLUMN status_after timestamptz;
