import { and, desc, eq, isNull, like, sql } from "drizzle-orm";

import {
  memoryMarkdownSchema,
  memoryOperationSchema,
  publicIdSchema,
  type MemoryCollection,
  type MemoryDocument,
  type MemoryOperationResult,
  type MemoryProvenance,
  type MemoryRevision,
  type MemorySummary,
} from "@razbor/contracts";

import type { Database, Transaction } from "@database/src/connection.js";
import {
  requireContextSession,
  resolveContextId,
} from "@database/src/contexts.js";
import { publicId } from "@database/src/ids.js";
import {
  memoryCollections,
  memoryDocuments,
  memoryRevisions,
  repositories,
  repositoryMemoryCollections,
} from "@database/src/schema.js";

type DocumentRow = typeof memoryDocuments.$inferSelect;

type SummaryRow = Pick<
  DocumentRow,
  | "publicId"
  | "collectionId"
  | "path"
  | "title"
  | "version"
  | "createdAt"
  | "updatedAt"
  | "deletedAt"
>;

type CollectionBinding = {
  internalId: string;
  collection: MemoryCollection;
};

const MAX_REVISION_PAGE_BYTES = 768 * 1024;

export class MemoryError extends Error {
  /** Carry an API-safe explanation and the latest document after a version conflict. */
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
    readonly current?: MemoryDocument,
  ) {
    super(message);
    this.name = "MemoryError";
  }
}

