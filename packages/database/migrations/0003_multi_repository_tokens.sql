-- Existing keys retain their primary workspace binding. Only additional grants
-- are stored here, so legacy keys and their hashes require no migration.
ALTER TABLE index_access_tokens ADD COLUMN all_repositories boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE index_access_token_workspaces (
  token_id uuid NOT NULL REFERENCES index_access_tokens(id),
  workspace_id uuid NOT NULL REFERENCES index_workspaces(id),
  PRIMARY KEY (token_id, workspace_id)
);
--> statement-breakpoint
CREATE INDEX token_workspaces_workspace ON index_access_token_workspaces(workspace_id);
