import type { PoolClient } from "pg";

import { publicIdSchema } from "@razbor/contracts";

import type { Database } from "@database/src/connection.js";

export type EmbeddingScope = {
  owner: string;
  workspaceId: string;
  repositoryId: string;
};

export type EmbeddingChunk = {
  id: string;
  hash: string;
  path: string;
  qualifiedName: string;
  startLine: number;
  endLine: number;
  text: string;
  partial: boolean;
};

export type EmbeddingIndexKey = {
  headSha: string;
  model: string;
  chunkerVersion: string;
};

type WorkspaceBinding = {
  id: string;
  repository_id: string;
  state: string;
  head_sha: string | null;
  index_sha: string | null;
  temporary: boolean;
};

class EmbeddingStorageError extends Error {}

/**
 * Reject empty, oversized or NUL-containing embedding metadata before
 * persistence.
 */
function validString(value: string, bytes: number) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    Buffer.byteLength(value) > bytes
  )
    throw new EmbeddingStorageError("invalid embedding metadata");
}

/** Require a lowercase SHA-256 content hash for cache identity. */
function validHash(hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash))
    throw new EmbeddingStorageError("invalid embedding content hash");
}

/** Restrict stored vectors to the supported embedding dimensions. */
function validDimensions(dimensions: number) {
  if (dimensions !== 384 && dimensions !== 1024)
    throw new EmbeddingStorageError("invalid embedding dimensions");
}

/**
 * Require finite vector components, the expected dimension and a unit norm
 * within tolerance.
 */
function validVector(vector: number[], dimensions: number) {
  validDimensions(dimensions);
  if (
    !Array.isArray(vector) ||
    vector.length !== dimensions ||
    vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
  )
    throw new EmbeddingStorageError("invalid embedding vector");
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (Math.abs(norm - 1) > 0.001)
    throw new EmbeddingStorageError("embedding vector must be normalized");
}

/**
 * Validate the revision, model and chunker identity that bind an embedding
 * index.
 */
function validKey(key: EmbeddingIndexKey) {
  validString(key.model, 512);
  validString(key.chunkerVersion, 128);
  if (!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(key.headSha))
    throw new EmbeddingStorageError("invalid embedding revision");
}

/**
 * Require a normalized repository-relative source path without traversal or
 * platform-specific separators.
 */
function validPath(path: string) {
  validString(path, 4096);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new EmbeddingStorageError("invalid embedding source path");
}

/**
 * Validate bounded chunk metadata and reject duplicate IDs, invalid ranges or
 * oversized source excerpts.
 */
function validChunks(chunks: EmbeddingChunk[]) {
  if (!Array.isArray(chunks) || chunks.length > 20_000)
    throw new EmbeddingStorageError("embedding chunk limit exceeded");
  const ids = new Set<string>();
  for (const chunk of chunks) {
    validString(chunk.id, 512);
    validHash(chunk.hash);
    validPath(chunk.path);
    validString(chunk.qualifiedName, 4096);
    validString(chunk.text, 1800);
    if (
      ids.has(chunk.id) ||
      typeof chunk.partial !== "boolean" ||
      !Number.isSafeInteger(chunk.startLine) ||
      !Number.isSafeInteger(chunk.endLine) ||
      chunk.startLine < 1 ||
      chunk.endLine < chunk.startLine ||
      chunk.endLine > 2_147_483_647
    )
      throw new EmbeddingStorageError("invalid embedding chunk");
    ids.add(chunk.id);
  }
}

/**
 * Commit or roll back an embedding operation and release its connection; hide
 * database errors that might contain source text.
 */
async function transaction<T>(
  database: Database,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let client: PoolClient | undefined;
  try {
    client = await database.pool.connect();
    await client.query("begin");
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client?.query("rollback").catch(() => {});
    // PostgreSQL constraint errors can contain the source text in a failing row.
    if (error instanceof EmbeddingStorageError) throw error;
    throw new EmbeddingStorageError("embedding storage operation failed");
  } finally {
    client?.release();
  }
}

