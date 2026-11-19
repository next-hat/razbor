ALTER TABLE webhook_deliveries ADD COLUMN closed_command_id text;
--> statement-breakpoint
ALTER TABLE webhook_deliveries ADD COLUMN pending_action text;
--> statement-breakpoint
CREATE UNIQUE INDEX delivery_closed_command ON webhook_deliveries (webhook_id, closed_command_id) WHERE closed_command_id IS NOT NULL;
