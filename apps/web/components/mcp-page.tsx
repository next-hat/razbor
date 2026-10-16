"use client";

import { useEffect, useState } from "react";
import {
  CircleCheck,
  Clock3,
  Info,
  KeyRound,
  Plug,
  Search,
  type LucideIcon,
} from "lucide-react";

import type { McpServerView } from "@razbor/contracts";

import { McpForm } from "@web/components/mcp-form.js";
import { ConsoleHero } from "@web/components/console-hero.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import { Badge } from "@web/components/ui/badge.js";
import { Button } from "@web/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@web/components/ui/dialog.js";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@web/components/ui/empty.js";
import { Field, FieldLabel } from "@web/components/ui/field.js";
import { Input } from "@web/components/ui/input.js";
import { Skeleton } from "@web/components/ui/skeleton.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@web/components/ui/table.js";
import { formatUtc } from "@web/lib/date.js";

type ConnectionResult = {
  server?: { name: string; version: string };
  tools: { name: string; description?: string }[];
};

/** Finds the latest valid registration save timestamp without substituting connection-test activity. */
function latestMcpUpdate(servers: McpServerView[] | undefined) {
  let latest = Number.NEGATIVE_INFINITY;
  for (const server of servers ?? []) {
    const timestamp = Date.parse(server.updatedAt);
    if (Number.isFinite(timestamp) && timestamp > latest) latest = timestamp;
  }
  return Number.isFinite(latest) ? new Date(latest).toISOString() : undefined;
}

/** Presents saved registration metadata with the explanatory text aligned to the bottom. */
function McpSummaryCard({
  label,
  value,
  detail,
  icon: Icon,
  tone,
  valueTitle,
}: Readonly<{
  label: string;
  value: number | string | undefined;
  detail: string;
  icon: LucideIcon;
  tone: "success" | "info" | "findings" | "tokens";
  valueTitle?: string;
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
        <p
          className="mt-1 break-words text-2xl font-semibold tracking-tight tabular-nums"
          title={valueTitle}
        >
          {typeof value === "number"
            ? value.toLocaleString("en-US")
            : (value ?? "—")}
        </p>
        <p className="mt-auto pt-1 text-xs leading-relaxed text-muted-foreground">
          {detail}
        </p>
      </div>
    </div>
  );
}

