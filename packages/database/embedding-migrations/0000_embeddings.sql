CREATE TABLE embedding_cache (
  repository_id uuid NOT NULL REFERENCES repositories(id),
  model text NOT NULL CHECK (octet_length(model) BETWEEN 1 AND 512),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  embedding public.vector(1024) NOT NULL,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_id, model, content_hash)
);
--> statement-breakpoint
CREATE TABLE embedding_indexes (
  workspace_id uuid PRIMARY KEY REFERENCES index_workspaces(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  head_sha text NOT NULL CHECK (head_sha ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  model text NOT NULL CHECK (octet_length(model) BETWEEN 1 AND 512),
  chunker_version text NOT NULL CHECK (octet_length(chunker_version) BETWEEN 1 AND 128),
  chunk_count integer NOT NULL CHECK (chunk_count BETWEEN 0 AND 20000),
  indexed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, repository_id, model)
);
--> statement-breakpoint
CREATE TABLE embedding_chunks (
  workspace_id uuid NOT NULL,
  repository_id uuid NOT NULL,
  model text NOT NULL,
  chunk_id text NOT NULL CHECK (octet_length(chunk_id) BETWEEN 1 AND 512),
  content_hash text NOT NULL,
  path text NOT NULL CHECK (octet_length(path) BETWEEN 1 AND 4096),
  qualified_name text NOT NULL CHECK (octet_length(qualified_name) BETWEEN 1 AND 4096),
  start_line integer NOT NULL CHECK (start_line > 0),
  end_line integer NOT NULL CHECK (end_line >= start_line),
  content text NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 1800),
  partial boolean NOT NULL,
  PRIMARY KEY (workspace_id, chunk_id),
  FOREIGN KEY (workspace_id, repository_id, model)
    REFERENCES embedding_indexes(workspace_id, repository_id, model) ON DELETE CASCADE,
  FOREIGN KEY (repository_id, model, content_hash)
    REFERENCES embedding_cache(repository_id, model, content_hash)
);
--> statement-breakpoint
CREATE INDEX embedding_chunks_cache ON embedding_chunks(repository_id, model, content_hash);
--> statement-breakpoint
CREATE INDEX embedding_cache_cleanup ON embedding_cache(repository_id, last_used_at);
