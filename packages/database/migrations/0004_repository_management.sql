ALTER TABLE repositories ADD COLUMN api_credential jsonb;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleting'));
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN setup_state text NOT NULL DEFAULT 'ready' CHECK (setup_state IN ('pending', 'indexing', 'ready', 'error'));
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN setup_error text;
--> statement-breakpoint
CREATE TABLE stored_secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  value text NOT NULL
);