/** Keeps updates, connection probes, and deletion pending states coordinated per server. */
function McpServerActions({
  server,
  onSaved,
  onDeleted,
}: Readonly<{
  server: McpServerView;
  onSaved: (server: McpServerView) => void;
  onDeleted: (id: string) => void;
}>) {
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ConnectionResult>();

  /** Updates global availability without replacing the saved token. */
  async function toggleEnabled() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/mcp/${server.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: !server.enabled,
        }),
      });
      const updated = (await response.json()) as McpServerView & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(updated.error || "Unable to update MCP server.");
      onSaved(updated);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to update MCP server.",
      );
    } finally {
      setBusy(false);
    }
  }

  /** Shows a confirmation that preserves assignment conflicts returned by storage. */
  function changeDeleteOpen(value: boolean) {
    if (busy) return;
    setDeleteOpen(value);
    setError("");
  }

  /** Deletes only after the backend confirms the registration is no longer assigned. */
  async function remove() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/mcp/${server.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) {
        const failure = (await response.json()) as { error?: string };
        throw new Error(failure.error || "Unable to delete MCP server.");
      }
      setDeleteOpen(false);
      onDeleted(server.id);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to delete MCP server.",
      );
    } finally {
      setBusy(false);
    }
  }

  /** Opens a fresh bounded probe and displays only server and tool metadata. */
  async function changeTestOpen(value: boolean) {
    if (busy) return;
    setTestOpen(value);
    setError("");
    setResult(undefined);
    if (!value) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/mcp/${server.id}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(20_000),
      });
      const probe = (await response.json()) as ConnectionResult & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(probe.error || "Unable to test MCP connection.");
      setResult(probe);
    } catch (error) {
      setError(
        error instanceof Error && error.name !== "TimeoutError"
          ? error.message
          : "The connection test timed out. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <McpForm
          server={server}
          disabled={busy}
          onSaved={onSaved}
          onBusyChange={setBusy}
        />
        <Dialog
          open={testOpen}
          onOpenChange={(value) => void changeTestOpen(value)}
        >
          <DialogTrigger
            render={<Button variant="outline" disabled={busy} />}
            aria-label={`Test ${server.name} connection`}
          >
            Test
          </DialogTrigger>
          <DialogContent
            className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
            showCloseButton={!busy}
            aria-busy={busy}
          >
            <DialogHeader>
              <DialogTitle>Test {server.name}</DialogTitle>
              <DialogDescription>
                Connect using the saved endpoint and credentials, then list
                available tools.
              </DialogDescription>
            </DialogHeader>
            {busy && (
              <output className="block text-sm text-muted-foreground">
                Connecting…
              </output>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {result && (
              <div className="flex flex-col gap-4">
                <p role="status">
                  Connected. {result.tools.length}{" "}
                  {result.tools.length === 1 ? "tool" : "tools"} available.
                </p>
                {result.server && (
                  <p className="break-all text-sm text-muted-foreground">
                    {result.server.name} · {result.server.version}
                  </p>
                )}
                {result.tools.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    This server exposes no tools.
                  </p>
                ) : (
                  <ul
                    className="flex flex-col gap-4"
                    aria-label="Available MCP tools"
                  >
                    {result.tools.map((tool, index) => (
                      <li
                        key={`${tool.name}-${index}`}
                        className="flex flex-col gap-1"
                      >
                        <span className="break-all font-medium">
                          {tool.name}
                        </span>
                        {tool.description && (
                          <p className="break-words text-sm text-muted-foreground">
                            {tool.description}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void changeTestOpen(false)}
              >
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void toggleEnabled()}
          aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
        >
          {server.enabled ? "Disable" : "Enable"}
        </Button>
        <Dialog open={deleteOpen} onOpenChange={changeDeleteOpen}>
          <DialogTrigger
            render={<Button variant="ghost" disabled={busy} />}
            aria-label={`Delete ${server.name}`}
          >
            Delete
          </DialogTrigger>
          <DialogContent showCloseButton={!busy}>
            <DialogHeader>
              <DialogTitle>Delete MCP server?</DialogTitle>
              <DialogDescription>
                Remove {server.name}, its saved credentials, and its repository
                selections. Reviews using this server will lose access to its
                tools.
              </DialogDescription>
            </DialogHeader>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => changeDeleteOpen(false)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => void remove()}
              >
                {busy ? "Deleting…" : "Delete server"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      {error && !deleteOpen && !testOpen && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/** Lists saved registrations while keeping explicit repository access separate from connection testing. */
export function McpPage({
  initialData,
}: Readonly<{ initialData?: McpServerView[] }>) {
  const [servers, setServers] = useState(initialData);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const enabledServers = servers?.filter((server) => server.enabled).length;
  const storedTokens = servers?.filter((server) => server.hasToken).length;
  const latestUpdatedAt = latestMcpUpdate(servers);
  const query = search.trim().toLowerCase();
  const visibleServers = servers?.filter((server) =>
    `${server.name} ${server.endpoint}`.toLowerCase().includes(query),
  );

  useEffect(() => {
    if (initialData) return;
    const controller = new AbortController();
    setError("");
    void fetch("/api/mcp", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load MCP servers.");
        const current = (await response.json()) as McpServerView[];
        if (!controller.signal.aborted) setServers(current);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Unable to load MCP servers. Please try again.");
      });
    return () => controller.abort();
  }, [initialData, retry]);

  /** Replaces edited rows or appends a newly connected global registration. */
  function saved(server: McpServerView) {
    setServers((current) =>
      current?.some((item) => item.id === server.id)
        ? current.map((item) => (item.id === server.id ? server : item))
        : [...(current ?? []), server],
    );
    setNotice(
      `${server.name} saved. ${server.enabled ? "Select it in repository settings to grant tool access." : "This server is disabled for all repositories."}`,
    );
  }

  /** Removes the deleted row after successful server-side deletion. */
  function deleted(id: string) {
    setServers((current) => current?.filter((server) => server.id !== id));
    setNotice("MCP server deleted.");
  }

  return (
    <main className="console-hero-page mcp-page flex min-w-0 flex-col">
      <ConsoleHero
        id="mcp-title"
        eyebrow="Review tool connections"
        title="MCP"
        description="Manage tool servers and grant access per repository."
      >
        <span className="console-hero-status">
          <Plug aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="tabular-nums">
            {servers?.length ?? "—"} registered
          </span>
        </span>
      </ConsoleHero>
      <div className="console-container mt-6 mb-16 flex min-w-0 flex-col gap-5">
        <section
          aria-label="MCP registration totals"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
        >
          <McpSummaryCard
            label="Registered servers"
            value={servers?.length}
            detail="Saved HTTP endpoints"
            icon={Plug}
            tone="findings"
          />
          <McpSummaryCard
            label="Enabled registrations"
            value={enabledServers}
            detail="Requires repository selection"
            icon={CircleCheck}
            tone="success"
          />
          <McpSummaryCard
            label="Stored tokens"
            value={storedTokens}
            detail="Saved credentials · presence only"
            icon={KeyRound}
            tone="tokens"
          />
          <McpSummaryCard
            label="Last updated"
            value={
              latestUpdatedAt
                ? `${latestUpdatedAt.slice(11, 16)} UTC`
                : undefined
            }
            detail={
              latestUpdatedAt
                ? `${latestUpdatedAt.slice(0, 10)} · Latest saved server`
                : "Saved timestamp unavailable"
            }
            valueTitle={
              latestUpdatedAt ? formatUtc(latestUpdatedAt) : undefined
            }
            icon={Clock3}
            tone="info"
          />
        </section>
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Field className="w-full min-w-0 sm:max-w-md">
            <FieldLabel htmlFor="mcp-search" className="sr-only">
              Search MCP servers
            </FieldLabel>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id="mcp-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search server or endpoint…"
                disabled={!servers}
                className="pl-9"
              />
            </div>
          </Field>
          <McpForm disabled={!servers} onSaved={saved} />
        </div>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <span>{error}</span>
                <Button
                  variant="outline"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  Try again
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : !servers ? (
          <div role="status">
            <span className="sr-only">Loading MCP servers…</span>
            <Skeleton className="h-64 w-full" />
          </div>
        ) : !visibleServers?.length ? (
          <Empty className="border bg-card py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {query ? <Search /> : <Plug />}
              </EmptyMedia>
              <EmptyTitle>
                {query
                  ? "No matching MCP servers"
                  : "No MCP servers registered"}
              </EmptyTitle>
              <EmptyDescription>
                {query
                  ? "Try another server name or endpoint URL."
                  : "Connect a Streamable HTTP endpoint to make its tools available for selection in your repositories."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="console-table overflow-hidden rounded-xl border bg-card">
            <Table aria-label="Registered MCP servers">
              <TableHeader>
                <TableRow>
                  <TableHead className="console-table-primary">
                    Server
                  </TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="console-table-actions">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleServers.map((server) => (
                  <TableRow key={server.id}>
                    <TableCell
                      className="console-table-primary"
                      data-label="Server"
                    >
                      <div className="flex min-w-0 items-start gap-3">
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground">
                          <Plug aria-hidden="true" className="size-5" />
                        </span>
                        <div className="flex min-w-0 flex-col gap-1.5">
                          <span className="break-all font-semibold">
                            {server.name}
                          </span>
                          <span className="break-all text-xs leading-relaxed text-muted-foreground">
                            {server.endpoint}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {server.hasToken
                              ? "Bearer token stored"
                              : "No saved bearer token"}
                          </span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell data-label="Status">
                      <Badge
                        variant={server.enabled ? "success" : "secondary"}
                        className="h-auto min-h-5 max-w-full whitespace-normal"
                      >
                        {server.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                    </TableCell>
                    <TableCell data-label="Updated">
                      <time
                        className="text-xs text-muted-foreground"
                        dateTime={server.updatedAt}
                      >
                        {formatUtc(server.updatedAt)}
                      </time>
                    </TableCell>
                    <TableCell
                      className="console-table-actions"
                      data-label="Actions"
                    >
                      <McpServerActions
                        server={server}
                        onSaved={saved}
                        onDeleted={deleted}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <section
          aria-labelledby="about-mcp"
          className="console-card flex items-start gap-3"
        >
          <Info
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 text-primary"
          />
          <div>
            <h2 id="about-mcp" className="text-lg font-semibold">
              About MCP servers
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Register a Streamable HTTP endpoint, then select it in repository
              settings to grant tool access. Enabled describes the saved
              configuration; Test checks connectivity and lists tools using the
              stored endpoint and credentials.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
