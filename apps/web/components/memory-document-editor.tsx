"use client";

import { useEffect, useId, useRef, useState } from "react";

import {
  MAX_MEMORY_BYTES,
  type MemoryCollection,
  type MemoryDocument,
  type MemoryOperation,
} from "@razbor/contracts";

import { MemoryHistory } from "@web/components/memory-history.js";
import { ReviewMarkdown } from "@web/components/review-markdown.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import { Badge } from "@web/components/ui/badge.js";
import { Button } from "@web/components/ui/button.js";
import { Field, FieldGroup, FieldLabel } from "@web/components/ui/field.js";
import { Input } from "@web/components/ui/input.js";
import { formatUtc } from "@web/lib/date.js";
import {
  createMemoryDraftKey,
  memoryDrafts,
  removeMemoryDraft,
  saveMemoryDraft,
  type MemoryDraft,
} from "@web/lib/memory-drafts.js";
import { MemoryRequestError, memoryRequest } from "@web/lib/memory-request.js";

/**
 * Edits raw Markdown against a known document version and retains local drafts when
 * another writer updates or deletes the saved document. Field changes are stored
 * synchronously in a dedicated browser draft record before React updates the editor.
 */
export function MemoryDocumentEditor({
  repositoryId,
  document,
  collections,
  initialCollectionId,
  initialDraft,
  initialDraftKey,
  onSaved,
  onDirtyChange,
  onBusyChange,
  onDraftStored,
}: Readonly<{
  repositoryId: string;
  document?: MemoryDocument;
  collections: MemoryCollection[];
  initialCollectionId: string;
  initialDraft?: MemoryDraft;
  initialDraftKey?: string;
  onSaved: (document: MemoryDocument) => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onDraftStored: (stored: boolean) => void;
}>) {
  const id = useId();
  const [draftKey] = useState(
    () => initialDraftKey ?? createMemoryDraftKey(repositoryId, document?.id),
  );
  const [base, setBase] = useState(initialDraft?.base ?? document);
  const [collectionId, setCollectionId] = useState(
    initialDraft?.collectionId ?? document?.collectionId ?? initialCollectionId,
  );
  const [path, setPath] = useState(initialDraft?.path ?? document?.path ?? "");
  const [title, setTitle] = useState(
    initialDraft?.title ?? document?.title ?? "",
  );
  const [markdown, setMarkdown] = useState(
    initialDraft?.markdown ?? document?.markdown ?? "",
  );
  const [preview, setPreview] = useState(Boolean(document) && !initialDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [storageError, setStorageError] = useState("");
  const [draftStored, setDraftStored] = useState(false);
  const [conflict, setConflict] = useState<MemoryDocument | undefined>(
    initialDraft?.base &&
      document &&
      initialDraft.base.version !== document.version
      ? document
      : undefined,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const mounted = useRef(true);
  const collection = collections.find((item) => item.id === collectionId);
  const canWrite = collection?.canWrite ?? false;
  const bytes = new TextEncoder().encode(markdown).length;
  const dirty = base
    ? path !== base.path || title !== base.title || markdown !== base.markdown
    : Boolean(path || title || markdown);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  useEffect(() => {
    mounted.current = true;
    if (initialDraft) persistDraft({});
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);

  /** Removes only this page's draft after a successful save or explicit discard. */
  function clearDraft() {
    try {
      removeMemoryDraft(repositoryId, draftKey);
      setStorageError("");
      setDraftStored(false);
      onDraftStored(false);
    } catch {
      setStorageError(
        "The saved draft could not be removed from this browser.",
      );
    }
  }

  /** Persists the next complete snapshot before a field change can be followed by navigation. */
  function persistDraft(
    changes: Partial<
      Pick<MemoryDraft, "collectionId" | "path" | "title" | "markdown">
    >,
    nextBase = base,
  ) {
    const draft: MemoryDraft = {
      ...(nextBase ? { base: nextBase } : {}),
      collectionId,
      path,
      title,
      markdown,
      ...changes,
      updatedAt: new Date().toISOString(),
    };
    const changed = nextBase
      ? draft.path !== nextBase.path ||
        draft.title !== nextBase.title ||
        draft.markdown !== nextBase.markdown
      : Boolean(draft.path || draft.title || draft.markdown);
    if (!changed) {
      clearDraft();
      return;
    }
    try {
      saveMemoryDraft(repositoryId, draft, draftKey);
      setStorageError("");
      setDraftStored(true);
      onDraftStored(true);
    } catch {
      setStorageError(
        "This draft could not be saved in your browser. Keep this page open until you save the memory.",
      );
      setDraftStored(false);
      onDraftStored(false);
    }
  }

  /** Stores changed fields synchronously without publishing unfinished Markdown to the server. */
  function changeDraft(
    changes: Partial<
      Pick<MemoryDraft, "collectionId" | "path" | "title" | "markdown">
    >,
  ) {
    persistDraft(changes);
    if (changes.collectionId !== undefined)
      setCollectionId(changes.collectionId);
    if (changes.path !== undefined) setPath(changes.path);
    if (changes.title !== undefined) setTitle(changes.title);
    if (changes.markdown !== undefined) setMarkdown(changes.markdown);
  }

  /** Replaces editor fields only after a successful save or explicit draft discard. */
  function adopt(current: MemoryDocument) {
    clearDraft();
    setBase(current);
    setCollectionId(current.collectionId);
    setPath(current.path);
    setTitle(current.title);
    setMarkdown(current.markdown);
    setConflict(undefined);
    setConfirmDelete(false);
  }

  /** Clears a completed save after navigation only if the local fields still match its submitted draft. */
  function clearCommittedDraft() {
    try {
      const stored = memoryDrafts(repositoryId).find(
        (record) => record.key === draftKey,
      )?.draft;
      if (
        stored &&
        stored.base?.id === base?.id &&
        stored.base?.version === base?.version &&
        stored.collectionId === collectionId &&
        stored.path === path &&
        stored.title === title &&
        stored.markdown === markdown
      )
        removeMemoryDraft(repositoryId, draftKey);
    } catch {
      // A retained recovery copy is safer than risking fields changed in another editor.
    }
  }

  /**
   * Performs a versioned mutation, keeping the editor intact on failure and exposing
   * the latest saved document when a conflict needs reconciliation.
   */
  async function mutate(operation: MemoryOperation, success: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await memoryRequest(repositoryId, operation);
      if (!result.document) throw new Error("Saved memory is unavailable");
      if (!mounted.current) {
        clearCommittedDraft();
        return;
      }
      adopt(result.document);
      onSaved(result.document);
      setMessage(success);
    } catch (error) {
      if (!mounted.current) return;
      if (
        error instanceof MemoryRequestError &&
        error.status === 409 &&
        error.current
      )
        setConflict(error.current);
      setError(
        error instanceof Error ? error.message : "Unable to save memory",
      );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  /** Saves the complete Markdown draft without trimming or reformatting its content. */
  async function save() {
    if (!canWrite || base?.deletedAt || conflict || !dirty) return;
    await mutate(
      base
        ? {
            operation: "write",
            id: base.id,
            expectedVersion: base.version,
            path,
            title,
            markdown,
          }
        : { operation: "create", collectionId, path, title, markdown },
      "Memory saved. Future reviews can search and read this version.",
    );
  }

  /** Marks the current saved document deleted after an explicit confirmation. */
  async function deleteMemory() {
    if (!base || !canWrite || conflict) return;
    await mutate(
      { operation: "delete", id: base.id, expectedVersion: base.version },
      "Memory deleted. It is excluded from search and future reviews.",
    );
  }

  /** Restores a chosen live revision as a new version after checking for draft loss. */
  async function restore(revision?: number) {
    if (!base || !canWrite || conflict) return;
    if (
      dirty &&
      !window.confirm("Replace your unsaved draft with the restored memory?")
    )
      return;
    await mutate(
      {
        operation: "restore",
        id: base.id,
        expectedVersion: base.version,
        ...(revision ? { revision } : {}),
      },
      "Memory restored as a new version.",
    );
  }

  /** Reloads saved content only when the user agrees to discard a changed draft. */
  async function reload() {
    if (
      !base ||
      busy ||
      (dirty &&
        !window.confirm(
          "Discard your unsaved memory changes and load the latest version?",
        ))
    )
      return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await memoryRequest(repositoryId, {
        operation: "read",
        id: base.id,
      });
      if (!mounted.current) return;
      if (!result.document) throw new Error("Memory document is unavailable");
      adopt(result.document);
      onSaved(result.document);
    } catch (error) {
      if (!mounted.current) return;
      setError(
        error instanceof Error ? error.message : "Unable to reload memory",
      );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div className="console-card flex flex-col gap-5" aria-busy={busy}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 break-words text-base font-semibold">
          {base?.title ?? "New memory"}
        </h3>
        {base && <Badge variant="outline">Version {base.version}</Badge>}
        {base?.deletedAt && <Badge variant="outline">Deleted</Badge>}
        {!canWrite && <Badge variant="outline">Read only</Badge>}
        {dirty && <Badge variant="secondary">Unsaved draft</Badge>}
      </div>
      {base && (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>
            Created{" "}
            <time dateTime={base.createdAt}>{formatUtc(base.createdAt)}</time>
          </span>
          <span>
            Updated{" "}
            <time dateTime={base.updatedAt}>{formatUtc(base.updatedAt)}</time>
          </span>
          {base.deletedAt && (
            <span>
              Deleted{" "}
              <time dateTime={base.deletedAt}>{formatUtc(base.deletedAt)}</time>
            </span>
          )}
          <code className="break-all">{base.id}</code>
        </div>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {storageError && (
        <Alert variant="destructive">
          <AlertDescription>{storageError}</AlertDescription>
        </Alert>
      )}
      {dirty && draftStored && (
        <p className="text-xs text-muted-foreground" role="status">
          Draft saved in this browser. You can leave and resume it from Memory.
        </p>
      )}
      {conflict && (
        <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
          <p className="text-sm font-medium">
            Your draft is preserved. The saved memory is now version{" "}
            {conflict.version}
            {conflict.deletedAt ? " and has been deleted" : ""}.
          </p>
          <details className="text-sm">
            <summary className="cursor-pointer">
              Compare the latest saved Markdown
            </summary>
            <div className="mt-3 flex flex-col gap-2">
              <p>{conflict.title}</p>
              <code className="break-all text-xs">{conflict.path}</code>
              <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap break-words">
                {conflict.markdown}
              </pre>
            </div>
          </details>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                persistDraft({}, conflict);
                setBase(conflict);
                setConflict(undefined);
                setError("");
                setMessage(
                  "Latest version loaded. Your draft is preserved; reconcile it before saving.",
                );
              }}
            >
              Keep draft and use latest version
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                adopt(conflict);
                onSaved(conflict);
                setError("");
                setMessage("Loaded the latest saved Markdown.");
              }}
            >
              Discard draft and load latest
            </Button>
          </div>
        </div>
      )}
      <form
        className="flex min-w-0 flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <FieldGroup>
          {base ? (
            <p className="text-sm text-muted-foreground">
              Collection: {collection?.name ?? base.collectionId}
            </p>
          ) : (
            <Field>
              <FieldLabel htmlFor={`${id}-collection`}>Collection</FieldLabel>
              <select
                id={`${id}-collection`}
                className="h-8 rounded-lg border border-input bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                value={collectionId}
                disabled={busy}
                onChange={(event) =>
                  changeDraft({ collectionId: event.target.value })
                }
              >
                {collections
                  .filter((item) => item.canWrite)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </Field>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`${id}-title`}>Title</FieldLabel>
              <Input
                id={`${id}-title`}
                value={title}
                onChange={(event) => changeDraft({ title: event.target.value })}
                maxLength={200}
                required
                disabled={busy || !canWrite || Boolean(base?.deletedAt)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-path`}>Markdown path</FieldLabel>
              <Input
                id={`${id}-path`}
                value={path}
                onChange={(event) => changeDraft({ path: event.target.value })}
                placeholder="conventions/testing.md"
                maxLength={512}
                autoComplete="off"
                spellCheck={false}
                required
                disabled={busy || !canWrite || Boolean(base?.deletedAt)}
              />
            </Field>
          </div>
          <Field>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <FieldLabel htmlFor={`${id}-markdown`}>
                {preview ? "Rendered Markdown" : "Markdown"}
              </FieldLabel>
              <div className="flex gap-1" aria-label="Markdown view">
                <Button
                  type="button"
                  size="sm"
                  variant={preview ? "ghost" : "secondary"}
                  aria-pressed={!preview}
                  onClick={() => setPreview(false)}
                >
                  Markdown
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={preview ? "secondary" : "ghost"}
                  aria-pressed={preview}
                  onClick={() => setPreview(true)}
                >
                  Preview
                </Button>
              </div>
            </div>
            {preview ? (
              <div
                className="min-h-80 rounded-lg border p-4"
                id={`${id}-markdown`}
              >
                {markdown ? (
                  <ReviewMarkdown path={path}>{markdown}</ReviewMarkdown>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No Markdown content yet.
                  </p>
                )}
              </div>
            ) : (
              <textarea
                id={`${id}-markdown`}
                className="min-h-96 w-full resize-y rounded-lg border border-input bg-background p-3 font-mono text-sm leading-relaxed focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
                value={markdown}
                onChange={(event) =>
                  changeDraft({ markdown: event.target.value })
                }
                spellCheck={false}
                readOnly={!canWrite || Boolean(base?.deletedAt)}
                disabled={busy}
                aria-describedby={`${id}-size`}
              />
            )}
            <p
              id={`${id}-size`}
              className={
                bytes > MAX_MEMORY_BYTES
                  ? "text-xs text-destructive"
                  : "text-xs text-muted-foreground"
              }
            >
              {bytes.toLocaleString()} / {MAX_MEMORY_BYTES.toLocaleString()}{" "}
              bytes
            </p>
          </Field>
        </FieldGroup>
        <div className="flex flex-wrap gap-2">
          {!base?.deletedAt && (
            <Button
              type="submit"
              disabled={
                busy ||
                !canWrite ||
                !dirty ||
                Boolean(conflict) ||
                !title.trim() ||
                !path ||
                bytes > MAX_MEMORY_BYTES
              }
            >
              {busy ? "Saving…" : base ? "Save changes" : "Create memory"}
            </Button>
          )}
          {base?.deletedAt && (
            <Button
              type="button"
              disabled={busy || !canWrite || Boolean(conflict)}
              onClick={() => void restore()}
            >
              Restore memory
            </Button>
          )}
          {base && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void reload()}
            >
              Reload saved version
            </Button>
          )}
          {base && !base.deletedAt && canWrite && (
            <Button
              type="button"
              variant="destructive"
              disabled={busy || Boolean(conflict)}
              onClick={() => setConfirmDelete(true)}
            >
              Delete memory
            </Button>
          )}
        </div>
      </form>
      {confirmDelete && base && (
        <div className="flex min-w-0 flex-col gap-3 rounded-xl border bg-muted/20 p-4">
          <p className="text-sm">
            Delete “{base.title}”? It will stop appearing in search and reviews.
            Its revision history remains available for restore.
            {dirty ? " Your unsaved draft will be discarded." : ""}
          </p>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void deleteMemory()}
            >
              Confirm delete
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {message && (
        <output className="text-sm" aria-live="polite">
          {message}
        </output>
      )}
      {base && (
        <MemoryHistory
          key={`${base.id}-${base.version}`}
          repositoryId={repositoryId}
          document={base}
          canRestore={canWrite && !busy && !conflict}
          onRestore={restore}
        />
      )}
    </div>
  );
}
