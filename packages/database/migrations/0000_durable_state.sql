CREATE TABLE forge_instances (
id UUID PRIMARY KEY DEFAULT gen_random_uuid(), public_id TEXT COLLATE "C" NOT NULL CONSTRAINT forge_instances_public_id_unique UNIQUE CHECK (public_id ~ '^forge_[A-Za-z0-9]{16}$'), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
config_key TEXT NOT NULL UNIQUE, managed_by TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('github','gitlab','forgejo')), api_url TEXT NOT NULL, web_url TEXT NOT NULL, allow_http BOOLEAN NOT NULL DEFAULT false, credential JSONB
);
--> statement-breakpoint
CREATE TABLE repositories (
id UUID PRIMARY KEY DEFAULT gen_random_uuid(), public_id TEXT COLLATE "C" NOT NULL CONSTRAINT repositories_public_id_unique UNIQUE CHECK (public_id ~ '^repo_[A-Za-z0-9]{16}$'), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
config_key TEXT NOT NULL UNIQUE, managed_by TEXT NOT NULL, forge_id UUID REFERENCES forge_instances(id), selector TEXT, external_repository_id TEXT, observed JSONB, verified_at timestamptz, git JSONB NOT NULL, index_owner TEXT NOT NULL, persistent BOOLEAN NOT NULL, version INTEGER NOT NULL DEFAULT 1, CHECK ((forge_id IS NULL) = (selector IS NULL)), CHECK (external_repository_id IS NULL OR forge_id IS NOT NULL), UNIQUE(forge_id, external_repository_id)
);
--> statement-breakpoint
CREATE TABLE reviews (
id UUID PRIMARY KEY DEFAULT gen_random_uuid(), public_id TEXT COLLATE "C" NOT NULL CONSTRAINT reviews_public_id_unique UNIQUE CHECK (public_id ~ '^rev_[A-Za-z0-9]{16}$'), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
repository_id UUID NOT NULL REFERENCES repositories(id), base_sha TEXT NOT NULL CHECK (base_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'), head_sha TEXT NOT NULL CHECK (head_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'), source JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')), version INTEGER NOT NULL DEFAULT 0, started_at timestamptz, finished_at timestamptz, result JSONB, CHECK ((status = 'completed') = (result IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE review_attempts (
id UUID PRIMARY KEY DEFAULT gen_random_uuid(), public_id TEXT COLLATE "C" NOT NULL CONSTRAINT review_attempts_public_id_unique UNIQUE CHECK (public_id ~ '^att_[A-Za-z0-9]{16}$'), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
review_id UUID NOT NULL REFERENCES reviews(id), version INTEGER NOT NULL CHECK(version > 0), owner TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','completed','failed','abandoned')), lease_until timestamptz NOT NULL, finished_at timestamptz, UNIQUE(review_id, version)
);
--> statement-breakpoint
CREATE TABLE index_workspaces (
id UUID PRIMARY KEY DEFAULT gen_random_uuid(), public_id TEXT COLLATE "C" NOT NULL CONSTRAINT index_workspaces_public_id_unique UNIQUE CHECK (public_id ~ '^idx_[A-Za-z0-9]{16}$'), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
repository_id UUID NOT NULL REFERENCES repositories(id), attempt_id UUID REFERENCES review_attempts(id), owner TEXT NOT NULL, root TEXT NOT NULL, temporary BOOLEAN NOT NULL, git JSONB NOT NULL, state TEXT NOT NULL DEFAULT 'unready' CHECK(state IN ('unready','ready','deleting','deleted')), base_sha TEXT, head_sha TEXT, index_sha TEXT, expires_at timestamptz, legacy_key TEXT, UNIQUE(owner,root), UNIQUE(attempt_id), UNIQUE(owner,legacy_key), CHECK (state <> 'ready' OR (head_sha IS NOT NULL AND index_sha = head_sha)), CHECK (NOT temporary OR expires_at IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE index_access_tokens (
id UUID PRIMARY KEY DEFAULT gen_random_uuid(), public_id TEXT COLLATE "C" NOT NULL CONSTRAINT index_access_tokens_public_id_unique UNIQUE CHECK (public_id ~ '^tok_[A-Za-z0-9]{16}$'), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
workspace_id UUID NOT NULL REFERENCES index_workspaces(id), hash TEXT NOT NULL UNIQUE CHECK(hash ~ '^[a-f0-9]{64}$'), algorithm TEXT NOT NULL DEFAULT 'sha256' CHECK(algorithm = 'sha256'), refresh BOOLEAN NOT NULL, expires_at timestamptz, revoked_at timestamptz, legacy_key TEXT
);
--> statement-breakpoint
CREATE TABLE legacy_revocations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), hash TEXT NOT NULL UNIQUE CHECK(hash ~ '^[a-f0-9]{64}$'), created_at timestamptz NOT NULL DEFAULT now());
--> statement-breakpoint
CREATE TABLE dispatch_outbox (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), review_id UUID NOT NULL UNIQUE REFERENCES reviews(id), created_at timestamptz NOT NULL DEFAULT now(), dispatched_at timestamptz);
--> statement-breakpoint
CREATE UNIQUE INDEX workspace_development ON index_workspaces(repository_id) WHERE NOT temporary;
--> statement-breakpoint
CREATE INDEX workspace_cleanup ON index_workspaces(owner,state,expires_at);
--> statement-breakpoint
CREATE INDEX tokens_workspace ON index_access_tokens(workspace_id);
--> statement-breakpoint
CREATE INDEX reviews_created ON reviews(created_at DESC);
--> statement-breakpoint
CREATE INDEX outbox_pending ON dispatch_outbox(created_at) WHERE dispatched_at IS NULL;
--> statement-breakpoint
CREATE FUNCTION razbor_immutable_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.public_id <> OLD.public_id THEN RAISE EXCEPTION 'immutable resource identity'; END IF; RETURN NEW; END $$;
--> statement-breakpoint
CREATE TRIGGER immutable_identity BEFORE UPDATE ON forge_instances FOR EACH ROW EXECUTE FUNCTION razbor_immutable_identity();
--> statement-breakpoint
CREATE TRIGGER immutable_identity BEFORE UPDATE ON repositories FOR EACH ROW EXECUTE FUNCTION razbor_immutable_identity();
--> statement-breakpoint
CREATE TRIGGER immutable_identity BEFORE UPDATE ON reviews FOR EACH ROW EXECUTE FUNCTION razbor_immutable_identity();
--> statement-breakpoint
CREATE TRIGGER immutable_identity BEFORE UPDATE ON review_attempts FOR EACH ROW EXECUTE FUNCTION razbor_immutable_identity();
--> statement-breakpoint
CREATE TRIGGER immutable_identity BEFORE UPDATE ON index_workspaces FOR EACH ROW EXECUTE FUNCTION razbor_immutable_identity();
--> statement-breakpoint
CREATE TRIGGER immutable_identity BEFORE UPDATE ON index_access_tokens FOR EACH ROW EXECUTE FUNCTION razbor_immutable_identity();
