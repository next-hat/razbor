import { z } from "zod";

import {
  memoryMarkdownSchema,
  memoryPathSchema,
  memoryTitleSchema,
  publicIdSchema,
  type MemoryDocument,
} from "@razbor/contracts";

export type MemoryDraft = {
  base?: MemoryDocument;
  collectionId: string;
  path: string;
  title: string;
  markdown: string;
  updatedAt: string;
};

export type StoredMemoryDraft = {
  key: string;
  draft: MemoryDraft;
  owned: boolean;
};

const MAX_DRAFT_BYTES = 1024 * 1024;

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

const dateSchema = z.string().max(64).datetime({ offset: true });

const documentSchema = z
  .object({
    id: publicIdSchema("memory"),
    collectionId: publicIdSchema("memoryCollection"),
    path: memoryPathSchema,
    title: memoryTitleSchema,
    markdown: memoryMarkdownSchema,
    version: z.number().int().positive().safe(),
    createdAt: dateSchema,
    updatedAt: dateSchema,
    deletedAt: dateSchema.nullable(),
  })
  .strict();

const draftSchema = z
  .object({
    base: documentSchema.optional(),
    collectionId: publicIdSchema("memoryCollection"),
    path: z.string().max(4096),
    title: z.string().max(4096),
    markdown: z
      .string()
      .max(MAX_DRAFT_BYTES, "Draft Markdown must be at most 1 MiB")
      .refine(
        (markdown) =>
          new TextEncoder().encode(markdown).length <= MAX_DRAFT_BYTES,
        "Draft Markdown must be at most 1 MiB",
      ),
    updatedAt: dateSchema,
  })
  .strict();

const recordSchema = z
  .object({ version: z.literal(1), draft: draftSchema })
  .strict();

const preferredKeys = new Map<string, string>();

let pageWriterId: string | undefined;

/** Generate an RFC 4122 version 4 identifier on secure or plain HTTP browser origins. */
function draftUuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Allocate an independent writer identity for this page, including duplicated tabs. */
function writerId() {
  pageWriterId ??= draftUuid();
  return pageWriterId;
}

/** Keep draft keys inside one validated repository's versioned browser namespace. */
function draftPrefix(repositoryId: string) {
  publicIdSchema("repository").parse(repositoryId);
  return `razbor:memory-draft:v1:${repositoryId}:`;
}

/** Recognize an exact draft key without accepting another repository or arbitrary storage entry. */
function keyOwner(repositoryId: string, key: string) {
  const prefix = draftPrefix(repositoryId);
  if (!key.startsWith(prefix)) return undefined;
  const parts = key.slice(prefix.length).split(":");
  if (
    parts.length !== 3 ||
    !UUID_PATTERN.test(parts[0]) ||
    !UUID_PATTERN.test(parts[2]) ||
    (parts[1] !== "new" &&
      !publicIdSchema("memory").safeParse(parts[1]).success)
  )
    return undefined;
  return { writerId: parts[0], documentId: parts[1] };
}

/** Store only the recovery pointer best-effort; a blocked pointer cannot invalidate saved content. */
function preferDraft(repositoryId: string, key: string) {
  preferredKeys.set(repositoryId, key);
  try {
    sessionStorage.setItem(
      `razbor:memory-draft:preferred:v1:${repositoryId}`,
      key,
    );
  } catch {
    // The module map keeps navigation recovery available when session storage is blocked.
  }
}

/** Read the session's recovery pointer, retaining the in-page fallback if access is blocked. */
function preferredKey(repositoryId: string) {
  const preferred = preferredKeys.get(repositoryId);
  if (preferred !== undefined) return preferred;
  try {
    return (
      sessionStorage.getItem(
        `razbor:memory-draft:preferred:v1:${repositoryId}`,
      ) ?? undefined
    );
  } catch {
    return undefined;
  }
}

/** Allocate a separate owned record so recovering another draft cannot overwrite this page's work. */
export function createMemoryDraftKey(
  repositoryId: string,
  documentId?: string,
) {
  if (documentId !== undefined) publicIdSchema("memory").parse(documentId);
  return `${draftPrefix(repositoryId)}${writerId()}:${documentId ?? "new"}:${draftUuid()}`;
}

/** List valid raw drafts newest first; storage access failures remain visible to the caller. */
export function memoryDrafts(repositoryId: string): StoredMemoryDraft[] {
  const prefix = draftPrefix(repositoryId);
  const storage = localStorage;
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  const drafts: StoredMemoryDraft[] = [];
  for (const key of keys) {
    const owner = keyOwner(repositoryId, key);
    if (!owner) continue;
    const value = storage.getItem(key);
    if (value === null) continue;
    let input: unknown;
    try {
      input = JSON.parse(value);
    } catch {
      continue;
    }
    const parsed = recordSchema.safeParse(input);
    if (
      !parsed.success ||
      (parsed.data.draft.base?.id ?? "new") !== owner.documentId
    )
      continue;
    drafts.push({
      key,
      draft: parsed.data.draft,
      owned: owner.writerId === writerId(),
    });
  }
  return drafts.sort(
    (left, right) =>
      Date.parse(right.draft.updatedAt) - Date.parse(left.draft.updatedAt),
  );
}

/** Select the session's pointed draft or this page's newest draft, leaving other records for explicit recovery. */
export function preferredMemoryDraft(repositoryId: string) {
  const drafts = memoryDrafts(repositoryId);
  const key = preferredKey(repositoryId);
  return (
    drafts.find((draft) => draft.key === key) ??
    drafts.find((draft) => draft.owned)
  );
}

/** Persist a bounded raw draft synchronously without evicting any other page's work. */
export function saveMemoryDraft(
  repositoryId: string,
  draft: MemoryDraft,
  key: string,
): StoredMemoryDraft {
  const parsed = draftSchema.safeParse(draft);
  if (!parsed.success)
    throw new Error(
      `Unable to preserve memory draft: ${parsed.error.issues[0]?.message ?? "invalid draft"}.`,
    );
  const owner = keyOwner(repositoryId, key);
  if (
    !owner ||
    owner.writerId !== writerId() ||
    owner.documentId !== (parsed.data.base?.id ?? "new")
  )
    throw new Error(
      "The memory draft key must belong to this page and document.",
    );
  localStorage.setItem(key, JSON.stringify({ version: 1, draft: parsed.data }));
  preferDraft(repositoryId, key);
  return { key, draft: parsed.data, owned: true };
}

/** Remove only the requested scoped draft, allowing explicit discard of another page's recovery copy. */
export function removeMemoryDraft(repositoryId: string, key: string) {
  if (!keyOwner(repositoryId, key))
    throw new Error("The memory draft does not belong to this repository.");
  localStorage.removeItem(key);
  if (preferredKeys.get(repositoryId) === key)
    preferredKeys.delete(repositoryId);
  try {
    const pointer = `razbor:memory-draft:preferred:v1:${repositoryId}`;
    if (sessionStorage.getItem(pointer) === key)
      sessionStorage.removeItem(pointer);
  } catch {
    // Removing durable content succeeded even if its session pointer cannot be cleared.
  }
}
