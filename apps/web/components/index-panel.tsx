"use client";

import Link from "next/link.js";
import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  CircleCheck,
  Copy,
  KeyRound,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";

import { publicIdSchema, type IndexPreparation } from "@razbor/contracts";
import type { listIndexProjects, listTokens } from "@razbor/database";

import { ConsoleHero } from "@web/components/console-hero.js";
import { usePoll } from "@web/lib/use-poll.js";
import { formatUtc } from "@web/lib/date.js";
import { Status } from "@web/components/status.js";
import { Badge } from "@web/components/ui/badge.js";
import { Button } from "@web/components/ui/button.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@web/components/ui/empty.js";
import { Skeleton } from "@web/components/ui/skeleton.js";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@web/components/ui/table.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@web/components/ui/dialog.js";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldTitle,
  FieldDescription,
  FieldLegend,
  FieldSet,
} from "@web/components/ui/field.js";
import { Input } from "@web/components/ui/input.js";

type Project = Awaited<ReturnType<typeof listIndexProjects>>[number] & {
  preparation?: IndexPreparation | null;
};

export type IndexData = {
  asOf: string;
  projects: Project[];
  repositories: Project[];
  tokens: Awaited<ReturnType<typeof listTokens>>;
  preparationAvailable: boolean;
};

const labels: Record<string, string> = {
  ready: "Indexed",
  unready: "Refresh required",
  "not-provisioned": "Not indexed",
  "on-demand": "Not indexed",
  expired: "Expired",
  deleting: "Removing",
};

const phaseLabels: Record<IndexPreparation["phase"], string> = {
  queued: "Waiting for indexer",
  source_sync: "Fetching configured revision",
  graph_bootstrap: "Starting code graph",
  graph_readiness: "Building code graph",
  source_validation: "Checking revision",
  semantic_index: "Embedding code",
  document_index: "Embedding documents",
  readiness_publication: "Publishing index readiness",
  ready: "Preparation complete",
  error: "Preparation stopped",
};

/** Displays a count from the saved index snapshot and aligns its explanation to the bottom. */
function IndexSummaryCard({
  label,
  value,
  detail,
  icon: Icon,
  tone,
}: Readonly<{
  label: string;
  value: number | undefined;
  detail: string;
  icon: LucideIcon;
  tone: "success" | "info" | "findings" | "tokens";
}>) {
  return (
    <div className="flex min-h-24 min-w-0 gap-3 rounded-lg border bg-card p-4">
      <span
        className="overview-metric-icon flex size-9 shrink-0 items-center justify-center rounded-lg"
        data-tone={tone}
      >
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <h2 className="text-xs font-medium text-muted-foreground">{label}</h2>
        <p className="mt-1 break-all text-2xl font-semibold tracking-tight tabular-nums">
          {value?.toLocaleString("en-US") ?? "—"}
        </p>
        <p className="mt-auto pt-1 text-xs leading-relaxed text-muted-foreground">
          {detail}
        </p>
      </div>
    </div>
  );
}

/**
 * Validates the short background acceptance response; the workspace ID does not
 * imply readiness, which is reported by the server's regular status snapshots.
 */
async function acceptedWorkspace(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Indexer response is empty");
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4096) throw new Error("Indexer response is too large");
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    const result: unknown = JSON.parse(body);
    if (
      !result ||
      typeof result !== "object" ||
      !("workspaceId" in result) ||
      "error" in result
    )
      throw new Error("Indexer preparation was not accepted");
    return publicIdSchema("workspace").parse(result.workspaceId);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Manages repository indexing and scoped access tokens, clearing one-time token values
 * when their dialog closes.
 */
