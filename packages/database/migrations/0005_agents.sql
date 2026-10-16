CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text COLLATE "C" NOT NULL CONSTRAINT agents_public_id_unique UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  endpoint text NOT NULL,
  model text NOT NULL,
  api_key text NOT NULL,
  CONSTRAINT agent_public_id_format CHECK (public_id ~ '^agent_[A-Za-z0-9]{16}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX agents_endpoint_model_unique ON agents(endpoint, model);
--> statement-breakpoint
CREATE TRIGGER immutable_identity BEFORE UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION razbor_immutable_identity();
