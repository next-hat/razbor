CREATE TABLE repository_webhooks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), public_id text COLLATE "C" NOT NULL CONSTRAINT repository_webhooks_public_id_unique UNIQUE CHECK(public_id ~ '^hook_[A-Za-z0-9]{16}$'), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), repository_id uuid NOT NULL UNIQUE REFERENCES repositories(id), managed_by text NOT NULL, enabled boolean NOT NULL, callback_base text NOT NULL, secret jsonb NOT NULL, senders jsonb NOT NULL, remote_id text, bot_id text, setup text NOT NULL DEFAULT 'pending', last_delivery text, last_delivery_at timestamptz);
--> statement-breakpoint
CREATE TABLE review_triggers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), webhook_id uuid NOT NULL REFERENCES repository_webhooks(id), repository_id uuid NOT NULL REFERENCES repositories(id), review_id uuid NOT NULL UNIQUE REFERENCES reviews(id), comment_id text NOT NULL, change jsonb NOT NULL);
CREATE UNIQUE INDEX trigger_comment_identity ON review_triggers(repository_id,comment_id);
--> statement-breakpoint
CREATE TABLE webhook_deliveries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), webhook_id uuid NOT NULL REFERENCES repository_webhooks(id), delivery_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX delivery_identity ON webhook_deliveries(webhook_id,delivery_id);
--> statement-breakpoint
ALTER TABLE dispatch_outbox ADD COLUMN acknowledged_at timestamptz, ADD COLUMN acknowledgement jsonb, ADD COLUMN publication jsonb, ADD COLUMN interaction_after timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
CREATE TRIGGER immutable_identity BEFORE UPDATE ON repository_webhooks FOR EACH ROW EXECUTE FUNCTION razbor_immutable_identity();
