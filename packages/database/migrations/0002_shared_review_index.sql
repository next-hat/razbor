-- Persistent indexes describe their own checkout. Temporary review access
-- records bind a PR head to a separately pinned shared branch index revision.
ALTER TABLE index_workspaces DROP CONSTRAINT index_workspaces_check;
--> statement-breakpoint
ALTER TABLE index_workspaces ADD CONSTRAINT workspace_revision_binding CHECK (
  state <> 'ready' OR (
    head_sha IS NOT NULL AND index_sha IS NOT NULL
    AND (temporary OR index_sha = head_sha)
  )
);