/**
 * Lock and resolve an active workspace owned by the requested indexer and
 * repository, rejecting expired or unavailable scope.
 */
async function binding(client: PoolClient, scope: EmbeddingScope) {
  publicIdSchema("workspace").parse(scope.workspaceId);
  publicIdSchema("repository").parse(scope.repositoryId);
  validString(scope.owner, 512);
  const result = await client.query<WorkspaceBinding>(
    `select w.id, w.repository_id, w.state, w.head_sha, w.index_sha, w.temporary
     from index_workspaces w join repositories r on r.id = w.repository_id
     where w.public_id = $1 and w.owner = $2 and r.public_id = $3
       and r.index_owner = $2 and r.status = 'active' and w.state in ('ready', 'unready')
       and (w.expires_at is null or w.expires_at > now())
     for share of w, r`,
    [scope.workspaceId, scope.owner, scope.repositoryId],
  );
  if (!result.rows[0])
    throw new EmbeddingStorageError("embedding workspace unavailable");
  return result.rows[0];
}

/**
 * Serialize repository cache writes within the current transaction without
 * holding locks during inference.
 */
async function lockCache(client: PoolClient, repositoryId: string) {
  // Serialize cache writes per repository, without holding locks during inference.
  await client.query("select pg_advisory_xact_lock(748322, hashtext($1))", [
    repositoryId,
  ]);
}

/**
 * Remove at most one thousand unreferenced cache entries older than a day,
 * preserving recent entries that may belong to ongoing builds.
 */
async function pruneCache(client: PoolClient, repositoryId: string) {
  // New, unreferenced entries may belong to an in-progress workspace build.
  // Keep them for 24 hours; each invocation removes at most 1,000 older orphans.
  await client.query(
    `delete from embedding_cache c using (
       select c.repository_id, c.model, c.content_hash from embedding_cache c
       where c.repository_id = $1 and c.last_used_at < now() - interval '24 hours'
         and not exists (
           select 1 from embedding_chunks k where k.repository_id = c.repository_id
             and k.model = c.model and k.content_hash = c.content_hash
         )
       order by c.last_used_at, c.model, c.content_hash limit 1000
     ) unused
     where c.repository_id = unused.repository_id and c.model = unused.model
       and c.content_hash = unused.content_hash`,
    [repositoryId],
  );
}

/**
 * Verify optional vector storage migrations and access before enabling
 * semantic indexing.
 */
export async function embeddingStorageReady(database: Database) {
  await transaction(database, async (client) => {
    const result = await client.query<{ ready: boolean }>(
      `select exists (
         select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace
         where e.extname = 'vector' and n.nspname = 'public'
       ) and to_regclass('public.embedding_cache') is not null
         and to_regclass('public.embedding_indexes') is not null
         and to_regclass('public.embedding_chunks') is not null
         and exists (
           select 1 from pg_constraint
           where conrelid = to_regclass('public.embedding_cache')
             and conname = 'embedding_cache_dimensions'
         ) as ready`,
    );
    if (!result.rows[0]?.ready)
      throw new EmbeddingStorageError(
        "embedding storage requires pgvector and optional embedding migrations",
      );
    await client.query("select workspace_id from embedding_indexes limit 0");
  });
}

/**
 * Read validated cached vectors for a bounded batch and update their last-use
 * time under the repository cache lock.
 */
