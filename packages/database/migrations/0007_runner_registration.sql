CREATE TABLE runners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text COLLATE "C" NOT NULL CONSTRAINT runners_public_id_unique UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  name text NOT NULL,
  state text NOT NULL DEFAULT 'enabled' CHECK (state IN ('enabled','draining','revoked')),
  enrollment_hash text UNIQUE CHECK (enrollment_hash ~ '^[a-f0-9]{64}$'),
  enrollment_expires_at timestamptz,
  credential_hash text UNIQUE CHECK (credential_hash ~ '^[a-f0-9]{64}$'),
  enrolled_at timestamptz,
  session_id uuid,
  session_expires_at timestamptz,
  last_seen_at timestamptz,
  capacity integer NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 32),
  runtime_ready boolean NOT NULL DEFAULT false,
  protocol_version integer NOT NULL DEFAULT 1,
  runtime_version text CHECK (runtime_version IS NULL OR length(runtime_version) BETWEEN 1 AND 64),
  timeout_ms integer NOT NULL DEFAULT 900000 CHECK (timeout_ms BETWEEN 1000 AND 3600000),
  fallback_model boolean NOT NULL DEFAULT false,
  CONSTRAINT runner_public_id_format CHECK (public_id ~ '^run_[A-Za-z0-9]{16}$')
);
--> statement-breakpoint
CREATE TABLE runner_repositories (
  runner_id uuid NOT NULL REFERENCES runners(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  PRIMARY KEY (runner_id, repository_id)
);
--> statement-breakpoint
ALTER TABLE review_attempts ADD COLUMN runner_id uuid REFERENCES runners(id),
  ADD COLUMN runner_session_id uuid,
  ADD COLUMN deadline timestamptz,
  ADD CONSTRAINT attempt_runner_binding CHECK ((runner_id IS NULL AND runner_session_id IS NULL AND deadline IS NULL) OR (runner_id IS NOT NULL AND runner_session_id IS NOT NULL AND deadline IS NOT NULL));
--> statement-breakpoint
CREATE INDEX attempt_runner_capacity ON review_attempts(runner_id, runner_session_id, status, lease_until);
--> statement-breakpoint
CREATE TRIGGER immutable_identity BEFORE UPDATE ON runners FOR EACH ROW EXECUTE FUNCTION razbor_immutable_identity();
