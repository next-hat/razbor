CREATE TABLE github_apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text COLLATE "C" NOT NULL CONSTRAINT github_apps_public_id_unique UNIQUE,
  external_id text NOT NULL,
  name text NOT NULL,
  slug text NOT NULL,
  api_url text NOT NULL,
  web_url text NOT NULL,
  app_url text NOT NULL,
  callback_base text NOT NULL,
  private_key text NOT NULL,
  webhook_secret text NOT NULL,
  bot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_app_public_id_format CHECK (public_id ~ '^ghapp_[A-Za-z0-9]{16}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX github_apps_external_identity ON github_apps(api_url, external_id);
--> statement-breakpoint
CREATE TRIGGER immutable_identity BEFORE UPDATE ON github_apps FOR EACH ROW EXECUTE FUNCTION razbor_immutable_identity();
--> statement-breakpoint
ALTER TABLE repository_webhooks ADD COLUMN mode text NOT NULL DEFAULT 'managed'
  CHECK (mode IN ('managed', 'manual', 'github-app'));
