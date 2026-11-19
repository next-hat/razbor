ALTER TABLE webhook_deliveries
  ADD COLUMN boundary_number integer,
  ADD COLUMN boundary_at timestamptz;
--> statement-breakpoint
-- Capture the verified boundary when the receipt is written, including by a
-- dispatcher still using the old schema during a rolling upgrade.
CREATE FUNCTION razbor_record_deferred_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.boundary_number := (NEW.pending_open->>'number')::integer;
  NEW.boundary_at := coalesce((NEW.pending_open->>'occurredAt')::timestamptz, NEW.created_at);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER record_deferred_boundary BEFORE INSERT OR UPDATE OF pending_open ON webhook_deliveries
  FOR EACH ROW WHEN (NEW.boundary_number IS NULL AND NEW.pending_open->>'kind' IN ('closed', 'reopened'))
  EXECUTE FUNCTION razbor_record_deferred_boundary();
--> statement-breakpoint
-- Authenticated receipts may already be waiting under an older hook revision.
UPDATE webhook_deliveries
  SET boundary_number = (pending_open->>'number')::integer,
      boundary_at = coalesce((pending_open->>'occurredAt')::timestamptz, created_at)
  WHERE pending_open->>'kind' IN ('closed', 'reopened');
--> statement-breakpoint
CREATE INDEX delivery_session_boundary ON webhook_deliveries (webhook_id, boundary_number, boundary_at)
  WHERE boundary_number IS NOT NULL;
