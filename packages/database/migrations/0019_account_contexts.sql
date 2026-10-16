ALTER TABLE console_users DROP CONSTRAINT console_user_role;
UPDATE console_users SET role = 'super_admin' WHERE role = 'admin';
ALTER TABLE console_users ADD CONSTRAINT console_user_role CHECK (role IN ('super_admin', 'user'));
--> statement-breakpoint
CREATE TABLE account_contexts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text COLLATE "C" NOT NULL CONSTRAINT account_contexts_public_id_unique UNIQUE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  kind text NOT NULL CHECK (kind IN ('personal','organization')),
  user_id uuid REFERENCES console_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_context_public_id_format CHECK (public_id ~ '^ctx_[A-Za-z0-9]{16}$'),
  CONSTRAINT account_context_owner CHECK ((kind = 'personal') = (user_id IS NOT NULL))
);
CREATE UNIQUE INDEX account_contexts_personal_user_unique ON account_contexts(user_id);
CREATE TRIGGER immutable_identity BEFORE UPDATE ON account_contexts FOR EACH ROW EXECUTE FUNCTION razbor_immutable_identity();
--> statement-breakpoint
INSERT INTO account_contexts(public_id, name, kind, user_id)
SELECT 'ctx_' || substring(public_id FROM 5), left(coalesce(display_name, username, email, 'Personal account'),100), 'personal', id
FROM console_users;
--> statement-breakpoint
ALTER TABLE agents ADD COLUMN context_id uuid REFERENCES account_contexts(id);
ALTER TABLE skills ADD COLUMN context_id uuid REFERENCES account_contexts(id);
ALTER TABLE mcp_servers ADD COLUMN context_id uuid REFERENCES account_contexts(id);
ALTER TABLE github_apps ADD COLUMN context_id uuid REFERENCES account_contexts(id);
ALTER TABLE forge_instances ADD COLUMN context_id uuid REFERENCES account_contexts(id);
ALTER TABLE repositories ADD COLUMN context_id uuid REFERENCES account_contexts(id);
--> statement-breakpoint
-- A fresh database may have no console account until web bootstrap. Such legacy
-- rows remain unowned and inaccessible to ordinary users until bootstrap binds them.
UPDATE agents SET context_id = (SELECT c.id FROM account_contexts c JOIN console_users u ON u.id = c.user_id WHERE u.role = 'super_admin' ORDER BY u.created_at, u.public_id LIMIT 1);
UPDATE skills SET context_id = (SELECT c.id FROM account_contexts c JOIN console_users u ON u.id = c.user_id WHERE u.role = 'super_admin' ORDER BY u.created_at, u.public_id LIMIT 1);
UPDATE mcp_servers SET context_id = (SELECT c.id FROM account_contexts c JOIN console_users u ON u.id = c.user_id WHERE u.role = 'super_admin' ORDER BY u.created_at, u.public_id LIMIT 1);
UPDATE github_apps SET context_id = (SELECT c.id FROM account_contexts c JOIN console_users u ON u.id = c.user_id WHERE u.role = 'super_admin' ORDER BY u.created_at, u.public_id LIMIT 1);
UPDATE forge_instances SET context_id = (SELECT c.id FROM account_contexts c JOIN console_users u ON u.id = c.user_id WHERE u.role = 'super_admin' ORDER BY u.created_at, u.public_id LIMIT 1);
UPDATE repositories SET context_id = (SELECT c.id FROM account_contexts c JOIN console_users u ON u.id = c.user_id WHERE u.role = 'super_admin' ORDER BY u.created_at, u.public_id LIMIT 1);
--> statement-breakpoint
DROP INDEX agents_endpoint_model_unique;
CREATE UNIQUE INDEX agents_endpoint_model_unique ON agents(context_id, endpoint, model) NULLS NOT DISTINCT;
DROP INDEX skills_name_unique;
CREATE UNIQUE INDEX skills_name_unique ON skills(context_id, name) NULLS NOT DISTINCT;
DROP INDEX mcp_servers_name_unique;
CREATE UNIQUE INDEX mcp_servers_name_unique ON mcp_servers(context_id, name) NULLS NOT DISTINCT;
DROP INDEX github_apps_external_identity;
CREATE UNIQUE INDEX github_apps_external_identity ON github_apps(context_id, api_url, external_id) NULLS NOT DISTINCT;
ALTER TABLE forge_instances DROP CONSTRAINT forge_instances_config_key_key;
CREATE UNIQUE INDEX forge_instances_config_key_unique ON forge_instances(context_id, config_key) NULLS NOT DISTINCT;
ALTER TABLE repositories DROP CONSTRAINT repositories_config_key_key;
CREATE UNIQUE INDEX repositories_config_key_unique ON repositories(context_id, config_key) NULLS NOT DISTINCT;
ALTER TABLE repositories DROP CONSTRAINT repositories_forge_id_external_repository_id_key;
CREATE UNIQUE INDEX repository_external_identity ON repositories(context_id, forge_id, external_repository_id);
CREATE UNIQUE INDEX repository_pending_external_identity ON repositories(forge_id, external_repository_id) WHERE context_id IS NULL AND forge_id IS NOT NULL AND external_repository_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE organization_members (
  context_id uuid NOT NULL REFERENCES account_contexts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES console_users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin','moderator','member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(context_id, user_id)
);
CREATE INDEX organization_members_user ON organization_members(user_id);
--> statement-breakpoint
CREATE TABLE organization_repository_grants (
  context_id uuid NOT NULL,
  user_id uuid NOT NULL,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  PRIMARY KEY(context_id,user_id,repository_id),
  FOREIGN KEY(context_id,user_id) REFERENCES organization_members(context_id,user_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE organization_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text COLLATE "C" NOT NULL CONSTRAINT organization_invitations_public_id_unique UNIQUE,
  context_id uuid NOT NULL REFERENCES account_contexts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES console_users(id) ON DELETE CASCADE,
  invited_by uuid NOT NULL REFERENCES console_users(id),
  role text NOT NULL CHECK (role IN ('admin','moderator','member')),
  repository_ids jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(repository_ids) = 'array'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_invitation_public_id_format CHECK (public_id ~ '^inv_[A-Za-z0-9]{16}$')
);
CREATE UNIQUE INDEX organization_invitations_pending_unique ON organization_invitations(context_id,user_id) WHERE status = 'pending';
CREATE TRIGGER immutable_identity BEFORE UPDATE ON organization_invitations FOR EACH ROW EXECUTE FUNCTION razbor_immutable_identity();
--> statement-breakpoint
-- Global repository grants no longer convey authority. Explicit access is scoped
-- to membership in the organization owning the repository.
DELETE FROM console_user_repositories;
--> statement-breakpoint
CREATE FUNCTION razbor_organization_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM account_contexts WHERE id = NEW.context_id AND kind = 'organization') THEN
    RAISE EXCEPTION 'organization membership requires an organization';
  END IF;
  IF TG_TABLE_NAME = 'organization_repository_grants' THEN
    IF NOT EXISTS (SELECT 1 FROM repositories WHERE id = NEW.repository_id AND context_id = NEW.context_id) THEN
      RAISE EXCEPTION 'repository access must belong to the organization';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organization_binding BEFORE INSERT OR UPDATE ON organization_members FOR EACH ROW EXECUTE FUNCTION razbor_organization_binding();
CREATE TRIGGER organization_binding BEFORE INSERT OR UPDATE ON organization_repository_grants FOR EACH ROW EXECUTE FUNCTION razbor_organization_binding();
CREATE TRIGGER organization_binding BEFORE INSERT OR UPDATE ON organization_invitations FOR EACH ROW EXECUTE FUNCTION razbor_organization_binding();