export async function cachedEmbeddings(
  database: Database,
  scope: EmbeddingScope,
  model: string,
  hashes: string[],
  dimensions = 1024,
): Promise<Map<string, number[]>> {
  validString(model, 512);
  validDimensions(dimensions);
  if (!Array.isArray(hashes) || hashes.length > 256)
    throw new EmbeddingStorageError("embedding cache batch limit exceeded");
  hashes.forEach(validHash);
  return transaction(database, async (client) => {
    const workspace = await binding(client, scope);
    await lockCache(client, workspace.repository_id);
    const result = await client.query<{
      content_hash: string;
      embedding: string;
    }>(
      `update embedding_cache set last_used_at = now()
       where repository_id = $1 and model = $2 and content_hash = any($3::text[])
       returning content_hash, embedding::text`,
      [workspace.repository_id, model, hashes],
    );
    return new Map(
      result.rows.map((row) => {
        const vector: number[] = JSON.parse(row.embedding);
        validVector(vector, dimensions);
        return [row.content_hash, vector];
      }),
    );
  });
}

/**
 * Persist a bounded batch of normalized vectors by repository, model and
 * content hash; existing vectors retain their values and refresh their usage
 * time.
 */
export async function cacheEmbeddings(
  database: Database,
  scope: EmbeddingScope,
  model: string,
  entries: { hash: string; embedding: number[] }[],
  dimensions = 1024,
) {
  validString(model, 512);
  validDimensions(dimensions);
  if (!Array.isArray(entries) || entries.length > 256)
    throw new EmbeddingStorageError("embedding cache batch limit exceeded");
  const values = new Map<string, { hash: string; embedding: string }>();
  for (const entry of entries) {
    validHash(entry.hash);
    validVector(entry.embedding, dimensions);
    values.set(entry.hash, {
      hash: entry.hash,
      embedding: JSON.stringify(entry.embedding),
    });
  }
  await transaction(database, async (client) => {
    const workspace = await binding(client, scope);
    await lockCache(client, workspace.repository_id);
    await client.query(
      `insert into embedding_cache(repository_id, model, content_hash, embedding)
       select $1, $2, e.hash, e.embedding::public.vector from
         jsonb_to_recordset($3::jsonb) as e(hash text, embedding text)
       where true
       on conflict (repository_id, model, content_hash)
         do update set last_used_at = now()`,
      [workspace.repository_id, model, JSON.stringify([...values.values()])],
    );
  });
}

/**
 * Atomically replace one workspace model index while it is unready, enforce
 * temporary revision binding and prune old unreferenced cache entries.
 */