export function IndexPanel({
  initialData,
  repositoryId,
}: Readonly<{
  initialData?: IndexData;
  repositoryId?: string;
}>) {
  const { data, error } = usePoll<IndexData>(
    repositoryId ? `/api/indexes?repositoryId=${repositoryId}` : "/api/indexes",
    initialData,
  );
  const [indexing, setIndexing] = useState<string>();
  const [indexMessage, setIndexMessage] = useState("");
  const [indexError, setIndexError] = useState(false);
  const operation = useRef<AbortController | null>(null);
  /**
   * Starts server-owned indexing and reports acceptance while the panel is
   * active. Unmount only cancels this short request, leaving accepted work alive.
   */
  async function index(repositoryId: string) {
    if (indexing) return;
    setIndexing(repositoryId);
    setIndexMessage("");
    setIndexError(false);
    operation.current = new AbortController();
    try {
      const response = await fetch(`/api/repositories/${repositoryId}/index`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: operation.current.signal,
      });
      if (response.status !== 202)
        throw new Error(`Indexer request failed (${response.status})`);
      await acceptedWorkspace(response, operation.current.signal);
      if (active.current)
        setIndexMessage(
          "Indexing started. Progress updates automatically; you can reload or leave this page.",
        );
    } catch {
      if (active.current) {
        setIndexError(true);
        setIndexMessage(
          "Unable to confirm that indexing started. Progress will update automatically if the request was accepted; otherwise retry.",
        );
      }
    } finally {
      if (active.current) setIndexing(undefined);
    }
  }
  const [generating, setGenerating] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [allRepositories, setAllRepositories] = useState(false);
  const [generatedRepositories, setGeneratedRepositories] = useState<
    Pick<Project, "repositoryId" | "name">[]
  >([]);
  const [refresh, setRefresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [revoking, setRevoking] = useState<string>();
  const [revokeError, setRevokeError] = useState("");
  const repositories = data?.repositories ?? [];
  const selectedRepositories = allRepositories
    ? repositories
    : repositories.filter((p) => selectedIds.includes(p.repositoryId));
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      operation.current?.abort();
    };
  }, []);
  /**
   * Initializes the token dialog with an optional repository and removes prior token or
   * permission state.
   */
  function open(repositoryId?: string) {
    setSelectedIds(repositoryId ? [repositoryId] : []);
    setAllRepositories(false);
    setGeneratedRepositories([]);
    setToken("");
    setMessage("");
    setCopyStatus("");
    setRefresh(false);
    setGenerating(true);
  }
  /** Closes an idle token dialog and clears its one-time token and selected grants. */
  function close() {
    if (busy) return;
    setGenerating(false);
    setSelectedIds([]);
    setAllRepositories(false);
    setGeneratedRepositories([]);
    setToken("");
    setMessage("");
    setCopyStatus("");
    setRefresh(false);
  }
  /**
   * Creates an index token for the selected repository snapshot and retains the
   * returned secret only in the open dialog.
   */
  async function create() {
    if (!selectedRepositories.length || busy) return;
    const grantedRepositories = selectedRepositories.map(
      ({ repositoryId, name }) => ({ repositoryId, name }),
    );
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/index-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repositoryIds: grantedRepositories.map((p) => p.repositoryId),
          refresh,
          allRepositories,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (active.current) {
        setGeneratedRepositories(grantedRepositories);
        setToken(result.token);
      }
    } catch (e) {
      if (active.current)
        setMessage(e instanceof Error ? e.message : "Unable to create token");
    } finally {
      if (active.current) setBusy(false);
    }
  }
  /**
   * Copies the newly generated token or offers manual-copy guidance when the clipboard
   * is unavailable.
   */
  async function copy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus("Select and copy the token manually.");
    }
  }
  /**
   * Requests token revocation and reports failures while the regular polling cycle
   * refreshes token status.
   */
  async function revoke(id: string) {
    setRevoking(id);
    setRevokeError("");
    try {
      const response = await fetch(`/api/index-tokens/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok)
        throw new Error(`Indexer request failed (${response.status})`);
    } catch {
      setRevokeError("Unable to revoke token. Try again.");
    } finally {
      setRevoking(undefined);
    }
  }
  const panelContent = (
    <div className="flex min-w-0 flex-col gap-6">
      {indexMessage && (
        <Alert variant={indexError ? "destructive" : "default"}>
          <AlertDescription>{indexMessage}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            Unable to refresh indexer data. Retrying…
            {data &&
              " Showing the last successful snapshot; index readiness and token statuses may be outdated."}
          </AlertDescription>
        </Alert>
      )}
      <ProjectIndexes
        data={data}
        error={error}
        repositoryId={repositoryId}
        indexing={indexing}
        index={index}
        open={open}
      />
      <IndexTokens
        data={data}
        error={error}
        repositories={repositories}
        revoking={revoking}
        revokeError={revokeError}
        revoke={revoke}
        open={open}
      />
      <Dialog
        open={generating}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogContent
          showCloseButton={!busy}
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>
              {token ? "Copy your access token" : "Generate indexer token"}
            </DialogTitle>
            <DialogDescription>
              {token
                ? "This is the only time the secret is shown. Store it before closing this dialog."
                : "Choose the repositories this token can access. The token has no expiration; you can revoke it at any time."}
            </DialogDescription>
          </DialogHeader>
          {message && (
            <Alert variant="destructive">
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          )}
          {token ? (
            <>
              <FieldGroup>
                <Field>
                  <FieldTitle>
                    {allRepositories
                      ? "All repositories"
                      : `Access to ${repositoryCount(generatedRepositories.length)}`}
                  </FieldTitle>
                  {allRepositories && (
                    <FieldDescription>
                      Includes repositories added in the future.
                    </FieldDescription>
                  )}
                  {!!generatedRepositories.length && (
                    <ul className="flex max-h-40 flex-col gap-2 overflow-y-auto rounded-lg border p-3 text-sm">
                      {generatedRepositories.map((p) => (
                        <li
                          key={p.repositoryId}
                          className="break-words [overflow-wrap:anywhere]"
                        >
                          {p.name}
                        </li>
                      ))}
                    </ul>
                  )}
                </Field>
                <Field>
                  <FieldLabel htmlFor="new-token">Access token</FieldLabel>
                  <Input
                    id="new-token"
                    value={token}
                    readOnly
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono text-xs"
                    onFocus={(e) => e.target.select()}
                  />
                  <FieldDescription>
                    No expiration ·{" "}
                    {refresh ? "query and refresh" : "query only"}
                  </FieldDescription>
                </Field>
              </FieldGroup>
              <output className="block text-xs text-muted-foreground">
                {copyStatus}
              </output>
              <DialogFooter>
                <Button variant="outline" onClick={() => void copy()}>
                  <Copy data-icon="inline-start" />
                  Copy token
                </Button>
                <Button onClick={close}>Done</Button>
              </DialogFooter>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
              className="flex flex-col gap-4"
            >
              <FieldSet disabled={busy}>
                <FieldLegend variant="label">Repositories</FieldLegend>
                <FieldDescription id="token-repositories-description">
                  Choose individual repositories, or grant access to all current
                  and future repositories.
                </FieldDescription>
                <FieldGroup className="gap-0 overflow-hidden rounded-lg border">
                  <Field
                    orientation="horizontal"
                    className="min-h-10 gap-3 border-b bg-muted/40 px-3"
                  >
                    <input
                      id="token-all-repositories"
                      type="checkbox"
                      checked={allRepositories}
                      ref={(node) => {
                        if (node)
                          node.indeterminate =
                            selectedRepositories.length > 0 && !allRepositories;
                      }}
                      aria-describedby="token-repositories-description"
                      disabled={busy}
                      onChange={(e) => {
                        setAllRepositories(e.target.checked);
                        setSelectedIds([]);
                      }}
                      className="size-4 shrink-0 accent-primary"
                    />
                    <FieldLabel
                      htmlFor="token-all-repositories"
                      className="min-h-10 items-center py-2"
                    >
                      All repositories
                    </FieldLabel>
                    <output className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {selectedRepositories.length} of {repositories.length}
                    </output>
                  </Field>
                  <div className="max-h-60 overflow-y-auto">
                    {repositories.map((p) => (
                      <Field
                        key={p.repositoryId}
                        orientation="horizontal"
                        className="min-h-10 gap-3 px-3"
                      >
                        <input
                          id={`token-repository-${p.repositoryId}`}
                          type="checkbox"
                          checked={
                            allRepositories ||
                            selectedIds.includes(p.repositoryId)
                          }
                          disabled={busy}
                          onChange={(e) => {
                            const current = allRepositories
                              ? repositories.map((p) => p.repositoryId)
                              : selectedIds;
                            setAllRepositories(false);
                            setSelectedIds(
                              e.target.checked
                                ? [...current, p.repositoryId]
                                : current.filter((id) => id !== p.repositoryId),
                            );
                          }}
                          className="size-4 shrink-0 accent-primary"
                        />
                        <FieldLabel
                          htmlFor={`token-repository-${p.repositoryId}`}
                          className="min-h-10 min-w-0 items-center break-words py-2 [overflow-wrap:anywhere]"
                        >
                          {p.name}
                        </FieldLabel>
                      </Field>
                    ))}
                    {!repositories.length && (
                      <p className="p-3 text-sm text-muted-foreground">
                        No repositories registered yet.
                      </p>
                    )}
                  </div>
                </FieldGroup>
              </FieldSet>
              <FieldGroup>
                <Field orientation="horizontal">
                  <input
                    id="refresh"
                    type="checkbox"
                    checked={refresh}
                    disabled={busy}
                    onChange={(e) => setRefresh(e.target.checked)}
                    className="size-4 accent-primary"
                  />
                  <FieldLabel htmlFor="refresh">
                    Allow refreshing repository indexes
                  </FieldLabel>
                </Field>
                <FieldDescription>
                  Query access is always included. Refresh permission allows the
                  indexer to fetch and index each authorized repository's
                  configured revision.
                </FieldDescription>
              </FieldGroup>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={close}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={busy || !selectedRepositories.length}
                >
                  {busy ? "Creating…" : "Generate token"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
  if (repositoryId) return panelContent;
  return (
    <main className="console-hero-page indexes-page flex min-w-0 flex-col">
      <ConsoleHero
        id="indexes-title"
        eyebrow="Codebase knowledge"
        title="Indexer"
        description="Prepare repository indexes and manage query access."
      >
        <span className="console-hero-status">
          <BookOpen aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="tabular-nums">
            {data?.projects.length ?? "—"} projects
          </span>
        </span>
        <span className="console-hero-status">
          <RefreshCw aria-hidden="true" className="size-3.5 shrink-0" />
          Refreshes every 3 seconds
        </span>
      </ConsoleHero>
      <div className="console-container mt-6 mb-16 flex min-w-0 flex-col gap-5">
        <section
          aria-label="Index snapshot totals"
          className="grid grid-cols-1 gap-4 lg:grid-cols-3"
        >
          <IndexSummaryCard
            label="Projects"
            value={data?.projects.length}
            detail="Projects in the saved snapshot"
            icon={BookOpen}
            tone="findings"
          />
          <IndexSummaryCard
            label="Indexed projects"
            value={
              data?.projects.filter((project) => project.state === "ready")
                .length
            }
            detail="Saved readiness is indexed"
            icon={CircleCheck}
            tone="success"
          />
          <IndexSummaryCard
            label="Recent tokens"
            value={data?.tokens.length}
            detail="Latest 100 token records"
            icon={KeyRound}
            tone="tokens"
          />
        </section>
        {panelContent}
      </div>
    </main>
  );
}

/**
 * Lists persistent index readiness and available indexing or token actions, including
 * loading and empty states.
 */
function ProjectIndexes({
  data,
  error,
  repositoryId,
  indexing,
  index,
  open,
}: Readonly<{
  data?: IndexData;
  error: boolean;
  repositoryId?: string;
  indexing?: string;
  index: (repositoryId: string) => Promise<void>;
  open: (repositoryId?: string) => void;
}>) {
  let projectsContent;
  if (!data && !error) {
    projectsContent = <Skeleton className="h-40 w-full" />;
  } else if (data?.projects.length) {
    projectsContent = (
      <div className="console-table overflow-hidden rounded-xl border bg-card">
        <Table aria-label="Repository indexes">
          <TableHeader>
            <TableRow>
              <TableHead className="console-table-primary">Project</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last indexed</TableHead>
              <TableHead className="console-table-actions">Access</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.projects.map((p) => (
              <TableRow key={p.id ?? p.repositoryId}>
                <TableCell
                  className="console-table-primary"
                  data-label="Project"
                >
                  <Link
                    className="break-all font-semibold hover:underline"
                    href={`/repos/${p.repositoryId}`}
                  >
                    {p.name}
                  </Link>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                    {p.id ?? "No persistent index"}
                  </p>
                  {p.headSha && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Revision <code>{p.headSha.slice(0, 12)}</code>
                    </p>
                  )}
                </TableCell>
                <TableCell data-label="Status">
                  <ProjectPreparation
                    project={p}
                    starting={indexing === p.repositoryId}
                    asOf={data.asOf}
                  />
                </TableCell>
                <TableCell
                  className="text-xs tabular-nums text-muted-foreground"
                  data-label="Last indexed"
                >
                  {p.indexedAt ? (
                    <time dateTime={p.indexedAt}>{formatUtc(p.indexedAt)}</time>
                  ) : (
                    "Unavailable"
                  )}
                </TableCell>
                <TableCell
                  className="console-table-actions"
                  data-label="Access"
                >
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      size="sm"
                      disabled={
                        !!indexing ||
                        preparationActive(p) ||
                        p.state === "deleting" ||
                        p.state === "expired"
                      }
                      onClick={() => void index(p.repositoryId)}
                    >
                      <RefreshCw data-icon="inline-start" />
                      {indexButtonLabel(p, indexing)}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={p.state === "deleting" || p.state === "expired"}
                      onClick={() => open(p.repositoryId)}
                    >
                      <KeyRound data-icon="inline-start" />
                      Generate token
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  } else {
    projectsContent = data && (
      <Empty className="border bg-card">
        <EmptyHeader>
          <EmptyTitle>No projects configured</EmptyTitle>
          <EmptyDescription>
            Register a repository to see its index status here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <section aria-labelledby="projects" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="projects" className="text-base font-semibold">
          {repositoryId ? "Project index" : "Projects"}
        </h2>
        {data && (
          <span className="text-xs text-muted-foreground">
            {data.projects.length}{" "}
            {data.projects.length === 1 ? "project" : "projects"}
          </span>
        )}
      </div>
      {projectsContent}
      {data?.preparationAvailable === false && (
        <Alert>
          <AlertDescription>
            Live indexing progress is unavailable. Showing the saved index
            status; progress will reconnect automatically.
          </AlertDescription>
        </Alert>
      )}
      <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
        Dates use the existing successful indexing timestamp for ready
        persistent projects. Historical dates and dates for temporary review
        indexes are unavailable.
      </p>
      <p className="text-xs text-muted-foreground">
        Index a repository to fetch its configured branch and build the graph.
        Indexing continues if you reload or leave this page. Tokens can be
        generated before the first index; query access becomes available once
        indexing succeeds.
      </p>
    </section>
  );
}

/**
 * Shows server-reported phases and chunk counters without estimating missing
 * totals. Removing or expired projects retain their authoritative lifecycle state.
 */
function ProjectPreparation({
  project,
  starting,
  asOf,
}: Readonly<{ project: Project; starting: boolean; asOf: string }>) {
  const unavailable = ["deleting", "expired"].includes(project.state);
  const preparation = unavailable ? null : project.preparation;
  let status;
  if (unavailable) {
    status = <Status value={labels[project.state] ?? project.state} />;
  } else if (starting) {
    status = <Badge variant="info">Starting…</Badge>;
  } else if (preparation?.state === "queued") {
    status = <Badge variant="warning">Queued</Badge>;
  } else if (preparation?.state === "running") {
    status = <Badge variant="info">Indexing</Badge>;
  } else if (preparation?.state === "error") {
    status = (
      <Badge variant="destructive">
        {preparation.errorCode === "timeout" ? "Timed out" : "Indexing failed"}
      </Badge>
    );
  } else if (project.state === "ready") {
    status = <Badge variant="success">Indexed</Badge>;
  } else {
    status = <Status value={labels[project.state] ?? project.state} />;
  }
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      <div role="status" aria-live="polite" aria-atomic="true">
        {status}
      </div>
      {preparation && (
        <div className="flex max-w-xs flex-col gap-1 whitespace-normal text-xs text-muted-foreground">
          <span>
            {preparation.state === "error"
              ? preparationError(preparation)
              : phaseLabels[preparation.phase]}
          </span>
          <span className="tabular-nums">
            {corpusCount("Code", preparation.code)}
          </span>
          <span className="tabular-nums">
            {corpusCount("Documents", preparation.documents)}
          </span>
          <span className="tabular-nums">
            {preparation.state === "ready" || preparation.state === "error"
              ? "Duration"
              : "Elapsed"}{" "}
            {elapsedTime(preparation.startedAt, preparation.finishedAt ?? asOf)}
          </span>
          {preparation.deadlineAt && (
            <span className="tabular-nums">
              Deadline{" "}
              <time dateTime={preparation.deadlineAt}>
                {formatUtc(preparation.deadlineAt)}
              </time>
            </span>
          )}
        </div>
      )}
      {project.id && (
        <span className="text-xs text-muted-foreground">
          {project.kind === "review"
            ? "Temporary review"
            : "Persistent project"}
        </span>
      )}
    </div>
  );
}

/** Identifies active server-owned work independently of the current browser session. */
function preparationActive(project: Project) {
  return (
    project.preparation?.state === "queued" ||
    project.preparation?.state === "running"
  );
}

/** Formats actual chunk progress, retaining an unknown total until discovery completes. */
function corpusCount(label: string, progress: IndexPreparation["code"]) {
  const processed = progress.processed.toLocaleString("en-US");
  if (progress.total === undefined)
    return `${label}: ${processed} chunks processed`;
  return `${label}: ${processed} / ${progress.total.toLocaleString("en-US")} chunks`;
}

/** Formats a nonnegative measured duration without adding a browser-side timer or ETA. */
function elapsedTime(start: string, end: string) {
  const seconds = Math.max(
    0,
    Math.floor((Date.parse(end) - Date.parse(start)) / 1000),
  );
  if (!Number.isFinite(seconds)) return "Unavailable";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours
    ? `${hours}h ${minutes}m ${seconds % 60}s`
    : `${minutes}m ${seconds % 60}s`;
}

/** Gives safe retry guidance for the service's bounded preparation failure codes. */
function preparationError(preparation: IndexPreparation) {
  if (preparation.errorCode === "timeout")
    return "Time limit reached. Retry to reuse cached embeddings.";
  if (preparation.errorCode === "cancelled")
    return "Indexing was interrupted. Retry to continue.";
  return "Check indexer logs and repository access, then retry.";
}

/** Lists token scopes and expiry or revocation status with per-token revoke actions. */
function IndexTokens({
  data,
  error,
  repositories,
  revoking,
  revokeError,
  revoke,
  open,
}: Readonly<{
  data?: IndexData;
  error: boolean;
  repositories: Project[];
  revoking?: string;
  revokeError: string;
  revoke: (id: string) => Promise<void>;
  open: (repositoryId?: string) => void;
}>) {
  let tokensContent;
  if (!data && !error) {
    tokensContent = <Skeleton className="h-28 w-full" />;
  } else if (data?.tokens.length) {
    tokensContent = (
      <div className="console-table overflow-hidden rounded-xl border bg-card">
        <Table aria-label="Indexer access tokens">
          <TableHeader>
            <TableRow>
              <TableHead className="console-table-primary">
                Token / repositories
              </TableHead>
              <TableHead>Permission</TableHead>
              <TableHead>Expiration</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="console-table-actions">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.tokens.map((t) => {
              const expired =
                !!t.expiresAt && new Date(t.expiresAt) <= new Date(data.asOf);
              return (
                <TableRow key={t.id}>
                  <TableCell
                    className="console-table-primary"
                    data-label="Token / repositories"
                  >
                    <code className="break-all text-xs">{t.id}</code>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t.allRepositories
                        ? "All repositories (including future)"
                        : repositoryCount(t.scopes.length)}
                    </p>
                    <ul className="mt-1 flex max-w-sm flex-col gap-1 whitespace-normal text-xs text-muted-foreground">
                      {t.scopes.map((scope) => (
                        <li
                          key={scope.workspaceId}
                          className="break-words [overflow-wrap:anywhere]"
                        >
                          {scope.name ?? scope.repositoryId}
                        </li>
                      ))}
                    </ul>
                  </TableCell>
                  <TableCell className="text-xs" data-label="Permission">
                    {t.refresh ? "Query + refresh" : "Query only"}
                  </TableCell>
                  <TableCell
                    className="text-xs tabular-nums"
                    data-label="Expiration"
                  >
                    {t.expiresAt ? formatUtc(t.expiresAt) : "No expiration"}
                  </TableCell>
                  <TableCell data-label="Status">
                    <Status value={tokenStatus(t.revokedAt, expired)} />
                  </TableCell>
                  <TableCell
                    className="console-table-actions"
                    data-label="Actions"
                  >
                    {!t.revokedAt && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!!revoking}
                        onClick={() => void revoke(t.id)}
                      >
                        {revoking === t.id ? "Revoking…" : "Revoke"}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    );
  } else {
    tokensContent = data && (
      <Empty className="border bg-card">
        <EmptyHeader>
          <EmptyTitle>No access tokens</EmptyTitle>
          <EmptyDescription>
            Generate a token for one or more repositories. New tokens have no
            expiration and remain valid until revoked.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <section
      id="tokens"
      aria-labelledby="tokens-title"
      className="flex flex-col gap-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="tokens-title" className="text-base font-semibold">
          Access tokens
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-muted-foreground">
            Latest 100 tokens · secret shown only once
          </span>
          <Button
            size="sm"
            disabled={!repositories.length}
            onClick={() => open()}
          >
            <KeyRound data-icon="inline-start" />
            Generate token
          </Button>
        </div>
      </div>
      {revokeError && (
        <Alert variant="destructive">
          <AlertDescription>{revokeError}</AlertDescription>
        </Alert>
      )}
      {tokensContent}
    </section>
  );
}

/** Formats a repository count with the correct singular or plural noun. */
function repositoryCount(count: number) {
  const noun = count === 1 ? "repository" : "repositories";
  return `${count} ${noun}`;
}

/**
 * Distinguishes an in-progress request from first indexing and refreshing an existing
 * index.
 */
function indexButtonLabel(project: Project, indexing?: string) {
  if (indexing === project.repositoryId) return "Starting…";
  if (preparationActive(project))
    return project.preparation?.state === "queued" ? "Queued" : "Indexing…";
  if (project.preparation?.state === "error") return "Retry indexing";
  return project.headSha ? "Refresh index" : "Index repository";
}

/**
 * Labels revoked tokens before considering expiry, otherwise identifying active access.
 */
function tokenStatus(revokedAt: string | null, expired: boolean) {
  if (revokedAt) return "Revoked";
  return expired ? "Expired" : "Active";
}
