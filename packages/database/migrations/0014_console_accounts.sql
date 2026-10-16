CREATE TABLE console_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text COLLATE "C" NOT NULL CONSTRAINT console_users_public_id_unique UNIQUE,
  username text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT console_user_public_id_format CHECK (public_id ~ '^usr_[A-Za-z0-9]{16}$'),
  CONSTRAINT console_user_username CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  CONSTRAINT console_user_role CHECK (role IN ('admin', 'user'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX console_users_username_unique ON console_users(username);
--> statement-breakpoint
CREATE TRIGGER immutable_identity BEFORE UPDATE ON console_users FOR EACH ROW EXECUTE FUNCTION razbor_immutable_identity();
--> statement-breakpoint
CREATE TABLE console_user_repositories (
  user_id uuid NOT NULL REFERENCES console_users(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, repository_id)
);
--> statement-breakpoint
CREATE INDEX console_user_repositories_repository ON console_user_repositories(repository_id);
--> statement-breakpoint
CREATE TABLE console_sessions (
  hash text PRIMARY KEY CHECK (hash ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES console_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX console_sessions_user ON console_sessions(user_id);
--> statement-breakpoint
CREATE INDEX console_sessions_expiry ON console_sessions(expires_at);
