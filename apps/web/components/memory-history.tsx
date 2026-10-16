"use client";

import Link from "next/link.js";
import { useEffect, useState } from "react";

import type { MemoryDocument, MemoryRevision } from "@razbor/contracts";

import { ReviewMarkdown } from "@web/components/review-markdown.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import { Badge } from "@web/components/ui/badge.js";
import { Button } from "@web/components/ui/button.js";
import { formatUtc } from "@web/lib/date.js";
import { memoryRequest } from "@web/lib/memory-request.js";

/** Shows a revision's author, review source, commit, and save time. */
function RevisionSource({ revision }: Readonly<{ revision: MemoryRevision }>) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span>{revision.actor === "bot" ? "Review bot" : "Human edit"}</span>
      <time dateTime={revision.createdAt}>{formatUtc(revision.createdAt)}</time>
      {revision.reviewId && (
        <Link
          className="underline underline-offset-2"
          href={`/jobs/${revision.reviewId}`}
        >
          Source review
        </Link>
      )}
      {revision.headSha && (
        <code className="break-all" title={revision.headSha}>
          {revision.headSha.slice(0, 12)}
        </code>
      )}
    </div>
  );
}

/**
 * Reads bounded revision pages, exposes original Markdown and previews, and delegates
 * version-checked restores to the editor.
 */
export function MemoryHistory({
  repositoryId,
  document,
  canRestore,
  onRestore,
}: Readonly<{
  repositoryId: string;
  document: MemoryDocument;
  canRestore: boolean;
  onRestore: (version: number) => Promise<void>;
}>) {
  const [revisions, setRevisions] = useState<MemoryRevision[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    memoryRequest(
      repositoryId,
      { operation: "revisions", id: document.id, limit: 10 },
      controller.signal,
    )
      .then((result) => {
        setRevisions(result.revisions ?? []);
        setHasMore(result.hasMore ?? false);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : "Unable to load revision history",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [repositoryId, document.id, refresh]);

  /** Appends another revision page without requesting an unbounded document history. */
  async function loadMore() {
    if (loading || !hasMore) return;
    setLoading(true);
    setError("");
    try {
      const result = await memoryRequest(repositoryId, {
        operation: "revisions",
        id: document.id,
        limit: 10,
        offset: revisions.length,
      });
      setRevisions((previous) => [...previous, ...(result.revisions ?? [])]);
      setHasMore(result.hasMore ?? false);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to load revision history",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3 border-t pt-4">
      {revisions[0] && <RevisionSource revision={revisions[0]} />}
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          Revision history
        </summary>
        <div className="mt-3 flex min-w-0 flex-col gap-3" aria-busy={loading}>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>
                {error}{" "}
                <Button
                  variant="link"
                  size="sm"
                  disabled={loading}
                  onClick={() => setRefresh((value) => value + 1)}
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {revisions.map((revision) => (
            <details
              key={revision.version}
              className="min-w-0 rounded-xl border bg-muted/20 p-4"
            >
              <summary className="cursor-pointer break-words text-sm font-medium">
                Version {revision.version} — {revision.title}
                {revision.deletedAt ? " (deleted)" : ""}
              </summary>
              <div className="mt-3 flex min-w-0 flex-col gap-3">
                <RevisionSource revision={revision} />
                <code className="break-all text-xs text-muted-foreground">
                  {revision.path}
                </code>
                <div>
                  <Badge variant="outline">
                    {revision.version === document.version
                      ? "Current version"
                      : "Historical version"}
                  </Badge>
                </div>
                <div className="max-h-96 overflow-auto rounded-lg border p-3">
                  <ReviewMarkdown path={revision.path}>
                    {revision.markdown}
                  </ReviewMarkdown>
                </div>
                <details className="text-sm">
                  <summary className="cursor-pointer">Raw Markdown</summary>
                  <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap break-words">
                    {revision.markdown}
                  </pre>
                </details>
                {!revision.deletedAt &&
                  revision.version !== document.version && (
                    <div>
                      <Button
                        variant="outline"
                        disabled={!canRestore || loading}
                        onClick={() => void onRestore(revision.version)}
                      >
                        Restore this version
                      </Button>
                    </div>
                  )}
              </div>
            </details>
          ))}
          {loading && (
            <p className="text-sm text-muted-foreground" role="status">
              Loading revision history…
            </p>
          )}
          {hasMore && (
            <Button
              variant="outline"
              disabled={loading}
              onClick={() => void loadMore()}
            >
              Load older revisions
            </Button>
          )}
        </div>
      </details>
    </div>
  );
}
