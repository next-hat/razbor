CREATE TABLE memory_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text COLLATE "C" NOT NULL CONSTRAINT memory_collections_public_id_unique UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_collection_public_id_format CHECK (public_id ~ '^memcol_[A-Za-z0-9]{16}$')
);
--> statement-breakpoint
CREATE TABLE repository_memory_collections (
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  collection_id uuid NOT NULL REFERENCES memory_collections(id) ON DELETE CASCADE,
  can_write boolean NOT NULL DEFAULT false,
  is_default boolean NOT NULL DEFAULT false,
  PRIMARY KEY (repository_id, collection_id),
  CONSTRAINT repository_memory_default_writable CHECK (NOT is_default OR can_write)
);
--> statement-breakpoint
CREATE UNIQUE INDEX repository_memory_default ON repository_memory_collections(repository_id) WHERE is_default;
--> statement-breakpoint
CREATE INDEX repository_memory_collection ON repository_memory_collections(collection_id);
--> statement-breakpoint
CREATE TABLE memory_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text COLLATE "C" NOT NULL CONSTRAINT memory_documents_public_id_unique UNIQUE,
  collection_id uuid NOT NULL REFERENCES memory_collections(id) ON DELETE CASCADE,
  path text NOT NULL,
  title text NOT NULL,
  markdown text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(path, '')), 'B') ||
    to_tsvector('simple', coalesce(markdown, ''))
  ) STORED,
  CONSTRAINT memory_document_public_id_format CHECK (public_id ~ '^mem_[A-Za-z0-9]{16}$'),
  CONSTRAINT memory_document_version CHECK (version > 0),
  CONSTRAINT memory_document_bytes CHECK (octet_length(markdown) <= 65536),
  CONSTRAINT memory_document_path_format CHECK (
    length(path) BETWEEN 1 AND 512 AND path ~ '\.md$'
    AND path !~ '(^|/)(\.\.?|)(/|$)' AND path !~ '[[:cntrl:]]'
    AND position(chr(92) IN path) = 0
  ),
  CONSTRAINT memory_document_title CHECK (length(title) BETWEEN 1 AND 200 AND title !~ '[[:cntrl:]]')
);
--> statement-breakpoint
CREATE UNIQUE INDEX memory_document_path ON memory_documents(collection_id, path);
--> statement-breakpoint
CREATE INDEX memory_document_search ON memory_documents USING gin(search);
--> statement-breakpoint
CREATE TABLE memory_revisions (
  document_id uuid NOT NULL REFERENCES memory_documents(id) ON DELETE CASCADE,
  version integer NOT NULL,
  path text NOT NULL,
  title text NOT NULL,
  markdown text NOT NULL,
  deleted_at timestamptz,
  actor text NOT NULL,
  review_id text,
  head_sha text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, version),
  CONSTRAINT memory_revision_version CHECK (version > 0),
  CONSTRAINT memory_revision_actor CHECK (actor IN ('human', 'bot')),
  CONSTRAINT memory_revision_bytes CHECK (octet_length(markdown) <= 65536),
  CONSTRAINT memory_revision_review CHECK (review_id IS NULL OR review_id ~ '^rev_[A-Za-z0-9]{16}$'),
  CONSTRAINT memory_revision_head CHECK (head_sha IS NULL OR head_sha ~ '^[a-f0-9]{40}([a-f0-9]{24})?$')
);
--> statement-breakpoint
CREATE TRIGGER immutable_identity BEFORE UPDATE ON memory_collections FOR EACH ROW EXECUTE FUNCTION razbor_immutable_identity();
--> statement-breakpoint
CREATE TRIGGER immutable_identity BEFORE UPDATE ON memory_documents FOR EACH ROW EXECUTE FUNCTION razbor_immutable_identity();
--> statement-breakpoint
CREATE FUNCTION razbor_immutable_memory_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'memory revisions are immutable';
END
$$;
--> statement-breakpoint
CREATE TRIGGER immutable_revision BEFORE UPDATE ON memory_revisions FOR EACH ROW EXECUTE FUNCTION razbor_immutable_memory_revision();