/** Convert a stored document to a credential-free, serializable metadata view. */
function documentSummary(row: SummaryRow, collectionId: string): MemorySummary {
  return {
    id: row.publicId,
    collectionId,
    path: row.path,
    title: row.title,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

/** Include the original Markdown without normalizing whitespace or rendering HTML. */
function documentView(row: DocumentRow, collectionId: string): MemoryDocument {
  return { ...documentSummary(row, collectionId), markdown: row.markdown };
}

/** Return one immutable snapshot with its human or review-origin provenance. */
function revisionView(
  row: typeof memoryRevisions.$inferSelect,
): MemoryRevision {
  return {
    version: row.version,
    path: row.path,
    title: row.title,
    markdown: row.markdown,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    actor: row.actor,
    ...(row.reviewId ? { reviewId: row.reviewId } : {}),
    ...(row.headSha ? { headSha: row.headSha } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Resolve and lock an active repository before checking any memory bindings. */
async function activeRepository(tx: Transaction, id: string) {
  const isPublic = publicIdSchema("repository").safeParse(id).success;
  if (
    !isPublic &&
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
  )
    throw new MemoryError(404, "Repository not found.");
  const [repository] = await tx
    .select()
    .from(repositories)
    .where(eq(isPublic ? repositories.publicId : repositories.id, id))
    .for("update");
  if (!repository) throw new MemoryError(404, "Repository not found.");
  if (repository.status !== "active")
    throw new MemoryError(409, "This repository is being deleted.");
  return repository;
}

/** Create the initial private collection exactly once while holding the repository lock. */
async function ensureDefaultCollection(
  tx: Transaction,
  repository: typeof repositories.$inferSelect,
  beforeWrite?: (tx: Transaction) => Promise<void>,
) {
  const [existing] = await tx
    .select({ id: repositoryMemoryCollections.collectionId })
    .from(repositoryMemoryCollections)
    .where(
      and(
        eq(repositoryMemoryCollections.repositoryId, repository.id),
        eq(repositoryMemoryCollections.isDefault, true),
      ),
    );
  if (existing) return;
  await beforeWrite?.(tx);
  const [collection] = await tx
    .insert(memoryCollections)
    .values({
      publicId: publicId("memoryCollection"),
      name:
        repository.observed?.fullPath ??
        repository.selector ??
        repository.configKey,
    })
    .returning();
  await tx.insert(repositoryMemoryCollections).values({
    repositoryId: repository.id,
    collectionId: collection.id,
    isDefault: true,
    canWrite: true,
  });
  await beforeWrite?.(tx);
}

/** Read attached collections; a document's collection is independent of its originating project. */
async function accessibleCollections(tx: Transaction, repositoryId: string) {
  const rows = await tx
    .select({
      internalId: memoryCollections.id,
      id: memoryCollections.publicId,
      name: memoryCollections.name,
      isDefault: repositoryMemoryCollections.isDefault,
      canWrite: repositoryMemoryCollections.canWrite,
    })
    .from(repositoryMemoryCollections)
    .innerJoin(
      memoryCollections,
      eq(memoryCollections.id, repositoryMemoryCollections.collectionId),
    )
    .where(eq(repositoryMemoryCollections.repositoryId, repositoryId))
    .orderBy(
      desc(repositoryMemoryCollections.isDefault),
      memoryCollections.name,
    )
    .for("share", { of: repositoryMemoryCollections });
  return rows.map((row): CollectionBinding => ({
    internalId: row.internalId,
    collection: {
      id: row.id,
      name: row.name,
      isDefault: row.isDefault,
      canWrite: row.canWrite,
    },
  }));
}

/** Record the document snapshot in the same transaction as its searchable current version. */
async function appendRevision(
  tx: Transaction,
  row: DocumentRow,
  provenance: MemoryProvenance,
) {
  await tx.insert(memoryRevisions).values({
    documentId: row.id,
    version: row.version,
    path: row.path,
    title: row.title,
    markdown: row.markdown,
    deletedAt: row.deletedAt,
    actor: provenance.actor,
    reviewId: provenance.reviewId ?? null,
    headSha: provenance.headSha ?? null,
    createdAt: row.updatedAt,
  });
}

/** Escape SQL LIKE metacharacters so path prefixes select literal directory names. */
function literalPrefix(prefix: string) {
  return `${prefix.replace(/[\\%_]/g, "\\$&")}%`;
}

/** Validate provenance supplied by the authenticated human or runner rather than document content. */
function validateProvenance(provenance: MemoryProvenance) {
  if (
    !["human", "bot"].includes(provenance.actor) ||
    (provenance.reviewId !== undefined &&
      !publicIdSchema("review").safeParse(provenance.reviewId).success) ||
    (provenance.headSha !== undefined &&
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(provenance.headSha))
  )
    throw new MemoryError(400, "Invalid memory provenance.");
}

/**
 * Execute one authorized file-style memory operation with optimistic versions,
 * append-only snapshots, and transactionally generated PostgreSQL full-text search.
 * The repository can be identified by its public ID or the authenticated internal UUID.
 * Optional write guards run after locks and again before writes complete, using this transaction
 * to roll back changes if cancellation or lease ownership changes during SQL execution.
 * Console callers supply their account context and session so management access is
 * checked before repository locks and all memory stays within the selected account.
 */
export async function memoryOperation(
  database: Database,
  repositoryId: string,
  input: unknown,
  provenance: MemoryProvenance,
  options: {
    beforeWrite?: (tx: Transaction) => Promise<void>;
    contextId?: string;
    sessionToken?: string;
  } = {},
): Promise<MemoryOperationResult> {
  const parsed = memoryOperationSchema.safeParse(input);
  if (!parsed.success)
    throw new MemoryError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid memory operation.",
    );
  validateProvenance(provenance);
  const request = parsed.data;
  try {
    return await database.transaction(async (tx) => {
      if (options.sessionToken !== undefined)
        await requireContextSession(
          tx,
          options.sessionToken,
          options.contextId ?? "",
          "repositories",
        );
      const ownerId =
        options.contextId === undefined
          ? undefined
          : await resolveContextId(tx, options.contextId);
      const repository = await activeRepository(tx, repositoryId);
      if (ownerId !== undefined && repository.contextId !== ownerId)
        throw new MemoryError(404, "Repository not found.");
      await ensureDefaultCollection(tx, repository, options.beforeWrite);
      const bindings = await accessibleCollections(tx, repository.id);
      if (request.operation === "list" || request.operation === "search") {
        const selected = request.collectionId
          ? bindings.filter(
              (binding) => binding.collection.id === request.collectionId,
            )
          : bindings;
        if (!selected.length)
          throw new MemoryError(
            403,
            "Memory collection is not attached to this repository.",
          );
        const allowed = sql.join(
          selected.map((binding) => sql`${binding.internalId}`),
          sql`, `,
        );
        const searchQuery =
          request.operation === "search"
            ? sql`websearch_to_tsquery('simple', ${request.query})`
            : undefined;
        const limit = request.limit ?? 50;
        const rows = await tx
          .select({
            publicId: memoryDocuments.publicId,
            collectionId: memoryDocuments.collectionId,
            path: memoryDocuments.path,
            title: memoryDocuments.title,
            version: memoryDocuments.version,
            createdAt: memoryDocuments.createdAt,
            updatedAt: memoryDocuments.updatedAt,
            deletedAt: memoryDocuments.deletedAt,
          })
          .from(memoryDocuments)
          .where(
            and(
              sql`${memoryDocuments.collectionId} in (${allowed})`,
              request.operation === "list" && request.includeDeleted
                ? undefined
                : isNull(memoryDocuments.deletedAt),
              request.pathPrefix !== undefined
                ? like(memoryDocuments.path, literalPrefix(request.pathPrefix))
                : undefined,
              searchQuery
                ? sql`${memoryDocuments.search} @@ ${searchQuery}`
                : undefined,
            ),
          )
          .orderBy(
            ...(searchQuery
              ? [
                  desc(sql`ts_rank(${memoryDocuments.search}, ${searchQuery})`),
                  memoryDocuments.path,
                  memoryDocuments.publicId,
                ]
              : [memoryDocuments.path, memoryDocuments.publicId]),
          )
          .limit(limit + 1)
          .offset(request.offset ?? 0);
        const collectionIds = new Map(
          bindings.map((binding) => [
            binding.internalId,
            binding.collection.id,
          ]),
        );
        return {
          collections: bindings.map((binding) => binding.collection),
          documents: rows
            .slice(0, limit)
            .map((row) =>
              documentSummary(row, collectionIds.get(row.collectionId)!),
            ),
          hasMore: rows.length > limit,
        };
      }
      if (request.operation === "create") {
        const binding = request.collectionId
          ? bindings.find(
              (candidate) => candidate.collection.id === request.collectionId,
            )
          : bindings.find((candidate) => candidate.collection.isDefault);
        if (!binding)
          throw new MemoryError(
            403,
            "Memory collection is not attached to this repository.",
          );
        if (!binding.collection.canWrite)
          throw new MemoryError(403, "This memory collection is read-only.");
        await options.beforeWrite?.(tx);
        const [row] = await tx
          .insert(memoryDocuments)
          .values({
            publicId: publicId("memory"),
            collectionId: binding.internalId,
            path: request.path,
            title: request.title,
            markdown: request.markdown,
          })
          .returning();
        await appendRevision(tx, row, provenance);
        await options.beforeWrite?.(tx);
        return { document: documentView(row, binding.collection.id) };
      }
      const [row] = await tx
        .select({
          document: memoryDocuments,
          collectionId: memoryCollections.publicId,
          canWrite: repositoryMemoryCollections.canWrite,
        })
        .from(memoryDocuments)
        .innerJoin(
          memoryCollections,
          eq(memoryCollections.id, memoryDocuments.collectionId),
        )
        .innerJoin(
          repositoryMemoryCollections,
          and(
            eq(
              repositoryMemoryCollections.collectionId,
              memoryDocuments.collectionId,
            ),
            eq(repositoryMemoryCollections.repositoryId, repository.id),
          ),
        )
        .where(eq(memoryDocuments.publicId, request.id))
        .for(
          request.operation === "read" || request.operation === "revisions"
            ? "share"
            : "update",
          { of: memoryDocuments },
        );
      if (!row) throw new MemoryError(404, "Memory document not found.");
      const current = documentView(row.document, row.collectionId);
      if (request.operation === "read") {
        if (request.revision === undefined) return { document: current };
        const [revision] = await tx
          .select()
          .from(memoryRevisions)
          .where(
            and(
              eq(memoryRevisions.documentId, row.document.id),
              eq(memoryRevisions.version, request.revision),
            ),
          );
        if (!revision) throw new MemoryError(404, "Memory revision not found.");
        return {
          document: documentView(
            {
              ...row.document,
              version: revision.version,
              path: revision.path,
              title: revision.title,
              markdown: revision.markdown,
              deletedAt: revision.deletedAt,
              updatedAt: revision.createdAt,
            },
            row.collectionId,
          ),
        };
      }
      if (request.operation === "revisions") {
        const limit = request.limit ?? 10;
        const revisions = await tx
          .select()
          .from(memoryRevisions)
          .where(eq(memoryRevisions.documentId, row.document.id))
          .orderBy(desc(memoryRevisions.version))
          .limit(limit + 1)
          .offset(request.offset ?? 0);
        const page: MemoryRevision[] = [];
        let pageBytes = 0;
        for (const revision of revisions.slice(0, limit)) {
          const view = revisionView(revision);
          const bytes = Buffer.byteLength(JSON.stringify(view), "utf8");
          // Bound encoded JSON as well as Markdown; escaped controls can expand sixfold.
          if (pageBytes + bytes > MAX_REVISION_PAGE_BYTES) break;
          page.push(view);
          pageBytes += bytes;
        }
        return { revisions: page, hasMore: revisions.length > page.length };
      }
      if (!row.canWrite)
        throw new MemoryError(403, "This memory collection is read-only.");
      if (request.expectedVersion !== row.document.version)
        throw new MemoryError(
          409,
          "Memory changed since it was read. Reconcile your edits with the current document.",
          current,
        );
      if (row.document.deletedAt && request.operation !== "restore")
        throw new MemoryError(
          409,
          "Restore this deleted memory before editing it.",
          current,
        );
      let markdown = row.document.markdown;
      let title = row.document.title;
      let path = row.document.path;
      let deletedAt = row.document.deletedAt;
      if (request.operation === "write") {
        markdown = request.markdown;
        title = request.title ?? title;
        path = request.path ?? path;
      } else if (request.operation === "edit") {
        const position = markdown.indexOf(request.oldText);
        if (
          position === -1 ||
          markdown.indexOf(request.oldText, position + 1) !== -1
        )
          throw new MemoryError(
            409,
            "The text to replace must occur exactly once in the current Markdown.",
            current,
          );
        markdown =
          markdown.slice(0, position) +
          request.newText +
          markdown.slice(position + request.oldText.length);
        if (!memoryMarkdownSchema.safeParse(markdown).success)
          throw new MemoryError(
            400,
            "Edited Markdown must be at most 64 KiB and contain no NUL.",
          );
      } else if (request.operation === "delete") {
        deletedAt = new Date();
      } else {
        if (request.revision !== undefined) {
          const [revision] = await tx
            .select()
            .from(memoryRevisions)
            .where(
              and(
                eq(memoryRevisions.documentId, row.document.id),
                eq(memoryRevisions.version, request.revision),
              ),
            );
          if (!revision)
            throw new MemoryError(404, "Memory revision not found.");
          markdown = revision.markdown;
          title = revision.title;
          path = revision.path;
        } else if (!deletedAt) {
          throw new MemoryError(
            409,
            "This memory is already active. Select a revision to restore.",
            current,
          );
        }
        deletedAt = null;
      }
      await options.beforeWrite?.(tx);
      const [saved] = await tx
        .update(memoryDocuments)
        .set({
          path,
          title,
          markdown,
          deletedAt,
          version: row.document.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(memoryDocuments.id, row.document.id))
        .returning();
      await appendRevision(tx, saved, provenance);
      await options.beforeWrite?.(tx);
      return { document: documentView(saved, row.collectionId) };
    });
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause ?? error;
    const pg = cause as { code?: string; constraint?: string };
    if (pg.code === "23505" && pg.constraint === "memory_document_path")
      throw new MemoryError(
        409,
        "A memory already uses this path in the collection. Read or restore that document instead.",
      );
    throw error;
  }
}
