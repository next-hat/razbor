ALTER TABLE embedding_cache ALTER COLUMN embedding TYPE public.vector;
--> statement-breakpoint
ALTER TABLE embedding_cache ADD CONSTRAINT embedding_cache_dimensions
  CHECK (public.vector_dims(embedding) IN (384, 1024));
--> statement-breakpoint
ALTER TABLE embedding_indexes DROP CONSTRAINT embedding_indexes_pkey;
--> statement-breakpoint
ALTER TABLE embedding_indexes ADD PRIMARY KEY (workspace_id, model);
--> statement-breakpoint
ALTER TABLE embedding_chunks DROP CONSTRAINT embedding_chunks_pkey;
--> statement-breakpoint
ALTER TABLE embedding_chunks ADD PRIMARY KEY (workspace_id, model, chunk_id);
