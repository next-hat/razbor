ALTER TABLE webhook_deliveries
  ADD COLUMN pending_open jsonb,
  ADD COLUMN open_retry_after timestamptz;
--> statement-breakpoint
CREATE INDEX delivery_due_open ON webhook_deliveries (open_retry_after) WHERE open_retry_after IS NOT NULL;
