"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, RefreshCw, Search } from "lucide-react";

import type {
  MemoryDocument,
  MemoryOperation,
  MemoryOperationResult,
} from "@razbor/contracts";

import { MemoryDocumentEditor } from "@web/components/memory-document-editor.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import { Badge } from "@web/components/ui/badge.js";
import { Button } from "@web/components/ui/button.js";
import { Input } from "@web/components/ui/input.js";
import { formatUtc } from "@web/lib/date.js";
import {
  memoryDrafts,
  preferredMemoryDraft,
  removeMemoryDraft,
  type MemoryDraft,
  type StoredMemoryDraft,
} from "@web/lib/memory-drafts.js";
import { memoryRequest } from "@web/lib/memory-request.js";
import { cn } from "@web/lib/utils.js";

/**
 * Browses repository and shared memory collections, searches saved Markdown, and keeps
 * a selected document's unsaved draft separate from refreshed search results. Browser
 * draft records allow returning from navigation and recovering unfinished memories.
 */
export function MemoryEditor({
  repositoryId,
  initialData,
}: Readonly<{
  repositoryId: string;
  initialData?: MemoryOperationResult;
}>) {
  const [data, setData] = useState(initialData);
  const [collectionId, setCollectionId] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(!initialData);
  const [opening, setOpening] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<MemoryDocument | null | undefined>();
  const [dirty, setDirty] = useState(false);
  const [creatingCollectionId, setCreatingCollectionId] = useState("");
  const [draftNumber, setDraftNumber] = useState(0);
  const [initialDraft, setInitialDraft] = useState<MemoryDraft>();
  const [initialDraftKey, setInitialDraftKey] = useState<string>();
  const [drafts, setDrafts] = useState<StoredMemoryDraft[]>([]);
  const [draftStored, setDraftStored] = useState(false);
  const [draftError, setDraftError] = useState("");
  const firstLoad = useRef(true);
  const requestNumber = useRef(0);
  const collections = data?.collections ?? [];
  const documents = data?.documents ?? [];

  /** Updates local recovery choices without replacing the open editor's fields. */
  const refreshDrafts = useCallback(() => {
    try {
      setDrafts(memoryDrafts(repositoryId));
      setDraftError("");
    } catch {
      setDraftError("Local drafts are unavailable in this browser.");
    }
  }, [repositoryId]);

  /** Tracks whether the latest fields can safely survive leaving this editor. */
  const draftStorageChanged = useCallback(
    (stored: boolean) => {
      setDraftStored(stored);
      if (!stored) refreshDrafts();
    },
    [refreshDrafts],
  );

  useEffect(() => {
    const controller = new AbortController();
    refreshDrafts();
    try {
      const preferred = preferredMemoryDraft(repositoryId);
      if (preferred) void recoverDraft(preferred, controller.signal);
    } catch {
      setDraftError("Local drafts are unavailable in this browser.");
    }
    /** Refreshes other tabs' recovery entries without changing this draft. */
    function storageChanged() {
      refreshDrafts();
    }
    window.addEventListener("storage", storageChanged);
    return () => {
      controller.abort();
      window.removeEventListener("storage", storageChanged);
    };
  }, [repositoryId, refreshDrafts]);

  useEffect(() => {
    if (firstLoad.current && initialData) {
      firstLoad.current = false;
      return;
    }
    firstLoad.current = false;
    const controller = new AbortController();
    const number = ++requestNumber.current;
    setLoading(true);
    setError("");
    const operation: MemoryOperation = {
      ...(query
        ? { operation: "search", query }
        : { operation: "list", includeDeleted }),
      ...(collectionId ? { collectionId } : {}),
      limit: 100,
    };
    memoryRequest(repositoryId, operation, controller.signal)
      .then((result) => {
        if (number !== requestNumber.current) return;
        setData((previous) => ({
          ...result,
          collections: result.collections ?? previous?.collections,
        }));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || number !== requestNumber.current)
          return;
        setError(
          error instanceof Error ? error.message : "Unable to load memory",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted && number === requestNumber.current)
          setLoading(false);
      });
    return () => controller.abort();
  }, [repositoryId, initialData, collectionId, query, includeDeleted, refresh]);

  useEffect(() => {
    if (!dirty || draftStored) return;
    /** Warns on unload when the latest fields could not be stored locally. */
    function beforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, draftStored]);

  /** Asks before replacing fields only when local draft storage failed. */
  function canLeaveDraft() {
    return (
      !dirty ||
      draftStored ||
      window.confirm(
        "This draft could not be stored in your browser. Discard your unsaved memory changes?",
      )
    );
  }

  /** Reopens a local snapshot against the latest server version, retaining its original baseline. */
  async function recoverDraft(record: StoredMemoryDraft, signal?: AbortSignal) {
    if (opening || editing || !canLeaveDraft()) return;
    setOpening(true);
    setError("");
    try {
      const latest = memoryDrafts(repositoryId).find(
        (draft) => draft.key === record.key,
      );
      if (!latest) throw new Error("This local draft is no longer available.");
      const current = latest.draft.base
        ? (
            await memoryRequest(
              repositoryId,
              {
                operation: "read",
                id: latest.draft.base.id,
              },
              signal,
            )
          ).document
        : undefined;
      if (signal?.aborted) return;
      if (latest.draft.base && !current)
        throw new Error("Memory document is unavailable");
      // Typing remains available while the server read is pending; recover the newest local fields.
      const recovered = memoryDrafts(repositoryId).find(
        (draft) => draft.key === record.key,
      );
      if (!recovered)
        throw new Error("This local draft is no longer available.");
      setInitialDraft(recovered.draft);
      setInitialDraftKey(recovered.owned ? recovered.key : undefined);
      setCreatingCollectionId(recovered.draft.collectionId);
      setDraftNumber((value) => value + 1);
      setSelected(current ?? null);
      setDirty(false);
      setDraftStored(false);
      refreshDrafts();
    } catch (error) {
      if (!signal?.aborted)
        setError(
          error instanceof Error ? error.message : "Unable to recover draft",
        );
    } finally {
      if (!signal?.aborted) setOpening(false);
    }
  }

  /** Explicitly discards one local recovery record, leaving other writers' drafts intact. */
  function discardDraft(record: StoredMemoryDraft) {
    if (!window.confirm("Discard this draft saved in your browser?")) return;
    try {
      removeMemoryDraft(repositoryId, record.key);
      refreshDrafts();
    } catch {
      setDraftError("The local draft could not be removed from this browser.");
    }
  }

  /** Opens the latest saved document while preserving the current editor on errors. */
  async function openDocument(id: string) {
    if (opening || editing || selected?.id === id || !canLeaveDraft()) return;
    try {
      const existing = memoryDrafts(repositoryId).find(
        (record) => record.owned && record.draft.base?.id === id,
      );
      if (existing) {
        await recoverDraft(existing);
        return;
      }
    } catch {
      setDraftError("Local drafts are unavailable in this browser.");
    }
    setOpening(true);
    setError("");
    try {
      const result = await memoryRequest(repositoryId, {
        operation: "read",
        id,
      });
      if (!result.document) throw new Error("Memory document is unavailable");
      setInitialDraft(undefined);
      setInitialDraftKey(undefined);
      setDraftNumber((value) => value + 1);
      setSelected(result.document);
      setDirty(false);
      setDraftStored(false);
      refreshDrafts();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to open memory",
      );
    } finally {
      setOpening(false);
    }
  }

  /** Starts a new Markdown draft in the selected writable or default collection. */
  function createDocument() {
    if (opening || editing || !canLeaveDraft()) return;
    const collection =
      collections.find((item) => item.id === collectionId && item.canWrite) ??
      collections.find((item) => item.isDefault && item.canWrite) ??
      collections.find((item) => item.canWrite);
    if (!collection) return;
    setCreatingCollectionId(collection.id);
    setInitialDraft(undefined);
    setInitialDraftKey(undefined);
    setDraftNumber((value) => value + 1);
    setSelected(null);
    setDirty(false);
    setDraftStored(false);
    setError("");
    refreshDrafts();
  }

  /** Refreshes browse results after a save without losing the selected document. */
  function saved(document: MemoryDocument) {
    setSelected(document);
    setDirty(false);
    setInitialDraft(undefined);
    setInitialDraftKey(undefined);
    setDraftStored(false);
    refreshDrafts();
    setRefresh((value) => value + 1);
  }

  /** Appends the next bounded page and ignores responses superseded by new filters. */
  async function loadMore() {
    if (loading || !data?.hasMore) return;
    const number = ++requestNumber.current;
    setLoading(true);
    setError("");
    try {
      const result = await memoryRequest(repositoryId, {
        ...(query
          ? { operation: "search", query }
          : { operation: "list", includeDeleted }),
        ...(collectionId ? { collectionId } : {}),
        limit: 100,
        offset: documents.length,
      });
      if (number !== requestNumber.current) return;
      setData((previous) => ({
        ...result,
        collections: result.collections ?? previous?.collections,
        documents: [
          ...(previous?.documents ?? []),
          ...(result.documents ?? []),
        ],
      }));
    } catch (error) {
      if (number === requestNumber.current)
        setError(
          error instanceof Error ? error.message : "Unable to load more memory",
        );
    } finally {
      if (number === requestNumber.current) setLoading(false);
    }
  }

  return (
    <section
      className="flex min-w-0 flex-col gap-5"
      aria-labelledby="memory-title"
    >
      <div className="console-card flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="memory-title" className="text-base font-semibold">
            Knowledge library
          </h2>
          <p className="text-sm text-muted-foreground">
            Knowledge saved by the reviewer and your team. Edit the Markdown
            used in future reviews.
          </p>
        </div>
        <Button
          onClick={createDocument}
          disabled={
            opening || editing || !collections.some((item) => item.canWrite)
          }
        >
          <Plus data-icon="inline-start" />
          New memory
        </Button>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {draftError && (
        <Alert variant="destructive">
          <AlertDescription>{draftError}</AlertDescription>
        </Alert>
      )}
      {drafts.length > 0 && (
        <details className="console-card">
          <summary className="cursor-pointer text-sm font-medium">
            Drafts saved in this browser ({drafts.length})
          </summary>
          <ul className="mt-3 flex flex-col gap-3">
            {drafts.map((record) => (
              <li
                key={record.key}
                className="flex flex-wrap items-center justify-between gap-3"
              >
                <div className="min-w-0 text-sm">
                  <p className="break-words">
                    {record.draft.title || "Untitled memory"}
                  </p>
                  <code className="break-all text-xs text-muted-foreground">
                    {record.draft.path || "New memory"}
                  </code>
                  <p className="text-xs text-muted-foreground">
                    {formatUtc(record.draft.updatedAt)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={opening || editing}
                    onClick={() => void recoverDraft(record)}
                  >
                    Resume draft
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={
                      opening ||
                      editing ||
                      (record.owned &&
                        (record.draft.base?.id ?? null) ===
                          (selected?.id ?? null) &&
                        dirty)
                    }
                    onClick={() => discardDraft(record)}
                  >
                    Discard
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
      <form
        className="console-card flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(search.trim());
          setRefresh((value) => value + 1);
        }}
      >
        <label className="flex w-full min-w-0 flex-col gap-1.5 text-sm sm:w-auto sm:min-w-48">
          Collection
          <select
            className="h-(--console-control-height) w-full min-w-0 max-w-full rounded-md border border-input bg-background px-2.5 text-[0.8125rem] focus-visible:outline-2 focus-visible:outline-ring"
            value={collectionId}
            onChange={(event) => setCollectionId(event.target.value)}
          >
            <option value="">All collections</option>
            {collections.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.canWrite ? "" : " (read only)"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex w-full min-w-0 flex-1 flex-col gap-1.5 text-sm sm:min-w-48">
          Search memory
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search titles and Markdown…"
            maxLength={1000}
          />
        </label>
        <Button type="submit" variant="outline" disabled={loading}>
          <Search data-icon="inline-start" />
          Search
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={loading}
          onClick={() => setRefresh((value) => value + 1)}
          aria-label="Refresh memory list"
        >
          <RefreshCw />
        </Button>
      </form>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          checked={includeDeleted}
          disabled={Boolean(query)}
          onChange={(event) => setIncludeDeleted(event.target.checked)}
        />
        Show deleted memories
        {query ? " (clear search to browse deleted memories)" : ""}
      </label>
      <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div
          className="flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card"
          aria-busy={loading || opening}
        >
          <div
            className="border-b px-4 py-3 text-xs text-muted-foreground"
            aria-live="polite"
          >
            {loading
              ? "Loading memories…"
              : `${documents.length} ${documents.length === 1 ? "memory" : "memories"}${data?.hasMore ? " loaded" : ""}`}
          </div>
          {documents.length ? (
            <ul className="max-h-[65dvh] divide-y overflow-y-auto">
              {documents.map((document) => (
                <li key={document.id}>
                  <button
                    type="button"
                    className={cn(
                      "flex w-full flex-col gap-1.5 px-4 py-3 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50",
                      selected?.id === document.id && "bg-muted",
                    )}
                    aria-current={
                      selected?.id === document.id ? "true" : undefined
                    }
                    disabled={opening || editing}
                    onClick={() => void openDocument(document.id)}
                  >
                    <span className="flex flex-wrap items-center gap-2 break-all text-sm font-medium">
                      {document.title}
                      {document.deletedAt && (
                        <Badge variant="outline">Deleted</Badge>
                      )}
                    </span>
                    <code className="break-all text-xs text-muted-foreground">
                      {document.path}
                    </code>
                    <span className="text-xs text-muted-foreground">
                      {
                        collections.find(
                          (item) => item.id === document.collectionId,
                        )?.name
                      }
                    </span>
                    <time
                      dateTime={document.updatedAt}
                      className="text-xs text-muted-foreground"
                    >
                      {formatUtc(document.updatedAt)}
                    </time>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            !loading && (
              <p className="px-4 py-8 text-sm text-muted-foreground">
                {query
                  ? "No memories match this search."
                  : "No memories saved here yet."}
              </p>
            )
          )}
          {data?.hasMore && (
            <Button
              className="m-3"
              variant="outline"
              disabled={loading}
              onClick={() => void loadMore()}
            >
              Load more
            </Button>
          )}
        </div>
        {selected !== undefined ? (
          <MemoryDocumentEditor
            key={`${selected?.id ?? "new"}-${draftNumber}`}
            repositoryId={repositoryId}
            document={selected ?? undefined}
            collections={collections}
            initialCollectionId={creatingCollectionId}
            initialDraft={initialDraft}
            initialDraftKey={initialDraftKey}
            onSaved={saved}
            onDirtyChange={setDirty}
            onBusyChange={setEditing}
            onDraftStored={draftStorageChanged}
          />
        ) : (
          <div className="flex min-h-60 items-center justify-center rounded-xl border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
            Select a memory to read or edit its Markdown, or create a new one.
          </div>
        )}
      </div>
    </section>
  );
}
