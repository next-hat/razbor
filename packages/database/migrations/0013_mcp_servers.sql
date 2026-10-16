CREATE TABLE mcp_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text COLLATE "C" NOT NULL CONSTRAINT mcp_servers_public_id_unique UNIQUE,
  name text NOT NULL,
  endpoint text NOT NULL,
  token text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mcp_server_public_id_format CHECK (public_id ~ '^mcp_[A-Za-z0-9]{16}$'),
  CONSTRAINT mcp_server_name CHECK (length(name) BETWEEN 1 AND 32 AND name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT mcp_server_endpoint CHECK (length(endpoint) BETWEEN 1 AND 2048),
  CONSTRAINT mcp_server_token CHECK (length(token) <= 8192 AND token !~ '[[:cntrl:]]')
);
--> statement-breakpoint
CREATE UNIQUE INDEX mcp_servers_name_unique ON mcp_servers(name);
--> statement-breakpoint
CREATE TRIGGER immutable_identity BEFORE UPDATE ON mcp_servers FOR EACH ROW EXECUTE FUNCTION razbor_immutable_identity();
--> statement-breakpoint
CREATE TABLE repository_mcp_servers (
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  server_id uuid NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  PRIMARY KEY (repository_id, server_id)
);
--> statement-breakpoint
CREATE INDEX repository_mcp_servers_server ON repository_mcp_servers(server_id);