export async function publishEmbeddingIndex(
  database: Database,
  scope: EmbeddingScope,
  index: EmbeddingIndexKey & { chunks: EmbeddingChunk[] },
) {
  validKey(index);
  validChunks(index.chunks);
  await transaction(database, async (client) => {
    const workspace = await binding(client, scope);
    if (
      workspace.state !== "unready" ||
      (workspace.temporary && workspace.head_sha !== index.headSha)
    )
      throw new EmbeddingStorageError("embedding publication binding changed");
    await lockCache(client, workspace.repository_id);
    await client.query(
      "delete from embedding_indexes where workspace_id = $1 and model = $2",
      [workspace.id, index.model],
    );
    await client.query(
      `insert into embedding_indexes
       (workspace_id, repository_id, head_sha, model, chunker_version, chunk_count)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        workspace.id,
        workspace.repository_id,
        index.headSha,
        index.model,
        index.chunkerVersion,
        index.chunks.length,
      ],
    );
    await client.query(
      `insert into embedding_chunks
       (workspace_id, repository_id, model, chunk_id, content_hash, path,
        qualified_name, start_line, end_line, content, partial)
       select $1, $2, $3, k.id, k.hash, k.path, k."qualifiedName",
         k."startLine", k."endLine", k.text, k.partial
       from jsonb_to_recordset($4::jsonb) as k(
         id text, hash text, path text, "qualifiedName" text,
         "startLine" integer, "endLine" integer, text text, partial boolean
       )`,
      [
        workspace.id,
        workspace.repository_id,
        index.model,
        JSON.stringify(index.chunks),
      ],
    );
    await pruneCache(client, workspace.repository_id);
  });
}

/**
 * Look up an index only when workspace, repository, revision, model and
 * chunker identity all match.
 */
export async function embeddingIndex(
  database: Database,
  scope: EmbeddingScope,
  key: EmbeddingIndexKey,
): Promise<{ chunkCount: number; indexedAt: Date } | undefined> {
  validKey(key);
  return transaction(database, async (client) => {
    const workspace = await binding(client, scope);
    const result = await client.query<{ chunkCount: number; indexedAt: Date }>(
      `select chunk_count as "chunkCount", indexed_at as "indexedAt"
       from embedding_indexes where workspace_id = $1 and repository_id = $2
         and head_sha = $3 and model = $4 and chunker_version = $5`,
      [
        workspace.id,
        workspace.repository_id,
        key.headSha,
        key.model,
        key.chunkerVersion,
      ],
    );
    return result.rows[0];
  });
}

/**
 * Search the exact published workspace revision with optional path filtering;
 * combine bounded lexical and semantic rankings when query text is provided.
 */
export async function searchEmbeddings(
  database: Database,
  scope: EmbeddingScope,
  query: EmbeddingIndexKey & {
    embedding: number[];
    limit: number;
    pathPrefix?: string;
    dimensions?: number;
    text?: string;
  },
): Promise<
  (EmbeddingChunk & {
    score: number;
    hybridScore?: number;
    lexicalScore?: number;
  })[]
> {
  validKey(query);
  validVector(query.embedding, query.dimensions ?? 1024);
  if (query.text !== undefined) validString(query.text, 4096);
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 20)
    throw new EmbeddingStorageError("invalid embedding search limit");
  if (query.pathPrefix !== undefined) {
    validString(query.pathPrefix, 4096);
    validPath(query.pathPrefix.replace(/\/$/, ""));
  }
  return transaction(database, async (client) => {
    const workspace = await binding(client, scope);
    if (
      workspace.state !== "ready" ||
      workspace.index_sha !== query.headSha ||
      workspace.head_sha !== query.headSha
    )
      throw new EmbeddingStorageError(
        "embedding workspace revision unavailable",
      );
    const snapshot = await client.query(
      `select 1 from embedding_indexes where workspace_id = $1 and repository_id = $2
         and head_sha = $3 and model = $4 and chunker_version = $5`,
      [
        workspace.id,
        workspace.repository_id,
        query.headSha,
        query.model,
        query.chunkerVersion,
      ],
    );
    if (!snapshot.rowCount)
      throw new EmbeddingStorageError("embedding index revision unavailable");
    if (query.text !== undefined) {
      // Bound each retrieval arm before reciprocal-rank fusion. The public score
      // stays cosine similarity; hybridScore describes the document ordering.
      const result = await client.query<
        EmbeddingChunk & {
          score: number;
          hybridScore: number;
          lexicalScore: number;
        }
      >(
        `with candidates as materialized (
           select k.chunk_id as id, k.content_hash as hash, k.path,
             k.qualified_name as "qualifiedName", k.start_line as "startLine",
             k.end_line as "endLine", k.content as text, k.partial,
             1 - (c.embedding <=> $6::public.vector) as score,
             to_tsvector('simple', concat_ws(' ', k.path, k.qualified_name, k.content)) as document
           from embedding_indexes i
           join embedding_chunks k on k.workspace_id = i.workspace_id and k.model = i.model
           join embedding_cache c on c.repository_id = k.repository_id
             and c.model = k.model and c.content_hash = k.content_hash
           where i.workspace_id = $1 and i.repository_id = $2 and i.head_sha = $3
             and i.model = $4 and i.chunker_version = $5
             and ($7::text is null or starts_with(k.path, $7))
         ), semantic as (
           select id, row_number() over (order by score desc, path, "startLine", id) as rank
           from candidates order by score desc, path, "startLine", id limit 100
         ), lexical as (
           select id, ts_rank_cd(document, websearch_to_tsquery('simple', $9)) as score,
             row_number() over (
               order by ts_rank_cd(document, websearch_to_tsquery('simple', $9)) desc,
                 path, "startLine", id
             ) as rank
           from candidates where document @@ websearch_to_tsquery('simple', $9)
           order by score desc, path, "startLine", id limit 100
         ), ranked as (
           select coalesce(s.id, l.id) as id,
             (coalesce(1.0 / (60 + s.rank), 0) + coalesce(1.0 / (60 + l.rank), 0))::double precision as score,
             coalesce(l.score, 0) as lexical_score
           from semantic s full join lexical l on l.id = s.id
         )
         select c.id, c.hash, c.path, c."qualifiedName", c."startLine", c."endLine",
           c.text, c.partial, c.score, r.score as "hybridScore", r.lexical_score as "lexicalScore"
         from ranked r join candidates c on c.id = r.id
         order by r.score desc, c.score desc, c.path, c."startLine", c.id limit $8`,
        [
          workspace.id,
          workspace.repository_id,
          query.headSha,
          query.model,
          query.chunkerVersion,
          JSON.stringify(query.embedding),
          query.pathPrefix ?? null,
          query.limit,
          query.text,
        ],
      );
      return result.rows;
    }
    const result = await client.query<EmbeddingChunk & { score: number }>(
      `select k.chunk_id as id, k.content_hash as hash, k.path,
         k.qualified_name as "qualifiedName", k.start_line as "startLine",
         k.end_line as "endLine", k.content as text, k.partial,
         1 - (c.embedding <=> $6::public.vector) as score
       from embedding_indexes i
       join embedding_chunks k on k.workspace_id = i.workspace_id and k.model = i.model
       join embedding_cache c on c.repository_id = k.repository_id
         and c.model = k.model and c.content_hash = k.content_hash
       where i.workspace_id = $1 and i.repository_id = $2 and i.head_sha = $3
         and i.model = $4 and i.chunker_version = $5
         and ($7::text is null or starts_with(k.path, $7))
       order by c.embedding <=> $6::public.vector, k.path, k.start_line, k.chunk_id
       limit $8`,
      [
        workspace.id,
        workspace.repository_id,
        query.headSha,
        query.model,
        query.chunkerVersion,
        JSON.stringify(query.embedding),
        query.pathPrefix ?? null,
        query.limit,
      ],
    );
    return result.rows;
  });
}

/**
 * Remove embedding data only for an owned workspace in deletion; repository
 * deletion clears shared caches, while temporary cleanup prunes old orphaned
 * vectors.
 */
export async function deleteEmbeddingIndex(
  database: Database,
  owner: string,
  workspaceId: string,
) {
  publicIdSchema("workspace").parse(workspaceId);
  validString(owner, 512);
  await transaction(database, async (client) => {
    const tables = await client.query<{ present: boolean }>(
      "select to_regclass('public.embedding_indexes') is not null as present",
    );
    if (!tables.rows[0]?.present) return;
    const result = await client.query<{
      id: string;
      repository_id: string;
      deleting_repository: boolean;
    }>(
      `select w.id, w.repository_id, r.status = 'deleting' as deleting_repository from index_workspaces w
       join repositories r on r.id = w.repository_id
       where w.public_id = $1 and w.owner = $2 and r.index_owner = $2
         and (w.temporary or r.status = 'deleting') and w.state in ('deleting', 'deleted')
       for share of w, r`,
      [workspaceId, owner],
    );
    const workspace = result.rows[0];
    if (!workspace)
      throw new EmbeddingStorageError("owned deleting workspace required");
    await lockCache(client, workspace.repository_id);
    await client.query(
      "delete from embedding_indexes where workspace_id = $1",
      [workspace.id],
    );
    if (workspace.deleting_repository) {
      await client.query(
        "delete from embedding_indexes where repository_id = $1",
        [workspace.repository_id],
      );
      await client.query(
        "delete from embedding_cache where repository_id = $1",
        [workspace.repository_id],
      );
    } else {
      await pruneCache(client, workspace.repository_id);
    }
  });
}
